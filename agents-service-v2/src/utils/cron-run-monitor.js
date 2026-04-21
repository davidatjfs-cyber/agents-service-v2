/**
 * 定时任务运行日志 + 失败飞书告警（上海时区）。
 *
 * 设计原则（2026-04 修订）：
 *   1. 每个定时任务只在约定时刻触发一次（通过 node-cron）。
 *   2. runWithCronLog 包装：成功写 ok=true；失败写 ok=false，并立即发飞书告警给 admin（不推送给总部营运）。
 *   3. 不再有 sweepCronRetries 全局补偿循环，从根上杜绝「莫名其妙多出消息」。
 *   4. 极端情况（进程重启错过窗口）通过飞书告警人工确认，而非自动补跑。
 */
import cron from 'node-cron';
import { query } from './db.js';
import { logger } from './logger.js';

const TABLE = 'agent_v2_cron_runs';

/** 飞书告警展示用中文名（与 runWithCronLog 的 job_key 一一对应） */
const CRON_JOB_LABEL_ZH = {
  kpi_yesterday: '昨日 KPI 计算',
  morning_briefing: '每日晨报推送',
  daily_execution_rating: '执行力日评',
  food_safety_daily_scan: '食安日扫',
  daily_task_completion_report: '每日任务达成率报告',
  daily_bi_anomaly: '日频 BI 异常检测',
  bitable_actual_gross_margin: '飞书实际毛利率表同步',
  weekly_bi_anomaly: '周频 BI 异常检测',
  weekly_store_scoring: '周度门店评分',
  monthly_anomaly_item_bonus: '月度异常项加分',
  monthly_gross_margin_check: '月度毛利率检测',
  monthly_comprehensive_rating: '月度绩效成绩单',
  rhythm_weekly_report: '总部周报节奏',
  rhythm_monthly_evaluation: '本月运营月报',
  monthly_revenue_anomaly: '月度营收异常检测',
  daily_attendance_report: '考勤日报',
  daily_attendance_report_catchup: '考勤日报（23:10补跑）',
  escalation_scan: '任务升级扫描',
  task_card_reminders: '任务卡片催办',
  daily_inspection_tick: '每日巡检调度（整轮）',
  daily_attitude_filing_report: '工作态度备案日报（昨日汇总）',
  bi_anomaly_notify_flush: 'BI异常任务卡片发送（09:05延迟队列刷新）'
};

function cronJobLabelZh(jobKey) {
  const k = String(jobKey || '').trim();
  return CRON_JOB_LABEL_ZH[k] || '定时任务';
}

/** 凡经 runWithCronLog 包装且抛错时，会向 admin 发飞书告警的任务清单（与 job_key 一致） */
export function listCronJobKeysWithFeishuFailureAlert() {
  return Object.keys(CRON_JOB_LABEL_ZH);
}

export async function ensureCronRunTable() {
  try {
    await query(`
      CREATE TABLE IF NOT EXISTS ${TABLE} (
        id BIGSERIAL PRIMARY KEY,
        job_key TEXT NOT NULL,
        run_ymd TEXT NOT NULL,
        ok BOOLEAN NOT NULL,
        error TEXT,
        source TEXT NOT NULL DEFAULT 'cron',
        created_at TIMESTAMPTZ DEFAULT NOW()
      )`);
    await query(
      `CREATE INDEX IF NOT EXISTS idx_agent_v2_cron_runs_key_ymd ON ${TABLE} (job_key, run_ymd, created_at DESC)`
    );
  } catch (e) {
    logger.warn({ err: e?.message }, 'ensureCronRunTable');
  }
}

/** 上海当前：ymd、时、分、当天分钟数、weekday 0=日…1=一、dom */
export function getShanghaiNowClock() {
  const parts = new Intl.DateTimeFormat('en', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
    hour12: false
  }).formatToParts(new Date());
  const o = {};
  for (const p of parts) {
    if (p.type !== 'literal') o[p.type] = p.value;
  }
  const ymd = `${o.year}-${o.month}-${o.day}`;
  const hour = parseInt(o.hour, 10);
  const minute = parseInt(o.minute, 10);
  const mapDow = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const weekday = mapDow[o.weekday] ?? 0;
  const dom = parseInt(o.day, 10);
  return { ymd, hour, minute, minuteOfDay: hour * 60 + minute, weekday, dom };
}

async function insertRun(jobKey, runYmd, ok, error, source) {
  await ensureCronRunTable();
  await query(
    `INSERT INTO ${TABLE} (job_key, run_ymd, ok, error, source) VALUES ($1,$2,$3,$4,$5)`,
    [jobKey, runYmd, ok, error || null, source]
  );
}

/** 向所有 admin 发飞书告警文本（失败类告警不推送给 hq_manager） */
async function notifyAdminsOnFailure(jobKey, errorMsg) {
  try {
    const { sendText } = await import('../services/feishu-client.js');
    const r = await query(
      `SELECT open_id FROM feishu_users
       WHERE registered = true AND open_id IS NOT NULL
         AND role = 'admin'
       LIMIT 20`
    );
    const { ymd, hour, minute } = getShanghaiNowClock();
    const timeStr = `${ymd} ${String(hour).padStart(2,'0')}:${String(minute).padStart(2,'0')}`;
    const text = `⚠️ 【定时任务失败告警】\n任务：${cronJobLabelZh(jobKey)}\n时间：${timeStr}（上海）\n错误：${String(errorMsg || '未知错误').slice(0, 1200)}\n\n请检查服务日志并在必要时联系运维补跑。`;
    for (const row of (r.rows || [])) {
      sendText(row.open_id, text, 'open_id').catch(() => {});
    }
  } catch (e) {
    logger.warn({ err: e?.message, jobKey }, 'notifyAdminsOnFailure: failed to send alert');
  }
}

/**
 * 主定时任务包装：
 *   - 成功：默认记录 ok=true（高频任务可传 { recordSuccess: false } 省略成功行，仅失败入库 + 飞书）
 *   - 失败：记录 ok=false + 立即向所有 admin 飞书告警（错误信息截断见 notifyAdminsOnFailure）
 *
 * @param {string} jobKey
 * @param {() => Promise<unknown>} fn
 * @param {string | { source?: string, recordSuccess?: boolean }} [third]  source 或选项对象
 */
export async function runWithCronLog(jobKey, fn, third = 'cron') {
  let source = 'cron';
  let recordSuccess = true;
  if (third != null && typeof third === 'object' && !Array.isArray(third)) {
    source = String(third.source ?? 'cron');
    if (third.recordSuccess === false) recordSuccess = false;
  } else if (typeof third === 'string') {
    source = third;
  }
  const { ymd } = getShanghaiNowClock();
  try {
    await fn();
    if (recordSuccess) {
      await insertRun(jobKey, ymd, true, null, source);
    }
  } catch (e) {
    const msg = String(e?.message || e);
    await insertRun(jobKey, ymd, false, msg, source).catch(() => {});
    await notifyAdminsOnFailure(jobKey, msg);
    throw e;
  }
}

/**
 * startCronRetrySweeper 已废弃——不再做全局兜底重试。
 * 保留空函数避免 index.js 调用报错；调用方可逐步移除。
 */
export function startCronRetrySweeper(_getFlags) {
  logger.info('sweepCronRetries disabled: jobs run once at scheduled time; failures trigger Feishu admin alert');
}

// 以下两个函数供外部查询日志用，不再供 sweep 内部使用
export async function hasSuccessToday(jobKey, runYmd) {
  await ensureCronRunTable();
  const r = await query(
    `SELECT 1 FROM ${TABLE} WHERE job_key = $1 AND run_ymd = $2 AND ok = true LIMIT 1`,
    [jobKey, runYmd]
  );
  return (r.rows || []).length > 0;
}

export async function countRunsToday(jobKey, runYmd) {
  await ensureCronRunTable();
  const r = await query(
    `SELECT COUNT(*)::int AS c FROM ${TABLE} WHERE job_key = $1 AND run_ymd = $2`,
    [jobKey, runYmd]
  );
  return Number(r.rows?.[0]?.c || 0);
}
