/**
 * Unit tests — update_where operations (DEV-TODO 64)
 * Run: node tests/unit-test-update-where-ops.js
 */

import {
  applyReplace,
  assertNoForeignDecimalFinalCell,
  assertNoForeignDecimalInSetOps,
  assertNoLeadingFormulaChars,
  assertNoLegacySetParam,
  cellHasTextFormatRuns,
  cellTextForReplace,
  normalizeOperations,
  snippetAround,
} from "../update-where-ops.js";
import { colLetterToIndex, rowMatches } from "../index.js";

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
  let threw = false;
  let msg = "";
  try {
    fn();
  } catch (e) {
    threw = true;
    msg = String(e && e.message ? e.message : e);
  }
  const ok = threw && (!msgIncludes || msg.includes(msgIncludes));
  if (ok) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}`);
    console.error(`      expected throw${msgIncludes ? ` containing ${JSON.stringify(msgIncludes)}` : ""}`);
    console.error(`      threw=${threw} msg=${JSON.stringify(msg)}`);
    failed++;
  }
}

console.log("\n=== update_where operations unit test (DEV-TODO 64) ===\n");

console.log("normalizeOperations:");
assert(
  "set op OK",
  normalizeOperations([{ op: "set", column: "b", value: false }]),
  [{ op: "set", column: "B", value: false }]
);
assert(
  "replace op OK",
  normalizeOperations([{ op: "replace", column: "J", find: "bekcerülés", replace: "bekerülés" }]),
  [{ op: "replace", column: "J", find: "bekcerülés", replace: "bekerülés", replace_all: true }]
);
assertThrows("empty find", () => normalizeOperations([{ op: "replace", column: "J", find: "", replace: "x" }]), "non-empty");
assertThrows("missing op", () => normalizeOperations([{ column: "A", value: 1 }]), "unknown or missing op");
assertThrows("unknown op", () => normalizeOperations([{ op: "append", column: "A" }]), "unknown or missing op");
assertThrows("set with find", () => normalizeOperations([{ op: "set", column: "A", value: 1, find: "x" }]), "must not include find");
assertThrows("replace with value", () => normalizeOperations([{ op: "replace", column: "A", find: "a", replace: "b", value: 1 }]), "must not include value");
assertThrows("empty operations", () => normalizeOperations([]), "at least one");
assertThrows(
  "legacy set param",
  () => assertNoLegacySetParam({ set: [{ column: "A", value: 1 }] }),
  "hard break"
);

console.log("\napplyReplace:");
assert("one hit", applyReplace("bekcerülés volt", "bekcerülés", "bekerülés", true), {
  text: "bekerülés volt",
  occurrences: 1,
});
assert(
  "replace_all true three",
  applyReplace("aa X aa X aa", "X", "Y", true),
  { text: "aa Y aa Y aa", occurrences: 2 }
);
assert(
  "replace_all false first only",
  applyReplace("aa X aa X aa", "X", "Y", false),
  { text: "aa Y aa X aa", occurrences: 1 }
);
assert("no hit", applyReplace("hello", "zzz", "Y", true), { text: "hello", occurrences: 0 });
assertThrows("empty find runtime", () => applyReplace("a", "", "b"), "non-empty");

console.log("\ncellTextForReplace:");
assert("null → empty", cellTextForReplace(null), "");
assert("undefined → empty", cellTextForReplace(undefined), "");
assert("empty string", cellTextForReplace(""), "");
assert("string passthrough", cellTextForReplace("hi"), "hi");
assertThrows("number refused", () => cellTextForReplace(100), "string");
assertThrows("bool refused", () => cellTextForReplace(true), "string");

console.log("\nsnippetAround:");
const sn = snippetAround("xxxx bekcerülés yyyy", "bekcerülés", 4);
assert("snippet before", sn.before, "xxx ");
assert("snippet match", sn.match, "bekcerülés");
assert("snippet after", sn.after, " yyy");

console.log("\nformula guard:");
assertThrows("rejects =", () => assertNoLeadingFormulaChars("=SUM(A1)"), "formula character");
assertThrows("rejects +", () => assertNoLeadingFormulaChars("+1"), "formula character");
assertThrows("rejects -", () => assertNoLeadingFormulaChars("-1"), "formula character");
assertThrows("rejects @", () => assertNoLeadingFormulaChars("@ref"), "formula character");
assertNoLeadingFormulaChars("=SUM(A1)", { allowFormula: true });
assert("allow_formula passes", true, true);

console.log("\ndecimal final cell (1C):");
assertThrows(
  "full cell 29.3 hu_HU",
  () => assertNoForeignDecimalFinalCell("29.3", { locale: "hu_HU" }),
  "29.3"
);
assertNoForeignDecimalFinalCell("verzió 29.3 jelent meg", { locale: "hu_HU" });
assert("long text with 29.3 OK", true, true);
assertThrows(
  "set op foreign decimal",
  () =>
    assertNoForeignDecimalInSetOps([{ op: "set", column: "B", value: "29.3" }], {
      locale: "hu_HU",
    }),
  "operations[0] set B"
);

console.log("\ncellHasTextFormatRuns:");
assert("empty", cellHasTextFormatRuns({}), false);
assert("empty runs", cellHasTextFormatRuns({ textFormatRuns: [] }), false);
assert("has runs", cellHasTextFormatRuns({ textFormatRuns: [{ startIndex: 0 }] }), true);

console.log("\nHandler mirror: replace-only match basis:");
function resolveOps(values, { where, operations, headerRows = 0, matchMode = "AND", expectedMatchCount, expectedOccurrenceCount, limit }) {
  const whereMatched = [];
  for (let i = headerRows; i < values.length; i++) {
    if (rowMatches(values[i], where, matchMode)) whereMatched.push(i + 1);
  }
  const ops = normalizeOperations(operations);
  const hasReplace = ops.some((o) => o.op === "replace");
  const hasSet = ops.some((o) => o.op === "set");
  const planned = [];
  let totalOccurrences = 0;
  for (const rowNum of whereMatched) {
    const row = values[rowNum - 1] || [];
    const writes = [];
    let rowHasWrite = false;
    for (const op of ops) {
      if (op.op === "set") {
        writes.push({ column: op.column, value: op.value });
        rowHasWrite = true;
        continue;
      }
      const text = cellTextForReplace(row[colLetterToIndex(op.column)]);
      if (!text.includes(op.find)) continue;
      const r = applyReplace(text, op.find, op.replace, op.replace_all);
      totalOccurrences += r.occurrences;
      writes.push({ column: op.column, value: r.text });
      rowHasWrite = true;
    }
    if (rowHasWrite) planned.push({ rowNum, writes });
  }
  const matchBasis = hasReplace && !hasSet ? planned.map((p) => p.rowNum) : whereMatched;
  if (expectedMatchCount !== undefined && matchBasis.length !== expectedMatchCount) {
    return { matched: matchBasis, wrote: false, reason: "expected_match_count", totalOccurrences };
  }
  if (limit !== undefined && matchBasis.length > limit) {
    return { matched: matchBasis, wrote: false, reason: "limit", totalOccurrences };
  }
  if (expectedOccurrenceCount !== undefined && totalOccurrences !== expectedOccurrenceCount) {
    return { matched: matchBasis, wrote: false, reason: "expected_occurrence_count", totalOccurrences };
  }
  if (matchBasis.length === 0) return { matched: [], wrote: false, reason: "no_match", totalOccurrences };
  return { matched: matchBasis, wrote: true, planned, totalOccurrences };
}

const sheetValues = [
  ["Ticker", "Ctx"],
  ["AXON", "bekcerülés one"],
  ["NVO", "clean"],
  ["AXON", "bekcerülés two"],
];
const r1 = resolveOps(sheetValues, {
  headerRows: 1,
  where: [{ column: "A", op: "eq", value: "AXON" }],
  operations: [{ op: "replace", column: "B", find: "bekcerülés", replace: "bekerülés" }],
  expectedMatchCount: 2,
});
assert("replace-only expected 2 containing", r1.wrote, true);
assert("replace matched [2,4]", r1.matched, [2, 4]);
assert("occurrences 2", r1.totalOccurrences, 2);

const r2 = resolveOps(sheetValues, {
  headerRows: 1,
  where: [{ column: "A", op: "eq", value: "AXON" }],
  operations: [{ op: "replace", column: "B", find: "bekcerülés", replace: "bekerülés" }],
  expectedMatchCount: 3,
});
assert("expected_match_count 3 abort", r2.wrote, false);

const r3 = resolveOps(sheetValues, {
  headerRows: 1,
  where: [{ column: "A", op: "eq", value: "AXON" }],
  operations: [
    { op: "set", column: "A", value: "DONE" },
    { op: "replace", column: "B", find: "bekcerülés", replace: "bekerülés" },
  ],
});
assert("mixed: set basis is where-matched", r3.matched, [2, 4]);
assert("mixed wrote", r3.wrote, true);

console.log(`\n${"─".repeat(40)}`);
if (failed === 0) {
  console.log(`✓ All tests passed (${passed}/${passed})\n`);
  process.exit(0);
} else {
  console.error(`✗ ${failed} test(s) failed (${passed}/${passed + failed} passed)\n`);
  process.exit(1);
}
