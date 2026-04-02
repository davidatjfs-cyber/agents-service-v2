/**
 * HQ Rhythm Engine — 总部主管工作节奏
 * 
 * 09:30 晨检 — 昨日异常Top / 未闭环清单 / 阻塞事项
 * 11:30 巡检 — BI+DataAuditor规则检查+数据质量
 * 16:30 巡检 — 同上
 * 21:30 日终 — 闭环率/逾期率/提醒次数/证据链缺失+明日风险预告
 * 周一10:00 周报
 * 每月1日 月度评估
 */
import cron from 'node-cron';
import { query } from '../utils/db.js';
import { logger } from '../utils/logger.js';
import { runAnomalyChecks } from './anomaly-engine.js';
import { pushAnomalyAlert, pushRhythmReport } from './feishu-client.js';
import { checkCampaignProgress, evaluateCompletedCampaigns } from './agent-collaboration.js';
import { getRhythmSchedule } from './config-service.js';

// ─── 检查任务是否启用 ───
async function isRhythmTaskEnabled(taskKey) {
  try {
    const cfg = await getRhythmSchedule();
    const items = cfg?.rhythmItems;
    if (!Array.isArray(items) || !items.length) return true; // no config = all enabled
    const item = items.find(it => it.key === taskKey);
    if (!item) return true; // not in config = enabled by default
    return item.enabled !== false;
  } catch (e) {
    logger.warn({ err: e?.message, taskKey }, 'Failed to check rhythm config, defaulting to enabled');
    return true;
  }
}

// ─── 获取活跃门店列表 ───
async function getActiveStores() {
  const r = await query(
    `SELECT DISTINCT store FROM daily_reports WHERE date >= CURRENT_DATE - 30 AND store IS NOT NULL`
  );
  return r.rows.map(r => r.store);
}

// ─── 记录节奏执行日志 ───
async function logRhythm(type, status, summary, error = null) {
  try {
    await query(
      `INSERT INTO rhythm_logs (rhythm_type, execution_date, execution_time, status, result_summary, error_message)
       VALUES ($1, CURRENT_DATE, CURRENT_TIME, $2, $3, $4)`,
      [type, status, JSON.stringify(summary), error]
    );
  } catch (e) {
    logger.error({ err: e }, 'Failed to log rhythm');
  }
}

// ─── 09:30 晨检 ───
export async function morningStandup() {
  logger.info('🌅 Running morning standup');
  const stores = await getActiveStores();
  const summary = { stores: stores.length, anomalies: [], pendingTasks: 0, blockers: [] };

  try {
    // 1. 昨日新增异常 Top
    const newAnomalies = await query(
      `SELECT anomaly_key, store, severity, trigger_value
       FROM anomaly_triggers
       WHERE trigger_date = CURRENT_DATE - 1
       ORDER BY CASE severity WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END
       LIMIT 10`
    );
    summary.anomalies = newAnomalies.rows;

    // 2. 未闭环清单（按逾期排序）
    const pendingTasks = await query(
      `SELECT task_id, title, store, severity, status, created_at, timeout_at,
              EXTRACT(EPOCH FROM (now() - created_at))/3600 AS hours_open
       FROM master_tasks
       WHERE status NOT IN ('closed', 'settled')
       ORDER BY
         CASE WHEN timeout_at < now() THEN 0 ELSE 1 END,
         CASE severity WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
         created_at ASC
       LIMIT 20`
    );
    summary.pendingTasks = pendingTasks.rows.length;
    summary.taskList = pendingTasks.rows;

    // 3. 阻塞事项（超时未响应）
    const blockers = await query(
      `SELECT task_id, title, store, severity, status
       FROM master_tasks
       WHERE status = 'pending_response'
         AND (timeout_at IS NOT NULL AND timeout_at < now())
       ORDER BY created_at ASC`
    );
    summary.blockers = blockers.rows;

    await logRhythm('morning_standup', 'success', summary);
    logger.info({ pendingTasks: summary.pendingTasks, anomalies: summary.anomalies.length, blockers: summary.blockers.length }, '晨检完成');

    // ── 主动推送晨检报告 ──
    const lines = ['🌅 晨检报告'];
    if (summary.anomalies.length) lines.push(`昨日新增异常 ${summary.anomalies.length} 条: ` + summary.anomalies.slice(0, 5).map(a => `${a.store}/${a.anomaly_key}(${a.severity})`).join(', '));
    lines.push(`未闭环任务: ${summary.pendingTasks} | 阻塞事项: ${summary.blockers.length}`);
    if (summary.blockers.length) lines.push('⚠️ 阻塞: ' + summary.blockers.slice(0, 3).map(b => `${b.store}/${b.title}`).join(', '));
    await pushRhythmReport(lines.join('\n')).catch(e => logger.warn({ err: e?.message }, 'push morning failed'));

    return summary;
  } catch (err) {
    logger.error({ err }, 'Morning standup failed');
    await logRhythm('morning_standup', 'error', {}, err.message);
    throw err;
  }
}

// ─── 11:30 / 16:30 巡检 ───
export async function patrol(waveLabel = 'am') {
  logger.info({ wave: waveLabel }, '🔍 Running patrol');
  const stores = await getActiveStores();

  try {
    // 跑日频和周频异常检测
    const dailyResults = await runAnomalyChecks('daily', stores);
    const triggered = dailyResults.filter(r => r.triggered);

    // 红色通道检查
    const redChannel = await checkRedChannel(stores);

    const summary = {
      wave: waveLabel,
      stores: stores.length,
      checksRun: dailyResults.length,
      triggered: triggered.length,
      triggeredDetails: triggered,
      redChannelAlerts: redChannel
    };

    await logRhythm(`patrol_${waveLabel}`, 'success', summary);
    logger.info({ triggered: triggered.length, redChannel: redChannel.length }, `巡检(${waveLabel})完成`);

    // ── 主动推送异常告警到门店负责人 ──
    for (const t of triggered) {
      await pushAnomalyAlert(t.store, t.anomalyKey, t.severity, t.detail || '').catch(() => {});
    }
    // ── 推送红色通道告警到HQ ──
    const RED_TYPE_LABELS = { high_no_response_24h: '高危任务24h未响应', consecutive_3day: '连续3天指标异常', food_safety_open: '食品安全未结案' };
    if (redChannel.length) {
      await pushRhythmReport('🚨 红色通道告警 ' + redChannel.length + '条\n' + redChannel.slice(0, 5).map(a => {
        const label = RED_TYPE_LABELS[a.type] || a.type;
        const store = a.store || a.task?.store || '';
        const detail = a.anomaly || a.task?.title || '';
        return `• ${label} — ${store} ${detail}`;
      }).join('\n')).catch(() => {});
    }
    // ── 巡检摘要到HQ ──
    if (triggered.length) {
      await pushRhythmReport(`🔍 巡检(${waveLabel}) ${stores.length}店 | 触发${triggered.length}条异常`).catch(() => {});
    }

    return summary;
  } catch (err) {
    logger.error({ err }, `Patrol ${waveLabel} failed`);
    await logRhythm(`patrol_${waveLabel}`, 'error', {}, err.message);
    throw err;
  }
}

// ─── 红色通道检查 ───
async function checkRedChannel(stores) {
  const alerts = [];

  // 1. high + 24h未响应
  const highNoResponse = await query(
    `SELECT task_id, title, store, severity, created_at
     FROM master_tasks
     WHERE severity = 'high'
       AND status IN ('pending_audit', 'pending_dispatch', 'pending_response')
       AND created_at < now() - INTERVAL '24 hours'`
  );
  for (const t of highNoResponse.rows) {
    alerts.push({ type: 'high_no_response_24h', task: t });
  }

  // 2. 连续3天关键指标异常
  for (const store of stores) {
    const consecutive = await query(
      `SELECT anomaly_key, COUNT(DISTINCT trigger_date) AS days
       FROM anomaly_triggers
       WHERE store = $1 AND trigger_date >= CURRENT_DATE - 3
         AND anomaly_key IN ('revenue_achievement', 'labor_efficiency', 'gross_margin')
       GROUP BY anomaly_key
       HAVING COUNT(DISTINCT trigger_date) >= 3`,
      [store]
    );
    for (const r of consecutive.rows) {
      alerts.push({ type: 'consecutive_3day', store, anomaly: r.anomaly_key, days: r.days });
    }
  }

  // 3. 食品安全（任何未结案的food_safety触发记录）
  const foodSafety = await query(
    `SELECT * FROM anomaly_triggers
     WHERE anomaly_key = 'food_safety' AND status = 'open'
     ORDER BY created_at DESC LIMIT 5`
  );
  for (const t of foodSafety.rows) {
    alerts.push({ type: 'food_safety_open', trigger: t });
  }

  if (alerts.length > 0) {
    logger.error({ count: alerts.length }, '🚨 RED CHANNEL ALERTS');
  }
  return alerts;
}

// ─── 21:30 日终 ───
export async function endOfDay() {
  logger.info('🌙 Running end-of-day summary');

  try {
    // 闭环率
    const total = await query(`SELECT COUNT(*) AS cnt FROM master_tasks WHERE created_at >= CURRENT_DATE`);
    const closed = await query(`SELECT COUNT(*) AS cnt FROM master_tasks WHERE closed_at >= CURRENT_DATE`);
    const overdue = await query(`SELECT COUNT(*) AS cnt FROM master_tasks WHERE timeout_at < now() AND status NOT IN ('closed','settled')`);

    const totalCnt = parseInt(total.rows[0]?.cnt || 0);
    const closedCnt = parseInt(closed.rows[0]?.cnt || 0);
    const overdueCnt = parseInt(overdue.rows[0]?.cnt || 0);
    const closeRate = totalCnt ? ((closedCnt / totalCnt) * 100).toFixed(1) : '0.0';

    // 证据链缺失
    const noEvidence = await query(
      `SELECT COUNT(*) AS cnt FROM master_tasks
       WHERE status NOT IN ('closed','settled')
         AND (evidence_refs IS NULL OR evidence_refs = '[]'::jsonb)`
    );

    // 明日风险预告
    const tomorrowRisk = await query(
      `SELECT store, anomaly_key, severity, trigger_date
       FROM anomaly_triggers
       WHERE status = 'open' AND severity = 'high'
       ORDER BY created_at DESC LIMIT 10`
    );

    const summary = {
      closeRate,
      totalTasks: totalCnt,
      closedToday: closedCnt,
      overdueTasks: overdueCnt,
      noEvidenceTasks: parseInt(noEvidence.rows[0]?.cnt || 0),
      tomorrowRisks: tomorrowRisk.rows
    };

    await logRhythm('end_of_day', 'success', summary);
    logger.info(summary, '日终对账完成');

    // ── 检查营销活动进度 ──
    let campaignResults = [];
    try {
      campaignResults = await checkCampaignProgress();
      summary.activeCampaigns = campaignResults.length;
    } catch (e) { logger.warn({ err: e?.message }, 'campaign progress check failed'); }

    // ── P1: 评估已完成的营销活动效果 → 写入记忆 ──
    let evalResults = [];
    try {
      evalResults = await evaluateCompletedCampaigns();
      summary.evaluatedCampaigns = evalResults.length;
    } catch (e) { logger.warn({ err: e?.message }, 'campaign evaluation failed'); }

    // ── 主动推送日终报告 ──
    const eodLines = [
      '🌙 日终报告',
      `闭环率: ${closeRate}% (${closedCnt}/${totalCnt})`,
      `逾期任务: ${overdueCnt} | 证据缺失: ${summary.noEvidenceTasks}`,
    ];
    if (campaignResults.length) eodLines.push(`📢 活跃营销活动: ${campaignResults.length}个 — ` + campaignResults.slice(0, 3).map(c => `${c.store}/${c.title}(${c.progress})`).join(', '));
    if (summary.tomorrowRisks.length) eodLines.push('⚠️ 明日风险: ' + summary.tomorrowRisks.slice(0, 5).map(r => `${r.store}/${r.anomaly_key}`).join(', '));
    await pushRhythmReport(eodLines.join('\n')).catch(e => logger.warn({ err: e?.message }, 'push eod failed'));

    return summary;
  } catch (err) {
    logger.error({ err }, 'End of day failed');
    await logRhythm('end_of_day', 'error', {}, err.message);
    throw err;
  }
}

// ─── 周报生成 ───
export async function weeklyReport() {
  logger.info('📊 Generating weekly report');
  const stores = await getActiveStores();

  // 运行周频异常检测
  const weeklyResults = await runAnomalyChecks('weekly', stores);
  const triggered = weeklyResults.filter(r => r.triggered);

  // KPI汇总
  const kpiR = await query(
    `SELECT store,
            AVG(ttfr_p90_minutes) AS avg_ttfr,
            AVG(ttc_p90_hours) AS avg_ttc,
            AVG(timeout_rate) AS avg_timeout,
            AVG(first_pass_rate) AS avg_pass_rate,
            SUM(total_tasks) AS total_tasks,
            SUM(closed_tasks) AS closed_tasks
     FROM kpi_snapshots
     WHERE snapshot_date >= CURRENT_DATE - 7
     GROUP BY store`
  );

  // Top3问题门店
  const top3 = await query(
    `SELECT store, COUNT(*) AS anomaly_count
     FROM anomaly_triggers
     WHERE trigger_date >= CURRENT_DATE - 7 AND severity IN ('high','medium')
     GROUP BY store ORDER BY anomaly_count DESC LIMIT 3`
  );

  const summary = {
    weeklyChecks: weeklyResults.length,
    triggered: triggered.length,
    triggeredDetails: triggered,
    kpiByStore: kpiR.rows,
    top3ProblemStores: top3.rows
  };

  await logRhythm('weekly_report', 'success', summary);
  logger.info({ triggered: triggered.length }, '周报生成完成');

  // ── 运营数据汇总(来自daily_reports) ──
  let opsData = [];
  try {
    const opsR = await query(
      `SELECT store,
              COUNT(*) AS report_days,
              ROUND(AVG(revenue)::numeric, 0) AS avg_revenue,
              ROUND(SUM(revenue)::numeric, 0) AS total_revenue,
              ROUND(AVG(table_count)::numeric, 0) AS avg_tables,
              ROUND(AVG(guest_count)::numeric, 0) AS avg_guests
       FROM daily_reports
       WHERE date >= CURRENT_DATE - 7
       GROUP BY store`
    );
    opsData = opsR.rows;
    summary.opsDataByStore = opsData;
  } catch (e) { logger.warn({ err: e?.message }, 'weekly ops data query failed'); }

  // ── 主动推送周报 ──
  const wkLines = ['📊 本周运营周报'];
  wkLines.push(`异常检测: ${summary.weeklyChecks}项 | 触发异常: ${summary.triggered}项`);
  if (opsData.length) {
    wkLines.push('');
    wkLines.push('📈 门店运营数据(本周):');
    for (const s of opsData) {
      wkLines.push(`  ${s.store}: 总营收¥${s.total_revenue || 0} | 日均¥${s.avg_revenue || 0} | 日均桌数${s.avg_tables || 0} | 日均客数${s.avg_guests || 0} (${s.report_days}天数据)`);
    }
  }
  if (summary.kpiByStore?.length) {
    wkLines.push('');
    wkLines.push('📋 KPI汇总:');
    for (const k of summary.kpiByStore) {
      const closeRate = k.total_tasks > 0 ? ((k.closed_tasks / k.total_tasks) * 100).toFixed(1) : '-';
      wkLines.push(`  ${k.store}: 任务${k.total_tasks || 0}个 | 闭环率${closeRate}% | 超时率${(parseFloat(k.avg_timeout || 0) * 100).toFixed(1)}%`);
    }
  }
  if (summary.top3ProblemStores?.length) {
    wkLines.push('');
    wkLines.push('⚠️ 问题门店Top3: ' + summary.top3ProblemStores.map(s => `${s.store}(${s.anomaly_count}次异常)`).join(', '));
  }
  if (!opsData.length && !summary.kpiByStore?.length && !summary.top3ProblemStores?.length) {
    wkLines.push('暂无本周运营数据');
  }
  await pushRhythmReport(wkLines.join('\n')).catch(() => {});

  return summary;
}

// ─── 月度评估 ───
export async function monthlyEvaluation() {
  logger.info('📈 Running monthly evaluation');
  const stores = await getActiveStores();

  // 运行月频检测
  const monthlyResults = await runAnomalyChecks('monthly', stores);

  // 月度KPI汇总
  const kpiR = await query(
    `SELECT store,
            AVG(ttfr_p90_minutes) AS avg_ttfr,
            AVG(ttc_p90_hours) AS avg_ttc,
            AVG(timeout_rate) AS avg_timeout,
            AVG(false_positive_rate) AS avg_fp,
            AVG(evidence_coverage_rate) AS avg_evidence,
            AVG(first_pass_rate) AS avg_pass_rate,
            SUM(total_tasks) AS total_tasks,
            SUM(closed_tasks) AS closed_tasks,
            SUM(overdue_tasks) AS overdue_tasks
     FROM kpi_snapshots
     WHERE snapshot_date >= CURRENT_DATE - 30
     GROUP BY store`
  );

  const summary = {
    monthlyChecks: monthlyResults.length,
    triggered: monthlyResults.filter(r => r.triggered).length,
    kpiByStore: kpiR.rows
  };

  await logRhythm('monthly_evaluation', 'success', summary);
  logger.info(summary, '月度评估完成');

  // ── 主动推送月度评估 ──
  await pushRhythmReport(`📈 月度评估\n检测: ${summary.monthlyChecks} | 触发: ${summary.triggered}\n门店KPI: ${(summary.kpiByStore||[]).length}店已汇总`).catch(() => {});

  return summary;
}

// ─── 启动Cron调度（读取配置，尊重enabled开关） ───
export function startRhythmScheduler() {
  // 09:30 晨检 (Asia/Shanghai)
  cron.schedule('30 9 * * *', async () => {
    if (!await isRhythmTaskEnabled('morning')) { logger.info('Cron: morning standup SKIPPED (disabled in config)'); return; }
    try { await morningStandup(); } catch (e) { logger.error({ err: e }, 'Cron: morning standup failed'); }
  }, { timezone: 'Asia/Shanghai' });

  // 11:30 巡检
  cron.schedule('30 11 * * *', async () => {
    if (!await isRhythmTaskEnabled('patrol_am')) { logger.info('Cron: AM patrol SKIPPED (disabled in config)'); return; }
    try { await patrol('am'); } catch (e) { logger.error({ err: e }, 'Cron: AM patrol failed'); }
  }, { timezone: 'Asia/Shanghai' });

  // 16:30 巡检
  cron.schedule('30 16 * * *', async () => {
    if (!await isRhythmTaskEnabled('patrol_pm')) { logger.info('Cron: PM patrol SKIPPED (disabled in config)'); return; }
    try { await patrol('pm'); } catch (e) { logger.error({ err: e }, 'Cron: PM patrol failed'); }
  }, { timezone: 'Asia/Shanghai' });

  // 21:30 日终
  cron.schedule('30 21 * * *', async () => {
    if (!await isRhythmTaskEnabled('eod')) { logger.info('Cron: end of day SKIPPED (disabled in config)'); return; }
    try { await endOfDay(); } catch (e) { logger.error({ err: e }, 'Cron: end of day failed'); }
  }, { timezone: 'Asia/Shanghai' });

  // 周一 10:00 周报
  cron.schedule('0 10 * * 1', async () => {
    if (!await isRhythmTaskEnabled('weekly')) { logger.info('Cron: weekly report SKIPPED (disabled in config)'); return; }
    try { await weeklyReport(); } catch (e) { logger.error({ err: e }, 'Cron: weekly report failed'); }
  }, { timezone: 'Asia/Shanghai' });

  // 每月1日 10:00 月度评估
  cron.schedule('0 10 1 * *', async () => {
    if (!await isRhythmTaskEnabled('monthly')) { logger.info('Cron: monthly evaluation SKIPPED (disabled in config)'); return; }
    try { await monthlyEvaluation(); } catch (e) { logger.error({ err: e }, 'Cron: monthly evaluation failed'); }
  }, { timezone: 'Asia/Shanghai' });

  logger.info('✅ HQ Rhythm Scheduler started — config-aware (晨检09:30 / 巡检11:30+16:30 / 日终21:30 / 周报周一10:00 / 月评每月1日)');
}
