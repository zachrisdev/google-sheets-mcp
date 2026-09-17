/**
 * Pure helpers for update_where operations (set / replace) — DEV-TODO 64.
 * No Sheets API calls; unit-testable without credentials.
 */

import {
  formatForeignDecimalTextError,
  isForeignDecimalTextNumeric,
} from "./type-guards.js";

export const MAX_CELL_CHARS = 50_000;
export const MAX_OCCURRENCES_PER_CALL = 500;
export const SNIPPET_RADIUS = 40;

/**
 * @param {unknown} raw
 * @returns {boolean}
 */
export function parseAllowFormula(raw) {
  return raw === true || raw === "true";
}

/**
 * Normalize + validate operations[]. Hard-break: callers must not pass legacy top-level set.
 * @param {unknown} raw
 * @returns {Array<object>}
 */
export function normalizeOperations(raw) {
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw);
    } catch (e) {
      throw new Error(`Failed to parse 'operations' string as JSON: ${e.message}`);
    }
  }
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error("'operations' must contain at least one ColumnOp (minItems: 1).");
  }

  return raw.map((entry, i) => {
    const path = `operations[${i}]`;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`${path} must be an object with op discriminator`);
    }
    const op = entry.op;
    if (op !== "set" && op !== "replace") {
      throw new Error(
        `${path}: unknown or missing op ${JSON.stringify(op)} (expected "set" | "replace")`
      );
    }

    const col = entry.column;
    if (typeof col !== "string" || !col.trim()) {
      throw new Error(`${path}.column is required (column letter)`);
    }
    const column = col.trim().toUpperCase();

    if (op === "set") {
      if (Object.prototype.hasOwnProperty.call(entry, "find") || Object.prototype.hasOwnProperty.call(entry, "replace")) {
        throw new Error(`${path}: op "set" must not include find/replace`);
      }
      if (!Object.prototype.hasOwnProperty.call(entry, "value")) {
        throw new Error(`${path}: op "set" requires value`);
      }
      const t = typeof entry.value;
      if (t !== "string" && t !== "number" && t !== "boolean") {
        throw new Error(`${path}.value must be string|number|boolean`);
      }
      // Reject unknown keys beyond op/column/value
      for (const k of Object.keys(entry)) {
        if (!["op", "column", "value"].includes(k)) {
          throw new Error(`${path}: unknown key "${k}" for op set`);
        }
      }
      return { op: "set", column, value: entry.value };
    }

    // replace
    if (Object.prototype.hasOwnProperty.call(entry, "value")) {
      throw new Error(`${path}: op "replace" must not include value`);
    }
    if (typeof entry.find !== "string" || entry.find.length === 0) {
      throw new Error(`${path}: op "replace" requires non-empty string find`);
    }
    if (typeof entry.replace !== "string") {
      throw new Error(`${path}: op "replace" requires string replace (may be empty)`);
    }
    let replaceAll = true;
    if (entry.replace_all !== undefined) {
      if (typeof entry.replace_all !== "boolean") {
        throw new Error(`${path}.replace_all must be boolean`);
      }
      replaceAll = entry.replace_all;
    }
    for (const k of Object.keys(entry)) {
      if (!["op", "column", "find", "replace", "replace_all"].includes(k)) {
        throw new Error(`${path}: unknown key "${k}" for op replace`);
      }
    }
    return {
      op: "replace",
      column,
      find: entry.find,
      replace: entry.replace,
      replace_all: replaceAll,
    };
  });
}

/**
 * Reject legacy top-level `set` when present alongside/instead of operations.
 * @param {object} args
 */
export function assertNoLegacySetParam(args) {
  if (args && Object.prototype.hasOwnProperty.call(args, "set") && args.set !== undefined) {
    throw new Error(
      "update_where: hard break — top-level 'set' was removed. " +
        'Use operations: [{ op: "set", column, value }] or [{ op: "replace", column, find, replace }]. ' +
        "Re-attach the MCP connector if the client still offers the old schema."
    );
  }
}

/**
 * Replace target cell must be string or empty. null/undefined/missing → "".
 * @param {unknown} raw
 * @param {string} [path]
 * @returns {string}
 */
export function cellTextForReplace(raw, path = "cell") {
  if (raw === null || raw === undefined || raw === "") return "";
  if (typeof raw === "string") return raw;
  throw new Error(
    `op:replace requires a string (or empty) cell at ${path}; got ${typeof raw} ` +
      `(number/boolean/date-serial targets are refused — use op:set for full overwrite)`
  );
}

/**
 * Literal in-cell replace. Non-overlapping occurrence count.
 * @param {string} cellText
 * @param {string} find
 * @param {string} replace
 * @param {boolean} [replaceAll=true]
 * @returns {{ text: string, occurrences: number }}
 */
export function applyReplace(cellText, find, replace, replaceAll = true) {
  if (typeof find !== "string" || find.length === 0) {
    throw new Error("op:replace find must be a non-empty string");
  }
  if (typeof replace !== "string") {
    throw new Error("op:replace replace must be a string");
  }
  const text = String(cellText ?? "");
  if (!text.includes(find)) {
    return { text, occurrences: 0 };
  }

  let occurrences = 0;
  let idx = 0;
  while ((idx = text.indexOf(find, idx)) !== -1) {
    occurrences++;
    idx += find.length;
  }

  if (replaceAll) {
    return { text: text.split(find).join(replace), occurrences };
  }
  const i = text.indexOf(find);
  return {
    text: text.slice(0, i) + replace + text.slice(i + find.length),
    occurrences: 1,
  };
}

/**
 * @param {string} text
 * @param {string} find
 * @param {number} [radius]
 * @returns {{ before: string, match: string, after: string, startIndex: number } | null}
 */
export function snippetAround(text, find, radius = SNIPPET_RADIUS) {
  const i = String(text).indexOf(find);
  if (i < 0) return null;
  const start = Math.max(0, i - radius);
  const end = Math.min(text.length, i + find.length + radius);
  return {
    before: text.slice(start, i),
    match: find,
    after: text.slice(i + find.length, end),
    startIndex: i,
  };
}

/**
 * @param {unknown} finalText
 * @param {{ allowFormula?: boolean, path?: string }} [opts]
 */
export function assertNoLeadingFormulaChars(finalText, opts = {}) {
  if (opts.allowFormula === true) return;
  if (typeof finalText !== "string" || finalText.length === 0) return;
  const c = finalText[0];
  if (c === "=" || c === "+" || c === "-" || c === "@") {
    const path = opts.path || "value";
    throw new Error(
      `Rejected leading formula character ${JSON.stringify(c)} at ${path}. ` +
        `Pass allow_formula:true for intentional formulas, or use write_sheet / hybrid cells.`
    );
  }
}

/**
 * Fail-fast on op:set values that are foreign-decimal text numerics.
 * @param {Array<{ op: string, column?: string, value?: unknown }>} operations
 * @param {{ allow?: boolean, toolName?: string, locale?: string }} [opts]
 */
export function assertNoForeignDecimalInSetOps(operations, opts = {}) {
  const allow = opts.allow === true;
  const toolName = opts.toolName || "update_where";
  const locale = opts.locale || "hu_HU";
  if (allow) return;
  if (!Array.isArray(operations)) return;

  for (let i = 0; i < operations.length; i++) {
    const entry = operations[i];
    if (!entry || entry.op !== "set") continue;
    const v = entry.value;
    if (isForeignDecimalTextNumeric(v, locale)) {
      const col = entry.column != null ? String(entry.column).toUpperCase() : "?";
      throw new Error(
        formatForeignDecimalTextError(toolName, `operations[${i}] set ${col}`, String(v), locale)
      );
    }
  }
}

/**
 * 1C: guard final cell text only when the *entire* trimmed string is foreign-decimal.
 * @param {unknown} finalText
 * @param {{ allow?: boolean, toolName?: string, locale?: string, path?: string }} [opts]
 */
export function assertNoForeignDecimalFinalCell(finalText, opts = {}) {
  const allow = opts.allow === true;
  const toolName = opts.toolName || "update_where";
  const locale = opts.locale || "hu_HU";
  if (allow) return;
  if (!isForeignDecimalTextNumeric(finalText, locale)) return;
  throw new Error(
    formatForeignDecimalTextError(
      toolName,
      opts.path || "final cell",
      String(finalText),
      locale
    )
  );
}

/**
 * @param {string} text
 */
export function assertCellSizeLimit(text, path = "cell") {
  if (typeof text === "string" && text.length > MAX_CELL_CHARS) {
    throw new Error(
      `${path}: cell text length ${text.length} exceeds max ${MAX_CELL_CHARS}`
    );
  }
}

/**
 * @param {number} total
 */
export function assertOccurrenceBudget(total) {
  if (total > MAX_OCCURRENCES_PER_CALL) {
    throw new Error(
      `Refused: ${total} replace occurrence(s) exceed max ${MAX_OCCURRENCES_PER_CALL} per call`
    );
  }
}

/**
 * Whether a grid cell (from includeGridData) has textFormatRuns.
 * @param {object|undefined|null} cellData
 * @returns {boolean}
 */
export function cellHasTextFormatRuns(cellData) {
  const runs = cellData?.textFormatRuns;
  return Array.isArray(runs) && runs.length > 0;
}
