#!/usr/bin/env node
/**
 * 幂等执行 strategy_rules（与 src/migrations/005_strategy_rules.sql 一致）。
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
  console.error('[apply-strategy-rules-sql] Missing DATABASE_URL');
  process.exit(1);
}

const sqlPath = path.join(root, 'src/migrations/005_strategy_rules.sql');
const sql = fs.readFileSync(sqlPath, 'utf8');
const pool = new pg.Pool({ connectionString: url, max: 1 });

try {
  await pool.query(sql);
  console.log('[apply-strategy-rules-sql] OK');
} catch (e) {
  console.error('[apply-strategy-rules-sql]', e.message);
  process.exit(1);
} finally {
  await pool.end();
}
