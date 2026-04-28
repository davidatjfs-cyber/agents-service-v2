#!/usr/bin/env node
/**
 * 将执行力日评备案（ops_tasks.execution_rating_daily）历史状态 pending_review
 * 统一为「已备案」，与 daily-execution-rating.js 写入口径一致。
 */
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
  console.error('[apply-ops-execution-filing-status-zh] Missing DATABASE_URL');
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: url, max: 1 });
try {
  const r = await pool.query(
    `UPDATE ops_tasks
     SET status = '已备案', updated_at = NOW()
     WHERE task_type = 'execution_rating_daily'
       AND status = 'pending_review'`
  );
  console.log('[apply-ops-execution-filing-status-zh] OK, rows updated:', r.rowCount ?? 0);
} catch (e) {
  console.error('[apply-ops-execution-filing-status-zh]', e.message);
  process.exit(1);
} finally {
  await pool.end();
}
