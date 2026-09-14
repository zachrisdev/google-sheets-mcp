/**
 * Guard against text numerics that USER_ENTERED stores as TEXT because the
 * decimal separator does not match the spreadsheet locale (silent MAXIFS/SUMIFS failures).
 *
 * Pattern (after trim): digits + separator + fraction, OR leading-separator fraction.
 * Trailing-separator labels like "29." / "29," are allowed (may be serial/label text).
 */

export const DOT_DECIMAL_TEXT_RE = /^-?(?:\d+\.\d+|\.\d+)$/;
export const COMMA_DECIMAL_TEXT_RE = /^-?(?:\d+,\d+|,\d+)$/;

/** @type {Map<string, string>} */
const localeCache = new Map();

/**
 * Google Sheets uses underscores (hu_HU); Intl expects BCP 47 (hu-HU).
 * @param {string} [locale]
 * @returns {string}
 */
export function normalizeLocaleTag(locale) {
  if (!locale || typeof locale !== "string") return "en-US";
  return locale.replace(/_/g, "-");
}

/**
 * @param {string} [locale]
 * @returns {string} "." or ","
 */
export function decimalSeparatorForLocale(locale) {
  try {
    const parts = new Intl.NumberFormat(normalizeLocaleTag(locale)).formatToParts(1.1);
    return parts.find((p) => p.type === "decimal")?.value || ".";
  } catch {
    return ".";
  }
}

/**
 * @param {import("googleapis").sheets_v4.Sheets} sheets
 * @param {string} spreadsheetId
 * @returns {Promise<string>}
 */
export async function getSpreadsheetLocale(sheets, spreadsheetId) {
  if (localeCache.has(spreadsheetId)) {
    return localeCache.get(spreadsheetId);
  }
  const res = await sheets.spreadsheets.get({
    spreadsheetId,
    fields: "properties.locale",
  });
  const locale = res.data.properties?.locale || "en_US";
  localeCache.set(spreadsheetId, locale);
  return locale;
}

/** Test / process reset helper. */
export function clearSpreadsheetLocaleCache() {
  localeCache.clear();
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
export function isDotDecimalTextNumeric(value) {
  if (typeof value !== "string") return false;
  const t = value.trim();
  if (t === "" || t.startsWith("=")) return false;
  return DOT_DECIMAL_TEXT_RE.test(t);
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
export function isCommaDecimalTextNumeric(value) {
  if (typeof value !== "string") return false;
  const t = value.trim();
  if (t === "" || t.startsWith("=")) return false;
  return COMMA_DECIMAL_TEXT_RE.test(t);
}

/**
 * True when `value` is a text numeric using the *foreign* decimal separator
 * for this spreadsheet locale (would become TEXT under USER_ENTERED).
 * @param {unknown} value
 * @param {string} [locale]
 * @returns {boolean}
 */
export function isForeignDecimalTextNumeric(value, locale) {
  const sep = decimalSeparatorForLocale(locale);
  return sep === "," ? isDotDecimalTextNumeric(value) : isCommaDecimalTextNumeric(value);
}

/**
 * @param {unknown} raw
 * @returns {number|null}
 */
export function suggestedNumberFromDotDecimalText(raw) {
  if (!isDotDecimalTextNumeric(raw)) return null;
  const n = Number(String(raw).trim());
  return Number.isFinite(n) ? n : null;
}

/**
 * @param {unknown} raw
 * @returns {number|null}
 */
export function suggestedNumberFromCommaDecimalText(raw) {
  if (!isCommaDecimalTextNumeric(raw)) return null;
  const n = Number(String(raw).trim().replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

/**
 * @param {unknown} raw
 * @param {string} [locale]
 * @returns {number|null}
 */
export function suggestedNumberFromForeignDecimalText(raw, locale) {
  const sep = decimalSeparatorForLocale(locale);
  return sep === ","
    ? suggestedNumberFromDotDecimalText(raw)
    : suggestedNumberFromCommaDecimalText(raw);
}

/**
 * @param {string} toolName
 * @param {string} path
 * @param {string} raw
 * @param {string} [locale]
 * @returns {string}
 */
export function formatForeignDecimalTextError(toolName, path, raw, locale) {
  const loc = locale || "unknown";
  const sheetSep = decimalSeparatorForLocale(locale);
  const suggested = suggestedNumberFromForeignDecimalText(raw, locale);
  const numHint = suggested !== null ? String(suggested) : "29.3";
  const localeHint =
    suggested !== null
      ? String(suggested).replace(".", sheetSep)
      : sheetSep === ","
        ? "29,3"
        : "29.3";
  const foreignSep = sheetSep === "," ? "point" : "comma";
  return (
    `${toolName}: rejected decimal-${foreignSep} text numeric at ${path}: ${JSON.stringify(raw)}. ` +
    `On locale ${loc} USER_ENTERED would store this as TEXT (looks like a number, breaks MAXIFS/SUMIFS). ` +
    `Pass a JSON number (${numHint}) or locale decimal string ("${localeHint}"), ` +
    `or set allow_text_numerics:true if the text form is intentional.`
  );
}

/** @deprecated Use formatForeignDecimalTextError */
export function formatDotDecimalTextError(toolName, path, raw) {
  return formatForeignDecimalTextError(toolName, path, raw, "hu_HU");
}

/**
 * Fail-fast: first offender throws.
 * @param {unknown[][]} scalarGrid
 * @param {{ allow?: boolean, toolName?: string, locale?: string }} [opts]
 */
export function assertNoDotDecimalTextNumerics(scalarGrid, opts = {}) {
  const allow = opts.allow === true;
  const toolName = opts.toolName || "write";
  const locale = opts.locale || "hu_HU";
  if (allow) return;
  if (!Array.isArray(scalarGrid)) return;

  for (let i = 0; i < scalarGrid.length; i++) {
    const row = scalarGrid[i];
    if (!Array.isArray(row)) continue;
    for (let j = 0; j < row.length; j++) {
      const v = row[j];
      if (isForeignDecimalTextNumeric(v, locale)) {
        throw new Error(
          formatForeignDecimalTextError(toolName, `values[${i}][${j}]`, String(v), locale)
        );
      }
    }
  }
}

/**
 * Fail-fast on update_where set[].value (runs even for dry_run).
 * @param {Array<{ column?: string, value?: unknown }>} set
 * @param {{ allow?: boolean, toolName?: string, locale?: string }} [opts]
 */
export function assertNoDotDecimalTextInSet(set, opts = {}) {
  const allow = opts.allow === true;
  const toolName = opts.toolName || "update_where";
  const locale = opts.locale || "hu_HU";
  if (allow) return;
  if (!Array.isArray(set)) return;

  for (let i = 0; i < set.length; i++) {
    const entry = set[i] || {};
    const v = entry.value;
    if (isForeignDecimalTextNumeric(v, locale)) {
      const col = entry.column != null ? String(entry.column).toUpperCase() : "?";
      throw new Error(
        formatForeignDecimalTextError(toolName, `set[${i}] ${col}`, String(v), locale)
      );
    }
  }
}

/** Shared schema property for ListTools. */
export const ALLOW_TEXT_NUMERICS_PROP = {
  type: "boolean",
  description:
    "If true, allow strings like \"29.3\" / \".5\" or \"29,3\" / \",5\" that would otherwise be rejected when they use the foreign decimal separator for the spreadsheet locale. " +
    "Default false. Prefer a JSON number instead. No silent conversion.",
};

/**
 * @param {unknown} raw
 * @returns {boolean}
 */
export function parseAllowTextNumerics(raw) {
  return raw === true || raw === "true";
}
