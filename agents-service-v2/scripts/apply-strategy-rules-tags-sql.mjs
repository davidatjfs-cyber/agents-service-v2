#!/usr/bin/env node
/** 幂等：strategy_rules.tags 列 + 种子标签 */
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
  console.error('[apply-strategy-rules-tags-sql] Missing DATABASE_URL');
  process.exit(1);
}

const migrationsDir = path.join(root, 'src/migrations');
const files = ['007_strategy_rules_tags.sql', '008_strategy_rules_tags_verified.sql', '009_strategy_rules_tags_score.sql'];
const pool = new pg.Pool({ connectionString: url, max: 1 });

try {
  for (const f of files) {
    const sql = fs.readFileSync(path.join(migrationsDir, f), 'utf8');
    await pool.query(sql);
    console.log(`[apply-strategy-rules-tags-sql] ${f} OK`);
  }
  console.log('[apply-strategy-rules-tags-sql] OK');
} catch (e) {
  console.error('[apply-strategy-rules-tags-sql]', e.message);
  process.exit(1);
} finally {
  await pool.end();
}
