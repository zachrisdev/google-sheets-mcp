/**
 * Optional OAuth smoke: temp spreadsheet + sql.js WHERE/COUNT (needs token.json).
 * node tests/smoke-sql.js
 */
import { executeSheetSqlQuery } from "../index.js";
import {
  createTempSpreadsheet,
  deleteTempSpreadsheet,
  seedTempSpreadsheet,
} from "./temp-spreadsheet.js";

const FIXTURE = [
  ["Ticker", "Type", "Value"],
  ["AMZN", "AR_TARGET", 10],
  ["AMZN", "AR_STOP", 20],
  ["AAPL", "AR_TARGET", 30],
];

let spreadsheetId = null;

try {
  const created = await createTempSpreadsheet({
    locale: "hu_HU",
    sheetName: "Alerts",
    log: (m) => console.log(m),
  });
  spreadsheetId = created.spreadsheetId;
  const sheetName = created.sheetName;
  await seedTempSpreadsheet(spreadsheetId, sheetName, FIXTURE, {
    log: (m) => console.log(m),
  });

  const where = await executeSheetSqlQuery(FIXTURE, 1, sheetName, "SELECT C WHERE C = 'AMZN'");
  const agg = await executeSheetSqlQuery(
    FIXTURE,
    1,
    sheetName,
    "SELECT C, COUNT(*) AS n WHERE C = 'AMZN' GROUP BY C"
  );

  console.log(
    JSON.stringify(
      { where_matched: where.matched_rows, agg_rows: agg.rows, agg_matched: agg.matched_rows },
      null,
      2
    )
  );

  if (where.matched_rows < 1) {
    throw new Error("FAIL: expected AMZN rows >= 1");
  }
  if (agg.rows?.[0]?.[1] !== where.matched_rows) {
    throw new Error("FAIL: COUNT mismatch");
  }
  console.log("SMOKE OK");
  process.exitCode = 0;
} catch (err) {
  if (String(err.message || err).includes("Missing") && String(err.message || err).includes("token.json")) {
    console.log("SKIP: no token.json");
    process.exitCode = 0;
  } else {
    console.error(err.message || err);
    process.exitCode = 1;
  }
} finally {
  if (spreadsheetId) {
    await deleteTempSpreadsheet(spreadsheetId, { log: (m) => console.log(m) });
  }
  process.exit(process.exitCode ?? 0);
}
