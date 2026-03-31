#!/usr/bin/env node
import 'dotenv/config';
import pg from 'pg';
const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
const q = async (sql, params = []) => (await pool.query(sql, params)).rows;

const store = String(process.argv[2] || '');
const before = String(process.argv[3] || '');
if (!store || !before) {
  console.error('Usage: node scripts/count-daily-reports-before.mjs \"门店\" 2026-03-01');
  process.exit(1);
}
const r = await q(
  `SELECT COUNT(*)::int AS cnt,
          MIN(date) AS min_date,
          MAX(date) AS max_date
   FROM daily_reports
   WHERE store=$1 AND date < $2::date`,
  [store, before]
);
console.log(JSON.stringify({ store, before, ...r[0] }, null, 2));
await pool.end();

