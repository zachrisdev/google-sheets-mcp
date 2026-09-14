/**
 * Load sheets token from sibling gateway config (gitignored).
 * Override with env SHEETS_MCP_TOKEN.
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function getSheetsToken() {
  if (process.env.SHEETS_MCP_TOKEN) return process.env.SHEETS_MCP_TOKEN;

  const configPath = path.resolve(
    __dirname,
    "..",
    "..",
    "mcp-http-gateway",
    "config.json"
  );
  if (!fs.existsSync(configPath)) {
    throw new Error(
      `Missing ${configPath} (or set SHEETS_MCP_TOKEN). Copy config.example.json in mcp-http-gateway.`
    );
  }
  const cfg = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const token = cfg?.services?.sheets?.token;
  if (!token) throw new Error(`services.sheets.token missing in ${configPath}`);
  return token;
}
