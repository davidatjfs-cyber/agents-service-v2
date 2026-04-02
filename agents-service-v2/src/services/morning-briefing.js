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

const FMT_MONEY = (n) => `¥${Number(n || 0).toLocaleString('zh-CN', { maximumFractionDigits: 0 })}`;
const FMT_PCT   = (n) => `${(Number(n || 0) * 100).toFixed(1)}%`;

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
  const keys = ['评价内容', '差评原因', 'content', 'reason', '差评内容', '备注'];
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
 * 晨报「待处理/备案任务」白名单：仅展示异常类闭环任务。
 * - bi_anomaly：agents-service-v2 异常引擎 + 通知管线写入
 * - data_auditor：HRMS runDataAuditor → agent_issues → master_tasks 同步（MT-*）
 * 排除：scheduled_checklist(OPS-*)、scheduled_inspection、random_inspection、auto_collab 等控制台非异常项
 */
const BRIEFING_PENDING_TASK_SOURCES = ['bi_anomaly', 'data_auditor'];

/** 晨报「待处理」仅展示日频闭环：周/月维度的 BI 任务（桌访产品、桌访占比、营收达成、差评、包房、毛利等）不进入晨报，避免标题里出现整周区间造成「天天同一批周期任务」 */
const BRIEFING_BI_WEEKLY_MONTHLY_CATEGORIES = [
  'table_visit_product',
  'table_visit_ratio',
  'revenue_achievement',
  'revenue_achievement_monthly',
  'gross_margin',
  'bad_review_product',
  'bad_review_service',
  'hongchao_jiuguang_private_room'
];

/** 禁止把「未写 frequency」默认当 daily，否则 gross_margin 等周/月键在库里缺字段时会误进晨报 */
const BRIEFING_BI_DAILY_ONLY_SQL = `AND (
  source = 'data_auditor'
  OR (
    source = 'bi_anomaly'
    AND (
      lower(trim(COALESCE(source_data->>'anomaly_frequency', ''))) = 'daily'
      OR (
        (source_data->>'anomaly_frequency' IS NULL OR trim(source_data->>'anomaly_frequency') = '')
        AND NOT (category = ANY($4::text[]))
      )
    )
  )
)`;

/** data_auditor 任务：晨报仅展示「业务日 = 昨日」的日频项；周标签(YYYY-Www)等不进入昨日待办，避免标题出现整周区间 */
const BRIEFING_DATA_AUDITOR_YESTERDAY_SQL = `AND (
  source <> 'data_auditor'
  OR (
    NULLIF(trim(COALESCE(source_data->>'date', '')), '') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
    AND trim(COALESCE(source_data->>'date', '')) = $2::text
  )
)`;

/** 晨报待办：data_auditor 仅保留「真·日频」闭环（充值/单日人效）；周桌访/周差评/周毛利等走周审计，勿进昨日待办 */
const BRIEFING_DATA_AUDITOR_ALLOW_CATEGORIES = ['充值异常', '人效值异常'];
const BRIEFING_DATA_AUDITOR_CATEGORY_SQL = `AND (
  source <> 'data_auditor'
  OR (category = ANY($5::text[]))
)`;

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

// 构建单门店晨报内容（recipientName 用于桌访块抬头，与聊天侧展示风格一致）
async function buildStoreBriefing(store, { recipientName = '' } = {}) {
  const nowSh = new Date().toLocaleString('en-CA', { timeZone: 'Asia/Shanghai' });
  const today = nowSh.slice(0, 10);
  const yesterday = new Date(new Date(today + 'T00:00:00+08:00') - 86400000)
    .toLocaleString('en-CA', { timeZone: 'Asia/Shanghai' }).slice(0, 10);

  let sections = [];

  // 1. 昨日营业数据
  try {
    const dr = await query(
      `SELECT date, actual_revenue, budget_rate, dine_traffic, dine_orders,
              delivery_actual, efficiency, pre_discount_revenue,
              operational_anomaly_note
       FROM daily_reports WHERE store ILIKE $1 AND date = $2 LIMIT 1`,
      [`%${store}%`, yesterday]
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
      sections.push(
        `**📊 昨日营业 (${yesterday})**\n` +
        `· 实收营业额：${FMT_MONEY(d.actual_revenue)}　达成率：${rateIcon} ${FMT_PCT(d.budget_rate)}\n` +
        `· 堂食客流：${d.dine_traffic || 0}人　堂食桌数：${d.dine_orders || 0}桌\n` +
        `· 外卖营收：${FMT_MONEY(d.delivery_actual)}　人效：${FMT_MONEY(d.efficiency)}/人\n` +
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
       WHERE store ILIKE $1 AND TO_CHAR(date,'YYYY-MM') = $2`,
      [`%${store}%`, curMo]
    );
    const curRev = Number(moR.rows?.[0]?.cur_rev ?? 0);
    const tgt = await resolveMonthlyRevenueTargetYuan(store, curMo);
    if (tgt > 0) {
      const ach = (curRev / tgt * 100).toFixed(1);
      const icon = +ach >= 100 ? '✅' : +ach >= 80 ? '⚠️' : '🔴';
      sections.push(
        `**🎯 本月进度 (${curMo})**\n` +
        `· 累计营收：${FMT_MONEY(curRev)}　月目标：${FMT_MONEY(tgt)}\n` +
        `· 达成率：${icon} **${ach}%**`
      );
    } else {
      sections.push(
        `**🎯 本月进度 (${curMo})**\n` +
        `· 累计营收：${FMT_MONEY(curRev)}　月目标：⚠️ **未配置**（请在营收目标中维护本店「${curMo}」目标）\n` +
        `· 达成率：—（配置目标后自动计算）`
      );
    }
  } catch (e) { logger.warn({ err: e?.message, store }, 'briefing monthly'); }

  // 2b. 昨日桌访 + 开档 + 收档 + 例会 + 原料（与飞书助手问答同源口径）
  try {
    const opsMd = await buildYesterdayOpsBriefingSection(store, yesterday, {
      displayName: String(recipientName || '').trim()
    });
    if (opsMd) sections.push(opsMd);
  } catch (e) {
    logger.warn({ err: e?.message, store }, 'briefing yesterday ops');
    sections.push(`**──────── 昨日营运速览 ────────**\n⚠️ 加载失败：${e?.message || '未知错误'}`);
  }

  // 3. 任务跟进（晨报口径：**仅昨日上海日历当天派发的任务**，不含历史积压，避免与多日前的 INSP-* 混淆）
  try {
    const roleZh = (r) =>
      r === 'store_production_manager' ? '出品经理' : r === 'store_manager' ? '店长' : (r || '责任人');

    /** 派发日：优先 dispatched_at，否则 created_at，按 Asia/Shanghai 日历与「昨日」对齐 */
    const taskDaySql = `(timezone('Asia/Shanghai', COALESCE(dispatched_at, created_at)))::date = $2::date`;

    const perfCntR = await query(
      `SELECT COUNT(*)::int AS c FROM master_tasks
       WHERE store ILIKE $1 AND ${taskDaySql}
         AND source = ANY($3::text[])
         ${BRIEFING_BI_DAILY_ONLY_SQL}
         ${BRIEFING_DATA_AUDITOR_YESTERDAY_SQL}
         ${BRIEFING_DATA_AUDITOR_CATEGORY_SQL}
         AND COALESCE(hr_performance_recorded,false) = true
         AND status IN ('pending_response','pending_review')`,
      [
        `%${store}%`,
        yesterday,
        BRIEFING_PENDING_TASK_SOURCES,
        BRIEFING_BI_WEEKLY_MONTHLY_CATEGORIES,
        BRIEFING_DATA_AUDITOR_ALLOW_CATEGORIES
      ]
    );
    const perfTotal = parseInt(perfCntR.rows[0]?.c || 0, 10);
    const perfR = await query(
      `SELECT task_id, title, status, source, timeout_at, assignee_username, assignee_role,
              COALESCE(remind_count,0)::int AS remind_count, COALESCE(review_count,0)::int AS review_count
       FROM master_tasks
       WHERE store ILIKE $1 AND ${taskDaySql}
         AND source = ANY($3::text[])
         ${BRIEFING_BI_DAILY_ONLY_SQL}
         ${BRIEFING_DATA_AUDITOR_YESTERDAY_SQL}
         ${BRIEFING_DATA_AUDITOR_CATEGORY_SQL}
         AND COALESCE(hr_performance_recorded,false) = true
         AND status IN ('pending_response','pending_review')
       ORDER BY updated_at DESC NULLS LAST LIMIT 5`,
      [
        `%${store}%`,
        yesterday,
        BRIEFING_PENDING_TASK_SOURCES,
        BRIEFING_BI_WEEKLY_MONTHLY_CATEGORIES,
        BRIEFING_DATA_AUDITOR_ALLOW_CATEGORIES
      ]
    );

    const pendCntR = await query(
      `SELECT COUNT(*)::int AS c FROM master_tasks
       WHERE store ILIKE $1 AND ${taskDaySql}
         AND source = ANY($3::text[])
         ${BRIEFING_BI_DAILY_ONLY_SQL}
         ${BRIEFING_DATA_AUDITOR_YESTERDAY_SQL}
         ${BRIEFING_DATA_AUDITOR_CATEGORY_SQL}
         AND status IN ('pending_response','pending_review')
         AND COALESCE(hr_performance_recorded,false) = false`,
      [
        `%${store}%`,
        yesterday,
        BRIEFING_PENDING_TASK_SOURCES,
        BRIEFING_BI_WEEKLY_MONTHLY_CATEGORIES,
        BRIEFING_DATA_AUDITOR_ALLOW_CATEGORIES
      ]
    );
    const pendTotal = parseInt(pendCntR.rows[0]?.c || 0, 10);
    const pendR = await query(
      `SELECT task_id, title, status, source, timeout_at, assignee_username, assignee_role,
              COALESCE(remind_count,0)::int AS remind_count, COALESCE(review_count,0)::int AS review_count
       FROM master_tasks
       WHERE store ILIKE $1 AND ${taskDaySql}
         AND source = ANY($3::text[])
         ${BRIEFING_BI_DAILY_ONLY_SQL}
         ${BRIEFING_DATA_AUDITOR_YESTERDAY_SQL}
         ${BRIEFING_DATA_AUDITOR_CATEGORY_SQL}
         AND status IN ('pending_response','pending_review')
         AND COALESCE(hr_performance_recorded,false) = false
       ORDER BY timeout_at ASC NULLS LAST LIMIT 5`,
      [
        `%${store}%`,
        yesterday,
        BRIEFING_PENDING_TASK_SOURCES,
        BRIEFING_BI_WEEKLY_MONTHLY_CATEGORIES,
        BRIEFING_DATA_AUDITOR_ALLOW_CATEGORIES
      ]
    );

    const taskUsernames = [...(perfR.rows || []), ...(pendR.rows || [])]
      .map((t) => t.assignee_username)
      .filter(Boolean);
    const displayNameMap = await briefAssigneeDisplayMap(taskUsernames);

    /** 每条附带催办/审核进度；责任人展示飞书姓名，不展示内部账号串 */
    const fmtTaskLines = (rows) => rows.map((t) => {
      const deadline = t.timeout_at
        ? String(t.timeout_at).slice(5, 16).replace('T', ' ')
        : '无截止';
      const urgency = t.timeout_at && new Date(t.timeout_at) < new Date() ? '🔴' : '📌';
      const un = t.assignee_username ? String(t.assignee_username).trim() : '';
      const nm = un ? displayNameMap.get(un.toLowerCase()) : null;
      const atLabel = nm || (un ? '责任人（未匹配飞书姓名）' : '');
      const who = un
        ? `@${atLabel}（${roleZh(t.assignee_role)}）`
        : `默认${roleZh(t.assignee_role)}`;
      const rc = Math.min(3, Math.max(0, parseInt(t.remind_count ?? 0, 10) || 0));
      const rv = Math.min(3, Math.max(0, parseInt(t.review_count ?? 0, 10) || 0));
      let trail = '';
      if (String(t.status) === 'pending_review') {
        trail = `｜待审核｜审核累计 ${rv}/3 次`;
      } else {
        trail = `｜待回复｜催办 ${rc}/3 次`;
      }
      const ttl = briefingPrettyTaskTitle(t.title);
      return `${urgency} [${t.task_id}] ${ttl.slice(0, 48)}｜${who}｜截止 ${deadline}${trail}`;
    });

    if (perfTotal > 0) {
      sections.push(
        `**⚠️ 已备案工作态度的任务（昨日 ${yesterday} 派发 · ${perfTotal}个）**\n` +
        `_以下任务已打**工作态度备案**标（**不计入绩效总分**），且来源为 **BI 异常 / 数据审计**；若仍待回复/待审核请优先处理。仅含 **${yesterday}** 派发。_\n` +
        fmtTaskLines(perfR.rows || []).join('\n') +
        (perfTotal > (perfR.rows?.length || 0) ? `\n_…共${perfTotal}个，此处仅列5条_` : '') +
        '\n_触发条件：「满 3 次催办 + 再等 1 小时仍无有效回复」或「回复连续 **3 次**审核不合格」。_'
      );
    }

    if (pendTotal > 0) {
      sections.push(
        `**📋 待处理任务（昨日 ${yesterday} 派发 · ${pendTotal}个）**\n` +
        `_仅含 **日频** BI 异常，及数据审计中 **昨日单日** 的 **充值异常 / 人效值异常**；**不含**周/月维度的桌访、差评、桌访占比、实收营收累计、毛利等 MT 任务。仅统计 **${yesterday}** 派发。_\n` +
        fmtTaskLines(pendR.rows || []).join('\n') +
        (pendTotal > (pendR.rows?.length || 0) ? `\n_…共${pendTotal}个，此处仅列5条_` : '') +
        '\n\n**为何还没备案？（核心）**\n' +
        '· **待回复**：自动催办约每 **1 小时**可记 1 次，**满 3 次后还须再经过 1 小时**仍无有效回复，才会**改打标**并记入工作态度统计（请看每行末尾「催办 x/3」）。\n' +
        '· **待审核**：已提交回复、在等审核，**不走「未回复催办」**；若审核不通过，须累计 **3 次不合格**才打标备案（请看「审核累计 x/3」）。\n' +
        '· **打标之后**：同一条会**只出现在上方「已备案工作态度的任务」**，**不再**出现在本节「待处理」。'
      );
    } else if (perfTotal === 0) {
      sections.push(
        `**📋 昨日派发任务（${yesterday}）**\n✅ 无「待处理」项（晨报仅统计异常类任务；昨日无此类未闭环项）。`
      );
    }
  } catch (e) { logger.warn({ err: e?.message, store }, 'briefing tasks'); }

  // 4. 昨日差评摘要（飞书差评报告）
  try {
    const br = await getBadReviewRowsForStoreDateRange(store, yesterday, yesterday);
    if (br.length) {
      const byPlat = new Map();
      for (const row of br) {
        const f = row.fields && typeof row.fields === 'object' ? row.fields : {};
        const plat = pickReviewPlatform(f);
        const txt = pickReviewText(f);
        if (!byPlat.has(plat)) byPlat.set(plat, []);
        if (txt) byPlat.get(plat).push(txt.slice(0, 120));
      }
      const parts = [];
      for (const [plat, texts] of byPlat) {
        parts.push(`· **${plat}** ${texts.length}条｜摘要：${texts[0] || '（无文字摘要）'}${texts.length > 1 ? '…' : ''}`);
      }
      sections.push(`**💬 昨日差评（${yesterday}）**\n${parts.join('\n')}`);
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
         WHERE store ILIKE $1
           AND trigger_date >= (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Shanghai')::date - INTERVAL '3 days'
       ) sub
       WHERE rn = 1
       ORDER BY td DESC
       LIMIT 8`,
      [`%${store}%`]
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
    } else {
      logger.info({ user: user.username, store, openId: user.open_id }, 'morning briefing sent OK');
    }
  } catch (e) {
    logger.warn({ err: e?.message, user: user.username }, 'morning briefing send exception');
  }
}

// 主入口：发送所有门店的晨报
export async function sendMorningBriefing() {
  logger.info('morning briefing starting...');
  try {
    await query(`ALTER TABLE master_tasks ADD COLUMN IF NOT EXISTS hr_performance_recorded BOOLEAN DEFAULT FALSE`);
  } catch (e) { /* ignore */ }
  const recipients = await getBriefingRecipients();
  if (!recipients.length) {
    logger.warn('no briefing recipients found');
    return;
  }

  // 按门店归组（总部管理员接收所有门店摘要；排除「总部」等非经营门店，避免无意义整块）
  const stores = [...new Set(recipients.filter(u => u.store).map(u => u.store))].filter(
    (s) => !isBriefingExcludedStore(s)
  );

  for (const user of recipients) {
    try {
      if (user.role === 'admin' || user.role === 'hq_manager') {
        // 总部：仅拼接各实体门店，不包含管理部门「总部」假门店
        const allParts = [];
        for (const s of stores) {
          const content = await buildStoreBriefing(s, {});
          if (content) allParts.push(`**【${s}】**\n${content}`);
        }
        if (allParts.length) {
          await sendMorningBriefingToUser(user, allParts.join('\n\n---\n\n'), '全门店汇总');
        }
      } else if (user.store) {
        // 门店负责人/出品经理：只看本门店
        const content = await buildStoreBriefing(user.store, {
          recipientName: user.name || user.username || ''
        });
        if (content) {
          await sendMorningBriefingToUser(user, content, user.store);
        }
      }
    } catch (e) {
      logger.warn({ err: e?.message, user: user.username }, 'briefing user error');
    }
  }

  logger.info({ stores: stores.length, users: recipients.length }, 'morning briefing done');
}
