/**
 * 异常通知延迟队列 — BI异常触发后不立即发飞书卡片给责任人，而是存入DB队列，
 * 每日 09:05（上海时间）统一刷新发送，避免凌晨5点打扰门店人员。
 *
 * 流程：anomaly-engine 触发 → enqueueDelayedNotify() 写DB → rhythm-engine 09:05 cron 刷队列发送
 * 食安类（food_safety）始终立即发送，不走延迟队列。
 * 周一任务多时每条间隔5分钟，平时间隔1分钟，避免集中轰炸。
 */
import { query } from '../utils/db.js';
import { logger } from '../utils/logger.js';

const TABLE = 'anomaly_pending_notifications';

export async function ensureNotifyQueueTable() {
  await query(`
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      id BIGSERIAL PRIMARY KEY,
      store TEXT NOT NULL,
      brand TEXT,
      rule_key TEXT NOT NULL,
      severity TEXT NOT NULL DEFAULT 'medium',
      detail TEXT,
      value JSONB,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      sent_at TIMESTAMPTZ,
      error TEXT
    )`);
  await query(`CREATE INDEX IF NOT EXISTS idx_apn_status ON ${TABLE} (status, created_at)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_apn_rule_key ON ${TABLE} (rule_key, created_at)`);
}

/**
 * 将异常通知存入延迟队列（09:05统一发送）
 * 食安类不延迟，直接走原有即时链路
 */
export async function enqueueDelayedNotify({ store, brand, ruleKey, severity, detail, value }) {
  if (ruleKey === 'food_safety') {
    return { immediate: true };
  }
  await ensureNotifyQueueTable();
  await query(
    `INSERT INTO ${TABLE} (store, brand, rule_key, severity, detail, value, status)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, 'pending')`,
    [store, brand || null, ruleKey, severity || 'medium', detail || '', JSON.stringify(value || {})]
  );
  logger.info({ store, ruleKey, severity }, 'delayed notify enqueued (will send at 09:05)');
  return { immediate: false };
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isMondayInShanghai() {
  return new Date().toLocaleString('en-US', { timeZone: 'Asia/Shanghai', weekday: 'short' }) === 'Mon';
}

/**
 * 刷新延迟队列：取出所有 pending 记录，逐条调用 runBiAnomalyNotifyPipeline 发送。
 * 周一间隔5分钟（任务多），平时间隔1分钟。
 * 成功标记 sent，失败标记 error 并记录日志（不阻断后续记录）。
 */
export async function flushPendingNotifications() {
  await ensureNotifyQueueTable();
  const r = await query(
    `SELECT id, store, brand, rule_key, severity, detail, value, created_at
     FROM ${TABLE}
     WHERE status = 'pending'
     ORDER BY created_at ASC
     LIMIT 200`
  );
  if (!r.rows?.length) {
    logger.info('flushPendingNotifications: no pending notifications');
    return { sent: 0, failed: 0 };
  }

  const { runBiAnomalyNotifyPipeline } = await import('./anomaly-notify-pipeline.js');
  const intervalMs = isMondayInShanghai() ? 5 * 60_000 : 60_000;
  let sent = 0;
  let failed = 0;

  for (let i = 0; i < r.rows.length; i++) {
    const row = r.rows[i];
    if (i > 0) {
      await sleep(intervalMs);
    }
    try {
      const value = typeof row.value === 'string' ? JSON.parse(row.value) : (row.value || {});
      await runBiAnomalyNotifyPipeline({
        store: row.store,
        brand: row.brand,
        ruleKey: row.rule_key,
        severity: row.severity,
        detail: row.detail,
        value
      });
      await query(
        `UPDATE ${TABLE} SET status = 'sent', sent_at = NOW() WHERE id = $1`,
        [row.id]
      );
      sent++;
    } catch (e) {
      logger.error({ err: e?.message, id: row.id, store: row.store, ruleKey: row.rule_key }, 'flushPendingNotifications: send failed');
      await query(
        `UPDATE ${TABLE} SET status = 'error', error = $2 WHERE id = $1`,
        [row.id, String(e?.message || e).slice(0, 2000)]
      );
      failed++;
    }
  }

  logger.info({ sent, failed, total: r.rows.length, intervalMin: intervalMs / 60_000, isMonday: isMondayInShanghai() }, 'flushPendingNotifications done');

  // 清理7天前的已发送/错误记录
  try {
    const del = await query(
      `DELETE FROM ${TABLE} WHERE status IN ('sent', 'error') AND created_at < NOW() - INTERVAL '7 days'`
    );
    if (del.rowCount) logger.info({ deleted: del.rowCount }, 'flushPendingNotifications: cleaned old records');
  } catch (_e) { /* ignore */ }

  return { sent, failed, total: r.rows.length };
}