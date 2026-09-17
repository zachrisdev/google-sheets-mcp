/**
 * Shared column / cell helpers for update_where and query_sheet (sql.js).
 */

export function colLetterToIndex(letter) {
  const s = String(letter).trim().toUpperCase();
  if (!/^[A-Z]+$/.test(s)) throw new Error(`Invalid column letter: ${letter}`);
  let n = 0;
  for (const ch of s) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

export function colIndexToLetter(index) {
  let n = index + 1;
  let s = "";
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

export function coerceNumber(v) {
  if (typeof v === "number") return isNaN(v) ? null : v;
  if (typeof v === "string") {
    const t = v.trim();
    if (t === "") return null;
    const n = Number(t.replace(",", "."));
    return isNaN(n) ? null : n;
  }
  return null;
}

export function formatGvizDate(raw) {
  if (raw === null || raw === undefined || raw === "") return null;
  const m = String(raw)
    .trim()
    .match(/^Date\((\d+),\s*(\d+),\s*(\d+)(?:,\s*(\d+),\s*(\d+),\s*(\d+))?\)$/);
  if (!m) return raw;
  const year = Number(m[1]);
  const month = Number(m[2]) + 1;
  const day = Number(m[3]);
  const pad = (n) => String(n).padStart(2, "0");
  const dateStr = `${year}-${pad(month)}-${pad(day)}`;
  if (m[4] === undefined) return dateStr;
  return `${dateStr} ${pad(Number(m[4]))}:${pad(Number(m[5]))}:${pad(Number(m[6]))}`;
}

export function isSheetsDateSerial(n) {
  return typeof n === "number" && !Number.isNaN(n) && n >= 30000 && n < 60000;
}

const SHEETS_EPOCH_MS = Date.UTC(1899, 11, 30);

/** UTC Y/M/D[/h/mi/s] → Sheets serial (same epoch as formatSheetsSerialDate). */
export function utcPartsToSheetsSerial(year, month0, day, h = 0, mi = 0, s = 0) {
  const ms = Date.UTC(year, month0, day, h, mi, s);
  return (ms - SHEETS_EPOCH_MS) / 86400000;
}

/**
 * True if a string looks like an ISO date/datetime or GViz Date(...) —
 * even when calendar-invalid (e.g. 2026-13-99). Used for fail-fast.
 */
export function looksLikeDateString(v) {
  if (typeof v !== "string") return false;
  const t = v.trim();
  if (!t) return false;
  if (/^Date\(\d+/i.test(t)) return true;
  return /^\d{4}-\d{2}-\d{2}(?:[T ]\d{1,2}:\d{2}(?::\d{2})?)?$/.test(t);
}

/**
 * Coerce a where-value or cell to a Sheets date serial, or null if not dateish.
 * - number in serial range → itself
 * - ISO `YYYY-MM-DD` → that day 00:00 UTC
 * - ISO `YYYY-MM-DD[T ]HH:MM[:SS]` → fractional serial
 * - GViz `Date(y,m,d[,h,mi,s])` (month 0-based)
 */
export function parseDateishToSerial(v) {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "number") {
    return isSheetsDateSerial(v) ? v : null;
  }
  if (typeof v !== "string") return null;
  const t = v.trim();
  if (!t) return null;

  const gviz = t.match(/^Date\((\d+),\s*(\d+),\s*(\d+)(?:,\s*(\d+),\s*(\d+),\s*(\d+))?\)$/);
  if (gviz) {
    const year = Number(gviz[1]);
    const month0 = Number(gviz[2]);
    const day = Number(gviz[3]);
    const h = gviz[4] !== undefined ? Number(gviz[4]) : 0;
    const mi = gviz[5] !== undefined ? Number(gviz[5]) : 0;
    const sec = gviz[6] !== undefined ? Number(gviz[6]) : 0;
    const ms = Date.UTC(year, month0, day, h, mi, sec);
    const d = new Date(ms);
    if (
      d.getUTCFullYear() !== year ||
      d.getUTCMonth() !== month0 ||
      d.getUTCDate() !== day
    ) {
      return null;
    }
    return utcPartsToSheetsSerial(year, month0, day, h, mi, sec);
  }

  const iso = t.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  if (!iso) return null;
  const year = Number(iso[1]);
  const month0 = Number(iso[2]) - 1;
  const day = Number(iso[3]);
  const h = iso[4] !== undefined ? Number(iso[4]) : 0;
  const mi = iso[5] !== undefined ? Number(iso[5]) : 0;
  const sec = iso[6] !== undefined ? Number(iso[6]) : 0;
  const ms = Date.UTC(year, month0, day, h, mi, sec);
  const d = new Date(ms);
  if (
    d.getUTCFullYear() !== year ||
    d.getUTCMonth() !== month0 ||
    d.getUTCDate() !== day ||
    d.getUTCHours() !== h ||
    d.getUTCMinutes() !== mi ||
    d.getUTCSeconds() !== sec
  ) {
    return null;
  }
  return utcPartsToSheetsSerial(year, month0, day, h, mi, sec);
}

export function formatSheetsSerialDate(serial) {
  if (typeof serial !== "number" || Number.isNaN(serial)) return serial;
  const ms = SHEETS_EPOCH_MS + Math.round(serial * 86400000);
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, "0");
  const dateStr = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  const frac = Math.abs(serial % 1);
  if (frac < 1e-10) return dateStr;
  return `${dateStr} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

export function inferQueryColType(values) {
  const nonEmpty = values.filter((v) => v !== null && v !== undefined && v !== "");
  if (nonEmpty.length === 0) return "string";
  if (
    nonEmpty.every(
      (v) =>
        typeof v === "boolean" || v === "TRUE" || v === "FALSE" || v === "true" || v === "false"
    )
  ) {
    return "boolean";
  }
  if (nonEmpty.every((v) => isSheetsDateSerial(v))) {
    return nonEmpty.some((v) => Math.abs(v % 1) >= 1e-10) ? "datetime" : "date";
  }
  if (nonEmpty.every((v) => typeof v === "number" || coerceNumber(v) !== null)) {
    return "number";
  }
  return "string";
}

export function formatQueryCell(raw, colType) {
  if (raw === null || raw === undefined || raw === "") return null;
  if (colType === "date" || colType === "datetime") {
    if (typeof raw === "number") return formatSheetsSerialDate(raw);
    return formatGvizDate(raw);
  }
  if (colType === "number") {
    const n = coerceNumber(raw);
    return n !== null ? n : String(raw);
  }
  if (colType === "boolean") {
    if (raw === true || raw === 1 || raw === "TRUE" || raw === "true") return true;
    if (raw === false || raw === 0 || raw === "FALSE" || raw === "false") return false;
    return raw;
  }
  return raw;
}
