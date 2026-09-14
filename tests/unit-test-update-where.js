/**
 * Unit Test — update_where logic (runnable without credentials)
 *
 * Tests pure helper functions exported from index.js:
 *   - colLetterToIndex / colIndexToLetter (column letter ↔ index, including AA)
 *   - coerceNumber (comma decimals, text-num, empty, non-numeric)
 *   - evaluateCondition (all ops)
 *   - rowMatches (AND / OR)
 * Also mirrors handler core logic:
 *   - matching physical row calculation with header_rows
 *   - batch-range generation (e.g. Sheet1!F87)
 *   - expected_match_count / limit preconditions
 *   - zero-match case
 *
 * Run:
 *   node tests/unit-test-update-where.js
 */

import {
  colLetterToIndex,
  colIndexToLetter,
  coerceNumber,
  evaluateCondition,
  rowMatches,
  toUserEnteredValue,
  valuesToRowData,
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

// Helper mirroring handler core: computes matching physical rows and batch data.
// (If index.js handler logic changes, update this too.)
function resolveUpdate(values, { sheet, where, set, headerRows = 0, matchMode = "AND", limit, expectedMatchCount }) {
  const matched = [];
  for (let i = headerRows; i < values.length; i++) {
    if (rowMatches(values[i], where, matchMode)) matched.push(i + 1);
  }
  if (expectedMatchCount !== undefined && matched.length !== expectedMatchCount) {
    return { matched, wrote: false, reason: "expected_match_count" };
  }
  if (limit !== undefined && matched.length > limit) {
    return { matched, wrote: false, reason: "limit" };
  }
  if (matched.length === 0) {
    return { matched, wrote: false, reason: "no_match" };
  }
  const data = [];
  for (const rowNum of matched) {
    for (const s of set) {
      data.push({ range: `${sheet}!${String(s.column).toUpperCase()}${rowNum}`, values: [[s.value]] });
    }
  }
  return { matched, wrote: true, data };
}

console.log("\n=== update_where unit test ===\n");

console.log("colLetterToIndex:");
assert("A → 0", colLetterToIndex("A"), 0);
assert("C → 2", colLetterToIndex("C"), 2);
assert("F → 5", colLetterToIndex("F"), 5);
assert("Z → 25", colLetterToIndex("Z"), 25);
assert("AA → 26", colLetterToIndex("AA"), 26);
assert("lowercase 'c' → 2", colLetterToIndex("c"), 2);

console.log("\ncolIndexToLetter:");
assert("0 → A", colIndexToLetter(0), "A");
assert("5 → F", colIndexToLetter(5), "F");
assert("25 → Z", colIndexToLetter(25), "Z");
assert("26 → AA", colIndexToLetter(26), "AA");

console.log("\ncoerceNumber:");
assert("100 (number) → 100", coerceNumber(100), 100);
assert("'23,3' → 23.3", coerceNumber("23,3"), 23.3);
assert("'42.30' → 42.3", coerceNumber("42.30"), 42.3);
assert("'' → null", coerceNumber(""), null);
assert("'abc' → null", coerceNumber("abc"), null);
assert("true → null", coerceNumber(true), null);

console.log("\nevaluateCondition:");
assert("eq: '100' == 100 (num) → true", evaluateCondition("100", "eq", 100), true);
assert("eq: 'AXON' == 'AXON' → true", evaluateCondition("AXON", "eq", "AXON"), true);
assert("eq: 'AXON' == 'axon' (str) → false", evaluateCondition("AXON", "eq", "axon"), false);
assert("ne: 'AXON' != 'NVO' → true", evaluateCondition("AXON", "ne", "NVO"), true);
assert("contains: 'Hungary' contains 'hun' (ci) → true", evaluateCondition("Hungary", "contains", "hun"), true);
assert("gt: 150 > 100 → true", evaluateCondition(150, "gt", 100), true);
assert("gte: 100 >= 100 → true", evaluateCondition(100, "gte", 100), true);
assert("lt: 30 < 100 → true", evaluateCondition(30, "lt", 100), true);
assert("lte: 100 <= 30 → false", evaluateCondition(100, "lte", 30), false);
assert("gt: 'abc' > 10 (non-numeric) → false", evaluateCondition("abc", "gt", 10), false);
assert("empty: '' → true", evaluateCondition("", "empty"), true);
assert("empty: null → true", evaluateCondition(null, "empty"), true);
assert("empty: undefined → true", evaluateCondition(undefined, "empty"), true);
assert("not_empty: 'x' → true", evaluateCondition("x", "not_empty"), true);
assert("gt comma decimal: '23,3' > 20 → true", evaluateCondition("23,3", "gt", 20), true);

console.log("\nrowMatches (AND / OR):");
const row = ["AXON", "AR_TARGET", 150, true, "", 25];
assert("AND: C==AXON? no (A is AXON) — A==AXON AND F<30 → true",
  rowMatches(row, [{ column: "A", op: "eq", value: "AXON" }, { column: "F", op: "lt", value: 30 }], "AND"), true);
assert("AND: A==AXON AND F>30 → false",
  rowMatches(row, [{ column: "A", op: "eq", value: "AXON" }, { column: "F", op: "gt", value: 30 }], "AND"), false);
assert("OR: A==NVO OR F<30 → true",
  rowMatches(row, [{ column: "A", op: "eq", value: "NVO" }, { column: "F", op: "lt", value: 30 }], "OR"), true);

console.log("\nHandler core: matching rows, physical row numbers, batch-range:");
// header (row 1) + 4 data rows. Physical rows are 1-based.
const sheetValues = [
  ["Ticker", "Type", "Value"],   // row 1 (header)
  ["AXON", "AR_TARGET", 10],      // row 2
  ["NVO", "AR_STOP", 20],         // row 3
  ["AXON", "AR_TARGET", 30],      // row 4
  ["ANET", "AR_TARGET", 40],      // row 5
];

const r1 = resolveUpdate(sheetValues, {
  sheet: "Sheet1",
  headerRows: 1,
  where: [{ column: "A", op: "eq", value: "AXON" }],
  set: [{ column: "C", value: 99 }],
});
assert("AXON matches physical rows → [2, 4]", r1.matched, [2, 4]);
assert("write occurs", r1.wrote, true);
assert("batch ranges → Sheet1!C2, Sheet1!C4", r1.data.map((d) => d.range), ["Sheet1!C2", "Sheet1!C4"]);
assert("batch value → 99", r1.data[0].values, [[99]]);

console.log("\nPreconditions:");
const r2 = resolveUpdate(sheetValues, {
  sheet: "Sheet1", headerRows: 1,
  where: [{ column: "A", op: "eq", value: "AXON" }],
  set: [{ column: "C", value: 99 }],
  expectedMatchCount: 1,
});
assert("expected_match_count=1, actual=2 → no write", r2.wrote, false);
assert("rejection reason: expected_match_count", r2.reason, "expected_match_count");

const r3 = resolveUpdate(sheetValues, {
  sheet: "Sheet1", headerRows: 1,
  where: [{ column: "A", op: "eq", value: "AXON" }],
  set: [{ column: "C", value: 99 }],
  limit: 1,
});
assert("limit=1, actual=2 → no write", r3.wrote, false);
assert("rejection reason: limit", r3.reason, "limit");

const r4 = resolveUpdate(sheetValues, {
  sheet: "Sheet1", headerRows: 1,
  where: [{ column: "A", op: "eq", value: "NINCS_ILYEN" }],
  set: [{ column: "C", value: 99 }],
});
assert("0 matches → no write", r4.wrote, false);
assert("0 match reason: no_match", r4.reason, "no_match");
assert("0 match matched empty", r4.matched, []);

console.log("\n── insert_rows helpers ──");
assert("toUserEnteredValue number", toUserEnteredValue(42), { numberValue: 42 });
assert("toUserEnteredValue bool", toUserEnteredValue(true), { boolValue: true });
assert("toUserEnteredValue formula", toUserEnteredValue("=A1+1"), { formulaValue: "=A1+1" });
assert("toUserEnteredValue string", toUserEnteredValue("hello"), { stringValue: "hello" });
assert("toUserEnteredValue empty", toUserEnteredValue(""), null);
assert("toUserEnteredValue null", toUserEnteredValue(null), null);
assert("valuesToRowData shape", valuesToRowData([["a", 1], ["=B1", true]]), [
  { values: [{ userEnteredValue: { stringValue: "a" } }, { userEnteredValue: { numberValue: 1 } }] },
  { values: [{ userEnteredValue: { formulaValue: "=B1" } }, { userEnteredValue: { boolValue: true } }] },
]);

console.log(`\n${"─".repeat(40)}`);
if (failed === 0) {
  console.log(`✓ All tests passed (${passed}/${passed})\n`);
  process.exit(0);
} else {
  console.error(`✗ ${failed} test(s) failed (${passed}/${passed + failed} passed)\n`);
  process.exit(1);
}
