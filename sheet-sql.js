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
  isSheetsDateSerial,
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

function refineResultColType(colName, values, sheetColSet, loadTypeByLetter) {
  const upper = String(colName).toUpperCase();
  // Only force load-time type for real booleans (avoids 0/1 number cols → true/false).
  // Mixed number/text columns stay result-inferred (SELECT C LIMIT 1 → number if that cell is numeric).
  if (sheetColSet.has(upper) && loadTypeByLetter[upper] === "boolean") {
    return "boolean";
  }
  if (values.every((v) => v === null || v === undefined || v === "")) return "string";
  if (values.some((v) => isSheetsDateSerial(v))) {
    const nonEmpty = values.filter((v) => v !== null && v !== undefined && v !== "");
    if (nonEmpty.length && nonEmpty.every((v) => isSheetsDateSerial(v))) {
      return nonEmpty.some((v) => Math.abs(v % 1) >= 1e-10) ? "datetime" : "date";
    }
  }
  return inferQueryColType(values);
}

/**
 * Run prepared SELECT; format cells (dates→ISO, nums, bools).
 */
export function runSheetSql(db, preparedSql, header, sheetColSet = new Set(), loadColTypes = [], colLetters = []) {
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

  const colTypes = colNames.map((name, ci) =>
    refineResultColType(
      name,
      projectedRaw.map((r) => r[ci]),
      sheetColSet,
      loadTypeByLetter
    )
  );

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

/** Full pipeline: load → prepare → run → discard DB. */
export async function executeSheetSqlQuery(sheetValues, headerRows, sheetName, query) {
  const preparedSql = prepareSheetSql(query, sheetName);
  const { db, header, colLetters, loadColTypes } = await loadSheetIntoSql(
    sheetValues,
    headerRows,
    sheetName
  );
  const sheetColSet = new Set(colLetters);
  try {
    return runSheetSql(db, preparedSql, header, sheetColSet, loadColTypes, colLetters);
  } finally {
    db.close();
  }
}
