/**
 * Write-path helpers for Claude Desktop MCP bridge quirks (DEV-TODO 32):
 * - in-memory TTL dedupe (naive retry after false client timeout → no second write)
 * - structured completion logs on stderr for correlating Desktop 4-min orphans
 *
 * Keying:
 *   request_id (preferred): rid:<tool>:<spreadsheetId>:<request_id>
 *   else content hash:      fp:<tool>:<spreadsheetId>:<sha256>
 */

import { createHash } from "crypto";

export const DEDUPE_TTL_MS = 5 * 60 * 1000;
export const DEDUPE_MAX_ENTRIES = 200;

/** Schema fragment for write tools. */
export const REQUEST_ID_PROP = {
  type: "string",
  description:
    "Optional idempotency key. Same request_id (or identical payload) within ~5 min " +
    "returns the prior success without a second Sheets write — defense against Claude Desktop " +
    "false 4-min timeouts / bridge drops that tempt naive retries.",
};

/** @type {Map<string, { storedAt: number, response: object }>} */
const cache = new Map();

/** Stable JSON for hashing (sorted object keys; arrays keep order). */
export function canonicalJson(value) {
  return JSON.stringify(value, (_key, v) => {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const sorted = {};
      for (const k of Object.keys(v).sort()) sorted[k] = v[k];
      return sorted;
    }
    return v;
  });
}

export function sha256Hex(text) {
  return createHash("sha256").update(String(text), "utf8").digest("hex");
}

export function shortFp(hex) {
  return String(hex).slice(0, 12);
}

/**
 * Estimate string payload size (chars) for logging.
 * @param {unknown} payload
 */
export function estimatePayloadChars(payload) {
  try {
    return canonicalJson(payload).length;
  } catch {
    return -1;
  }
}

/**
 * @param {{ tool: string, spreadsheetId: string, requestId?: string|null, fingerprint: string }} p
 */
export function buildDedupeKey({ tool, spreadsheetId, requestId, fingerprint }) {
  if (requestId) {
    return `rid:${tool}:${spreadsheetId}:${requestId}`;
  }
  return `fp:${tool}:${spreadsheetId}:${fingerprint}`;
}

export function parseRequestId(args) {
  if (!args || typeof args !== "object") return null;
  const raw = args.request_id;
  if (typeof raw !== "string") return null;
  const t = raw.trim();
  return t.length ? t : null;
}

function pruneExpired(now = Date.now()) {
  for (const [k, v] of cache) {
    if (now - v.storedAt > DEDUPE_TTL_MS) cache.delete(k);
  }
  while (cache.size > DEDUPE_MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    cache.delete(oldest);
  }
}

/**
 * @param {string} key
 * @returns {object|null} cached MCP tool response, or null
 */
export function lookupDedupe(key) {
  pruneExpired();
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.storedAt > DEDUPE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  // Refresh LRU order
  cache.delete(key);
  cache.set(key, hit);
  return hit.response;
}

/**
 * @param {string} key
 * @param {object} response MCP CallTool result (must not be isError)
 */
export function storeDedupe(key, response) {
  if (!response || response.isError) return;
  pruneExpired();
  if (cache.has(key)) cache.delete(key);
  cache.set(key, { storedAt: Date.now(), response: structuredCloneSafe(response) });
  pruneExpired();
}

function structuredCloneSafe(obj) {
  try {
    return structuredClone(obj);
  } catch {
    return JSON.parse(JSON.stringify(obj));
  }
}

/**
 * Mark a cached response so agents/logs can see the dedupe hit.
 * @param {object} response
 */
export function annotateDedupedResponse(response) {
  const clone = structuredCloneSafe(response);
  const block = clone?.content?.[0];
  if (!block || typeof block.text !== "string") {
    return clone;
  }
  const text = block.text;
  const trimmed = text.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        parsed.deduped = true;
        parsed.dedupe_note =
          "Identical write within TTL — no second Sheets API call (Claude Desktop false-timeout defense).";
        block.text = JSON.stringify(parsed, null, 2);
        return clone;
      }
    } catch {
      // fall through to text suffix
    }
  }
  block.text = `${text}\n[deduped=true] Identical write within TTL — no second Sheets API call.`;
  return clone;
}

/**
 * @param {Record<string, unknown>} fields
 */
export function logWriteEvent(event, fields) {
  const parts = Object.entries(fields)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`);
  console.error(`[${event}] ${parts.join(" ")}`);
}

/**
 * Run a write with optional dedupe + start/complete logs.
 * @param {object} opts
 * @param {string} opts.tool
 * @param {string} opts.spreadsheetId
 * @param {object} opts.args
 * @param {unknown} opts.fingerprintPayload — canonicalized for hash (excludes request_id)
 * @param {() => Promise<object>} opts.run — returns MCP tool response
 * @param {boolean} [opts.skipDedupe=false] — e.g. update_where dry_run
 */
export async function withWriteDedupe({
  tool,
  spreadsheetId,
  args,
  fingerprintPayload,
  run,
  skipDedupe = false,
}) {
  const t0 = performance.now();
  const requestId = parseRequestId(args);
  const fingerprint = sha256Hex(canonicalJson(fingerprintPayload));
  const fpShort = shortFp(fingerprint);
  const chars = estimatePayloadChars(fingerprintPayload);
  const key = buildDedupeKey({ tool, spreadsheetId, requestId, fingerprint });

  logWriteEvent("WRITE_START", {
    tool,
    spreadsheetId,
    request_id: requestId || "-",
    fp: fpShort,
    chars,
    dedupe: skipDedupe ? "skip" : "on",
  });

  if (!skipDedupe) {
    const cached = lookupDedupe(key);
    if (cached) {
      const ms = Math.round(performance.now() - t0);
      logWriteEvent("WRITE_DONE", {
        tool,
        spreadsheetId,
        request_id: requestId || "-",
        fp: fpShort,
        chars,
        status: "deduped_hit",
        ms,
      });
      return annotateDedupedResponse(cached);
    }
  }

  try {
    const response = await run();
    const ms = Math.round(performance.now() - t0);
    if (!skipDedupe && response && !response.isError) {
      storeDedupe(key, response);
    }
    logWriteEvent("WRITE_DONE", {
      tool,
      spreadsheetId,
      request_id: requestId || "-",
      fp: fpShort,
      chars,
      status: response?.isError ? "tool_error" : "ok",
      ms,
    });
    return response;
  } catch (err) {
    const ms = Math.round(performance.now() - t0);
    logWriteEvent("WRITE_DONE", {
      tool,
      spreadsheetId,
      request_id: requestId || "-",
      fp: fpShort,
      chars,
      status: "error",
      ms,
      err: err?.message || String(err),
    });
    throw err;
  }
}

/** Test helpers */
export function _resetDedupeForTests() {
  cache.clear();
}

export function _dedupeSizeForTests() {
  return cache.size;
}
