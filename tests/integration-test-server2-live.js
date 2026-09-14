/**
 * Gateway v2 integration test — live host.
 *
 * Requires env MCP_TEST_BASE (origin only), e.g. https://example.com
 * Prerequisite: mcp-http-gateway v2 running behind that host
 * Run: MCP_TEST_BASE=https://example.com node tests/integration-test-server2-live.js
 */

import { runAllTests } from "./integration-test-server2-common.js";
import { getSheetsToken } from "./gateway-token.js";

const origin = (process.env.MCP_TEST_BASE || "").replace(/\/$/, "");
if (!origin) {
  console.error("MCP_TEST_BASE is required (e.g. https://example.com)");
  process.exit(1);
}

const TOKEN = getSheetsToken();

runAllTests({
  baseUrl: `${origin}/mcp/v2/sheets/${TOKEN}`,
  label: "live",
});
