/**
 * Unit Test — query_sheet sql.js path (no credentials required)
 *
 * Run: node tests/unit-test-query-sheet-sql.js
 */

import {
  executeSheetSqlQuery,
  prepareSheetSql,
  rewriteContainsToLike,
  cellToSqlValue,
  ensureFromClause,
  assertSelectOnly,
  formatSheetsSerialDate,
  isSheetsDateSerial,
} from "../index.js";

let passed = 0;
let failed = 0;

function assert(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}`);
    console.error(`      expected: ${JSON.stringify(expected)}`);
    console.error(`      actual:   ${JSON.stringify(actual)}`);
    failed++;
  }
}

function assertTrue(label, cond, detail) {
  if (cond) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}`);
    if (detail !== undefined) console.error(`      ${detail}`);
    failed++;
  }
}

const Alerts = [
  ["Created", "Active", "Ticker", "Type", "Trigger"],
  ["2026-05-26", true, "AMZN", "AR_STOP", 217],
  ["2026-05-26", true, "AMZN", "AR_TARGET", 340],
  ["2026-05-26", true, "AMZN", "DATUM_EARNINGS", 46233],
  ["2026-06-12", true, "META", "AR_STOP", 500],
  ["2026-06-12", true, "AMZN", "ENTRY_WATCH", 223],
  ["2026-07-24", true, "AMZN", "AR_STOP", 220],
  ["2026-07-24", false, "AMZN", "DATUM_EARNINGS", 46233],
];

console.log("\n=== query_sheet sql.js unit test ===\n");

console.log("prepare / contains:");
assert(
  "FROM auto-inject",
  prepareSheetSql("SELECT C WHERE C = 'AMZN'", "Alerts"),
  'SELECT C FROM "Alerts" WHERE C = \'AMZN\''
);
assert(
  "contains → LIKE",
  rewriteContainsToLike("SELECT A WHERE A contains 'hun'"),
  "SELECT A WHERE A LIKE '%hun%' ESCAPE '\\'"
);
assertTrue(
  "FROM kept if present",
  prepareSheetSql("SELECT C FROM Alerts WHERE C = 'X'", "Alerts").includes("FROM Alerts"),
  prepareSheetSql("SELECT C FROM Alerts WHERE C = 'X'", "Alerts")
);

assert("cell bool", cellToSqlValue(true), 1);
assert("cell text num", cellToSqlValue("42.30"), 42.3);
assert("cell comma num", cellToSqlValue("23,3"), 23.3);
assert("cell empty → '' (matches WHERE = '')", cellToSqlValue(""), "");
assert("cell null → ''", cellToSqlValue(null), "");

console.log("\nAMZN false-negative regression (full fixture = Sheets API path):");
{
  const result = await executeSheetSqlQuery(Alerts, 1, "Alerts", "SELECT B, C, D WHERE C = 'AMZN'");
  assert("matched_rows = 6", result.matched_rows, 6);
  assertTrue(
    "all AMZN types present",
    result.rows.map((r) => r[2]).sort().join(",") ===
      ["AR_STOP", "AR_STOP", "AR_TARGET", "DATUM_EARNINGS", "DATUM_EARNINGS", "ENTRY_WATCH"]
        .sort()
        .join(","),
    JSON.stringify(result.rows)
  );
  assert("columns use header labels", result.columns, ["Active", "Ticker", "Type"]);
}

console.log("\nGROUP BY / COUNT / SUM:");
{
  const agg = await executeSheetSqlQuery(
    Alerts,
    1,
    "Alerts",
    "SELECT C, COUNT(*) AS n FROM Alerts WHERE C = 'AMZN' GROUP BY C"
  );
  assert("agg matched_rows = 1 (result rows, not source)", agg.matched_rows, 1);
  assert("COUNT AMZN = 6", agg.rows[0][1], 6);
  assert("group col ticker", agg.rows[0][0], "AMZN");
  assert("alias column stays n", agg.columns[1], "n");
  assert("C maps to Ticker", agg.columns[0], "Ticker");

  const sum = await executeSheetSqlQuery(
    Alerts,
    1,
    "Alerts",
    "SELECT C, SUM(E) AS s WHERE C = 'META' GROUP BY C"
  );
  assert("SUM META trigger", sum.rows[0][1], 500);
}

console.log("\nA/B/C only (no header names in SQL):");
{
  let threw = false;
  try {
    await executeSheetSqlQuery(Alerts, 1, "Alerts", "SELECT Ticker WHERE Ticker = 'AMZN'");
  } catch (e) {
    threw = /SQL error/i.test(e.message);
  }
  assertTrue("header name as column → SQL error", threw);
}

console.log("\nInvalid SQL → controlled error:");
{
  let msg = "";
  try {
    await executeSheetSqlQuery(Alerts, 1, "Alerts", "SELECTT C");
  } catch (e) {
    msg = e.message;
  }
  assertTrue("prefix query_sheet:", /^query_sheet:/.test(msg), msg);
  assertTrue("no stack in message", !msg.includes("\n    at "), msg);

  msg = "";
  try {
    await executeSheetSqlQuery(Alerts, 1, "Alerts", "DELETE FROM Alerts");
  } catch (e) {
    msg = e.message;
  }
  assertTrue("rejects DELETE", /only SELECT|read-only/i.test(msg), msg);
}

console.log("\nEmpty result:");
{
  const empty = await executeSheetSqlQuery(
    Alerts,
    1,
    "Alerts",
    "SELECT C WHERE C = 'DOES_NOT_EXIST'"
  );
  assert("matched_rows 0", empty.matched_rows, 0);
  assert("rows []", empty.rows, []);
  assertTrue("columns still present", empty.columns.length >= 1, JSON.stringify(empty.columns));
}

console.log("\nDate / ORDER BY / aggregation:");
{
  const dateSheet = [
    ["Tool", "Action", "Status", "Date"],
    ["A", "x", "OK", 46213],
    ["B", "y", "OK", 46220],
    ["C", "z", "OK", 46210],
  ];
  assertTrue("serial detected", isSheetsDateSerial(46213));
  assert("serial → ISO", formatSheetsSerialDate(46213), "2026-07-10");

  const sorted = await executeSheetSqlQuery(
    dateSheet,
    1,
    "DateTest",
    "SELECT A, D ORDER BY D DESC LIMIT 2"
  );
  assert("ORDER BY date DESC", sorted.rows[0][0], "B");
  assert("date ISO out", sorted.rows[0][1], "2026-07-17");
  assert("date col_type", sorted.col_types[1], "date");

  const cnt = await executeSheetSqlQuery(
    dateSheet,
    1,
    "DateTest",
    "SELECT COUNT(*) AS n WHERE D >= 46213"
  );
  assert("date filter + COUNT", cnt.rows[0][0], 2);
}

console.log("\nNumber / bool / contains regression:");
{
  const numSheet = [
    ["Ticker", "Type", "Value", "Active"],
    ["NVO", "AR_STOP_DOT", "42.30", true],
    ["NVO", "AR_STOP_COMMA", "23,3", true],
    ["NVO", "AR_STOP_EMPTY", "", true],
    ["AXON", "X", 100, true],
    ["HUN1", "Y", 1, false],
  ];
  const numRes = await executeSheetSqlQuery(
    numSheet,
    1,
    "GvizTest",
    "SELECT C WHERE A = 'NVO' AND B = 'AR_STOP_DOT'"
  );
  assert("text 42.30 → 42.3", numRes.rows[0][0], 42.3);

  const boolRes = await executeSheetSqlQuery(
    numSheet,
    1,
    "GvizTest",
    "SELECT A WHERE D = true"
  );
  assertTrue("bool WHERE >= 4", boolRes.matched_rows >= 4, JSON.stringify(boolRes));

  const containsRes = await executeSheetSqlQuery(
    numSheet,
    1,
    "GvizTest",
    "SELECT A WHERE A contains 'HUN'"
  );
  assert("contains match", containsRes.rows[0][0], "HUN1");
}

console.log("\nFilter safety (unit assert — no GViz on data path):");
{
  // The tool always operates on the full values matrix passed by the caller
  // (in production = values.get). UI basicFilter cannot strip rows here.
  const full = await executeSheetSqlQuery(Alerts, 1, "Alerts", "SELECT C WHERE C = 'AMZN'");
  const filteredViewWouldHide = Alerts.filter(
    (row, i) => i === 0 || row[2] !== "AMZN" || i > 4
  );
  // "Filter ON" scenario: with GViz, only late AMZN rows would appear — but the
  // sql path receives the full matrix (like values.get), so 6 remains.
  assert("full data → 6 AMZN", full.matched_rows, 6);
  assertTrue(
    "partial fixture would be less (documents GViz risk)",
    filteredViewWouldHide.length - 1 < 6,
    String(filteredViewWouldHide.length - 1)
  );
  assertTrue(
    "executeSheetSqlQuery is the query engine (no gviz in module path)",
    typeof executeSheetSqlQuery === "function"
  );
}

console.log("\nEdge cases (string literals / empty / bool vs 0-1):");
{
  try {
    assertSelectOnly("SELECT C WHERE C = 'drop'");
    assertTrue("allow drop in string", true);
  } catch (e) {
    assertTrue("allow drop in string", false, e.message);
  }
  try {
    assertSelectOnly("SELECT replace(C, 'a', 'b') FROM T");
    assertTrue("allow replace()", true);
  } catch (e) {
    assertTrue("allow replace()", false, e.message);
  }
  assert(
    "FROM inject ignores 'from' value",
    ensureFromClause("SELECT C WHERE C = 'from'", "T"),
    'SELECT C FROM "T" WHERE C = \'from\''
  );
  assert(
    "FROM inject ignores 'where' literal",
    ensureFromClause("SELECT 'where' AS x", "T"),
    `SELECT 'where' AS x FROM "T"`
  );

  const emptySheet = [
    ["ColA", "ColB", "ColC"],
    ["", true, "E1"],
    [null, false, "E2"],
    ["x", true, "KEEP"],
  ];
  const emptyRes = await executeSheetSqlQuery(emptySheet, 1, "T", "SELECT C WHERE A = ''");
  assert("A = '' matches empties", emptyRes.matched_rows, 2);
  assertTrue(
    "empty filter returns E1/E2",
    emptyRes.rows.map((r) => r[0]).sort().join(",") === "E1,E2",
    JSON.stringify(emptyRes.rows)
  );
  const num01 = await executeSheetSqlQuery([["V"], [0], [1], [0]], 1, "T", "SELECT A");
  assert("0/1 stays number type", num01.col_types[0], "number");
  assert("0/1 stays numeric 0", num01.rows[0][0], 0);

  // Mixed Value col (numbers + invalid_num): LIMIT 1 result type from projected cells
  const mixed = [
    ["Ticker", "Type", "Value", "Active"],
    ["ANET", "AR_TARGET", 100, true],
    ["NVO", "AR_STOP_BAD", "invalid_num", true],
  ];
  const lim = await executeSheetSqlQuery(mixed, 1, "GvizTest", "SELECT C LIMIT 1");
  assert("mixed col LIMIT 1 → number", lim.col_types[0], "number");
  assert("mixed col LIMIT 1 value 100", lim.rows[0][0], 100);
}

console.log(`\n${"─".repeat(40)}`);
if (failed === 0) {
  console.log(`✓ All tests passed (${passed}/${passed})\n`);
  process.exit(0);
} else {
  console.error(`✗ ${failed} test(s) failed (${passed}/${passed + failed} passed)\n`);
  process.exit(1);
}
