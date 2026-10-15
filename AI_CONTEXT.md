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
| `update_where` | Filter + column ops (`where` + `operations`). Ops: `set` (overwrite) \| `replace` (literal in-cell). Options: `dry_run`, `limit`, `expected_match_count`, `expected_occurrence_count`, `allow_formula`. Rich-text cells refused. |

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
2. Parallel `values.get` with the same `UNFORMATTED_VALUE` plus `dateTimeRenderOption=FORMATTED_STRING` (DATE/TIME/DATE_TIME/DURATION → string; number/currency/percent stay numeric) — builds the date column mask
3. Ephemeral in-memory sql.js

Schema: table = tab name; columns = A, B, C…; `FROM` optional; `contains` → `LIKE`.

**`col_types` (DEV-078):** from the format mask + SELECT-expression classification — not from “value looks like a Sheets serial (30000–60000)”. Bare columns and `MIN`/`MAX`(col) inherit the column’s date-ness (incl. `AS` alias); every other expression (`SUM`/`AVG`/`COUNT`/arithmetic/functions) is never `date`. Mixed columns (any plain number beside a date-formatted cell) → `number` (raw serials, no false ISO). TIME/DURATION also hit the date mask in v1 (separate type is backlog). Without the formatted matrix (unit/smoke 4-arg calls) a load-time serial heuristic remains — pure HUF columns in-range can still look like `date`; production `query_sheet` always passes the formatted matrix.

### 5b. Why `update_where`

`query_sheet` does not return physical row indices. `update_where` reads → filters → applies `operations` in one call. Sheets API has no true transactions; use `expected_match_count`, `expected_occurrence_count`, `limit`, `dry_run`.

**Hard break (DEV-TODO 64):** top-level `set` removed. Use `operations: [{ op: "set", column, value }]` or `{ op: "replace", column, find, replace }`. After deploy: **re-attach the MCP connector** (Desktop / Claude.ai) so the client schema refreshes.

### 5c. `update_where` date/datetime `where` values (DEV-TODO 38)

Cells arrive as Sheets serials (`UNFORMATTED_VALUE`). Where values may be:

- ISO date `YYYY-MM-DD` → that day **00:00** UTC serial
- ISO datetime `YYYY-MM-DD HH:MM[:SS]` or `T` separator → fractional serial
- numeric serial (e.g. `46240`) — unchanged

Comparison is numeric on serials (exact). Day-range: `gte` day + `lt` next day. A date-looking but unparseable value throws (no silent `matched_rows: 0`).

### 5d. `update_where` operations / replace (DEV-TODO 64)

- `op:"set"` — full cell overwrite (`column` + `value`).
- `op:"replace"` — literal in-cell find/replace (`find` minLength 1, `replace` may be empty, `replace_all` default true). **No regex.**
- Replace targets must be **string or empty**; number / boolean / date-serial → explicit error (checked on every where-matched row for that column, even if `find` is absent — narrow `where` first).
- Cells with `textFormatRuns` → **refused** (plain `values.batchUpdate` only; formatting support is a separate backlog).
- Decimal guard: foreign-decimal text on `set` values **and** on final cell text when the **entire** trimmed cell matches (not substrings in long context).
- Leading `= + - @` on set value / post-replace text → refused unless `allow_formula: true`.
- `dry_run` preview includes replace snippets (±40 chars) and `occurrence_count` (= **applied** replacements; with `replace_all:false` at most 1 per cell).
- Replace-only: `expected_match_count` / `limit` apply to rows that **contain** `find` (among where matches).
- **Same column, multiple ops in one call:** not a pipeline. Each `replace` reads the **original** cell; write Map is last-wins per `column+row`. Prefer one op per column per call.

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

## Sibling PMon repo — marketdata / S&P 500 TR DB (post-reorg)

This MCP stack (`zachrisdev/mcp-stack` / `google-sheets-mcp`) is a **separate git repo**. PMon’s `.gitignore` excludes `MCP/`. The relocation commit `e97f7db` lives in the **PMon** repo, not here. Paths below are relative to the PMon checkout when that sibling tree is available. Do **not** use the old path `data/sp500_tr_db`.

Coverage / gap status (873/1097, missing crisis names, paid next steps): see PMon `marketdata/equities/sp500_tr_db/out/SUMMARY_10_lines.md` — do not guess from chat memory.

### Paths (PMon repo root)

| What | Path |
|------|------|
| S&P 500 monthly TR DB | `marketdata/equities/sp500_tr_db/` |
| Builder + fetchers | `…/build_db.py`, `…/fetch_*.py` |
| Git-tracked outputs | `…/out/*.csv`, `…/out/*.md` (incl. `prices_monthly.csv`) |
| Local-only (gitignored) | `…/raw/`, `…/cache/` |
| Release registry | `marketdata/releases.json`, `marketdata/MANIFEST.sha256.txt` |
| Release tooling | `marketdata/tools/releases.py` |
| Trim backtest (BEF-151) | `backtests/trim_bef151/` (reads `marketdata/equities/sp500_tr_db/out/`) |
| Details | `marketdata/README.md` |

Depth: `sp500_tr_db` is **three** levels below the PMon repo root (`marketdata/equities/sp500_tr_db`). Secret file resolution in `build_db.py` / `fetch_*.py`:

```text
ROOT.parents[2] / "secrets" / "exth_api_keys.env"
```

If that folder depth changes, update the parent index in those five scripts.

### Environment after move / clone

The project `.venv` may still hold Windows absolute paths from the old location. Before any Python run in that folder:

```powershell
cd marketdata\equities\sp500_tr_db
uv sync
```

Then use `uv run python …` (or the refreshed `.venv`).

### Git hygiene (PMon)

- **Never** `git add -A` in PMon: `secrets/` and `plans/` are untracked on purpose. Always stage **explicit paths**.
- After editing `.gitignore` or other text files on a Windows checkout, check `git diff --stat`. An unexpectedly large diff often means CRLF/LF line-ending churn (seen when git ran from a VM rewritten every line).

### Git vs GitHub Releases (PMon)

| Tracked in git | Not in git (GitHub Releases) |
|----------------|------------------------------|
| Code, `uv.lock`, `out/*.csv` / `out/*.md`, `releases.json`, `MANIFEST.sha256.txt` | `raw/`, `cache/` (nested + root `.gitignore`) |

- One release asset per source (tags listed in `marketdata/releases.json`).
- Run `package` / `publish` on the **Windows host** with authenticated `gh` (not over a network/mounted drive — large-tree zips are very slow there). From PMon repo root:  
  `python marketdata/tools/releases.py package --only <tag>`  
  then `publish --only <tag>`, then commit the updated `MANIFEST.sha256.txt` with an **explicit** `git add` path.
- New source → new row in `releases.json` first. Full workflow: `marketdata/README.md`.

### Diagnostics scripts

Former `cache/_diag_*.py` files are ignored with `cache/`. If they must be versioned, move them to a tracked folder such as `marketdata/equities/sp500_tr_db/diag/` (not under `cache/`).

### Contract for consumers (do not break casually)

`backtests/trim_bef151/` depends on `out/prices_monthly.csv`, `out/benchmark.csv`, `out/membership.csv` **column names and formats**. Do not rename/reshape those without coordinating; if you must change them, call it out explicitly in the session handoff.
