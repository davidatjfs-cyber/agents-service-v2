/**
 * morning-briefing.js
 * 每日 07:30（上海时区）自动推送昨日经营数据 + 待办任务到飞书。
 * 定时任务在 src/index.js：`cron.schedule('30 7 * * *', …, { timezone: 'Asia/Shanghai' })`，请勿改时刻。
 */
import { query } from '../utils/db.js';
import { logger } from '../utils/logger.js';
import { sendCard } from './feishu-client.js';
import {
  getBadReviewRowsForStoreDateRange,
  buildYesterdayOpsBriefingSection,
  resolveMonthlyRevenueTargetYuan
} from './deterministic-replies.js';
import { anomalyRuleLabelZh } from '../utils/anomaly-labels.js';
import { expandAgentStoreLabels } from '../config/store-mapping.js';
import { getShanghaiNowClock } from '../utils/cron-run-monitor.js';

const FMT_MONEY = (n) => `¥${Number(n || 0).toLocaleString('zh-CN', { maximumFractionDigits: 0 })}`;
const FMT_PCT   = (n) => `${(Number(n || 0) * 100).toFixed(1)}%`;
const BRIEFING_SEND_TABLE = 'agent_v2_morning_briefing_sends';
const BRIEFING_RETRY_MAX = 3;

/** 晨报 SQL：与日报/任务库门店别名对齐（洪潮久光 ↔ 洪潮大宁久光等） */
function briefingStoreSqlPatterns(store) {
  const labs = expandAgentStoreLabels(String(store || '').trim());
  const pats = labs.map((lab) => `%${String(lab).replace(/%/g, '')}%`);
  return pats.length ? pats : [`%${String(store || '').replace(/%/g, '')}%`];
}

/** 理论进度：截至昨日累计天数 / 本月自然天总数（上海当月） */
function theoreticalProgressLine(todayYmd, yesterdayYmd, curMoYyyyMm) {
  const ty = parseInt(todayYmd.slice(0, 4), 10);
  const tm = parseInt(todayYmd.slice(5, 7), 10);
  const daysInMonth = new Date(ty, tm, 0).getDate();
  const ymo = yesterdayYmd.slice(0, 7);
  const elapsed = ymo === curMoYyyyMm ? parseInt(yesterdayYmd.slice(8, 10), 10) || 0 : 0;
  const pct = daysInMonth > 0 ? ((elapsed / daysInMonth) * 100).toFixed(1) : '0.0';
  return `· **理论进度**：**${pct}%**（截至昨日已过 **${elapsed}** 天 / 本月共 **${daysInMonth}** 天）`;
}

/** 异常 key → 中文（晨报展示） */
const ANOMALY_LABEL_ZH = {
  revenue_anomaly: '营收异常',
  revenue_achievement: '营收达成异常',
  labor_efficiency: '人效异常',
  efficiency_anomaly: '人效异常',
  recharge_anomaly: '充值异常',
  recharge_zero: '充值异常',
  margin_anomaly: '毛利异常',
  gross_margin: '毛利率异常',
  traffic_decline: '客流或订单下滑',
  table_visit_anomaly: '桌访异常',
  table_visit_product: '桌访产品问题',
  table_visit_ratio: '桌访占比异常',
  bad_review_product: '差评（产品）',
  bad_review_service: '差评（服务）',
  product_review: '产品差评异常',
  service_review: '服务差评异常',
  food_safety: '食品安全'
};

/** 历史任务 title 形如「店 · BI异常 · gross_margin」→ 末段英文化中文 */
function briefingPrettyTaskTitle(title) {
  const s = String(title || '').trim();
  const m = s.match(/[·•]\s*BI异常\s*[·•]\s*([\w_]+)\s*$/);
  if (!m) return s;
  const zh = anomalyRuleLabelZh(m[1]);
  const prefix = s.slice(0, m.index).replace(/\s+$/, '');
  return `${prefix} · BI异常 · ${zh}`;
}

function severityZh(s) {
  const x = String(s || '').toLowerCase();
  if (x === 'high') return '高';
  if (x === 'medium') return '中';
  if (x === 'low') return '低';
  return s || '';
}

function pickReviewText(f) {
  const keys = [
    '评价内容', '差评原因', '差评内容', 'content', 'reason', '备注', '文字评价', '用户评论',
    '评论内容', '评价详情', 'review_content', 'reviewContent'
  ];
  for (const k of keys) {
    const v = f[k];
    if (v != null && String(v).trim()) return String(v).trim();
  }
  return '';
}
function pickReviewPlatform(f) {
  const keys = ['差评平台', '平台', 'platform'];
  for (const k of keys) {
    const v = f[k];
    if (v != null && String(v).trim()) return String(v).trim();
  }
  return '未知平台';
}

/** 管理部门/无门店经营实体：不出现在「全门店汇总」晨报块中 */
const BRIEFING_SKIP_STORE_NAMES = new Set([
  '总部', '公司总部', '集团总部', '管理中心', '管理总部', 'hq', 'HQ', 'Headquarters'
]);

function isBriefingExcludedStore(store) {
  const s = String(store || '').trim();
  if (!s) return true;
  if (BRIEFING_SKIP_STORE_NAMES.has(s)) return true;
  if (BRIEFING_SKIP_STORE_NAMES.has(s.toLowerCase())) return true;
  return false;
}

/**
 * 晨报「昨日派发 · 仍未闭环」：系统下发给责任人的任务（仅统计派发日 = 昨日，上海时区），不含历史积压。
 */
const BRIEFING_YESTERDAY_OPEN_SOURCES = [
  'bi_anomaly',
  'data_auditor',
  'scheduled_inspection',
  'random_inspection',
  'auto_collab'
];
const BRIEFING_OPEN_STATUSES = ['pending_response', 'pending_review', 'pending_dispatch', 'dispatched'];

function briefingSourceLabel(s) {
  switch (String(s || '')) {
    case 'bi_anomaly':
      return 'BI异常';
    case 'data_auditor':
      return '数据审计';
    case 'scheduled_inspection':
      return '定时任务';
    case 'random_inspection':
      return '随机巡检';
    case 'auto_collab':
      return '营销协作';
    default:
      return String(s || '任务');
  }
}

function briefingTaskStatusZh(st) {
  const s = String(st || '').trim().toLowerCase();
  if (s === 'pending_response') return '待回复';
  if (s === 'pending_review') return '待审核';
  if (s === 'pending_dispatch' || s === 'dispatched') return '待分派/待送达';
  if (s === 'closed' || s === 'settled' || s === 'resolved') return '已闭环';
  if (s === 'rejected') return '已驳回';
  return st || '其它';
}

/** username → 飞书展示名（优先真实姓名 name，避免晨报里 @NNYX… 账号） */
async function briefAssigneeDisplayMap(usernames) {
  const u = [...new Set((usernames || []).map((x) => String(x || '').trim().toLowerCase()).filter(Boolean))];
  if (!u.length) return new Map();
  try {
    const r = await query(
      `SELECT lower(username) AS lu,
              NULLIF(trim(COALESCE(name, '')), '') AS nm
       FROM feishu_users
       WHERE lower(username) = ANY($1::text[])`,
      [u]
    );
    const m = new Map();
    for (const row of r.rows || []) {
      if (row.lu) m.set(row.lu, row.nm || null);
    }
    return m;
  } catch (e) {
    logger.warn({ err: e?.message }, 'briefAssigneeDisplayMap failed');
    return new Map();
  }
}

// 获取所有需要接收晨报的飞书用户（店长 + 总部）
async function getBriefingRecipients() {
  try {
    const r = await query(
      `SELECT open_id, username, name, store, role FROM feishu_users
       WHERE registered = true AND open_id IS NOT NULL AND open_id != ''
       AND role IN ('store_manager','store_production_manager','hq_manager','admin')
       ORDER BY role, store`
    );
    return r.rows || [];
  } catch (e) {
    logger.warn({ err: e?.message }, 'getBriefingRecipients failed');
    return [];
  }
}

function getShanghaiYmd() {
  return new Date().toLocaleString('en-CA', { timeZone: 'Asia/Shanghai' }).slice(0, 10);
}

function recipientScope(user) {
  return user.role === 'admin' || user.role === 'hq_manager' ? '__all_stores__' : String(user.store || '').trim();
}

async function ensureBriefingSendTable() {
  try {
    await query(`
      CREATE TABLE IF NOT EXISTS ${BRIEFING_SEND_TABLE} (
        id BIGSERIAL PRIMARY KEY,
        run_ymd TEXT NOT NULL,
        username TEXT NOT NULL,
        scope TEXT NOT NULL,
        ok BOOLEAN NOT NULL DEFAULT false,
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(run_ymd, username, scope)
      )`);
    await query(
      `CREATE INDEX IF NOT EXISTS idx_${BRIEFING_SEND_TABLE}_ymd_ok ON ${BRIEFING_SEND_TABLE} (run_ymd, ok, updated_at DESC)`
    );
  } catch (e) {
    logger.warn({ err: e?.message }, 'ensureBriefingSendTable failed');
  }
}

async function hasBriefingSuccess(runYmd, username, scope) {
  try {
    const r = await query(
      `SELECT 1 FROM ${BRIEFING_SEND_TABLE}
       WHERE run_ymd = $1 AND username = $2 AND scope = $3 AND ok = true
       LIMIT 1`,
      [runYmd, String(username || '').trim(), String(scope || '').trim()]
    );
    return !!(r.rows || []).length;
  } catch (e) {
    logger.warn({ err: e?.message, runYmd, username, scope }, 'hasBriefingSuccess failed');
    return false;
  }
}

async function recordBriefingAttempt(runYmd, username, scope, ok, errMsg = '') {
  try {
    await query(
      `INSERT INTO ${BRIEFING_SEND_TABLE} (run_ymd, username, scope, ok, attempts, last_error, updated_at)
       VALUES ($1, $2, $3, $4, 1, $5, NOW())
       ON CONFLICT (run_ymd, username, scope)
       DO UPDATE SET
         ok = ${BRIEFING_SEND_TABLE}.ok OR EXCLUDED.ok,
         attempts = ${BRIEFING_SEND_TABLE}.attempts + 1,
         last_error = CASE WHEN EXCLUDED.ok THEN NULL ELSE EXCLUDED.last_error END,
         updated_at = NOW()`,
      [runYmd, String(username || '').trim(), String(scope || '').trim(), !!ok, errMsg || null]
    );
  } catch (e) {
    logger.warn({ err: e?.message, runYmd, username, scope }, 'recordBriefingAttempt failed');
  }
}

// 构建单门店晨报内容（recipientName 用于桌访块抬头，与聊天侧展示风格一致）
async function buildStoreBriefing(store, { recipientName = '' } = {}) {
  const nowSh = new Date().toLocaleString('en-CA', { timeZone: 'Asia/Shanghai' });
  const today = nowSh.slice(0, 10);
  const yesterday = new Date(new Date(today + 'T00:00:00+08:00') - 86400000)
    .toLocaleString('en-CA', { timeZone: 'Asia/Shanghai' }).slice(0, 10);

  let sections = [];
  const storePatsBrief = briefingStoreSqlPatterns(store);

  // 1. 昨日营业数据
  try {
    const dr = await query(
      `SELECT date, actual_revenue, budget_rate, dine_traffic, dine_orders,
              delivery_actual, efficiency, pre_discount_revenue,
              operational_anomaly_note,
              COALESCE(recharge_count, 0)::int AS recharge_count,
              COALESCE(recharge_amount, 0)::numeric AS recharge_amount
       FROM daily_reports WHERE store ILIKE ANY($1::text[]) AND date = $2 LIMIT 1`,
      [storePatsBrief, yesterday]
    );
    if (dr.rows?.[0]) {
      const d = dr.rows[0];
      const rate = Number(d.budget_rate || 0);
      const rateIcon = rate >= 1 ? '✅' : rate >= 0.8 ? '⚠️' : '🔴';
      const opRaw = String(d.operational_anomaly_note || '').trim();
      const opOne = opRaw.replace(/\s+/g, ' ');
      const opLine = opOne
        ? `· **营运异常报备**：${opOne.slice(0, 600)}${opOne.length > 600 ? '…' : ''}`
        : '· **营运异常报备**：✅ 无（昨日营业日报未填写）';
      const rCnt = Math.floor(Number(d.recharge_count) || 0);
      const rAmt = Number(d.recharge_amount) || 0;
      const rWarn = rCnt === 0 && rAmt === 0 ? '　⚠️昨日无充值入账' : '';
      sections.push(
        `**📊 昨日营业 (${yesterday})**\n` +
        `· 实收营业额：${FMT_MONEY(d.actual_revenue)}　达成率：${rateIcon} ${FMT_PCT(d.budget_rate)}\n` +
        `· 堂食客流：${d.dine_traffic || 0}人　堂食桌数：${d.dine_orders || 0}桌\n` +
        `· 外卖营收：${FMT_MONEY(d.delivery_actual)}　人效：${FMT_MONEY(d.efficiency)}/人\n` +
        `· **充值（会员卡/储值）**：**${rCnt}** 笔　**${FMT_MONEY(rAmt)}**（营业日报）${rWarn}\n` +
        opLine
      );
    } else {
      sections.push(`**📊 昨日营业 (${yesterday})**\n⚠️ 暂未提交营业日报`);
    }
  } catch (e) { logger.warn({ err: e?.message, store }, 'briefing daily_reports'); }

  // 2. 本月进度（每店固定展示一块，与是否有「月目标」配置无关，避免有的店缺一节）
  try {
    const curMo = today.slice(0, 7);
    const moR = await query(
      `SELECT COALESCE(SUM(actual_revenue), 0) AS cur_rev FROM daily_reports
       WHERE store ILIKE ANY($1::text[]) AND TO_CHAR(date,'YYYY-MM') = $2`,
      [storePatsBrief, curMo]
    );
    const curRev = Number(moR.rows?.[0]?.cur_rev ?? 0);
    const tgt = await resolveMonthlyRevenueTargetYuan(store, curMo);
    const theoryLn = theoreticalProgressLine(today, yesterday, curMo);
    if (tgt > 0) {
      const ach = (curRev / tgt * 100).toFixed(1);
      const icon = +ach >= 100 ? '✅' : +ach >= 80 ? '⚠️' : '🔴';
      sections.push(
        `**🎯 本月进度 (${curMo})**\n` +
        `· 累计营收：${FMT_MONEY(curRev)}　月目标：${FMT_MONEY(tgt)}\n` +
        `· 达成率：${icon} **${ach}%**\n` +
        theoryLn
      );
    } else {
      sections.push(
        `**🎯 本月进度 (${curMo})**\n` +
        `· 累计营收：${FMT_MONEY(curRev)}　月目标：⚠️ **未配置**（请在营收目标中维护本店「${curMo}」目标）\n` +
        `· 达成率：—（配置目标后自动计算）\n` +
        theoryLn
      );
    }
  } catch (e) { logger.warn({ err: e?.message, store }, 'briefing monthly'); }

  // 3. 待办任务（提前于营运速览，避免飞书卡片过长时尾部被截断；门店名与任务库多别名对齐）
  try {
    const roleZh = (r) =>
      r === 'store_production_manager' ? '出品经理' : r === 'store_manager' ? '店长' : (r || '责任人');

    /** 派发日：优先 dispatched_at，否则 created_at，按 Asia/Shanghai 日历与「昨日」对齐 */
    const taskDaySql = `(timezone('Asia/Shanghai', COALESCE(dispatched_at, created_at)))::date = $2::date`;
    const storePats = briefingStoreSqlPatterns(store);

    const openCntR = await query(
      `SELECT COUNT(*)::int AS c FROM master_tasks
       WHERE store ILIKE ANY($1::text[]) AND ${taskDaySql}
         AND source = ANY($3::text[]) AND status = ANY($4::text[])`,
      [storePats, yesterday, BRIEFING_YESTERDAY_OPEN_SOURCES, BRIEFING_OPEN_STATUSES]
    );
    const openTotal = parseInt(openCntR.rows[0]?.c || 0, 10);

    const openR = await query(
      `SELECT task_id, title, status, source, timeout_at, assignee_username, assignee_role,
              COALESCE(remind_count,0)::int AS remind_count, COALESCE(review_count,0)::int AS review_count,
              COALESCE(hr_performance_recorded,false) AS hr_performance_recorded
       FROM master_tasks
       WHERE store ILIKE ANY($1::text[]) AND ${taskDaySql}
         AND source = ANY($3::text[]) AND status = ANY($4::text[])
       ORDER BY
         CASE WHEN COALESCE(hr_performance_recorded,false) THEN 0 ELSE 1 END,
         timeout_at ASC NULLS LAST,
         updated_at DESC NULLS LAST
       LIMIT 30`,
      [storePats, yesterday, BRIEFING_YESTERDAY_OPEN_SOURCES, BRIEFING_OPEN_STATUSES]
    );

    const backlogCntR = await query(
      `SELECT COUNT(*)::int AS c FROM master_tasks
       WHERE store ILIKE ANY($1::text[])
         AND source = ANY($2::text[]) AND status = ANY($3::text[])
         AND NOT ((timezone('Asia/Shanghai', COALESCE(dispatched_at, created_at)))::date = $4::date)
         AND COALESCE(hr_performance_recorded, false) = false
         AND dispatched_at >= CURRENT_DATE - INTERVAL '30 days'`
    );
    const backlogTotal = parseInt(backlogCntR.rows[0]?.c || 0, 10);

    const backlogR = backlogTotal
      ? await query(
          `SELECT task_id, title, status, source, timeout_at, assignee_username, assignee_role,
                  COALESCE(remind_count,0)::int AS remind_count, COALESCE(review_count,0)::int AS review_count,
                  COALESCE(hr_performance_recorded,false) AS hr_performance_recorded,
                  (timezone('Asia/Shanghai', COALESCE(dispatched_at, created_at)))::date AS dispatch_day
           FROM master_tasks
           WHERE store ILIKE ANY($1::text[])
             AND source = ANY($2::text[]) AND status = ANY($3::text[])
             AND NOT ((timezone('Asia/Shanghai', COALESCE(dispatched_at, created_at)))::date = $4::date)
             AND COALESCE(hr_performance_recorded, false) = false
             AND dispatched_at >= CURRENT_DATE - INTERVAL '30 days'
           ORDER BY timeout_at ASC NULLS LAST, updated_at DESC NULLS LAST
           LIMIT 8`,
          [storePats, BRIEFING_YESTERDAY_OPEN_SOURCES, BRIEFING_OPEN_STATUSES, yesterday]
        )
      : { rows: [] };

    const taskUsernames = [...(openR.rows || []), ...(backlogR.rows || [])]
      .map((t) => t.assignee_username)
      .filter(Boolean);
    const displayNameMap = await briefAssigneeDisplayMap(taskUsernames);

    const fmtOpenLines = (rows, opts = {}) =>
      (rows || []).map((t) => {
        const deadline = t.timeout_at
          ? String(t.timeout_at).slice(5, 16).replace('T', ' ')
          : '无截止';
        const overdue = t.timeout_at && new Date(t.timeout_at) < new Date();
        const urgency = overdue ? '🔴' : '📌';
        const un = t.assignee_username ? String(t.assignee_username).trim() : '';
        const nm = un ? displayNameMap.get(un.toLowerCase()) : null;
        const atLabel = nm || (un ? '责任人（未匹配飞书姓名）' : '');
        const who = un
          ? `@${atLabel}（${roleZh(t.assignee_role)}）`
          : `默认${roleZh(t.assignee_role)}`;
        const stZh = briefingTaskStatusZh(t.status);
        const rc = Math.min(3, Math.max(0, parseInt(t.remind_count ?? 0, 10) || 0));
        const rv = Math.min(3, Math.max(0, parseInt(t.review_count ?? 0, 10) || 0));
        let trail = '';
        if (String(t.status) === 'pending_review') {
          trail = `｜审核累计 ${rv}/3 次`;
        } else if (String(t.status) === 'pending_response') {
          trail = `｜催办 ${rc}/3 次`;
        }
        const flagged = t.hr_performance_recorded ? '｜HR已备案' : '';
        const ttl = briefingPrettyTaskTitle(t.title);
        const src = briefingSourceLabel(t.source);
        const dday =
          opts.showDispatch && t.dispatch_day
            ? `｜派发日 ${String(t.dispatch_day).slice(0, 10)}`
            : '';
        return `${urgency} [${t.task_id}] ${src}｜**${stZh}**｜${ttl.slice(0, 40)}｜${who}｜截止 ${deadline}${dday}${trail}${flagged}`;
      });

    const yLines =
      openTotal > 0
        ? fmtOpenLines(openR.rows || []).join('\n') +
          (openTotal > (openR.rows?.length || 0) ? `\n_…共 ${openTotal} 条，此处最多列 30 条_` : '')
        : `✅ 无（昨日未派发此类任务，或均已闭环）。`;

    const bLines =
      backlogTotal > 0
        ? fmtOpenLines(backlogR.rows || [], { showDispatch: true }).join('\n') +
          (backlogTotal > (backlogR.rows?.length || 0) ? `\n_…共 ${backlogTotal} 条较早未闭环，此处最多列 8 条_` : '')
        : '';

    sections.push(
      `**📋 待办任务**\n\n` +
        `**（1）昨日派发 · 仍待处理（${yesterday}）**　**${openTotal} 条**\n` +
        `_派发/创建日=昨日（上海）且未闭环：BI 异常、数据审计、定时、抽检、协作。_\n` +
        `${yLines}` +
        (bLines
          ? `\n\n**（2）更早派发 · 仍待处理**　**${backlogTotal} 条**\n` +
            `_非昨日派发日的积压，便于排查是否漏处理。_\n` +
            bLines
          : '') +
        `\n\n**催办与 HR 备案**\n` +
        '· **待回复**：约每 **1 小时**可催 1 次；**满 3 次催办 + 再等 1 小时**仍无有效闭环：**BI 异常任务卡、定时任务、随机抽检、数据审计、营销协作** → **仅**记入工作态度未完成（`hr_performance_recorded`），影响当月态度评级；**不因催办写入 agent_scores 扣分**。**BI 异常触发的绩效扣分**仅按 BI 规则在周度 **anomaly_rollups_v2** 中计算，与任务卡催办无关。均 **【公司通知】**（飞书卡片+文本）。\n' +
        '· **待审核**：回复连续 **3 次**不合格 → **工作态度**备案（与任务卡说明一致：**不计**绩效分），并 **【公司通知】**。\n' +
        '· 已打标 `hr_performance_recorded` 时行末显示「HR已备案」。'
    );
  } catch (e) { logger.warn({ err: e?.message, store }, 'briefing tasks'); }

  // 2b. 昨日桌访 + 开档 + 收档 + 例会 + 原料（放在待办之后，避免卡片过长截断待办）
  try {
    const opsMd = await buildYesterdayOpsBriefingSection(store, yesterday, {
      displayName: String(recipientName || '').trim()
    });
    if (opsMd) sections.push(opsMd);
  } catch (e) {
    logger.warn({ err: e?.message, store }, 'briefing yesterday ops');
    sections.push(`**──────── 昨日营运速览 ────────**\n⚠️ 加载失败：${e?.message || '未知错误'}`);
  }

  // 4. 昨日差评（飞书差评报告：含逐条文字，便于店长跟进）
  try {
    const br = await getBadReviewRowsForStoreDateRange(store, yesterday, yesterday);
    if (br.length) {
      const head = [
        `**💬 昨日差评（${yesterday}）**`,
        `_来源：飞书「差评报告」同步表（\`feishu_generic_records\`，config_key=bad_review）_`,
        `· 差评总数：**${br.length}** 条`,
        ''
      ];
      const body = [];
      br.slice(0, 10).forEach((row, i) => {
        const f = row.fields && typeof row.fields === 'object' ? row.fields : {};
        const plat = pickReviewPlatform(f);
        const prod = String(f['差评产品'] || f['product_name'] || '').trim();
        let txt = pickReviewText(f);
        if (txt.length > 500) txt = `${txt.slice(0, 500)}…`;
        body.push(`${i + 1}. **${plat}**${prod ? ` · 产品：${prod}` : ''}`);
        body.push(txt ? `   内容：${txt}` : '   内容：（记录中暂无评价正文，请在飞书多维表补充「评价内容」等字段）');
      });
      if (br.length > 10) body.push('', `_…共 ${br.length} 条，晨报展示前 10 条；完整列表可在飞书问「昨天差评情况」_`);
      sections.push([...head, ...body].join('\n'));
    } else {
      sections.push(`**💬 昨日差评（${yesterday}）**\n✅ 飞书差评报告中无该日记录`);
    }
  } catch (e) { logger.warn({ err: e?.message, store }, 'briefing bad_review'); }

  // 5. 近3天异常（去重：同店同日同类型只保留最新一条；中文标签）
  try {
    const anomalies = await query(
      `SELECT anomaly_key, severity, trigger_date::date AS td
       FROM (
         SELECT anomaly_key, severity, trigger_date, created_at,
                ROW_NUMBER() OVER (
                  PARTITION BY anomaly_key, store, trigger_date::date
                  ORDER BY created_at DESC NULLS LAST
                ) AS rn
         FROM anomaly_triggers
         WHERE store ILIKE ANY($1::text[])
           AND trigger_date >= (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Shanghai')::date - INTERVAL '3 days'
       ) sub
       WHERE rn = 1
       ORDER BY td DESC
       LIMIT 8`,
      [briefingStoreSqlPatterns(store)]
    );
    if (anomalies.rows?.length) {
      const aLines = anomalies.rows.map(a => {
        const name = ANOMALY_LABEL_ZH[a.anomaly_key] || a.anomaly_key;
        return `⚠️ ${name}（严重度：${severityZh(a.severity)}）· ${String(a.td).slice(0, 10)}`;
      });
      sections.push(`**🚨 近3天异常提醒**\n${aLines.join('\n')}`);
    }
  } catch (e) { logger.warn({ err: e?.message, store }, 'briefing anomalies'); }

  return sections.join('\n\n---\n\n');
}

// 发送晨报飞书卡片
async function sendMorningBriefingToUser(user, storeContent, store) {
  const nowSh = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
  const greeting = `🌅 早安，${user.name || user.username}！今日经营晨报已就绪`;

  const card = {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: `🌅 每日晨报 · ${store}` },
      template: 'blue'
    },
    elements: [
      {
        tag: 'div',
        text: { tag: 'lark_md', content: `**${greeting}**\n${nowSh.slice(0, -3)}` }
      },
      { tag: 'hr' },
      {
        tag: 'div',
        text: { tag: 'lark_md', content: storeContent || '暂无数据' }
      },
      { tag: 'hr' },
      {
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: '💬 如需详细分析，在飞书中直接发送：「分析一下最近生意」或「查看待办任务」'
        }
      }
    ]
  };

  try {
    const result = await sendCard(user.open_id, card);
    if (result?.ok === false) {
      logger.warn({ user: user.username, store, error: result.error, data: result.data }, 'morning briefing send FAILED (Feishu API error)');
      return { ok: false, error: String(result.error || result.data?.msg || 'feishu_send_failed') };
    } else {
      logger.info({ user: user.username, store, openId: user.open_id }, 'morning briefing sent OK');
      return { ok: true };
    }
  } catch (e) {
    logger.warn({ err: e?.message, user: user.username }, 'morning briefing send exception');
    return { ok: false, error: String(e?.message || 'send_exception') };
  }
}

/** 与主 cron 07:30、sweep 补偿（至 10:30）对齐；非此窗口的调用一律忽略，避免误触发（如异常时刻的补偿任务）。手动发报：options.force=true 或 POST /api/briefing/send-now */
export async function sendMorningBriefing(options = {}) {
  const force = !!options.force;
  if (!force) {
    const { minuteOfDay } = getShanghaiNowClock();
    const winStart = 7 * 60 + 25;
    const winEnd = 10 * 60 + 35;
    if (minuteOfDay < winStart || minuteOfDay > winEnd) {
      logger.warn(
        { minuteOfDay, winStart, winEnd },
        'morning briefing skipped: outside Shanghai window 07:25–10:35 (use force or admin send-now)'
      );
      return;
    }
  }
  logger.info({ force }, 'morning briefing starting...');
  try {
    await query(`ALTER TABLE master_tasks ADD COLUMN IF NOT EXISTS hr_performance_recorded BOOLEAN DEFAULT FALSE`);
  } catch (e) { /* ignore */ }
  const recipients = await getBriefingRecipients();
  if (!recipients.length) {
    logger.warn('no briefing recipients found');
    return;
  }
  await ensureBriefingSendTable();
  const runYmd = getShanghaiYmd();

  // 按门店归组（总部管理员接收所有门店摘要；排除「总部」等非经营门店，避免无意义整块）
  const stores = [...new Set(recipients.filter(u => u.store).map(u => u.store))].filter(
    (s) => !isBriefingExcludedStore(s)
  );
  let failedRecipients = 0;

  for (const user of recipients) {
    try {
      const scope = recipientScope(user);
      if (await hasBriefingSuccess(runYmd, user.username, scope)) {
        logger.info({ runYmd, user: user.username, scope }, 'morning briefing skip: already sent OK');
        continue;
      }
      let payload = null;
      let storeLabel = '';
      if (user.role === 'admin' || user.role === 'hq_manager') {
        // 总部：仅拼接各实体门店，不包含管理部门「总部」假门店
        const allParts = [];
        for (const s of stores) {
          const content = await buildStoreBriefing(s, {});
          if (content) allParts.push(`**【${s}】**\n${content}`);
        }
        if (allParts.length) {
          payload = allParts.join('\n\n---\n\n');
          storeLabel = '全门店汇总';
        }
      } else if (user.store) {
        // 门店负责人/出品经理：只看本门店
        const content = await buildStoreBriefing(user.store, {
          recipientName: user.name || user.username || ''
        });
        if (content) {
          payload = content;
          storeLabel = user.store;
        }
      }
      if (!payload) continue;
      let ok = false;
      let lastErr = '';
      for (let i = 1; i <= BRIEFING_RETRY_MAX; i++) {
        const r = await sendMorningBriefingToUser(user, payload, storeLabel);
        ok = !!r?.ok;
        lastErr = r?.error || '';
        await recordBriefingAttempt(runYmd, user.username, scope, ok, lastErr);
        if (ok) break;
        if (i < BRIEFING_RETRY_MAX) {
          await new Promise((resolve) => setTimeout(resolve, 1200));
        }
      }
      if (!ok) {
        failedRecipients += 1;
        logger.warn({ runYmd, user: user.username, scope, error: lastErr }, 'morning briefing recipient failed after retries');
      }
    } catch (e) {
      failedRecipients += 1;
      logger.warn({ err: e?.message, user: user.username }, 'briefing user error');
    }
  }

  if (failedRecipients > 0) {
    throw new Error(`morning briefing partial failure: ${failedRecipients} recipient(s) failed`);
  }
  logger.info({ stores: stores.length, users: recipients.length }, 'morning briefing done');
}
