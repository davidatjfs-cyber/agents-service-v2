/**
 * 数据异常时向 admin / hq_manager 发飞书文本告警（与 cron-run-monitor 定时失败告警风格一致）。
 * 用 DB 表做去重，避免同一问题短时间刷屏。
 *
 * 环境变量：
 * - ADMIN_DATA_ALERT_ENABLE：设为 0 / false 时关闭全部数据告警
 * - ADMIN_DATA_ALERT_DEDUPE_HOURS：默认 6，同 dedupe_key 在此时间内只发一次
 */
import { query } from '../utils/db.js';
import { logger } from '../utils/logger.js';
import { sendText } from './feishu-client.js';

const TABLE = 'agent_v2_data_alert_dedupe';

function shanghaiTimeLine() {
  return new Date().toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    hour12: false
  });
}

function alertsGloballyDisabled() {
  const v = String(process.env.ADMIN_DATA_ALERT_ENABLE || '').trim().toLowerCase();
  return v === '0' || v === 'false' || v === 'off';
}

function dedupeHours() {
  const n = Number(process.env.ADMIN_DATA_ALERT_DEDUPE_HOURS);
  return Number.isFinite(n) && n > 0 ? n : 6;
}

async function ensureDedupeTable() {
  await query(`
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      dedupe_key VARCHAR(320) PRIMARY KEY,
      sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
}

/**
 * @param {object} opts
 * @param {string} opts.alertType 短类型键，便于检索日志
 * @param {string} opts.title 一行标题
 * @param {string[]} [opts.lines] 核心信息行（门店、日期、计数、recordId 等）
 * @param {string} opts.dedupeKey 去重键（建议含场景+门店+日期+记录id）
 * @param {number} [opts.dedupeHours] 覆盖默认去重窗口（小时）
 * @returns {Promise<{ ok: boolean, skipped?: string }>}
 */
export async function notifyAdminsDataIssue(opts) {
  const alertType = String(opts?.alertType || 'data_issue').trim();
  const title = String(opts?.title || '').trim();
  const lines = Array.isArray(opts?.lines) ? opts.lines.map((x) => String(x || '').trim()).filter(Boolean) : [];
  const dedupeKey = String(opts?.dedupeKey || '').trim();
  const hours = opts?.dedupeHours != null ? Number(opts.dedupeHours) : dedupeHours();

  if (alertsGloballyDisabled()) {
    return { ok: false, skipped: 'disabled' };
  }
  if (!title || !dedupeKey) {
    logger.warn({ alertType }, 'notifyAdminsDataIssue: missing title or dedupeKey');
    return { ok: false, skipped: 'missing_params' };
  }

  try {
    await ensureDedupeTable();
    const prev = await query(`SELECT sent_at FROM ${TABLE} WHERE dedupe_key = $1`, [dedupeKey]);
    if (prev.rows?.[0]) {
      const ageMs = Date.now() - new Date(prev.rows[0].sent_at).getTime();
      if (ageMs < hours * 3600000) {
        logger.info({ dedupeKey, alertType }, 'admin data alert: deduped');
        return { ok: false, skipped: 'deduped' };
      }
    }

    await query(
      `INSERT INTO ${TABLE} (dedupe_key, sent_at) VALUES ($1, NOW())
       ON CONFLICT (dedupe_key) DO UPDATE SET sent_at = EXCLUDED.sent_at`,
      [dedupeKey]
    );

    const r = await query(
      `SELECT open_id, username FROM feishu_users
       WHERE registered = true AND open_id IS NOT NULL AND open_id <> ''
         AND role IN ('admin','hq_manager')
       ORDER BY username
       LIMIT 30`
    );

    const body = [
      `🚨 【数据异常告警】${title}`,
      `时间：${shanghaiTimeLine()}（上海）`,
      `类型：${alertType}`,
      '',
      ...lines,
      '',
      '—',
      '排查：Postgres `feishu_generic_records` / `agent_messages`；服务日志关键字：bitable、material_report、replyEngine。',
      `_同 key ${hours}h 内只发一次_`
    ].join('\n');

    const text = body.length > 3800 ? `${body.slice(0, 3700)}\n…(截断)` : body;
    let sent = 0;
    for (const row of r.rows || []) {
      const res = await sendText(row.open_id, text, 'open_id');
      if (res?.ok) sent++;
    }
    logger.info({ alertType, dedupeKey, recipients: (r.rows || []).length, sent }, 'admin data alert sent');
    return { ok: sent > 0, sent };
  } catch (e) {
    logger.warn({ err: e?.message, alertType, dedupeKey }, 'notifyAdminsDataIssue failed');
    return { ok: false, skipped: String(e?.message || e) };
  }
}
