# Skill gotcha proposal — `google-sheets` (+ `portfolio-sheet-write`) SKILL.md

> Cursor must **not** edit the skill cache. The Claude Desktop session should
> write these blocks back into the skills (gotcha table + `update_where` mechanics).

## Breaking change — connector re-attach (FIRST)

| Problem | Solution |
|---|---|
| After deploy, Claude Desktop / Claude.ai still offers top-level `update_where.set` and rejects or mis-calls the new `operations` schema (DEV-TODO 64, 2026-09-17) | **Hard break:** `set` removed. Use `operations: [{ op:"set", column, value }]` or `{ op:"replace", column, find, replace }`. **Settings → Connectors → disconnect/reconnect** the Sheets MCP (local + remote) so the client refreshes the tool schema. If the client still sends `set`, the server returns an explicit hard-break error. |

## New / updated gotcha table rows

| Problem | Solution |
|---|---|
| Long `Alertek!J` (1–3k chars) cosmetic typo needed full-cell rewrite via `set` / `write_sheet` (token cost, truncation risk) | Prefer `operations: [{ op:"replace", column:"J", find:"…", replace:"…" }]` with `dry_run` + `expected_match_count` + `expected_occurrence_count`. CONFIRM via `query_sheet`, not header-shifted `read_sheet`. |
| `op:replace` on a number / date-serial cell | Refused — replace is string/empty only. Use `op:"set"` for full overwrite. |
| Target cell has `textFormatRuns` (rich text) | **Refused** in v1 (plain path). Formatting-preserving replace is a separate backlog TODO. |
| Want `=SUM(...)` via `update_where` | Pass `allow_formula: true`, or use `write_sheet` / hybrid cells. Default refuses leading `= + - @`. |
| Final cell becomes exactly `"29.3"` on `hu_HU` after replace/set | Same decimal guard as writes — pass JSON number or `allow_text_numerics:true`. Long text containing `29.3` as substring is OK. |
| Replace on a column where some where-matched cells are numbers/dates | Refused for the whole call (type check before find). Narrow `where` to string rows first. |
| Two ops on the same column in one `operations` array | Not a pipeline: each replace sees the **original** cell; write last-wins. Prefer one op per column. |

## Mechanics supplement (under `update_where`)

**API:** `where` + `operations[]` (not `set`).  
**set:** full overwrite. **replace:** literal find/replace; `replace_all` default true; no regex.  
**Safety:** `dry_run` (snippets ±40), `expected_match_count`, `expected_occurrence_count` (= applied replacements), `limit`.  
**Replace-only match count:** rows among where-matches that contain `find`.

## `portfolio-sheet-write` note

Long J / H / AA cosmetic fixes: **prefer `op:replace` first**; full rewrite only when rewriting content intentionally.
