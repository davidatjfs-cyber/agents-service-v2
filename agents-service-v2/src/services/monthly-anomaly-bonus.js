/**
 * 上月「未触发」异常项：负责人每项 +10 分（写入 agent_scores，独立 period / score_model）
 * 定时：每月 10 日 00:30（上海），早于 monthly-comprehensive-rating 的 01:18。
 */
import { query } from '../utils/db.js';
import { logger } from '../utils/logger.js';
import { ensureHrmsUserNotificationsTable } from '../utils/hrms-user-notifications.js';
import { getBrandForStore } from './config-service.js';
import { sendCard, buildBiBonusCard } from './feishu-client.js';

function pad(n) {
  return String(n).padStart(2, '0');
}

function shanghaiPrevMonthBounds() {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });
  const today = fmt.format(new Date());
  const [y, m] = today.split('-').map(Number);
  let py = y;
  let pm = m - 1;
  if (pm < 1) {
    pm = 12;
    py -= 1;
  }
  const monthDays = new Date(py, pm, 0).getDate();
  const start = `${py}-${pad(pm)}-01`;
  const end = `${py}-${pad(pm)}-${String(monthDays).padStart(2, '0')}`;
  return { start, end, label: `${py}-${pad(pm)}` };
}

function isJiuguangStore(store) {
  return /(大宁久光|洪潮久光)/.test(String(store || ''));
}

async function resolveScoringUser(store, role) {
  try {
    const r = await query(
      `SELECT username, COALESCE(NULLIF(TRIM(name),''), username) AS disp
       FROM feishu_users
       WHERE registered = true AND role = $2
         AND (store = $1 OR $1 ILIKE '%' || store || '%' OR store ILIKE '%' || $1 || '%')
       ORDER BY updated_at DESC NULLS LAST
       LIMIT 1`,
      [store, role]
    );
    const row = r.rows?.[0];
    if (row?.username) return { username: row.username, name: row.disp || row.username };
  } catch (_e) {
    /* ignore */
  }
  if (role === 'store_manager') return { username: '__periodic_store_manager__', name: '店长(周度自动·未绑定)' };
  return { username: '__periodic_kitchen__', name: '出品经理(周度自动·未绑定)' };
}

async function hadTriggerInRange(store, keys, start, end) {
  if (!keys.length) return false;
  const r = await query(
    `SELECT 1 FROM anomaly_triggers
     WHERE store = $1
       AND anomaly_key = ANY($2::text[])
       AND trigger_date >= $3::date AND trigger_date <= $4::date
     LIMIT 1`,
    [store, keys, start, end]
  );
  return (r.rows || []).length > 0;
}

async function fetchLatestRollupScore(username) {
  if (!username || String(username).startsWith('__periodic')) return 100;
  try {
    const scoreRes = await query(
      `SELECT total_score FROM agent_scores
       WHERE username = $1 AND score_model = 'anomaly_rollups_v2'
       ORDER BY updated_at DESC LIMIT 1`,
      [username]
    );
    if (scoreRes.rows?.[0]?.total_score != null) {
      return Math.max(0, Number(scoreRes.rows[0].total_score));
    }
  } catch (_e) {
    /* ignore */
  }
  return 100;
}

/** 飞书卡片（与扣分卡同版式）+ HRMS 公司通知 + 管理层抄送 */
async function notifyBiMonthlyBonus({
  username,
  name,
  store,
  role,
  label,
  start,
  end,
  additions,
  bonus,
  recordedTotal
}) {
  await ensureHrmsUserNotificationsTable();

  const rollupScore = await fetchLatestRollupScore(username);
  const periodZh = `上月 ${label}（${start}～${end}）`;
  const bonusLines = additions
    .map((a) => `• **${a.label}**：+${a.points} 分（${a.reason}）`)
    .join('\n');

  const card = buildBiBonusCard({
    store,
    assigneeName: name || username,
    role,
    period: periodZh,
    bonusLines,
    rollupScore,
    bonusPoints: bonus,
    recordedTotal
  });

  const metaJson = JSON.stringify({
    store,
    role,
    month: label,
    bonus,
    recorded_total: recordedTotal,
    additions,
    score_model: 'anomaly_item_monthly_bonus'
  });
  const msg = `上月（${label}）BI 异常未触发共 ${additions.length} 项，+${bonus} 分；备案写入总分 ${recordedTotal} 分（独立 score_model）。`;

  try {
    await query(
      `INSERT INTO hrms_user_notifications (target_username, title, message, type, meta)
       VALUES ($1, $2, $3, $4, $5::jsonb)`,
      [username, 'BI异常未触发加分', msg, 'bi_anomaly_monthly_bonus', metaJson]
    );
  } catch (e) {
    logger.warn({ err: e?.message, username }, 'monthly bonus hrms insert failed');
  }

  let assigneeOpenId = null;
  try {
    const fu = await query(
      `SELECT open_id FROM feishu_users WHERE username = $1 AND registered = true AND open_id IS NOT NULL LIMIT 1`,
      [username]
    );
    assigneeOpenId = fu.rows?.[0]?.open_id || null;
  } catch (_e) {
    /* ignore */
  }

  if (assigneeOpenId) {
    try {
      await sendCard(assigneeOpenId, card, 'open_id');
    } catch (e) {
      logger.warn({ err: e?.message, username }, 'monthly bonus feishu card failed');
    }
  }

  let mgmtOpenIds = [];
  try {
    const mg = await query(
      `SELECT DISTINCT open_id FROM feishu_users
       WHERE role IN ('admin','hq_manager') AND registered = true AND open_id IS NOT NULL`
    );
    mgmtOpenIds = (mg.rows || []).map((r) => r.open_id).filter(Boolean);
  } catch (_e) {
    /* ignore */
  }

  for (const oid of mgmtOpenIds) {
    try {
      await sendCard(oid, card, 'open_id');
    } catch (e) {
      logger.warn({ err: e?.message, oid }, 'monthly bonus mgmt card failed');
    }
  }
}

/** @param {{ store: string, role: 'store_manager'|'store_production_manager', slots: { label: string, keys: string[] }[] }} p */
async function applyBonusForUser(p) {
  const { start, end, label } = shanghaiPrevMonthBounds();
  const { store, role, slots } = p;
  const brand = (await getBrandForStore(store).catch(() => null)) || '未知';
  const additions = [];
  let bonus = 0;
  for (const s of slots) {
    if (!s.keys?.length) continue;
    const hit = await hadTriggerInRange(store, s.keys, start, end);
    if (!hit) {
      bonus += 10;
      additions.push({ label: s.label, points: 10, reason: '上月未触发' });
    }
  }
  if (bonus <= 0) return { store, role, bonus: 0 };

  const { username, name } = await resolveScoringUser(store, role);
  const period = `monthbonus_${label}`;
  const summary = `月度异常项未触发加分（${label}）：共 ${additions.length} 项，+${bonus} 分`;

  const recordedTotal = Math.min(100 + bonus, 300);

  await query(
    `INSERT INTO agent_scores (
       brand, store, username, name, role, period, score_model,
       base_score, total_score, additions, deductions, breakdown, summary
     ) VALUES ($1,$2,$3,$4,$5,$6,'anomaly_item_monthly_bonus',100,$7,$8::jsonb,'[]'::jsonb,$9::jsonb,$10)
     ON CONFLICT (brand, store, username, period)
     DO UPDATE SET
       total_score = EXCLUDED.total_score,
       additions = EXCLUDED.additions,
       summary = EXCLUDED.summary,
       updated_at = NOW()`,
    [
      brand,
      store,
      username,
      name,
      role,
      period,
      recordedTotal,
      JSON.stringify(additions),
      JSON.stringify({ items: additions, month: label }),
      summary
    ]
  );

  if (!String(username).startsWith('__periodic')) {
    await notifyBiMonthlyBonus({
      username,
      name,
      store,
      role,
      label,
      start,
      end,
      additions,
      bonus,
      recordedTotal
    });
  }

  return { store, role, bonus, items: additions.length };
}

export async function runMonthlyAnomalyItemBonuses() {
  const { start, end } = shanghaiPrevMonthBounds();
  const storesR = await query(
    `SELECT DISTINCT store FROM daily_reports WHERE date >= $1::date AND date <= $2::date AND store IS NOT NULL`,
    [start, end]
  );
  const stores = (storesR.rows || []).map((x) => x.store).filter(Boolean);
  const results = [];

  const smSlots = [
    { label: '实收营收（周/月）', keys: ['revenue_achievement', 'revenue_achievement_monthly'] },
    { label: '人效', keys: ['labor_efficiency'] },
    { label: '充值', keys: ['recharge_zero'] },
    { label: '桌访占比', keys: ['table_visit_ratio'] },
    { label: '大众点评服务差评', keys: ['bad_review_service'] },
    { label: '食品安全', keys: ['food_safety'] }
  ];
  const pmSlotsBase = [
    { label: '人效', keys: ['labor_efficiency'] },
    { label: '桌访产品', keys: ['table_visit_product'] },
    { label: '毛利率', keys: ['gross_margin'] },
    { label: '大众点评产品差评', keys: ['bad_review_product'] },
    { label: '食品安全', keys: ['food_safety'] }
  ];

  for (const store of stores) {
    const jg = isJiuguangStore(store);
    const smSlotsStore = jg
      ? [...smSlots, { label: '洪潮久光包房使用', keys: ['hongchao_jiuguang_private_room'] }]
      : smSlots;
    results.push(await applyBonusForUser({ store, role: 'store_manager', slots: smSlotsStore }));
    results.push(await applyBonusForUser({ store, role: 'store_production_manager', slots: pmSlotsBase }));
  }

  logger.info({ month: shanghaiPrevMonthBounds().label, stores: stores.length, results }, 'monthly anomaly item bonuses done');
  return { ok: true, results };
}
