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

export function formatSheetsSerialDate(serial) {
  if (typeof serial !== "number" || Number.isNaN(serial)) return serial;
  const epochMs = Date.UTC(1899, 11, 30);
  const ms = epochMs + Math.round(serial * 86400000);
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
