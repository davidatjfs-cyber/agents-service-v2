/**
 * 数据异常时向 admin / hq_manager 发飞书文本告警（与 cron-run-monitor 定时失败告警风格一致）。
 * 用 DB 表做去重，避免同一问题短时间刷屏。
 *
 * 分级（与业务约定一致）：
 * - A：数据安全、双写/备份/损坏、网络/基础设施类（重要且紧急）— 默认去重窗口更短
 * - B：绩效相关（扣分、备案、统计投递）— 须及时发现
 * - C：数据准确性（如助手口径与飞书表不一致）— 重要但不紧急 — 默认去重窗口更长
 *
 * 环境变量：
 * - ADMIN_DATA_ALERT_ENABLE：设为 0 / false 时关闭全部数据告警
 * - ADMIN_DATA_ALERT_DEDUPE_HOURS：默认 6，同 dedupe_key 在此时间内只发一次（B 级基准）
 */
import { query } from '../utils/db.js';
import { logger } from '../utils/logger.js';
import { sendText } from './feishu-client.js';

const TABLE = 'agent_v2_data_alert_dedupe';
const LOG_TABLE = 'agent_admin_alert_log';

/** 飞书正文展示用中文类型（日志里仍用英文 alertType 便于检索） */
const ALERT_TYPE_LABEL_ZH = {
  bitable_poll_fetch_failed: '飞书多维表轮询：拉取记录失败（整表未同步）',
  bitable_material_store_parse_empty: '原料表轮询：门店列有值但解析为空',
  bitable_material_date_parse_empty: '原料表轮询：日期列有值但解析为空',
  material_agent_feishu_divergence: '原料数据：助手结果与飞书同步库不一致',
  execution_rating_feishu_partial_fail: '执行力日评：飞书卡片部分发送失败',
  data_issue: '数据异常'
};

function alertTypeLabelZh(alertType) {
  const k = String(alertType || '').trim();
  return ALERT_TYPE_LABEL_ZH[k] || '数据异常';
}

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

function dedupeHoursBase() {
  const n = Number(process.env.ADMIN_DATA_ALERT_DEDUPE_HOURS);
  return Number.isFinite(n) && n > 0 ? n : 6;
}

/** 未显式传入 dedupeHours 时，按优先级收紧/放宽默认窗口 */
function effectiveDedupeHours(priority, explicitHours) {
  if (explicitHours != null) {
    const n = Number(explicitHours);
    if (Number.isFinite(n) && n > 0) return n;
  }
  const base = dedupeHoursBase();
  const p = String(priority || 'B').trim().toUpperCase();
  if (p === 'A') return Math.min(base, 2);
  if (p === 'C') return Math.max(base, 12);
  return base;
}

async function ensureDedupeTable() {
  await query(`
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      dedupe_key VARCHAR(320) PRIMARY KEY,
      sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
}

/** 控制台「Agent 活动」按日查看 A/B/C 管理告警（至少成功发出过一条飞书时落库） */
export async function ensureAdminAlertLogTable() {
  await query(`
    CREATE TABLE IF NOT EXISTS ${LOG_TABLE} (
      id BIGSERIAL PRIMARY KEY,
      priority CHAR(1) NOT NULL DEFAULT 'B',
      alert_type VARCHAR(96) NOT NULL DEFAULT '',
      title TEXT NOT NULL DEFAULT '',
      body TEXT NOT NULL DEFAULT '',
      dedupe_key VARCHAR(320) NOT NULL DEFAULT '',
      recipient_count INT NOT NULL DEFAULT 0,
      sent_count INT NOT NULL DEFAULT 0,
      sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
  await query(`
    CREATE INDEX IF NOT EXISTS idx_agent_admin_alert_log_sh_date
    ON ${LOG_TABLE} ((DATE(timezone('Asia/Shanghai', sent_at))))`);
}

/**
 * @param {object} opts
 * @param {string} opts.alertType 短类型键，便于检索日志
 * @param {string} opts.title 一行标题
 * @param {string[]} [opts.lines] 核心信息行（门店、日期、计数、recordId 等）
 * @param {string} opts.dedupeKey 去重键（建议含场景+门店+日期+记录id）
 * @param {number} [opts.dedupeHours] 覆盖默认去重窗口（小时）
 * @param {'A'|'B'|'C'} [opts.priority] 告警分级（影响标题前缀与默认去重窗口）
 * @returns {Promise<{ ok: boolean, skipped?: string }>}
 */
export async function notifyAdminsDataIssue(opts) {
  const alertType = String(opts?.alertType || 'data_issue').trim();
  const title = String(opts?.title || '').trim();
  const lines = Array.isArray(opts?.lines) ? opts.lines.map((x) => String(x || '').trim()).filter(Boolean) : [];
  const dedupeKey = String(opts?.dedupeKey || '').trim();
  const priorityRaw = String(opts?.priority || 'B').trim().toUpperCase();
  const priority = priorityRaw === 'A' || priorityRaw === 'C' ? priorityRaw : 'B';
  const tierEmoji = priority === 'A' ? '🔴' : priority === 'C' ? '🟡' : '🟠';
  const tierLabel =
    priority === 'A' ? 'A级·紧急' : priority === 'C' ? 'C级·准确性' : 'B级·绩效/流程';
  const hours = effectiveDedupeHours(priority, opts?.dedupeHours);

  if (alertsGloballyDisabled()) {
    return { ok: false, skipped: 'disabled' };
  }
  if (!title || !dedupeKey) {
    logger.warn({ alertType }, 'notifyAdminsDataIssue: missing title or dedupeKey');
    return { ok: false, skipped: 'missing_params' };
  }

  try {
    await ensureDedupeTable();
    await ensureAdminAlertLogTable();
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

    const typeLineZh = alertTypeLabelZh(alertType);
    const body = [
      `${tierEmoji} 【数据异常告警·${tierLabel}】${title}`,
      `时间：${shanghaiTimeLine()}（上海）`,
      `问题类型：${typeLineZh}`,
      `级别：${priority === 'A' ? 'A（紧急）' : priority === 'C' ? 'C（准确性）' : 'B（绩效/流程）'}`,
      '',
      ...lines,
      '',
      '—',
      '【排查建议】',
      '1）数据库：查看表「feishu_generic_records」（飞书多维表同步结果）、「agent_messages」（助手侧归档）。',
      '2）服务日志：搜索 bitable、material_report、replyEngine（回复引擎构建号，见健康检查）。',
      '3）配置：核对 BITABLE_*、ADMIN_DATA_ALERT_* 等环境变量是否与线上一致。',
      '',
      `【去重】同一告警在 ${hours} 小时内只发送一次。`
    ].join('\n');

    const text = body.length > 3800 ? `${body.slice(0, 3700)}\n…(截断)` : body;
    let sent = 0;
    for (const row of r.rows || []) {
      const res = await sendText(row.open_id, text, 'open_id');
      if (res?.ok) sent++;
    }
    logger.info({ alertType, dedupeKey, recipients: (r.rows || []).length, sent }, 'admin data alert sent');
    if (sent > 0) {
      try {
        await query(
          `INSERT INTO ${LOG_TABLE}
           (priority, alert_type, title, body, dedupe_key, recipient_count, sent_count)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [
            priority,
            alertType,
            title.slice(0, 2000),
            text.slice(0, 12000),
            dedupeKey.slice(0, 320),
            (r.rows || []).length,
            sent
          ]
        );
      } catch (logErr) {
        logger.warn({ err: logErr?.message, dedupeKey }, 'admin alert log insert failed');
      }
    }
    return { ok: sent > 0, sent };
  } catch (e) {
    logger.warn({ err: e?.message, alertType, dedupeKey }, 'notifyAdminsDataIssue failed');
    return { ok: false, skipped: String(e?.message || e) };
  }
}
