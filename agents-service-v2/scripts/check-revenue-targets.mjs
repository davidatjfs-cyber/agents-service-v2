#!/usr/bin/env node
/**
 * 查看某月 revenue_targets 是否存在（门店评级依赖）
 * 用法：node scripts/check-revenue-targets.mjs 2026-03
 */
import 'dotenv/config';
import pg from 'pg';

const { Pool } = pg;
if (!process.env.DATABASE_URL) throw new Error('Missing DATABASE_URL');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
const period = String(process.argv[2] || '2026-03');

const rows = await (await pool.query(
  `SELECT store, brand, period, target_revenue
   FROM revenue_targets
   WHERE period=$1
   ORDER BY store
   LIMIT 30`,
  [period]
)).rows;

const c = await (await pool.query(
  `SELECT COUNT(*)::int AS total FROM revenue_targets WHERE period=$1`,
  [period]
)).rows[0];

console.log(JSON.stringify({ period, total: c.total, sample: rows }, null, 2));
await pool.end();

