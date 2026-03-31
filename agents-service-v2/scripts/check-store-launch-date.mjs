#!/usr/bin/env node
import 'dotenv/config';
import pg from 'pg';

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
const q = async (sql, params = []) => (await pool.query(sql, params)).rows;

const stores = process.argv.slice(2);
if (!stores.length) {
  console.error('Usage: node scripts/check-store-launch-date.mjs \"洪潮久光店\" ...');
  process.exit(1);
}

const rows = await q(
  `SELECT store, MIN(date) AS first_date, COUNT(*)::int AS rows_cnt
   FROM daily_reports
   WHERE store = ANY($1::text[])
   GROUP BY store
   ORDER BY store`,
  [stores]
);

console.log(JSON.stringify({ stores, rows }, null, 2));
await pool.end();

