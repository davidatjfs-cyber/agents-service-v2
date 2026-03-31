#!/usr/bin/env node
import 'dotenv/config';
import pg from 'pg';

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
const q = async (sql, params = []) => (await pool.query(sql, params)).rows;

const stores = process.argv.slice(2);
if (!stores.length) {
  console.error('Usage: node scripts/check-store-ratings-history.mjs "洪潮久光店" "马己仙上海音乐广场店"');
  process.exit(1);
}

const rows = await q(
  `SELECT store, period, rating
   FROM store_ratings
   WHERE store = ANY($1::text[])
   ORDER BY store, period`,
  [stores]
);

console.log(JSON.stringify({ stores, rows }, null, 2));
await pool.end();

