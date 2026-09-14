/**
 * Shared temp Google Spreadsheet lifecycle for integration / smoke tests.
 * Requires credentials.json + token.json in the google-sheets-mcp root.
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { google } from "googleapis";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.join(__dirname, "..");
const CREDENTIALS_PATH = path.join(PROJECT_ROOT, "credentials.json");
const TOKEN_PATH = path.join(PROJECT_ROOT, "token.json");

export async function getGoogleAuth() {
  if (!fs.existsSync(CREDENTIALS_PATH)) {
    throw new Error(`Missing ${CREDENTIALS_PATH}`);
  }
  if (!fs.existsSync(TOKEN_PATH)) {
    throw new Error(`Missing ${TOKEN_PATH} — run 'npm run auth' first`);
  }
  const credentials = JSON.parse(fs.readFileSync(CREDENTIALS_PATH));
  const { client_id, client_secret, redirect_uris } = credentials.installed;
  const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);
  oAuth2Client.setCredentials(JSON.parse(fs.readFileSync(TOKEN_PATH)));
  return oAuth2Client;
}

function testSheetTitle() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  const ts = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  return `google-sheets-mcp_TEST_${ts}`;
}

/**
 * @param {{ locale?: string, title?: string, sheetName?: string, log?: (msg: string) => void }} [opts]
 */
export async function createTempSpreadsheet(opts = {}) {
  const log = opts.log || (() => {});
  const auth = await getGoogleAuth();
  const sheets = google.sheets({ version: "v4", auth });
  const title = opts.title || testSheetTitle();
  const sheetName = opts.sheetName || "Sheet1";
  const locale = opts.locale || "hu_HU";
  log(`▶ Creating temp spreadsheet: ${title} (locale=${locale})`);
  const res = await sheets.spreadsheets.create({
    requestBody: {
      properties: { title, locale },
      sheets: [{ properties: { title: sheetName } }],
    },
  });
  const spreadsheetId = res.data.spreadsheetId;
  const resolvedName = res.data.sheets?.[0]?.properties?.title ?? sheetName;
  log(`✓ Created: ${spreadsheetId} (tab: ${resolvedName})`);
  return { spreadsheetId, sheetName: resolvedName, sheets, auth };
}

/**
 * Seed a simple header + data row for smoke queries.
 * @param {string} spreadsheetId
 * @param {string} sheetName
 * @param {unknown[][]} [values]
 * @param {{ log?: (msg: string) => void }} [opts]
 */
export async function seedTempSpreadsheet(spreadsheetId, sheetName, values, opts = {}) {
  const log = opts.log || (() => {});
  const auth = await getGoogleAuth();
  const sheets = google.sheets({ version: "v4", auth });
  const grid = values || [
    ["Ticker", "Type", "Value"],
    ["AAPL", "SMOKE", 1],
  ];
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${sheetName}!A1`,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: grid },
  });
  log(`✓ Seeded ${grid.length} row(s) on ${sheetName}`);
}

/**
 * @param {string} spreadsheetId
 * @param {{ log?: (msg: string) => void }} [opts]
 */
export async function deleteTempSpreadsheet(spreadsheetId, opts = {}) {
  if (!spreadsheetId) return;
  const log = opts.log || (() => {});
  const auth = await getGoogleAuth();
  const drive = google.drive({ version: "v3", auth });
  log(`▶ Deleting temp spreadsheet: ${spreadsheetId}`);
  try {
    await drive.files.delete({ fileId: spreadsheetId });
    log(`✓ Deleted: ${spreadsheetId}`);
  } catch (err) {
    try {
      await drive.files.update({ fileId: spreadsheetId, requestBody: { trashed: true } });
      log(`⚠ Delete failed (${err.message}), moved to trash instead`);
    } catch (err2) {
      console.warn(`⚠ Could not delete spreadsheet ${spreadsheetId}: ${err2.message}`);
      console.warn("  Manual cleanup may be required.");
    }
  }
}
