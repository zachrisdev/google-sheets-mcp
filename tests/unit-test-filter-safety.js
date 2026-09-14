/**
 * Unit Test — reader tools are filter-independent (documented asserts)
 *
 * Proves: query_sheet / update_where / read_sheet use Sheets API values,
 * not GViz /gviz/tq — UI basicFilter is not part of the data path.
 *
 * Run: node tests/unit-test-filter-safety.js
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { executeSheetSqlQuery, rowMatches, evaluateCondition } from "../index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");

let passed = 0;
let failed = 0;

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

console.log("\n=== filter-safety unit test ===\n");

const indexSrc = fs.readFileSync(path.join(ROOT, "index.js"), "utf8");
const sheetSqlSrc = fs.readFileSync(path.join(ROOT, "sheet-sql.js"), "utf8");

console.log("query_sheet path:");
{
  // Production handler: values.get + executeSheetSqlQuery, no gviz/tq call
  const handlerSlice = indexSrc.slice(
    indexSrc.indexOf('if (name === "query_sheet")'),
    indexSrc.indexOf('if (name === "update_where")')
  );
  assertTrue(
    "query_sheet uses spreadsheets.values.get",
    /spreadsheets\.values\.get/.test(handlerSlice),
    handlerSlice.slice(0, 200)
  );
  assertTrue(
    "query_sheet uses executeSheetSqlQuery",
    /executeSheetSqlQuery/.test(handlerSlice)
  );
  assertTrue(
    "query_sheet handler has no gviz/tq fetch/URL",
    !/https?:\/\/[^'"\s]*gviz\/tq|\/gviz\/tq\?/.test(handlerSlice),
    handlerSlice.match(/gviz[^\n]*/)?.[0]
  );
  assertTrue(
    "sheet-sql has no gviz/tq",
    !/gviz\/tq/.test(sheetSqlSrc)
  );
}

console.log("\nread_sheet path:");
{
  const handlerSlice = indexSrc.slice(
    indexSrc.indexOf('if (name === "read_sheet")'),
    indexSrc.indexOf('if (name === "write_sheet")')
  );
  assertTrue(
    "read_sheet uses spreadsheets.values.get",
    /spreadsheets\.values\.get/.test(handlerSlice)
  );
  assertTrue("read_sheet has no gviz/tq", !/gviz\/tq/.test(handlerSlice));
}

console.log("\nupdate_where path:");
{
  const handlerSlice = indexSrc.slice(
    indexSrc.indexOf('if (name === "update_where")'),
    indexSrc.indexOf("throw new Error(`Unknown tool:")
  );
  assertTrue(
    "update_where uses spreadsheets.values.get",
    /spreadsheets\.values\.get/.test(handlerSlice)
  );
  assertTrue("update_where has no gviz/tq", !/gviz\/tq/.test(handlerSlice));
  // dry_run / rowMatches remain local — filter-independent
  assertTrue(
    "rowMatches available (dry_run filter logic)",
    typeof rowMatches === "function" && typeof evaluateCondition === "function"
  );
}

console.log("\nSemantic: full matrix visible to sql engine:");
{
  const sheet = [
    ["Ticker"],
    ["AMZN"],
    ["AMZN"],
    ["META"],
    ["AMZN"],
  ];
  // UI filter could hide the first two AMZN rows; values.get returns all.
  const r = await executeSheetSqlQuery(sheet, 1, "T", "SELECT A WHERE A = 'AMZN'");
  assertTrue("3 AMZN rows regardless of any UI filter", r.matched_rows === 3, JSON.stringify(r));
}

console.log(`\n${"─".repeat(40)}`);
if (failed === 0) {
  console.log(`✓ All tests passed (${passed}/${passed})\n`);
  process.exit(0);
} else {
  console.error(`✗ ${failed} test(s) failed (${passed}/${passed + failed} passed)\n`);
  process.exit(1);
}
