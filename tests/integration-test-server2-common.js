/**
 * Gateway v2 integration tests — shared logic (local + live entry points).
 *
 * Run:
 *   node tests/integration-test-server2-local.js
 *   node tests/integration-test-server2-live.js
 */

import http from "http";
import https from "https";
import { google } from "googleapis";
import { parseHexColor } from "../index.js";
import {
  createTempSpreadsheet as createTempSpreadsheetShared,
  deleteTempSpreadsheet as deleteTempSpreadsheetShared,
  getGoogleAuth,
} from "./temp-spreadsheet.js";

const RICH_SHEET = "RichTest";

const FIXTURE = [
  ["Ticker", "Type", "Value"],
  ["AXON", "AR_TARGET", 10],
  ["NVO", "AR_STOP", 20],
  ["AXON", "AR_TARGET", 30],
  ["ANET", "AR_TARGET", 40],
];

// GvizTest tab: text-stored numbers, comma/dot decimals, empty cell
const GVIZ_FIXTURE = [
  ["Ticker", "Type", "Value", "Active"],
  ["ANET", "AR_TARGET", 100, true],
  ["ANET", "AR_TARGET", 110, true],
  ["ANET", "AR_TARGET", 120, true],
  ["NVO", "AR_STOP_DOT", "'42.30", true],
  ["NVO", "AR_STOP_COMMA", "'23,3", true],
  ["NVO", "AR_STOP_NUM", 42.30, true],
  ["NVO", "AR_STOP_EMPTY", null, true],
  ["NVO", "AR_STOP_BAD", "invalid_num", true],
  ["AXON", "AR_TARGET", 185, false],
];

const GVIZ_SHEET = "GvizTest";
const DATE_SHEET = "DateTest";
const DATE_FIXTURE = [
  ["Tool", "Action", "Status", "Date"],
  ["TOOL_TEST", "append_rows", "OK", "2026-07-10"],
];

let rpcId = 1;
let passed = 0;
let failed = 0;
let logPrefix = "";

function log(msg) {
  console.log(`${logPrefix}${msg}`);
}

function assert(label, condition, detail) {
  if (condition) {
    log(`  ✓ ${label}`);
    passed++;
    return;
  }
  console.error(`${logPrefix}  ✗ ${label}`);
  if (detail !== undefined) console.error(`${logPrefix}      ${detail}`);
  failed++;
  throw new Error(`Assert failed: ${label}`);
}

// --- Google lifecycle (local googleapis) ---

export async function createTempSpreadsheet() {
  return withSheetsQuotaRetry_("createTempSpreadsheet", () =>
    createTempSpreadsheetShared({ locale: "hu_HU", log })
  );
}

export async function deleteTempSpreadsheet(spreadsheetId) {
  return withSheetsQuotaRetry_("deleteTempSpreadsheet", () =>
    deleteTempSpreadsheetShared(spreadsheetId, { log })
  );
}

async function setupDateTestSheet(spreadsheetId) {
  await withSheetsQuotaRetry_(`setup ${DATE_SHEET}`, async () => {
    const auth = await getGoogleAuth();
    const sheets = google.sheets({ version: "v4", auth });
    log(`▶ Adding ${DATE_SHEET} tab with date fixture`);
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [{ addSheet: { properties: { title: DATE_SHEET } } }],
      },
    });
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `${DATE_SHEET}!A1`,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: DATE_FIXTURE },
    });
    log(`✓ ${DATE_SHEET} fixture written (${DATE_FIXTURE.length - 1} data rows)`);
  });
}

async function setupGvizTestSheet(spreadsheetId) {
  await withSheetsQuotaRetry_(`setup ${GVIZ_SHEET}`, async () => {
    const auth = await getGoogleAuth();
    const sheets = google.sheets({ version: "v4", auth });
    log(`▶ Adding ${GVIZ_SHEET} tab with GViz fixture`);
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [{ addSheet: { properties: { title: GVIZ_SHEET } } }],
      },
    });
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `${GVIZ_SHEET}!A1`,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: GVIZ_FIXTURE },
    });
    log(`✓ ${GVIZ_SHEET} fixture written (${GVIZ_FIXTURE.length - 1} data rows)`);
  });
}

function queryFirstCell(queryRes, colIndex = 0) {
  return queryRes.parsed?.rows?.[0]?.[colIndex];
}

function assertNumber(label, actual, expected) {
  assert(
    label,
    typeof actual === "number" && Math.abs(actual - expected) < 0.001,
    `actual=${JSON.stringify(actual)}, expected=${expected}`
  );
}

// --- MCP client (http / https) ---

/** Free-tier Sheets often ~60 read req/min/user — suite exceeds that without pacing. */
const MCP_TEST_MIN_INTERVAL_MS = Math.max(
  0,
  Number(process.env.MCP_TEST_MIN_INTERVAL_MS ?? 600)
);
const MCP_TEST_QUOTA_RETRIES = Math.max(
  1,
  Number(process.env.MCP_TEST_QUOTA_RETRIES ?? 8)
);

let lastSheetsTouchAt = 0;

function sleep_(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function isQuotaMessage_(s) {
  return /Quota exceeded|RATE_LIMIT|rateLimitExceeded|429/i.test(String(s || ""));
}

async function throttleSheetsTouch_() {
  if (MCP_TEST_MIN_INTERVAL_MS <= 0) return;
  const wait = lastSheetsTouchAt + MCP_TEST_MIN_INTERVAL_MS - Date.now();
  if (wait > 0) await sleep_(wait);
  lastSheetsTouchAt = Date.now();
}

/**
 * Pace + retry Google Sheets quota (MCP tool errors and thrown API errors).
 * @template T
 * @param {string} label
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
async function withSheetsQuotaRetry_(label, fn) {
  let lastErr;
  for (let attempt = 0; attempt < MCP_TEST_QUOTA_RETRIES; attempt++) {
    await throttleSheetsTouch_();
    try {
      const out = await fn();
      // tools/call often returns isError text instead of throwing
      if (out && typeof out === "object" && out.isError && isQuotaMessage_(out.text)) {
        lastErr = new Error(String(out.text).slice(0, 240));
      } else {
        return out;
      }
    } catch (e) {
      if (!isQuotaMessage_(e && e.message)) throw e;
      lastErr = e;
    }
    const delay = Math.min(60_000, 4_000 * 2 ** attempt);
    log(`⏳ Sheets quota (${label}) — retry ${attempt + 1}/${MCP_TEST_QUOTA_RETRIES} in ${Math.round(delay / 1000)}s`);
    await sleep_(delay);
  }
  throw lastErr || new Error(`Sheets quota exhausted after retries (${label})`);
}

function parseMcpBody(raw) {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("{")) return JSON.parse(trimmed);
  const dataLine = trimmed.split("\n").find((l) => l.startsWith("data:"));
  if (dataLine) return JSON.parse(dataLine.replace(/^data:\s*/, ""));
  throw new Error(`Cannot parse MCP response: ${trimmed.slice(0, 200)}`);
}

function mcpRequest(baseUrl, method, params, sessionId) {
  const url = new URL(baseUrl);
  const transport = url.protocol === "https:" ? https : http;
  const body = JSON.stringify({ jsonrpc: "2.0", id: rpcId++, method, params: params ?? {} });
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    "Content-Length": Buffer.byteLength(body),
  };
  if (sessionId) {
    headers["mcp-session-id"] = sessionId;
    headers["mcp-protocol-version"] = "2024-11-05";
  }

  return new Promise((resolve, reject) => {
    const req = transport.request(
      baseUrl,
      { method: "POST", headers },
      (res) => {
        let data = "";
        res.on("data", (chunk) => { data += chunk; });
        res.on("end", () => {
          if (res.statusCode >= 400) {
            reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 300)}`));
            return;
          }
          try {
            const payload = data ? parseMcpBody(data) : null;
            resolve({ statusCode: res.statusCode, headers: res.headers, payload });
          } catch (e) {
            reject(new Error(`Parse error: ${e.message}; body: ${data.slice(0, 300)}`));
          }
        });
      }
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

async function initializeSession(baseUrl) {
  const res = await mcpRequest(baseUrl, "initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "integration-test-server2", version: "1.0.0" },
  });
  const sessionId = res.headers["mcp-session-id"];
  assert("mcp-session-id header present", !!sessionId, `headers: ${JSON.stringify(res.headers)}`);
  await mcpRequest(baseUrl, "notifications/initialized", {}, sessionId);
  return sessionId;
}

async function callTool(baseUrl, sessionId, name, args) {
  return withSheetsQuotaRetry_(name, async () => {
    const res = await mcpRequest(baseUrl, "tools/call", { name, arguments: args }, sessionId);
    if (res.payload?.error) {
      const msg = JSON.stringify(res.payload.error);
      if (isQuotaMessage_(msg)) throw new Error(msg);
      throw new Error(`tools/call error: ${msg}`);
    }
    const result = res.payload?.result;
    const text = result?.content?.[0]?.text;
    let parsed = null;
    if (text) {
      try { parsed = JSON.parse(text); } catch { parsed = text; }
    }
    return { result, parsed, isError: !!result?.isError, text };
  });
}

function parseReadSheetRows(parsed) {
  if (Array.isArray(parsed)) return parsed;
  if (typeof parsed === "string") return JSON.parse(parsed);
  return parsed;
}

function colorsApproxEqual(style, hex) {
  const expected = parseHexColor(hex).rgbColor;
  const rgb = style?.rgbColor;
  if (!rgb) return false;
  const near = (a, b) => Math.abs((a ?? 0) - b) < 0.02;
  return near(rgb.red, expected.red) && near(rgb.green, expected.green) && near(rgb.blue, expected.blue);
}

async function getGridRowCells(spreadsheetId, a1Range) {
  return withSheetsQuotaRetry_(`getGridRowCells ${a1Range}`, async () => {
    const auth = await getGoogleAuth();
    const sheets = google.sheets({ version: "v4", auth });
    const res = await sheets.spreadsheets.get({
      spreadsheetId,
      ranges: [a1Range],
      includeGridData: true,
      fields:
        "sheets.data.rowData.values(userEnteredFormat,textFormatRuns,formattedValue,userEnteredValue,effectiveValue)",
    });
    return res.data.sheets?.[0]?.data?.[0]?.rowData?.[0]?.values ?? [];
  });
}

async function setupRichTestSheet(spreadsheetId) {
  await withSheetsQuotaRetry_(`setup ${RICH_SHEET}`, async () => {
    const auth = await getGoogleAuth();
    const sheets = google.sheets({ version: "v4", auth });
    log(`▶ Adding ${RICH_SHEET} tab`);
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [{ addSheet: { properties: { title: RICH_SHEET } } }],
      },
    });
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `${RICH_SHEET}!A1`,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [["Ts", "Level", "Message"]] },
    });
    log(`✓ ${RICH_SHEET} header written`);
  });
}

// --- Test cases ---

export async function runAllTests({ baseUrl, label }) {
  logPrefix = `[${label}] `;
  passed = 0;
  failed = 0;
  let spreadsheetId = null;
  let sheetName = "Sheet1";

  const timeout = setTimeout(() => {
    console.error(`\n${logPrefix}✗ Timeout: tests did not finish in 15m`);
    process.exit(1);
  }, 900_000);
  log(`▶ Server2 integration tests → ${baseUrl}`);
  log(`  Sheets pace: minInterval=${MCP_TEST_MIN_INTERVAL_MS}ms retries=${MCP_TEST_QUOTA_RETRIES}\n`);

  try {
    // 0. Temp spreadsheet
    ({ spreadsheetId, sheetName } = await createTempSpreadsheet());
    assert("spreadsheetId not empty", !!spreadsheetId);

    // 1. MCP session
    const sessionId = await initializeSession(baseUrl);
    assert("session initialized", !!sessionId);

    // 2. tools/list — update_where + insert_rows registered
    const listRes = await mcpRequest(baseUrl, "tools/list", {}, sessionId);
    const tools = listRes.payload?.result?.tools ?? [];
    const toolNames = tools.map((t) => t.name);
    assert("update_where in tools/list", toolNames.includes("update_where"), `tools: ${toolNames.join(", ")}`);
    assert("insert_rows in tools/list", toolNames.includes("insert_rows"), `tools: ${toolNames.join(", ")}`);

    // 3. Fixture
    const writeRes = await callTool(baseUrl, sessionId, "write_sheet", {
      url_or_id: spreadsheetId,
      range: `${sheetName}!A1`,
      values: FIXTURE,
    });
    assert("write_sheet succeeded", !writeRes.isError, writeRes.text);

    // 4. Dry run
    const dryRun = await callTool(baseUrl, sessionId, "update_where", {
      url_or_id: spreadsheetId,
      sheet: sheetName,
      header_rows: 1,
      where: [{ column: "A", op: "eq", value: "AXON" }],
      operations: [{ op: "set", column: "C", value: 99 }],
      dry_run: true,
    });
    assert("dry_run not error", !dryRun.isError, dryRun.text);
    assert("dry_run matched_rows=2", dryRun.parsed?.matched_rows === 2, JSON.stringify(dryRun.parsed));
    assert("dry_run matched_row_numbers=[2,4]", JSON.stringify(dryRun.parsed?.matched_row_numbers) === JSON.stringify([2, 4]));
    assert("dry_run updated_rows=0", dryRun.parsed?.updated_rows === 0);

    // 5. Actual write
    const writeUpdate = await callTool(baseUrl, sessionId, "update_where", {
      url_or_id: spreadsheetId,
      sheet: sheetName,
      header_rows: 1,
      where: [{ column: "A", op: "eq", value: "AXON" }],
      operations: [{ op: "set", column: "C", value: 99 }],
      expected_match_count: 2,
    });
    assert("update_where write not error", !writeUpdate.isError, writeUpdate.text);
    assert("update_where updated_rows=2", writeUpdate.parsed?.updated_rows === 2);

    // 6. Verify via read_sheet
    const readRes = await callTool(baseUrl, sessionId, "read_sheet", {
      url_or_id: spreadsheetId,
      range: `${sheetName}!A2:C5`,
    });
    const rows = parseReadSheetRows(readRes.parsed);
    assert("read_sheet returns 4 rows", rows?.length === 4, JSON.stringify(rows));
    assert("row 2 (AXON) C=99", rows[0][2] == 99, JSON.stringify(rows[0]));
    assert("row 3 (NVO) C=20 unchanged", rows[1][2] == 20, JSON.stringify(rows[1]));
    assert("row 4 (AXON) C=99", rows[2][2] == 99, JSON.stringify(rows[2]));

    // 7. Zero matches
    const zeroMatch = await callTool(baseUrl, sessionId, "update_where", {
      url_or_id: spreadsheetId,
      sheet: sheetName,
      header_rows: 1,
      where: [{ column: "A", op: "eq", value: "NINCS_ILYEN" }],
      operations: [{ op: "set", column: "C", value: 0 }],
    });
    assert("0 match not error", !zeroMatch.isError, zeroMatch.text);
    assert("0 match matched_rows=0", zeroMatch.parsed?.matched_rows === 0);

    // 8. expected_match_count failure
    const expectFail = await callTool(baseUrl, sessionId, "update_where", {
      url_or_id: spreadsheetId,
      sheet: sheetName,
      header_rows: 1,
      where: [{ column: "A", op: "eq", value: "AXON" }],
      operations: [{ op: "set", column: "C", value: 1 }],
      expected_match_count: 1,
    });
    assert("expected_match_count isError", expectFail.isError);
    assert("expected_match_count updated_rows=0", expectFail.parsed?.updated_rows === 0);

    // 9. limit failure
    const limitFail = await callTool(baseUrl, sessionId, "update_where", {
      url_or_id: spreadsheetId,
      sheet: sheetName,
      header_rows: 1,
      where: [{ column: "A", op: "eq", value: "AXON" }],
      operations: [{ op: "set", column: "C", value: 1 }],
      limit: 1,
    });
    assert("limit isError", limitFail.isError);
    assert("limit updated_rows=0", limitFail.parsed?.updated_rows === 0);

    // 9b. DEV-TODO 64 — op:replace + hard break (temp sheet only)
    const longCtx =
      "x".repeat(80) +
      " bekcerülés " +
      "y".repeat(80) +
      " more context around the typo for bit-identity check";
    const seedReplace = await callTool(baseUrl, sessionId, "write_sheet", {
      url_or_id: spreadsheetId,
      range: `${sheetName}!D1`,
      values: [
        ["Ctx"],
        ["clean axon"],
        ["clean nvo"],
        ["clean axon2"],
        [longCtx],
      ],
    });
    assert("replace fixture write ok", !seedReplace.isError, seedReplace.text);

    const replaceDry = await callTool(baseUrl, sessionId, "update_where", {
      url_or_id: spreadsheetId,
      sheet: sheetName,
      header_rows: 1,
      where: [{ column: "A", op: "eq", value: "ANET" }],
      operations: [{ op: "replace", column: "D", find: "bekcerülés", replace: "bekerülés" }],
      dry_run: true,
      expected_match_count: 1,
      expected_occurrence_count: 1,
    });
    assert("replace dry_run not error", !replaceDry.isError, replaceDry.text);
    assert("replace dry_run matched=1", replaceDry.parsed?.matched_rows === 1, JSON.stringify(replaceDry.parsed));
    assert("replace dry_run occurrence=1", replaceDry.parsed?.occurrence_count === 1, JSON.stringify(replaceDry.parsed));
    assert(
      "replace dry_run has snippet",
      !!replaceDry.parsed?.preview?.[0]?.replace?.[0]?.snippet?.match,
      JSON.stringify(replaceDry.parsed?.preview)
    );

    const replaceWrite = await callTool(baseUrl, sessionId, "update_where", {
      url_or_id: spreadsheetId,
      sheet: sheetName,
      header_rows: 1,
      where: [{ column: "A", op: "eq", value: "ANET" }],
      operations: [{ op: "replace", column: "D", find: "bekcerülés", replace: "bekerülés" }],
      expected_match_count: 1,
      expected_occurrence_count: 1,
    });
    assert("replace write not error", !replaceWrite.isError, replaceWrite.text);

    const confirmReplace = await callTool(baseUrl, sessionId, "query_sheet", {
      url_or_id: spreadsheetId,
      sheet: sheetName,
      header_rows: 1,
      query: "SELECT A, D WHERE A = 'ANET'",
    });
    const anetCtx = confirmReplace.parsed?.rows?.[0]?.[1];
    assert("replace CONFIRM bekerülés", typeof anetCtx === "string" && anetCtx.includes("bekerülés"), JSON.stringify(confirmReplace.parsed));
    assert("replace CONFIRM no old typo", typeof anetCtx === "string" && !anetCtx.includes("bekcerülés"), anetCtx);
    assert(
      "replace CONFIRM surroundings",
      typeof anetCtx === "string" && anetCtx.includes("x".repeat(80)) && anetCtx.includes("y".repeat(80)),
      anetCtx
    );

    // Re-seed multi-row replace case
    await callTool(baseUrl, sessionId, "write_sheet", {
      url_or_id: spreadsheetId,
      range: `${sheetName}!D2:D5`,
      values: [["has bekcerülés a"], ["nope"], ["has bekcerülés b"], ["nope2"]],
    });
    const multiOk = await callTool(baseUrl, sessionId, "update_where", {
      url_or_id: spreadsheetId,
      sheet: sheetName,
      header_rows: 1,
      where: [{ column: "D", op: "not_empty" }],
      operations: [{ op: "replace", column: "D", find: "bekcerülés", replace: "bekerülés" }],
      expected_match_count: 2,
      dry_run: true,
    });
    assert("replace multi expected 2 ok", !multiOk.isError, multiOk.text);
    assert("replace multi matched=2", multiOk.parsed?.matched_rows === 2, JSON.stringify(multiOk.parsed));

    const multiAbort = await callTool(baseUrl, sessionId, "update_where", {
      url_or_id: spreadsheetId,
      sheet: sheetName,
      header_rows: 1,
      where: [{ column: "D", op: "not_empty" }],
      operations: [{ op: "replace", column: "D", find: "bekcerülés", replace: "bekerülés" }],
      expected_match_count: 3,
      dry_run: true,
    });
    assert("replace multi expected 3 abort", multiAbort.isError, multiAbort.text);

    await callTool(baseUrl, sessionId, "write_sheet", {
      url_or_id: spreadsheetId,
      range: `${sheetName}!E2`,
      values: [["foo X foo X foo"]],
    });
    const repAll = await callTool(baseUrl, sessionId, "update_where", {
      url_or_id: spreadsheetId,
      sheet: sheetName,
      header_rows: 1,
      where: [{ column: "A", op: "eq", value: "AXON" }],
      operations: [{ op: "replace", column: "E", find: "X", replace: "Y", replace_all: true }],
      limit: 1,
      expected_match_count: 1,
    });
    // First AXON only due to limit? limit refuses if matchBasis > limit. Two AXON rows both have E empty except we only wrote E2.
    // E2 is first AXON; second AXON E4 empty — replace on empty won't contain X. So matched=1.
    assert("replace_all write ok", !repAll.isError, repAll.text);
    const e2read = await callTool(baseUrl, sessionId, "read_sheet", {
      url_or_id: spreadsheetId,
      range: `${sheetName}!E2`,
    });
    const e2val = parseReadSheetRows(e2read.parsed)?.[0]?.[0];
    assert("replace_all both X→Y", e2val === "foo Y foo Y foo", JSON.stringify(e2val));

    await callTool(baseUrl, sessionId, "write_sheet", {
      url_or_id: spreadsheetId,
      range: `${sheetName}!E3`,
      values: [["foo X foo X foo"]],
    });
    const repFirst = await callTool(baseUrl, sessionId, "update_where", {
      url_or_id: spreadsheetId,
      sheet: sheetName,
      header_rows: 1,
      where: [{ column: "A", op: "eq", value: "NVO" }],
      operations: [{ op: "replace", column: "E", find: "X", replace: "Y", replace_all: false }],
      expected_match_count: 1,
      expected_occurrence_count: 1,
    });
    assert("replace_all false ok", !repFirst.isError, repFirst.text);
    const e3read = await callTool(baseUrl, sessionId, "read_sheet", {
      url_or_id: spreadsheetId,
      range: `${sheetName}!E3`,
    });
    assert(
      "replace_all false only first",
      parseReadSheetRows(e3read.parsed)?.[0]?.[0] === "foo Y foo X foo",
      JSON.stringify(e3read.parsed)
    );

    const noHit = await callTool(baseUrl, sessionId, "update_where", {
      url_or_id: spreadsheetId,
      sheet: sheetName,
      header_rows: 1,
      where: [{ column: "A", op: "eq", value: "NVO" }],
      operations: [{ op: "replace", column: "D", find: "NO_SUCH_SUBSTRING_XYZ", replace: "z" }],
      expected_match_count: 1,
      dry_run: true,
    });
    assert("no-hit expected_match abort", noHit.isError, noHit.text);

    const mixedOps = await callTool(baseUrl, sessionId, "update_where", {
      url_or_id: spreadsheetId,
      sheet: sheetName,
      header_rows: 1,
      where: [{ column: "A", op: "eq", value: "NVO" }],
      operations: [
        { op: "set", column: "B", value: "MIXED" },
        { op: "replace", column: "D", find: "nope", replace: "yep" },
      ],
      expected_match_count: 1,
    });
    assert("mixed set+replace ok", !mixedOps.isError, mixedOps.text);

    const legacySet = await callTool(baseUrl, sessionId, "update_where", {
      url_or_id: spreadsheetId,
      sheet: sheetName,
      header_rows: 1,
      where: [{ column: "A", op: "eq", value: "AXON" }],
      set: [{ column: "C", value: 1 }],
    });
    assert("legacy set hard break isError", legacySet.isError, legacySet.text);
    assert("legacy set message", /hard break/i.test(legacySet.text || ""), legacySet.text);

    // 9c. Soft blockers from DEV-TODO 64 review — formula / non-string / final decimal
    const formulaRefuse = await callTool(baseUrl, sessionId, "update_where", {
      url_or_id: spreadsheetId,
      sheet: sheetName,
      header_rows: 1,
      where: [{ column: "A", op: "eq", value: "AXON" }],
      operations: [{ op: "set", column: "B", value: "=SUM(A1)" }],
      dry_run: true,
      limit: 1,
    });
    assert("formula refuse isError", formulaRefuse.isError, formulaRefuse.text);
    assert("formula refuse message", /formula character/i.test(formulaRefuse.text || ""), formulaRefuse.text);

    const formulaAllow = await callTool(baseUrl, sessionId, "update_where", {
      url_or_id: spreadsheetId,
      sheet: sheetName,
      header_rows: 1,
      where: [{ column: "A", op: "eq", value: "NVO" }],
      operations: [{ op: "set", column: "B", value: "=1+1" }],
      allow_formula: true,
      expected_match_count: 1,
    });
    assert("allow_formula write ok", !formulaAllow.isError, formulaAllow.text);

    const nonStringReplace = await callTool(baseUrl, sessionId, "update_where", {
      url_or_id: spreadsheetId,
      sheet: sheetName,
      header_rows: 1,
      where: [{ column: "A", op: "eq", value: "AXON" }],
      operations: [{ op: "replace", column: "C", find: "99", replace: "100" }],
      dry_run: true,
    });
    assert("non-string replace refuse", nonStringReplace.isError, nonStringReplace.text);
    assert(
      "non-string replace message",
      /string \(or empty\)/i.test(nonStringReplace.text || ""),
      nonStringReplace.text
    );

    await callTool(baseUrl, sessionId, "write_sheet", {
      url_or_id: spreadsheetId,
      range: `${sheetName}!F2`,
      values: [["xx"]],
    });
    const finalDecimal = await callTool(baseUrl, sessionId, "update_where", {
      url_or_id: spreadsheetId,
      sheet: sheetName,
      header_rows: 1,
      where: [{ column: "A", op: "eq", value: "AXON" }],
      operations: [{ op: "replace", column: "F", find: "xx", replace: "29.3" }],
      dry_run: true,
      limit: 1,
      expected_match_count: 1,
    });
    assert("final-cell 29.3 refuse", finalDecimal.isError, finalDecimal.text);
    assert(
      "final-cell 29.3 message",
      /29\.3/.test(finalDecimal.text || "") && /allow_text_numerics/i.test(finalDecimal.text || ""),
      finalDecimal.text
    );

    const expectFailDry = await callTool(baseUrl, sessionId, "update_where", {
      url_or_id: spreadsheetId,
      sheet: sheetName,
      header_rows: 1,
      where: [{ column: "A", op: "eq", value: "AXON" }],
      operations: [{ op: "set", column: "B", value: "X" }],
      expected_match_count: 1,
      dry_run: true,
    });
    assert("precondition dry_run flag true", expectFailDry.parsed?.dry_run === true, JSON.stringify(expectFailDry.parsed));

    const opsSchema = (await mcpRequest(baseUrl, "tools/list", {}, sessionId)).payload?.result?.tools
      ?.find((t) => t.name === "update_where");
    assert(
      "update_where schema has operations",
      !!opsSchema?.inputSchema?.properties?.operations,
      JSON.stringify(opsSchema?.inputSchema?.properties)
    );
    assert(
      "update_where schema no top-level set",
      !opsSchema?.inputSchema?.properties?.set,
      JSON.stringify(opsSchema?.inputSchema?.properties)
    );

    // 10. query_sheet — GViz text-number + decimal normalization (production bug regression)
    await setupGvizTestSheet(spreadsheetId);

    const dotText = await callTool(baseUrl, sessionId, "query_sheet", {
      url_or_id: spreadsheetId,
      sheet: GVIZ_SHEET,
      query: "SELECT C WHERE A = 'NVO' AND B = 'AR_STOP_DOT'",
      header_rows: 1,
    });
    assert("gviz dot-text not error", !dotText.isError, dotText.text);
    assertNumber("text '42.30' → 42.3 (not null)", queryFirstCell(dotText, 0), 42.3);

    const commaText = await callTool(baseUrl, sessionId, "query_sheet", {
      url_or_id: spreadsheetId,
      sheet: GVIZ_SHEET,
      query: "SELECT C WHERE A = 'NVO' AND B = 'AR_STOP_COMMA'",
      header_rows: 1,
    });
    assert("gviz comma-text not error", !commaText.isError, commaText.text);
    assertNumber("text '23,3' → 23.3 (not null)", queryFirstCell(commaText, 0), 23.3);

    const realNum = await callTool(baseUrl, sessionId, "query_sheet", {
      url_or_id: spreadsheetId,
      sheet: GVIZ_SHEET,
      query: "SELECT C WHERE A = 'NVO' AND B = 'AR_STOP_NUM'",
      header_rows: 1,
    });
    assert("gviz real number not error", !realNum.isError, realNum.text);
    assertNumber("real number 42.30 → 42.3", queryFirstCell(realNum, 0), 42.3);

    const emptyCell = await callTool(baseUrl, sessionId, "query_sheet", {
      url_or_id: spreadsheetId,
      sheet: GVIZ_SHEET,
      query: "SELECT C WHERE A = 'NVO' AND B = 'AR_STOP_EMPTY'",
      header_rows: 1,
    });
    assert("gviz empty cell not error", !emptyCell.isError, emptyCell.text);
    assert("empty cell → null", queryFirstCell(emptyCell, 0) === null, JSON.stringify(emptyCell.parsed));

    const badNum = await callTool(baseUrl, sessionId, "query_sheet", {
      url_or_id: spreadsheetId,
      sheet: GVIZ_SHEET,
      query: "SELECT C WHERE A = 'NVO' AND B = 'AR_STOP_BAD'",
      header_rows: 1,
    });
    assert("gviz invalid_num not error", !badNum.isError, badNum.text);
    assert("non-numeric text stays string", queryFirstCell(badNum, 0) === "invalid_num", JSON.stringify(badNum.parsed));

    const stringCol = await callTool(baseUrl, sessionId, "query_sheet", {
      url_or_id: spreadsheetId,
      sheet: GVIZ_SHEET,
      query: "SELECT A WHERE A = 'AXON'",
      header_rows: 1,
    });
    assert("gviz string column not error", !stringCol.isError, stringCol.text);
    assert("string column unchanged → 'AXON'", queryFirstCell(stringCol, 0) === "AXON", JSON.stringify(stringCol.parsed));

    const boolFilter = await callTool(baseUrl, sessionId, "query_sheet", {
      url_or_id: spreadsheetId,
      sheet: GVIZ_SHEET,
      query: "SELECT A, B WHERE D = true",
      header_rows: 1,
    });
    assert("gviz bool WHERE not error", !boolFilter.isError, boolFilter.text);
    assert("bool WHERE returns rows", (boolFilter.parsed?.matched_rows ?? 0) >= 5, JSON.stringify(boolFilter.parsed));

    const colTypesRes = await callTool(baseUrl, sessionId, "query_sheet", {
      url_or_id: spreadsheetId,
      sheet: GVIZ_SHEET,
      query: "SELECT C LIMIT 1",
      header_rows: 1,
    });
    assert("gviz col_types present", Array.isArray(colTypesRes.parsed?.col_types), JSON.stringify(colTypesRes.parsed));
    assert("Value col type is number", colTypesRes.parsed?.col_types?.[0] === "number", JSON.stringify(colTypesRes.parsed?.col_types));

    // 10a. query_sheet — sql.js aggregation (GROUP BY / COUNT / SUM)
    const aggCount = await callTool(baseUrl, sessionId, "query_sheet", {
      url_or_id: spreadsheetId,
      sheet: GVIZ_SHEET,
      query: "SELECT A, COUNT(*) AS n WHERE A = 'NVO' GROUP BY A",
      header_rows: 1,
    });
    assert("agg COUNT not error", !aggCount.isError, aggCount.text);
    assert("agg COUNT matched_rows=1", aggCount.parsed?.matched_rows === 1, JSON.stringify(aggCount.parsed));
    assert("agg COUNT NVO = 5", aggCount.parsed?.rows?.[0]?.[1] === 5, JSON.stringify(aggCount.parsed?.rows));

    const aggSum = await callTool(baseUrl, sessionId, "query_sheet", {
      url_or_id: spreadsheetId,
      sheet: GVIZ_SHEET,
      query: "SELECT A, SUM(C) AS s WHERE A = 'ANET' GROUP BY A",
      header_rows: 1,
    });
    assert("agg SUM not error", !aggSum.isError, aggSum.text);
    assertNumber("agg SUM ANET values", aggSum.parsed?.rows?.[0]?.[1], 330);

    // 10b. query_sheet — GViz date → ISO 8601
    await setupDateTestSheet(spreadsheetId);

    const dateQuery = await callTool(baseUrl, sessionId, "query_sheet", {
      url_or_id: spreadsheetId,
      sheet: DATE_SHEET,
      query: "SELECT * WHERE A = 'TOOL_TEST'",
      header_rows: 1,
    });
    assert("gviz date query not error", !dateQuery.isError, dateQuery.text);
    assert(
      "date col_types",
      JSON.stringify(dateQuery.parsed?.col_types) === JSON.stringify(["string", "string", "string", "date"]),
      JSON.stringify(dateQuery.parsed?.col_types)
    );
    assert(
      "date row ISO 8601",
      JSON.stringify(dateQuery.parsed?.rows?.[0]) === JSON.stringify(["TOOL_TEST", "append_rows", "OK", "2026-07-10"]),
      JSON.stringify(dateQuery.parsed?.rows?.[0])
    );

    // 10c. update_where — ISO date where vs UNFORMATTED serial cell (DEV-TODO 38)
    const dateWhereDry = await callTool(baseUrl, sessionId, "update_where", {
      url_or_id: spreadsheetId,
      sheet: DATE_SHEET,
      header_rows: 1,
      dry_run: true,
      expected_match_count: 1,
      where: [
        { column: "A", op: "eq", value: "TOOL_TEST" },
        { column: "D", op: "lt", value: "2026-07-11" },
      ],
      operations: [{ op: "set", column: "C", value: "DRY" }],
    });
    assert("update_where date where dry_run not error", !dateWhereDry.isError, dateWhereDry.text);
    assert("update_where date where matched_rows=1", dateWhereDry.parsed?.matched_rows === 1, JSON.stringify(dateWhereDry.parsed));
    assert("update_where date where dry_run updated_rows=0", dateWhereDry.parsed?.updated_rows === 0);

    const dateWhereMiss = await callTool(baseUrl, sessionId, "update_where", {
      url_or_id: spreadsheetId,
      sheet: DATE_SHEET,
      header_rows: 1,
      dry_run: true,
      where: [
        { column: "A", op: "eq", value: "TOOL_TEST" },
        { column: "D", op: "lt", value: "2026-07-10" },
      ],
      operations: [{ op: "set", column: "C", value: "DRY" }],
    });
    assert("update_where date where miss not error", !dateWhereMiss.isError, dateWhereMiss.text);
    assert("update_where date where miss matched_rows=0", dateWhereMiss.parsed?.matched_rows === 0, JSON.stringify(dateWhereMiss.parsed));

    // 11. query_sheet regression (update_where fixture)
    const queryRes = await callTool(baseUrl, sessionId, "query_sheet", {
      url_or_id: spreadsheetId,
      sheet: sheetName,
      query: "SELECT A, B, C LIMIT 3",
      header_rows: 1,
    });
    assert("query_sheet not error", !queryRes.isError, queryRes.text);
    assert("query_sheet matched_rows >= 1", (queryRes.parsed?.matched_rows ?? 0) >= 1);
    assert("query_sheet has columns", Array.isArray(queryRes.parsed?.columns) && queryRes.parsed.columns.length >= 3);

    // 12. insert_rows — below header (startIndex=1), atomic fill
    const beforeInsert = await callTool(baseUrl, sessionId, "read_sheet", {
      url_or_id: spreadsheetId,
      range: `${sheetName}!A1:C10`,
    });
    assert("read before insert_rows ok", !beforeInsert.isError, beforeInsert.text);
    const beforeRows = parseReadSheetRows(beforeInsert.parsed);
    assert("header present before insert", beforeRows?.[0]?.[0] === "Ticker", JSON.stringify(beforeRows?.[0]));
    const oldRow2 = beforeRows[1];
    assert("data row exists before insert", Array.isArray(oldRow2) && oldRow2.length > 0, JSON.stringify(oldRow2));

    const insertRes = await callTool(baseUrl, sessionId, "insert_rows", {
      url_or_id: spreadsheetId,
      sheet: sheetName,
      startIndex: 1,
      values: [["INSERTED", "TOP", 999]],
    });
    assert("insert_rows succeeded", !insertRes.isError, insertRes.text);
    assert("insert_rows rows_inserted=1", insertRes.parsed?.rows_inserted === 1, JSON.stringify(insertRes.parsed));
    assert("insert_rows start_index=1", insertRes.parsed?.start_index === 1, JSON.stringify(insertRes.parsed));
    assert("insert_rows inserted_at_row=2", insertRes.parsed?.inserted_at_row === 2, JSON.stringify(insertRes.parsed));
    assert("insert_rows filled=true", insertRes.parsed?.filled === true, JSON.stringify(insertRes.parsed));

    const afterInsert = await callTool(baseUrl, sessionId, "read_sheet", {
      url_or_id: spreadsheetId,
      range: `${sheetName}!A1:C10`,
    });
    assert("read after insert_rows ok", !afterInsert.isError, afterInsert.text);
    const afterRows = parseReadSheetRows(afterInsert.parsed);
    assert("header intact after insert", afterRows?.[0]?.[0] === "Ticker", JSON.stringify(afterRows?.[0]));
    assert(
      "new row at physical row 2",
      afterRows?.[1]?.[0] === "INSERTED" && afterRows?.[1]?.[1] === "TOP",
      JSON.stringify(afterRows?.[1])
    );
    assert(
      "old row 2 shifted to row 3",
      JSON.stringify(afterRows?.[2]) === JSON.stringify(oldRow2),
      `expected ${JSON.stringify(oldRow2)}, got ${JSON.stringify(afterRows?.[2])}`
    );

    // 13. insert_rows — datetime value interpretation (main regression: values.update USER_ENTERED)
    // DateTest fixture (1 data row): row2 = TOOL_TEST/append_rows/OK/2026-07-10.
    // Insert a datetime at startIndex=1; the old date row shifts to row3.
    const insertDate = await callTool(baseUrl, sessionId, "insert_rows", {
      url_or_id: spreadsheetId,
      sheet: DATE_SHEET,
      startIndex: 1,
      values: [["TOOL_TEST", "insert_rows_dt", "OK", "2026-07-18 21:03"]],
    });
    assert("insert_rows (datetime) succeeded", !insertDate.isError, insertDate.text);
    assert("insert_rows (datetime) rows_inserted=1", insertDate.parsed?.rows_inserted === 1, JSON.stringify(insertDate.parsed));
    assert("insert_rows (datetime) inserted_at_row=2", insertDate.parsed?.inserted_at_row === 2, JSON.stringify(insertDate.parsed));

    // The inserted cell must come back as a real datetime (not text → not null),
    // and ORDER BY D DESC must place rows in correct chronological order.
    const dateSort = await callTool(baseUrl, sessionId, "query_sheet", {
      url_or_id: spreadsheetId,
      sheet: DATE_SHEET,
      query: "SELECT D WHERE C = 'OK' ORDER BY D DESC",
      header_rows: 1,
    });
    assert("insert datetime query not error", !dateSort.isError, dateSort.text);
    assert("insert datetime matched_rows=2", dateSort.parsed?.matched_rows === 2, JSON.stringify(dateSort.parsed));
    const sortedFirst = queryFirstCell(dateSort, 0);
    const sortedSecond = dateSort.parsed?.rows?.[1]?.[0];
    assert(
      "date col type is date/datetime",
      dateSort.parsed?.col_types?.[0] === "date" || dateSort.parsed?.col_types?.[0] === "datetime",
      JSON.stringify(dateSort.parsed?.col_types)
    );
    assert(
      "inserted datetime not null (parsed, not text)",
      sortedFirst !== null && sortedFirst !== undefined,
      JSON.stringify(dateSort.parsed?.rows)
    );
    assert(
      "ORDER BY DESC: 2026-07-18 first",
      String(sortedFirst).startsWith("2026-07-18"),
      `got ${JSON.stringify(sortedFirst)}`
    );
    assert(
      "ORDER BY DESC: 2026-07-10 second",
      sortedSecond != null && String(sortedSecond).startsWith("2026-07-10"),
      `got ${JSON.stringify(sortedSecond)}`
    );

    // Regression: numeric and text columns remain unchanged during insert.
    const dateAfter = await callTool(baseUrl, sessionId, "read_sheet", {
      url_or_id: spreadsheetId,
      range: `${DATE_SHEET}!A1:D3`,
    });
    const dateRows = parseReadSheetRows(dateAfter.parsed);
    assert("date sheet header intact", dateRows?.[0]?.[0] === "Tool", JSON.stringify(dateRows?.[0]));
    assert(
      "inserted row text cols intact (A/B/C)",
      dateRows?.[1]?.[0] === "TOOL_TEST" && dateRows?.[1]?.[1] === "insert_rows_dt" && dateRows?.[1]?.[2] === "OK",
      JSON.stringify(dateRows?.[1])
    );

    // 13b. insert_rows — pure date (no time) must also be a real date, not text
    const insertPureDate = await callTool(baseUrl, sessionId, "insert_rows", {
      url_or_id: spreadsheetId,
      sheet: DATE_SHEET,
      startIndex: 1,
      values: [["TOOL_TEST", "insert_rows_date", "OK", "2026-07-15"]],
    });
    assert("insert_rows (pure date) succeeded", !insertPureDate.isError, insertPureDate.text);

    const pureDateQuery = await callTool(baseUrl, sessionId, "query_sheet", {
      url_or_id: spreadsheetId,
      sheet: DATE_SHEET,
      query: "SELECT D WHERE B = 'insert_rows_date'",
      header_rows: 1,
    });
    assert("pure date query not error", !pureDateQuery.isError, pureDateQuery.text);
    assert(
      "pure date not null (parsed, not text)",
      queryFirstCell(pureDateQuery, 0) !== null && queryFirstCell(pureDateQuery, 0) !== undefined,
      JSON.stringify(pureDateQuery.parsed?.rows)
    );
    assert(
      "pure date ISO 8601",
      String(queryFirstCell(pureDateQuery, 0)).startsWith("2026-07-15"),
      `got ${JSON.stringify(queryFirstCell(pureDateQuery, 0))}`
    );

    // Full chronology: datetime > pure date > fixture date
    const fullSort = await callTool(baseUrl, sessionId, "query_sheet", {
      url_or_id: spreadsheetId,
      sheet: DATE_SHEET,
      query: "SELECT D WHERE C = 'OK' ORDER BY D DESC",
      header_rows: 1,
    });
    assert("full date sort not error", !fullSort.isError, fullSort.text);
    assert("full date sort matched_rows=3", fullSort.parsed?.matched_rows === 3, JSON.stringify(fullSort.parsed));
    assert(
      "full ORDER BY DESC: datetime, pure date, fixture",
      String(fullSort.parsed?.rows?.[0]?.[0]).startsWith("2026-07-18") &&
        String(fullSort.parsed?.rows?.[1]?.[0]).startsWith("2026-07-15") &&
        String(fullSort.parsed?.rows?.[2]?.[0]).startsWith("2026-07-10"),
      JSON.stringify(fullSort.parsed?.rows)
    );

    // 13c. append_rows regression — datetime still parsed with USER_ENTERED
    const appendDt = await callTool(baseUrl, sessionId, "append_rows", {
      url_or_id: spreadsheetId,
      range: DATE_SHEET,
      values: [["TOOL_TEST", "append_rows_dt", "OK", "2026-07-20 12:00"]],
    });
    assert("append_rows datetime succeeded", !appendDt.isError, appendDt.text);

    const appendSort = await callTool(baseUrl, sessionId, "query_sheet", {
      url_or_id: spreadsheetId,
      sheet: DATE_SHEET,
      query: "SELECT D WHERE C = 'OK' ORDER BY D DESC",
      header_rows: 1,
    });
    assert("append datetime sort not error", !appendSort.isError, appendSort.text);
    assert("append datetime matched_rows=4", appendSort.parsed?.matched_rows === 4, JSON.stringify(appendSort.parsed));
    assert(
      "append datetime tops ORDER BY DESC",
      String(appendSort.parsed?.rows?.[0]?.[0]).startsWith("2026-07-20"),
      JSON.stringify(appendSort.parsed?.rows)
    );

    // 14. insert_rows type regression: number, bool, formula, empty, special characters
    // Dedicated tab so we do not corrupt the Sheet1 fixture.
    const PARSE_SHEET = "ParseTest";
    await withSheetsQuotaRetry_(`setup ${PARSE_SHEET}`, async () => {
      const authForParse = await getGoogleAuth();
      const sheetsForParse = google.sheets({ version: "v4", auth: authForParse });
      await sheetsForParse.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: {
          requests: [{ addSheet: { properties: { title: PARSE_SHEET } } }],
        },
      });
      await sheetsForParse.spreadsheets.values.update({
        spreadsheetId,
        range: `${PARSE_SHEET}!A1`,
        valueInputOption: "USER_ENTERED",
        requestBody: {
          values: [["Label", "Num", "Flag", "Formula", "Note"]],
        },
      });
    });

    const insertParse = await callTool(baseUrl, sessionId, "insert_rows", {
      url_or_id: spreadsheetId,
      sheet: PARSE_SHEET,
      startIndex: 1,
      values: [["PARSE_OK", 42.5, true, "=1+2", "a & b <c>"]],
    });
    assert("insert_rows (parse types) succeeded", !insertParse.isError, insertParse.text);

    const parseNum = await callTool(baseUrl, sessionId, "query_sheet", {
      url_or_id: spreadsheetId,
      sheet: PARSE_SHEET,
      query: "SELECT B WHERE A = 'PARSE_OK'",
      header_rows: 1,
    });
    assert("parse number query not error", !parseNum.isError, parseNum.text);
    assert("parse number col type", parseNum.parsed?.col_types?.[0] === "number", JSON.stringify(parseNum.parsed?.col_types));
    assertNumber("parse number value 42.5", queryFirstCell(parseNum, 0), 42.5);

    const parseBool = await callTool(baseUrl, sessionId, "query_sheet", {
      url_or_id: spreadsheetId,
      sheet: PARSE_SHEET,
      query: "SELECT C WHERE A = 'PARSE_OK'",
      header_rows: 1,
    });
    assert("parse bool query not error", !parseBool.isError, parseBool.text);
    assert("parse bool value true", queryFirstCell(parseBool, 0) === true, JSON.stringify(parseBool.parsed));

    const parseFormula = await callTool(baseUrl, sessionId, "query_sheet", {
      url_or_id: spreadsheetId,
      sheet: PARSE_SHEET,
      query: "SELECT D WHERE A = 'PARSE_OK'",
      header_rows: 1,
    });
    assert("parse formula query not error", !parseFormula.isError, parseFormula.text);
    assertNumber("parse formula =1+2 → 3", queryFirstCell(parseFormula, 0), 3);

    const parseNote = await callTool(baseUrl, sessionId, "read_sheet", {
      url_or_id: spreadsheetId,
      range: `${PARSE_SHEET}!E2`,
    });
    const noteRows = parseReadSheetRows(parseNote.parsed);
    assert(
      "HTML special chars round-trip (a & b <c>)",
      noteRows?.[0]?.[0] === "a & b <c>",
      JSON.stringify(noteRows)
    );

    // Empty cell mid-row + multiple rows at once
    const insertMulti = await callTool(baseUrl, sessionId, "insert_rows", {
      url_or_id: spreadsheetId,
      sheet: PARSE_SHEET,
      startIndex: 1,
      values: [
        ["MULTI_A", "", false, "", "x"],
        ["MULTI_B", 7, true, "=2*3", "y"],
      ],
    });
    assert("insert_rows multi-row succeeded", !insertMulti.isError, insertMulti.text);
    assert("insert_rows multi-row count=2", insertMulti.parsed?.rows_inserted === 2, JSON.stringify(insertMulti.parsed));

    const multiEmpty = await callTool(baseUrl, sessionId, "query_sheet", {
      url_or_id: spreadsheetId,
      sheet: PARSE_SHEET,
      query: "SELECT B WHERE A = 'MULTI_A'",
      header_rows: 1,
    });
    assert("multi empty cell query not error", !multiEmpty.isError, multiEmpty.text);
    assert("multi empty cell → null", queryFirstCell(multiEmpty, 0) === null, JSON.stringify(multiEmpty.parsed));

    const multiNum = await callTool(baseUrl, sessionId, "query_sheet", {
      url_or_id: spreadsheetId,
      sheet: PARSE_SHEET,
      query: "SELECT B, D WHERE A = 'MULTI_B'",
      header_rows: 1,
    });
    assert("multi second row query not error", !multiNum.isError, multiNum.text);
    assertNumber("multi second row num 7", multiNum.parsed?.rows?.[0]?.[0], 7);
    assertNumber("multi second row formula =2*3 → 6", multiNum.parsed?.rows?.[0]?.[1], 6);

    // 15. insert_rows — tab/newline character fidelity (values.update USER_ENTERED)
    // Critical: must not create extra columns, AND tab / in-cell line break (CHAR(10))
    // must round-trip exactly in values.get. (pasteData html in production turns \t into space.)
    const insertWs = await callTool(baseUrl, sessionId, "insert_rows", {
      url_or_id: spreadsheetId,
      sheet: PARSE_SHEET,
      startIndex: 1,
      values: [
        ["TAB_OK", "a\tb", "KEEP", "", ""],
        ["NL_OK", "line1\nline2", "KEEP", "", ""],
        ["SP_OK", "a  b", "KEEP", "", ""],
      ],
    });
    assert("insert_rows (whitespace) succeeded", !insertWs.isError, insertWs.text);
    assert("insert_rows (whitespace) count=3", insertWs.parsed?.rows_inserted === 3, JSON.stringify(insertWs.parsed));

    const wsRead = await callTool(baseUrl, sessionId, "read_sheet", {
      url_or_id: spreadsheetId,
      range: `${PARSE_SHEET}!A1:E5`,
    });
    assert("whitespace read ok", !wsRead.isError, wsRead.text);
    const wsRows = parseReadSheetRows(wsRead.parsed);
    // startIndex=1 → row2=TAB_OK, row3=NL_OK, row4=SP_OK
    const tabRow = wsRows?.[1];
    const nlRow = wsRows?.[2];
    const spRow = wsRows?.[3];
    assert("TAB_OK at row 2", tabRow?.[0] === "TAB_OK", JSON.stringify(tabRow));
    assert("NL_OK at row 3", nlRow?.[0] === "NL_OK", JSON.stringify(nlRow));
    assert("SP_OK at row 4", spRow?.[0] === "SP_OK", JSON.stringify(spRow));
    assert(
      "tab does not create extra columns (C still KEEP)",
      tabRow?.[2] === "KEEP",
      `expected C=KEEP, got ${JSON.stringify(tabRow)}`
    );
    assert(
      "tab round-trip exact (a\\tb)",
      tabRow?.[1] === "a\tb",
      `got B=${JSON.stringify(tabRow?.[1])}`
    );
    assert(
      "newline does not create extra columns (C still KEEP)",
      nlRow?.[2] === "KEEP",
      `expected C=KEEP, got ${JSON.stringify(nlRow)}`
    );
    assert(
      "newline round-trip exact (line1\\nline2)",
      nlRow?.[1] === "line1\nline2",
      `got B=${JSON.stringify(nlRow?.[1])}`
    );
    assert(
      "multi-space round-trip exact (a  b)",
      spRow?.[1] === "a  b",
      `got B=${JSON.stringify(spRow?.[1])}`
    );

    // 16. Hybrid Cell — write_sheet / insert_rows / append_rows formatting
    await setupRichTestSheet(spreadsheetId);

    const richWrite = await callTool(baseUrl, sessionId, "write_sheet", {
      url_or_id: spreadsheetId,
      range: `${RICH_SHEET}!A2`,
      values: [[
        { value: "2026-07-18 21:03:00", bold: true, color: "#666666" },
        { value: "ERROR", bold: true, bg: "#FFCCCC", color: "#CC0000" },
        {
          wrap: true,
          bg: "#FFCCCC",
          color: "#333333",
          segments: [
            { text: "ERROR", bold: true, color: "#CC0000" },
            { text: ": timeout after 30s\n" },
            { text: "docs", link: "https://example.com/docs", color: "#1155CC", underline: true },
          ],
        },
      ]],
    });
    assert("rich write_sheet succeeded", !richWrite.isError, richWrite.text);

    const richCells = await getGridRowCells(spreadsheetId, `${RICH_SHEET}!A2:C2`);
    assert("rich row has 3 cells", richCells.length >= 3, JSON.stringify(richCells.map((c) => c?.formattedValue)));

    const tsCell = richCells[0];
    const levelCell = richCells[1];
    const msgCell = richCells[2];

    assert("ts bold", tsCell?.userEnteredFormat?.textFormat?.bold === true, JSON.stringify(tsCell?.userEnteredFormat));
    assert(
      "ts color #666666",
      colorsApproxEqual(tsCell?.userEnteredFormat?.textFormat?.foregroundColorStyle, "#666666"),
      JSON.stringify(tsCell?.userEnteredFormat?.textFormat?.foregroundColorStyle)
    );
    assert(
      "ts is datetime (numberValue)",
      typeof tsCell?.effectiveValue?.numberValue === "number",
      JSON.stringify(tsCell?.effectiveValue)
    );

    assert("level bold", levelCell?.userEnteredFormat?.textFormat?.bold === true, JSON.stringify(levelCell?.userEnteredFormat));
    assert(
      "level bg #FFCCCC",
      colorsApproxEqual(levelCell?.userEnteredFormat?.backgroundColorStyle, "#FFCCCC"),
      JSON.stringify(levelCell?.userEnteredFormat?.backgroundColorStyle)
    );
    assert(
      "level color #CC0000",
      colorsApproxEqual(levelCell?.userEnteredFormat?.textFormat?.foregroundColorStyle, "#CC0000"),
      JSON.stringify(levelCell?.userEnteredFormat?.textFormat?.foregroundColorStyle)
    );
    assert("level text ERROR", levelCell?.formattedValue === "ERROR" || levelCell?.userEnteredValue?.stringValue === "ERROR", JSON.stringify(levelCell));

    assert("msg wrap", msgCell?.userEnteredFormat?.wrapStrategy === "WRAP", JSON.stringify(msgCell?.userEnteredFormat));
    assert(
      "msg bg #FFCCCC",
      colorsApproxEqual(msgCell?.userEnteredFormat?.backgroundColorStyle, "#FFCCCC"),
      JSON.stringify(msgCell?.userEnteredFormat?.backgroundColorStyle)
    );
    assert(
      "msg cell default color #333333",
      colorsApproxEqual(msgCell?.userEnteredFormat?.textFormat?.foregroundColorStyle, "#333333"),
      JSON.stringify(msgCell?.userEnteredFormat?.textFormat?.foregroundColorStyle)
    );
    const runs = msgCell?.textFormatRuns ?? [];
    assert("msg has textFormatRuns", runs.length >= 2, JSON.stringify(runs));
    const boldRun = runs.find((r) => r.format?.bold === true);
    assert("msg has bold run", !!boldRun, JSON.stringify(runs));
    assert(
      "msg bold run color #CC0000",
      colorsApproxEqual(boldRun?.format?.foregroundColorStyle, "#CC0000"),
      JSON.stringify(boldRun?.format)
    );
    const linkRun = runs.find((r) => r.format?.link?.uri);
    assert("msg has link run", linkRun?.format?.link?.uri === "https://example.com/docs", JSON.stringify(runs));
    assert(
      "msg plain contains newline",
      (msgCell?.userEnteredValue?.stringValue || msgCell?.formattedValue || "").includes("\n"),
      JSON.stringify(msgCell?.userEnteredValue)
    );

    // DEV-TODO 64: rich text refuse on update_where replace/set
    const richRefuse = await callTool(baseUrl, sessionId, "update_where", {
      url_or_id: spreadsheetId,
      sheet: RICH_SHEET,
      header_rows: 1,
      where: [{ column: "B", op: "eq", value: "ERROR" }],
      operations: [{ op: "replace", column: "C", find: "timeout", replace: "TIMEOUT" }],
      dry_run: true,
      expected_match_count: 1,
    });
    assert("rich replace refuse isError", richRefuse.isError, richRefuse.text);
    assert("rich replace refuse message", /textFormatRuns/i.test(richRefuse.text || ""), richRefuse.text);
    const richUnchanged = await getGridRowCells(spreadsheetId, `${RICH_SHEET}!C2`);
    assert(
      "rich cell unchanged after refuse",
      (richUnchanged[0]?.textFormatRuns?.length ?? 0) >= 2,
      JSON.stringify(richUnchanged[0]?.textFormatRuns)
    );

    // insert_rows hybrid (below header)
    const richInsert = await callTool(baseUrl, sessionId, "insert_rows", {
      url_or_id: spreadsheetId,
      sheet: RICH_SHEET,
      startIndex: 1,
      values: [[
        { value: "2026-07-19 10:00:00", italic: true },
        { value: "WARN", bg: "#FFF3CD", color: "#856404" },
        {
          segments: [
            { text: "A" },
            { text: "😀", bold: true },
            { text: "B", strikethrough: true },
          ],
          color: "#111111",
        },
      ]],
    });
    assert("rich insert_rows succeeded", !richInsert.isError, richInsert.text);
    assert("rich insert rows_inserted=1", richInsert.parsed?.rows_inserted === 1, JSON.stringify(richInsert.parsed));

    const inserted = await getGridRowCells(spreadsheetId, `${RICH_SHEET}!A2:C2`);
    assert("insert italic on ts", inserted[0]?.userEnteredFormat?.textFormat?.italic === true, JSON.stringify(inserted[0]?.userEnteredFormat));
    assert(
      "insert datetime still number",
      typeof inserted[0]?.effectiveValue?.numberValue === "number",
      JSON.stringify(inserted[0]?.effectiveValue)
    );
    assert(
      "insert warn bg",
      colorsApproxEqual(inserted[1]?.userEnteredFormat?.backgroundColorStyle, "#FFF3CD"),
      JSON.stringify(inserted[1]?.userEnteredFormat?.backgroundColorStyle)
    );
    const emojiRuns = inserted[2]?.textFormatRuns ?? [];
    assert("emoji runs present", emojiRuns.length >= 2, JSON.stringify(emojiRuns));
    const emojiBold = emojiRuns.find((r) => r.startIndex === 1 && r.format?.bold === true);
    assert("emoji bold at UTF-16 index 1", !!emojiBold, JSON.stringify(emojiRuns));
    const strikeRun = emojiRuns.find((r) => r.format?.strikethrough === true);
    assert("strikethrough run after emoji (startIndex 3)", strikeRun?.startIndex === 3, JSON.stringify(emojiRuns));

    // append_rows hybrid
    const richAppend = await callTool(baseUrl, sessionId, "append_rows", {
      url_or_id: spreadsheetId,
      range: RICH_SHEET,
      values: [[
        "plain-ts",
        { value: "INFO", underline: true, color: "#0D47A1" },
        { segments: [{ text: "hello\tworld", italic: true }], wrap: true },
      ]],
    });
    assert("rich append_rows succeeded", !richAppend.isError, richAppend.text);

    const appendRead = await callTool(baseUrl, sessionId, "read_sheet", {
      url_or_id: spreadsheetId,
      range: `${RICH_SHEET}!A1:C10`,
    });
    assert("rich append read ok", !appendRead.isError, appendRead.text);
    const appendRows = parseReadSheetRows(appendRead.parsed);
    const last = appendRows?.[appendRows.length - 1];
    assert("append last A plain-ts", last?.[0] === "plain-ts", JSON.stringify(last));
    assert("append tab preserved in message", last?.[2] === "hello\tworld", JSON.stringify(last?.[2]));

    const appendCells = await getGridRowCells(
      spreadsheetId,
      `${RICH_SHEET}!A${appendRows.length}:C${appendRows.length}`
    );
    assert("append INFO underline", appendCells[1]?.userEnteredFormat?.textFormat?.underline === true, JSON.stringify(appendCells[1]?.userEnteredFormat));
    assert(
      "append INFO color",
      colorsApproxEqual(appendCells[1]?.userEnteredFormat?.textFormat?.foregroundColorStyle, "#0D47A1"),
      JSON.stringify(appendCells[1]?.userEnteredFormat?.textFormat?.foregroundColorStyle)
    );
    assert("append msg wrap", appendCells[2]?.userEnteredFormat?.wrapStrategy === "WRAP", JSON.stringify(appendCells[2]?.userEnteredFormat));
    // Sheets may fold a single full-cell run into userEnteredFormat.textFormat
    const appendItalic =
      appendCells[2]?.userEnteredFormat?.textFormat?.italic === true ||
      (appendCells[2]?.textFormatRuns ?? []).some((r) => r.format?.italic === true);
    assert(
      "append msg italic (cell or run)",
      appendItalic,
      JSON.stringify({
        format: appendCells[2]?.userEnteredFormat,
        runs: appendCells[2]?.textFormatRuns,
      })
    );

    // Validation error surfaces as tool error (not crash)
    const badCell = await callTool(baseUrl, sessionId, "write_sheet", {
      url_or_id: spreadsheetId,
      range: `${RICH_SHEET}!A10`,
      values: [[{ value: "x", segments: [{ text: "y" }] }]],
    });
    assert("value+segments is error", badCell.isError, badCell.text);
    assert("value+segments message", /not both/i.test(badCell.text || ""), badCell.text);

    // 17. Decimal-point text numeric guard (comma-locale silent TEXT trap)
    const rejectDotNum = await callTool(baseUrl, sessionId, "write_sheet", {
      url_or_id: spreadsheetId,
      range: `${RICH_SHEET}!A11`,
      values: [["29.3"]],
    });
    assert("write_sheet rejects \"29.3\"", rejectDotNum.isError, rejectDotNum.text);
    assert(
      "write_sheet error mentions allow_text_numerics",
      /allow_text_numerics/i.test(rejectDotNum.text || ""),
      rejectDotNum.text
    );

    const okDotNum = await callTool(baseUrl, sessionId, "write_sheet", {
      url_or_id: spreadsheetId,
      range: `${RICH_SHEET}!A11`,
      values: [[29.3]],
    });
    assert("write_sheet accepts JSON 29.3", !okDotNum.isError, okDotNum.text);

    const overrideDotNum = await callTool(baseUrl, sessionId, "write_sheet", {
      url_or_id: spreadsheetId,
      range: `${RICH_SHEET}!A12`,
      values: [["29.3"]],
      allow_text_numerics: true,
    });
    assert("write_sheet allow_text_numerics override", !overrideDotNum.isError, overrideDotNum.text);

    const dryDotBad = await callTool(baseUrl, sessionId, "update_where", {
      url_or_id: spreadsheetId,
      sheet: RICH_SHEET,
      header_rows: 0,
      where: [{ column: "A", op: "eq", value: "TOOL_TEST" }],
      operations: [{ op: "set", column: "B", value: "29.3" }],
      dry_run: true,
    });
    assert("update_where dry_run rejects \"29.3\" in set", dryDotBad.isError, dryDotBad.text);
    assert(
      "update_where dry_run error useful",
      /operations\[0\] set B/i.test(dryDotBad.text || "") && /allow_text_numerics/i.test(dryDotBad.text || ""),
      dryDotBad.text
    );

    const schemaList = await mcpRequest(baseUrl, "tools/list", {}, sessionId);
    const writeTool = (schemaList.payload?.result?.tools ?? []).find((t) => t.name === "write_sheet");
    assert(
      "write_sheet schema has allow_text_numerics",
      !!writeTool?.inputSchema?.properties?.allow_text_numerics,
      JSON.stringify(writeTool?.inputSchema?.properties)
    );

    log(`\n★ All tests passed (${passed} assertions)`);
  } catch (err) {
    console.error(`\n${logPrefix}✗ Test run failed: ${err.message}`);
    if (failed > 0) console.error(`${logPrefix}  ${failed} assertion(s) failed, ${passed} passed`);
    process.exitCode = 1;
  } finally {
    clearTimeout(timeout);
    if (spreadsheetId) await deleteTempSpreadsheet(spreadsheetId);
    if (process.exitCode === 1) process.exit(1);
  }
}
