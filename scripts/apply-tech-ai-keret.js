/**
 * One-shot: Stratégiák Tech/AI keret-összesítő (DEV-TODO STRATEGIAK_FUL).
 * - Expand grid + AF column + summary block AH:AK
 * - Data validation AF (0/50/100)
 * - Conditional formatting on utilization % (yellow ≥90%, red ≥100%)
 *
 * Usage: node scripts/apply-tech-ai-keret.js
 */
import { google } from "googleapis";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SS_ID = "1bgH3CQQnv-8uJgQuSh3qVY1Zw4Jw9Af7-jRq-XZhBiE";
const SHEET_NAME = "Stratégiák";

const WEIGHT_100 = new Set([
  "ANET", "META", "AMZN", "MSFT", "GOOGL", "AMD", // MAG
  "VEEV", "CSU", "SHOP", // TECH-ADJACENT 100%
]);
const WEIGHT_50 = new Set([
  "MELI", "AXON", "TCEHY", "ABNB", "MCHP", // TECH-ADJACENT 50%
]);

function authClient() {
  const credentials = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "credentials.json"), "utf8")
  );
  const token = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "token.json"), "utf8")
  );
  const { client_id, client_secret, redirect_uris } = credentials.installed;
  const oAuth2Client = new google.auth.OAuth2(
    client_id,
    client_secret,
    redirect_uris[0]
  );
  oAuth2Client.setCredentials(token);
  return oAuth2Client;
}

function weightFor(ticker) {
  if (!ticker) return null;
  if (WEIGHT_100.has(ticker)) return 100;
  if (WEIGHT_50.has(ticker)) return 50;
  return 0;
}

async function main() {
  const auth = authClient();
  const sheets = google.sheets({ version: "v4", auth });

  const meta = await sheets.spreadsheets.get({
    spreadsheetId: SS_ID,
    fields: "sheets(properties(sheetId,title,gridProperties))",
  });
  const sh = meta.data.sheets.find((s) => s.properties.title === SHEET_NAME);
  if (!sh) throw new Error(`Sheet not found: ${SHEET_NAME}`);
  const sheetId = sh.properties.sheetId;
  const cols = sh.properties.gridProperties.columnCount || 0;
  console.log(`sheetId=${sheetId} cols=${cols}`);

  const requests = [];

  // Need columns through AK (37). Current 31 (A–AE) → add 6.
  if (cols < 37) {
    requests.push({
      appendDimension: {
        sheetId,
        dimension: "COLUMNS",
        length: 37 - cols,
      },
    });
  }

  if (requests.length) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SS_ID,
      requestBody: { requests },
    });
    console.log(`Expanded columns to ≥37`);
  }

  // Read tickers A2:A207
  const tickersRes = await sheets.spreadsheets.values.get({
    spreadsheetId: SS_ID,
    range: `${SHEET_NAME}!A2:A207`,
  });
  const tickers = tickersRes.data.values || [];
  const afValues = tickers.map((row) => {
    const t = (row[0] || "").toString().trim();
    const w = weightFor(t);
    return w === null ? [""] : [w];
  });
  // Pad to at least existing length
  while (afValues.length < tickers.length) afValues.push([""]);

  // Header AF1 + weights
  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: SS_ID,
    requestBody: {
      valueInputOption: "USER_ENTERED",
      data: [
        {
          range: `${SHEET_NAME}!AF1`,
          values: [["Tech/AI-súly %"]],
        },
        {
          range: `${SHEET_NAME}!AF2:AF${1 + afValues.length}`,
          values: afValues,
        },
        {
          // Summary block — top-right of sheet (visible with freeze A)
          range: `${SHEET_NAME}!AH1:AK8`,
          values: [
            ["KERET-ÖSSZESÍTŐ", "Érték (Ft)", "Kihasználtság", "Szabad (Ft)"],
            [
              "Tech/AI (plafon 27M)",
              "=SUMPRODUCT(T2:T207;AF2:AF207/100)",
              "=IF(AI2=\"\";\"\";AI2/27000000)",
              "=27000000-AI2",
            ],
            [
              "Szatellit (plafon 55M)",
              '=SUMPRODUCT((F2:F207="ÉLŐ")*(D2:D207<>"ETF-GERINC")*(D2:D207<>"")*(T2:T207))',
              "=IF(AI3=\"\";\"\";AI3/55000000)",
              "=55000000-AI3",
            ],
            ["", "", "", ""],
            [
              "Forrás: Rules 0.3.1 → AF (0/50/100). Lezárt pozíció T=0 → auto kiesik.",
              "",
              "",
              "",
            ],
            [
              "Sárga ≥90%, piros ≥100% (feltételes formázás AJ2:AJ3).",
              "",
              "",
              "",
            ],
            ["", "", "", ""],
            [
              "Frissítve: 2026-09-23 (STRATEGIAK_FUL DEV-TODO)",
              "",
              "",
              "",
            ],
          ],
        },
      ],
    },
  });
  console.log(`Wrote AF header+${afValues.filter((r) => r[0] !== "").length} weights + summary AH1:AK8`);

  // Formatting + DV + CF
  const existing = await sheets.spreadsheets.get({
    spreadsheetId: SS_ID,
    fields: "sheets(properties(sheetId,title),conditionalFormats)",
  });
  const existingSheet = existing.data.sheets.find(
    (s) => s.properties.sheetId === sheetId
  );
  const existingRules = existingSheet.conditionalFormats || [];
  console.log(`Existing CF rules: ${existingRules.length}`);

  // Rebuild CF: keep existing + add keret rules (avoid dup by clearing only our target ranges if re-run)
  // Safer: append two rules for AJ2 and AJ3. If re-run, may duplicate — delete rules whose ranges are only AJ2/AJ3 first.
  const keptRules = [];
  for (const rule of existingRules) {
    const ranges = rule.ranges || [];
    const onlyKeret = ranges.every(
      (r) =>
        r.sheetId === sheetId &&
        r.startColumnIndex === 35 && // AJ
        r.endColumnIndex === 36 &&
        r.startRowIndex >= 1 &&
        r.endRowIndex <= 3
    );
    if (!onlyKeret) keptRules.push(rule);
  }

  // hu_HU CF: NUMBER_* rejects "0.9"; use CUSTOM_FORMULA with ; separators.
  // Relative formula evaluated per cell in range (AJ2, AJ3).
  const redRule = {
    ranges: [
      {
        sheetId,
        startRowIndex: 1,
        endRowIndex: 3,
        startColumnIndex: 35,
        endColumnIndex: 36,
      },
    ],
    booleanRule: {
      condition: {
        type: "CUSTOM_FORMULA",
        values: [{ userEnteredValue: "=AJ2>=1" }],
      },
      format: { backgroundColor: { red: 0.957, green: 0.78, blue: 0.765 } }, // #f4c7c3
    },
  };
  const yellowRule = {
    ranges: [
      {
        sheetId,
        startRowIndex: 1,
        endRowIndex: 3,
        startColumnIndex: 35,
        endColumnIndex: 36,
      },
    ],
    booleanRule: {
      condition: {
        type: "CUSTOM_FORMULA",
        values: [{ userEnteredValue: "=AJ2>=0,9" }],
      },
      format: { backgroundColor: { red: 1, green: 0.95, blue: 0.6 } }, // #fff2cc-ish
    },
  };

  // Red must be evaluated after yellow for higher threshold — Sheets uses rule order;
  // put red FIRST so it takes precedence when both match? Actually in Sheets, first matching rule wins.
  // So: red (≥100%) first, then yellow (≥90%).
  const newRules = [redRule, yellowRule, ...keptRules.map((r) => {
    // strip read-only fields if any — API wants ConditionalFormatRule without index
    const { ranges, booleanRule, gradientRule } = r;
    const out = { ranges };
    if (booleanRule) out.booleanRule = booleanRule;
    if (gradientRule) out.gradientRule = gradientRule;
    return out;
  })];

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: SS_ID,
    requestBody: {
      requests: [
        {
          updateSheetProperties: {
            properties: {
              sheetId,
              gridProperties: { columnCount: Math.max(cols, 37) },
            },
            fields: "gridProperties.columnCount",
          },
        },
        // Header AF bold + light analyst tint
        {
          repeatCell: {
            range: {
              sheetId,
              startRowIndex: 0,
              endRowIndex: 1,
              startColumnIndex: 31,
              endColumnIndex: 32,
            },
            cell: {
              userEnteredFormat: {
                textFormat: { bold: true },
                backgroundColor: { red: 0.85, green: 0.92, blue: 0.83 },
              },
            },
            fields: "userEnteredFormat(textFormat,backgroundColor)",
          },
        },
        // AF body analyst tint (not formula-gray)
        {
          repeatCell: {
            range: {
              sheetId,
              startRowIndex: 1,
              endRowIndex: 207,
              startColumnIndex: 31,
              endColumnIndex: 32,
            },
            cell: {
              userEnteredFormat: {
                backgroundColor: { red: 0.93, green: 0.97, blue: 0.91 },
                horizontalAlignment: "CENTER",
              },
            },
            fields: "userEnteredFormat(backgroundColor,horizontalAlignment)",
          },
        },
        // Summary header row
        {
          repeatCell: {
            range: {
              sheetId,
              startRowIndex: 0,
              endRowIndex: 1,
              startColumnIndex: 33,
              endColumnIndex: 37,
            },
            cell: {
              userEnteredFormat: {
                textFormat: { bold: true },
                backgroundColor: { red: 1, green: 0.95, blue: 0.8 },
              },
            },
            fields: "userEnteredFormat(textFormat,backgroundColor)",
          },
        },
        // Number formats AI2:AI3 Ft, AJ2:AJ3 %, AK2:AK3 Ft
        {
          repeatCell: {
            range: {
              sheetId,
              startRowIndex: 1,
              endRowIndex: 3,
              startColumnIndex: 34,
              endColumnIndex: 35,
            },
            cell: { userEnteredFormat: { numberFormat: { type: "NUMBER", pattern: "#,##0" } } },
            fields: "userEnteredFormat.numberFormat",
          },
        },
        {
          repeatCell: {
            range: {
              sheetId,
              startRowIndex: 1,
              endRowIndex: 3,
              startColumnIndex: 35,
              endColumnIndex: 36,
            },
            cell: { userEnteredFormat: { numberFormat: { type: "PERCENT", pattern: "0.0%" } } },
            fields: "userEnteredFormat.numberFormat",
          },
        },
        {
          repeatCell: {
            range: {
              sheetId,
              startRowIndex: 1,
              endRowIndex: 3,
              startColumnIndex: 36,
              endColumnIndex: 37,
            },
            cell: { userEnteredFormat: { numberFormat: { type: "NUMBER", pattern: "#,##0" } } },
            fields: "userEnteredFormat.numberFormat",
          },
        },
        // Data validation AF2:AF200
        {
          setDataValidation: {
            range: {
              sheetId,
              startRowIndex: 1,
              endRowIndex: 200,
              startColumnIndex: 31,
              endColumnIndex: 32,
            },
            rule: {
              condition: {
                type: "ONE_OF_LIST",
                values: [
                  { userEnteredValue: "0" },
                  { userEnteredValue: "50" },
                  { userEnteredValue: "100" },
                ],
              },
              showCustomUi: true,
              strict: true,
            },
          },
        },
        // Replace all CF rules (kept + new keret)
        {
          updateSheetProperties: {
            // no-op placeholder — CF via clear+add below
            properties: { sheetId },
            fields: "sheetId",
          },
        },
      ],
    },
  });

  // Conditional format: delete all then re-add.
  // addConditionalFormatRule: { rule, index } — sheetId only inside rule.ranges[].
  function sanitizeRule(rule) {
    const ranges = (rule.ranges || []).map((r) => ({
      sheetId: r.sheetId,
      startRowIndex: r.startRowIndex,
      endRowIndex: r.endRowIndex,
      startColumnIndex: r.startColumnIndex,
      endColumnIndex: r.endColumnIndex,
    }));
    const out = { ranges };
    if (rule.booleanRule) {
      const fmt = rule.booleanRule.format || {};
      const cleanFmt = {};
      if (fmt.backgroundColor) cleanFmt.backgroundColor = fmt.backgroundColor;
      if (fmt.textFormat) cleanFmt.textFormat = fmt.textFormat;
      out.booleanRule = {
        condition: rule.booleanRule.condition,
        format: cleanFmt,
      };
    }
    if (rule.gradientRule) out.gradientRule = rule.gradientRule;
    return out;
  }

  const addOnly = [];
  for (let i = existingRules.length - 1; i >= 0; i--) {
    addOnly.push({ deleteConditionalFormatRule: { sheetId, index: i } });
  }
  newRules.forEach((rule, idx) => {
    addOnly.push({
      addConditionalFormatRule: { rule: sanitizeRule(rule), index: idx },
    });
  });

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: SS_ID,
    requestBody: { requests: addOnly },
  });
  console.log(`CF rules set: ${newRules.length} (red≥100%, yellow≥90% on AJ2:AJ3 + ${keptRules.length} prior)`);

  // Column widths for summary
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: SS_ID,
    requestBody: {
      requests: [
        {
          updateDimensionProperties: {
            range: { sheetId, dimension: "COLUMNS", startIndex: 31, endIndex: 32 },
            properties: { pixelSize: 110 },
            fields: "pixelSize",
          },
        },
        {
          updateDimensionProperties: {
            range: { sheetId, dimension: "COLUMNS", startIndex: 33, endIndex: 34 },
            properties: { pixelSize: 180 },
            fields: "pixelSize",
          },
        },
        {
          updateDimensionProperties: {
            range: { sheetId, dimension: "COLUMNS", startIndex: 34, endIndex: 37 },
            properties: { pixelSize: 120 },
            fields: "pixelSize",
          },
        },
      ],
    },
  });

  // Confirm values
  const confirm = await sheets.spreadsheets.values.get({
    spreadsheetId: SS_ID,
    range: `${SHEET_NAME}!AH1:AK3`,
    valueRenderOption: "FORMATTED_VALUE",
  });
  console.log("CONFIRM summary:");
  console.log(JSON.stringify(confirm.data.values, null, 2));

  const sample = await sheets.spreadsheets.values.get({
    spreadsheetId: SS_ID,
    range: `${SHEET_NAME}!A2:A7`,
  });
  const sampleAf = await sheets.spreadsheets.values.get({
    spreadsheetId: SS_ID,
    range: `${SHEET_NAME}!AF2:AF7`,
  });
  console.log("Sample tickers:", sample.data.values?.flat());
  console.log("Sample AF:", sampleAf.data.values?.flat());
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
