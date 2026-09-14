# Skill gotcha proposal — `google-sheets` SKILL.md (Claude Desktop sync)

> Cursor must **not** edit the skill cache. The Claude Desktop session should
> write this block back into the `google-sheets` skill (gotcha table + short mechanics note).

## New gotcha table rows

| Problem | Solution |
|---|---|
| Claude Desktop `insert_rows` / write tool: "No result after waiting **4 minutes**" — the write may **still succeed** mid-flight (DEV-TODO 32, 2026-07-25; Anthropic [#44032](https://github.com/anthropics/claude-code/issues/44032), [#80012](https://github.com/anthropics/claude-code/issues/80012)) | **Not** Sheets API slowness (empirical: 1–5k characters <6 s). Hard client timeout / MCP Apps bridge orphan (`oncalltool handler replaced`). **Do NOT blind retry.** CONFIRM first (`query_sheet` / `read_sheet`). If the next call also times out → stop; user restarts MCP/Desktop. Optional `request_id` or identical payload → server ~5 min TTL dedupe (second response without another API write). STDERR: `[WRITE_START]` / `[WRITE_DONE]` for correlation |
| `insert_rows` "atomic batchUpdate" | **Not atomic** (since 2026-07-18): `insertDimension` + `values.update` (+ hybrid). Skill text must not claim the opposite |

## Mechanics supplement (short)

Write tools (`write_sheet`, `append_rows`, `insert_rows`, `update_where`) support the optional `request_id` field. A repeat within ~5 minutes with the same key (or bit-identical payload fingerprint) returns the previous successful response with `deduped: true` — guards against naive Claude Desktop retry after a false timeout.

Decision tree after timeout:

1. CONFIRM the target cell / row.
2. If present → do not write again.
3. If missing + server responds → write (preferably with the same `request_id`).
4. If server does not respond → user restart, then back to step 1.
