/**
 * Gateway v2 integration test — localhost (port 3302)
 *
 * Prerequisite: mcp-http-gateway `node server-v2.js`
 * Run: node tests/integration-test-server2-local.js
 */

import { runAllTests } from "./integration-test-server2-common.js";
import { getSheetsToken } from "./gateway-token.js";

const TOKEN = getSheetsToken();

runAllTests({
  baseUrl: `http://localhost:3302/mcp/v2/sheets/${TOKEN}`,
  label: "localhost:3302",
});
