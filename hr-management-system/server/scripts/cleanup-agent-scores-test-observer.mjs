#!/usr/bin/env node
/**
 * 物理删除 agent_scores 中：测试门店、马己仙出品观察号 nnyxcs35、周度占位账号 等历史行。
 * 默认只处理 score_model = 'anomaly_rollups_v2'（周度异常汇总）。
 *
 * 用法：在 hr-management-system 目录或设置 DATABASE_URL 后执行：
 *   node server/scripts/cleanup-agent-scores-test-observer.mjs
 * 干跑（只打印将要删除的行数）：
 *   node server/scripts/cleanup-agent-scores-test-observer.mjs --dry-run
 */
import pg from 'pg';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootHrms = path.resolve(__dirname, '../..');
const rootServer = path.resolve(__dirname, '..');
for (const p of [
  path.join(rootHrms, '.env'),
  path.join(rootHrms, '.env.local'),
  path.join(rootServer, '.env'),
  path.join(rootServer, '.env.local')
]) {
  if (fs.existsSync(p)) {
    const raw = fs.readFileSync(p, 'utf8');
    for (const line of raw.split('\n')) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
}

const dry = process.argv.includes('--dry-run');
const url = process.env.DATABASE_URL || process.env.PG_CONNECTION_STRING;
if (!url) {
  console.error('缺少 DATABASE_URL（或 PG_CONNECTION_STRING）');
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: url, max: 2 });

const where = `score_model = 'anomaly_rollups_v2'
  AND (
    store ~* '(测试门店|SAFE_TEST|_SAFE_TEST|沙箱|sandbox)'
    OR lower(trim(coalesce(username,''))) = 'nnyxcs35'
    OR coalesce(username,'') like '__periodic%'
  )`;

try {
  const cnt = await pool.query(`SELECT COUNT(*)::int AS n FROM agent_scores WHERE ${where}`);
  const n = cnt.rows?.[0]?.n ?? 0;
  console.log(`${dry ? '[干跑] ' : ''}将删除 anomaly_rollups_v2 行数: ${n}`);
  if (dry || n === 0) {
    await pool.end();
    process.exit(0);
  }
  const del = await pool.query(`DELETE FROM agent_scores WHERE ${where}`);
  console.log('已删除行数:', del.rowCount);
} catch (e) {
  console.error(e.message);
  process.exit(1);
} finally {
  await pool.end().catch(() => {});
}
