import "dotenv/config";
import pg from "pg";
import { buildDailyOperationSummaries, getAIOperationsReport } from "../src/services/ai-operations.js";

const { Pool } = pg;

function pickDate(v) {
  if (!v) return null;
  if (typeof v === "string") return v.slice(0, 10);
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).slice(0, 10);
}

function printJson(title, data) {
  console.log(`\n${title}`);
  console.log(JSON.stringify(data, null, 2));
}

async function main() {
  const url = process.env.DATABASE_URL || "";
  const masked = url.replace(/:\/\/([^:]+):([^@]+)@/, "://$1:***@");
  console.log("DATABASE_URL_SET:", Boolean(url));
  console.log("DATABASE_URL_MASKED:", masked || "(empty)");

  const pool = new Pool({ connectionString: url || undefined });

  const targetTables = ["daily_reports", "schedules", "feishu_generic_records"];
  const t = await pool.query(
    `SELECT table_name
     FROM information_schema.tables
     WHERE table_schema='public' AND table_name = ANY($1::text[])
     ORDER BY table_name`,
    [targetTables]
  );
  const found = new Set(t.rows.map((r) => r.table_name));

  const tableStatus = [];
  for (const tableName of targetTables) {
    if (!found.has(tableName)) {
      tableStatus.push({ table: tableName, exists: false, count: 0 });
      continue;
    }
    const c = await pool.query(`SELECT COUNT(*)::int AS c FROM ${tableName}`);
    tableStatus.push({ table: tableName, exists: true, count: c.rows[0].c });
  }

  const dayRows = await pool.query(
    `SELECT date::text AS date, COUNT(*)::int AS count
     FROM daily_reports
     WHERE date >= CURRENT_DATE - 2
     GROUP BY date
     ORDER BY date`
  ).catch(() => ({ rows: [] }));

  const storeRows = await pool.query(
    `SELECT date::text AS date, store,
            COUNT(*)::int AS rows,
            ROUND(SUM(COALESCE(actual_revenue,0))::numeric,2) AS revenue_sum,
            ROUND(SUM(COALESCE(target_revenue,0))::numeric,2) AS target_sum
     FROM daily_reports
     WHERE date >= CURRENT_DATE - 2
     GROUP BY date, store
     ORDER BY date, store`
  ).catch(() => ({ rows: [] }));

  const latestDate = dayRows.rows.length
    ? dayRows.rows[dayRows.rows.length - 1].date
    : new Date().toISOString().slice(0, 10);

  const summaries = await buildDailyOperationSummaries(latestDate);
  const reportFor0318 = await getAIOperationsReport("2026-03-18");

  const worstDayRows = await pool.query(
    `SELECT date::text AS date,
            COUNT(*) FILTER (
              WHERE COALESCE(target_revenue,0) > 0
                AND COALESCE(actual_revenue,0) < COALESCE(target_revenue,0)
            )::int AS under_target_stores,
            COUNT(*)::int AS total_stores
     FROM daily_reports
     GROUP BY date
     ORDER BY under_target_stores DESC, date DESC
     LIMIT 1`
  ).catch(() => ({ rows: [] }));

  const worstDate = worstDayRows.rows[0]?.date || null;
  const worstReport = worstDate ? await getAIOperationsReport(worstDate) : { summaries: [], report: {} };

  printJson("【数据检查结果】", {
    tableStatus,
    recent3DaysCounts: dayRows.rows,
    perStoreByDay: storeRows.rows,
    latestDateUsedForSummary: latestDate,
    buildDailyOperationSummaries_count: summaries.length,
    needImportTestData: tableStatus.some((x) => x.exists && x.count === 0)
  });

  printJson("【实际读取到的数据示例】", {
    summariesSample: summaries.slice(0, 3)
  });

  printJson("【输入数据】", {
    date: "2026-03-18",
    summaries: reportFor0318.summaries
  });

  printJson("【AI分析结果】", {
    date: "2026-03-18",
    report: reportFor0318.report
  });

  printJson("【最差日期与分析】", {
    worstDay: worstDayRows.rows[0] || null,
    inputSummaries: worstReport.summaries,
    aiReport: worstReport.report
  });

  await pool.end();
}

main().catch(async (err) => {
  console.error("inspect-ai-ops-data failed:", err?.message || err);
  process.exit(1);
});
