/**
 * 食品安全 BI 异常（agents-service-v2 / Feishu 任务回复）
 *
 * 通知：卡片仍发店长、出品经理、总部营运、管理员（管理员仅知情，不参与判罚）。
 * 判罚：仅总部营运（feishu_users.role = hq_manager）的回复会触发本模块；管理员回复不进入此处。
 *
 * 总部营运回复：
 *  · 不记录 / 情况不属实 → 结案，关 anomaly_triggers，不写 agent_scores。
 *  · 记录并指明店长 / 出品经理 / 双方 → 按岗位在「该门店」下解析 feishu_users：
 *      每个命中用户各扣 FOOD_SAFETY_HQ_POINTS，写入 score_model=anomaly_rollups_v2、period=week_<本周一>，
 *      与同表周度 BI 异常汇总同源，计入绩效展示链路；并发飞书扣分卡 + hrms_user_notifications（与周度 BI 扣分通知形式一致）。
 *      若 HQ 只点「出品经理」而门店绑定多名出品，则每人各扣一次（岗位维度）；通常每岗一人则只扣责任人。
 *
 * 门店侧（店长/出品）回复整改说明：走 feishu-client reviewTaskReply；三次不合格 → HR 工作态度备案，不扣 agent_scores 绩效分。
 */
import { query } from '../utils/db.js';
import { logger } from '../utils/logger.js';
import { getBrandForStore } from './config-service.js';
import {
  getShanghaiYmdParts,
  shanghaiWeekMonSunContaining,
  addDaysYmdShanghai
} from '../utils/anomaly-week-bounds.js';
import { anomalyRollupPeriodKey } from '../utils/week-period-keys.js';
import { ensureHrmsUserNotificationsTable } from '../utils/hrms-user-notifications.js';

const FOOD_SAFETY_HQ_POINTS = 20;

const HQ_RULING_GUIDANCE_MSG = `⚠️ 无法识别判罚结论，请**直接按下面二选一**写清楚后重发：

① **情况属实、要记入绩效**：写明责任岗位——**店长**、**出品经理**，或 **双方（两人）**；可附简短事由（系统将按岗位对该门店已绑定飞书账号各扣 ${FOOD_SAFETY_HQ_POINTS} 分，与同周 BI 异常绩效同源，并推送扣分通知）。

② **情况不属实**：回复 **不记录** 或 **情况不属实**（将结案且不扣分）。

管理员账号不参与判罚，请由 **总部营运** 回复。`;

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

/** 「记录」作动词/备案义，避免匹配「不记录」里的子串；「属实」排除「不属实」 */
function recordIntentCue(t) {
  return (
    /(?:^|[^不])记录/.test(t) ||
    /备案|记在|扣分|处理决定|罚款|责任在|扣\s*\d|扣.*分|(?<!不)属实/.test(t)
  );
}

function parseDismissIntent(t) {
  if (/情况不属实|核实不属实|核实.*不属|与事实不符|false\s*positive|误判|未发现异常|不存在问题|没有问题/i.test(t)) {
    return true;
  }
  if (/无需记录|不实记录|不扣分/.test(t)) return true;
  /** 整句仅为「不记录」类结案用语 */
  if (/^不记录[。！!\s]*$/i.test(t)) return true;
  if (/情况不属实[^。；;]*不记录|不记录[^。；;]*情况不属实/.test(t)) return true;
  return false;
}

/** @returns {{ kind: 'dismiss' } | { kind: 'record', targets: string[] } | { kind: 'unknown', reason?: string }} */
export function parseFoodSafetyHqRuling(text) {
  const t = String(text || '').trim();
  if (!t) return { kind: 'unknown', reason: 'empty' };

  const bothRe =
    /双方|两人|两个人|店长和出品经理|出品经理和店长|店长[、,和]\s*出品|各扣|分别扣|两岗|前厅.*后厨|后厨.*前厅/;
  const pmRe = /出品经理|后厨负责人|出品负责人|出品主管|厨师长/;
  const smRe = /店长|门店负责人|门店经理/;
  const smOrPmLoose = /前厅|后厨|出品(?!经理)/;

  const rulingSemantics =
    recordIntentCue(t) ||
    /扣分|扣\s*\d|罚款|责任认定|备案|处理决定|记在/.test(t);

  const targets = new Set();
  if (bothRe.test(t)) {
    targets.add('store_manager');
    targets.add('store_production_manager');
  } else {
    if (pmRe.test(t)) targets.add('store_production_manager');
    if (smRe.test(t)) targets.add('store_manager');
    if (!targets.size && rulingSemantics && smOrPmLoose.test(t)) {
      if (/后厨|出品(?!经理)/.test(t)) targets.add('store_production_manager');
      if (/前厅/.test(t)) targets.add('store_manager');
    }
  }

  /** 先识别「记录在…」属实判罚，再处理「不记录」结案，避免「不推荐不记录」等误判 */
  if (targets.size > 0 && rulingSemantics) {
    return { kind: 'record', targets: [...targets] };
  }
  if (recordIntentCue(t) || /记在|扣分|扣\s*\d/.test(t)) {
    return { kind: 'unknown', reason: 'need_target' };
  }
  if (parseDismissIntent(t)) {
    return { kind: 'dismiss' };
  }
  return { kind: 'unknown', reason: 'no_ruling' };
}

async function resolveScoringUsersForStore(store, role) {
  const r = await query(
    `SELECT username, COALESCE(NULLIF(TRIM(name),''), username) AS disp, store
     FROM feishu_users
     WHERE registered = true AND role = $1`,
    [role]
  );
  return (r.rows || []).filter((row) => sameStore(store, row.store));
}

async function fetchOpenUser(openId) {
  if (!openId) return null;
  const r = await query(
    `SELECT role, username, store FROM feishu_users WHERE open_id = $1 AND registered = true LIMIT 1`,
    [openId]
  );
  return r.rows?.[0] || null;
}

function parseDeductions(raw) {
  if (raw == null) return [];
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'string') {
    try {
      const p = JSON.parse(raw);
      return Array.isArray(p) ? p : [];
    } catch {
      return [];
    }
  }
  return [];
}

async function applyFoodSafetyDeduction({
  store,
  username,
  name,
  role,
  points,
  taskId,
  period,
  brand
}) {
  const detail = {
    category: 'food_safety',
    severity: 'high',
    anomaly_key: 'food_safety',
    points,
    task_id: taskId,
    source: 'hq_ruling'
  };
  const roleZh = role === 'store_manager' ? '店长' : role === 'store_production_manager' ? '出品经理' : role;

  const sel = await query(
    `SELECT total_score, deductions, breakdown, summary
     FROM agent_scores
     WHERE brand = $1 AND store = $2 AND username = $3 AND period = $4 AND score_model = 'anomaly_rollups_v2'`,
    [brand, store, username, period]
  );
  const row = sel.rows?.[0];
  if (!row) {
    const totalScore = Math.max(0, 100 - points);
    await query(
      `INSERT INTO agent_scores (
         brand, store, username, name, role, period, score_model,
         total_score, deductions, breakdown, summary
       ) VALUES ($1,$2,$3,$4,$5,$6,'anomaly_rollups_v2',$7,$8::jsonb,$9::jsonb,$10)`,
      [
        brand,
        store,
        username,
        name,
        role,
        period,
        totalScore,
        JSON.stringify([detail]),
        JSON.stringify({ 数据来源: '食安总部判罚' }),
        `本周食安总部判罚：${roleZh} 扣 ${points} 分（任务 ${taskId}），剩余 ${totalScore} 分。`
      ]
    );
    return { totalScore };
  }

  const deductions = parseDeductions(row.deductions);
  deductions.push(detail);
  const totalScore = Math.max(0, Number(row.total_score) - points);
  const summaryZh = `本周含食安总部判罚等：${roleZh} 当前剩余 ${totalScore} 分（任务 ${taskId}）。`;
  await query(
    `UPDATE agent_scores SET
       total_score = $2,
       deductions = $3::jsonb,
       summary = $4,
       name = COALESCE(NULLIF(TRIM($5), ''), name),
       feishu_notified = FALSE,
       updated_at = NOW()
     WHERE brand = $1 AND store = $6 AND username = $7 AND period = $8 AND score_model = 'anomaly_rollups_v2'`,
    [brand, totalScore, JSON.stringify(deductions), summaryZh, name, store, username, period]
  );
  return { totalScore };
}

async function notifyInstantDeductionFeishu({
  store,
  username,
  role,
  points,
  currentScore,
  remainingScore,
  weekStart,
  weekEnd
}) {
  const { sendCard, buildBiDeductionCard } = await import('./feishu-client.js');
  const rangeZh = `${weekStart}～${weekEnd}`;
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
  } catch (_e) {
    /* ignore */
  }
  let mgmtOpenIds = [];
  try {
    const mg = await query(
      `SELECT DISTINCT open_id FROM feishu_users
       WHERE role IN ('admin','hq_manager') AND registered = true AND open_id IS NOT NULL`
    );
    mgmtOpenIds = (mg.rows || []).map((x) => x.open_id).filter(Boolean);
  } catch (_e) {
    /* ignore */
  }
  const card = buildBiDeductionCard({
    store,
    assigneeName,
    role,
    period: rangeZh,
    reason: '食品安全异常',
    keyZh: '食品安全（总部判罚）',
    severity: '高',
    points,
    currentScore,
    remainingScore,
    taskId: ''
  });
  await ensureHrmsUserNotificationsTable();
  const metaJson = JSON.stringify({
    store,
    role,
    anomaly_key: 'food_safety',
    category: 'food_safety',
    points,
    current_score: currentScore,
    remaining_score: remainingScore,
    period_week_start: weekStart,
    source: 'hq_ruling'
  });
  try {
    await query(
      `INSERT INTO hrms_user_notifications (target_username, title, message, type, meta)
       VALUES ($1, $2, $3, $4, $5::jsonb)`,
      [
        username,
        'BI异常情况扣分',
        `您的${rangeZh}绩效扣${points}分（食安总部判罚），剩余${remainingScore}分。`,
        'bi_deduction',
        metaJson
      ]
    );
  } catch (e) {
    logger.warn({ err: e?.message, username }, 'food-safety hq: hrms_user_notifications insert failed');
  }
  if (assigneeOpenId) {
    await sendCard(assigneeOpenId, card, 'open_id').catch((e) =>
      logger.warn({ err: e?.message, username }, 'food-safety hq: assignee card failed')
    );
  }
  for (const oid of mgmtOpenIds) {
    await sendCard(oid, card, 'open_id').catch(() => {});
  }
}

async function closeLatestFoodSafetyTrigger(store) {
  try {
    await query(
      `UPDATE anomaly_triggers at
       SET status = 'closed', updated_at = NOW()
       FROM (
         SELECT id FROM anomaly_triggers
         WHERE anomaly_key = 'food_safety'
           AND COALESCE(status, 'open') = 'open'
           AND (
             TRIM(LOWER(store)) = TRIM(LOWER($1))
             OR TRIM(LOWER($1)) LIKE '%' || TRIM(LOWER(store)) || '%'
             OR TRIM(LOWER(store)) LIKE '%' || TRIM(LOWER($1)) || '%'
           )
         ORDER BY trigger_date DESC NULLS LAST, id DESC
         LIMIT 1
       ) x
       WHERE at.id = x.id`,
      [store]
    );
  } catch (e) {
    logger.warn({ err: e?.message, store }, 'food-safety hq: close anomaly_triggers failed');
  }
}

/**
 * @param {{ taskId: string, responseText: string|null, openId: string|null, replyMsg: (t: string) => Promise<unknown> }} args
 * @returns {Promise<{ handled: boolean, outcome?: 'guidance'|'dismissed'|'recorded'|'record_failed' }>}
 */
export async function tryHandleFoodSafetyHqRuling({ taskId, responseText, openId, replyMsg }) {
  const reply = typeof replyMsg === 'function' ? replyMsg : async () => {};
  try {
    const fu = await fetchOpenUser(openId);
    const role = String(fu?.role || '').trim();
    if (role !== 'hq_manager') {
      return { handled: false };
    }

    const tr = await query(
      `SELECT task_id, source, category, store, title, status
       FROM master_tasks WHERE task_id = $1 LIMIT 1`,
      [taskId]
    );
    const task = tr.rows?.[0];
    if (!task || String(task.source || '') !== 'bi_anomaly') {
      return { handled: false };
    }
    if (String(task.category || '').trim() !== 'food_safety') {
      return { handled: false };
    }
    if (!['pending_response', 'pending_review'].includes(String(task.status || ''))) {
      return { handled: false };
    }

    const parsed = parseFoodSafetyHqRuling(responseText);
    if (parsed.kind === 'unknown') {
      await reply(`${HQ_RULING_GUIDANCE_MSG}\n\n任务：**${taskId}**`).catch(() => {});
      return { handled: true, outcome: 'guidance' };
    }

    const store = String(task.store || '').trim();
    const brand = (await getBrandForStore(store).catch(() => null)) || '未知';
    const { ymd: today } = getShanghaiYmdParts();
    const { weekStart } = shanghaiWeekMonSunContaining(today);
    const weekEnd = addDaysYmdShanghai(weekStart, 6);
    const period = anomalyRollupPeriodKey(weekStart, today);

    if (parsed.kind === 'dismiss') {
      await query(
        `UPDATE master_tasks SET
           status = 'resolved',
           resolved_at = COALESCE(resolved_at, NOW()),
           review_passed = true,
           review_feedback = $2,
           resolution_code = 'food_safety_hq_dismissed',
           response_text = COALESCE($3, response_text),
           response_at = COALESCE(response_at, NOW()),
           updated_at = NOW()
         WHERE task_id = $1`,
        [taskId, '总部营运：不记录（核实不属实）', responseText]
      ).catch(() => {});
      await closeLatestFoodSafetyTrigger(store);
      setImmediate(() => {
        import('./proactive-v2/proactive-task-outcome-on-close.js')
          .then((m) => m.scheduleProactiveOutcomeOnClose(taskId, { newStatus: 'resolved' }))
          .catch(() => {});
      });
      await reply(`✅ 已按 **不记录** 结案，未扣分。任务：**${taskId}**`).catch(() => {});
      logger.info({ taskId, store, role: fu?.role }, 'Food safety HQ ruling: dismissed');
      return { handled: true, outcome: 'dismissed' };
    }

    const targets = parsed.targets;
    const applied = [];
    for (const dbRole of targets) {
      const users = await resolveScoringUsersForStore(store, dbRole);
      if (!users.length) {
        logger.warn({ taskId, store, dbRole }, 'food-safety hq: no feishu user for role');
        continue;
      }
      for (const u of users) {
        let currentScore = 100;
        try {
          const sr = await query(
            `SELECT total_score FROM agent_scores
             WHERE username = $1 AND score_model = 'anomaly_rollups_v2'
             ORDER BY updated_at DESC LIMIT 1`,
            [u.username]
          );
          if (sr.rows?.[0]?.total_score != null) {
            currentScore = Math.max(0, Number(sr.rows[0].total_score));
          }
        } catch (_e) {
          /* ignore */
        }
        const points = FOOD_SAFETY_HQ_POINTS;
        const { totalScore: remainingScore } = await applyFoodSafetyDeduction({
          store,
          username: u.username,
          name: u.disp || u.username,
          role: dbRole,
          points,
          taskId,
          period,
          brand
        });
        await notifyInstantDeductionFeishu({
          store,
          username: u.username,
          role: dbRole,
          points,
          currentScore,
          remainingScore,
          weekStart,
          weekEnd
        });
        applied.push({ username: u.username, role: dbRole, remainingScore });
      }
    }

    if (!applied.length) {
      await reply(
        `⚠️ 未找到该门店对应岗位的飞书用户，无法扣分。请核对门店「${store}」是否已绑定店长/出品经理账号，或联系管理员维护 feishu_users。任务：**${taskId}**`
      ).catch(() => {});
      return { handled: true, outcome: 'record_failed' };
    }

    await query(
      `UPDATE master_tasks SET
         status = 'resolved',
         resolved_at = COALESCE(resolved_at, NOW()),
         review_passed = true,
         review_feedback = $2,
         resolution_code = 'food_safety_hq_recorded',
         response_text = COALESCE($3, response_text),
         response_at = COALESCE(response_at, NOW()),
         updated_at = NOW()
       WHERE task_id = $1`,
      [taskId, `总部营运：记录扣分（${applied.map((a) => `${a.role}:${a.username}`).join('; ')}）`, responseText]
    ).catch(() => {});

    await closeLatestFoodSafetyTrigger(store);

    setImmediate(() => {
      import('./proactive-v2/proactive-task-outcome-on-close.js')
        .then((m) => m.scheduleProactiveOutcomeOnClose(taskId, { newStatus: 'resolved' }))
        .catch(() => {});
    });

    const pts = FOOD_SAFETY_HQ_POINTS;
    const lines = applied.map((a) => {
      const rz = a.role === 'store_manager' ? '店长' : a.role === 'store_production_manager' ? '出品经理' : a.role;
      return `· ${rz} ${a.username}：扣 ${pts} 分，剩余 ${a.remainingScore} 分`;
    });
    await reply(
      `✅ 食安 **记录** 已执行（按岗位各扣 ${pts} 分，已写入当周绩效异常分并与 BI 异常同源）\n${lines.join('\n')}\n任务：**${taskId}**`
    ).catch(() => {});

    logger.info({ taskId, store, applied }, 'Food safety HQ ruling: recorded deductions');
    return { handled: true, outcome: 'recorded' };
  } catch (e) {
    logger.warn({ err: e?.message, taskId }, 'tryHandleFoodSafetyHqRuling failed');
    return { handled: false };
  }
}
