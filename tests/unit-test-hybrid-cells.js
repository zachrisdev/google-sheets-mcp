/**
 * Unit Test — hybrid Cell (value|segments + defaults) helpers
 *
 * Run:
 *   node tests/unit-test-hybrid-cells.js
 */

import {
  parseHexColor,
  utf16Length,
  buildTextFormat,
  buildUserEnteredFormat,
  segmentsToPlainAndRuns,
  normalizeCell,
  normalizeValuesGrid,
  extractScalarValues,
  gridNeedsHybrid,
  parseA1RangeStart,
  collectFormatRequests,
  colLetterToIndex,
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

function assertThrows(label, fn, msgIncludes) {
  try {
    fn();
    console.error(`  ✗ ${label} (expected throw)`);
    failed++;
  } catch (e) {
    if (msgIncludes && !String(e.message).includes(msgIncludes)) {
      console.error(`  ✗ ${label}`);
      console.error(`      expected message to include: ${msgIncludes}`);
      console.error(`      actual: ${e.message}`);
      failed++;
      return;
    }
    console.log(`  ✓ ${label}`);
    passed++;
  }
}

console.log("\n=== hybrid Cell unit test ===\n");

console.log("parseHexColor:");
assert("#RGB expand", parseHexColor("#C00"), {
  rgbColor: { red: 204 / 255, green: 0, blue: 0 },
});
assert("#RRGGBB", parseHexColor("#1155CC"), {
  rgbColor: { red: 17 / 255, green: 85 / 255, blue: 204 / 255 },
});
assert("without hash", parseHexColor("00FF00"), {
  rgbColor: { red: 0, green: 1, blue: 0 },
});
assertThrows("invalid hex", () => parseHexColor("red"), "Invalid color");

console.log("\nutf16Length (JS = Sheets UTF-16 units):");
assert("ascii", utf16Length("ERROR"), 5);
assert("newline", utf16Length("a\nb"), 3);
assert("emoji surrogate pair", utf16Length("😀"), 2);
assert("A+emoji+B", utf16Length("A😀B"), 4);

console.log("\nsegmentsToPlainAndRuns:");
{
  const { text, runs } = segmentsToPlainAndRuns([
    { text: "ERROR", bold: true, color: "#CC0000" },
    { text: ": ok\n" },
    { text: "docs", link: "https://example.com", color: "#1155CC" },
  ]);
  assert("plain text concat", text, "ERROR: ok\ndocs");
  assert("3 runs", runs.length, 3);
  assert("run0 start", runs[0].startIndex, 0);
  assert("run1 start", runs[1].startIndex, 5);
  assert("run2 start", runs[2].startIndex, 10);
  assert("run0 bold", runs[0].format.bold, true);
  assert("run1 empty format keys", Object.keys(runs[1].format), []);
  assert("run2 link", runs[2].format.link, { uri: "https://example.com" });
}
{
  const { text, runs } = segmentsToPlainAndRuns([
    { text: "A" },
    { text: "😀", bold: true },
    { text: "B" },
  ]);
  assert("emoji text", text, "A😀B");
  assert("emoji bold startIndex", runs[1].startIndex, 1);
  assert("after emoji startIndex", runs[2].startIndex, 3);
}

console.log("\nnormalizeCell:");
{
  const s = normalizeCell("plain");
  assert("scalar kind", s.kind, "scalar");
  assert("scalar value", s.value, "plain");
  assert("scalar no hybrid", s.needsFormat || s.needsRich, false);
}
{
  const c = normalizeCell({ value: "2026-07-18 21:03:00", bold: true, color: "#666666" });
  assert("value kind", c.kind, "value");
  assert("value passthrough", c.value, "2026-07-18 21:03:00");
  assert("value needsFormat", c.needsFormat, true);
  assert("value not rich", c.needsRich, false);
  assert("value bold in format", c.cellFormat.textFormat.bold, true);
}
{
  const c = normalizeCell({
    wrap: true,
    bg: "#FFCCCC",
    color: "#333333",
    segments: [
      { text: "ERROR", bold: true, color: "#CC0000" },
      { text: ": timeout" },
    ],
  });
  assert("rich kind", c.kind, "rich");
  assert("rich plain", c.plainText, "ERROR: timeout");
  assert("rich needsRich", c.needsRich, true);
  assert("rich wrap", c.cellFormat.wrapStrategy, "WRAP");
  assert("rich bg present", !!c.cellFormat.backgroundColorStyle, true);
  assert("rich cell color present", !!c.cellFormat.textFormat.foregroundColorStyle, true);
  assert("rich runs", c.runs.length, 2);
}
assertThrows("value+segments", () => normalizeCell({ value: "x", segments: [{ text: "y" }] }), "not both");
assertThrows("cell-level link", () => normalizeCell({ value: "x", link: "https://x" }), "only allowed on segments");
assertThrows("unknown cell key", () => normalizeCell({ value: "x", fontSize: 12 }), "unknown key");
assertThrows("unknown segment key", () => normalizeCell({ segments: [{ text: "a", foo: 1 }] }), "unknown key");
assertThrows("segment missing text", () => normalizeCell({ segments: [{ bold: true }] }), "text is required");

console.log("\ngrid helpers:");
{
  const grid = normalizeValuesGrid([
    ["a", { value: "b", bold: true }],
    [{ segments: [{ text: "c", italic: true }] }],
  ]);
  assert("extract scalars", extractScalarValues(grid), [["a", "b"], ["c"]]);
  assert("needs hybrid", gridNeedsHybrid(grid), true);
  assert("plain grid no hybrid", gridNeedsHybrid(normalizeValuesGrid([[1, 2]])), false);
}

console.log("\nparseA1RangeStart:");
assert("Sheet1!B2:D4", parseA1RangeStart("Sheet1!B2:D4"), {
  sheetName: "Sheet1",
  startCol: colLetterToIndex("B"),
  startRow: 1,
});
assert("quoted sheet", parseA1RangeStart("'My Sheet'!A1"), {
  sheetName: "My Sheet",
  startCol: 0,
  startRow: 0,
});
assert("no sheet", parseA1RangeStart("C10"), {
  sheetName: null,
  startCol: colLetterToIndex("C"),
  startRow: 9,
});

console.log("\ncollectFormatRequests:");
{
  const grid = normalizeValuesGrid([[
    { value: "ERROR", bg: "#FFCCCC", bold: true },
    { segments: [{ text: "Hi", bold: true }, { text: " there" }], wrap: true },
  ]]);
  const reqs = collectFormatRequests(grid, 99, 2, 0);
  assert("2 format requests", reqs.length, 2);
  assert("value cell fields", reqs[0].updateCells.fields.includes("userEnteredFormat"), true);
  assert("value cell no runs field", reqs[0].updateCells.fields.includes("textFormatRuns"), false);
  assert("rich fields include runs", reqs[1].updateCells.fields.includes("textFormatRuns"), true);
  assert("rich fields include value", reqs[1].updateCells.fields.includes("userEnteredValue"), true);
  assert("row index", reqs[0].updateCells.range.startRowIndex, 2);
  assert("col0", reqs[0].updateCells.range.startColumnIndex, 0);
  assert("col1", reqs[1].updateCells.range.startColumnIndex, 1);
}

console.log("\nbuildTextFormat / buildUserEnteredFormat:");
assert("bold false explicit", buildTextFormat({ bold: false }).bold, false);
assert("wrap only", buildUserEnteredFormat({ wrap: true }), { wrapStrategy: "WRAP" });
assert("empty defaults null", buildUserEnteredFormat({}), null);

console.log(`\n=== Result: ${passed} passed, ${failed} failed ===\n`);
process.exit(failed > 0 ? 1 : 0);
