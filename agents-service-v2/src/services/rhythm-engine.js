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
import { pushRhythmReport } from './feishu-client.js';
import { buildTableVisitKpiMarkdownSection } from './deterministic-replies.js';
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
  if (!opsData.length && !summary.kpiByStore?.length && !summary.top3ProblemStores?.length) {
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
  if (moTv.length) {
    moBody += `\n\n🪑 **桌访经营 KPI（${moStart}～${moEnd}）**\n${moTv.slice(0, 12).join('\n\n')}`;
    if (moTv.length > 12) moBody += `\n…余 ${moTv.length - 12} 家门店有桌访数据（略）`;
  }
  await pushRhythmReport(moBody).catch(() => {});

  return summary;
}

// ─── 22:00 考勤日报 — 打卡情况 + 休假 + 人效排班建议（本地 Ollama 生成） ───
export async function dailyAttendanceReport() {
  logger.info('📋 Running daily attendance report');
  const today = shanghaiTodayYmd();
  const stores = await getActiveStores();
  if (!stores.length) { logger.warn('dailyAttendanceReport: no active stores'); return; }

  // 收集所有门店数据
  const allStoresData = [];
  for (const store of stores) {
    const storeData = { store, checkins: [], allStaff: [], leaves: [], dailyReport: null };

    // 全部注册员工（先查，用于打卡匹配）
    const allStaffR = await query(
      `SELECT username, name, role FROM feishu_users
       WHERE registered = true AND trim(store) ILIKE '%' || $1 || '%'
       ORDER BY role, username`,
      [store]
    );
    storeData.allStaff = allStaffR.rows || [];

    // 打卡记录（只查注册员工的）
    const registeredUsernames = storeData.allStaff.map(e => String(e.username || '').toLowerCase());
    if (registeredUsernames.length > 0) {
      const checkinR = await query(
        `SELECT c.username, c.type, c.check_time, c.distance_meters, c.status,
                fu.name, fu.role
         FROM checkin_records c
         LEFT JOIN feishu_users fu ON lower(fu.username) = lower(c.username) AND fu.registered = true
         WHERE c.check_time::date = $1::date
           AND c.store ILIKE '%' || $2 || '%'
           AND lower(c.username) = ANY($3::text[])
         ORDER BY c.username, c.check_time`,
        [today, store, registeredUsernames]
      );
      storeData.checkins = checkinR.rows || [];
    }

    // 休假记录
    const leaveR = await query(
      `SELECT l.username, l.name, l.start_date, l.end_date, l.days, l.type, l.reason
       FROM hrms_leave_records l
       WHERE l.store ILIKE '%' || $1 || '%'
         AND l.start_date <= $2::date AND l.end_date >= $2::date
         AND l.status = 'approved'
       ORDER BY l.start_date`,
      [store, today]
    );
    storeData.leaves = leaveR.rows || [];

    // 营业日报
    const drR = await query(
      `SELECT actual_revenue, labor_total, efficiency, dine_orders, delivery_orders, dine_traffic,
              pre_discount_revenue, delivery_actual, gross_profit, recharge_count, recharge_amount
       FROM daily_reports
       WHERE date = $1::date AND store ILIKE '%' || $2 || '%'
       LIMIT 1`,
      [today, store]
    );
    storeData.dailyReport = drR.rows?.[0] || null;

    allStoresData.push(storeData);
  }

  // 构建数据文本供 Ollama 生成报告
  const dataText = buildAttendanceDataText(allStoresData, today);

  // 调用本地 Ollama 生成报告
  const reportText = await generateAttendanceReportWithLLM(dataText, today);

  if (!reportText) {
    logger.warn('dailyAttendanceReport: LLM generation failed, falling back to template');
    return await fallbackAttendanceReport(allStoresData, today);
  }

  logger.info({ storeCount: stores.length, reportLength: reportText.length }, 'daily attendance report generated by LLM');

  // 推送：admin + hq_manager 收到所有门店
  const { sendText } = await import('./feishu-client.js');
  const hq = await query(
    `SELECT open_id, username, name FROM feishu_users
     WHERE registered = true AND open_id IS NOT NULL AND role IN ('admin','hq_manager')`
  );
  for (const u of hq.rows || []) {
    await sendText(u.open_id, reportText, 'open_id').catch(e =>
      logger.warn({ err: e?.message, username: u.username }, 'daily attendance report push to HQ failed')
    );
  }

  // 推送：店长收到自己门店
  for (const sd of allStoresData) {
    const storeManagers = await query(
      `SELECT open_id, username, name FROM feishu_users
       WHERE registered = true AND open_id IS NOT NULL AND role = 'store_manager'
         AND trim(store) ILIKE '%' || $1 || '%'`,
      [sd.store]
    );
    // 从完整报告中提取该门店部分
    const storeSection = extractStoreSection(reportText, sd.store);
    if (storeSection && storeManagers.rows?.length) {
      for (const u of storeManagers.rows) {
        await sendText(u.open_id, storeSection, 'open_id').catch(e =>
          logger.warn({ err: e?.message, username: u.username }, 'daily attendance report push to store manager failed')
        );
      }
    }
  }

  logger.info({ hqPush: hq.rows?.length || 0 }, 'daily attendance report pushed');
  await logRhythm('daily_attendance', 'success', { storeCount: stores.length });
  return { ok: true, storeCount: stores.length };
}

function fmtCheckinTime(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  const h = String(d.getHours()).padStart(2, '0');
  const m = String(d.getMinutes()).padStart(2, '0');
  return `${h}:${m}`;
}

function fmtLeaveDate(d) {
  if (!d) return '—';
  const date = new Date(d);
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  return `${mm}-${dd}`;
}

function buildAttendanceDataText(allStoresData, today) {
  const roleLabel = (r) => {
    const m = { admin:'管理员', hq_manager:'总部营运', store_manager:'店长', store_production_manager:'出品经理', store_employee:'员工', hr_manager:'HR', cashier:'出纳' };
    return m[r] || r || '—';
  };
  const typeLabel = (t) => {
    const m = { annual:'年假', sick:'病假', personal:'事假' };
    return m[t] || '休假';
  };

  let text = `今天是${today}，以下是各门店考勤和人效数据：\n\n`;

  for (const sd of allStoresData) {
    text += `【${sd.store}】\n`;

    // 打卡
    const checkedIn = new Set();
    const clockInLines = [];
    for (const c of sd.checkins) {
      if (c.type === 'clock_in') {
        checkedIn.add(String(c.username || '').toLowerCase());
        const nm = String(c.name || c.username || '?');
        const timeStr = fmtCheckinTime(c.check_time);
        const dist = c.distance_meters ? `${Math.round(c.distance_meters)}m` : '';
        const mark = c.status === 'normal' ? '✅' : '⚠️';
        clockInLines.push(`${mark} ${nm}（${roleLabel(c.role)}）${timeStr}${dist ? ` ${dist}` : ''}`);
      }
    }
    const notCheckedIn = sd.allStaff
      .filter(e => !checkedIn.has(String(e.username || '').toLowerCase()))
      .map(e => `${String(e.name || e.username || '?')}（${roleLabel(e.role)}）`);

    text += `应到${sd.allStaff.length}人，实到${checkedIn.size}人\n`;
    if (clockInLines.length) text += `已打卡：${clockInLines.join('；')}\n`;
    if (notCheckedIn.length) text += `未打卡：${notCheckedIn.join('、')}\n`;

    // 休假
    if (sd.leaves.length) {
      const leaveLines = sd.leaves.map(lv => {
        const sd2 = fmtLeaveDate(lv.start_date);
        const ed = fmtLeaveDate(lv.end_date);
        return `${String(lv.name || lv.username || '?')}（${typeLabel(lv.type)} ${sd2}~${ed} ${lv.days}天）${lv.reason || ''}`;
      });
      text += `休假：${leaveLines.join('；')}\n`;
    } else {
      text += `休假：无人\n`;
    }

    // 人效
    if (sd.dailyReport) {
      const dr = sd.dailyReport;
      const eff = parseFloat(dr.efficiency) || 0;
      const labor = parseFloat(dr.labor_total) || 0;
      const revenue = parseFloat(dr.actual_revenue) || 0;
      const dineOrders = parseInt(dr.dine_orders) || 0;
      const deliveryOrders = parseInt(dr.delivery_orders) || 0;
      const dineTraffic = parseInt(dr.dine_traffic) || 0;
      const brand = sd.store.includes('洪潮') ? '洪潮' : '马己仙';
      const threshold = brand === '洪潮' ? 1200 : 1500;

      text += `实收¥${Math.round(revenue).toLocaleString()}，出勤${labor}人，人效¥${Math.round(eff).toLocaleString()}/人`;
      text += `（标准¥${threshold}/人）`;
      if (dineTraffic > 0 && labor > 0) text += `，堂食${dineTraffic}人/出勤${labor}人=每人${Math.round(dineTraffic/labor)}人`;
      text += `，堂食${dineOrders}桌，外卖${deliveryOrders}单\n`;
    } else {
      text += `营业日报：未提交\n`;
    }
    text += '\n';
  }

  return text;
}

async function generateAttendanceReportWithLLM(dataText, today) {
  try {
    const { callLLM } = await import('./llm-provider.js');
    const prompt = `你是年年有喜餐饮集团的HR考勤分析助手。请根据以下数据，生成一份简洁专业的考勤日报。

要求：
1. 开头用一句话总结今日整体考勤情况
2. 按门店分块，每块包含：打卡情况（应到/实到/未打卡人员）、休假情况、人效分析与排班建议
3. 人效分析要对比品牌标准（洪潮1200元/人，马己仙1500元/人），给出明确的排班优化建议
4. 语气专业但亲切，适当使用emoji
5. 总字数控制在800字以内
6. 使用markdown格式，门店名用**加粗**

数据：
${dataText}`;

    const result = await callLLM(
      [{ role: 'user', content: prompt }],
      { temperature: 0.3, max_tokens: 2000 }
    );

    if (result.ok && result.content) {
      return `📋 **考勤日报 · ${today}**\n\n${result.content.trim()}`;
    }
    logger.warn({ error: result.error }, 'LLM generation failed for attendance report');
    return null;
  } catch (e) {
    logger.error({ err: e?.message }, 'generateAttendanceReportWithLLM failed');
    return null;
  }
}

function extractStoreSection(fullReport, store) {
  // 尝试从完整报告中提取该门店的部分
  const lines = fullReport.split('\n');
  const storeIdx = lines.findIndex(l => l.includes(store));
  if (storeIdx === -1) return null;

  // 找到下一个门店名
  let endIdx = storeIdx + 1;
  while (endIdx < lines.length) {
    const line = lines[endIdx];
    // 如果这行包含另一个门店名（排除当前门店），说明到了下一块
    if (line.includes('洪潮') || line.includes('马己仙')) {
      if (!line.includes(store)) break;
    }
    endIdx++;
  }

  return lines.slice(storeIdx, endIdx).join('\n').trim();
}

async function fallbackAttendanceReport(allStoresData, today) {
  const roleLabel = (r) => {
    const m = { admin:'管理员', hq_manager:'总部营运', store_manager:'店长', store_production_manager:'出品经理', store_employee:'员工', hr_manager:'HR', cashier:'出纳' };
    return m[r] || r || '—';
  };
  const typeLabel = (t) => {
    const m = { annual:'年假', sick:'病假', personal:'事假' };
    return m[t] || '休假';
  };

  const lines = [`📋 **考勤日报 · ${today}`];

  for (const sd of allStoresData) {
    lines.push('');
    lines.push(`── **${sd.store}** ──`);

    const checkedIn = new Set();
    const clockInLines = [];
    for (const c of sd.checkins) {
      if (c.type === 'clock_in') {
        checkedIn.add(String(c.username || '').toLowerCase());
        const nm = String(c.name || c.username || '?');
        const timeStr = fmtCheckinTime(c.check_time);
        const dist = c.distance_meters ? `${Math.round(c.distance_meters)}m` : '';
        const mark = c.status === 'normal' ? '✅' : '⚠️';
        clockInLines.push(`  ${mark} ${nm}（${roleLabel(c.role)}）${timeStr}${dist ? ` · ${dist}` : ''}`);
      }
    }
    const notCheckedIn = sd.allStaff
      .filter(e => !checkedIn.has(String(e.username || '').toLowerCase()))
      .map(e => `${String(e.name || e.username || '?')}（${roleLabel(e.role)}）`);

    lines.push(`📍 **打卡**（应到 ${sd.allStaff.length} 人，实到 ${checkedIn.size} 人）`);
    if (clockInLines.length) lines.push(clockInLines.join('\n'));
    if (notCheckedIn.length) lines.push(`  ❌ 未打卡：${notCheckedIn.join('、')}`);

    if (sd.leaves.length) {
      lines.push(`🏖️ **休假**（${sd.leaves.length} 人）`);
      for (const lv of sd.leaves) {
        const sd2 = fmtLeaveDate(lv.start_date);
        const ed = fmtLeaveDate(lv.end_date);
        lines.push(`  ${String(lv.name || lv.username || '?')}（${typeLabel(lv.type)} ${sd2}~${ed}，${lv.days}天）${lv.reason ? ` · ${lv.reason}` : ''}`);
      }
    } else {
      lines.push('🏖️ **休假**：无人');
    }

    if (sd.dailyReport) {
      const dr = sd.dailyReport;
      const eff = parseFloat(dr.efficiency) || 0;
      const labor = parseFloat(dr.labor_total) || 0;
      const revenue = parseFloat(dr.actual_revenue) || 0;
      const dineOrders = parseInt(dr.dine_orders) || 0;
      const deliveryOrders = parseInt(dr.delivery_orders) || 0;
      const dineTraffic = parseInt(dr.dine_traffic) || 0;
      const brand = sd.store.includes('洪潮') ? '洪潮' : '马己仙';
      const threshold = brand === '洪潮' ? 1200 : 1500;

      lines.push(`💰 **人效**：¥${Math.round(eff).toLocaleString()}/人（实收 ¥${Math.round(revenue).toLocaleString()} / 出勤 ${labor} 人）`);

      const advice = [];
      if (eff > 0 && eff < threshold * 0.8) {
        advice.push(`⚠️ 人效偏低（低于标准20%），建议明日适当减少排班`);
      } else if (eff > 0 && eff < threshold) {
        advice.push(`📊 人效略低于标准，可优化高峰排班`);
      } else if (eff > 0 && eff < threshold * 1.2) {
        advice.push(`✅ 人效达标，排班合理`);
      } else if (eff > 0) {
        advice.push(`📈 人效优秀（超标准${Math.round((eff/threshold-1)*100)}%），持续偏高可考虑增加人手`);
      }
      if (dineTraffic > 0 && labor > 0) advice.push(`堂食 ${dineTraffic}人 / 出勤 ${labor}人 = 每人接待 ${Math.round(dineTraffic/labor)}人`);
      if (dineOrders > 0 || deliveryOrders > 0) advice.push(`堂食 ${dineOrders}桌 + 外卖 ${deliveryOrders}单`);
      if (advice.length) {
        lines.push(`📝 **排班建议**`);
        advice.forEach(a => lines.push(`  ${a}`));
      }
    } else {
      lines.push(`💰 **人效**：暂无营业日报`);
      lines.push(`📝 **排班建议**：请督促提交今日营业日报`);
    }
  }

  const reportText = lines.join('\n');
  const { sendText } = await import('./feishu-client.js');

  // admin + hq_manager 收到所有门店
  const hq = await query(
    `SELECT open_id, username FROM feishu_users
     WHERE registered = true AND open_id IS NOT NULL AND role IN ('admin','hq_manager')`
  );
  for (const u of hq.rows || []) {
    await sendText(u.open_id, reportText, 'open_id').catch(() => {});
  }

  // 店长收到自己门店
  for (const sd of allStoresData) {
    const sms = await query(
      `SELECT open_id FROM feishu_users
       WHERE registered = true AND open_id IS NOT NULL AND role = 'store_manager'
         AND trim(store) ILIKE '%' || $1 || '%'`,
      [sd.store]
    );
    const section = extractStoreSection(reportText, sd.store);
    if (section && sms.rows?.length) {
      for (const u of sms.rows) {
        await sendText(u.open_id, section, 'open_id').catch(() => {});
      }
    }
  }

  await logRhythm('daily_attendance', 'success', { storeCount: allStoresData.length, fallback: true });
  return { ok: true, storeCount: allStoresData.length, fallback: true };
}

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
async function runAnomalyChecksForStores(frequency) {
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
  // 周一 08:00 — 周度 BI 异常检测（revenue_achievement/labor_efficiency/table_visit/bad_review 等）
  cron.schedule('0 8 * * 1', async () => {
    try { await runAnomalyChecksForStores('weekly'); } catch (e) { logger.error({ err: e?.message }, 'weekly anomaly check cron failed'); }
  }, { timezone: 'Asia/Shanghai' });

  // 周一 10:00 周报（发送飞书汇总卡片，不重复触发异常检测）
  cron.schedule('0 10 * * 1', async () => {
    if (!await isRhythmTaskEnabled('weekly')) { logger.info('Cron: weekly report SKIPPED (disabled in config)'); return; }
    try { await weeklyReport(); } catch (e) { logger.error({ err: e }, 'Cron: weekly report failed'); }
  }, { timezone: 'Asia/Shanghai' });

  // 每月1日 10:00 月度评估
  cron.schedule('0 10 1 * *', async () => {
    if (!await isRhythmTaskEnabled('monthly')) { logger.info('Cron: monthly evaluation SKIPPED (disabled in config)'); return; }
    try { await monthlyEvaluation(); } catch (e) { logger.error({ err: e }, 'Cron: monthly evaluation failed'); }
  }, { timezone: 'Asia/Shanghai' });

  // 每日 08:00 充值异常检测（daily 频率，仅 recharge_zero）
  cron.schedule('0 8 * * *', async () => {
    try { await runAnomalyChecksForStores('daily'); } catch (e) { logger.error({ err: e?.message }, '充值异常日检 08:00 failed'); }
  }, { timezone: 'Asia/Shanghai' });

  // 每月1日 08:00 — 月度实收营收达成检测（revenue_achievement_monthly）
  cron.schedule('0 8 1 * *', async () => {
    try {
      await runAnomalyChecksForStores('monthly');
    } catch (e) { logger.error({ err: e?.message }, '月度实收营收检测 08:00 failed'); }
  }, { timezone: 'Asia/Shanghai' });

  // 每日 22:00 — 考勤日报（打卡+休假+人效排班建议）
  cron.schedule('0 22 * * *', async () => {
    try { await dailyAttendanceReport(); } catch (e) { logger.error({ err: e?.message }, 'daily attendance report 22:00 failed'); }
  }, { timezone: 'Asia/Shanghai' });

  logger.info('✅ HQ Rhythm Scheduler started — 周度BI(周一08:00)+周报(周一10:00)+月评(每月1日10:00)+充值日检(08:00)+月末月收(每月1日08:00)+考勤日报(每日22:00)');
}
