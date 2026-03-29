# Google Sheets MCP

A [Model Context Protocol (MCP)](https://modelcontextprotocol.io) server that gives Claude (and other MCP clients) read/write access to any Google Sheet via OAuth.

## Tools

| Tool | Description |
|------|-------------|
| `read_sheet` | Read data from any range in a spreadsheet |
| `write_sheet` | Write or update data in a spreadsheet |
| `append_rows` | Append new rows to a spreadsheet |
| `get_sheet_info` | Get sheet names, row counts, and column counts |
| `clear_range` | Clear a range of cells |

All tools accept a full Google Sheets URL **or** a bare spreadsheet ID.

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
