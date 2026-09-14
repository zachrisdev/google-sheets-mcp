/**
 * Audit a spreadsheet for foreign decimal-separator text numerics
 * (UNFORMATTED_VALUE: string "29.3" vs number 29.3 on comma locales, etc.).
 *
 * Usage:
 *   node scripts/audit-text-numerics.js --spreadsheet-id=ID              # dry-run
 *   node scripts/audit-text-numerics.js --spreadsheet-id=ID --apply      # fix after review
 *   node scripts/audit-text-numerics.js --spreadsheet-id=ID --tab=Sheet1
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { google } from "googleapis";
import {
  DOT_DECIMAL_TEXT_RE,
  COMMA_DECIMAL_TEXT_RE,
  isForeignDecimalTextNumeric,
  suggestedNumberFromForeignDecimalText,
  getSpreadsheetLocale,
  clearSpreadsheetLocaleCache,
  colIndexToLetter,
} from "../index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const TOKEN_PATH = path.join(ROOT, "token.json");
const CREDENTIALS_PATH = path.join(ROOT, "credentials.json");

function parseArgs(argv) {
  const out = { apply: false, spreadsheetId: null, tab: null };
  for (const a of argv) {
    if (a === "--apply") out.apply = true;
    else if (a.startsWith("--spreadsheet-id=")) out.spreadsheetId = a.slice("--spreadsheet-id=".length);
    else if (a.startsWith("--tab=")) out.tab = a.slice("--tab=".length);
  }
  return out;
}

async function getAuth() {
  const credentials = JSON.parse(fs.readFileSync(CREDENTIALS_PATH));
  const { client_id, client_secret, redirect_uris } = credentials.installed;
  const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);
  oAuth2Client.setCredentials(JSON.parse(fs.readFileSync(TOKEN_PATH)));
  return oAuth2Client;
}

function scanGrid(values, locale) {
  const hits = [];
  for (let r = 0; r < values.length; r++) {
    const row = values[r] || [];
    for (let c = 0; c < row.length; c++) {
      const raw = row[c];
      if (!isForeignDecimalTextNumeric(raw, locale)) continue;
      const suggested = suggestedNumberFromForeignDecimalText(raw, locale);
      hits.push({
        a1: `${colIndexToLetter(c)}${r + 1}`,
        raw,
        suggested,
      });
    }
  }
  return hits;
}

async function main() {
  if (!fs.existsSync(TOKEN_PATH)) {
    console.error("Missing token.json — run npm run auth first.");
    process.exit(1);
  }

  const opts = parseArgs(process.argv.slice(2));
  if (!opts.spreadsheetId) {
    console.error(
      "Required: --spreadsheet-id=<id>\n" +
        "Optional: --tab=<tabName>  --apply"
    );
    process.exit(1);
  }

  clearSpreadsheetLocaleCache();
  const auth = await getAuth();
  const sheets = google.sheets({ version: "v4", auth });
  const locale = await getSpreadsheetLocale(sheets, opts.spreadsheetId);
  console.log(`Locale: ${locale}`);

  const meta = await sheets.spreadsheets.get({
    spreadsheetId: opts.spreadsheetId,
    fields: "properties.title,sheets.properties(title)",
  });
  const ssName = meta.data.properties?.title || opts.spreadsheetId;
  let tabs = (meta.data.sheets || []).map((s) => s.properties?.title).filter(Boolean);
  if (opts.tab) {
    tabs = tabs.filter((t) => t === opts.tab);
    if (tabs.length === 0) {
      console.error(`Tab not found: ${opts.tab} in ${ssName}`);
      process.exit(1);
    }
  }

  const allHits = [];

  for (const tab of tabs) {
    const quoted = /['\\]/.test(tab) || /\s/.test(tab) ? `'${tab.replace(/'/g, "''")}'` : tab;
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: opts.spreadsheetId,
      range: `${quoted}!A:ZZ`,
      valueRenderOption: "UNFORMATTED_VALUE",
    });
    const values = res.data.values || [];
    const hits = scanGrid(values, locale);
    for (const h of hits) {
      allHits.push({ spreadsheet: ssName, spreadsheetId: opts.spreadsheetId, tab, ...h });
    }
    console.log(`[scan] ${ssName} / ${tab}: ${hits.length} hit(s)`);
  }

  console.log("\n=== Report ===");
  console.log(`Mode: ${opts.apply ? "APPLY" : "DRY-RUN"}`);
  console.log(`Total hits: ${allHits.length}`);
  console.log(`Dot regex: ${DOT_DECIMAL_TEXT_RE}`);
  console.log(`Comma regex: ${COMMA_DECIMAL_TEXT_RE}`);
  if (allHits.length === 0) {
    console.log("No foreign-decimal text numerics found.");
    return;
  }

  console.log("\nA1 list:");
  for (const h of allHits) {
    console.log(
      `  ${h.spreadsheet} | ${h.tab}!${h.a1} | raw=${JSON.stringify(h.raw)} | suggested=${h.suggested}`
    );
  }

  if (!opts.apply) {
    console.log("\nDry-run only. Re-run with --apply to write JSON numbers.");
    return;
  }

  const bySs = new Map();
  for (const h of allHits) {
    if (h.suggested === null) {
      console.warn(`SKIP (no suggested number): ${h.tab}!${h.a1} raw=${JSON.stringify(h.raw)}`);
      continue;
    }
    if (!bySs.has(h.spreadsheetId)) bySs.set(h.spreadsheetId, []);
    const quoted = /['\\]/.test(h.tab) || /\s/.test(h.tab) ? `'${h.tab.replace(/'/g, "''")}'` : h.tab;
    bySs.get(h.spreadsheetId).push({
      range: `${quoted}!${h.a1}`,
      values: [[h.suggested]],
    });
  }

  for (const [spreadsheetId, data] of bySs) {
    for (let i = 0; i < data.length; i += 100) {
      const chunk = data.slice(i, i + 100);
      await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId,
        requestBody: { valueInputOption: "USER_ENTERED", data: chunk },
      });
    }
    console.log(`Wrote ${data.length} cell(s) to ${spreadsheetId}`);
  }

  const sample = allHits.filter((h) => h.suggested !== null).slice(0, 5);
  console.log("\n=== CONFIRM sample ===");
  for (const h of sample) {
    const quoted = /['\\]/.test(h.tab) || /\s/.test(h.tab) ? `'${h.tab.replace(/'/g, "''")}'` : h.tab;
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: h.spreadsheetId,
      range: `${quoted}!${h.a1}`,
      valueRenderOption: "UNFORMATTED_VALUE",
    });
    const got = res.data.values?.[0]?.[0];
    const ok = typeof got === "number" && Math.abs(got - h.suggested) < 1e-9;
    console.log(
      `  ${h.tab}!${h.a1}: now=${JSON.stringify(got)} (${typeof got}) ${ok ? "OK" : "FAIL"}`
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
