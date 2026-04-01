/**
 * BI 异常触发后的标准链路（按业务要求）：
 * 1) 立刻把异常通知到规则定义的责任人（飞书卡片 + master_tasks 待响应）
 * 2) Planner 生成分析与改进建议
 * 3) 以「营运督导 OP」口吻把建议发给同一批责任人，并引用任务 ID 便于跟踪与回复
 *
 * 说明：不再依赖「等到固定巡检时刻」才 push；patrol / daily_inspection 里重复的 push 已移除。
 */
import { query } from '../utils/db.js';
import { logger } from '../utils/logger.js';
import { ANOMALY_RULES } from '../config/anomaly-rules.js';
import { getBrandForStore, getAnomalyRules } from './config-service.js';
import { sendCard, sendText, buildAnomalyCard } from './feishu-client.js';
import { anomalyRuleLabelZh } from '../utils/anomaly-labels.js';
import { planAndExecute } from './master-planner.js';

function storeKey(v) {
  return String(v || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '');
}
function sameStore(a, b) {
  const x = storeKey(a);
  const y = storeKey(b);
  if (!x || !y) return false;
  return x === y || x.includes(y) || y.includes(x);
}

/** 规则里的 kitchen_manager → DB 角色 store_production_manager */
export function mapNotifyRoleToDbRole(role) {
  const r = String(role || '').trim();
  if (r === 'kitchen_manager') return 'store_production_manager';
  return r;
}

/** 若某类异常仅需通知门店、不要求营运督导跟发长文，可在此加入 ruleKey（当前 V2 引擎无单独「原料收货」异常键） */
const SKIP_OP_SUPERVISOR_FOLLOWUP = new Set([
  // 例: 'material_receipt_weekly'
]);

export function getNotifyDbRoles(ruleKey) {
  if (ruleKey === 'food_safety') {
    return ['store_manager', 'store_production_manager', 'hq_manager', 'admin'];
  }
  const rule = ANOMALY_RULES.find((x) => x.key === ruleKey);
  const tgt = rule?.notifyTarget;
  const roles = [];
  if (Array.isArray(tgt)) {
    for (const t of tgt) {
      if (t?.role) roles.push(mapNotifyRoleToDbRole(t.role));
    }
  } else if (tgt?.role) {
    roles.push(mapNotifyRoleToDbRole(tgt.role));
  }
  if (!roles.length) roles.push('store_manager');
  return [...new Set(roles)];
}

function plannerSyntheticQuestion(ruleKey) {
  if (ruleKey === 'table_visit_ratio') return '为什么最近桌访占比偏低，应如何提升巡台与反馈收集';
  if (ruleKey === 'table_visit_product') return '为什么桌访中多款产品被集中反馈不满意，应如何整改出品与培训';
  if (ruleKey === 'gross_margin') return '为什么最近利润下降';
  if (['labor_efficiency', 'revenue_achievement', 'recharge_zero'].includes(ruleKey)) {
    return '为什么最近营收下降';
  }
  if (ruleKey === 'food_safety') return '食品安全异常应如何紧急处置与整改';
  return '为什么最近经营数据异常';
}

async function pickUsersForStoreAndRoles(store, dbRoles) {
  const r = await query(
    `SELECT open_id, username, role, store FROM feishu_users
     WHERE registered = true AND open_id IS NOT NULL`
  );
  const rows = (r.rows || []).filter(
    (u) => dbRoles.includes(u.role) && sameStore(u.store, store)
  );
  return rows;
}

/** 食安：门店店长/出品 + 全量 admin/hq_manager（不按门店过滤） */
async function pickUsersForFoodSafety(store, dbRoles) {
  const local = await pickUsersForStoreAndRoles(store, ['store_manager', 'store_production_manager']);
  let hqRows = [];
  try {
    const r = await query(
      `SELECT open_id, username, role, store FROM feishu_users
       WHERE registered = true AND open_id IS NOT NULL AND role IN ('hq_manager','admin')`
    );
    hqRows = r.rows || [];
  } catch (_e) {
    hqRows = [];
  }
  const seen = new Set();
  const out = [];
  for (const u of [...local, ...hqRows]) {
    const k = String(u.open_id || u.username || '');
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(u);
  }
  return out;
}

/**
 * master_tasks 主责任人：按规则 notifyTarget 中的角色顺序匹配，避免 DB 返回顺序随机把任务记到错误岗位。
 */
function pickPrimaryAssignee(ruleKey, users, dbRoles) {
  if (ruleKey === 'food_safety') {
    const hq = users.find((x) => x.role === 'hq_manager');
    if (hq) return { username: hq.username || '', role: 'hq_manager' };
    const ad = users.find((x) => x.role === 'admin');
    if (ad) return { username: ad.username || '', role: 'admin' };
  }
  const ordered = Array.isArray(dbRoles) && dbRoles.length ? dbRoles : ['store_manager'];
  for (const role of ordered) {
    const u = users.find((x) => x.role === role);
    if (u) return { username: u.username || '', role: u.role };
  }
  if (users[0]) return { username: users[0].username || '', role: users[0].role };
  return { username: '', role: ordered[0] || 'store_manager' };
}

function extractMessageId(sendRes) {
  const d = sendRes?.data;
  return d?.message_id || d?.data?.message_id || '';
}

/**
 * 在 anomaly_triggers 已落库之后调用：立刻通知 + 建任务 + Planner + OP 跟进文案
 */
export async function runBiAnomalyNotifyPipeline({
  store,
  brand: brandIn,
  ruleKey,
  severity,
  detail,
  value
}) {
  const brand = brandIn || (await getBrandForStore(store).catch(() => null)) || '';
  const roles = getNotifyDbRoles(ruleKey);
  const users =
    ruleKey === 'food_safety' ? await pickUsersForFoodSafety(store, roles) : await pickUsersForStoreAndRoles(store, roles);

  const taskId = `ANO-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${String(Math.floor(Math.random() * 10000)).padStart(4, '0')}`;

  const typeZh = anomalyRuleLabelZh(ruleKey);
  const title = `${store} · BI异常 · ${typeZh}`;
  const detailCap = ruleKey === 'food_safety' ? 5200 : 1800;
  let initialDetail = String(detail || '').slice(0, detailCap);
  if (ruleKey === 'food_safety') {
    initialDetail += `\n\n─── 总部营运处置 ───\n请在本任务回复 **「记录」**（属实并记入绩效，将按前厅/后厨责任扣20分/次）或 **「不记录」**（核实不属实）。`;
  }
  const msgIds = [];

  // ── ① 立刻通知（卡片优先）──
  for (const u of users) {
    const card = buildAnomalyCard(store, ruleKey, severity, initialDetail, taskId);
    let r = await sendCard(u.open_id, card);
    if (!r?.ok) {
      const emoji = severity === 'high' ? '🚨' : '⚠️';
      r = await sendText(
        u.open_id,
        `${emoji} 【BI异常｜立刻处理】${store}\n类型: ${typeZh}\n严重度: ${severity}\n任务ID: ${taskId}\n\n${initialDetail.slice(0, 1200)}`,
        'open_id'
      );
    }
    const mid = extractMessageId(r);
    if (mid) msgIds.push(mid);
  }

  if (!users.length) {
    logger.warn({ store, ruleKey, roles }, 'bi-anomaly: no feishu users matched for notify');
  }

  const { username: assigneeUsername, role: assigneeRole } = pickPrimaryAssignee(ruleKey, users, roles);

  let anomalyFrequency = 'daily';
  try {
    const rules = await getAnomalyRules();
    anomalyFrequency = String(rules?.[ruleKey]?.frequency || 'daily').trim() || 'daily';
  } catch (_e) {
    /* keep daily */
  }
  const sourceDataBase = {
    anomaly_key: ruleKey,
    anomaly_frequency: anomalyFrequency,
    value: value || {},
    pipeline: 'v2'
  };

  // ── 建 master_tasks（供催办 / HR 绩效 / 状态跟踪）；食安类时限 24h，其它 7 天 ──
  const timeoutHours = ruleKey === 'food_safety' ? 24 : 168;
  try {
    await query(
      `INSERT INTO master_tasks (
         task_id, status, source, category, severity, store, brand, assignee_username, assignee_role,
         title, detail, source_data, feishu_msg_ids, dispatched_at, timeout_at, remind_count
       ) VALUES (
         $1, 'pending_response', 'bi_anomaly', $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb, NOW(),
         NOW() + INTERVAL '${timeoutHours} hours', 0
       )`,
      [
        taskId,
        ruleKey,
        severity || 'medium',
        store,
        brand || null,
        assigneeUsername,
        assigneeRole,
        title,
        initialDetail,
        JSON.stringify(sourceDataBase),
        JSON.stringify(msgIds)
      ]
    );
  } catch (e) {
    logger.warn({ err: e?.message, taskId }, 'bi-anomaly: full insert failed, retry minimal columns');
    try {
      await query(
        `INSERT INTO master_tasks (task_id, status, source, category, store, assignee_username, assignee_role, title, detail, source_data, feishu_msg_ids, dispatched_at, timeout_at, remind_count)
         VALUES ($1, 'pending_response', 'bi_anomaly', $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, NOW(), NOW() + INTERVAL '${timeoutHours} hours', 0)`,
        [
          taskId,
          ruleKey,
          store,
          assigneeUsername,
          assigneeRole,
          title,
          initialDetail,
          JSON.stringify({ ...sourceDataBase, pipeline: 'v2_min' }),
          JSON.stringify(msgIds)
        ]
      );
    } catch (e2) {
      logger.error({ err: e2?.message, taskId, store, ruleKey }, 'bi-anomaly: master_tasks insert failed');
    }
  }

  // ── ② Planner 建议 ──
  let plannerText = '';
  try {
    const synthetic = plannerSyntheticQuestion(ruleKey);
    const plannerRes = await planAndExecute(
      `${synthetic}。门店「${store}」，异常类型 ${ruleKey}，当前说明：${initialDetail.slice(0, 400)}`,
      { store, username: '', role: '' },
      { intent: 'analysis', complexity: 'high', mode: 'workflow' }
    );
    if (plannerRes?.response) plannerText = String(plannerRes.response).slice(0, 2000);
  } catch (e) {
    logger.warn({ err: e?.message, ruleKey, store }, 'bi-anomaly: planner failed');
  }

  if (plannerText) {
    try {
      await query(
        `UPDATE master_tasks SET detail = $2, source_data = source_data || $3::jsonb, updated_at = NOW() WHERE task_id = $1`,
        [
          taskId,
          `${initialDetail}\n\n─── AI分析与改进建议 ───\n${plannerText}`,
          JSON.stringify({ planner_advice: plannerText })
        ]
      );
    } catch (_e) {
      /* ignore */
    }
  }

  if (SKIP_OP_SUPERVISOR_FOLLOWUP.has(ruleKey)) {
    logger.info({ store, ruleKey, taskId }, 'bi-anomaly: skip OP supervisor follow-up text');
    return { taskId, notified: users.length, plannerLen: plannerText.length, skippedOp: true };
  }

  // ── ③ OP 督导跟进（文字，明确任务 ID）──
  const opBody = `📋 【营运督导｜任务 ${taskId}】
门店：${store}
异常：${ruleKey}（${severity}）

✅ 请优先按上一条卡片处理异常。

${plannerText ? `📌 AI 改进建议摘要：\n${plannerText.slice(0, 1500)}${plannerText.length > 1500 ? '…' : ''}\n\n` : ''}请在本对话回复**具体整改措施 / 处理方案**，或在任务卡片上操作。系统将跟踪直至闭环归档。`;

  for (const u of users) {
    await sendText(u.open_id, opBody.slice(0, 4500), 'open_id').catch(() => {});
  }

  logger.info(
    { taskId, store, ruleKey, recipients: users.length, msgIds: msgIds.length },
    'bi-anomaly pipeline completed'
  );

  return { taskId, notified: users.length, plannerLen: plannerText.length };
}
