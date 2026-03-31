import { logger } from '../utils/logger.js';
import { routeMessage } from './message-router.js';
import { dispatchToAgent } from './agent-handlers.js';
import { planAndExecute } from './master-planner.js';
import { tryDeterministicReply } from './deterministic-replies.js';
import { detectMetricFromQuestion } from './analysis-intent.js';
import { detectIntent } from './intent-classifier.js';
import { extractTimeRangeFromText } from './data-executor.js';
import { analyzeMetricTree } from './analysis-engine.js';
import { sendText, replyMsg, getFeishuUserName, getHrmsEmployeeName, getHrmsEmployeeByFeishuOpenId, isHrmsEmployeeActive } from './feishu-client.js';
import { query } from '../utils/db.js';
import { checkIdempotency, saveIdempotency } from '../middleware/idempotency.js';

const DATA_AGENTS = new Set(['data_auditor','ops_supervisor','chief_evaluator','appeal']);
const HQ_ROLES = new Set(['admin','hq_manager']);
const STORE_ROLES = new Set(['store_manager','store_production_manager','front_manager']);

let _storeNamesCache = null;
let _storeNamesCacheTs = 0;
async function getAllStoreNames() {
  if (_storeNamesCache && Date.now() - _storeNamesCacheTs < 600000) return _storeNamesCache;
  try {
    const r = await query(`SELECT DISTINCT store FROM feishu_users WHERE store IS NOT NULL AND store != '' AND store != '总部'`);
    _storeNamesCache = r.rows.map(x => x.store);
    _storeNamesCacheTs = Date.now();
  } catch(e) { _storeNamesCache = _storeNamesCache || []; }
  return _storeNamesCache;
}

function extractStoreFromText(text, storeNames) {
  if (!text || !storeNames?.length) return '';
  for (const s of storeNames) {
    if (text.includes(s)) return s;
  }
  for (const s of storeNames) {
    const short = s.replace(/店$/, '').trim();
    if (text.includes(short)) return s;
  }
  // 短名匹配：洪潮、马己仙等 → 洪潮xxx店、马己仙xxx店
  for (const s of storeNames) {
    const noSuffix = s.replace(/店$/, '').trim();
    for (let len = 2; len <= Math.min(6, noSuffix.length); len++) {
      const prefix = noSuffix.slice(0, len);
      if (text.includes(prefix)) return s;
    }
  }
  return '';
}

/** 与 master-planner 的 plan 对齐，供子 Agent 的 callLLM context */
function inferLlmContextFromRoute(route, text) {
  const t = String(text || '');
  if (/为什么|为何|原因|分析|趋势|异常|下降|下滑/.test(t)) {
    return {
      mode: 'single',
      intent: 'analysis',
      complexity: /为什么|原因|趋势|异常/.test(t) ? 'high' : 'medium'
    };
  }
  if (route === 'chief_evaluator' || route === 'appeal') {
    return { mode: 'single', intent: 'analysis', complexity: 'high' };
  }
  if (route === 'marketing_planner' || route === 'marketing_executor' || route === 'marketing') {
    return { mode: 'single', intent: 'analysis', complexity: 'medium' };
  }
  if (route === 'train_advisor') {
    return { mode: 'single', intent: 'query', complexity: 'medium' };
  }
  return { mode: 'single', intent: 'query', complexity: 'low' };
}

function mergePlannerLlmContext(plannerPlan, route, text) {
  if (plannerPlan && plannerPlan.intent != null) {
    return {
      intent: plannerPlan.intent,
      complexity: plannerPlan.complexity ?? 'low',
      mode: plannerPlan.mode ?? 'single'
    };
  }
  return inferLlmContextFromRoute(route, text);
}

function validateEvidence(res) {
  if (!DATA_AGENTS.has(res.agent)) return { valid: true };
  const hasData = res.data && !res.data.includes('[no data found]') && !res.data.includes('[暂无');
  const resp = res.response || '';
  // 明确说明无数据/暂无/0条 的回复视为合规
  if (/\b(无营业数据|暂无数据|0条|未.*数据|无.*记录)\b/.test(resp)) return { valid: true, hasData: false };
  const hasNumbers = /\d{2,}/.test(resp);
  if (hasNumbers && !hasData) {
    logger.warn({ agent: res.agent, store: res.store }, 'evidence_chain_violation: response has numbers but no data backing');
    return { valid: false, reason: 'no_data_backing' };
  }
  return { valid: true, hasData };
}

/** 是否在问「我是谁」类身份问题 */
function isIdentityQuery(text) {
  const t = String(text || '').trim();
  return /^我是谁|谁是我|我的身份|当前用户|当前是谁$/i.test(t) || /^(我|你)是(谁|哪个)/.test(t);
}

/**
 * V1 回复模版（与参考图一致）：
 * 第1行：小年: | Magazine: [用户问题原文]
 * 第2行：小年: 📊 [报告标题](门店・时间)
 * 空行
 * 正文（引导句 + 要点 + **总结**）
 */
function formatReplyV1(res, userStoreLabel, userQuery) {
  const body = String(res.response || '').trim();
  const store = res.store || userStoreLabel || '';
  const timeLabel = res.timeLabel || '';
  const reportTitle = res.reportTitle || '';
  const topicLine = userQuery ? `小年: | Magazine: ${userQuery}\n` : '';
  if (reportTitle && (store || timeLabel)) {
    // V1 营收分析用竖线： (门店 | 时间)，其他用中点 ・
    const sep = reportTitle === '营收分析' ? ' | ' : '・';
    const sub = [store, timeLabel].filter(Boolean).join(sep);
    return `${topicLine}小年: 📊 ${reportTitle}(${sub})\n\n${body}`;
  }
  if (topicLine) return `${topicLine}小年: ${body}`;
  return '小年: ' + body;
}

/** 确保 feishu_pending_replies 表存在 */
async function ensurePendingRepliesTable() {
  await query(`
    CREATE TABLE IF NOT EXISTS feishu_pending_replies (
      open_id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `).catch(() => {});
}
// 初始化时建表（不阻塞）
ensurePendingRepliesTable().catch(() => {});

/** 检查用户是否有待回复任务；若有则保存回复内容到 master_tasks，返回 taskId；否则返回 null */
async function checkAndProcessPendingReply(openId, text, messageId) {
  if (!openId || !text) return null;
  try {
    const r = await query(
      `SELECT task_id, created_at FROM feishu_pending_replies WHERE open_id = $1 LIMIT 1`,
      [openId]
    );
    if (!r.rows?.length) return null;
    const { task_id: taskId, created_at: createdAt } = r.rows[0];
    // 超过 30 分钟的 pending reply 自动失效
    if (Date.now() - new Date(createdAt).getTime() > 30 * 60 * 1000) {
      await query(`DELETE FROM feishu_pending_replies WHERE open_id = $1`, [openId]).catch(() => {});
      return null;
    }
    // 保存整改回复到 master_tasks
    const replyContent = String(text).trim();
    await query(
      `UPDATE master_tasks
       SET status = 'pending_review',
           response_text = $2,
           response_at = NOW(),
           updated_at = NOW()
       WHERE task_id = $1`,
      [taskId, replyContent]
    ).catch(() => {});
    // 清除 pending 状态
    await query(`DELETE FROM feishu_pending_replies WHERE open_id = $1`, [openId]).catch(() => {});
    logger.info({ openId, taskId, replyLen: replyContent.length }, 'pending reply processed → task pending_review');
    // 确认消息
    const confirmMsg = `✅ 已收到您对任务 ${taskId} 的整改回复，已提交审核。系统将跟踪直至审核通过。`;
    if (messageId) {
      await replyMsg(messageId, confirmMsg).catch(() => {});
    } else {
      await sendText(openId, confirmMsg, 'open_id').catch(() => {});
    }
    return taskId;
  } catch (e) {
    logger.warn({ err: e?.message, openId }, 'checkAndProcessPendingReply error');
    return null;
  }
}

export async function processMessage(ev) {
  if (!ev.text) return { ok: false, reason: 'empty' };

  // ── 检查待回复任务状态（在幂等检查之后，业务路由之前）──
  if (ev.userId) {
    const pendingTaskId = await checkAndProcessPendingReply(ev.userId, ev.text, ev.messageId);
    if (pendingTaskId) {
      return { ok: true, route: 'task_reply', taskId: pendingTaskId };
    }
  }

  // ── 幂等性检查: 防止飞书事件重复处理 ──
  const idemKey = ev.eventId || ev.messageId || null;
  if (idemKey) {
    const cached = await checkIdempotency(idemKey);
    if (cached) {
      logger.info({ key: idemKey }, 'idempotency hit — skip duplicate');
      return { ok: true, cached: true, ...cached };
    }
  }

  const t0 = Date.now();
  const pipelineIntent = detectIntent(ev.text);
  logger.info({ text: ev.text?.slice(0, 50), userId: ev.userId, pipelineIntent }, 'pipeline start');
  try {
    const user = await resolveUser(ev.userId);
    logger.info({ user: user?.username, store: user?.store, role: user?.role }, 'resolved user');

    // ── 检查员工是否在职：若未绑定或已离职/禁用，禁止使用 ──
    let hrmsEmp = null;
    try {
      hrmsEmp = await getHrmsEmployeeByFeishuOpenId(ev.userId);
    } catch (e) {
      logger.warn({ err: e?.message, userId: ev.userId }, 'getHrmsEmployeeByFeishuOpenId error, fallback to feishu_users');
    }

    // 调试日志
    logger.info({ userId: ev.userId, hrmsEmpFound: !!hrmsEmp, hrmsEmpStatus: hrmsEmp?.status }, 'HRMS employee lookup result');

    if (!hrmsEmp) {
      // 未绑定HRMS：如果feishu_users有注册记录则放行（用feishu_users数据），否则提示绑定
      if (!user) {
        const bindPrompt = '小年：您尚未绑定员工信息，请联系管理员完成绑定后再使用。';
        if (ev.messageId) await replyMsg(ev.messageId, bindPrompt).catch(() => {});
        else if (ev.chatId) await sendText(ev.chatId, bindPrompt).catch(() => {});
        return { ok: false, reason: 'not_bound', ms: Date.now() - t0 };
      }
      logger.info({ userId: ev.userId, username: user?.username }, 'User in feishu_users but not HRMS, allowing');
    } else if (!isHrmsEmployeeActive(hrmsEmp)) {
      // 已离职/禁用，禁止使用
      const inactiveMsg = '小年: 您的账号已离职或已禁用，无法使用智能助理。如有疑问，请联系人事部门。';
      if (ev.messageId) await replyMsg(ev.messageId, inactiveMsg).catch(() => {});
      else if (ev.chatId) await sendText(ev.chatId, inactiveMsg).catch(() => {});
      return { ok: false, reason: 'inactive_employee', ms: Date.now() - t0 };
    }

    // c) 我是谁：优先 HRMS 员工姓名 → feishu_users.name → 飞书 API → username
    if (isIdentityQuery(ev.text)) {
      // HRMS 姓名优先，若无则用 feishu_users
      let displayName = hrmsEmp?.name ? String(hrmsEmp.name).trim() : null;
      if (!displayName && user?.name) displayName = String(user.name).trim();
      if (!displayName && user?.username) {
        const hrmsName = await getHrmsEmployeeName(user.username);
        if (hrmsName) displayName = hrmsName;
      }
      if (!displayName && ev.userId) {
        const feishuName = await getFeishuUserName(ev.userId);
        if (feishuName) displayName = feishuName;
      }
      displayName = displayName || user?.username || '未知用户';
      const storeDesc = hrmsEmp?.store || user?.store || '';
      const storeLabel = storeDesc && storeDesc !== '总部' ? storeDesc : '未指定门店';
      const roleDesc = (hrmsEmp?.role || user?.role) === 'store_manager' ? '店长' :
                       (hrmsEmp?.role || user?.role) === 'store_production_manager' ? '出品经理' :
                       (hrmsEmp?.role || user?.role) === 'hq_manager' ? '总部主管' :
                       (hrmsEmp?.role || user?.role) || '员工';
      const identityReply = `小年: 您是 **${displayName}**（${roleDesc}），当前门店：${storeLabel}。`;
      if (ev.messageId) await replyMsg(ev.messageId, identityReply).catch(() => {});
      else if (ev.chatId) await sendText(ev.chatId, identityReply).catch(() => {});
      return { ok: true, route: 'identity', agent: 'master', ms: Date.now() - t0 };
    }

    // 使用 HRMS 员工信息覆盖 feishu_users（姓名/门店/角色均以 HRMS 为准），若无则用 feishu_users
    let store = hrmsEmp?.store || user?.store || '';
    const role = hrmsEmp?.role || user?.role || '';
    const username = hrmsEmp?.username || user?.username || '';

    let rt = await routeMessage(ev.text, !!ev.hasImage, username);
    // a) 从消息中推断门店：支持「洪潮」「马己仙」等短名
    if (HQ_ROLES.has(role) || !store || store === '总部') {
      const storeNames = await getAllStoreNames();
      const mentioned = extractStoreFromText(ev.text, storeNames);
      if (mentioned) store = mentioned;
      else if (HQ_ROLES.has(role)) store = '';
    }
    if (STORE_ROLES.has(role) && store && store !== '总部') {
      // 已确认门店，保持不变
    }
    // 优先使用 HRMS 姓名作为 ctx.name
    const ctxName = hrmsEmp?.name || user?.name || username;
    const ctx = { store, username, role, name: ctxName, realName: ctxName };
    ctx.pipelineIntent = pipelineIntent;
    ctx.forceAnalysis = pipelineIntent === 'analysis';
    ctx.forceStrategy = pipelineIntent === 'strategy';

    // 策略生成类：统一走营销策划 Agent（避免被 data_auditor / 确定性日报抢占）
    if (pipelineIntent === 'strategy') {
      rt = { ...rt, route: 'marketing_planner' };
    }

    // ── Planner：query / unknown 保留；analysis / strategy 不抢答，交给指标分析或营销 Agent ──
    let plannerPlanSnapshot = null;
    if (pipelineIntent !== 'analysis' && pipelineIntent !== 'strategy') {
      try {
        const plannerRes = await planAndExecute(ev.text, ctx);
        plannerPlanSnapshot = plannerRes?.plan ?? null;
        if (plannerRes?.agent === 'master_planner' && plannerRes.response) {
          const prefixedResponse = formatReplyV1(
            { agent: 'master_planner', response: plannerRes.response, store: plannerRes.store || store },
            store,
            ev.text?.trim() || ''
          );
          if (ev.messageId) await replyMsg(ev.messageId, prefixedResponse).catch(e => logger.error({ err: e?.message }, 'planner reply failed'));
          else if (ev.chatId) await sendText(ev.chatId, prefixedResponse).catch(e => logger.error({ err: e?.message }, 'planner send failed'));

          await logTaskResult({ agent: 'planner_workflow', store, data: plannerRes.data }, ctx, Date.now() - t0).catch(() => {});
          const result = { ok: true, route: 'planner', agent: 'planner_workflow', ms: Date.now() - t0, evidence: true };
          if (idemKey) await saveIdempotency(idemKey, result).catch(() => {});
          return result;
        }
      } catch (e) {
        logger.warn({ err: e?.message }, 'planner failed, fallback to original flow');
      }
    }

    // ── analysis：预取指标树；query 走后续 deterministic；strategy 跳过日报式确定性（营销侧自行处理） ──
    if (pipelineIntent === 'analysis' && store) {
      try {
        const tr = extractTimeRangeFromText(ev.text);
        const metricCode = detectMetricFromQuestion(ev.text) || 'revenue';
        ctx.metricAnalysis = await analyzeMetricTree(metricCode, store, tr);
      } catch (e) {
        logger.warn({ err: e?.message }, 'pipeline: metric analysis prefetch skipped');
      }
    }

    // ── 确定性回复优先：匹配V1格式，直接返回结构化数据，不走LLM ──
    try {
      const detReply = await tryDeterministicReply(ev.text, ctx);
      if (detReply) {
        const prefixed = '小年：' + detReply;
        logger.info({ store, detReplyLen: detReply.length }, 'deterministic reply hit');
        if (ev.messageId) await replyMsg(ev.messageId, prefixed).catch(e => logger.error({ err: e?.message }, 'det reply failed'));
        else if (ev.chatId) await sendText(ev.chatId, prefixed).catch(e => logger.error({ err: e?.message }, 'det send failed'));
        await logTaskResult({ agent: 'deterministic', store, data: detReply }, ctx, Date.now() - t0).catch(() => {});
        const result = { ok: true, route: 'deterministic', agent: 'deterministic', ms: Date.now() - t0, evidence: true };
        if (idemKey) await saveIdempotency(idemKey, result).catch(() => {});
        return result;
      }
    } catch (detErr) {
      logger.warn({ err: detErr?.message }, 'deterministic reply error, falling back to LLM');
    }

    ctx.llmContext = mergePlannerLlmContext(plannerPlanSnapshot, rt.route, ev.text);
    if (pipelineIntent === 'analysis') {
      ctx.llmContext = { ...ctx.llmContext, intent: 'analysis', complexity: 'high', mode: 'single' };
    } else if (pipelineIntent === 'strategy') {
      ctx.llmContext = { ...ctx.llmContext, intent: 'analysis', complexity: 'medium', mode: 'single' };
    } else if (pipelineIntent === 'query') {
      ctx.llmContext = { ...ctx.llmContext, intent: 'query', complexity: 'low', mode: 'single' };
    }
    const res = await dispatchToAgent(rt.route, ev.text, ctx);
    const ev_check = validateEvidence(res);
    if (!ev_check.valid) {
      res.response = '⚠️ 数据证据不足，无法生成可靠回复。请提供门店（如：洪潮、马己仙）或更具体的时间范围（如：昨天、上周）。';
      res.evidenceViolation = true;
      logger.warn({ agent: res.agent, reason: ev_check.reason }, 'blocked fabricated response');
    }
    const prefixedResponse = formatReplyV1(res, store, ev.text?.trim() || '');
    logger.info({ route: rt.route, agent: res.agent, responsePreview: prefixedResponse?.slice(0, 100) }, 'sending reply');
    if (ev.messageId) await replyMsg(ev.messageId, prefixedResponse).catch(e => logger.error({ err: e?.message }, 'reply failed'));
    else if (ev.chatId) await sendText(ev.chatId, prefixedResponse).catch(e => logger.error({ err: e?.message }, 'send failed'));
    await logTaskResult(res, ctx, Date.now() - t0).catch(() => {});
    const result = { ok:true, route:rt.route, agent:res.agent, ms:Date.now()-t0, evidence: ev_check.valid };

    if (idemKey) await saveIdempotency(idemKey, result).catch(() => {});

    return result;
  } catch(e) {
    logger.error({err:e?.message},'pipeline err');
    return { ok:false, error:e?.message };
  }
}

async function logTaskResult(res, ctx, ms) {
  try {
    await query(
      `INSERT INTO agent_task_logs (agent, store, username, latency_ms, has_evidence, evidence_violation)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [res.agent, ctx.store||null, ctx.username||null, ms, !!res.data, !!res.evidenceViolation]);
  } catch (e) { /* table may not exist */ }
}
async function resolveUser(uid) {
  if (!uid) return null;
  try { const r=await query('SELECT username,role,store,name FROM feishu_users WHERE open_id=$1 AND registered=true LIMIT 1',[uid]); return r.rows?.[0]||null; } catch(e){ return null; }
}
