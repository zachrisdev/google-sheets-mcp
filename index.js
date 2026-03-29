#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { google } from "googleapis";
import fs from "fs";
import path from "path";
import readline from "readline";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CREDENTIALS_PATH = path.join(__dirname, "credentials.json");
const TOKEN_PATH = path.join(__dirname, "token.json");

// Auth setup
async function getAuth() {
  const credentials = JSON.parse(fs.readFileSync(CREDENTIALS_PATH));
  const { client_id, client_secret, redirect_uris } = credentials.installed;
  const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);

  if (fs.existsSync(TOKEN_PATH)) {
    const token = JSON.parse(fs.readFileSync(TOKEN_PATH));
    oAuth2Client.setCredentials(token);
  oAuth2Client.on('tokens', (tokens) => {
    const current = JSON.parse(fs.readFileSync(TOKEN_PATH));
    fs.writeFileSync(TOKEN_PATH, JSON.stringify({ ...current, ...tokens }));
  });
  return oAuth2Client;
  }
  return getNewToken(oAuth2Client);
}

async function getNewToken(oAuth2Client) {
  const authUrl = oAuth2Client.generateAuthUrl({
    access_type: "offline",
    scope: [
      "https://www.googleapis.com/auth/spreadsheets",
      "https://www.googleapis.com/auth/drive.readonly",
    ],
  });
  console.error("Authorize this app by visiting:", authUrl);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve, reject) => {
    rl.question("Enter the code from that page here: ", async (code) => {
      rl.close();
      const { tokens } = await oAuth2Client.getToken(code);
      oAuth2Client.setCredentials(tokens);
      fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens));
      console.error("Token stored to", TOKEN_PATH);
      resolve(oAuth2Client);
    });
  });
}

// Extract sheet ID from URL or use directly
function extractSheetId(urlOrId) {
  const match = urlOrId.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  return match ? match[1] : urlOrId;
}

// MCP Server
const server = new Server(
  { name: "google-sheets-mcp", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "read_sheet",
      description: "Read data from a Google Sheet. Accepts full URL or sheet ID.",
      inputSchema: {
        type: "object",
        properties: {
          url_or_id: { type: "string", description: "Google Sheet URL or ID" },
          range: { type: "string", description: "A1 notation range (e.g. Sheet1!A1:Z100). Defaults to all data." },
        },
        required: ["url_or_id"],
      },
    },
    {
      name: "write_sheet",
      description: "Write or update data in a Google Sheet.",
      inputSchema: {
        type: "object",
        properties: {
          url_or_id: { type: "string", description: "Google Sheet URL or ID" },
          range: { type: "string", description: "A1 notation range to write to (e.g. Sheet1!A1)" },
          values: { type: "array", description: "2D array of values to write", items: { type: "array" } },
        },
        required: ["url_or_id", "range", "values"],
      },
    },
    {
      name: "append_rows",
      description: "Append new rows to a Google Sheet.",
      inputSchema: {
        type: "object",
        properties: {
          url_or_id: { type: "string", description: "Google Sheet URL or ID" },
          range: { type: "string", description: "Sheet name or range (e.g. Sheet1)" },
          values: { type: "array", description: "2D array of rows to append", items: { type: "array" } },
        },
        required: ["url_or_id", "range", "values"],
      },
    },
    {
      name: "get_sheet_info",
      description: "Get metadata about a spreadsheet — sheet names, row counts, etc.",
      inputSchema: {
        type: "object",
        properties: {
          url_or_id: { type: "string", description: "Google Sheet URL or ID" },
        },
        required: ["url_or_id"],
      },
    },
    {
      name: "clear_range",
      description: "Clear a range of cells in a Google Sheet.",
      inputSchema: {
        type: "object",
        properties: {
          url_or_id: { type: "string", description: "Google Sheet URL or ID" },
          range: { type: "string", description: "A1 notation range to clear" },
        },
        required: ["url_or_id", "range"],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const auth = await getAuth();
  const sheets = google.sheets({ version: "v4", auth });
  const { name, arguments: args } = request.params;
  const spreadsheetId = extractSheetId(args.url_or_id);

  try {
    if (name === "read_sheet") {
      const range = args.range || "A1:ZZ10000";
      const res = await sheets.spreadsheets.values.get({ spreadsheetId, range });
      return {
        content: [{ type: "text", text: JSON.stringify(res.data.values || [], null, 2) }],
      };
    }

    if (name === "write_sheet") {
      await sheets.spreadsheets.values.update({
        spreadsheetId,
        range: args.range,
        valueInputOption: "USER_ENTERED",
        requestBody: { values: args.values },
      });
      return { content: [{ type: "text", text: `Successfully written to ${args.range}` }] };
    }

    if (name === "append_rows") {
      await sheets.spreadsheets.values.append({
        spreadsheetId,
        range: args.range,
        valueInputOption: "USER_ENTERED",
        requestBody: { values: args.values },
      });
      return { content: [{ type: "text", text: `Successfully appended ${args.values.length} rows` }] };
    }

    if (name === "get_sheet_info") {
      const res = await sheets.spreadsheets.get({ spreadsheetId });
      const info = res.data.sheets.map((s) => ({
        title: s.properties.title,
        rows: s.properties.gridProperties.rowCount,
        cols: s.properties.gridProperties.columnCount,
      }));
      return { content: [{ type: "text", text: JSON.stringify(info, null, 2) }] };
    }

    if (name === "clear_range") {
      await sheets.spreadsheets.values.clear({ spreadsheetId, range: args.range });
      return { content: [{ type: "text", text: `Cleared range ${args.range}` }] };
    }
  } catch (err) {
    return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
  }
});

// Start server
const transport = new StdioServerTransport();
await server.connect(transport);

