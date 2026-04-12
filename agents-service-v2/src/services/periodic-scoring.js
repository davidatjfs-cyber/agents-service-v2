/**
 * 周度门店评级：按 anomaly_triggers 聚合扣分，写入 agent_scores（店长 / 出品经理维度）。
 * score_model=anomaly_rollups_v2；扣分按异常类型/严重度/频次由 scoring-model.calcDeductions 等计算。
 *
 * **充值异常（recharge_zero）**：日频检测落库后 **立即** 调用 refreshWeeklyRollupAfterRechargeTrigger
 * 重算当周 anomaly_rollups_v2（与周一全量任务同一公式）；店长 **当天即可在绩效分看到更新**，周一任务再次全量跑仍幂等。
 * 周汇总时充值扣分按 **daily_reports** 与 `anomaly-engine` 同日 streak 规则 **逐日重算求和**，**不**再累加各条 `anomaly_triggers.penalty_points`（避免同日多次日检、多 trigger_date 指向同一营业日导致多扣）。
 * 汇总时其它 anomaly 仍计入 status 为 open/closed 的触发（排除 superseded、pending_data），避免飞书结案后误从扣分里消失。
 *
 * 实收营收 / 人效 / 桌访占比 / 毛利率 等为月度扣分项：周度任务只汇总「周频/日频」规则，不因上述 triggers 在周行扣分（飞书任务仍可周提醒）。
 * 任务卡催办链路不向 agent_scores 写入扣分，仅打工作态度标；与本周度 BI 汇总独立。
 * 同步：HRMS 公司通知栏 hrms_user_notifications + 飞书周度卡片（本人 + 管理员/总部营运汇总）
 */
import cron from 'node-cron';
import { query } from '../utils/db.js';
import { logger } from '../utils/logger.js';
import { calcDeductions } from './scoring-model.js';
import { getBrandForStore } from './config-service.js';
import { sendCard, sendText, buildPerformanceSummaryCard, buildBiDeductionCard } from './feishu-client.js';
import { ensureHrmsUserNotificationsTable } from '../utils/hrms-user-notifications.js';
import { runWithCronLog } from '../utils/cron-run-monitor.js';
import {
  shanghaiLastCompletedWeekBounds,
  shanghaiWeekMonSunContaining,
  addDaysYmdShanghai
} from '../utils/anomaly-week-bounds.js';
import {
  sortFeishuScoringRows,
  resolveMajixianProductionManagersForScoring,
  majixianPmNewModelLookupUsername
} from '../utils/scoring-assignee.js';
import { sumRechargePenaltyPointsForClosedDaysInRange } from './anomaly-engine.js';

const CAT_ZH = {
  revenue_anomaly: '营收/实收异常',
  efficiency_anomaly: '人效异常',
  recharge_anomaly: '充值异常',
  table_visit_anomaly: '桌访相关异常',
  table_visit_ratio_anomaly: '桌访占比异常',
  margin_anomaly: '毛利异常',
  product_review: '产品差评异常',
  service_review: '服务差评异常',
  private_room_anomaly: '包房使用异常'
};

/** 规则键 → 中文名（飞书卡片/通知禁止裸露英文 key） */
const ANOMALY_KEY_ZH = {
  revenue_achievement: '实收营收异常',
  labor_efficiency: '人效值异常',
  recharge_zero: '充值异常',
  table_visit_product: '桌访产品异常',
  table_visit_ratio: '桌访占比异常',
  gross_margin: '总实收毛利率异常',
  bad_review_product: '差评产品异常',
  bad_review_service: '差评服务异常',
  hongchao_jiuguang_private_room: '洪潮久光包房使用异常',
  food_safety: '食品安全异常',
};

/**
 * 每条扣分写入 HRMS 档案「公司通知」数据源，同时发飞书即时消息给责任人 + admin/hq_manager 抄送
 */
async function recordDeductionNotifications({
  username,
  store,
  role,
  periodMonday,
  weekEndStr,
  rangeStart,
  rangeEnd,
  details,
  /** 本周期 UPSERT 后的总分（与 details 同源）；用于推算每条扣分前的「现有分」，避免误读他店/他周或「已扣分后再 SELECT」的错序 */
  scoreAfterRollup
}) {
  if (!username || String(username).startsWith('__periodic')) return;
  await ensureHrmsUserNotificationsTable();
  const rs = String(rangeStart || periodMonday || '').slice(0, 10);
  const re = String(rangeEnd || weekEndStr || '').slice(0, 10);
  const rangeZh = `${rs}～${re}`;
  
  // 查询责任人飞书 open_id
  let assigneeOpenId = null;
  let assigneeName = username;
  try {
    const fu = await query(
      `SELECT open_id, COALESCE(NULLIF(TRIM(name), ''), username) AS name
       FROM feishu_users WHERE username = $1 AND registered = true AND open_id IS NOT NULL LIMIT 1`,
      [username]
    );
    assigneeOpenId = fu.rows?.[0]?.open_id || null;
    assigneeName = fu.rows?.[0]?.name || username;
  } catch (_e) { /* ignore */ }
  
  const after = Math.max(0, Math.min(100, Number(scoreAfterRollup)));
  const ptSum = (details || []).reduce((s, d) => s + Math.max(0, Number(d.points || 0)), 0);
  /** 在「本批 details 已并入 total」前提下，扣分前总分 = 当前总分 + 本批扣分之和（通常为 100） */
  let running = Math.min(100, after + ptSum);
  
  // 查询 admin+hq_manager 的飞书 open_id（管理层抄送）
  let mgmtOpenIds = [];
  try {
    const mg = await query(
      `SELECT DISTINCT open_id FROM feishu_users
       WHERE role IN ('admin','hq_manager') AND registered = true AND open_id IS NOT NULL`
    );
    mgmtOpenIds = (mg.rows || []).map((r) => r.open_id).filter(Boolean);
  } catch (_e) { /* ignore */ }
  
  for (const d of details || []) {
    const pts = Number(d.points || 0);
    if (!pts) continue;
    const currentScore = running;
    const remainingScore = Math.max(0, currentScore - pts);
    running = remainingScore;
    const reason =
      (CAT_ZH[d.category] || d.category || '异常规则') +
      (d.detail_note ? `\n${String(d.detail_note).slice(0, 400)}` : '');
    const keyZh = ANOMALY_KEY_ZH[d.anomaly_key] || '相关规则';
    const sevZh = d.severity === 'high' ? '高' : d.severity === 'medium' ? '中' : String(d.severity || '-');
    
    // 构建卡片
    const card = buildBiDeductionCard({
      store,
      assigneeName,
      role,
      period: rangeZh,
      reason,
      keyZh,
      severity: sevZh,
      points: pts,
      currentScore,
      remainingScore
    });
    
    // 写入 HRMS 档案通知
    const metaJson = JSON.stringify({ 
      store, 
      role, 
      anomaly_key: d.anomaly_key, 
      category: d.category, 
      points: pts, 
      current_score: currentScore, 
      remaining_score: remainingScore,
      period_week_start: periodMonday 
    });
    
    try {
      await query(
        `INSERT INTO hrms_user_notifications (target_username, title, message, type, meta)
         VALUES ($1, $2, $3, $4, $5::jsonb)`,
        [username, 'BI异常情况扣分', `您的${rangeZh}绩效扣${pts}分，剩余${remainingScore}分。`, 'bi_deduction', metaJson]
      );
    } catch (e) {
      logger.warn({ err: e?.message, username }, 'recordDeductionNotifications insert failed');
    }
    
    // 发送飞书卡片给责任人
    if (assigneeOpenId) {
      try {
        await sendCard(assigneeOpenId, card, 'open_id');
      } catch (e) {
        logger.warn({ err: e?.message, username }, 'bi deduction card send failed');
      }
    }
    
    // 管理层抄送：每人收一张卡片
    for (const oid of mgmtOpenIds) {
      try {
        await sendCard(oid, card, 'open_id');
      } catch (e) {
        logger.warn({ err: e?.message, oid }, 'bi deduction card send failed');
      }
    }
  }
}

/**
 * anomaly_key → scoring-model 的 category（周度汇总专用）
 *
 * 扣分频率规则：
 * - 充值异常：**日频**检测并写入 anomaly_triggers；**周一「周度门店评分」**按自然周内各日 penalty_points **累加**后写入 anomaly_rollups_v2（勿将整条链描述为「周频才检测」）。
 * - 桌访/差评/包房等：按各规则频率检测；周汇总任务写入 anomaly_rollups_v2（其中月度键仅提醒、不扣分）。
 * - 月度扣分（monthly）：实收营收、人效、桌访占比、毛利率 — 周汇总不扣，由月评分/月任务执行。
 */
const ANOMALY_TO_CATEGORY = {
  // 周汇总中参与 scoring-model 的 anomaly_key（不含已下线的 dish_unit_product / cost_spike）
  recharge_zero: 'recharge_anomaly',
  table_visit_product: 'table_visit_anomaly',
  bad_review_product: 'product_review',
  bad_review_service: 'service_review',
  hongchao_jiuguang_private_room: 'private_room_anomaly',
  // 月度扣分规则（monthly frequency）— 周度仅提醒，不扣分
  revenue_achievement: 'revenue_anomaly',
  labor_efficiency: 'efficiency_anomaly',
  table_visit_ratio: 'table_visit_ratio_anomaly',
  gross_margin: 'margin_anomaly'
};

/** 月度扣分规则 — 周度汇总时跳过扣分，仅记录提醒 */
const MONTHLY_DEDUCTION_KEYS = new Set([
  'revenue_achievement',
  'labor_efficiency',
  'table_visit_ratio',
  'gross_margin',
  'revenue_achievement_monthly'
]);

const SKIP_WORST_FOR_KEYS = new Set([
  'recharge_zero',
  'bad_review_product',
  'bad_review_service',
  /** 桌访产品：按产品维度累计扣分，见 mergeTableVisitProductWeekDeduction */
  'table_visit_product',
  'revenue_achievement_monthly',
  /** 食安走单独闭环/记录流程，不并入通用周汇总扣分模型 */
  'food_safety'
]);

function previousWeekMonday() {
  return shanghaiLastCompletedWeekBounds().weekStart;
}

/**
 * 同一门店同岗位可能有多名绑定用户（如 nnyxcs35 与「测试」同为出品经理）；
 * 须每人写入一行 agent_scores，否则汇总里会漏人且他人被误算成「唯一负责人」。
 */
async function resolveScoringUsers(store, role) {
  if (role === 'store_production_manager' && /马己仙/.test(String(store || ''))) {
    return resolveMajixianProductionManagersForScoring(store);
  }
  try {
    const r = await query(
      `SELECT username, COALESCE(NULLIF(TRIM(name),''), username) AS disp
       FROM feishu_users
       WHERE registered = true AND role = $2
         AND (store = $1 OR $1 ILIKE '%' || store || '%' OR store ILIKE '%' || $1 || '%')
       ORDER BY updated_at DESC NULLS LAST`,
      [store, role]
    );
    const rows = sortFeishuScoringRows(store, role, r.rows || []);
    if (rows.length) {
      const seen = new Set();
      const out = [];
      for (const row of rows) {
        const u = String(row.username || '').trim();
        if (!u || seen.has(u.toLowerCase())) continue;
        seen.add(u.toLowerCase());
        out.push({ username: u, name: row.disp || u });
      }
      if (out.length) return out;
    }
  } catch (_e) {
    /* ignore */
  }
  if (role === 'store_manager') return [{ username: '__periodic_store_manager__', name: '店长(周度自动·未绑定)' }];
  return [{ username: '__periodic_kitchen__', name: '出品经理(周度自动·未绑定)' }];
}

function parseTriggerValue(row) {
  const v = row.trigger_value;
  if (v && typeof v === 'object') return v;
  if (typeof v === 'string') {
    try {
      return JSON.parse(v);
    } catch {
      return {};
    }
  }
  return {};
}

/**
 * 桌访产品异常：同一自然周内可能有多条 anomaly_triggers；按菜品名合并取最大次数后，
 * 再按产品分别计分（≥4→10，≥2→5）并相加，与 anomaly-engine.checkTableVisitProduct 口径一致。
 */
function mergeTableVisitProductWeekDeduction(triggerRows) {
  const byCanon = new Map();
  for (const row of triggerRows || []) {
    if (row.anomaly_key !== 'table_visit_product') continue;
    const tv = parseTriggerValue(row);
    const products = tv?.products;
    if (!Array.isArray(products)) continue;
    for (const p of products) {
      const name = String(p.complaint || '').trim();
      const cnt = parseInt(String(p.cnt ?? ''), 10) || 0;
      if (!name) continue;
      const canon = name.toLowerCase().replace(/\s+/g, '');
      if (!canon) continue;
      const prev = byCanon.get(canon);
      if (!prev || cnt > prev.cnt) byCanon.set(canon, { complaint: name, cnt });
    }
  }
  let totalPoints = 0;
  const lines = [];
  for (const { complaint, cnt } of byCanon.values()) {
    let pts = 0;
    if (cnt >= 4) pts = 10;
    else if (cnt >= 2) pts = 5;
    if (pts > 0) {
      totalPoints += pts;
      lines.push({ complaint, cnt, points: pts });
    }
  }
  return { totalPoints, lines };
}

/**
 * 人效（labor_efficiency）已列入 MONTHLY_DEDUCTION_KEYS：周度 anomaly_rollups_v2 不得再按 triggers 补扣，
 * 否则会出现「每周写入人效扣分」、与「周提醒、月扣分」产品规则相反（历史上曾导致店长周分异常偏低）。
 */
function mergeLaborEfficiencyIfMissing(baseTotal, baseDetails, _role, _triggerRows) {
  return { baseTotal, baseDetails };
}

/** @param {string} ym YYYY-MM */
function lastDayYmdForYm(ym) {
  const [y, m] = ym.split('-').map(Number);
  const last = new Date(y, m, 0).getDate();
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(last).padStart(2, '0')}`;
}

/**
 * 将「周一～周日」按自然月切成若干段；每段内 trigger_date 只属于该月，满足绩效不跨月累计。
 */
function splitWeekByCalendarMonths(weekStart, weekEnd) {
  const segments = [];
  let cur = String(weekStart).slice(0, 10);
  const wkEnd = String(weekEnd).slice(0, 10);
  while (cur <= wkEnd) {
    const ymMonth = cur.slice(0, 7);
    const monthEnd = lastDayYmdForYm(ymMonth);
    const segEnd = wkEnd < monthEnd ? wkEnd : monthEnd;
    segments.push({
      start: cur,
      end: segEnd,
      ymMonth,
      ymKey: ymMonth.replace(/-/g, '')
    });
    if (segEnd >= wkEnd) break;
    cur = addDaysYmdShanghai(segEnd, 1);
  }
  return segments;
}

function computeRoleRollupFromRows(rows, role, opts = {}) {
  const rechargeFromDaily = opts.rechargePenaltySum;
  const rechargeLineDays = opts.rechargePenaltyLineDays || [];
  const tableVisitProductMerged = mergeTableVisitProductWeekDeduction(rows || []);

  let rechargeSum = 0;
  let badProductPts = 0;
  let badServicePts = 0;
  const worst = new Map();

  for (const row of rows || []) {
    const key = row.anomaly_key;
    if (MONTHLY_DEDUCTION_KEYS.has(key)) continue;
    if (key === 'recharge_zero') {
      /** 周汇总充值分由 `sumRechargePenaltyPointsForClosedDaysInRange` 传入，避免累加 trigger 上已固化的 penalty */
      if (rechargeFromDaily == null) {
        const tv = parseTriggerValue(row);
        const pts = Number(tv.penalty_points != null ? tv.penalty_points : row.severity === 'high' ? 4 : 2);
        if (Number.isFinite(pts) && pts > 0) rechargeSum += pts;
      }
      continue;
    }
    if (key === 'bad_review_product') {
      const tv = parseTriggerValue(row);
      const pts = Number(tv.deduction_production || 0);
      if (pts > 0) badProductPts = Math.max(badProductPts, pts);
      continue;
    }
    if (key === 'bad_review_service') {
      const tv = parseTriggerValue(row);
      const pts = Number(tv.deduction_manager || 0);
      if (pts > 0) badServicePts = Math.max(badServicePts, pts);
      continue;
    }
    if (SKIP_WORST_FOR_KEYS.has(key)) continue;

    const cat = ANOMALY_TO_CATEGORY[key];
    if (!cat) continue;
    const sev = row.severity === 'high' ? 'high' : 'medium';
    const k = `${row.anomaly_key}:${cat}`;
    const prev = worst.get(k);
    if (!prev || sev === 'high') worst.set(k, { category: cat, severity: sev, anomaly_key: row.anomaly_key });
  }
  const anomalies = [...worst.values()];

  let { total: baseTotal, details: baseDetails } = calcDeductions(anomalies, role);
  const merged = mergeLaborEfficiencyIfMissing(baseTotal, baseDetails, role, rows || []);
  baseTotal = merged.baseTotal;
  baseDetails = merged.baseDetails;

  let extra = 0;
  const extraDetails = [];
  if (role === 'store_manager') {
    const rechargeTotal = rechargeFromDaily != null ? rechargeFromDaily : rechargeSum;
    if (rechargeTotal > 0) {
      extra += rechargeTotal;
      const note =
        rechargeLineDays.length > 0
          ? `按营业日报重算（当月 streak；不跨日重复计 trigger）：${rechargeLineDays
              .map((x) => `${x.d} 连续${x.streak}日零充值→${x.penalty}分`)
              .join('；')}`
          : rechargeFromDaily != null
            ? '按营业日报重算当周各日充值异常扣分'
            : '';
      extraDetails.push({
        category: 'recharge_anomaly',
        severity: 'mixed',
        anomaly_key: 'recharge_zero',
        points: rechargeTotal,
        ...(note ? { detail_note: note } : {})
      });
    }
    if (badServicePts > 0) {
      extra += badServicePts;
      extraDetails.push({
        category: 'service_review',
        severity: 'custom',
        anomaly_key: 'bad_review_service',
        points: badServicePts
      });
    }
  }
  if (role === 'store_production_manager' && badProductPts > 0) {
    extra += badProductPts;
    extraDetails.push({
      category: 'product_review',
      severity: 'custom',
      anomaly_key: 'bad_review_product',
      points: badProductPts
    });
  }
  if (role === 'store_production_manager' && tableVisitProductMerged.totalPoints > 0) {
    const tvp = tableVisitProductMerged.totalPoints;
    extra += tvp;
    const sev = tableVisitProductMerged.lines.some((l) => l.points >= 10) ? 'high' : 'medium';
    const breakdown = tableVisitProductMerged.lines
      .map((l) => `${l.complaint}×${l.cnt}→${l.points}分`)
      .join('；');
    extraDetails.push({
      category: 'table_visit_anomaly',
      severity: sev,
      anomaly_key: 'table_visit_product',
      points: tvp,
      detail_note: `按产品累计：${breakdown}`
    });
  }

  const total = baseTotal + extra;
  const details = [...baseDetails, ...extraDetails];
  const totalScore = Math.max(0, 100 - total);
  return { totalScore, details, totalDeducted: total };
}

/**
 * 充值异常日检落库后：立即按当前自然周重算该店 anomaly_rollups_v2（与周一全量任务同一公式，幂等）。
 * 不重复发「周度扣分」飞书/HRMS 通知（即时卡已在 notify 链路发过）。
 */
export async function refreshWeeklyRollupAfterRechargeTrigger(store, evaluationYmd) {
  const ymd = String(evaluationYmd || '').slice(0, 10);
  if (!store || !/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return;
  const { weekStart } = shanghaiWeekMonSunContaining(ymd);
  await scoreStoreForPeriod(store, weekStart, { skipFeishuDeductionNotify: true });
  logger.info({ store, evaluationYmd: ymd, weekStart }, 'recharge: refreshed anomaly_rollups_v2 after daily trigger');
}

/** 按门店 × 周期写入 agent_scores（period=week_周一 或 跨月拆分为 week_周一__YYYYMM，score_model=anomaly_rollups_v2） */
export async function scoreStoreForPeriod(store, periodMonday, options = {}) {
  const skipFeishuDeductionNotify = options.skipFeishuDeductionNotify === true;
  const endStr = addDaysYmdShanghai(periodMonday, 6);
  const brand = (await getBrandForStore(store).catch(() => null)) || '未知';
  const segments = splitWeekByCalendarMonths(periodMonday, endStr);

  if (segments.length > 1) {
    try {
      await query(
        `DELETE FROM agent_scores
         WHERE brand = $1 AND store = $2 AND score_model = 'anomaly_rollups_v2' AND period = $3`,
        [brand, store, `week_${periodMonday}`]
      );
    } catch (e) {
      logger.warn({ err: e?.message, store, periodMonday }, 'periodic-scoring: drop legacy cross-month row failed');
    }
  }

  for (const seg of segments) {
    const r = await query(
      `SELECT anomaly_key, severity, trigger_value
       FROM anomaly_triggers
       WHERE store = $1
         AND trigger_date >= $2::date
         AND trigger_date <= $3::date
         AND COALESCE(status, 'open') NOT IN ('superseded', 'pending_data')`,
      [store, seg.start, seg.end]
    );

    const periodTag = segments.length > 1 ? `week_${periodMonday}__${seg.ymKey}` : `week_${periodMonday}`;
    const monthPartZh =
      segments.length > 1 ? `${Number(seg.ymMonth.slice(5, 7))} 月段` : '';
    const rangeZh = `${seg.start}～${seg.end}`;

    const rechargeRollup = await sumRechargePenaltyPointsForClosedDaysInRange(store, seg.start, seg.end);

    for (const role of ['store_manager', 'store_production_manager']) {
      const { totalScore, details, totalDeducted } = computeRoleRollupFromRows(r.rows || [], role, {
        rechargePenaltySum: rechargeRollup.sum,
        rechargePenaltyLineDays: rechargeRollup.lineDays
      });
      const roleZh = roleLabelZh(role);
      const summaryZh =
        segments.length > 1
          ? `周度自动评分（${monthPartZh}）：基于 ${rangeZh} 异常触发汇总，${roleZh} 合计扣 ${totalDeducted} 分（自然周 ${periodMonday}～${endStr}，按自然月拆分不计跨月）。`
          : `周度自动评分：基于 ${periodMonday}～${endStr} 异常触发汇总，${roleZh} 合计扣 ${totalDeducted} 分。`;
      const users = await resolveScoringUsers(store, role);
      for (const { username, name } of users) {
        try {
          await query(
            `INSERT INTO agent_scores (
               brand, store, username, name, role, period, score_model,
               total_score, deductions, breakdown, summary
             ) VALUES ($1,$2,$3,$4,$5,$6,'anomaly_rollups_v2',$7,$8::jsonb,$9::jsonb,$10)
             ON CONFLICT (brand, store, username, period)
             DO UPDATE SET
               score_model = EXCLUDED.score_model,
               total_score = EXCLUDED.total_score,
               deductions = EXCLUDED.deductions,
               breakdown = EXCLUDED.breakdown,
               summary = EXCLUDED.summary,
               name = EXCLUDED.name,
               feishu_notified = CASE
                 WHEN agent_scores.feishu_notified = TRUE
                      AND agent_scores.total_score = EXCLUDED.total_score
                 THEN TRUE
                 ELSE FALSE
               END,
               updated_at = NOW()`,
            [
              brand,
              store,
              username,
              name,
              role,
              periodTag,
              totalScore,
              JSON.stringify(details),
              JSON.stringify({
                扣分项条数: details.length,
                数据来源: '异常触发汇总',
                ...(segments.length > 1 ? { 月分段: seg.ymMonth, 自然周: `${periodMonday}～${endStr}` } : {})
              }),
              summaryZh
            ]
          );
          if (!skipFeishuDeductionNotify) {
            await recordDeductionNotifications({
              username,
              store,
              role,
              periodMonday,
              weekEndStr: endStr,
              rangeStart: seg.start,
              rangeEnd: seg.end,
              details,
              scoreAfterRollup: totalScore
            });
          }
        } catch (e) {
          logger.warn({ err: e?.message, store, role, username }, 'periodic-scoring upsert failed');
        }
      }
    }
  }
}

function roleLabelZh(role) {
  if (role === 'store_manager') return '店长';
  if (role === 'store_production_manager') return '出品经理';
  return role || '—';
}

async function loadAnomalyRollupRows(periodMonday) {
  const base = `week_${periodMonday}`;
  const r = await query(
    `SELECT username, name, store, role, total_score, deductions, summary, period,
            COALESCE(updated_at, created_at) AS sort_ts
     FROM agent_scores
     WHERE score_model = 'anomaly_rollups_v2'
       AND (
         period = $1
         OR (
           length(period) > length($1) + 2
           AND left(period, length($1)) = $1
           AND substring(period, length($1) + 1, 2) = '__'
         )
       )
     ORDER BY store, role, period, sort_ts DESC`,
    [base]
  );
  return r.rows || [];
}

/** 飞书：上周 **异常扣分** 汇总 → 本人；汇总 → admin/hq。**绝不**使用 HRMS `new_model` 行（否则全员 100 与事实不符） */
export async function sendWeeklyPerformanceFeishu(periodMonday, options = {}) {
  const ensureAnomalyScores = options.ensureAnomalyScores !== false;
  const weekEnd = new Date(periodMonday);
  weekEnd.setDate(weekEnd.getDate() + 6);
  const endStr = weekEnd.toISOString().slice(0, 10);
  const periodLabel = `${periodMonday}～${endStr}`;
  try {
    let list = await loadAnomalyRollupRows(periodMonday);
    if (!list.length && ensureAnomalyScores) {
      logger.warn({ periodMonday }, 'sendWeeklyPerformanceFeishu: 无 anomaly_rollups_v2 行，按 daily_reports 门店回填周度异常评分');
      const storesR = await query(
        `SELECT DISTINCT store FROM daily_reports WHERE date >= CURRENT_DATE - 120 AND store IS NOT NULL`
      );
      const stores = (storesR.rows || []).map((x) => x.store).filter(Boolean);
      for (const store of stores) {
        await scoreStoreForPeriod(store, periodMonday);
      }
      list = await loadAnomalyRollupRows(periodMonday);
    }
    const hq = await query(
      `SELECT open_id, username FROM feishu_users
       WHERE registered = true AND open_id IS NOT NULL AND role IN ('admin','hq_manager')`
    );
    // 管理端汇总：每一行 agent_scores（每店×店长/出品）都列出，避免仅绑定用户才进汇总
    const hqLines = list.map((row) => {
      const rzh = roleLabelZh(row.role);
      const un = String(row.username || '');
      const placeholder = un.startsWith('__periodic');
      const who = row.name || (placeholder ? rzh : row.username) || rzh;
      const bindTag = placeholder ? ' · ⚠️未绑定飞书' : '';
      const p = String(row.period || '');
      const crossTag = p.includes('__') ? ` · 月分段 ${p.split('__').pop()}` : '';
      return `- **${row.store}** · ${who}（${rzh}）${bindTag}：**${row.total_score}** 分${crossTag}`;
    });
    for (const row of list) {
      if (!row.username || String(row.username).startsWith('__periodic')) continue;
      const fu = await query(
        `SELECT open_id FROM feishu_users WHERE username = $1 AND registered = true AND open_id IS NOT NULL LIMIT 1`,
        [row.username]
      );
      const oid = fu.rows?.[0]?.open_id;
      let ded = row.deductions;
      if (typeof ded === 'string') {
        try {
          ded = JSON.parse(ded);
        } catch {
          ded = [];
        }
      }
      ded = Array.isArray(ded) ? ded : [];
      const detailMd =
        ded.length > 0
          ? ded
              .map((d) => {
                const cat = CAT_ZH[d.category] || '异常扣分';
                const kz = ANOMALY_KEY_ZH[d.anomaly_key] || '';
                const tail = kz ? `（${kz}）` : '';
                return `• ${cat}${tail}：**-${d.points}** 分`;
              })
              .join('\n')
          : '本周无异常扣分项。';

      // 从 HRMS new_model 获取维度评级（门店级别/工作能力/工作态度/执行力）
      let dimensionRatings = null;
      try {
        const dimUser = majixianPmNewModelLookupUsername(row.username, row.store);
        const ratingR = await query(
          `SELECT breakdown FROM agent_scores
           WHERE username = $1 AND store = $2 AND score_model = 'new_model'
           ORDER BY updated_at DESC LIMIT 1`,
          [dimUser, row.store]
        );
        if (ratingR.rows?.[0]?.breakdown) {
          const bd = ratingR.rows[0].breakdown;
          dimensionRatings = {
            store_rating: bd.store_rating,
            ability_rating: bd.ability_rating,
            attitude_rating: bd.attitude_rating,
            execution_rating: bd.execution_rating
          };
        }
      } catch (e) { /* ignore */ }

      const card = buildPerformanceSummaryCard({
        title: '📊 绩效考核周报',
        store: row.store,
        periodLabel,
        totalScore: row.total_score,
        role: roleLabelZh(row.role),
        detailMd,
        dimensionRatings
      });
      if (oid) {
        let r = await sendCard(oid, card);
        if (!r?.ok) {
          r = await sendText(
            oid,
            `【上周绩效】${row.store} ${periodLabel}\n得分：${row.total_score}\n${row.summary || ''}`.slice(0, 3500),
            'open_id'
          );
        }
        if (!r?.ok) logger.warn({ u: row.username }, 'weekly perf feishu user failed');
      }
    }
    const digestMd = `**全员上周异常汇总得分（${periodLabel}）**（周度异常汇总口径）\n\n${
      hqLines.length
        ? hqLines.join('\n')
        : '本周在库中尚无周度异常汇总记录，请确认已对本周期跑过评分，且营业日报中有门店数据。'
    }`;
    for (const u of hq.rows || []) {
      if (!u.open_id) continue;
      const card = buildPerformanceSummaryCard({
        title: '📊 上周绩效汇总（管理）',
        store: '全部门店',
        periodLabel,
        totalScore: null,
        role: 'admin/hq',
        detailMd: digestMd,
        managementDigest: true
      });
      let r = await sendCard(u.open_id, card);
      if (!r?.ok) await sendText(u.open_id, digestMd.slice(0, 3500), 'open_id');
    }
  } catch (e) {
    logger.error({ err: e?.message }, 'sendWeeklyPerformanceFeishu failed');
  }
}

/** 与「自然周」对齐：覆盖区间内所有周一（含首尾日期所在周） */
function mondaysIntersectingRange(startYmd, endYmd) {
  const mondays = [];
  const first = shanghaiWeekMonSunContaining(String(startYmd).slice(0, 10)).weekStart;
  const last = shanghaiWeekMonSunContaining(String(endYmd).slice(0, 10)).weekStart;
  let ws = first;
  while (ws <= last) {
    mondays.push(ws);
    ws = addDaysYmdShanghai(ws, 7);
  }
  return mondays;
}

/**
 * 按日期区间回填周度 anomaly_rollups_v2（每店 × 每人）。
 * 门店集合 = 该周内有 anomaly_triggers 或 daily_reports 的店（避免仅有 BI 异常却无日报的店被漏跑）。
 */
export async function backfillWeeklyScoresForDateRange(startYmd, endYmd, options = {}) {
  const sendFeishu = options.sendFeishu === true;
  const mondays = mondaysIntersectingRange(startYmd, endYmd);
  const summary = [];
  for (const periodMonday of mondays) {
    const weekEnd = addDaysYmdShanghai(periodMonday, 6);
    const r = await query(
      `SELECT DISTINCT store FROM anomaly_triggers
       WHERE trigger_date >= $1::date AND trigger_date <= $2::date
         AND store IS NOT NULL AND trim(store) <> ''
       UNION
       SELECT DISTINCT store FROM daily_reports
       WHERE date >= $1::date AND date <= $2::date
         AND store IS NOT NULL AND trim(store) <> ''`,
      [periodMonday, weekEnd]
    );
    const stores = (r.rows || []).map((x) => x.store).filter(Boolean);
    for (const store of stores) {
      await scoreStoreForPeriod(store, periodMonday);
    }
    summary.push({ periodMonday, weekEnd, storesScored: stores.length });
    if (sendFeishu) {
      await sendWeeklyPerformanceFeishu(periodMonday, { ensureAnomalyScores: false });
    }
  }
  logger.info({ startYmd, endYmd, weeks: mondays.length }, 'backfillWeeklyScoresForDateRange done');
  return { startYmd, endYmd, mondays, summary, weeks: mondays.length };
}

export async function runWeeklyStoreScoring() {
  const periodMonday = previousWeekMonday();
  const weekEnd = addDaysYmdShanghai(periodMonday, 6);
  const storesR = await query(
    `SELECT DISTINCT store FROM daily_reports
     WHERE date >= CURRENT_DATE - 60 AND store IS NOT NULL AND trim(store) <> ''
     UNION
     SELECT DISTINCT store FROM anomaly_triggers
     WHERE trigger_date >= $1::date AND trigger_date <= $2::date AND store IS NOT NULL AND trim(store) <> ''`,
    [periodMonday, weekEnd]
  );
  const stores = (storesR.rows || []).map((x) => x.store).filter(Boolean);
  let n = 0;
  for (const store of stores) {
    await scoreStoreForPeriod(store, periodMonday);
    n++;
  }
  logger.info({ stores: n, periodMonday }, 'Weekly store scoring done');
  await sendWeeklyPerformanceFeishu(periodMonday);
  return { stores: n, periodMonday };
}

export function startPeriodicScoringScheduler() {
  cron.schedule(
    '25 8 * * 1',
    async () => {
      try {
        await runWithCronLog('weekly_store_scoring', async () => {
          await runWeeklyStoreScoring();
        });
      } catch (e) {
        logger.error({ err: e?.message }, 'Weekly scoring cron failed');
      }
    },
    { timezone: 'Asia/Shanghai' }
  );
  logger.info('Periodic scoring scheduler started (每周一 08:25 Asia/Shanghai，含飞书卡片与 HRMS 扣分通知)');
}
