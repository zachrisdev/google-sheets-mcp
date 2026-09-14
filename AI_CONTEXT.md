# AI_CONTEXT.md — Google Sheets MCP

Project notes for future AI sessions. Keep this file English and free of personal domains / spreadsheet IDs.

## Overview

Model Context Protocol (MCP) server exposing the Google Sheets API to Claude (local Desktop/IDE and remote Claude.ai via HTTP gateway).

### Layout

```
├── auth.js            — OAuth2 login (run once)
├── index.js           — MCP server (stdio + createMcpServer())
├── type-guards.js     — locale-aware foreign-decimal text numeric guard
├── credentials.json   — Google OAuth client (DO NOT commit)
├── token.json         — OAuth token (DO NOT commit)
├── package.json
└── tests/             — unit + gateway integration + smoke
```

**Remote HTTP:** sibling [`../mcp-http-gateway`](../mcp-http-gateway) — stdio spawn bridge (v1 SSE / v2 Streamable HTTP).

### Tools

| Tool | Description |
|------|-------------|
| `read_sheet` | Read sheet content (URL or ID) |
| `write_sheet` | Overwrite cells in a range |
| `append_rows` | Append rows at the end |
| `insert_rows` | Insert at 0-based `startIndex` (UI Insert row). Optional fill via `values.update` + `USER_ENTERED` |
| `get_sheet_info` | Metadata (tab names, dimensions) |
| `clear_range` | Clear a range |
| `query_sheet` | SQLite `SELECT` on a tab via Sheets API → ephemeral sql.js. Columns A, B, C…; table = tab name (`FROM` optional) |
| `update_where` | Filter + update in one server call (`where` + `set`). Options: `dry_run`, `limit`, `expected_match_count` |

## Run modes

### 1. Local (Claude Desktop / IDE)

`index.js` on stdio (`command: node index.js`).

### 2. Network (Claude.ai)

Gateway spawns `index.js` per session on stdio and exposes HTTP.

URLs (replace host + token):

- SSE v1: `https://YOUR_DOMAIN/mcp/v1/sheets/{token}`
- Streamable v2: `https://YOUR_DOMAIN/mcp/v2/sheets/{token}`

See `mcp-http-gateway/README.md` (`pm2`: `mcp-gateway-v1` / `mcp-gateway-v2`).

## Testing

### Gateway v2 (Streamable HTTP)

Shared logic: [`tests/integration-test-server2-common.js`](./tests/integration-test-server2-common.js)

Creates a temporary spreadsheet (`google-sheets-mcp_TEST_<timestamp>`, locale `hu_HU`), runs write/query/insert tests, deletes the sheet. **Does not use production spreadsheets.**

```bash
# Local — gateway server-v2.js on port 3302
npm run test:integration:local

# Live — set origin (no default host)
MCP_TEST_BASE=https://YOUR_DOMAIN npm run test:integration:live
```

Unit tests (no credentials):

```bash
npm run test:unit
```

### Gateway v1 SSE smoke

```bash
MCP_TEST_BASE=https://YOUR_DOMAIN node tests/integration-test.js
```

Creates a temp sheet, runs `query_sheet`, deletes it.

### SQL smoke (OAuth)

```bash
npm run test:smoke:sql
```

Temp sheet + in-process sql.js WHERE/COUNT.

### Meta-repo remote smoke (v2)

From the MCP meta root:

```powershell
.\scripts\smoke-v2.ps1 -BaseUrl https://YOUR_DOMAIN
```

Needs sheets OAuth + gateway `config.json`. Creates temp sheet → gateway tools → delete.

## Technical notes

### 1. Stdio isolation (gateway)

MCP SDK `Server` handles one transport at a time. Gateway spawns a new stdio child per session.

### 2. No `express.json()` on v1 POST `/message`

`handlePostMessage()` needs the raw stream.

### 3. Auth token in URL path

Nginx must not embed the token; gateway checks `config.json` timing-safe. Token should be URL-safe.

### 4. Nginx SSE

`proxy_buffering off` is required for SSE. Prefer not logging URLs that contain tokens.

### 5. `query_sheet` (no GViz)

GViz `/gviz/tq` respects UI `basicFilter` / hidden rows → silent false negatives. Production path:

1. `spreadsheets.values.get` (`UNFORMATTED_VALUE`) — same source as `update_where`
2. Ephemeral in-memory sql.js

Schema: table = tab name; columns = A, B, C…; `FROM` optional; `contains` → `LIKE`.

### 5b. Why `update_where`

`query_sheet` does not return physical row indices. `update_where` reads → filters → writes in one call. Sheets API has no true transactions; use `expected_match_count`, `limit`, `dry_run`.

### 6. Locale-aware decimal text guard

On write tools, the server reads `spreadsheets.get` → `properties.locale` (cached per process by spreadsheet ID).

- Spreadsheet decimal separator from `Intl.NumberFormat(locale).formatToParts(1.1)`
- If separator is `,` (e.g. `hu_HU`): reject `"29.3"` / `".5"` text (would become TEXT under `USER_ENTERED`)
- If separator is `.` (e.g. `en_US`): reject `"29,3"` / `",5"` symmetrically
- Escape hatch: `allow_text_numerics: true`
- Prefer JSON numbers

Integration temp sheets are created with `locale: "hu_HU"` so point-reject regressions stay stable.

Audit (no hardcoded spreadsheet IDs):

```bash
npm run audit:text-numerics -- --spreadsheet-id=ID [--tab=Sheet1] [--apply]
```

### 7. Write dedupe

Optional `request_id` on write tools; see `write-dedupe.js`.

## Security

- Never commit `credentials.json` / `token.json` / gateway `config.json`
- Gateway tokens are secrets in the URL path — treat logs carefully
