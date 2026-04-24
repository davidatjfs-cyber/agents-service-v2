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
import { sendCard, sendText, buildAnomalyCard, buildBiDeductionCard } from './feishu-client.js';
import { getShanghaiYmdParts, shanghaiWeekMonSunContaining } from '../utils/anomaly-week-bounds.js';
import { anomalyRuleLabelZh } from '../utils/anomaly-labels.js';
import { planAndExecute } from './master-planner.js';
import { resolveSingleScoringUser, isMajixianPmObserverUsername } from '../utils/scoring-assignee.js';

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

/**
 * 通知/任务卡责任人岗位：优先读 DB `anomaly_rules.<key>.notify_target_role`（与 apply-anomaly-rules-v2 一致，支持逗号多岗），
 * 再回落静态 ANOMALY_RULES（避免仅店长、漏发出品经理）。
 */
export async function getNotifyDbRoles(ruleKey) {
  if (ruleKey === 'food_safety') {
    return ['store_manager', 'store_production_manager', 'hq_manager', 'admin'];
  }
  try {
    const dbRules = await getAnomalyRules();
    const patch = dbRules?.[ruleKey];
    const ntr = patch && typeof patch.notify_target_role === 'string' ? patch.notify_target_role.trim() : '';
    if (ntr) {
      const roles = ntr
        .split(/[,，;；]/)
        .map((s) => mapNotifyRoleToDbRole(s.trim()))
        .filter(Boolean);
      if (roles.length) return [...new Set(roles)];
    }
  } catch (_e) {
    /* fall through */
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
  if (ruleKey === 'table_visit_product')
    return '桌访产品异常：仅统计「今天不满意菜品」列中出现的菜名（上周一至上周日窗口）；请按列中菜品逐一整改出品与培训；周度绩效按每产品分别扣分（≥4次10分、≥2次5分，多产品累加）';
  if (ruleKey === 'gross_margin') return '为什么最近利润下降';
  if (['labor_efficiency', 'revenue_achievement', 'recharge_zero'].includes(ruleKey)) {
    return '为什么最近营收下降';
  }
  if (ruleKey === 'food_safety') return '食品安全异常应如何紧急处置与整改';
  return '为什么最近经营数据异常';
}

async function pickUsersForStoreAndRoles(store, dbRoles) {
  const r = await query(
    `SELECT open_id, username, role, store,
            COALESCE(NULLIF(TRIM(name), ''), username) AS display_name
     FROM feishu_users
     WHERE registered = true AND open_id IS NOT NULL AND open_id NOT LIKE '%probe%'`
  );
  const rows = (r.rows || []).filter(
    (u) => dbRoles.includes(u.role) && sameStore(u.store, store)
  );
  return rows;
}

function dedupeUsersByOpenId(rows) {
  const seen = new Set();
  const out = [];
  for (const u of rows || []) {
    const k = String(u.open_id || '').trim();
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(u);
  }
  return out;
}

async function fetchFeishuUserRow(username) {
  const u = String(username || '').trim();
  if (!u) return null;
  try {
    const r = await query(
      `SELECT open_id, username, role, store,
              COALESCE(NULLIF(TRIM(name), ''), username) AS display_name
       FROM feishu_users
       WHERE registered = true AND open_id IS NOT NULL AND open_id NOT LIKE '%probe%' AND LOWER(username) = LOWER($1)
       LIMIT 1`,
      [u]
    );
    const row = r.rows?.[0];
    if (!row?.open_id) return null;
    return row;
  } catch (_e) {
    return null;
  }
}

/**
 * BI 通知与任务卡：出品经理强制为「岗位唯一规范账号」（马己仙 → 黎永荣主号），避免误绑观察号抢责。
 */
async function collapseProductionManagerNotifyRecipients(store, users) {
  const list = [...(users || [])];
  const nonPm = list.filter((u) => u.role !== 'store_production_manager');
  const pms = list.filter((u) => u.role === 'store_production_manager');
  if (!pms.length) return dedupeUsersByOpenId(list);
  const pmsNoObserver = pms.filter((x) => !isMajixianPmObserverUsername(x.username));
  const canon = await resolveSingleScoringUser(store, 'store_production_manager');
  if (!canon?.username || String(canon.username).startsWith('__periodic')) {
    return dedupeUsersByOpenId([...nonPm, ...(pmsNoObserver[0] ? [pmsNoObserver[0]] : [])]);
  }
  const hit = pms.find((x) => String(x.username || '').toLowerCase() === String(canon.username).toLowerCase());
  if (hit) return dedupeUsersByOpenId([...nonPm, hit]);
  const row = await fetchFeishuUserRow(canon.username);
  if (row && sameStore(row.store, store)) return dedupeUsersByOpenId([...nonPm, row]);
  if (row) return dedupeUsersByOpenId([...nonPm, row]);
  return dedupeUsersByOpenId([...nonPm, ...(pmsNoObserver[0] ? [pmsNoObserver[0]] : [])]);
}

/** 食安：门店店长/出品 + 全量 admin/hq_manager（不按门店过滤） */
async function pickUsersForFoodSafety(store, dbRoles) {
  const local = await pickUsersForStoreAndRoles(store, ['store_manager', 'store_production_manager']);
  let hqRows = [];
  try {
    const r = await query(
      `SELECT open_id, username, role, store,
              COALESCE(NULLIF(TRIM(name), ''), username) AS display_name
       FROM feishu_users
       WHERE registered = true AND open_id IS NOT NULL AND role IN ('hq_manager','admin')
       AND open_id NOT LIKE '%probe%'`
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
  const base = Array.isArray(dbRoles) && dbRoles.length ? [...dbRoles] : ['store_manager'];
  /** 人效：主责任人优先出品经理（与周度绩效双岗扣分一致，任务卡/态度统计主挂人） */
  let ordered = base;
  if (ruleKey === 'labor_efficiency') {
    const want = ['store_production_manager', 'store_manager'];
    const head = want.filter((r) => base.includes(r));
    const tail = base.filter((r) => !head.includes(r));
    ordered = [...head, ...tail];
  }
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
 * 与周度扣分卡片一致：取 anomaly_rollups_v2 总分；必须限定门店与自然周 period，
 * 禁止仅用 username + ORDER BY updated_at（多店多周并存时会错绑到「刚被更新」的另一行）。
 */
async function fetchLatestAnomalyRollupScore(username, store = null, weekPeriod = null) {
  if (!username) return 100;
  try {
    const cond = [`username = $1`, `score_model = 'anomaly_rollups_v2'`];
    const params = [username];
    let n = 2;
    if (store) {
      cond.push(`(store = $${n} OR $${n} ILIKE '%' || store || '%' OR store ILIKE '%' || $${n} || '%')`);
      params.push(store);
      n++;
    }
    if (weekPeriod) {
      cond.push(`(period = $${n} OR period LIKE $${n} || '__%')`);
      params.push(weekPeriod);
      n++;
    }
    const scoreRes = await query(
      `SELECT total_score FROM agent_scores WHERE ${cond.join(' AND ')} ORDER BY updated_at DESC LIMIT 1`,
      params
    );
    if (scoreRes.rows?.[0]?.total_score != null) {
      return Number(scoreRes.rows[0].total_score);
    }
    // Fallback: no row for current week — look up the latest period for this user+store
    if (weekPeriod) {
      const fbCond = [`username = $1`, `score_model = 'anomaly_rollups_v2'`];
      const fbParams = [username];
      let fn = 2;
      if (store) {
        fbCond.push(`(store = $${fn} OR $${fn} ILIKE '%' || store || '%' OR store ILIKE '%' || $${fn} || '%')`);
        fbParams.push(store);
        fn++;
      }
      const fbRes = await query(
        `SELECT total_score FROM agent_scores WHERE ${fbCond.join(' AND ')} ORDER BY period DESC LIMIT 1`,
        fbParams
      );
      if (fbRes.rows?.[0]?.total_score != null) {
        return Number(fbRes.rows[0].total_score);
      }
    }
  } catch (_e) {
    /* ignore */
  }
  return 100;
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
  const roles = await getNotifyDbRoles(ruleKey);
  let users =
    ruleKey === 'food_safety' ? await pickUsersForFoodSafety(store, roles) : await pickUsersForStoreAndRoles(store, roles);
  users = await collapseProductionManagerNotifyRecipients(store, users);
  const isFoodSafety = ruleKey === 'food_safety';
  if (isFoodSafety) {
    const missingHqRoles = ['admin', 'hq_manager'].filter(r => !roles.includes(r));
    if (missingHqRoles.length) {
      try {
        const hqR = await query(
          `SELECT open_id, username, role, store,
                  COALESCE(NULLIF(TRIM(name), ''), username) AS display_name
           FROM feishu_users
           WHERE registered = true AND open_id IS NOT NULL AND open_id NOT LIKE '%probe%' AND role = ANY($1)`,
          [missingHqRoles]
        );
        for (const hq of hqR.rows || []) {
          if (!users.some(u => u.open_id === hq.open_id)) users.push(hq);
        }
      } catch (_e) { /* ignore */ }
    }
  }

  const taskId = `ANO-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${String(Math.floor(Math.random() * 10000)).padStart(4, '0')}`;

  /** 与 anomaly_triggers.trigger_date 对齐，供任务结案时回写触发记录状态 */
  const deriveBiTriggerDate = (rk, val) => {
    const v = val && typeof val === 'object' ? val : {};
    if (v.evaluated_business_day) return String(v.evaluated_business_day).slice(0, 10);
    if (v.evaluationYmd) return String(v.evaluationYmd).slice(0, 10);
    if (v.weekEnd) return String(v.weekEnd).slice(0, 10);
    if (v.dateToday) return String(v.dateToday).slice(0, 10);
    return null;
  };
  const biTriggerDate = deriveBiTriggerDate(ruleKey, value);

  const typeZh = anomalyRuleLabelZh(ruleKey);
  const title = `${store} · BI异常 · ${typeZh}`;
  const detailCap = ruleKey === 'food_safety' ? 5200 : 1800;
  let initialDetail = String(detail || '').slice(0, detailCap);
  if (ruleKey === 'food_safety') {
    initialDetail +=
      `\n\n─── 总部营运处置（仅 hq_manager 可判罚；管理员仅同步通知）───\n` +
      `请由 **总部营运** 回复：**「记录」** 并写明责任（**店长** / **出品经理** / **双方**），系统将按岗位对该门店已绑定人员各扣 20 分，与同周 BI 异常绩效（anomaly_rollups_v2）同源并推送扣分通知；或回复 **「不记录」** / **情况不属实** 结案不扣分。\n` +
      `店长/出品回复整改说明走系统审核；多次不合格备案工作态度，不扣本绩效分。`;
  }
  const msgIds = [];

  // ── ① 立刻通知：异常告警卡（含任务功能） + BI异常情况扣分卡（纯通知）──
  for (const u of users) {
    const assigneeName = u.display_name || u.username || '—';

    // ── 1) 异常告警卡（带任务提示、按钮、催办，回复可被记录）──
    const alertCard = buildAnomalyCard(store, ruleKey, severity, initialDetail, taskId);
    let r = await sendCard(u.open_id, alertCard);
    if (!r?.ok) {
      const emoji = severity === 'high' ? '🚨' : '⚠️';
      r = await sendText(
        u.open_id,
        `${emoji} 【异常告警｜立刻处理】${store}\n类型: ${typeZh}\n严重度: ${severity}\n任务ID: ${taskId}\n\n${initialDetail.slice(0, 1200)}`,
        'open_id'
      );
    }
    const mid = extractMessageId(r);
    if (mid) msgIds.push(mid);

    // ── 2) BI异常情况扣分卡（纯通知，无任务提示）──
    const { weekStart: weekStartVal } = shanghaiWeekMonSunContaining(getShanghaiYmdParts().ymd);
    const weekPeriod = `week_${weekStartVal}`;
    const curScore = await fetchLatestAnomalyRollupScore(u.username, store, weekPeriod);
    let pts = 0;
    let periodZh = '';
    let reasonZh = typeZh;
    let bizDates = biTriggerDate || getShanghaiYmdParts().ymd;
    let dataSourceNote = '数据来源：异常触发汇总（anomaly_triggers）· 周度自动计算';
    if (ruleKey === 'recharge_zero') {
      pts = Number(value?.penalty_points ?? 0) || 0;
      const todayYmd = value?.evaluationYmd || value?.dateToday || getShanghaiYmdParts().ymd;
      const monthStart = value?.month_start || '';
      const runY = value?.runCalendarYmd || '';
      periodZh = monthStart
        ? `判定营业日 ${todayYmd}（以上海「昨日」口径，任务在 ${runY || '—'} 触发；当月自 ${monthStart} 起累计，不跨月）`
        : `判定营业日 ${todayYmd}（以上海「昨日」口径${runY ? `，${runY} 触发` : ''}）`;
      reasonZh = '充值异常';
      bizDates = todayYmd;
      dataSourceNote = '数据来源：日频检测写入 anomaly_triggers（判定营业日为上海「昨日」）；绩效扣分在周一「周度门店评分」中按自然周内各日 penalty 累加后写入 anomaly_rollups_v2。';
    } else if (ruleKey === 'bad_review_product') {
      pts = value?.deduction_production ?? 0;
      const ws = value?.weekStart || '';
      const we = value?.weekEnd || '';
      periodZh = ws ? `自然周 ${ws}~${we}（每日触发，自然周递进扣分）` : '';
      reasonZh = '差评产品异常';
      dataSourceNote = '数据来源：日频检测写入 anomaly_triggers（飞书 bitable 差评分产品/服务分类）；绩效扣分在周一「周度门店评分」中按自然周内各日 penalty 累加后写入 anomaly_rollups_v2。';
    } else if (ruleKey === 'bad_review_service') {
      pts = value?.deduction_manager ?? 0;
      const ws = value?.weekStart || '';
      const we = value?.weekEnd || '';
      periodZh = ws ? `自然周 ${ws}~${we}（每日触发，自然周递进扣分）` : '';
      reasonZh = '差评服务异常';
      dataSourceNote = '数据来源：日频检测写入 anomaly_triggers（飞书 bitable 差评分产品/服务分类）；绩效扣分在周一「周度门店评分」中按自然周内各日 penalty 累加后写入 anomaly_rollups_v2。';
    } else if (ruleKey === 'food_safety') {
      pts = 20;
      const { weekStart: fsWs, weekEnd: fsWe } = shanghaiWeekMonSunContaining(getShanghaiYmdParts().ymd);
      periodZh = `自然周 ${fsWs}~${fsWe}`;
      reasonZh = '食品安全异常';
      dataSourceNote = '数据来源：实时检测+日频扫描写入 anomaly_triggers（食安红色通道）；绩效扣分在周一「周度门店评分」中按自然周内各日 penalty 累加后写入 anomaly_rollups_v2。';
    } else if (ruleKey === 'table_visit_product') {
      pts = value?.deduction_points_total ?? 0;
      periodZh = value?.weekPeriod || '';
      reasonZh = '桌访产品异常';
      dataSourceNote = '数据来源：周频检测写入 anomaly_triggers（桌访合并数据）；绩效扣分在周一「周度门店评分」中按自然周内各日 penalty 累加后写入 anomaly_rollups_v2。';
    } else {
      pts = severity === 'high' ? 10 : severity === 'medium' ? 5 : 0;
    }
    const sevZh = severity === 'high' ? '高' : severity === 'medium' ? '中' : String(severity || '—');
    const rem = curScore - pts;
    const dedCard = buildBiDeductionCard({
      store,
      assigneeName,
      role: u.role,
      period: periodZh,
      reason: reasonZh,
      keyZh: reasonZh,
      severity: sevZh,
      points: pts,
      currentScore: curScore,
      remainingScore: rem,
      taskId: null,
      bizDates,
      dataSourceNote
    });
    await sendCard(u.open_id, dedCard).catch(() => {});
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
  const staticFreq = ANOMALY_RULES.find((x) => x.key === ruleKey)?.frequency;
  if (staticFreq && staticFreq !== anomalyFrequency) {
    anomalyFrequency = staticFreq;
  }
  const sourceDataBase = {
    anomaly_key: ruleKey,
    anomaly_frequency: anomalyFrequency,
    bi_trigger_date: biTriggerDate,
    value: value || {},
    pipeline: 'v2',
    assignee_open_ids: users.map((u) => u.open_id).filter(Boolean)
  };

  // ── 建 master_tasks（供催办 / HR 绩效 / 状态跟踪）；食安类时限 24h，其它 7 天 ──
  // labor_efficiency: 店长+出品经理都是责任人，分别建任务以便各自催办跟踪
  const timeoutHours = ruleKey === 'food_safety' ? 24 : 168;

  // 人效异常需要给每个责任人分别建任务；其他异常只建主责任人任务
  const taskAssignees = ruleKey === 'labor_efficiency'
    ? users.filter((u) => ['store_manager', 'store_production_manager'].includes(u.role))
    : [{ username: assigneeUsername, role: assigneeRole }];

  // 至少保证有一个责任人
  const effectiveAssignees = taskAssignees.length > 0
    ? taskAssignees
    : [{ username: assigneeUsername, role: assigneeRole }];

  for (const assignee of effectiveAssignees) {
    const subTaskId = effectiveAssignees.length > 1
      ? `${taskId}-${assignee.role === 'store_manager' ? 'SM' : 'PM'}`
      : taskId;
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
          subTaskId,
          ruleKey,
          severity || 'medium',
          store,
          brand || null,
          assignee.username,
          assignee.role,
          title,
          initialDetail,
          JSON.stringify(sourceDataBase),
          JSON.stringify(msgIds)
        ]
      );
    } catch (e) {
      logger.warn({ err: e?.message, taskId: subTaskId }, 'bi-anomaly: full insert failed, retry minimal columns');
      try {
        await query(
          `INSERT INTO master_tasks (task_id, status, source, category, store, assignee_username, assignee_role, title, detail, source_data, feishu_msg_ids, dispatched_at, timeout_at, remind_count)
           VALUES ($1, 'pending_response', 'bi_anomaly', $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, NOW(), NOW() + INTERVAL '${timeoutHours} hours', 0)`,
          [
            subTaskId,
            ruleKey,
            store,
            assignee.username,
            assignee.role,
            title,
            initialDetail,
            JSON.stringify({ ...sourceDataBase, pipeline: 'v2_min' }),
            JSON.stringify(msgIds)
          ]
        );
      } catch (e2) {
        logger.error({ err: e2?.message, taskId: subTaskId, store, ruleKey }, 'bi-anomaly: master_tasks insert failed');
      }
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
