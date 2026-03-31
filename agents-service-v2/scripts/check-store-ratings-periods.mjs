#!/usr/bin/env node
import 'dotenv/config';
import pg from 'pg';
const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
const q = async (sql, params = []) => (await pool.query(sql, params)).rows;
const rows = await q(
  `SELECT period, COUNT(*)::int AS cnt
   FROM store_ratings
   GROUP BY period
   ORDER BY period DESC
   LIMIT 30`
);
console.log(JSON.stringify({ rows }, null, 2));
await pool.end();

