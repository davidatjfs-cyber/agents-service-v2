#!/usr/bin/env node
/**
 * 核对 daily_reports 中指定日期的门店行（默认查马己仙/洪潮）。
 * 用法：DATABASE_URL=... node scripts/check-daily-reports-stores.mjs 2026-04-10 2026-04-11
 */
import 'dotenv/config';
import pg from 'pg';

const dates = process.argv.slice(2).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d));
const list = dates.length ? dates : ['2026-04-10', '2026-04-11'];

if (!process.env.DATABASE_URL) {
  console.error('缺少 DATABASE_URL，无法查询。');
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 });

for (const d of list) {
  const r = await pool.query(
    `SELECT date::text AS date, store, submitted, submitted_at::text AS submitted_at,
            actual_revenue, updated_at::text AS updated_at
     FROM daily_reports
     WHERE date = $1::date
       AND (store ILIKE '%马己仙%' OR store ILIKE '%洪潮%')
     ORDER BY store`,
    [d]
  );
  console.log(`\n=== daily_reports · ${d} · 马己仙/洪潮 ===`);
  console.log(r.rows?.length ? JSON.stringify(r.rows, null, 2) : '(无行)');
}

await pool.end();
