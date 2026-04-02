/**
 * Idempotency Middleware — 防止飞书事件重复处理
 * 
 * 使用 idempotency_keys 表持久化处理结果
 * 24小时内相同key返回缓存结果
 */
import { query } from '../utils/db.js';
import { logger } from '../utils/logger.js';

export async function checkIdempotency(key) {
  if (!key) return null;
  try {
    const r = await query(
      `SELECT result FROM idempotency_keys WHERE key = $1 AND created_at > NOW() - INTERVAL '24h'`,
      [key]
    );
    return r.rows[0]?.result || null;
  } catch (e) {
    logger.warn({ err: e?.message }, 'idempotency check failed');
    return null;
  }
}

export async function saveIdempotency(key, result) {
  if (!key) return;
  try {
    await query(
      `INSERT INTO idempotency_keys (key, result) VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET result = $2, created_at = NOW()`,
      [key, JSON.stringify(result)]
    );
  } catch (e) {
    logger.warn({ err: e?.message }, 'idempotency save failed');
  }
}

// 清理过期key（>48h）
export async function cleanupIdempotencyKeys() {
  try {
    const r = await query(`DELETE FROM idempotency_keys WHERE created_at < NOW() - INTERVAL '48h'`);
    return r.rowCount || 0;
  } catch (e) { return 0; }
}
