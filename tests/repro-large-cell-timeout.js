/**
 * DEV-TODO 32 repro: long cell value + insert_rows timing / success.
 *
 * Does not use a production spreadsheet. Creates → measures → deletes.
 *
 *   node tests/repro-large-cell-timeout.js
 */

import { google } from "googleapis";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createHash } from "crypto";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.join(__dirname, "..");
const CREDENTIALS_PATH = path.join(PROJECT_ROOT, "credentials.json");
const TOKEN_PATH = path.join(PROJECT_ROOT, "token.json");

const SIZES = [1000, 1500, 2100, 2500, 3000, 3300, 3400, 5000];
const LARGE_GRID_ROWS = 1200;

function log(msg) {
  console.log(msg);
}

function ms(t0) {
  return Math.round(performance.now() - t0);
}

async function getAuth() {
  const credentials = JSON.parse(fs.readFileSync(CREDENTIALS_PATH));
  const { client_id, client_secret, redirect_uris } = credentials.installed;
  const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);
  if (!fs.existsSync(TOKEN_PATH)) throw new Error("token.json missing — run npm run auth");
  oAuth2Client.setCredentials(JSON.parse(fs.readFileSync(TOKEN_PATH)));
  return oAuth2Client;
}

function makePayload(n) {
  // Realistic EventLog-like text: newlines + quotes (parseValuesArg stress).
  const seed =
    'PROBLEM: `insert_rows` "timeout" — but the write is NOT deterministic.\n' +
    "CASE A / CASE B. Keywords: PM, NKE, PLD.\n";
  let s = "";
  while (s.length < n) s += seed;
  return s.slice(0, n);
}

function rowFor(marker, body) {
  return [
    "2026-09-08 23:20",
    "DEV",
    "REPRO",
    marker,
    body,
    "✅",
  ];
}

async function createTemp(sheets) {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  const title = `google-sheets-mcp_REPRO32_${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  log(`▶ Creating: ${title}`);
  const res = await sheets.spreadsheets.create({
    requestBody: {
      properties: { title },
      sheets: [
        { properties: { title: "EventLog" } },
        { properties: { title: "LargeGrid" } },
        { properties: { title: "WriteTest" } },
      ],
    },
  });
  const spreadsheetId = res.data.spreadsheetId;
  const tabs = Object.fromEntries(
    (res.data.sheets || []).map((s) => [s.properties.title, s.properties.sheetId])
  );
  log(`✓ id=${spreadsheetId}`);
  return { spreadsheetId, tabs };
}

async function deleteTemp(spreadsheetId) {
  const auth = await getAuth();
  const drive = google.drive({ version: "v3", auth });
  try {
    await drive.files.delete({ fileId: spreadsheetId });
    log(`✓ Deleted ${spreadsheetId}`);
  } catch (err) {
    try {
      await drive.files.update({ fileId: spreadsheetId, requestBody: { trashed: true } });
      log(`⚠ Trash instead of delete: ${err.message}`);
    } catch (err2) {
      console.warn(`⚠ Cleanup failed: ${err2.message}`);
    }
  }
}

/** Mirror index.js insert_rows: get → insertDimension → values.update (no hybrid). */
async function timedInsertRows(sheets, spreadsheetId, sheetName, sheetId, startIndex, values) {
  const steps = {};
  let t = performance.now();
  await sheets.spreadsheets.get({
    spreadsheetId,
    fields: "sheets.properties(sheetId,title)",
  });
  steps.get_ms = ms(t);

  t = performance.now();
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [
        {
          insertDimension: {
            range: {
              sheetId,
              dimension: "ROWS",
              startIndex,
              endIndex: startIndex + values.length,
            },
            inheritFromBefore: false,
          },
        },
      ],
    },
  });
  steps.insertDimension_ms = ms(t);

  t = performance.now();
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${sheetName}!A${startIndex + 1}`,
    valueInputOption: "USER_ENTERED",
    requestBody: { values },
  });
  steps.valuesUpdate_ms = ms(t);

  steps.total_ms = steps.get_ms + steps.insertDimension_ms + steps.valuesUpdate_ms;
  return steps;
}

async function timedAppend(sheets, spreadsheetId, sheetName, values) {
  const t = performance.now();
  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: sheetName,
    valueInputOption: "USER_ENTERED",
    requestBody: { values },
  });
  return { total_ms: ms(t) };
}

async function timedWrite(sheets, spreadsheetId, range, values) {
  const t = performance.now();
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range,
    valueInputOption: "USER_ENTERED",
    requestBody: { values },
  });
  return { total_ms: ms(t) };
}

async function timedUpdateWhereLike(sheets, spreadsheetId, sheetName, matchMarker, newBody) {
  // Minimal update_where analogue: read A:E, find marker in D, write E.
  const tRead = performance.now();
  const read = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${sheetName}!A:E`,
    valueRenderOption: "UNFORMATTED_VALUE",
  });
  const read_ms = ms(tRead);
  const rows = read.data.values || [];
  let physicalRow = -1; // 1-based
  for (let i = 0; i < rows.length; i++) {
    if (rows[i][3] === matchMarker) {
      physicalRow = i + 1;
      break;
    }
  }
  if (physicalRow < 0) throw new Error(`marker not found: ${matchMarker}`);
  const tWrite = performance.now();
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${sheetName}!E${physicalRow}`,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [[newBody]] },
  });
  return { read_ms, write_ms: ms(tWrite), total_ms: read_ms + ms(tWrite), row: physicalRow };
}

async function seedHeader(sheets, spreadsheetId, sheetName) {
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${sheetName}!A1`,
    valueInputOption: "USER_ENTERED",
    requestBody: {
      values: [["Date", "Type", "Ticker", "Short", "Detailed reason", "Status"]],
    },
  });
}

async function padGrid(sheets, spreadsheetId, sheetId, targetRows) {
  // Ensure grid has targetRows so insertDimension shifts a large block.
  const meta = await sheets.spreadsheets.get({
    spreadsheetId,
    fields: "sheets.properties(sheetId,gridProperties)",
  });
  const props = (meta.data.sheets || []).find((s) => s.properties.sheetId === sheetId)?.properties;
  const current = props?.gridProperties?.rowCount ?? 1000;
  if (current >= targetRows) return current;
  const t = performance.now();
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [
        {
          appendDimension: {
            sheetId,
            dimension: "ROWS",
            length: targetRows - current,
          },
        },
      ],
    },
  });
  log(`  padded LargeGrid ${current} → ${targetRows} (+${ms(t)} ms)`);
  return targetRows;
}

async function verifyRow(sheets, spreadsheetId, sheetName, marker, expectedLen) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${sheetName}!A2:E2`,
    valueRenderOption: "UNFORMATTED_VALUE",
  });
  const row = res.data.values?.[0];
  if (!row) return { found: false };
  const body = String(row[4] ?? "");
  return {
    found: row[3] === marker,
    bodyLen: body.length,
    bodyLenOk: body.length === expectedLen,
    endsOk: body.endsWith(makePayload(expectedLen).slice(-20)),
  };
}

function printTable(rows) {
  const cols = Object.keys(rows[0] || {});
  const widths = cols.map((c) => Math.max(c.length, ...rows.map((r) => String(r[c]).length)));
  const line = (vals) => vals.map((v, i) => String(v).padEnd(widths[i])).join("  ");
  log("\n" + line(cols));
  log(widths.map((w) => "-".repeat(w)).join("  "));
  for (const r of rows) log(line(cols.map((c) => r[c])));
}

async function main() {
  const auth = await getAuth();
  const sheets = google.sheets({ version: "v4", auth });
  let spreadsheetId;
  const results = [];
  const pathResults = [];

  try {
    const created = await createTemp(sheets);
    spreadsheetId = created.spreadsheetId;
    const eventLogId = created.tabs["EventLog"];
    const largeId = created.tabs["LargeGrid"];

    await seedHeader(sheets, spreadsheetId, "EventLog");
    await seedHeader(sheets, spreadsheetId, "LargeGrid");
    await seedHeader(sheets, spreadsheetId, "WriteTest");
    // Seed one row for update_where-like tests
    await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: "WriteTest",
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [rowFor("SEED", "seed")] },
    });

    log("\n══ Size ladder: insert_rows (below header, small grid) ══");
    for (const n of SIZES) {
      const marker = `INS_${n}`;
      const body = makePayload(n);
      const payloadJsonLen = JSON.stringify([rowFor(marker, body)]).length;
      const hash = createHash("sha256").update(body).digest("hex").slice(0, 8);
      log(`\n→ insert_rows size=${n} json=${payloadJsonLen} hash=${hash}`);
      let steps;
      let err = null;
      try {
        steps = await timedInsertRows(
          sheets,
          spreadsheetId,
          "EventLog",
          eventLogId,
          1,
          [rowFor(marker, body)]
        );
      } catch (e) {
        err = e.message;
        steps = { get_ms: "-", insertDimension_ms: "-", valuesUpdate_ms: "-", total_ms: "-" };
      }
      let verify = { found: false };
      if (!err) {
        verify = await verifyRow(sheets, spreadsheetId, "EventLog", marker, n);
      }
      const row = {
        tool: "insert_rows",
        chars: n,
        json_len: payloadJsonLen,
        get_ms: steps.get_ms,
        insertDim_ms: steps.insertDimension_ms,
        valuesUpd_ms: steps.valuesUpdate_ms,
        total_ms: steps.total_ms,
        wrote: err ? "ERR" : verify.found && verify.bodyLenOk ? "YES" : "PARTIAL",
        body_len: verify.bodyLen ?? "-",
        error: err ? err.slice(0, 60) : "",
      };
      results.push(row);
      log(
        `  get=${steps.get_ms}ms insertDim=${steps.insertDimension_ms}ms update=${steps.valuesUpdate_ms}ms total=${steps.total_ms}ms wrote=${row.wrote}`
      );
    }

    log("\n══ Size ladder: append_rows ══");
    for (const n of [2100, 3300, 5000]) {
      const marker = `APP_${n}`;
      const body = makePayload(n);
      log(`\n→ append_rows size=${n}`);
      let total_ms;
      let err = null;
      try {
        ({ total_ms } = await timedAppend(sheets, spreadsheetId, "EventLog", [
          rowFor(marker, body),
        ]));
      } catch (e) {
        err = e.message;
        total_ms = "-";
      }
      results.push({
        tool: "append_rows",
        chars: n,
        json_len: JSON.stringify([rowFor(marker, body)]).length,
        get_ms: "-",
        insertDim_ms: "-",
        valuesUpd_ms: "-",
        total_ms,
        wrote: err ? "ERR" : "YES*",
        body_len: n,
        error: err ? err.slice(0, 60) : "",
      });
      log(`  total=${total_ms}ms ${err ? "ERR " + err : "ok"}`);
    }

    log("\n══ Size ladder: write_sheet (E2 overwrite) ══");
    for (const n of [2100, 3300, 5000]) {
      const body = makePayload(n);
      log(`\n→ write_sheet size=${n}`);
      let total_ms;
      let err = null;
      try {
        ({ total_ms } = await timedWrite(sheets, spreadsheetId, "WriteTest!E2", [[body]]));
      } catch (e) {
        err = e.message;
        total_ms = "-";
      }
      const check = await sheets.spreadsheets.values.get({
        spreadsheetId,
        range: "WriteTest!E2",
        valueRenderOption: "UNFORMATTED_VALUE",
      });
      const got = String(check.data.values?.[0]?.[0] ?? "");
      results.push({
        tool: "write_sheet",
        chars: n,
        json_len: JSON.stringify([[body]]).length,
        get_ms: "-",
        insertDim_ms: "-",
        valuesUpd_ms: "-",
        total_ms,
        wrote: err ? "ERR" : got.length === n ? "YES" : `LEN ${got.length}`,
        body_len: got.length,
        error: err ? err.slice(0, 60) : "",
      });
      log(`  total=${total_ms}ms wroteLen=${got.length}`);
    }

    log("\n══ Size ladder: update_where-like ══");
    for (const n of [2100, 3300, 5000]) {
      const body = makePayload(n);
      log(`\n→ update_where-like size=${n}`);
      let timing;
      let err = null;
      try {
        timing = await timedUpdateWhereLike(sheets, spreadsheetId, "WriteTest", "SEED", body);
      } catch (e) {
        err = e.message;
        timing = { total_ms: "-", read_ms: "-", write_ms: "-" };
      }
      results.push({
        tool: "update_where~",
        chars: n,
        json_len: n,
        get_ms: timing.read_ms,
        insertDim_ms: "-",
        valuesUpd_ms: timing.write_ms,
        total_ms: timing.total_ms,
        wrote: err ? "ERR" : "YES*",
        body_len: n,
        error: err ? err.slice(0, 60) : "",
      });
      log(`  read=${timing.read_ms}ms write=${timing.write_ms}ms total=${timing.total_ms}ms`);
    }

    log("\n══ Large grid insertDimension stress (1200 rows) ══");
    await padGrid(sheets, spreadsheetId, largeId, LARGE_GRID_ROWS);
    // Fill some cells so shift has content cost
    const filler = [];
    for (let i = 0; i < 50; i++) {
      filler.push(rowFor(`FILL_${i}`, makePayload(200)));
    }
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: "LargeGrid!A2",
      valueInputOption: "USER_ENTERED",
      requestBody: { values: filler },
    });

    for (const n of [1500, 3300, 5000]) {
      const marker = `LG_${n}`;
      const body = makePayload(n);
      log(`\n→ insert_rows on LargeGrid(${LARGE_GRID_ROWS}) size=${n}`);
      const steps = await timedInsertRows(
        sheets,
        spreadsheetId,
        "LargeGrid",
        largeId,
        1,
        [rowFor(marker, body)]
      );
      const verify = await verifyRow(sheets, spreadsheetId, "LargeGrid", marker, n);
      pathResults.push({
        scene: "large_grid",
        chars: n,
        get_ms: steps.get_ms,
        insertDim_ms: steps.insertDimension_ms,
        valuesUpd_ms: steps.valuesUpdate_ms,
        total_ms: steps.total_ms,
        wrote: verify.found && verify.bodyLenOk ? "YES" : "PARTIAL",
      });
      log(
        `  get=${steps.get_ms}ms insertDim=${steps.insertDimension_ms}ms update=${steps.valuesUpdate_ms}ms total=${steps.total_ms}ms wrote=${verify.found && verify.bodyLenOk}`
      );
    }

    // Double-insert identical payload (dedupe motivation)
    log("\n══ Double identical insert (dup risk demo) ══");
    const dupBody = makePayload(3300);
    const dupMarker = "DUP_3300";
    await timedInsertRows(sheets, spreadsheetId, "EventLog", eventLogId, 1, [
      rowFor(dupMarker, dupBody),
    ]);
    await timedInsertRows(sheets, spreadsheetId, "EventLog", eventLogId, 1, [
      rowFor(dupMarker, dupBody),
    ]);
    const all = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: "EventLog!D:D",
      valueRenderOption: "UNFORMATTED_VALUE",
    });
    const dupCount = (all.data.values || []).filter((r) => r[0] === dupMarker).length;
    log(`  identical insert twice → ${dupCount} rows with marker ${dupMarker}`);

    printTable(results);
    if (pathResults.length) {
      log("\nLarge-grid path:");
      printTable(pathResults);
    }

    log("\n══ SUMMARY ══");
    const maxTotal = Math.max(
      ...results.filter((r) => typeof r.total_ms === "number").map((r) => r.total_ms),
      ...pathResults.map((r) => r.total_ms)
    );
    log(`Max observed API total: ${maxTotal} ms`);
    log(
      maxTotal < 30_000
        ? "Sheets API path is FAST (<< 4 min). Timeout is likely CLIENT/host ack loss or MCP process crash — not Google API wall time."
        : "Sheets API path is SLOW enough to approach client timeouts."
    );
    log(`Duplicate demo: ${dupCount} identical rows after naive retry.`);
    log(`\nSpreadsheet (deleted next): ${spreadsheetId}`);
  } finally {
    if (spreadsheetId) await deleteTemp(spreadsheetId);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
