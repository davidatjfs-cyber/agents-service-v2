#!/usr/bin/env node
/**
 * 幂等执行 analysis_sop 表 DDL + 种子（与 src/migrations/004_analysis_sop.sql 一致）。
 * 用于生产 ECS：migrate/run.js 会因 APP_ENV=production 拒绝执行。
 *
 * 用法（在 agents-service-v2 根目录，与 .env.production 同机）：
 *   node scripts/apply-analysis-sop-sql.mjs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import pg from 'pg';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');

dotenv.config({ path: path.join(root, '.env') });
dotenv.config({ path: path.join(root, '.env.production') });

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('[apply-analysis-sop-sql] Missing DATABASE_URL');
  process.exit(1);
}

const sqlPath = path.join(root, 'src/migrations/004_analysis_sop.sql');
const sql = fs.readFileSync(sqlPath, 'utf8');
const pool = new pg.Pool({ connectionString: url, max: 1 });

try {
  await pool.query(sql);
  console.log('[apply-analysis-sop-sql] OK');
} catch (e) {
  console.error('[apply-analysis-sop-sql]', e.message);
  process.exit(1);
} finally {
  await pool.end();
}
