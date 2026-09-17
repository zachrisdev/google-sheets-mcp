#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { google } from "googleapis";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import {
  colLetterToIndex,
  colIndexToLetter,
  coerceNumber,
  formatGvizDate,
  formatQueryCell,
  formatSheetsSerialDate,
  inferQueryColType,
  isSheetsDateSerial,
  looksLikeDateString,
  parseDateishToSerial,
} from "./sheet-helpers.js";
import { executeSheetSqlQuery } from "./sheet-sql.js";
import {
  ALLOW_TEXT_NUMERICS_PROP,
  assertNoDotDecimalTextNumerics,
  getSpreadsheetLocale,
  parseAllowTextNumerics,
} from "./type-guards.js";
import {
  applyReplace,
  assertCellSizeLimit,
  assertNoForeignDecimalFinalCell,
  assertNoForeignDecimalInSetOps,
  assertNoLeadingFormulaChars,
  assertNoLegacySetParam,
  assertOccurrenceBudget,
  cellHasTextFormatRuns,
  cellTextForReplace,
  normalizeOperations,
  parseAllowFormula,
  snippetAround,
} from "./update-where-ops.js";
import { REQUEST_ID_PROP, withWriteDedupe } from "./write-dedupe.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CREDENTIALS_PATH = path.join(__dirname, "credentials.json");
const TOKEN_PATH = path.join(__dirname, "token.json");

// Re-export helpers so unit tests can import from index.js
export {
  colLetterToIndex,
  colIndexToLetter,
  coerceNumber,
  formatGvizDate,
  formatQueryCell,
  formatSheetsSerialDate,
  inferQueryColType,
  isSheetsDateSerial,
  looksLikeDateString,
  parseDateishToSerial,
  utcPartsToSheetsSerial,
} from "./sheet-helpers.js";
// Keep evaluateCondition / rowMatches below as local exports.
export {
  executeSheetSqlQuery,
  prepareSheetSql,
  rewriteContainsToLike,
  cellToSqlValue,
  ensureFromClause,
  assertSelectOnly,
  maskSqlStringLiterals,
} from "./sheet-sql.js";
export {
  ALLOW_TEXT_NUMERICS_PROP,
  COMMA_DECIMAL_TEXT_RE,
  DOT_DECIMAL_TEXT_RE,
  assertNoDotDecimalTextInSet,
  assertNoDotDecimalTextNumerics,
  clearSpreadsheetLocaleCache,
  decimalSeparatorForLocale,
  formatDotDecimalTextError,
  formatForeignDecimalTextError,
  getSpreadsheetLocale,
  isCommaDecimalTextNumeric,
  isDotDecimalTextNumeric,
  isForeignDecimalTextNumeric,
  normalizeLocaleTag,
  parseAllowTextNumerics,
  suggestedNumberFromCommaDecimalText,
  suggestedNumberFromDotDecimalText,
  suggestedNumberFromForeignDecimalText,
} from "./type-guards.js";
export {
  REQUEST_ID_PROP,
  withWriteDedupe,
  buildDedupeKey,
  canonicalJson,
  lookupDedupe,
  storeDedupe,
  annotateDedupedResponse,
  parseRequestId,
  sha256Hex,
  shortFp,
  _resetDedupeForTests,
  _dedupeSizeForTests,
  DEDUPE_TTL_MS,
} from "./write-dedupe.js";
export {
  applyReplace,
  assertCellSizeLimit,
  assertNoForeignDecimalFinalCell,
  assertNoForeignDecimalInSetOps,
  assertNoLeadingFormulaChars,
  assertNoLegacySetParam,
  assertOccurrenceBudget,
  cellHasTextFormatRuns,
  cellTextForReplace,
  normalizeOperations,
  parseAllowFormula,
  snippetAround,
  MAX_CELL_CHARS,
  MAX_OCCURRENCES_PER_CALL,
} from "./update-where-ops.js";

// Auth setup
async function getAuth() {
  const credentials = JSON.parse(fs.readFileSync(CREDENTIALS_PATH));
  const { client_id, client_secret, redirect_uris } = credentials.installed;
  const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);

  if (fs.existsSync(TOKEN_PATH)) {
    const token = JSON.parse(fs.readFileSync(TOKEN_PATH));
    oAuth2Client.setCredentials(token);
    oAuth2Client.on('tokens', (tokens) => {
      const current = JSON.parse(fs.readFileSync(TOKEN_PATH));
      fs.writeFileSync(TOKEN_PATH, JSON.stringify({ ...current, ...tokens }));
    });
    return oAuth2Client;
  }
  throw new Error(`Authentication token missing. Please run 'npm run auth' in your terminal to authenticate.`);
}

// Extract sheet ID from URL or use directly
function extractSheetId(urlOrId) {
  const match = urlOrId.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  return match ? match[1] : urlOrId;
}

// --- update_where helpers (exported for credential-free unit testing) ---

// Evaluate a single condition against a cell value.
export function evaluateCondition(cell, op, value) {
  const isEmpty = cell === null || cell === undefined || cell === "";
  switch (op) {
    case "empty":
      return isEmpty;
    case "not_empty":
      return !isEmpty;
    case "contains":
      return String(cell ?? "").toLowerCase().includes(String(value ?? "").toLowerCase());
    case "eq":
    case "ne":
    case "gt":
    case "gte":
    case "lt":
    case "lte": {
      if (looksLikeDateString(value) && parseDateishToSerial(value) === null) {
        throw new Error(
          `where: value is not a valid date for comparison: ${JSON.stringify(String(value))}`
        );
      }

      const cellSerial =
        typeof cell === "number" && isSheetsDateSerial(cell)
          ? cell
          : parseDateishToSerial(cell);
      const valueSerial = parseDateishToSerial(value);
      const cellNum = coerceNumber(cell);
      const valueNum = coerceNumber(value);
      const relational = op === "gt" || op === "gte" || op === "lt" || op === "lte";

      // Date path: ISO/serial value and/or Sheets date-serial cell.
      if (valueSerial !== null || cellSerial !== null) {
        if (valueSerial !== null) {
          const cn = cellSerial !== null ? cellSerial : cellNum;
          if (cn === null) {
            if (!relational) {
              const equal = String(cell ?? "") === String(value ?? "");
              return op === "eq" ? equal : !equal;
            }
            throw new Error(
              `where: cannot compare non-numeric/empty cell with date value ${JSON.stringify(String(value))}`
            );
          }
          return compareNums(cn, valueSerial, op);
        }
        // cell is date-serial; value is not dateish
        if (valueNum !== null) {
          return compareNums(cellSerial, valueNum, op);
        }
        if (!relational) {
          const equal = String(cell ?? "") === String(value ?? "");
          return op === "eq" ? equal : !equal;
        }
        throw new Error(
          `where: cannot compare date cell with non-date value ${JSON.stringify(String(value ?? ""))}`
        );
      }

      // Legacy number / string path
      if (relational) {
        if (cellNum === null || valueNum === null) return false;
        return compareNums(cellNum, valueNum, op);
      }
      const equal =
        cellNum !== null && valueNum !== null
          ? cellNum === valueNum
          : String(cell ?? "") === String(value ?? "");
      return op === "eq" ? equal : !equal;
    }
    default:
      throw new Error(`Unknown operator: ${op}`);
  }
}

function compareNums(cn, vn, op) {
  if (op === "eq") return cn === vn;
  if (op === "ne") return cn !== vn;
  if (op === "gt") return cn > vn;
  if (op === "gte") return cn >= vn;
  if (op === "lt") return cn < vn;
  return cn <= vn;
}

// Does a single row (array of cell values) match the where conditions?
export function rowMatches(row, where, matchMode) {
  const test = (cond) => {
    const idx = colLetterToIndex(cond.column);
    const cell = row ? row[idx] : undefined;
    return evaluateCondition(cell, cond.op, cond.value);
  };
  return matchMode === "OR" ? where.some(test) : where.every(test);
}

// --- insert_rows helpers ---

/** Map a JS cell value to Sheets API ExtendedValue for updateCells. */
export function toUserEnteredValue(v) {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "number" && !Number.isNaN(v)) return { numberValue: v };
  if (typeof v === "boolean") return { boolValue: v };
  const s = String(v);
  if (s.startsWith("=")) return { formulaValue: s };
  return { stringValue: s };
}

/** Convert a 2D values array into updateCells RowData[]. */
export function valuesToRowData(values) {
  return values.map((row) => ({
    values: (row || []).map((cell) => {
      const uev = toUserEnteredValue(cell);
      return uev ? { userEnteredValue: uev } : {};
    }),
  }));
}

// --- Hybrid Cell helpers (value|segments + cell defaults / segment overrides) ---

const CELL_TEXT_KEYS = ["bold", "italic", "underline", "strikethrough", "color"];
const CELL_FORMAT_KEYS = [...CELL_TEXT_KEYS, "bg", "wrap"];
const SEGMENT_KEYS = ["text", ...CELL_TEXT_KEYS, "link"];

/** Parse #RGB / #RRGGBB into Sheets ColorStyle (rgb 0–1). */
export function parseHexColor(hex, fieldName = "color") {
  if (typeof hex !== "string") {
    throw new Error(`${fieldName} must be a hex string like #RRGGBB`);
  }
  let h = hex.trim();
  if (!h.startsWith("#")) h = `#${h}`;
  if (/^#[0-9A-Fa-f]{3}$/.test(h)) {
    h = `#${h[1]}${h[1]}${h[2]}${h[2]}${h[3]}${h[3]}`;
  }
  if (!/^#[0-9A-Fa-f]{6}$/.test(h)) {
    throw new Error(`Invalid ${fieldName}: ${hex} (expected #RGB or #RRGGBB)`);
  }
  return {
    rgbColor: {
      red: parseInt(h.slice(1, 3), 16) / 255,
      green: parseInt(h.slice(3, 5), 16) / 255,
      blue: parseInt(h.slice(5, 7), 16) / 255,
    },
  };
}

/** JS string.length is UTF-16 code units — same as Sheets textFormatRuns.startIndex. */
export function utf16Length(str) {
  return String(str).length;
}

/** Build TextFormat from props; only includes keys that are present. */
export function buildTextFormat(props, { allowLink = true } = {}) {
  if (!props || typeof props !== "object") return {};
  const format = {};
  for (const k of ["bold", "italic", "underline", "strikethrough"]) {
    if (props[k] !== undefined) format[k] = !!props[k];
  }
  if (props.color !== undefined) {
    format.foregroundColorStyle = parseHexColor(props.color, "color");
  }
  if (allowLink && props.link !== undefined) {
    if (typeof props.link !== "string" || !props.link.trim()) {
      throw new Error("link must be a non-empty string URI");
    }
    format.link = { uri: props.link.trim() };
  }
  return format;
}

/** Cell-level userEnteredFormat from defaults (bg/wrap + textFormat). */
export function buildUserEnteredFormat(defaults) {
  if (!defaults || typeof defaults !== "object") return null;
  const fmt = {};
  const tf = buildTextFormat(defaults, { allowLink: false });
  if (Object.keys(tf).length) fmt.textFormat = tf;
  if (defaults.bg !== undefined) {
    fmt.backgroundColorStyle = parseHexColor(defaults.bg, "bg");
  }
  if (defaults.wrap === true) fmt.wrapStrategy = "WRAP";
  return Object.keys(fmt).length ? fmt : null;
}

/**
 * Convert segments[] to { text, runs } for Sheets textFormatRuns.
 * A run is emitted at every segment start; absent format keys inherit cell format.
 */
export function segmentsToPlainAndRuns(segments, path = "segments") {
  if (!Array.isArray(segments) || segments.length === 0) {
    throw new Error(`${path} must be a non-empty array`);
  }
  let text = "";
  const runs = [];
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const segPath = `${path}[${i}]`;
    if (!seg || typeof seg !== "object" || Array.isArray(seg)) {
      throw new Error(`${segPath} must be an object with text`);
    }
    if (typeof seg.text !== "string") {
      throw new Error(`${segPath}.text is required (string)`);
    }
    for (const k of Object.keys(seg)) {
      if (!SEGMENT_KEYS.includes(k)) {
        throw new Error(`${segPath}: unknown key "${k}"`);
      }
    }
    const startIndex = utf16Length(text);
    text += seg.text;
    runs.push({ startIndex, format: buildTextFormat(seg, { allowLink: true }) });
  }
  return { text, runs };
}

/**
 * Normalize one cell: scalar | { value, …defaults } | { segments, …defaults }.
 * @returns {{ kind, value, plainText?, runs?, cellFormat, needsFormat, needsRich }}
 */
export function normalizeCell(raw, path = "cell") {
  if (raw === null || raw === undefined) {
    return { kind: "scalar", value: "", cellFormat: null, needsFormat: false, needsRich: false };
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return { kind: "scalar", value: raw, cellFormat: null, needsFormat: false, needsRich: false };
  }

  const hasValue = Object.prototype.hasOwnProperty.call(raw, "value");
  const hasSegments = Object.prototype.hasOwnProperty.call(raw, "segments");
  if (hasValue && hasSegments) {
    throw new Error(`${path}: provide value or segments, not both`);
  }
  if (!hasValue && !hasSegments) {
    throw new Error(`${path}: object cell needs value or segments`);
  }
  if (raw.link !== undefined) {
    throw new Error(`${path}: link is only allowed on segments, not at cell level`);
  }

  const defaults = {};
  for (const k of Object.keys(raw)) {
    if (k === "value" || k === "segments") continue;
    if (!CELL_FORMAT_KEYS.includes(k)) {
      throw new Error(`${path}: unknown key "${k}"`);
    }
    defaults[k] = raw[k];
  }
  const cellFormat = buildUserEnteredFormat(defaults);

  if (hasSegments) {
    const { text, runs } = segmentsToPlainAndRuns(raw.segments, `${path}.segments`);
    return {
      kind: "rich",
      value: text,
      plainText: text,
      runs,
      cellFormat,
      needsFormat: true,
      needsRich: true,
    };
  }

  const needsFormat = cellFormat !== null;
  return {
    kind: "value",
    value: raw.value,
    cellFormat,
    needsFormat,
    needsRich: false,
  };
}

export function normalizeValuesGrid(values, path = "values") {
  if (!Array.isArray(values)) throw new Error(`${path} must be a 2D array`);
  return values.map((row, i) => {
    if (!Array.isArray(row)) throw new Error(`${path}[${i}] must be an array (row)`);
    return row.map((cell, j) => normalizeCell(cell, `${path}[${i}][${j}]`));
  });
}

export function extractScalarValues(normalizedGrid) {
  return normalizedGrid.map((row) => row.map((c) => c.value));
}

export function gridNeedsHybrid(normalizedGrid) {
  return normalizedGrid.some((row) => row.some((c) => c.needsFormat || c.needsRich));
}

/** Parse sheet name + 0-based start from A1 range (e.g. Sheet1!B2:D4, 'My Sheet'!A1, A1). */
export function parseA1RangeStart(range) {
  if (typeof range !== "string" || !range.trim()) {
    throw new Error("range is required to apply cell formatting");
  }
  let sheetName = null;
  let a1 = range.trim();
  const bang = a1.match(/^(?:'([^']+)'|([^'!]+))!(.+)$/);
  if (bang) {
    sheetName = bang[1] || bang[2];
    a1 = bang[3];
  }
  const startCell = a1.split(":")[0].trim();
  const cm = startCell.match(/^([A-Za-z]+)(\d+)$/);
  if (!cm) throw new Error(`Cannot parse A1 start from range: ${range}`);
  return {
    sheetName,
    startCol: colLetterToIndex(cm[1]),
    startRow: parseInt(cm[2], 10) - 1,
  };
}

export function collectFormatRequests(normalizedGrid, sheetId, startRow, startCol) {
  const requests = [];
  for (let r = 0; r < normalizedGrid.length; r++) {
    for (let c = 0; c < normalizedGrid[r].length; c++) {
      const cell = normalizedGrid[r][c];
      if (!cell.needsFormat && !cell.needsRich) continue;
      const cellData = {};
      const fields = [];
      if (cell.needsRich) {
        cellData.userEnteredValue = { stringValue: cell.plainText ?? "" };
        cellData.textFormatRuns = cell.runs ?? [];
        fields.push("userEnteredValue", "textFormatRuns");
      }
      if (cell.cellFormat) {
        cellData.userEnteredFormat = cell.cellFormat;
        fields.push("userEnteredFormat");
      }
      if (!fields.length) continue;
      requests.push({
        updateCells: {
          range: {
            sheetId,
            startRowIndex: startRow + r,
            endRowIndex: startRow + r + 1,
            startColumnIndex: startCol + c,
            endColumnIndex: startCol + c + 1,
          },
          rows: [{ values: [cellData] }],
          fields: fields.join(","),
        },
      });
    }
  }
  return requests;
}

async function resolveSheetId(sheets, spreadsheetId, sheetName) {
  const meta = await sheets.spreadsheets.get({
    spreadsheetId,
    fields: "sheets.properties(sheetId,title)",
  });
  const list = meta.data.sheets || [];
  if (sheetName) {
    const found = list.find((s) => s.properties?.title === sheetName);
    if (!found) {
      const titles = list.map((s) => s.properties?.title).filter(Boolean);
      throw new Error(`Sheet tab not found: "${sheetName}". Available: ${titles.join(", ") || "(none)"}`);
    }
    return found.properties.sheetId;
  }
  if (!list[0]) throw new Error("Spreadsheet has no sheets");
  return list[0].properties.sheetId;
}

async function applyHybridFormats(sheets, spreadsheetId, normalizedGrid, rangeForStart) {
  if (!gridNeedsHybrid(normalizedGrid)) return;
  const { sheetName, startRow, startCol } = parseA1RangeStart(rangeForStart);
  const sheetId = await resolveSheetId(sheets, spreadsheetId, sheetName);
  const requests = collectFormatRequests(normalizedGrid, sheetId, startRow, startCol);
  if (!requests.length) return;
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: { requests },
  });
}

function parseValuesArg(values, label = "values") {
  let v = values;
  if (typeof v === "string") {
    try {
      v = JSON.parse(v);
    } catch (e) {
      throw new Error(`Failed to parse ${label} string as JSON: ${e.message}`);
    }
  }
  if (!Array.isArray(v)) throw new Error(`${label} must be a 2D array.`);
  return v;
}

// MCP Server Creation
export function createMcpServer() {
  const server = new Server(
    { name: "google-sheets-mcp", version: "1.0.0" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const tools = [
      {
        name: "read_sheet",
        description: "Read sheet data. URL/ID; optional A1 range (e.g. Sheet1!A1:Z100, default all).",
        inputSchema: {
          type: "object",
          properties: {
            url_or_id: { type: "string", description: "Sheet URL or ID" },
            range: { type: "string", description: "A1 range (default all)" },
          },
          required: ["url_or_id"],
        },
      },
      {
        name: "write_sheet",
        description:
          "Overwrite cells in A1 range. values: 2D array of scalars or Cell objects. " +
          "Cell: {value, bold?, …} OR {segments:[…]}. Scalars keep USER_ENTERED date/number parse. " +
          "Rejects text numerics that use the foreign decimal separator for the spreadsheet locale (e.g. \"29.3\" on hu_HU); pass JSON number or allow_text_numerics:true. " +
          "Optional request_id / identical-payload TTL dedupe (~5 min) against Claude Desktop false timeouts.",
        inputSchema: {
          type: "object",
          properties: {
            url_or_id: { type: "string", description: "Sheet URL or ID" },
            range: { type: "string", description: "A1 range (e.g. Sheet1!A1)" },
            values: { type: "array", description: "2D array of scalars or Cell objects", items: { type: "array" } },
            allow_text_numerics: ALLOW_TEXT_NUMERICS_PROP,
            request_id: REQUEST_ID_PROP,
          },
          required: ["url_or_id", "range", "values"],
        },
      },
      {
        name: "append_rows",
        description:
          "Append rows to sheet end. values: 2D scalars or Cell objects (same as write_sheet). " +
          "Scalars USER_ENTERED; formatting via updateCells. " +
          "Rejects text numerics with the foreign decimal separator for the spreadsheet locale; pass JSON number or allow_text_numerics:true. " +
          "Optional request_id / identical-payload TTL dedupe (~5 min).",
        inputSchema: {
          type: "object",
          properties: {
            url_or_id: { type: "string", description: "Sheet URL or ID" },
            range: { type: "string", description: "Tab name (e.g. Sheet1)" },
            values: { type: "array", description: "2D array of scalars or Cell objects", items: { type: "array" } },
            allow_text_numerics: ALLOW_TEXT_NUMERICS_PROP,
            request_id: REQUEST_ID_PROP,
          },
          required: ["url_or_id", "range", "values"],
        },
      },
      {
        name: "insert_rows",
        description:
          "Insert rows at 0-based startIndex (UI Insert row). Optional values (hybrid format). " +
          "Fill via USER_ENTERED + format overlay (NOT one atomic batchUpdate). Newest-below-header: startIndex=1. " +
          "Rejects text numerics with the foreign decimal separator for the spreadsheet locale; pass JSON number or allow_text_numerics:true. " +
          "Optional request_id / identical-payload TTL dedupe (~5 min) — use after Desktop timeouts before retrying.",
        inputSchema: {
          type: "object",
          properties: {
            url_or_id: { type: "string", description: "Sheet URL or ID" },
            sheet: { type: "string", description: "Tab name (e.g. Sheet1)" },
            startIndex: { type: "integer", description: "0-based row index to insert at (0=before first row; 1=below one header row)" },
            rows: { type: "integer", description: "Blank rows to insert when values omitted (default 1)" },
            values: { type: "array", description: "Optional 2D scalars or Cell objects; row count = values.length", items: { type: "array" } },
            inheritFromBefore: { type: "boolean", description: "Inherit formatting from row above (default false; must be false if startIndex=0)" },
            allow_text_numerics: ALLOW_TEXT_NUMERICS_PROP,
            request_id: REQUEST_ID_PROP,
          },
          required: ["url_or_id", "sheet", "startIndex"],
        },
      },
      {
        name: "get_sheet_info",
        description: "Tab names, row/col counts. Call first to discover sheets.",
        inputSchema: {
          type: "object",
          properties: {
            url_or_id: { type: "string", description: "Sheet URL or ID" },
          },
          required: ["url_or_id"],
        },
      },
      {
        name: "clear_range",
        description: "Clear cell contents. Needs url_or_id, A1 range.",
        inputSchema: {
          type: "object",
          properties: {
            url_or_id: { type: "string", description: "Sheet URL or ID" },
            range: { type: "string", description: "A1 range to clear" },
          },
          required: ["url_or_id", "range"],
        },
      },
      {
        name: "query_sheet",
        description:
          "SQLite SELECT on a sheet tab (Sheets API load → ephemeral sql.js; ignores UI basicFilter). " +
          "Table = tab name (FROM optional — auto-injected). Columns = A,B,C… only (response `columns` uses header labels). " +
          "Examples: SELECT C, COUNT(*) FROM Alerts WHERE C = 'AMZN' GROUP BY C; " +
          "SELECT * WHERE C = 'AMZN' ORDER BY A DESC LIMIT 20; " +
          "SELECT A WHERE A contains 'hun' (→ LIKE). " +
          "Supports WHERE/GROUP BY/ORDER BY/LIMIT and COUNT/SUM/AVG/MIN/MAX. Single table only. Returns {columns, col_types, matched_rows, rows}.",
        inputSchema: {
          type: "object",
          properties: {
            url_or_id: { type: "string", description: "Sheet URL or ID" },
            sheet: { type: "string", description: "Tab name (= SQL table name)" },
            query: {
              type: "string",
              description:
                "SQLite SELECT. Cols A,B,C…. FROM optional. E.g. SELECT C, COUNT(*) WHERE C = 'AMZN' GROUP BY C",
            },
            header_rows: { type: "integer", description: "Header rows to skip (default 0)" },
          },
          required: ["url_or_id", "sheet", "query"],
        },
      },
      {
        name: "update_where",
        description:
          "Filter (where) + column ops in one call — use instead of query_sheet+write_sheet; no row indices. " +
          "HARD BREAK: top-level 'set' removed — use operations[] with op discriminator. " +
          "ops: set (full overwrite) | replace (literal in-cell find/replace; replace_all default true; no regex). " +
          "replace targets must be string/empty cells (number/bool/date-serial → error). " +
          "Cells with textFormatRuns → refused (plain path only; formatting support is a separate backlog). " +
          "Not atomic; read+write back-to-back. ≥1 where required. Safety: dry_run, limit, expected_match_count, expected_occurrence_count. " +
          "Rejects foreign-decimal text numerics on set values and on final cell text when the entire cell matches (also on dry_run). " +
          "Leading = + - @ on set value / post-replace text refused unless allow_formula:true. " +
          "After schema change: re-attach the MCP connector (Desktop / Claude.ai) so the client picks up operations.",
        inputSchema: {
          type: "object",
          properties: {
            url_or_id: { type: "string", description: "Sheet URL or ID" },
            sheet: { type: "string", description: "Tab name" },
            header_rows: { type: "integer", description: "Header rows to skip (default 0)" },
            where: {
              type: "array",
              description: "Filter conditions (≥1, by column letter)",
              items: {
                type: "object",
                properties: {
                  column: { type: "string", description: "Column letter (A, AA)" },
                  op: { type: "string", enum: ["eq", "ne", "contains", "gt", "gte", "lt", "lte", "empty", "not_empty"] },
                  value: { type: ["string", "number", "boolean"], description: "Compare value (omit for empty/not_empty)" },
                },
                required: ["column", "op"],
              },
            },
            match_mode: { type: "string", description: "Default AND", enum: ["AND", "OR"] },
            operations: {
              type: "array",
              minItems: 1,
              description:
                "ColumnOps (oneOf set|replace). set: {op,column,value}. replace: {op,column,find,replace,replace_all?}",
              items: {
                oneOf: [
                  {
                    type: "object",
                    properties: {
                      op: { type: "string", const: "set" },
                      column: { type: "string", description: "Column letter" },
                      value: { type: ["string", "number", "boolean"], description: "Full cell overwrite" },
                    },
                    required: ["op", "column", "value"],
                    additionalProperties: false,
                  },
                  {
                    type: "object",
                    properties: {
                      op: { type: "string", const: "replace" },
                      column: { type: "string", description: "Column letter" },
                      find: { type: "string", minLength: 1, description: "Literal substring (no regex)" },
                      replace: { type: "string", description: "Replacement (may be empty)" },
                      replace_all: {
                        type: "boolean",
                        description: "Replace every occurrence in the cell (default true)",
                      },
                    },
                    required: ["op", "column", "find", "replace"],
                    additionalProperties: false,
                  },
                ],
              },
            },
            dry_run: { type: "boolean", description: "Preview matches+snippets, no write (default false)" },
            limit: { type: "integer", description: "Max rows; refuse if exceeded" },
            expected_match_count: { type: "integer", description: "Abort if match count differs" },
            expected_occurrence_count: {
              type: "integer",
              description:
                "Abort if total applied replace occurrences across writable rows differs " +
                "(counts replacements performed: with replace_all:false, at most 1 per cell)",
            },
            allow_formula: {
              type: "boolean",
              description:
                "If true, allow leading = + - @ on set values / post-replace text (USER_ENTERED formulas). Default false.",
            },
            allow_text_numerics: ALLOW_TEXT_NUMERICS_PROP,
            request_id: REQUEST_ID_PROP,
          },
          required: ["url_or_id", "sheet", "where", "operations"],
        },
      },
    ];
    console.error(`[MCP] tools/list → ${tools.length} tools: ${tools.map((t) => t.name).join(", ")}`);
    return { tools };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const auth = await getAuth();
    const sheets = google.sheets({ version: "v4", auth });
    const { name, arguments: args } = request.params;
    console.error("[DBG]", JSON.stringify(args));
    
    const spreadsheetId = extractSheetId(args.url_or_id);

    try {
      if (name === "read_sheet") {
        const range = args.range || "A1:ZZ10000";
        const res = await sheets.spreadsheets.values.get({ spreadsheetId, range });
        return {
          content: [{ type: "text", text: JSON.stringify(res.data.values || [], null, 2) }],
        };
      }

      if (name === "write_sheet") {
        const values = parseValuesArg(args.values);
        const grid = normalizeValuesGrid(values);
        const scalarValues = extractScalarValues(grid);
        const locale = await getSpreadsheetLocale(sheets, spreadsheetId);
        assertNoDotDecimalTextNumerics(scalarValues, {
          allow: parseAllowTextNumerics(args.allow_text_numerics),
          toolName: "write_sheet",
          locale,
        });
        return await withWriteDedupe({
          tool: "write_sheet",
          spreadsheetId,
          args,
          fingerprintPayload: { range: args.range, values: scalarValues },
          run: async () => {
            await sheets.spreadsheets.values.update({
              spreadsheetId,
              range: args.range,
              valueInputOption: "USER_ENTERED",
              requestBody: { values: scalarValues },
            });
            await applyHybridFormats(sheets, spreadsheetId, grid, args.range);
            return { content: [{ type: "text", text: `Successfully written to ${args.range}` }] };
          },
        });
      }

      if (name === "append_rows") {
        const values = parseValuesArg(args.values);
        const grid = normalizeValuesGrid(values);
        const scalarValues = extractScalarValues(grid);
        const locale = await getSpreadsheetLocale(sheets, spreadsheetId);
        assertNoDotDecimalTextNumerics(scalarValues, {
          allow: parseAllowTextNumerics(args.allow_text_numerics),
          toolName: "append_rows",
          locale,
        });
        return await withWriteDedupe({
          tool: "append_rows",
          spreadsheetId,
          args,
          fingerprintPayload: { range: args.range, values: scalarValues },
          run: async () => {
            const appendRes = await sheets.spreadsheets.values.append({
              spreadsheetId,
              range: args.range,
              valueInputOption: "USER_ENTERED",
              requestBody: { values: scalarValues },
            });
            if (gridNeedsHybrid(grid)) {
              const updatedRange = appendRes.data.updates?.updatedRange;
              if (!updatedRange) {
                throw new Error("append succeeded but API returned no updatedRange; cannot apply cell formatting");
              }
              await applyHybridFormats(sheets, spreadsheetId, grid, updatedRange);
            }
            return { content: [{ type: "text", text: `Successfully appended ${values.length} rows` }] };
          },
        });
      }

      if (name === "insert_rows") {
        const startIndex = parseInt(args.startIndex, 10);
        if (Number.isNaN(startIndex) || startIndex < 0) {
          throw new Error("startIndex must be an integer >= 0 (0-based row index).");
        }
        if (!args.sheet || typeof args.sheet !== "string") {
          throw new Error("'sheet' (tab name) is required.");
        }

        let values = args.values;
        if (values !== undefined && typeof values === "string") {
          values = parseValuesArg(values);
        }
        const hasValues = values !== undefined && values !== null;
        let normalizedGrid = null;
        if (hasValues) {
          if (!Array.isArray(values) || values.length === 0) {
            throw new Error("'values' must be a non-empty 2D array when provided.");
          }
          normalizedGrid = normalizeValuesGrid(values);
        }

        const rowCount = hasValues
          ? normalizedGrid.length
          : (args.rows !== undefined ? parseInt(args.rows, 10) : 1);
        if (Number.isNaN(rowCount) || rowCount < 1) {
          throw new Error("'rows' must be an integer >= 1 when values are omitted.");
        }

        const inheritFromBefore = args.inheritFromBefore === true || args.inheritFromBefore === "true";
        if (inheritFromBefore && startIndex === 0) {
          throw new Error("inheritFromBefore cannot be true when startIndex is 0 (Sheets API constraint).");
        }

        // Reject bad numerics before insertDimension (avoid orphan blank rows on guard failure).
        const scalarValues = hasValues ? extractScalarValues(normalizedGrid) : null;
        if (hasValues) {
          const locale = await getSpreadsheetLocale(sheets, spreadsheetId);
          assertNoDotDecimalTextNumerics(scalarValues, {
            allow: parseAllowTextNumerics(args.allow_text_numerics),
            toolName: "insert_rows",
            locale,
          });
        }

        return await withWriteDedupe({
          tool: "insert_rows",
          spreadsheetId,
          args,
          fingerprintPayload: {
            sheet: args.sheet,
            startIndex,
            rowCount,
            inheritFromBefore,
            values: scalarValues,
          },
          run: async () => {
            const meta = await sheets.spreadsheets.get({
              spreadsheetId,
              fields: "sheets.properties(sheetId,title)",
            });
            const sheetMeta = (meta.data.sheets || []).find((s) => s.properties?.title === args.sheet);
            if (!sheetMeta) {
              const titles = (meta.data.sheets || []).map((s) => s.properties?.title).filter(Boolean);
              throw new Error(`Sheet tab not found: "${args.sheet}". Available: ${titles.join(", ") || "(none)"}`);
            }
            const sheetId = sheetMeta.properties.sheetId;

            // 1) Insert blank rows (shifts rows below).
            await sheets.spreadsheets.batchUpdate({
              spreadsheetId,
              requestBody: {
                requests: [
                  {
                    insertDimension: {
                      range: {
                        sheetId,
                        dimension: "ROWS",
                        startIndex,
                        endIndex: startIndex + rowCount,
                      },
                      inheritFromBefore,
                    },
                  },
                ],
              },
            });

            // 2) Fill with values.update USER_ENTERED — same parse path as append_rows/write_sheet.
            // Not atomic with step 1; if fill fails, blank inserted rows remain.
            if (hasValues) {
              const a1Start = `${args.sheet}!A${startIndex + 1}`;
              await sheets.spreadsheets.values.update({
                spreadsheetId,
                range: a1Start,
                valueInputOption: "USER_ENTERED",
                requestBody: { values: scalarValues },
              });
              await applyHybridFormats(sheets, spreadsheetId, normalizedGrid, a1Start);
            }

            const insertedAtRow = startIndex + 1;
            const endRow = startIndex + rowCount;
            return {
              content: [{
                type: "text",
                text: JSON.stringify({
                  rows_inserted: rowCount,
                  start_index: startIndex,
                  inserted_at_row: insertedAtRow,
                  filled: hasValues,
                  summary: `Inserted ${rowCount} row(s) at 0-based startIndex ${startIndex} (sheet rows ${insertedAtRow}${rowCount > 1 ? `–${endRow}` : ""}).`,
                }, null, 2),
              }],
            };
          },
        });
      }

      if (name === "get_sheet_info") {
        const res = await sheets.spreadsheets.get({ spreadsheetId });
        const info = res.data.sheets.map((s) => ({
          title: s.properties.title,
          rows: s.properties.gridProperties.rowCount,
          cols: s.properties.gridProperties.columnCount,
        }));
        return { content: [{ type: "text", text: JSON.stringify(info, null, 2) }] };
      }

      if (name === "clear_range") {
        await sheets.spreadsheets.values.clear({ spreadsheetId, range: args.range });
        return { content: [{ type: "text", text: `Cleared range ${args.range}` }] };
      }

      if (name === "query_sheet") {
        // 2026-07-24: GViz (/gviz/tq) silently respected UI basicFilter → false-negative
        // WHERE matches (AMZN 0 vs 6). Load via Sheets API (same as update_where),
        // run SQLite SELECT in ephemeral sql.js (aggregations, no GViz).
        const headerRows = args.header_rows !== undefined ? parseInt(args.header_rows) : 0;

        const sheetRes = await sheets.spreadsheets.values.get({
          spreadsheetId,
          range: `${args.sheet}!A:ZZ`,
          valueRenderOption: "UNFORMATTED_VALUE",
        });

        try {
          const result = await executeSheetSqlQuery(
            sheetRes.data.values || [],
            headerRows,
            args.sheet,
            args.query
          );
          return {
            content: [{
              type: "text",
              text: JSON.stringify(result, null, 2),
            }],
          };
        } catch (e) {
          const msg = e && e.message ? e.message : String(e);
          // Controlled SQL/parse errors → tool error text (no stack) for the agent
          if (/^query_sheet:/.test(msg)) {
            return {
              content: [{ type: "text", text: msg }],
              isError: true,
            };
          }
          throw e;
        }
      }

      if (name === "update_where") {
        assertNoLegacySetParam(args);
        let where = args.where;
        if (typeof where === "string") {
          try {
            where = JSON.parse(where);
          } catch (e) {
            throw new Error(`Failed to parse 'where' string as JSON: ${e.message}`);
          }
        }
        const operations = normalizeOperations(args.operations);
        const dryRun = args.dry_run === true || args.dry_run === "true";
        const allowFormula = parseAllowFormula(args.allow_formula);
        const allowTextNumerics = parseAllowTextNumerics(args.allow_text_numerics);
        if (!Array.isArray(where) || where.length === 0) {
          throw new Error("'where' must contain at least one condition (refusing to update an entire column).");
        }

        const locale = await getSpreadsheetLocale(sheets, spreadsheetId);
        assertNoForeignDecimalInSetOps(operations, {
          allow: allowTextNumerics,
          toolName: "update_where",
          locale,
        });
        for (let i = 0; i < operations.length; i++) {
          const op = operations[i];
          if (op.op === "set" && typeof op.value === "string") {
            assertNoLeadingFormulaChars(op.value, {
              allowFormula,
              path: `operations[${i}] set ${op.column}`,
            });
          }
        }

        const headerRows = args.header_rows !== undefined ? parseInt(args.header_rows) : 0;
        const matchMode = String(args.match_mode || "AND").toUpperCase() === "OR" ? "OR" : "AND";
        const hasReplace = operations.some((o) => o.op === "replace");
        const hasSet = operations.some((o) => o.op === "set");

        return await withWriteDedupe({
          tool: "update_where",
          spreadsheetId,
          args,
          skipDedupe: dryRun,
          fingerprintPayload: {
            sheet: args.sheet,
            where,
            operations,
            matchMode,
            headerRows,
            expected_match_count: args.expected_match_count ?? null,
            expected_occurrence_count: args.expected_occurrence_count ?? null,
            limit: args.limit ?? null,
            allow_formula: allowFormula,
          },
          run: async () => {
            const maxColIndex = Math.max(
              ...where.map((c) => colLetterToIndex(c.column)),
              ...operations.map((c) => colLetterToIndex(c.column))
            );
            const readRange = `${args.sheet}!A:${colIndexToLetter(maxColIndex)}`;

            const res = await sheets.spreadsheets.values.get({
              spreadsheetId,
              range: readRange,
              valueRenderOption: "UNFORMATTED_VALUE",
            });
            const values = res.data.values || [];

            const whereMatched = [];
            for (let i = headerRows; i < values.length; i++) {
              if (rowMatches(values[i], where, matchMode)) whereMatched.push(i + 1);
            }

            /** @type {Array<{ rowNum: number, writes: Array<{ column: string, value: unknown }>, replacePreview: Array<object> }>} */
            const planned = [];
            let totalOccurrences = 0;

            for (const rowNum of whereMatched) {
              const row = values[rowNum - 1] || [];
              const writes = [];
              const replacePreview = [];
              let rowHasWrite = false;

              for (let oi = 0; oi < operations.length; oi++) {
                const op = operations[oi];
                const colIdx = colLetterToIndex(op.column);
                const cellRaw = row[colIdx];

                if (op.op === "set") {
                  const finalVal = op.value;
                  if (typeof finalVal === "string") {
                    assertCellSizeLimit(finalVal, `operations[${oi}] set ${op.column}`);
                    assertNoForeignDecimalFinalCell(finalVal, {
                      allow: allowTextNumerics,
                      toolName: "update_where",
                      locale,
                      path: `operations[${oi}] set ${op.column}`,
                    });
                  }
                  writes.push({ column: op.column, value: finalVal });
                  rowHasWrite = true;
                  continue;
                }

                // replace
                const cellText = cellTextForReplace(
                  cellRaw,
                  `row ${rowNum} col ${op.column}`
                );
                if (!cellText.includes(op.find)) continue;

                const { text: newText, occurrences } = applyReplace(
                  cellText,
                  op.find,
                  op.replace,
                  op.replace_all
                );
                assertCellSizeLimit(newText, `operations[${oi}] replace ${op.column} row ${rowNum}`);
                assertNoLeadingFormulaChars(newText, {
                  allowFormula,
                  path: `operations[${oi}] replace ${op.column} row ${rowNum}`,
                });
                assertNoForeignDecimalFinalCell(newText, {
                  allow: allowTextNumerics,
                  toolName: "update_where",
                  locale,
                  path: `operations[${oi}] replace ${op.column} row ${rowNum}`,
                });
                totalOccurrences += occurrences;
                writes.push({ column: op.column, value: newText });
                replacePreview.push({
                  column: op.column,
                  find: op.find,
                  occurrences,
                  snippet: snippetAround(cellText, op.find),
                  before: cellText,
                  after: newText,
                });
                rowHasWrite = true;
              }

              if (rowHasWrite) {
                planned.push({ rowNum, writes, replacePreview });
              }
            }

            // Match basis for expected_match_count / limit:
            // replace-only → rows that receive at least one replace write
            // set (or mixed) → all where-matched (set always writes)
            const matchBasis = hasReplace && !hasSet
              ? planned.map((p) => p.rowNum)
              : whereMatched;

            if (args.expected_match_count !== undefined && matchBasis.length !== parseInt(args.expected_match_count)) {
              return {
                content: [{ type: "text", text: JSON.stringify({
                  matched_rows: matchBasis.length,
                  updated_rows: 0,
                  matched_row_numbers: matchBasis,
                  where_matched_rows: whereMatched.length,
                  dry_run: dryRun,
                  summary: `Precondition failed: expected_match_count=${parseInt(args.expected_match_count)} but ${matchBasis.length} row(s) matched. Nothing was written.`,
                }, null, 2) }],
                isError: true,
              };
            }
            if (args.limit !== undefined && matchBasis.length > parseInt(args.limit)) {
              return {
                content: [{ type: "text", text: JSON.stringify({
                  matched_rows: matchBasis.length,
                  updated_rows: 0,
                  matched_row_numbers: matchBasis,
                  dry_run: dryRun,
                  summary: `Refused: ${matchBasis.length} row(s) matched, exceeding limit=${parseInt(args.limit)}. Nothing was written.`,
                }, null, 2) }],
                isError: true,
              };
            }
            if (args.expected_occurrence_count !== undefined) {
              const expectedOcc = parseInt(args.expected_occurrence_count);
              if (totalOccurrences !== expectedOcc) {
                return {
                  content: [{ type: "text", text: JSON.stringify({
                    matched_rows: matchBasis.length,
                    updated_rows: 0,
                    matched_row_numbers: matchBasis,
                    occurrence_count: totalOccurrences,
                    dry_run: dryRun,
                    summary: `Precondition failed: expected_occurrence_count=${expectedOcc} but ${totalOccurrences} applied occurrence(s). Nothing was written.`,
                  }, null, 2) }],
                  isError: true,
                };
              }
            }

            try {
              assertOccurrenceBudget(totalOccurrences);
            } catch (e) {
              return {
                content: [{ type: "text", text: JSON.stringify({
                  matched_rows: matchBasis.length,
                  updated_rows: 0,
                  matched_row_numbers: matchBasis,
                  occurrence_count: totalOccurrences,
                  dry_run: dryRun,
                  summary: e.message,
                }, null, 2) }],
                isError: true,
              };
            }

            if (matchBasis.length === 0) {
              return {
                content: [{ type: "text", text: JSON.stringify({
                  matched_rows: 0,
                  updated_rows: 0,
                  matched_row_numbers: [],
                  where_matched_rows: whereMatched.length,
                  dry_run: dryRun,
                  summary: hasReplace && !hasSet
                    ? "No rows matched the filter with find substring — nothing was updated."
                    : "No rows matched the filter — nothing was updated.",
                }, null, 2) }],
              };
            }

            // Rich-text refuse on planned write targets (partial gridData; also on dry_run).
            const richTargets = [];
            const seen = new Set();
            for (const p of planned) {
              for (const w of p.writes) {
                const key = `${w.column}:${p.rowNum}`;
                if (seen.has(key)) continue;
                seen.add(key);
                richTargets.push({ column: w.column, rowNum: p.rowNum });
              }
            }
            if (richTargets.length > 0) {
              const ranges = richTargets.map(
                (t) => `${args.sheet}!${t.column}${t.rowNum}`
              );
              const gridRes = await sheets.spreadsheets.get({
                spreadsheetId,
                ranges,
                includeGridData: true,
                fields: "sheets.data.rowData.values.textFormatRuns",
              });
              const dataBlocks = gridRes.data.sheets?.[0]?.data || [];
              for (let i = 0; i < richTargets.length; i++) {
                const cellData = dataBlocks[i]?.rowData?.[0]?.values?.[0];
                if (cellHasTextFormatRuns(cellData)) {
                  const t = richTargets[i];
                  return {
                    content: [{ type: "text", text: JSON.stringify({
                      matched_rows: matchBasis.length,
                      updated_rows: 0,
                      matched_row_numbers: matchBasis,
                      dry_run: dryRun,
                      summary:
                        `Refused: cell ${t.column}${t.rowNum} has textFormatRuns (rich text). ` +
                        `update_where v1 is plain-value only. Nothing was written.`,
                    }, null, 2) }],
                    isError: true,
                  };
                }
              }
            }

            if (dryRun) {
              const preview = planned.map((p) => {
                const row = values[p.rowNum - 1] || [];
                const current = {};
                for (const c of where) {
                  const idx = colLetterToIndex(c.column);
                  current[c.column] = row[idx] !== undefined ? row[idx] : null;
                }
                for (const w of p.writes) {
                  const idx = colLetterToIndex(w.column);
                  current[w.column] = row[idx] !== undefined ? row[idx] : null;
                }
                return {
                  _row: p.rowNum,
                  current,
                  would_write: p.writes,
                  replace: p.replacePreview.length ? p.replacePreview : undefined,
                };
              });
              return {
                content: [{ type: "text", text: JSON.stringify({
                  matched_rows: matchBasis.length,
                  updated_rows: 0,
                  matched_row_numbers: matchBasis,
                  occurrence_count: totalOccurrences,
                  dry_run: true,
                  preview,
                  summary: `Dry run: ${matchBasis.length} row(s) would be updated` +
                    (hasReplace ? ` (${totalOccurrences} replace occurrence(s))` : "") +
                    `. Nothing was written.`,
                }, null, 2) }],
              };
            }

            // Collapse multiple writes to same cell (last wins) then batchUpdate.
            const dataMap = new Map();
            for (const p of planned) {
              for (const w of p.writes) {
                dataMap.set(
                  `${w.column}${p.rowNum}`,
                  { range: `${args.sheet}!${w.column}${p.rowNum}`, values: [[w.value]] }
                );
              }
            }
            const data = [...dataMap.values()];
            await sheets.spreadsheets.values.batchUpdate({
              spreadsheetId,
              requestBody: { valueInputOption: "USER_ENTERED", data },
            });

            return {
              content: [{ type: "text", text: JSON.stringify({
                matched_rows: matchBasis.length,
                updated_rows: matchBasis.length,
                matched_row_numbers: matchBasis,
                occurrence_count: totalOccurrences,
                dry_run: false,
                summary: `Updated ${matchBasis.length} row(s): ${matchBasis.join(", ")}.`,
              }, null, 2) }],
            };
          },
        });
      }
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
    }
  });

  return server;
}

// Start server locally if run directly
const isMain = process.argv[1] &&
  path.resolve(process.argv[1]).toLowerCase() === path.resolve(fileURLToPath(import.meta.url)).toLowerCase();

if (isMain) {
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

