# Google Sheets MCP

A [Model Context Protocol (MCP)](https://modelcontextprotocol.io) server that gives Claude (and other MCP clients) read/write access to any Google Sheet via OAuth.

## Tools

| Tool | Description |
|------|-------------|
| `read_sheet` | Read data from any range in a spreadsheet |
| `write_sheet` | Write or update data in a spreadsheet |
| `append_rows` | Append new rows to a spreadsheet |
| `insert_rows` | Insert rows at a 0-based index |
| `get_sheet_info` | Get sheet names, row counts, and column counts |
| `clear_range` | Clear a range of cells |
| `query_sheet` | SQLite `SELECT` on a tab (Sheets API → ephemeral sql.js). Cols A/B/C…; `FROM` optional. Aggregations OK. Ignores UI basicFilter. |
| `update_where` | Filter + update rows in one call (no row indices) |

All tools accept a full Google Sheets URL **or** a bare spreadsheet ID.

**Decimal text guard:** write tools reject strings that use the *foreign* decimal separator for the spreadsheet’s locale (e.g. `"29.3"` on `hu_HU`, `"29,3"` on `en_US` under USER_ENTERED → TEXT). Locale comes from `spreadsheets.properties.locale` (cached). Pass a JSON number, or set `allow_text_numerics: true`. See `type-guards.js`.

**Write dedupe (DEV-TODO 32):** optional `request_id` on write tools; identical payload / same id within ~5 min returns prior success without a second Sheets write. stderr: `[WRITE_START]` / `[WRITE_DONE]`. See `write-dedupe.js` and `docs/SKILL_GOTCHA_DEVTODO32.md`.

### query_sheet notes

- Data source: `spreadsheets.values.get` (same as `update_where`) — **not** GViz `/gviz/tq` (GViz respected UI filters → silent false negatives).
- Engine: in-memory sql.js per call. Table name = tab name; columns = `A`, `B`, `C`…
- Examples: `SELECT C, COUNT(*) WHERE C = 'AMZN' GROUP BY C`; `SELECT * WHERE C = 'AXON' ORDER BY A DESC LIMIT 20`

### Tests

```bash
npm run test:unit                  # includes sql.js + filter-safety + text-numerics
npm run test:integration:local     # needs mcp-http-gateway v2 on :3302 + token.json
MCP_TEST_BASE=https://YOUR_DOMAIN npm run test:integration:live
npm run test:smoke:sql             # temp sheet + sql.js (needs token.json)
npm run audit:text-numerics -- --spreadsheet-id=ID   # dry-run; add --apply to fix
```

---

## Prerequisites

- Node.js 18+
- A Google account
- A Google Cloud project (free)

---

## Setup

### 1. Clone the repo

```bash
git clone https://github.com/generalist-club/google-sheets-mcp.git
cd google-sheets-mcp
npm install
```

### 2. Create a Google Cloud project & OAuth credentials

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project (or select an existing one)
3. Enable the **Google Sheets API** and **Google Drive API**:
   - Navigate to **APIs & Services → Library**
   - Search for and enable both APIs
4. Create OAuth credentials:
   - Navigate to **APIs & Services → Credentials**
   - Click **Create Credentials → OAuth client ID**
   - Application type: **Desktop app**
   - Download the JSON file
5. Rename the downloaded file to `credentials.json` and place it in the project root

### 3. Authenticate

Run the auth script to generate your token:

```bash
node auth.js
```

It will print a URL. Open it in your browser, authorize the app, then paste the code back into the terminal. This creates a `token.json` file locally — keep it secret.

> **Token refresh:** The server automatically refreshes the access token when it expires. You should only need to run `auth.js` once.

### 4. Configure Claude Desktop (or any MCP client)

Add this server to your Claude Desktop config at `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "google-sheets": {
      "command": "node",
      "args": ["/absolute/path/to/google-sheets-mcp/index.js"]
    }
  }
}
```

Replace `/absolute/path/to/google-sheets-mcp` with the actual path on your machine.

Restart Claude Desktop. The five Google Sheets tools will now be available.

---

## Usage examples

Once connected, you can ask Claude things like:

- "Read the data from this spreadsheet: `https://docs.google.com/spreadsheets/d/...`"
- "Append a new row with today's date and 42 to Sheet1"
- "What sheets are in this workbook and how many rows does each have?"
- "Clear the range B2:D10 in my spreadsheet"

---

## Security notes

- `credentials.json` and `token.json` are excluded from git via `.gitignore` — never commit them
- The OAuth token is stored locally and only grants access to your own Google account
- Scopes requested: `spreadsheets` (read/write) and `drive.readonly` (to resolve sheet metadata)

---

## License

MIT
