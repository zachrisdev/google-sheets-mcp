/**
 * Unit tests — write-dedupe (TTL content-hash / request_id + annotate)
 *
 *   node tests/unit-test-write-dedupe.js
 */

import {
  canonicalJson,
  sha256Hex,
  shortFp,
  buildDedupeKey,
  parseRequestId,
  lookupDedupe,
  storeDedupe,
  annotateDedupedResponse,
  withWriteDedupe,
  _resetDedupeForTests,
  _dedupeSizeForTests,
  estimatePayloadChars,
} from "../write-dedupe.js";

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

_resetDedupeForTests();

console.log("\n── canonicalJson / hash ──");
assert(
  "object key order normalized",
  canonicalJson({ b: 1, a: 2 }),
  canonicalJson({ a: 2, b: 1 })
);
assertTrue("array order preserved", canonicalJson([1, 2]) !== canonicalJson([2, 1]));
assert("short fp length", shortFp(sha256Hex("x")).length, 12);

console.log("\n── keys ──");
assert(
  "request_id key preferred",
  buildDedupeKey({ tool: "insert_rows", spreadsheetId: "SID", requestId: "abc", fingerprint: "fff" }),
  "rid:insert_rows:SID:abc"
);
assert(
  "fingerprint key",
  buildDedupeKey({ tool: "insert_rows", spreadsheetId: "SID", requestId: null, fingerprint: "abcdef" }),
  "fp:insert_rows:SID:abcdef"
);
assert("parseRequestId trim", parseRequestId({ request_id: "  x  " }), "x");
assert("parseRequestId empty", parseRequestId({ request_id: "  " }), null);

console.log("\n── cache store/lookup ──");
_resetDedupeForTests();
const resp = { content: [{ type: "text", text: JSON.stringify({ rows_inserted: 1 }) }] };
storeDedupe("fp:insert_rows:SID:aaa", resp);
assertTrue("lookup hit", lookupDedupe("fp:insert_rows:SID:aaa") !== null);
assert("size 1", _dedupeSizeForTests(), 1);
storeDedupe("fp:insert_rows:SID:err", { isError: true, content: [{ type: "text", text: "Error" }] });
assert("errors not stored", _dedupeSizeForTests(), 1);

console.log("\n── annotate ──");
const annotated = annotateDedupedResponse(resp);
const parsed = JSON.parse(annotated.content[0].text);
assert("deduped flag on JSON", parsed.deduped, true);
assertTrue("dedupe_note present", typeof parsed.dedupe_note === "string");
const plain = annotateDedupedResponse({ content: [{ type: "text", text: "Successfully written" }] });
assertTrue("plain text suffix", plain.content[0].text.includes("[deduped=true]"));

console.log("\n── withWriteDedupe ──");
_resetDedupeForTests();
let runs = 0;
const args = { request_id: "req-1" };
const r1 = await withWriteDedupe({
  tool: "insert_rows",
  spreadsheetId: "SID",
  args,
  fingerprintPayload: { sheet: "EventLog", values: [["a", "b"]] },
  run: async () => {
    runs++;
    return { content: [{ type: "text", text: JSON.stringify({ rows_inserted: 1, ok: true }) }] };
  },
});
const r2 = await withWriteDedupe({
  tool: "insert_rows",
  spreadsheetId: "SID",
  args,
  fingerprintPayload: { sheet: "EventLog", values: [["a", "b"]] },
  run: async () => {
    runs++;
    return { content: [{ type: "text", text: JSON.stringify({ rows_inserted: 1, ok: true }) }] };
  },
});
assert("run once", runs, 1);
assert("second response deduped", JSON.parse(r2.content[0].text).deduped, true);
assertTrue("first not marked", JSON.parse(r1.content[0].text).deduped !== true);

// Same payload without request_id still dedupes via fingerprint
_resetDedupeForTests();
runs = 0;
const fpArgs = {};
await withWriteDedupe({
  tool: "append_rows",
  spreadsheetId: "SID",
  args: fpArgs,
  fingerprintPayload: { range: "X", values: [["z"]] },
  run: async () => {
    runs++;
    return { content: [{ type: "text", text: "Successfully appended 1 rows" }] };
  },
});
const fp2 = await withWriteDedupe({
  tool: "append_rows",
  spreadsheetId: "SID",
  args: fpArgs,
  fingerprintPayload: { range: "X", values: [["z"]] },
  run: async () => {
    runs++;
    return { content: [{ type: "text", text: "Successfully appended 1 rows" }] };
  },
});
assert("fingerprint dedupe run once", runs, 1);
assertTrue("plain dedupe suffix", fp2.content[0].text.includes("[deduped=true]"));

// dry_run skip
_resetDedupeForTests();
runs = 0;
await withWriteDedupe({
  tool: "update_where",
  spreadsheetId: "SID",
  args: {},
  skipDedupe: true,
  fingerprintPayload: { operations: [{ op: "set", column: "A", value: 1 }] },
  run: async () => {
    runs++;
    return { content: [{ type: "text", text: "{}" }] };
  },
});
await withWriteDedupe({
  tool: "update_where",
  spreadsheetId: "SID",
  args: {},
  skipDedupe: true,
  fingerprintPayload: { operations: [{ op: "set", column: "A", value: 1 }] },
  run: async () => {
    runs++;
    return { content: [{ type: "text", text: "{}" }] };
  },
});
assert("skipDedupe always runs", runs, 2);
assert("cache empty after skip", _dedupeSizeForTests(), 0);

assertTrue("estimatePayloadChars > 0", estimatePayloadChars({ a: "x".repeat(100) }) > 50);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
