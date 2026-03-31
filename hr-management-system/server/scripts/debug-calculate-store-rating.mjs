#!/usr/bin/env node
/**
 * 调试：打印 calculateStoreRating 的返回原因
 * 用法：
 *   node scripts/debug-calculate-store-rating.mjs 2026-03 "马己仙上海音乐广场店"
 */
import 'dotenv/config';
import { Pool } from 'pg';

import { setPool, inferBrandFromStoreName } from '../agents.js';
import { calculateStoreRating } from '../new-scoring-model.js';

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  const period = String(process.argv[2] || '').trim();
  const store = String(process.argv[3] || '').trim();
  if (!period || !store) {
    console.error('Usage: node scripts/debug-calculate-store-rating.mjs 2026-03 \"门店名\"');
    process.exit(1);
  }
  if (!process.env.DATABASE_URL) throw new Error('Missing DATABASE_URL');

  const pgssl = process.env.PGSSL === 'disable' ? false : { rejectUnauthorized: false };
  const pgPool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: pgssl });
  setPool(pgPool);

  const brand = inferBrandFromStoreName(store);
  const res = await calculateStoreRating(store, brand, period);
  console.log(JSON.stringify({ period, store, brand, result: res }, null, 2));

  await pgPool.end();
}

main().catch(async (e) => {
  console.error(e);
  process.exit(1);
});

