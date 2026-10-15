/**
 * Ephemeral in-memory SQLite (sql.js) for query_sheet.
 *
 * Schema: one table named after the sheet tab; columns A, B, C… only.
 * Per-call: create → load → SELECT → discard. sql.js module cached process-wide
 * and loaded lazily (so MCP stdio handshake is not blocked by the ~1.3MB asm bundle).
 *
 * No GViz, no on-disk SQLite cache. Data always from Sheets API values.get
 * (UI basicFilter-safe).
 */

import {
  colIndexToLetter,
  coerceNumber,
  formatQueryCell,
  inferQueryColType,
} from "./sheet-helpers.js";

/** @type {Promise<import("sql.js").SqlJsStatic> | null} */
let sqlJsPromise = null;

/** Process-lifetime cache; first query_sheet call loads sql-asm.js. */
export function getSqlJs() {
  if (!sqlJsPromise) {
    sqlJsPromise = import("sql.js/dist/sql-asm.js").then((mod) => mod.default());
  }
  return sqlJsPromise;
}

/** Double-quote a SQL identifier; escape embedded quotes. */
export function quoteIdent(name) {
  return `"${String(name).replace(/"/g, '""')}"`;
}

/**
 * Mask single-quoted string literals (length-preserving) so keyword scans
 * ignore contents like 'drop', 'from', 'where'. Handles escaped '' inside strings.
 */
export function maskSqlStringLiterals(sql) {
  const s = String(sql);
  let out = "";
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== "'") {
      out += s[i];
      continue;
    }
    out += "'";
    i++;
    while (i < s.length) {
      if (s[i] === "'" && s[i + 1] === "'") {
        out += "  ";
        i += 2;
        continue;
      }
      if (s[i] === "'") {
        out += "'";
        break;
      }
      out += " ";
      i++;
    }
  }
  return out;
}

/**
 * Cell → SQLite value.
 * Empty / missing → '' (so `col = ''` matches, like the old JS path); output still nullifies via formatQueryCell.
 * bool → 0/1; numeric text → REAL; date serials kept as REAL.
 */
export function cellToSqlValue(raw) {
  if (raw === null || raw === undefined || raw === "") return "";
  if (typeof raw === "boolean") return raw ? 1 : 0;
  if (raw === "TRUE" || raw === "true") return 1;
  if (raw === "FALSE" || raw === "false") return 0;
  if (typeof raw === "number") return Number.isNaN(raw) ? "" : raw;
  const n = coerceNumber(raw);
  if (n !== null) return n;
  return String(raw);
}

/** Escape % and _ for LIKE … ESCAPE '\' */
export function escapeLikePattern(s) {
  return String(s).replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

/**
 * GViz-style `A contains 'x'` → `A LIKE '%x%' ESCAPE '\'`.
 * Scans only outside string literals.
 */
export function rewriteContainsToLike(sql) {
  const masked = maskSqlStringLiterals(sql);
  let out = "";
  let last = 0;
  const re = /\b([A-Za-z]+)\s+contains\s+'/gi;
  let m;
  while ((m = re.exec(masked)) !== null) {
    // Find the opening quote position in masked (= same index in sql)
    const openQuote = m.index + m[0].length - 1;
    let close = openQuote + 1;
    const s = String(sql);
    while (close < s.length) {
      if (s[close] === "'" && s[close + 1] === "'") {
        close += 2;
        continue;
      }
      if (s[close] === "'") break;
      close++;
    }
    const col = m[1].toUpperCase();
    const val = s.slice(openQuote + 1, close);
    out += s.slice(last, m.index);
    out += `${col} LIKE '%${escapeLikePattern(val)}%' ESCAPE '\\'`;
    last = close + 1;
    re.lastIndex = close + 1;
  }
  out += String(sql).slice(last);
  return out;
}

/**
 * Ensure a single SELECT; reject multi-statement / non-SELECT / DDL.
 * Keyword checks run on string-literal-masked SQL (so 'drop' values are fine).
 * `replace()` is allowed; `REPLACE INTO` is not.
 */
export function assertSelectOnly(sql) {
  const q = String(sql || "").trim();
  if (!q) throw new Error("query_sheet: empty query");
  if (q.includes(";")) {
    throw new Error("query_sheet: multiple statements / semicolons are not allowed");
  }
  if (!/^\s*select\b/i.test(q)) {
    throw new Error("query_sheet: only SELECT queries are supported");
  }
  const masked = maskSqlStringLiterals(q);
  if (/\b(attach|detach|pragma|insert|update|delete|drop|create|alter|vacuum)\b/i.test(masked)) {
    throw new Error("query_sheet: only read-only SELECT is allowed (no DDL/DML/PRAGMA)");
  }
  if (/\breplace\s+/i.test(masked)) {
    throw new Error("query_sheet: only read-only SELECT is allowed (no REPLACE INTO)");
  }
  return q;
}

/**
 * If query has no FROM, inject `FROM "sheetName"` after the SELECT list.
 * Keyword detection ignores string literals.
 */
export function ensureFromClause(sql, sheetName) {
  const q = String(sql).trim();
  const masked = maskSqlStringLiterals(q);
  if (/\bfrom\b/i.test(masked)) return q;

  const fromSql = `FROM ${quoteIdent(sheetName)}`;
  const re = /\b(where|group\s+by|having|order\s+by|limit)\b/i;
  const m = masked.match(re);
  if (m && m.index !== undefined) {
    return `${q.slice(0, m.index).trimEnd()} ${fromSql} ${q.slice(m.index)}`;
  }
  return `${q} ${fromSql}`;
}

/** Validate + contains→LIKE + optional FROM inject. */
export function prepareSheetSql(query, sheetName) {
  let q = assertSelectOnly(query);
  q = rewriteContainsToLike(q);
  q = ensureFromClause(q, sheetName);
  return q;
}

export function sheetColumnWidth(sheetValues, headerRows) {
  const values = sheetValues || [];
  const header = values[headerRows - 1] || [];
  const dataRows = values.slice(headerRows);
  const maxColInData = Math.max(0, ...dataRows.map((r) => (r ? r.length : 0))) - 1;
  return Math.max(header.length - 1, maxColInData, 0);
}

/** Header label for sheet letter cols (A/B/C…); aliases like `n` / `COUNT(*)` stay as-is. */
export function resultColumnLabel(colName, header, sheetColSet) {
  const upper = String(colName).toUpperCase();
  if (!sheetColSet || !sheetColSet.has(upper)) return String(colName);
  let idx = 0;
  for (const ch of upper) idx = idx * 26 + (ch.charCodeAt(0) - 64);
  idx -= 1;
  const label = header[idx];
  if (label !== undefined && label !== null && label !== "") return String(label);
  return upper;
}

/**
 * Load sheet values into an ephemeral DB.
 * Caller must db.close().
 * Returns load-time colTypes (from raw Sheets values) for correct bool vs 0/1 formatting.
 */
export async function loadSheetIntoSql(sheetValues, headerRows, sheetName) {
  const SQL = await getSqlJs();
  const db = new SQL.Database();
  const values = sheetValues || [];
  const header = values[headerRows - 1] || [];
  const dataRows = values.slice(headerRows);
  const width = sheetColumnWidth(values, headerRows);
  const colLetters = Array.from({ length: width + 1 }, (_, i) => colIndexToLetter(i));

  const loadColTypes = colLetters.map((_, ci) => {
    const colVals = dataRows.map((row) => {
      const v = row?.[ci];
      return v === undefined || v === "" ? null : v;
    });
    return inferQueryColType(colVals);
  });

  const table = quoteIdent(sheetName);
  const colDefs = colLetters.map((c) => quoteIdent(c)).join(", ");
  db.run(`CREATE TABLE ${table} (${colDefs})`);

  if (dataRows.length > 0) {
    const placeholders = colLetters.map(() => "?").join(", ");
    const insertSql = `INSERT INTO ${table} VALUES (${placeholders})`;
    const stmt = db.prepare(insertSql);
    try {
      for (const row of dataRows) {
        const params = colLetters.map((_, i) => cellToSqlValue(row?.[i]));
        stmt.run(params);
      }
    } finally {
      stmt.free();
    }
  }

  return { db, width, header, colLetters, loadColTypes };
}

/**
 * Per-column date-format mask from Sheets cell formats.
 * A cell is date-formatted when raw is number and formatted is a non-empty string
 * (UNFORMATTED_VALUE + dateTimeRenderOption=FORMATTED_STRING).
 * Column is date iff ≥1 numeric data cell is date-formatted and none is plain number.
 * Mixed → not date. Sparse-safe (missing row/index/undefined → not date-formatted).
 *
 * @returns {{ [letter: string]: boolean }}
 */
export function buildDateColumnMask(rawRows, fmtRows, headerRows) {
  const raw = rawRows || [];
  const fmt = fmtRows || [];
  const width = Math.max(
    0,
    ...raw.map((r) => (r ? r.length : 0)),
    ...fmt.map((r) => (r ? r.length : 0))
  );
  const mask = {};
  for (let ci = 0; ci < width; ci++) {
    const letter = colIndexToLetter(ci);
    let sawDateFmt = false;
    let sawPlainNumber = false;
    const maxRows = Math.max(raw.length, fmt.length);
    for (let ri = headerRows; ri < maxRows; ri++) {
      const rawVal = raw[ri]?.[ci];
      if (typeof rawVal !== "number" || Number.isNaN(rawVal)) continue;
      const fmtVal = fmt[ri]?.[ci];
      if (typeof fmtVal === "string" && fmtVal !== "") {
        sawDateFmt = true;
      } else {
        sawPlainNumber = true;
      }
    }
    mask[letter] = sawDateFmt && !sawPlainNumber;
  }
  return mask;
}

/** Strip trailing `AS alias` (string-literal-safe). */
function stripTrailingAsAlias(expr) {
  const masked = maskSqlStringLiterals(expr);
  const m = masked.match(/\s+as\s+[A-Za-z_][A-Za-z0-9_]*\s*$/i);
  if (m && m.index !== undefined) return expr.slice(0, m.index).trim();
  return String(expr).trim();
}

/**
 * Split prepared SELECT list into expressions (comma at depth 0).
 * Uses string-literal-masked SQL for structure; returns raw slices.
 * @returns {string[] | null}
 */
export function splitSelectList(preparedSql) {
  const sql = String(preparedSql);
  const masked = maskSqlStringLiterals(sql);
  const selectMatch = masked.match(/^\s*select\s+/i);
  if (!selectMatch) return null;
  let start = selectMatch[0].length;
  const distinctMatch = masked.slice(start).match(/^distinct\s+/i);
  if (distinctMatch) start += distinctMatch[0].length;

  let depth = 0;
  let end = masked.length;
  for (let i = start; i < masked.length; i++) {
    const ch = masked[i];
    if (ch === "(") depth++;
    else if (ch === ")") depth = Math.max(0, depth - 1);
    else if (depth === 0) {
      const rest = masked.slice(i);
      const kw = rest.match(/^(from|where|group\s+by|having|order\s+by|limit)\b/i);
      if (kw) {
        end = i;
        break;
      }
    }
  }

  const listMasked = masked.slice(start, end);
  const listRaw = sql.slice(start, end);
  const items = [];
  let itemStart = 0;
  depth = 0;
  for (let i = 0; i < listMasked.length; i++) {
    const ch = listMasked[i];
    if (ch === "(") depth++;
    else if (ch === ")") depth = Math.max(0, depth - 1);
    else if (ch === "," && depth === 0) {
      items.push(stripTrailingAsAlias(listRaw.slice(itemStart, i)));
      itemStart = i + 1;
    }
  }
  items.push(stripTrailingAsAlias(listRaw.slice(itemStart)));
  return items.filter((s) => s.length > 0);
}

/**
 * Classify a SELECT expression for date inheritance.
 * @returns {{ kind: "bare"|"inherit"|"never_date"|"star", letter?: string }}
 */
export function classifySelectExpr(expr) {
  const e = String(expr).trim();
  if (e === "*" || /\.\*$/.test(e)) return { kind: "star" };
  if (/^[A-Za-z]{1,3}$/.test(e)) return { kind: "bare", letter: e.toUpperCase() };
  const minMax = e.match(/^(MIN|MAX)\s*\(\s*([A-Za-z]{1,3})\s*\)$/i);
  if (minMax) return { kind: "inherit", letter: minMax[2].toUpperCase() };
  return { kind: "never_date" };
}

function dateOrDatetimeFromValues(values) {
  const nums = values.filter((v) => typeof v === "number" && !Number.isNaN(v));
  if (nums.length === 0) return "date";
  return nums.some((v) => Math.abs(v % 1) >= 1e-10) ? "datetime" : "date";
}

/**
 * Result column typing (DEV-078): format-mask + SELECT-expression classification.
 * Without format mask: load-time date heuristic on full columns (test/compat only).
 */
export function classifyResultColumn(
  colName,
  values,
  sheetColSet,
  loadTypeByLetter,
  dateColumnMask,
  selectKind,
  selectLetter
) {
  const upper = String(colName).toUpperCase();
  // Only force load-time type for real booleans (avoids 0/1 number cols → true/false).
  if (sheetColSet.has(upper) && loadTypeByLetter[upper] === "boolean") {
    return "boolean";
  }
  if (values.every((v) => v === null || v === undefined || v === "")) return "string";

  const letterForDate =
    selectKind === "bare" || selectKind === "inherit"
      ? selectLetter
      : selectKind === "name_fallback" && sheetColSet.has(upper)
        ? upper
        : null;

  let isDateCol = false;
  if (selectKind === "never_date") {
    isDateCol = false;
  } else if (letterForDate) {
    if (dateColumnMask) {
      isDateCol = dateColumnMask[letterForDate] === true;
    } else {
      const loadT = loadTypeByLetter[letterForDate];
      isDateCol = loadT === "date" || loadT === "datetime";
    }
  }

  if (isDateCol) return dateOrDatetimeFromValues(values);
  return inferQueryColType(values, { allowDate: false });
}

/**
 * Run prepared SELECT; format cells (dates→ISO, nums, bools).
 * @param {{ [letter: string]: boolean } | null} [dateColumnMask] from buildDateColumnMask; null = fallback
 */
export function runSheetSql(
  db,
  preparedSql,
  header,
  sheetColSet = new Set(),
  loadColTypes = [],
  colLetters = [],
  dateColumnMask = null
) {
  let colNames;
  let projectedRaw;
  try {
    const stmt = db.prepare(preparedSql);
    try {
      colNames = stmt.getColumnNames().map((c) => String(c));
      projectedRaw = [];
      while (stmt.step()) {
        const row = stmt.get();
        projectedRaw.push(row.map((v) => (v === undefined || v === "" ? null : v)));
      }
    } finally {
      stmt.free();
    }
  } catch (e) {
    const msg = e && e.message ? e.message : String(e);
    throw new Error(`query_sheet: SQL error — ${msg}`);
  }

  const loadTypeByLetter = {};
  colLetters.forEach((letter, i) => {
    loadTypeByLetter[letter] = loadColTypes[i] || "string";
  });

  const selectItems = splitSelectList(preparedSql);
  const useNameFallback =
    !selectItems ||
    selectItems.length !== colNames.length ||
    selectItems.some((item) => classifySelectExpr(item).kind === "star");

  const colTypes = colNames.map((name, ci) => {
    let selectKind;
    let selectLetter;
    if (useNameFallback) {
      selectKind = "name_fallback";
      selectLetter = undefined;
    } else {
      const classified = classifySelectExpr(selectItems[ci]);
      if (classified.kind === "bare" || classified.kind === "inherit") {
        selectKind = classified.kind;
        selectLetter = classified.letter;
      } else {
        selectKind = "never_date";
        selectLetter = undefined;
      }
    }
    return classifyResultColumn(
      name,
      projectedRaw.map((r) => r[ci]),
      sheetColSet,
      loadTypeByLetter,
      dateColumnMask,
      selectKind,
      selectLetter
    );
  });

  const rows = projectedRaw.map((row) =>
    row.map((v, i) => formatQueryCell(v, colTypes[i]))
  );

  const columns = colNames.map((name) => resultColumnLabel(name, header, sheetColSet));

  return {
    columns,
    col_types: colTypes,
    matched_rows: rows.length,
    rows,
  };
}

/**
 * Full pipeline: load → prepare → run → discard DB.
 * @param {unknown[][]} [formattedValues] parallel values.get with dateTimeRenderOption=FORMATTED_STRING
 */
export async function executeSheetSqlQuery(sheetValues, headerRows, sheetName, query, formattedValues) {
  const preparedSql = prepareSheetSql(query, sheetName);
  const { db, header, colLetters, loadColTypes } = await loadSheetIntoSql(
    sheetValues,
    headerRows,
    sheetName
  );
  const sheetColSet = new Set(colLetters);
  const dateColumnMask =
    formattedValues !== undefined && formattedValues !== null
      ? buildDateColumnMask(sheetValues, formattedValues, headerRows)
      : null;
  try {
    return runSheetSql(
      db,
      preparedSql,
      header,
      sheetColSet,
      loadColTypes,
      colLetters,
      dateColumnMask
    );
  } finally {
    db.close();
  }
}
