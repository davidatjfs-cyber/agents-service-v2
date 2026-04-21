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
import { runWithCronLog } from '../utils/cron-run-monitor.js';
import { runAnomalyChecks } from './anomaly-engine.js';
import { pushRhythmReport } from './feishu-client.js';
import { buildTableVisitKpiMarkdownSection, getBadReviewRowsForStoreDateRange } from './deterministic-replies.js';
import { checkCampaignProgress, evaluateCompletedCampaigns } from './agent-collaboration.js';
import { getRhythmSchedule } from './config-service.js';
import { getShanghaiYmd, sendReportToRecipient } from './report-delivery.js';
import { sendWeeklyDishOptimizationReport, sendMonthlyDishOptimizationReport } from './dish-optimization-report.js';
import { generateDissatisfiedProductDailyReport, generateDissatisfiedProductWeeklyReport, generateDissatisfiedProductMonthlyReport } from './dissatisfied-product-report.js';
import { flushPendingNotifications } from './anomaly-notify-queue.js';

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

function shanghaiTodayYmd() {
  return new Date().toLocaleString('en-CA', { timeZone: 'Asia/Shanghai' }).slice(0, 10);
}

/** 按上海日历在日序上加减天数，返回 YYYY-MM-DD */
function addCalendarDaysYmdShanghai(ymd, deltaDays) {
  const t = new Date(`${ymd}T12:00:00+08:00`);
  t.setUTCDate(t.getUTCDate() + deltaDays);
  return t.toLocaleString('en-CA', { timeZone: 'Asia/Shanghai' }).slice(0, 10);
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

    // BI 异常已在 anomaly-engine 落库时立刻通知责任人，此处不再重复 push，避免重复卡片

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

  // 周度异常已在周日22:00触发，此处仅读取已有数据生成报告，不再重复检测
  const { weekStart, weekEnd } = await (async () => {
    const { shanghaiLastCompletedWeekBounds } = await import('../utils/anomaly-week-bounds.js');
    return shanghaiLastCompletedWeekBounds();
  })();
  const weeklyResults = [];
  try {
    const r = await query(
      `SELECT anomaly_key, store, brand, severity, trigger_date, trigger_value
       FROM anomaly_triggers
       WHERE trigger_date >= $1::date AND trigger_date <= $2::date
         AND anomaly_key IN ('revenue_achievement', 'labor_efficiency', 'table_visit_product', 'table_visit_ratio', 'bad_review_product', 'bad_review_service', 'recharge_zero')
       ORDER BY CASE severity WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END`,
      [weekStart, weekEnd]
    );
    weeklyResults.push(...r.rows.map(row => ({ ...row, triggered: true })));
  } catch (_e) { /* ignore */ }

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
              ROUND(AVG(actual_revenue)::numeric, 0) AS avg_revenue,
              ROUND(SUM(actual_revenue)::numeric, 0) AS total_revenue,
              ROUND(AVG(dine_orders)::numeric, 0) AS avg_tables,
              ROUND(AVG(dine_traffic)::numeric, 0) AS avg_guests
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
  // ── 包房使用数(本周) ──
  try {
    const prR = await query(
      `SELECT store, SUM(COALESCE(private_room_uses, 0))::int AS total
       FROM daily_reports
       WHERE date >= $1::date AND date <= $2::date AND private_room_uses IS NOT NULL
       GROUP BY store`,
      [addCalendarDaysYmdShanghai(shanghaiTodayYmd(), -6), shanghaiTodayYmd()]
    );
    if (prR.rows?.length) {
      wkLines.push('');
      wkLines.push('🏠 包房使用(本周):');
      let prTotal = 0;
      for (const s of prR.rows) {
        prTotal += Number(s.total) || 0;
        wkLines.push(`  ${s.store}: ${s.total}次`);
      }
      wkLines.push(`  **合计: ${prTotal}次**`);
      summary.privateRoomUses = prR.rows;
    }
  } catch (e) { logger.warn({ err: e?.message }, 'weekly private_room_uses query failed'); }

  // ── 差评数(本周) ──
  try {
    const brEnd = shanghaiTodayYmd();
    const brStart = addCalendarDaysYmdShanghai(brEnd, -6);
    const allBr = await query(
      `SELECT fields, created_at FROM feishu_generic_records WHERE config_key='bad_review' ORDER BY updated_at DESC LIMIT 3000`
    );
    const brByStore = new Map();
    for (const row of allBr.rows || []) {
      const f = row.fields && typeof row.fields === 'object' ? row.fields : {};
      const storeField = String(f['差评门店'] || f['门店'] || f['所属门店'] || '').trim();
      const dField = f['创建日期'] || f['日期'] || f['提交时间'] || f['评价日期'];
      let d = '';
      if (dField) {
        if (typeof dField === 'number') {
          const dt = new Date((dField - 25569) * 86400000);
          d = dt.toLocaleString('en-CA', { timeZone: 'Asia/Shanghai' }).slice(0, 10);
        } else {
          d = String(dField).slice(0, 10);
        }
      }
      if (!d) d = row.created_at ? new Date(row.created_at).toLocaleString('en-CA', { timeZone: 'Asia/Shanghai' }).slice(0, 10) : '';
      if (!d || d < brStart || d > brEnd) continue;
      for (const s of stores) {
        if (storeField.includes(s) || s.includes(storeField)) {
          brByStore.set(s, (brByStore.get(s) || 0) + 1);
        }
      }
    }
    let brTotal = 0;
    if (brByStore.size) {
      wkLines.push('');
      wkLines.push('💬 差评数(本周):');
      for (const [s, cnt] of brByStore) {
        brTotal += cnt;
        wkLines.push(`  ${s}: ${cnt}条`);
      }
      wkLines.push(`  **合计: ${brTotal}条**`);
      summary.badReviews = brByStore;
    }
  } catch (e) { logger.warn({ err: e?.message }, 'weekly bad_review query failed'); }

  if (!opsData.length && !summary.kpiByStore?.length && !summary.top3ProblemStores?.length && !summary.privateRoomUses && !summary.badReviews) {
    wkLines.push('暂无本周运营数据');
  }

  const wkEnd = shanghaiTodayYmd();
  const wkStart = addCalendarDaysYmdShanghai(wkEnd, -6);
  const tvBlocks = [];
  for (const st of stores) {
    const block = await buildTableVisitKpiMarkdownSection(st, wkStart, wkEnd, { skipIfEmpty: true }).catch(() => '');
    if (block) tvBlocks.push(block);
  }
  if (tvBlocks.length) {
    wkLines.push('', `🪑 **桌访经营 KPI（${wkStart}～${wkEnd}）**`);
    wkLines.push(...tvBlocks.slice(0, 12));
    if (tvBlocks.length > 12) wkLines.push(`…余 ${tvBlocks.length - 12} 家门店有桌访数据（略）`);
  }

  await pushRhythmReport(wkLines.join('\n')).catch(() => {});

  return summary;
}

// ─── 月度评估 ───
export async function monthlyEvaluation() {
  logger.info('📈 Running monthly evaluation');
  const stores = await getActiveStores();

  // 月度异常已在月末最后一天22:00（营收）和10号08:00（毛利率）触发，此处仅读取已有数据
  const monthlyResults = [];
  try {
    const r = await query(
      `SELECT anomaly_key, store, brand, severity, trigger_date, trigger_value
       FROM anomaly_triggers
       WHERE trigger_date >= CURRENT_DATE - 35
         AND anomaly_key IN ('revenue_achievement_monthly', 'gross_margin')
       ORDER BY CASE severity WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END`
    );
    monthlyResults.push(...r.rows.map(row => ({ ...row, triggered: true })));
  } catch (_e) { /* ignore */ }

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

  const moEnd = shanghaiTodayYmd();
  const moStart = addCalendarDaysYmdShanghai(moEnd, -29);
  const moTv = [];
  for (const st of stores) {
    const block = await buildTableVisitKpiMarkdownSection(st, moStart, moEnd, { skipIfEmpty: true }).catch(() => '');
    if (block) moTv.push(block);
  }
  let moBody = `📈 月度评估\n检测: ${summary.monthlyChecks} | 触发: ${summary.triggered}\n门店KPI: ${(summary.kpiByStore || []).length}店已汇总`;

  // ── 包房使用数(本月) ──
  try {
    const { y, m } = (await import('../utils/anomaly-week-bounds.js')).getShanghaiYmdParts();
    let pm = m - 1, py = y;
    if (pm < 1) { pm = 12; py -= 1; }
    const moPeriod = `${py}-${String(pm).padStart(2, '0')}`;
    const daysInMonth = new Date(py, pm, 0).getDate();
    const moStart = `${py}-${String(pm).padStart(2, '0')}-01`;
    const moEnd = `${py}-${String(pm).padStart(2, '0')}-${String(daysInMonth).padStart(2, '0')}`;
    const prR = await query(
      `SELECT store, SUM(COALESCE(private_room_uses, 0))::int AS total
       FROM daily_reports
       WHERE date >= $1::date AND date <= $2::date AND private_room_uses IS NOT NULL
       GROUP BY store`,
      [moStart, moEnd]
    );
    if (prR.rows?.length) {
      moBody += '\n\n🏠 **包房使用（上月）**:';
      let prTotal = 0;
      for (const s of prR.rows) {
        prTotal += Number(s.total) || 0;
        moBody += `\n  ${s.store}: ${s.total}次`;
      }
      moBody += `\n  **合计: ${prTotal}次**`;
    }
  } catch (e) { logger.warn({ err: e?.message }, 'monthly private_room_uses failed'); }

  // ── 差评数(本月) ──
  try {
    const { y, m } = (await import('../utils/anomaly-week-bounds.js')).getShanghaiYmdParts();
    let pm = m - 1, py = y;
    if (pm < 1) { pm = 12; py -= 1; }
    const moPeriod = `${py}-${String(pm).padStart(2, '0')}`;
    const daysInMonth = new Date(py, pm, 0).getDate();
    const moStart = `${py}-${String(pm).padStart(2, '0')}-01`;
    const moEnd = `${py}-${String(pm).padStart(2, '0')}-${String(daysInMonth).padStart(2, '0')}`;
    const allBr = await query(
      `SELECT fields, created_at FROM feishu_generic_records WHERE config_key='bad_review' ORDER BY updated_at DESC LIMIT 3000`
    );
    const brByStore = new Map();
    for (const row of allBr.rows || []) {
      const f = row.fields && typeof row.fields === 'object' ? row.fields : {};
      const storeField = String(f['差评门店'] || f['门店'] || f['所属门店'] || '').trim();
      const dField = f['创建日期'] || f['日期'] || f['提交时间'] || f['评价日期'];
      let d = '';
      if (dField) {
        if (typeof dField === 'number') {
          const dt = new Date((dField - 25569) * 86400000);
          d = dt.toLocaleString('en-CA', { timeZone: 'Asia/Shanghai' }).slice(0, 10);
        } else {
          d = String(dField).slice(0, 10);
        }
      }
      if (!d) d = row.created_at ? new Date(row.created_at).toLocaleString('en-CA', { timeZone: 'Asia/Shanghai' }).slice(0, 10) : '';
      if (!d || d < moStart || d > moEnd) continue;
      for (const s of stores) {
        if (storeField.includes(s) || s.includes(storeField)) {
          brByStore.set(s, (brByStore.get(s) || 0) + 1);
        }
      }
    }
    if (brByStore.size) {
      moBody += '\n\n💬 **差评数（上月）**:';
      let brTotal = 0;
      for (const [s, cnt] of brByStore) {
        brTotal += cnt;
        moBody += `\n  ${s}: ${cnt}条`;
      }
      moBody += `\n  **合计: ${brTotal}条**`;
    }
  } catch (e) { logger.warn({ err: e?.message }, 'monthly bad_review failed'); }

  if (moTv.length) {
    moBody += `\n\n🪑 **桌访经营 KPI（${moStart}～${moEnd}）**\n${moTv.slice(0, 12).join('\n\n')}`;
    if (moTv.length > 12) moBody += `\n…余 ${moTv.length - 12} 家门店有桌访数据（略）`;
  }
  await pushRhythmReport(moBody).catch(() => {});

  return summary;
}

/** HRMS `employees` 表：门店在编人数（与考勤日报「门店总人数」对齐；营业日报 staff JSON 结构多变不可依赖） */
async function fetchHrmsHeadcountForStore(store) {
  const s = String(store || '').trim();
  if (!s) return 0;
  try {
    const r = await query(
      `SELECT COUNT(DISTINCT username)::int AS c FROM employees
       WHERE TRIM(COALESCE(store, '')) ILIKE '%' || $1 || '%'
         AND (status IS NULL OR TRIM(LOWER(status)) NOT IN (
           'inactive','resigned','离职','已离职','leaved','dimission','terminated',
           'quit','dismissed','离开'
         ))`,
      [s]
    );
    return Number(r.rows?.[0]?.c || 0);
  } catch (e) {
    logger.warn({ err: e?.message, store: s }, 'fetchHrmsHeadcountForStore failed');
    return 0;
  }
}

/** 当日 PG 营业日报是否已落库（考勤日报唯一数据源；与 hrms_state 双写延迟解耦） */
function countStoresWithTodayDailyReport(allStoresData) {
  return (allStoresData || []).filter((sd) => !!sd?.dailyReport).length;
}

// ─── 考勤日报 — 考勤 + 人效 + 排班建议（飞书卡片推送）
// 首跑 22:30 + 补跑 23:10：与营业日报「提交后再写 PG」对齐；若仍无行则补跑重试。
export async function dailyAttendanceReport() {
  logger.info('📋 Running daily attendance report');
  const today = getShanghaiYmd();
  const stores = await getActiveStores();
  if (!stores.length) { logger.warn('dailyAttendanceReport: no active stores'); return; }

  const allStoresData = [];
  for (const store of stores) {
    const sd = { store, allStaff: [], dailyReport: null, hrmsEmployeeCount: 0 };

    // 全部注册员工
    const allStaffR = await query(
      `SELECT username, name, role FROM feishu_users
       WHERE registered = true AND trim(store) ILIKE '%' || $1 || '%'
       ORDER BY role, username`,
      [store]
    );
    sd.allStaff = allStaffR.rows || [];
    sd.hrmsEmployeeCount = await fetchHrmsHeadcountForStore(store);

    // 营业日报（仅 PostgreSQL daily_reports；若双写失败则此处无行 → 与 HRMS 前端「有数据」不一致）
    const drR = await query(
      `SELECT actual_revenue, labor_total, efficiency, pre_discount_revenue,
              segments, staff, schedule_next_day
       FROM daily_reports
       WHERE date = $1::date AND store ILIKE '%' || $2 || '%'
       LIMIT 1`,
      [today, store]
    );
    sd.dailyReport = drR.rows?.[0] || null;

    allStoresData.push(sd);
  }

  const readyN = countStoresWithTodayDailyReport(allStoresData);
  const missingStores = allStoresData.filter((sd) => !sd.dailyReport).map((sd) => sd.store);
  if (readyN === 0 && stores.length > 0) {
    logger.warn(
      { today, storeSample: stores.slice(0, 5), missingN: missingStores.length },
      'dailyAttendanceReport: 当日 daily_reports 无行（可能未到保存时间、或 HRMS→PG 双写失败）；飞书发送将标为失败以便补跑重试'
    );
  } else if (missingStores.length) {
    logger.info(
      { today, readyN, missingSome: missingStores.slice(0, 8) },
      'dailyAttendanceReport: 部分门店缺当日 PG 营业日报，卡片将仅包含有数门店'
    );
  }

  // 构建飞书卡片
  const card = buildAttendanceCard(allStoresData, today);

  // 推送
  const { sendCard, sendText } = await import('./feishu-client.js');
  const runYmd = today;
  /** 按接收人维度统计；仅当「至少应发 1 人且全员失败」时才抛错触发管理员飞书告警，避免个别人 open_id/网络问题误报整任务失败 */
  let deliveryAttempted = 0;
  let deliveryOk = 0;
  let deliveryFailed = 0;

  // admin + hq_manager 收到所有门店
  const hq = await query(
    `SELECT open_id, username FROM feishu_users
     WHERE registered = true AND open_id IS NOT NULL AND role IN ('admin','hq_manager')`
  );
  for (const u of hq.rows || []) {
    deliveryAttempted++;
    const deliver = await sendReportToRecipient({
      jobKey: 'daily_attendance_report',
      runYmd,
      username: u.username || u.open_id,
      scope: 'hq_summary',
      sendFn: async () => {
        const res = await sendCard(u.open_id, card, 'open_id').catch(() => ({ ok: false }));
        if (res?.ok) {
          if (readyN === 0 && stores.length > 0) {
            return { ok: false, error: 'no_pg_daily_report_for_today' };
          }
          return { ok: true };
        }
        const textRes = await sendText(u.open_id, `📋 出勤日报 ${today}`, 'open_id').catch(() => ({ ok: false }));
        if (textRes?.ok) {
          if (readyN === 0 && stores.length > 0) {
            return { ok: false, error: 'no_pg_daily_report_for_today' };
          }
          return { ok: true };
        }
        return { ok: false, error: res?.error || textRes?.error || '' };
      }
    });
    if (deliver?.ok) {
      deliveryOk++;
    } else {
      deliveryFailed++;
      logger.warn({ username: u.username, err: deliver?.error }, 'attendance card push to HQ failed after retries');
    }
  }

  // 店长 + 出品经理 收到自己门店（单独卡片）
  for (const sd of allStoresData) {
    const sms = await query(
      `SELECT open_id, username FROM feishu_users
       WHERE registered = true AND open_id IS NOT NULL
         AND role IN ('store_manager','store_production_manager')
         AND trim(store) ILIKE '%' || $1 || '%'`,
      [sd.store]
    );
    if (sms.rows?.length) {
      const storeCard = buildStoreCard(sd, today);
      let hasDr = false;
      try {
        hasDr = parseStoreData(sd) != null;
      } catch (e) {
        logger.warn({ store: sd.store, err: e?.message }, 'dailyAttendanceReport: parseStoreData failed');
      }
      for (const u of sms.rows) {
        deliveryAttempted++;
        const deliver = await sendReportToRecipient({
          jobKey: 'daily_attendance_report',
          runYmd,
          username: u.username || u.open_id,
          scope: `store_${sd.store}`,
          sendFn: async () => {
            const res = await sendCard(u.open_id, storeCard, 'open_id').catch(() => ({ ok: false }));
            if (res?.ok) {
              if (!hasDr) {
                return { ok: false, error: 'no_pg_daily_report_for_store_today' };
              }
              return { ok: true };
            }
            const textRes = await sendText(u.open_id, `📋 ${sd.store} 出勤日报 ${today}`, 'open_id').catch(() => ({ ok: false }));
            if (textRes?.ok) {
              if (!hasDr) {
                return { ok: false, error: 'no_pg_daily_report_for_store_today' };
              }
              return { ok: true };
            }
            return { ok: false, error: res?.error || textRes?.error || '' };
          }
        });
        if (deliver?.ok) {
          deliveryOk++;
        } else {
          deliveryFailed++;
          logger.warn({ username: u.username, store: sd.store, err: deliver?.error }, 'attendance card push to store failed after retries');
        }
      }
    }
  }

  if (deliveryAttempted > 0 && deliveryOk === 0) {
    throw new Error(`daily attendance report: all ${deliveryAttempted} recipient deliveries failed`);
  }
  if (deliveryFailed > 0) {
    logger.warn(
      { deliveryFailed, deliveryOk, deliveryAttempted, readyN, storeCount: stores.length },
      'daily attendance report: partial failures only (no admin Feishu alert; check logs / open_id for failed users)'
    );
  }
  logger.info(
    { hqPush: hq.rows?.length || 0, readyN, storeCount: stores.length, deliveryOk, deliveryFailed },
    'daily attendance report pushed'
  );
  await logRhythm('daily_attendance', 'success', {
    storeCount: stores.length,
    storesWithData: readyN,
    deliveryAttempted,
    deliveryOk,
    deliveryFailed
  });
  return { ok: true, storeCount: stores.length, storesWithData: readyN };
}

// ─── 飞书卡片构建 ───

function fmtDate(d) {
  if (!d) return '—';
  const dt = new Date(d);
  return `${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
}

function roleZh(r) {
  const m = { admin:'管理员', hq_manager:'总部营运', store_manager:'店长', store_production_manager:'出品经理', store_employee:'员工', hr_manager:'HR', cashier:'出纳' };
  return m[r] || r || '—';
}

/**
 * 与 HRMS 营业日报 `drSumStaff` 一致：每条上班/休息记录若 days 为有效正数则累加，否则按 **1**（全天）计。
 * 半天在前端存为 0.5。
 */
function sumHrmsStaffPersonDays(arr) {
  const list = Array.isArray(arr) ? arr : [];
  let sum = 0;
  for (const x of list) {
    const d = Number(x?.days);
    if (Number.isFinite(d) && d > 0) sum += d;
    else sum += 1;
  }
  return Math.round(sum * 100) / 100;
}

/** 合并当日休息人员（与 HRMS `drMergeUniqueStaffLists(restStaff, frontRestStaff, kitchenRestStaff)` 同序去重） */
function mergeDailyReportRestStaff(staffObj) {
  const so = staffObj && typeof staffObj === 'object' && !Array.isArray(staffObj) ? staffObj : {};
  const lists = [
    Array.isArray(so.restStaff) ? so.restStaff : [],
    Array.isArray(so.frontRestStaff) ? so.frontRestStaff : [],
    Array.isArray(so.kitchenRestStaff) ? so.kitchenRestStaff : []
  ];
  const seen = new Set();
  const out = [];
  for (const arr of lists) {
    for (const x of arr) {
      const u = String(x?.user || x?.username || '').trim().toLowerCase();
      const n = String(x?.name || '').trim();
      const key = u || n.toLowerCase();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push(x);
    }
  }
  return out;
}

function restShiftLabel(days) {
  const d = Number(days);
  if (Number.isFinite(d) && d > 0 && d < 1) return '半天';
  return '全天';
}

function formatDailyReportRestList(restMerged) {
  if (!restMerged.length) return '无';
  return restMerged
    .map((x) => {
      const name = String(x?.name || x?.user || x?.username || '').trim() || '—';
      const label = restShiftLabel(x?.days);
      return `${name}（休息${label}）`;
    })
    .join('、');
}

/** 从营业日报 staff 结构估算在岗人数（object：front/kitchen/restStaff 去重 user） */
function countStaffUsersFromDailyReport(staffObj) {
  if (!staffObj) return 0;
  if (Array.isArray(staffObj)) return staffObj.length;
  if (typeof staffObj !== 'object') return 0;
  const set = new Set();
  for (const key of ['front', 'kitchen', 'restStaff']) {
    const arr = Array.isArray(staffObj[key]) ? staffObj[key] : [];
    for (const s of arr) {
      if (s?.user) set.add(String(s.user).trim().toLowerCase());
    }
  }
  return set.size;
}

/** 构建单门店数据对象（供卡片使用） */
function parseStoreData(sd) {
  const dr = sd.dailyReport;
  if (!dr) return null;

  // staff 多为 JSON 对象 {front,kitchen,restStaff}；总人数以 HRMS employees 为准，其次日报去重，最后飞书注册人数
  const staffObj = dr.staff || {};
  const fromDailyDistinct = countStaffUsersFromDailyReport(staffObj);
  const feishuRegistered = Array.isArray(sd.allStaff) ? sd.allStaff.length : 0;
  const hrmsN = Number(sd.hrmsEmployeeCount || 0);
  const totalStaff =
    hrmsN > 0 ? hrmsN : (fromDailyDistinct > 0 ? fromDailyDistinct : feishuRegistered);

  const frontArr = Array.isArray(staffObj.front) ? staffObj.front : [];
  const kitchenArr = Array.isArray(staffObj.kitchen) ? staffObj.kitchen : [];
  const frontPersonDays = sumHrmsStaffPersonDays(frontArr);
  const kitchenPersonDays = sumHrmsStaffPersonDays(kitchenArr);
  const attendanceCount = Math.round((frontPersonDays + kitchenPersonDays) * 100) / 100;
  const attendanceRate = totalStaff > 0 ? Math.round((attendanceCount / totalStaff) * 100) : 0;
  const laborHours = parseFloat(dr.labor_total) || 0;

  const preRev = parseFloat(dr.pre_discount_revenue) || 0;
  const actualRev = parseFloat(dr.actual_revenue) || 0;
  const eff = parseFloat(dr.efficiency) || 0;

  const segmentsRaw = dr.segments || {};
  const seg = typeof segmentsRaw === 'string' ? JSON.parse(segmentsRaw) : segmentsRaw;
  const noonRev = parseFloat(seg.noon) || 0;
  const nightRev = parseFloat(seg.night) || 0;
  const afternoonRev = parseFloat(seg.afternoon) || 0;
  const noonRatio = preRev > 0 ? noonRev / preRev : 0.5;
  const nightRatio = preRev > 0 ? (nightRev + afternoonRev) / preRev : 0.5;
  const noonHours = Math.round(laborHours * noonRatio * 10) / 10;
  const nightHours = Math.round(laborHours * nightRatio * 10) / 10;
  const noonEff = noonHours > 0 ? Math.round(noonRev / noonHours) : 0;
  const nightEff = nightHours > 0 ? Math.round((nightRev + afternoonRev) / nightHours) : 0;

  const sched = typeof dr.schedule_next_day === 'string' ? JSON.parse(dr.schedule_next_day) : (dr.schedule_next_day || {});
  const tomorrowStaff = sched.staff || [];
  const tomorrowHeadcount = tomorrowStaff.reduce((sum, s) => sum + (parseFloat(s.days) || 1), 0);
  const tomorrowEst = parseFloat(sched.tomorrowGrossEstimate) || 0;
  const tomorrowEff = tomorrowHeadcount > 0 && tomorrowEst > 0 ? Math.round(tomorrowEst / tomorrowHeadcount) : 0;
  const frontStaff = sched.frontStaff || [];
  const kitchenStaff = sched.kitchenStaff || [];
  const morningStaff = sched.morningStaff || [];
  const afternoonStaff = sched.afternoonStaff || [];

  const restMerged = mergeDailyReportRestStaff(staffObj);
  const restPersonDays = sumHrmsStaffPersonDays(restMerged);
  const restNames = formatDailyReportRestList(restMerged);

  return {
    totalStaff, laborHours, attendanceCount, attendanceRate,
    frontPersonDays,
    kitchenPersonDays,
    restPersonDays,
    restNames,
    eff, actualRev, noonEff, nightEff,
    noonRev, nightRev: nightRev + afternoonRev, noonHours, nightHours,
    tomorrowEst, tomorrowHeadcount, tomorrowEff,
    frontCount: frontStaff.length, kitchenCount: kitchenStaff.length,
    morningCount: morningStaff.length, afternoonCount: afternoonStaff.length,
    morningNames: morningStaff.map(s => s.name).join('、'),
    afternoonNames: afternoonStaff.map(s => s.name).join('、')
  };
}

/** 构建完整考勤卡片（所有门店） */
function buildAttendanceCard(allStoresData, today) {
  const elements = [];

  // 标题
  elements.push({
    tag: 'div',
    text: { tag: 'lark_md', content: `**📋 考勤日报 · ${today}**` }
  });

  elements.push({ tag: 'hr' });

  const missingPg = (allStoresData || []).filter((s) => !s?.dailyReport).map((s) => s.store);
  const hasAny = (allStoresData || []).some((s) => !!s?.dailyReport);
  if (missingPg.length && hasAny) {
    elements.push({
      tag: 'div',
      text: {
        tag: 'lark_md',
        content:
          `> ⚠️ **部分门店缺当日 PostgreSQL \`daily_reports\` 行**（HRMS 前端有草稿但双写未落库时会出现）。` +
            `已跳过：${missingPg.slice(0, 14).join('、')}${missingPg.length > 14 ? ` 等共${missingPg.length}家` : ''}`
      }
    });
    elements.push({ tag: 'hr' });
  }

  for (const sd of allStoresData) {
    const d = parseStoreData(sd);
    if (!d) continue;

    // 门店标题
    elements.push({
      tag: 'div',
      text: { tag: 'lark_md', content: `**${sd.store}**` }
    });

    // 考勤（出勤/休息人数与 HRMS 营业日报「前厅+后厨上班」「当日休息」同一套 days 规则：缺省=1，半天=0.5）
    let attendText = `**一、考勤**\n`;
    attendText += `门店总人数：${d.totalStaff}人 ｜ 实际出勤：${d.attendanceCount}人（前厅${d.frontPersonDays}+后厨${d.kitchenPersonDays}）｜ ${d.laborHours}工时\n`;
    attendText += `出勤率：${d.attendanceRate}%（${d.attendanceCount}/${d.totalStaff}）\n`;
    attendText += `当日休息：折合 **${d.restPersonDays}** 人｜${d.restNames}`;
    elements.push({
      tag: 'div',
      text: { tag: 'lark_md', content: attendText }
    });

    // 人效
    let effText = `**二、人效**\n`;
    effText += `全天：¥${Math.round(d.eff).toLocaleString()}/人（实收¥${Math.round(d.actualRev).toLocaleString()} / ${d.laborHours}工时）\n`;
    effText += `午市：¥${d.noonEff.toLocaleString()}/工时（折前¥${Math.round(d.noonRev).toLocaleString()} / ${d.noonHours}工时）\n`;
    effText += `晚市：¥${d.nightEff.toLocaleString()}/工时（折前¥${Math.round(d.nightRev).toLocaleString()} / ${d.nightHours}工时）`;
    elements.push({
      tag: 'div',
      text: { tag: 'lark_md', content: effText }
    });

    // 明日排班
    let schedText = `**三、明日排班**\n`;
    schedText += `预计营业额：¥${d.tomorrowEst.toLocaleString()} ｜ 排班：${d.tomorrowHeadcount}人（前厅${d.frontCount}人，后厨${d.kitchenCount}人）\n`;
    schedText += `预计人效：¥${d.tomorrowEff.toLocaleString()}/人\n`;
    schedText += `早班（${d.morningCount}人）：${d.morningNames}\n`;
    schedText += `晚班（${d.afternoonCount}人）：${d.afternoonNames}`;
    elements.push({
      tag: 'div',
      text: { tag: 'lark_md', content: schedText }
    });

    elements.push({ tag: 'hr' });
  }

  // 排班建议
  let adviceText = `**📝 排班建议**\n`;
  adviceText += `1. 根据预计营业额调整排班，确保人效达标（洪潮¥1200/人，马己仙¥1500/人）\n`;
  adviceText += `2. 高峰期（午市11-14点，晚市17-20点）确保人手充足，前厅后厨配比1:1.5~1:2\n`;
  adviceText += `3. 合理安排休息日，避免连续工作日过长，建议每周至少休息1天\n`;
  adviceText += `4. 如预计人效低于标准，可减少非高峰期排班，或安排兼职/小时工\n`;
  adviceText += `5. 关注员工交叉培训，提升人员调配灵活性`;
  elements.push({
    tag: 'div',
    text: { tag: 'lark_md', content: adviceText }
  });

  // 底部备注
  elements.push({
    tag: 'note',
    elements: [{ tag: 'plain_text', content: '数据来源：营业日报 + 员工管理 · 每晚22:30自动推送' }]
  });

  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: `📋 考勤日报 · ${today}` },
      template: 'blue'
    },
    elements
  };
}

/** 构建单门店卡片（给店长/出品经理） */
function buildStoreCard(sd, today) {
  const d = parseStoreData(sd);
  const elements = [];

  elements.push({
    tag: 'div',
    text: { tag: 'lark_md', content: `**📋 考勤日报 · ${today}**` }
  });
  elements.push({ tag: 'hr' });

  if (!d) {
    elements.push({
      tag: 'div',
      text: { tag: 'lark_md', content: `**${sd.store}**\n今日暂无营业日报数据` }
    });
  } else {
    elements.push({
      tag: 'div',
      text: { tag: 'lark_md', content: `**${sd.store}**` }
    });

    let attendText = `**一、考勤**\n`;
    attendText += `门店总人数：${d.totalStaff}人 ｜ 实际出勤：${d.attendanceCount}人（前厅${d.frontPersonDays}+后厨${d.kitchenPersonDays}）｜ ${d.laborHours}工时\n`;
    attendText += `出勤率：${d.attendanceRate}%（${d.attendanceCount}/${d.totalStaff}）\n`;
    attendText += `当日休息：折合 **${d.restPersonDays}** 人｜${d.restNames}`;
    elements.push({ tag: 'div', text: { tag: 'lark_md', content: attendText } });

    let effText = `**二、人效**\n`;
    effText += `全天：¥${Math.round(d.eff).toLocaleString()}/人（实收¥${Math.round(d.actualRev).toLocaleString()} / ${d.laborHours}工时）\n`;
    effText += `午市：¥${d.noonEff.toLocaleString()}/工时（折前¥${Math.round(d.noonRev).toLocaleString()} / ${d.noonHours}工时）\n`;
    effText += `晚市：¥${d.nightEff.toLocaleString()}/工时（折前¥${Math.round(d.nightRev).toLocaleString()} / ${d.nightHours}工时）`;
    elements.push({ tag: 'div', text: { tag: 'lark_md', content: effText } });

    let schedText = `**三、明日排班**\n`;
    schedText += `预计营业额：¥${d.tomorrowEst.toLocaleString()} ｜ 排班：${d.tomorrowHeadcount}人（前厅${d.frontCount}人，后厨${d.kitchenCount}人）\n`;
    schedText += `预计人效：¥${d.tomorrowEff.toLocaleString()}/人\n`;
    schedText += `早班（${d.morningCount}人）：${d.morningNames}\n`;
    schedText += `晚班（${d.afternoonCount}人）：${d.afternoonNames}`;
    elements.push({ tag: 'div', text: { tag: 'lark_md', content: schedText } });
  }

  elements.push({ tag: 'hr' });

  let adviceText = `**📝 排班建议**\n`;
  adviceText += `1. 根据预计营业额调整排班，确保人效达标\n`;
  adviceText += `2. 高峰期确保人手充足，前厅后厨配比1:1.5~1:2\n`;
  adviceText += `3. 合理安排休息日，避免连续工作过长\n`;
  adviceText += `4. 如预计人效低于标准，可优化非高峰期排班\n`;
  adviceText += `5. 关注员工交叉培训，提升调配灵活性`;
  elements.push({ tag: 'div', text: { tag: 'lark_md', content: adviceText } });

  elements.push({
    tag: 'note',
    elements: [{ tag: 'plain_text', content: '数据来源：营业日报 + 员工管理 · 每晚22:30自动推送' }]
  });

  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: `📋 考勤日报 · ${today}` },
      template: 'green'
    },
    elements
  };
}

// 保留旧函数名供其他地方引用（已废弃）
function buildAttendanceDataText() { return ''; }
async function generateAttendanceReportWithLLM() { return null; }
function extractStoreSection() { return null; }
async function fallbackAttendanceReport() { return { ok: true, storeCount: 0, fallback: true }; }

function roleLabelZh(role) {
  const m = {
    admin: '管理员', hq_manager: '总部营运', store_manager: '店长',
    store_production_manager: '出品经理', store_employee: '员工',
    hr_manager: 'HR', cashier: '出纳'
  };
  return m[role] || role || '—';
}

// ─── 启动Cron调度（读取配置，尊重 enabled 开关） ───
// 产品约定（2026-03）：总部节律仅保留 **周报、月评**；晨检/午晚巡/日终暂不注册 cron（函数仍保留供手工 API 触发）。
export async function runAnomalyChecksForStores(frequency) {
  const storesR = await query(
    `SELECT DISTINCT store FROM daily_reports WHERE date >= CURRENT_DATE - 30 AND store IS NOT NULL`
  );
  const stores = (storesR.rows || []).map((x) => x.store).filter(Boolean);
  if (!stores.length) { logger.warn({ frequency }, 'runAnomalyChecksForStores: no active stores'); return; }
  logger.info({ frequency, stores }, `BI anomaly check (${frequency}) starting`);
  const results = await runAnomalyChecks(frequency, stores);
  const triggered = results.filter((r) => r.triggered);
  logger.info({ frequency, triggered: triggered.length, total: results.length }, `BI anomaly check (${frequency}) done`);
  return { triggered, total: results.length };
}

/** 上海日历当月最后一天 yyyy-mm-dd */
function shanghaiLastDayOfMonth() {
  const now = new Date();
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' });
  const s = fmt.format(now);
  const [y, m] = s.split('-').map(Number);
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${y}-${String(m).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
}

export function startRhythmScheduler() {
  // 周一 05:00 — 周度 BI（与日频 05:08、bitable 05:16 错开）
  cron.schedule('0 5 * * 1', async () => {
    try {
      await runWithCronLog('weekly_bi_anomaly', async () => {
        await runAnomalyChecksForStores('weekly');
      });
    } catch (e) {
      logger.error({ err: e?.message }, 'weekly anomaly check cron failed');
    }
  }, { timezone: 'Asia/Shanghai' });

  // 周一 10:06 周报（与每月1日 10:18 月评估错开）
  cron.schedule('6 10 * * 1', async () => {
    if (!await isRhythmTaskEnabled('weekly')) { logger.info('Cron: weekly report SKIPPED (disabled in config)'); return; }
    try {
      await runWithCronLog('rhythm_weekly_report', async () => {
        await weeklyReport();
      });
    } catch (e) {
      logger.error({ err: e }, 'Cron: weekly report failed');
    }
  }, { timezone: 'Asia/Shanghai' });

  // 每月1日 10:18 月度评估
  cron.schedule('18 10 1 * *', async () => {
    if (!await isRhythmTaskEnabled('monthly')) { logger.info('Cron: monthly evaluation SKIPPED (disabled in config)'); return; }
    try {
      await runWithCronLog('rhythm_monthly_evaluation', async () => {
        await monthlyEvaluation();
      });
    } catch (e) {
      logger.error({ err: e }, 'Cron: monthly evaluation failed');
    }
  }, { timezone: 'Asia/Shanghai' });

  // 每日 05:08 日频 BI（与周一 05:00 周度、05:16 bitable 错开）
  cron.schedule('8 5 * * *', async () => {
    try {
      await runWithCronLog('daily_bi_anomaly', async () => {
        await runAnomalyChecksForStores('daily');
      });
    } catch (e) {
      logger.error({ err: e?.message }, '日频 BI 检测 failed');
    }
  }, { timezone: 'Asia/Shanghai' });

  // 每日 09:05 — BI异常任务卡片发送（延迟队列刷新；周一间隔5分钟/平时间隔1分钟，避免集中轰炸）
  cron.schedule('5 9 * * *', async () => {
    try {
      await runWithCronLog('bi_anomaly_notify_flush', async () => {
        await flushPendingNotifications();
      });
    } catch (e) {
      logger.error({ err: e?.message }, 'BI anomaly notify flush failed');
    }
  }, { timezone: 'Asia/Shanghai' });

  // 每月1日 08:12 — 月度实收营收（与 08:02 执行力等错开）
  cron.schedule('12 8 1 * *', async () => {
    try {
      await runWithCronLog('monthly_revenue_anomaly', async () => {
        await runAnomalyChecksForStores('monthly');
      });
    } catch (e) {
      logger.error({ err: e?.message }, '月度实收营收检测 failed');
    }
  }, { timezone: 'Asia/Shanghai' });

  // 每日 22:30 — 考勤日报（依赖 PG daily_reports 当日行；营业日报仅「提交」后写入 PG）
  cron.schedule('30 22 * * *', async () => {
    try {
      await runWithCronLog('daily_attendance_report', async () => {
        await dailyAttendanceReport();
      });
    } catch (e) {
      logger.error({ err: e?.message }, 'daily attendance report failed');
    }
  }, { timezone: 'Asia/Shanghai' });

  // 每日 23:10 — 考勤日报补跑（首跑无 PG 数据时不落成功标记，此处可重发）
  cron.schedule('10 23 * * *', async () => {
    try {
      await runWithCronLog('daily_attendance_report_catchup', async () => {
        await dailyAttendanceReport();
      });
    } catch (e) {
      logger.error({ err: e?.message }, 'daily attendance report catch-up failed');
    }
  }, { timezone: 'Asia/Shanghai' });

  // 周一 08:30 — 菜品优化周报（按大类维度四象限分类）
  cron.schedule('30 8 * * 1', async () => {
    try {
      await runWithCronLog('weekly_dish_optimization', async () => {
        await sendWeeklyDishOptimizationReport();
      });
    } catch (e) {
      logger.error({ err: e }, 'Cron: weekly dish optimization report failed');
    }
  }, { timezone: 'Asia/Shanghai' });

  // 每月1日 08:10 — 菜品优化月报
  cron.schedule('10 8 1 * *', async () => {
    try {
      await runWithCronLog('monthly_dish_optimization', async () => {
        await sendMonthlyDishOptimizationReport();
      });
    } catch (e) {
      logger.error({ err: e }, 'Cron: monthly dish optimization report failed');
    }
  }, { timezone: 'Asia/Shanghai' });

  // 每日 22:00 — 不满意产品日报
  cron.schedule('0 22 * * *', async () => {
    try {
      await runWithCronLog('dissatisfied_product_daily', async () => {
        await generateDissatisfiedProductDailyReport();
      });
    } catch (e) {
      logger.error({ err: e }, 'Cron: dissatisfied product daily report failed');
    }
  }, { timezone: 'Asia/Shanghai' });

  // 周一 09:00 — 不满意产品周报（上周一~上周日）
  cron.schedule('0 9 * * 1', async () => {
    try {
      await runWithCronLog('dissatisfied_product_weekly', async () => {
        await generateDissatisfiedProductWeeklyReport();
      });
    } catch (e) {
      logger.error({ err: e }, 'Cron: dissatisfied product weekly report failed');
    }
  }, { timezone: 'Asia/Shanghai' });

  // 每月1日 09:00 — 不满意产品月报（上月）
  cron.schedule('0 9 1 * *', async () => {
    try {
      await runWithCronLog('dissatisfied_product_monthly', async () => {
        await generateDissatisfiedProductMonthlyReport();
      });
    } catch (e) {
      logger.error({ err: e }, 'Cron: dissatisfied product monthly report failed');
    }
  }, { timezone: 'Asia/Shanghai' });

  logger.info(
    '✅ HQ Rhythm Scheduler started — 周度BI(周一05:00)+日频BI(每日05:08)+BI通知发送(每日09:05)+月收(每月1日08:12)+周报(周一10:06)+月评(每月1日10:18)+考勤(每日22:30+补跑23:10)+菜品优化周报(周一08:30)+菜品优化月报(每月1日08:10)+不满意产品日报(每日22:00)+不满意产品周报(周一09:00)+不满意产品月报(每月1日09:00)'
  );
}
