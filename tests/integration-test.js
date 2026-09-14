/**
 * Integration test — Google Sheets MCP via gateway SSE v1.
 *
 * Opens a real SSE connection, creates a temp spreadsheet, runs query_sheet, deletes it.
 *
 * Env:
 *   MCP_TEST_BASE  required origin, e.g. https://example.com
 *
 * Run:
 *   MCP_TEST_BASE=https://example.com node tests/integration-test.js
 *
 * Prerequisite: mcp-http-gateway v1 running (pm2: mcp-gateway-v1)
 */

import https from "https";
import http from "http";
import { getSheetsToken } from "./gateway-token.js";
import {
  createTempSpreadsheet,
  deleteTempSpreadsheet,
  seedTempSpreadsheet,
} from "./temp-spreadsheet.js";

const origin = (process.env.MCP_TEST_BASE || "").replace(/\/$/, "");
if (!origin) {
  console.error("MCP_TEST_BASE is required (e.g. https://example.com)");
  process.exit(1);
}

const TOKEN = getSheetsToken();
const transport = origin.startsWith("https") ? https : http;
const TEST_QUERY = "SELECT * LIMIT 5";

let spreadsheetId = null;

async function main() {
  const created = await createTempSpreadsheet({
    locale: "hu_HU",
    log: (m) => console.log(m),
  });
  spreadsheetId = created.spreadsheetId;
  const sheetName = created.sheetName;
  await seedTempSpreadsheet(spreadsheetId, sheetName, undefined, {
    log: (m) => console.log(m),
  });

  const BASE_URL = `${origin}/mcp/v1/sheets/${TOKEN}`;
  console.log("▶ Connecting to SSE endpoint...");
  console.log(`  ${BASE_URL}\n`);

  await new Promise((resolve, reject) => {
    const sseReq = transport.get(BASE_URL, (res) => {
      console.log(`✓ SSE connected — HTTP ${res.statusCode}`);

      let buffer = "";

      res.on("data", (chunk) => {
        buffer += chunk.toString();

        if (!buffer.includes("jsonrpc")) {
          const match = buffer.match(/sessionId=([a-f0-9-]+)/);
          if (!match) return;

          const sessionId = match[1];
          console.log(`✓ Session ID: ${sessionId}`);

          const postBody = JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: {
              name: "query_sheet",
              arguments: {
                url_or_id: spreadsheetId,
                sheet: sheetName,
                query: TEST_QUERY,
              },
            },
          });

          const postUrl = `${BASE_URL}/message?sessionId=${sessionId}`;
          console.log(`▶ query: "${TEST_QUERY}" on ${sheetName}`);

          const postReq = transport.request(
            postUrl,
            {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(postBody),
              },
            },
            (postRes) => {
              let postData = "";
              postRes.on("data", (c) => {
                postData += c;
              });
              postRes.on("end", () => {
                console.log(`✓ POST /message — HTTP ${postRes.statusCode}`);
                if (postData) console.log(postData.slice(0, 500));
              });
            }
          );
          postReq.on("error", reject);
          postReq.write(postBody);
          postReq.end();
          return;
        }

        const lines = buffer.split("\n");
        for (const line of lines) {
          if (line.startsWith("data:")) {
            const payload = line.slice(5).trim();
            if (!payload) continue;
            try {
              const msg = JSON.parse(payload);
              if (msg.id === 1) {
                console.log("✓ query_sheet response:");
                console.log(JSON.stringify(msg, null, 2).slice(0, 800));
                sseReq.destroy();
                resolve();
              }
            } catch {
              /* keep buffering */
            }
          }
        }
      });

      res.on("error", reject);
    });

    sseReq.on("error", reject);
    setTimeout(() => {
      sseReq.destroy();
      reject(new Error("SSE timeout"));
    }, 60000);
  });
}

try {
  await main();
  console.log("\nSMOKE OK");
  process.exitCode = 0;
} catch (err) {
  console.error("\nSMOKE FAILED:", err.message || err);
  process.exitCode = 1;
} finally {
  if (spreadsheetId) {
    await deleteTempSpreadsheet(spreadsheetId, { log: (m) => console.log(m) });
  }
  process.exit(process.exitCode ?? 0);
}
