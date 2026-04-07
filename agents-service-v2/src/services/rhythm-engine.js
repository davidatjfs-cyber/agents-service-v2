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

// ─── 22:00 考勤日报 — 考勤 + 人效 + 排班建议（本地 Ollama 生成） ───
export async function dailyAttendanceReport() {
  logger.info('📋 Running daily attendance report');
  const today = shanghaiTodayYmd();
  const stores = await getActiveStores();
  if (!stores.length) { logger.warn('dailyAttendanceReport: no active stores'); return; }

  const allStoresData = [];
  for (const store of stores) {
    const sd = { store, allStaff: [], todayLeave: [], dailyReport: null };

    // 全部注册员工
    const allStaffR = await query(
      `SELECT username, name, role FROM feishu_users
       WHERE registered = true AND trim(store) ILIKE '%' || $1 || '%'
       ORDER BY role, username`,
      [store]
    );
    sd.allStaff = allStaffR.rows || [];

    // 今日休假
    const leaveR = await query(
      `SELECT l.username, l.name, l.start_date, l.end_date, l.days, l.type, l.reason
       FROM hrms_leave_records l
       WHERE l.store ILIKE '%' || $1 || '%'
         AND l.start_date <= $2::date AND l.end_date >= $2::date
         AND l.status = 'approved'
       ORDER BY l.start_date`,
      [store, today]
    );
    sd.todayLeave = leaveR.rows || [];

    // 营业日报
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

  // 构建结构化数据文本
  const dataText = buildAttendanceDataText(allStoresData, today);

  // 调用 LLM 生成报告
  const reportText = await generateAttendanceReportWithLLM(dataText, today);

  if (!reportText) {
    logger.warn('dailyAttendanceReport: LLM failed, using fallback');
    return await fallbackAttendanceReport(allStoresData, today);
  }

  logger.info({ storeCount: stores.length, reportLength: reportText.length }, 'daily attendance report generated by LLM');

  // 推送
  const { sendText } = await import('./feishu-client.js');

  // admin + hq_manager 收到所有门店
  const hq = await query(
    `SELECT open_id, username FROM feishu_users
     WHERE registered = true AND open_id IS NOT NULL AND role IN ('admin','hq_manager')`
  );
  for (const u of hq.rows || []) {
    await sendText(u.open_id, reportText, 'open_id').catch(e =>
      logger.warn({ err: e?.message, username: u.username }, 'attendance report push to HQ failed')
    );
  }

  // 店长 + 出品经理 收到自己门店
  for (const sd of allStoresData) {
    const sms = await query(
      `SELECT open_id, username FROM feishu_users
       WHERE registered = true AND open_id IS NOT NULL
         AND role IN ('store_manager','store_production_manager')
         AND trim(store) ILIKE '%' || $1 || '%'`,
      [sd.store]
    );
    const section = extractStoreSection(reportText, sd.store);
    if (section && sms.rows?.length) {
      for (const u of sms.rows) {
        await sendText(u.open_id, section, 'open_id').catch(e =>
          logger.warn({ err: e?.message, username: u.username }, 'attendance report push to store failed')
        );
      }
    }
  }

  logger.info({ hqPush: hq.rows?.length || 0 }, 'daily attendance report pushed');
  await logRhythm('daily_attendance', 'success', { storeCount: stores.length });
  return { ok: true, storeCount: stores.length };
}

function fmtDate(d) {
  if (!d) return '—';
  const dt = new Date(d);
  return `${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
}

function roleZh(r) {
  const m = { admin:'管理员', hq_manager:'总部营运', store_manager:'店长', store_production_manager:'出品经理', store_employee:'员工', hr_manager:'HR', cashier:'出纳' };
  return m[r] || r || '—';
}

function leaveTypeZh(t) {
  const m = { annual:'年假', sick:'病假', personal:'事假' };
  return m[t] || '休假';
}

function buildAttendanceDataText(allStoresData, today) {
  let text = `日期：${today}\n\n`;

  for (const sd of allStoresData) {
    text += `【${sd.store}】\n`;

    const dr = sd.dailyReport;
    if (!dr) {
      text += `一、考勤：暂无数据\n`;
      text += `二、人效：暂无数据\n`;
      text += `三、明日排班：暂无数据\n\n`;
      continue;
    }

    // 门店总人数 = daily_reports.staff 数组长度（员工管理里的实际人数）
    const staffData = typeof dr.staff === 'string' ? JSON.parse(dr.staff) : (dr.staff || []);
    const totalStaff = staffData.length;
    const laborHours = parseFloat(dr.labor_total) || 0;

    // 实际出勤人数 = staff 中排除今日休假人员
    const leaveUsernames = new Set(sd.todayLeave.map(lv => lv.username));
    const attendanceCount = staffData.filter(s => !leaveUsernames.has(s.user)).length;
    const attendanceRate = totalStaff > 0 ? Math.round((attendanceCount / totalStaff) * 100) : 0;

    text += `一、考勤\n`;
    text += `门店总人数：${totalStaff}人\n`;
    text += `实际出勤：${attendanceCount}人（${laborHours}工时）\n`;
    text += `出勤率：${attendanceRate}%\n`;

    // 今日休息人员（从 staff 中找岗位信息）
    const restNames = [];
    if (sd.todayLeave.length) {
      for (const lv of sd.todayLeave) {
        const emp = staffData.find(e => e.user === lv.username || e.name === lv.name);
        const roleName = emp ? '员工' : '—';
        const typeLabel = { annual: '年假', sick: '病假', personal: '事假' }[lv.type] || '休假';
        restNames.push(`${lv.name}（${roleName}，${typeLabel}）`);
      }
    }
    text += `今日休息：${restNames.length ? restNames.join('、') : '无'}\n\n`;

    // 人效
    const preRev = parseFloat(dr.pre_discount_revenue) || 0;
    const actualRev = parseFloat(dr.actual_revenue) || 0;
    const eff = parseFloat(dr.efficiency) || 0;
    const segments = typeof dr.segments === 'string' ? JSON.parse(dr.segments) : (dr.segments || {});
    const noonRev = parseFloat(segments.noon) || 0;
    const nightRev = parseFloat(segments.night) || 0;
    const afternoonRev = parseFloat(segments.afternoon) || 0;

    // 午市工时 ≈ labor_total * (noonRev / preRev)，晚市同理
    const noonRatio = preRev > 0 ? noonRev / preRev : 0.5;
    const nightRatio = preRev > 0 ? (nightRev + afternoonRev) / preRev : 0.5;
    const noonHours = Math.round(laborHours * noonRatio * 10) / 10;
    const nightHours = Math.round(laborHours * nightRatio * 10) / 10;
    const noonEff = noonHours > 0 ? Math.round(noonRev / noonHours) : 0;
    const nightEff = nightHours > 0 ? Math.round((nightRev + afternoonRev) / nightHours) : 0;

    text += `二、人效\n`;
    text += `全天人效：¥${Math.round(eff).toLocaleString()}/人（实收¥${Math.round(actualRev).toLocaleString()} / ${laborHours}工时）\n`;
    text += `午市人效：¥${noonEff.toLocaleString()}/工时（午市折前¥${Math.round(noonRev).toLocaleString()} / ${noonHours}工时）\n`;
    text += `晚市人效：¥${nightEff.toLocaleString()}/工时（晚市折前¥${Math.round(nightRev + afternoonRev).toLocaleString()} / ${nightHours}工时）\n\n`;

    // 明日排班
    const sched = typeof dr.schedule_next_day === 'string' ? JSON.parse(dr.schedule_next_day) : (dr.schedule_next_day || {});
    const tomorrowStaff = sched.staff || [];
    const tomorrowHeadcount = tomorrowStaff.reduce((sum, s) => sum + (parseFloat(s.days) || 1), 0);
    const tomorrowEst = parseFloat(sched.tomorrowGrossEstimate) || 0;
    const tomorrowEff = tomorrowHeadcount > 0 && tomorrowEst > 0 ? Math.round(tomorrowEst / tomorrowHeadcount) : 0;

    // 前后堂排班
    const frontStaff = sched.frontStaff || [];
    const kitchenStaff = sched.kitchenStaff || [];
    const morningStaff = sched.morningStaff || [];
    const afternoonStaff = sched.afternoonStaff || [];

    text += `三、明日排班\n`;
    text += `预计营业额：¥${tomorrowEst.toLocaleString()}\n`;
    text += `排班人数：${tomorrowHeadcount}人（前厅${frontStaff.length}人，后厨${kitchenStaff.length}人）\n`;
    text += `早班：${morningStaff.length}人（${morningStaff.map(s => s.name).join('、')}）\n`;
    text += `晚班：${afternoonStaff.length}人（${afternoonStaff.map(s => s.name).join('、')}）\n`;
    text += `预计人效：¥${tomorrowEff.toLocaleString()}/人\n`;
    text += '\n';
  }

  return text;
}

async function generateAttendanceReportWithLLM(dataText, today) {
  try {
    const { callLLM } = await import('./llm-provider.js');
    const prompt = `你是年年有喜HR考勤分析助手。请根据以下数据，生成一份格式整齐、简洁专业的考勤日报。

要求：
1. 开头用一句话总结今日整体考勤情况
2. 按门店分块，每块严格包含以下三部分，格式必须整齐对齐：
   ┌─ **门店名**
   │ 一、考勤
   │   门店总人数：X人
   │   实际出勤：X人（X工时）
   │   出勤率：X%
   │   今日休息：XXX（岗位，类型）
   │ 二、人效
   │   全天人效：¥X/人（实收¥X / X工时）
   │   午市人效：¥X/工时（午市折前¥X / X工时）
   │   晚市人效：¥X/工时（晚市折前¥X / X工时）
   │ 三、明日排班
   │   预计营业额：¥X
   │   排班人数：X人（前厅X人，后厨X人）
   │   早班：X人（XXX、XXX）
   │   晚班：X人（XXX、XXX）
   │   预计人效：¥X/人
3. 最后给出排班建议和方法（至少3条具体可执行的建议），包括：
   - 人效趋势分析（对比品牌标准：洪潮1200元/人，马己仙1500元/人）
   - 排班优化建议（如何根据营业额预测调整人数）
   - 高峰期人手安排建议
   - 员工休息日安排建议
   - 如何提升人效的具体方法
4. 语气专业但亲切，适当使用emoji
5. 总字数控制在800字以内
6. 使用markdown格式，数据用简洁的列表形式，每项单独一行，保持对齐

数据：
${dataText}`;

    const result = await callLLM(
      [{ role: 'user', content: prompt }],
      { temperature: 0.3, max_tokens: 2000 }
    );

    if (result.ok && result.content) {
      return `📋 **考勤日报 · ${today}**\n\n${result.content.trim()}`;
    }
    logger.warn({ error: result.error }, 'LLM generation failed');
    return null;
  } catch (e) {
    logger.error({ err: e?.message }, 'generateAttendanceReportWithLLM failed');
    return null;
  }
}

function extractStoreSection(fullReport, store) {
  const lines = fullReport.split('\n');
  const storeIdx = lines.findIndex(l => l.includes(store));
  if (storeIdx === -1) return null;

  let endIdx = storeIdx + 1;
  while (endIdx < lines.length) {
    const line = lines[endIdx];
    if ((line.includes('洪潮') || line.includes('马己仙')) && !line.includes(store)) break;
    endIdx++;
  }

  return lines.slice(storeIdx, endIdx).join('\n').trim();
}

async function fallbackAttendanceReport(allStoresData, today) {
  const lines = [`📋 **考勤日报 · ${today}`];

  for (const sd of allStoresData) {
    lines.push('');
    lines.push(`┌─ **${sd.store}**`);

    const dr = sd.dailyReport;
    if (!dr) {
      lines.push(`│ 一、考勤：暂无数据`);
      lines.push(`│ 二、人效：暂无数据`);
      lines.push(`│ 三、明日排班：暂无数据`);
      continue;
    }

    const staffData = typeof dr.staff === 'string' ? JSON.parse(dr.staff) : (dr.staff || []);
    const totalStaff = staffData.length;
    const laborHours = parseFloat(dr.labor_total) || 0;

    // 实际出勤人数 = staff 中排除今日休假人员
    const leaveUsernames = new Set(sd.todayLeave.map(lv => lv.username));
    const attendanceCount = staffData.filter(s => !leaveUsernames.has(s.user)).length;
    const attendanceRate = totalStaff > 0 ? Math.round((attendanceCount / totalStaff) * 100) : 0;

    lines.push(`│ 一、考勤`);
    lines.push(`│   门店总人数：${totalStaff}人`);
    lines.push(`│   实际出勤：${attendanceCount}人（${laborHours}工时）`);
    lines.push(`│   出勤率：${attendanceRate}%`);

    if (sd.todayLeave.length) {
      const restNames = sd.todayLeave.map(lv => {
        const emp = staffData.find(e => e.user === lv.username || e.name === lv.name);
        return `${lv.name}（${emp ? '员工' : '—'}）`;
      });
      lines.push(`│   今日休息：${restNames.join('、')}`);
    } else {
      lines.push(`│   今日休息：无`);
    }

    const eff = parseFloat(dr.efficiency) || 0;
    const actualRev = parseFloat(dr.actual_revenue) || 0;
    const preRev = parseFloat(dr.pre_discount_revenue) || 0;
    const segments = typeof dr.segments === 'string' ? JSON.parse(dr.segments) : (dr.segments || {});
    const noonRev = parseFloat(segments.noon) || 0;
    const nightRev = parseFloat(segments.night) || 0;
    const afternoonRev = parseFloat(segments.afternoon) || 0;
    const noonRatio = preRev > 0 ? noonRev / preRev : 0.5;
    const nightRatio = preRev > 0 ? (nightRev + afternoonRev) / preRev : 0.5;
    const noonHours = Math.round(laborHours * noonRatio * 10) / 10;
    const nightHours = Math.round(laborHours * nightRatio * 10) / 10;
    const noonEff = noonHours > 0 ? Math.round(noonRev / noonHours) : 0;
    const nightEff = nightHours > 0 ? Math.round((nightRev + afternoonRev) / nightHours) : 0;

    lines.push(`│ 二、人效`);
    lines.push(`│   全天人效：¥${Math.round(eff).toLocaleString()}/人（实收¥${Math.round(actualRev).toLocaleString()} / ${laborHours}工时）`);
    lines.push(`│   午市人效：¥${noonEff.toLocaleString()}/工时（午市折前¥${Math.round(noonRev).toLocaleString()} / ${noonHours}工时）`);
    lines.push(`│   晚市人效：¥${nightEff.toLocaleString()}/工时（晚市折前¥${Math.round(nightRev + afternoonRev).toLocaleString()} / ${nightHours}工时）`);

    const sched = typeof dr.schedule_next_day === 'string' ? JSON.parse(dr.schedule_next_day) : (dr.schedule_next_day || {});
    const tomorrowStaff = sched.staff || [];
    const tomorrowHeadcount = tomorrowStaff.reduce((sum, s) => sum + (parseFloat(s.days) || 1), 0);
    const tomorrowEst = parseFloat(sched.tomorrowGrossEstimate) || 0;
    const tomorrowEff = tomorrowHeadcount > 0 && tomorrowEst > 0 ? Math.round(tomorrowEst / tomorrowHeadcount) : 0;
    const frontStaff = sched.frontStaff || [];
    const kitchenStaff = sched.kitchenStaff || [];
    const morningStaff = sched.morningStaff || [];
    const afternoonStaff = sched.afternoonStaff || [];

    lines.push(`│ 三、明日排班`);
    lines.push(`│   预计营业额：¥${tomorrowEst.toLocaleString()}`);
    lines.push(`│   排班人数：${tomorrowHeadcount}人（前厅${frontStaff.length}人，后厨${kitchenStaff.length}人）`);
    lines.push(`│   早班：${morningStaff.length}人（${morningStaff.map(s => s.name).join('、')}）`);
    lines.push(`│   晚班：${afternoonStaff.length}人（${afternoonStaff.map(s => s.name).join('、')}）`);
    lines.push(`│   预计人效：¥${tomorrowEff.toLocaleString()}/人`);
  }

  const brand = '洪潮';
  const threshold = 1200;
  lines.push('');
  lines.push(`📝 **排班建议**`);
  lines.push(`1. 根据明日预计营业额调整排班人数，确保人效达标（${brand}标准¥${threshold}/人，马己仙¥1500/人）`);
  lines.push(`2. 高峰期（午市11:00-14:00，晚市17:00-20:00）确保人手充足，前厅后厨配比1:1.5~1:2`);
  lines.push(`3. 合理安排员工休息日，避免连续工作日过长，建议每周至少休息1天`);
  lines.push(`4. 如预计人效低于标准，可适当减少非高峰期排班人数，或安排兼职/小时工`);
  lines.push(`5. 关注员工技能交叉培训，提升人员调配灵活性`);

  const reportText = lines.join('\n');
  const { sendText } = await import('./feishu-client.js');

  const hq = await query(
    `SELECT open_id, username FROM feishu_users
     WHERE registered = true AND open_id IS NOT NULL AND role IN ('admin','hq_manager')`
  );
  for (const u of hq.rows || []) {
    await sendText(u.open_id, reportText, 'open_id').catch(() => {});
  }

  for (const sd of allStoresData) {
    const sms = await query(
      `SELECT open_id, username FROM feishu_users
       WHERE registered = true AND open_id IS NOT NULL
         AND role IN ('store_manager','store_production_manager')
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
