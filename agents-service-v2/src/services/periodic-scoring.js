/**
 * 周度门店评级：按 anomaly_triggers 聚合扣分，写入 agent_scores（店长 / 出品经理维度）。
 * score_model=anomaly_rollups_v2；扣分按异常类型/严重度/频次由 scoring-model.calcDeductions 等计算。
 * 任务卡催办链路不向 agent_scores 写入扣分，仅打工作态度标；与本周度 BI 汇总独立。
 * 同步：HRMS 公司通知栏 hrms_user_notifications + 飞书周度卡片（本人 + 管理员/总部营运汇总）
 */
import cron from 'node-cron';
import { query } from '../utils/db.js';
import { logger } from '../utils/logger.js';
import { calcDeductions } from './scoring-model.js';
import { getBrandForStore } from './config-service.js';
import { sendCard, sendText, buildPerformanceSummaryCard } from './feishu-client.js';
import {
  shanghaiLastCompletedWeekBounds,
  shanghaiWeekMonSunContaining,
  addDaysYmdShanghai
} from '../utils/anomaly-week-bounds.js';

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
  dish_unit_product: '菜品优化（单位产品）异常',
  cost_spike: '成本波动异常'
};

async function ensureHrmsNotifTable() {
  try {
    await query(`
      CREATE TABLE IF NOT EXISTS hrms_user_notifications (
        id BIGSERIAL PRIMARY KEY,
        target_username TEXT NOT NULL,
        title TEXT NOT NULL,
        message TEXT NOT NULL,
        type TEXT NOT NULL DEFAULT 'performance_deduction',
        meta JSONB DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )`);
    await query(`CREATE INDEX IF NOT EXISTS idx_hrms_notif_user_created ON hrms_user_notifications (target_username, created_at DESC)`);
  } catch (e) {
    logger.warn({ err: e?.message }, 'ensureHrmsNotifTable');
  }
}

/** 每条扣分写入 HRMS 档案「公司通知」数据源 */
async function recordDeductionNotifications({ username, store, role, periodMonday, weekEndStr, details }) {
  if (!username || String(username).startsWith('__periodic')) return;
  await ensureHrmsNotifTable();
  const rangeZh = `${periodMonday}～${weekEndStr}`;
  for (const d of details || []) {
    const pts = Number(d.points || 0);
    if (!pts) continue;
    const reason = CAT_ZH[d.category] || d.category || '异常规则';
    const keyZh = ANOMALY_KEY_ZH[d.anomaly_key] || '相关规则';
    const sevZh = d.severity === 'high' ? '高' : d.severity === 'medium' ? '中' : String(d.severity || '-');
    const msg = `${rangeZh} 因「${reason}」（${keyZh}，严重度 ${sevZh}），本周绩效扣 ${pts} 分。说明：周度汇总已写入绩效档案，如有异议请在飞书联系总部营运或回复「申诉」。`;
    try {
      await query(
        `INSERT INTO hrms_user_notifications (target_username, title, message, type, meta)
         VALUES ($1, $2, $3, 'performance_deduction', $4::jsonb)`,
        [
          username,
          '绩效扣分通知',
          msg,
          JSON.stringify({ store, role, anomaly_key: d.anomaly_key, category: d.category, points: pts, period_week_start: periodMonday })
        ]
      );
    } catch (e) {
      logger.warn({ err: e?.message, username }, 'recordDeductionNotifications insert failed');
    }
  }
}

/** anomaly_key → scoring-model 的 category（周度汇总；充值/大众点评差评按 trigger_value 另行计分；月毛利/月营收不进自然周汇总） */
const ANOMALY_TO_CATEGORY = {
  revenue_achievement: 'revenue_anomaly',
  labor_efficiency: 'efficiency_anomaly',
  table_visit_product: 'table_visit_anomaly',
  // table_visit_ratio 的 BI notifyTarget=店长，因此扣分也应落到 store_manager
  table_visit_ratio: 'table_visit_ratio_anomaly',
  hongchao_jiuguang_private_room: 'private_room_anomaly',
  /** 周度汇总须计入毛利率异常（此前被跳过导致多人显示 100 分） */
  gross_margin: 'margin_anomaly',
  /** 菜品优化/单位产品类触发 → 按毛利线由出品经理担责 */
  dish_unit_product: 'margin_anomaly',
  cost_spike: 'margin_anomaly'
};

const SKIP_WORST_FOR_KEYS = new Set([
  'recharge_zero',
  'bad_review_product',
  'bad_review_service',
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
  try {
    const r = await query(
      `SELECT username, COALESCE(NULLIF(TRIM(name),''), username) AS disp
       FROM feishu_users
       WHERE registered = true AND role = $2
         AND (store = $1 OR $1 ILIKE '%' || store || '%' OR store ILIKE '%' || $1 || '%')
       ORDER BY updated_at DESC NULLS LAST`,
      [store, role]
    );
    const rows = r.rows || [];
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

/** 按门店 × 周期写入 agent_scores（period=week_周一，score_model=anomaly_rollups_v2）— 供飞书「异常周汇总」与 HRMS new_model 区分 */
export async function scoreStoreForPeriod(store, periodMonday) {
  const weekEnd = new Date(periodMonday);
  weekEnd.setDate(weekEnd.getDate() + 6);
  const endStr = weekEnd.toISOString().slice(0, 10);
  const brand = (await getBrandForStore(store).catch(() => null)) || '未知';

  const r = await query(
    `SELECT anomaly_key, severity, trigger_value
     FROM anomaly_triggers
     WHERE store = $1
       AND trigger_date >= $2::date
       AND trigger_date <= $3::date
       AND COALESCE(status, 'open') = 'open'`,
    [store, periodMonday, endStr]
  );

  let rechargeSum = 0;
  let badProductPts = 0;
  let badServicePts = 0;
  const worst = new Map();

  for (const row of r.rows || []) {
    const key = row.anomaly_key;
    if (key === 'recharge_zero') {
      const tv = parseTriggerValue(row);
      const pts = Number(tv.penalty_points != null ? tv.penalty_points : row.severity === 'high' ? 4 : 2);
      if (Number.isFinite(pts) && pts > 0) rechargeSum += pts;
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

  for (const role of ['store_manager', 'store_production_manager']) {
    const { total: baseTotal, details: baseDetails } = calcDeductions(anomalies, role);
    let extra = 0;
    const extraDetails = [];
    if (role === 'store_manager') {
      if (rechargeSum > 0) {
        extra += rechargeSum;
        extraDetails.push({
          category: 'recharge_anomaly',
          severity: 'mixed',
          anomaly_key: 'recharge_zero',
          points: rechargeSum
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

    const total = baseTotal + extra;
    const details = [...baseDetails, ...extraDetails];
    const totalScore = Math.max(0, 100 - total);
    const roleZh = roleLabelZh(role);
    const summaryZh = `周度自动评分：基于 ${periodMonday}～${endStr} 异常触发汇总，${roleZh} 合计扣 ${total} 分。`;
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
             feishu_notified = FALSE,
             updated_at = NOW()`,
          [
            brand,
            store,
            username,
            name,
            role,
            `week_${periodMonday}`,
            totalScore,
            JSON.stringify(details),
            JSON.stringify({ 扣分项条数: details.length, 数据来源: '异常触发汇总' }),
            summaryZh
          ]
        );
        await recordDeductionNotifications({
          username,
          store,
          role,
          periodMonday,
          weekEndStr: endStr,
          details
        });
      } catch (e) {
        logger.warn({ err: e?.message, store, role, username }, 'periodic-scoring upsert failed');
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
  const periodTag = `week_${periodMonday}`;
  const r = await query(
    `SELECT username, name, store, role, total_score, deductions, summary, period,
            COALESCE(updated_at, created_at) AS sort_ts
     FROM agent_scores
     WHERE period = $1 AND score_model = 'anomaly_rollups_v2'
     ORDER BY store, role, sort_ts DESC`,
    [periodTag]
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
      return `- **${row.store}** · ${who}（${rzh}）${bindTag}：**${row.total_score}** 分`;
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
      const card = buildPerformanceSummaryCard({
        title: '📊 上周绩效（异常汇总）',
        store: row.store,
        periodLabel,
        totalScore: row.total_score,
        role: roleLabelZh(row.role),
        detailMd
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
    '0 5 * * 1',
    async () => {
      try {
        await runWeeklyStoreScoring();
      } catch (e) {
        logger.error({ err: e?.message }, 'Weekly scoring cron failed');
      }
    },
    { timezone: 'Asia/Shanghai' }
  );
  logger.info('Periodic scoring scheduler started (每周一 05:00 Asia/Shanghai，含飞书卡片与 HRMS 扣分通知)');
}
