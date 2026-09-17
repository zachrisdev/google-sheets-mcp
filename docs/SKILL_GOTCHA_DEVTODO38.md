# Skill gotcha proposal — `google-sheets` SKILL.md (Claude Desktop sync)

> Cursor must **not** edit the skill cache. The Claude Desktop session should
> write this block back into the `google-sheets` skill (gotcha table + short
> mechanics note under `update_where`).

## New / updated gotcha table rows

| Problem | Solution |
|---|---|
| `update_where` `where` on a date/datetime column with ISO string (`lt`/`gt`/`gte`/`lte`/`eq`) silently matched **0 rows** (DEV-TODO 38, 2026-08-06 MELI/O) | **Fixed (2026-09-17):** server coerces ISO → Sheets serial before compare. Prefer ISO (`YYYY-MM-DD` or `YYYY-MM-DD HH:MM[:SS]`); bare date = that day 00:00. Serial number still OK. Unparseable date-looking value → **explicit error** (not silent zero). Day-equality: use `gte` day + `lt` next day (exact serial `eq` does not match same-calendar-day datetimes). Old workaround (filter ticker/type in `update_where`, check date via `query_sheet`) no longer required for date filters |

## Mechanics supplement (short — under `update_where`)

`where` date/datetime values: ISO string or Sheets serial. Cells are always UNFORMATTED serials internally. Bare `YYYY-MM-DD` normalizes to midnight; relational ops are numeric on serials.
