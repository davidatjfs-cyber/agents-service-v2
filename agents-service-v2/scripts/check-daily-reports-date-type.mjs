#!/usr/bin/env node
import 'dotenv/config';
import pg from 'pg';
const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
const q = async (sql, params = []) => (await pool.query(sql, params)).rows;

const rows = await q(
  `SELECT column_name, data_type, udt_name
   FROM information_schema.columns
   WHERE table_name='daily_reports'
     AND column_name='date';`
);
console.log(JSON.stringify({ rows }, null, 2));

const row2 = await q(
  `SELECT
      MIN(date::text) as min_date,
      MAX(date::text) as max_date,
      SUM(CASE WHEN date < '2026-03-01'::date THEN 1 ELSE 0 END)::int as cnt_before
   FROM daily_reports
   WHERE store = '马己仙上海音乐广场店';`
);
console.log(JSON.stringify({ row2: row2[0] }, null, 2));

await pool.end();

