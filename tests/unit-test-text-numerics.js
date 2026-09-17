/**
 * Unit Test — locale-aware foreign decimal text numeric guard
 *
 * Run:
 *   node tests/unit-test-text-numerics.js
 */

import {
  DOT_DECIMAL_TEXT_RE,
  COMMA_DECIMAL_TEXT_RE,
  isDotDecimalTextNumeric,
  isCommaDecimalTextNumeric,
  isForeignDecimalTextNumeric,
  decimalSeparatorForLocale,
  suggestedNumberFromDotDecimalText,
  suggestedNumberFromCommaDecimalText,
  assertNoDotDecimalTextNumerics,
  assertNoDotDecimalTextInSet,
  parseAllowTextNumerics,
  normalizeValuesGrid,
  extractScalarValues,
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

function assertTrue(label, cond) {
  if (cond) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}`);
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

console.log("\n=== text-numerics unit test ===\n");

console.log("decimalSeparatorForLocale:");
assert("hu_HU → ,", decimalSeparatorForLocale("hu_HU"), ",");
assert("hu-HU → ,", decimalSeparatorForLocale("hu-HU"), ",");
assert("en_US → .", decimalSeparatorForLocale("en_US"), ".");
assert("en-US → .", decimalSeparatorForLocale("en-US"), ".");

console.log("\nisDotDecimalTextNumeric (reject candidates):");
for (const v of ["29.3", "-1.5", " 29.3 ", "\t29.3", ".5", "-.25"]) {
  assertTrue(JSON.stringify(v), isDotDecimalTextNumeric(v));
}

console.log("\nisDotDecimalTextNumeric (allow):");
for (const v of [
  29.3,
  "29",
  "29.",
  "2026-09-05",
  "4:1",
  "1.0.0",
  "=A1+1",
  " =SUM(1)",
  "hello",
  "",
  "  ",
  null,
  undefined,
  true,
]) {
  assertTrue(JSON.stringify(v), !isDotDecimalTextNumeric(v));
}

console.log("\nisCommaDecimalTextNumeric:");
assertTrue('"29,3"', isCommaDecimalTextNumeric("29,3"));
assertTrue('",5"', isCommaDecimalTextNumeric(",5"));
assertTrue('"29.3" not comma', !isCommaDecimalTextNumeric("29.3"));

console.log("\nisForeignDecimalTextNumeric:");
assertTrue("hu_HU rejects 29.3", isForeignDecimalTextNumeric("29.3", "hu_HU"));
assertTrue("hu_HU allows 29,3", !isForeignDecimalTextNumeric("29,3", "hu_HU"));
assertTrue("en_US rejects 29,3", isForeignDecimalTextNumeric("29,3", "en_US"));
assertTrue("en_US allows 29.3", !isForeignDecimalTextNumeric("29.3", "en_US"));

console.log("\nsuggestedNumberFromDotDecimalText:");
assert("29.3 → 29.3", suggestedNumberFromDotDecimalText("29.3"), 29.3);
assert(".5 → 0.5", suggestedNumberFromDotDecimalText(".5"), 0.5);
assert("29. → null", suggestedNumberFromDotDecimalText("29."), null);

console.log("\nsuggestedNumberFromCommaDecimalText:");
assert("29,3 → 29.3", suggestedNumberFromCommaDecimalText("29,3"), 29.3);

console.log("\nparseAllowTextNumerics:");
assertTrue("true", parseAllowTextNumerics(true));
assertTrue('"true"', parseAllowTextNumerics("true"));
assertTrue("false", !parseAllowTextNumerics(false));
assertTrue("undefined", !parseAllowTextNumerics(undefined));

console.log("\nassertNoDotDecimalTextNumerics (hu_HU):");
assertThrows(
  "rejects 29.3",
  () =>
    assertNoDotDecimalTextNumerics([["ok", "29.3"]], {
      toolName: "write_sheet",
      locale: "hu_HU",
    }),
  "values[0][1]"
);
assertThrows(
  "fail-fast first offender",
  () =>
    assertNoDotDecimalTextNumerics([["29.3", ".5"]], {
      toolName: "write_sheet",
      locale: "hu_HU",
    }),
  "values[0][0]"
);
assertNoDotDecimalTextNumerics([[29.3, "29", "29."]], {
  toolName: "write_sheet",
  locale: "hu_HU",
});
assertTrue("JSON number ok", true);
assertNoDotDecimalTextNumerics([["29.3"]], {
  allow: true,
  toolName: "write_sheet",
  locale: "hu_HU",
});
assertTrue("allow override", true);
assertNoDotDecimalTextNumerics([["29.3"]], {
  toolName: "write_sheet",
  locale: "en_US",
});
assertTrue("en_US allows point text", true);
assertThrows(
  "en_US rejects comma text",
  () =>
    assertNoDotDecimalTextNumerics([["29,3"]], {
      toolName: "write_sheet",
      locale: "en_US",
    }),
  "values[0][0]"
);

console.log("\nhybrid value + segments:");
{
  const grid = normalizeValuesGrid([[{ value: "29.3" }]]);
  assertThrows(
    "hybrid value rejected",
    () =>
      assertNoDotDecimalTextNumerics(extractScalarValues(grid), {
        toolName: "write_sheet",
        locale: "hu_HU",
      }),
    "values[0][0]"
  );
}
{
  const grid = normalizeValuesGrid([[{ segments: [{ text: "29.3" }] }]]);
  assertThrows(
    "segments plain rejected",
    () =>
      assertNoDotDecimalTextNumerics(extractScalarValues(grid), {
        toolName: "append_rows",
        locale: "hu_HU",
      }),
    "values[0][0]"
  );
}

console.log("\nassertNoDotDecimalTextInSet (legacy helper still OK):");
assertThrows(
  "set F=29.3",
  () =>
    assertNoDotDecimalTextInSet([{ column: "F", value: "29.3" }], {
      toolName: "update_where",
      locale: "hu_HU",
    }),
  "set[0] F"
);
assertNoDotDecimalTextInSet([{ column: "F", value: 29.3 }], {
  toolName: "update_where",
  locale: "hu_HU",
});
assertTrue("set JSON number ok", true);
assertNoDotDecimalTextInSet([{ column: "F", value: "29.3" }], {
  allow: true,
  toolName: "update_where",
  locale: "hu_HU",
});
assertTrue("set allow override", true);

console.log("\nregex export:");
assertTrue("dot regex matches 29.3", DOT_DECIMAL_TEXT_RE.test("29.3"));
assertTrue("dot regex rejects 29.", !DOT_DECIMAL_TEXT_RE.test("29."));
assertTrue("comma regex matches 29,3", COMMA_DECIMAL_TEXT_RE.test("29,3"));

console.log(`\n=== Result: ${passed} passed, ${failed} failed ===\n`);
process.exit(failed > 0 ? 1 : 0);
