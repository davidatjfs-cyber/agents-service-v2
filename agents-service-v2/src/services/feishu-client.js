// ============================================================
// feishu-client.js — Barrel / Facade
//
// 拆分说明：以下功能已迁移到独立子模块，本文件统一 re-export：
//   - feishu-auth.js       → 鉴权、token、加密解密
//   - feishu-messaging.js  → 消息发送（文本/卡片/群聊/回复/图片）
//   - feishu-users.js      → 用户查询、OpenId 解析、HRMS 员工绑定
//   - feishu-cards.js      → 卡片构建（BI/Bonus/Anomaly/Task/Review）
//
// 本文件保留较复杂的业务函数：webhook 处理、card action、review 系统、
// proactive 推送等。
//
// 外部导入路径不变：
//   import { sendText, getTenantToken } from './services/feishu-client.js'
// ============================================================

import { query } from '../utils/db.js';
import { logger } from '../utils/logger.js';
import { isMarketingPlanningIntent } from '../utils/marketing-intent.js';
import { isExternalEnabled } from '../utils/safety.js';

// ── Sub-module imports for remaining functions ──
export {
  getTenantToken,
  getFeishuStatus,
  decryptFeishuEncryptPayload,
  BASE
} from './feishu-auth.js';

export {
  sendText,
  sendCard,
  sendGroup,
  sendGroupCard,
  replyMsg,
  downloadImage
} from './feishu-messaging.js';

export {
  resolveOpenIdForCurrentFeishuApp,
  refreshFeishuUserOpenIdForImDelivery,
  feishuOpenIdIsMajixianPmObserver,
  lookupUser,
  getHrmsEmployeeName,
  getFeishuUserName,
  getHrmsEmployeeByUsername,
  isHrmsEmployeeActive,
  getHrmsEmployeeByFeishuOpenId,
  lookupUserByUsername,
  bindFeishuUserToEmployee
} from './feishu-users.js';

export {
  roleLabelZhForBiCard,
  buildBiDeductionCard,
  buildBiBonusCard,
  buildAnomalyCard,
  buildTaskCard,
  buildApprovalTaskCard,
  buildBadReviewCard,
  buildTableVisitCard,
  buildRhythmReportCard,
  buildPerformanceSummaryCard
} from './feishu-cards.js';

// ── Re-imports needed by remaining functions ──
import { sendText, sendCard, sendGroup, sendGroupCard, replyMsg, downloadImage } from './feishu-messaging.js';
import { getTenantToken, BASE } from './feishu-auth.js';
import { refreshFeishuUserOpenIdForImDelivery, lookupUser, getHrmsEmployeeByFeishuOpenId, feishuOpenIdIsMajixianPmObserver } from './feishu-users.js';
import { buildAnomalyCard } from './feishu-cards.js';

// ═══════════════════════════════════════════════════════════
// REMAINING FUNCTIONS (not extracted to sub-modules)
// ═══════════════════════════════════════════════════════════

// ── Notice / Alert functions ──

import { resolveAssigneeOpenIdsForTask } from '../utils/feishu-assignee-resolve.js';

function buildDefaultCompanyNoticeInteractiveCard(noticeTitle, plainBody) {
  const body = String(plainBody || '').trim();
  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: `【${noticeTitle}】` },
      template: 'blue'
    },
    elements: [
      { tag: 'div', text: { tag: 'lark_md', content: body } },
      {
        tag: 'note',
        elements: [{ tag: 'plain_text', content: '请妥善留存；如有异议请联系营运或 HR。' }]
      }
    ]
  };
}

function cloneMgmtCcInteractiveCard(baseCard, noticeTitle) {
  const card = JSON.parse(JSON.stringify(baseCard));
  card.header = card.header || {};
  card.header.title = { tag: 'plain_text', content: `【管理层抄送·${noticeTitle}】` };
  if (card.header.template == null) card.header.template = 'blue';
  return card;
}

export async function lookupAssigneeOpenIds(task) {
  return resolveAssigneeOpenIdsForTask(task);
}

export async function sendCompanyNoticeToAssignees(task, body, opts = {}) {
  const text = String(body || '').trim();
  if (!text) return { targets: 0, sentCards: 0, sentTexts: 0 };
  const sendToAssignee = opts.sendToAssignee !== false;
  const sendToManagement = opts.sendToManagement !== false;
  const oids = await lookupAssigneeOpenIds(task);

  const noticeTitle = opts.title || '公司通知';
  const noticeType = opts.type || 'task_attitude_notice';
  const assigneeUsernames = [];
  try {
    const un = String(task?.assignee_username || '').trim();
    if (un) assigneeUsernames.push(un.toLowerCase());
    for (const oid of oids) {
      const fu = await query(
        `SELECT username FROM feishu_users WHERE open_id = $1 AND registered = true LIMIT 1`,
        [oid]
      ).catch(() => ({ rows: [] }));
      const fu_un = String(fu.rows?.[0]?.username || '').trim().toLowerCase();
      if (fu_un && !assigneeUsernames.includes(fu_un)) assigneeUsernames.push(fu_un);
    }
    const taskId = task?.task_id;
    for (const username of assigneeUsernames) {
      if (!username) continue;
      if (taskId) {
        const dup = await query(
          `SELECT 1 FROM hrms_user_notifications
           WHERE target_username = $1 AND meta->>'task_id' = $2 LIMIT 1`,
          [username, String(taskId)]
        ).catch(() => ({ rows: [] }));
        if (dup.rows?.length) continue;
      }
      await query(
        `INSERT INTO hrms_user_notifications (target_username, title, message, type, meta)
         VALUES ($1, $2, $3, $4, $5::jsonb)`,
        [
          username,
          noticeTitle,
          text,
          noticeType,
          JSON.stringify({ task_id: taskId, store: task?.store, source: task?.source })
        ]
      ).catch((e) => logger.warn({ err: e?.message, username }, 'company notice: hrms_user_notifications insert failed'));
    }
  } catch (e) {
    logger.warn({ err: e?.message }, 'company notice: hrms_user_notifications batch failed');
  }

  let sentCards = 0;
  let sentTexts = 0;
  let sentMgmtCards = 0;
  const plain = text.length > 3500 ? `${text.slice(0, 3497)}…` : text;
  const assigneeInteractiveCard =
    opts.card && typeof opts.card === 'object'
      ? opts.card
      : buildDefaultCompanyNoticeInteractiveCard(noticeTitle, plain);
  if (sendToAssignee) {
    for (const oid of oids) {
      const cardRes = await sendCard(oid, assigneeInteractiveCard, 'open_id');
      if (cardRes?.ok) sentCards += 1;
      else {
        const txtRes = await sendText(oid, `【${noticeTitle}】\n${text}`, 'open_id');
        if (txtRes?.ok) sentTexts += 1;
      }
    }
  }
  if (sendToAssignee && !oids.length) {
    logger.warn({ taskId: task?.task_id, store: task?.store }, 'company notice: no assignee open_id');
  } else if (sendToAssignee) {
    logger.info(
      { taskId: task?.task_id, targets: oids.length, sentCards, sentTexts },
      'company notice to assignee'
    );
  }

  try {
    if (!sendToManagement) return { targets: sendToAssignee ? oids.length : 0, sentCards, sentTexts };
    const mgR = await query(
      `SELECT DISTINCT open_id, COALESCE(NULLIF(TRIM(name),''), username) AS name
       FROM feishu_users WHERE role IN ('admin','hq_manager') AND registered = true AND open_id IS NOT NULL AND open_id NOT LIKE '%probe%'`
    );
    const mgRows = mgR.rows || [];
    if (mgRows.length) {
      const assigneeNameRows = oids.length
        ? await query(
            `SELECT COALESCE(NULLIF(TRIM(name),''), username) AS name
             FROM feishu_users WHERE open_id = ANY($1::text[]) AND registered = true LIMIT 1`,
            [oids]
          ).then((r) => r.rows).catch(() => [])
        : [];
      const assigneeNameStr = assigneeNameRows[0]?.name || task?.assignee_username || '责任人';
      const storeStr = task?.store || '';
      const mgmtTextFallback = `【管理层抄送·${noticeTitle}】\n门店：${storeStr}｜责任人：${assigneeNameStr}\n${plain}`;
      for (const mg of mgRows) {
        if (oids.includes(mg.open_id)) continue;
        const mgCard = cloneMgmtCcInteractiveCard(assigneeInteractiveCard, noticeTitle);
        const mRes = await sendCard(mg.open_id, mgCard, 'open_id');
        if (mRes?.ok) sentMgmtCards += 1;
        else {
          await sendText(mg.open_id, mgmtTextFallback, 'open_id').catch((e) =>
            logger.warn({ err: e?.message, oid: mg.open_id }, 'company notice: mgmt cc failed')
          );
        }
      }
      logger.info(
        { mgmt: mgRows.length, sentMgmtCards, taskId: task?.task_id },
        'company notice: mgmt cc sent'
      );
    }
  } catch (e) {
    logger.warn({ err: e?.message }, 'company notice: mgmt cc batch failed');
  }

  return { targets: oids.length, sentCards, sentTexts };
}

export async function pushAnomalyAlert(store, anomalyKey, severity, detail, taskId) {
  const emoji = severity === 'high' ? '🚨' : '⚠️';
  const users = await query('SELECT open_id FROM feishu_users WHERE store = $1 AND role IN (\'store_manager\',\'admin\',\'hq_manager\') AND registered = TRUE AND open_id NOT LIKE \'%probe%\'', [store]);
  const results = [];
  for (const u of (users.rows || [])) {
    const card = buildAnomalyCard(store, anomalyKey, severity, detail, taskId);
    let r = await sendCard(u.open_id, card);
    if (!r.ok) {
      const { anomalyRuleLabelZh } = await import('../utils/anomaly-labels.js');
      const typeZh = anomalyRuleLabelZh(anomalyKey);
      r = await sendText(
        u.open_id,
        emoji + ' 【异常告警】' + store + '\n类型: ' + typeZh + '\n严重度: ' + severity + '\n详情: ' + detail
      );
    }
    results.push(r);
  }
  return { ok: true, sent: results.length };
}

export async function pushRhythmReport(content) {
  const chatId = process.env.FEISHU_HQ_OPS_CHAT_ID;
  if (chatId) return sendGroup(chatId, content);
  try {
    const r = await query(
      `SELECT open_id FROM feishu_users
       WHERE registered = true AND open_id IS NOT NULL AND role IN ('admin','hq_manager') AND open_id NOT LIKE '%probe%'`
    );
    let sent = 0;
    for (const u of (r.rows || [])) {
      if (!u.open_id) continue;
      const res = await sendText(u.open_id, content, 'open_id');
      if (res?.ok) sent++;
    }
    if (sent > 0) return { ok: true, sent };
  } catch (_e) { /* ignore */ }
  return { ok: false, reason: 'no_hq_chat_id_and_no_admins' };
}

export async function pushRhythmCard(card) {
  const chatId = process.env.FEISHU_HQ_OPS_CHAT_ID;
  if (chatId) return sendGroupCard(chatId, card);
  try {
    const r = await query(
      `SELECT open_id FROM feishu_users
       WHERE registered = true AND open_id IS NOT NULL AND role IN ('admin','hq_manager') AND open_id NOT LIKE '%probe%'`
    );
    let sent = 0;
    for (const u of (r.rows || [])) {
      if (!u.open_id) continue;
      const res = await sendCard(u.open_id, card, 'open_id');
      if (res?.ok) sent++;
    }
    if (sent > 0) return { ok: true, sent };
  } catch (_e) { /* ignore */ }
  return { ok: false, reason: 'no_hq_chat_id_and_no_admins' };
}

// ── Webhook helpers ──

const _processedEvents = new Set();

function shouldTriggerOpsDiagnosis(text) {
  const t = String(text || '').trim().toLowerCase();
  if (!t) return false;
  if (isMarketingPlanningIntent(text)) return false;
  const keywords = [
    '运营诊断',
    '营运诊断',
    '门店诊断',
    '达成率',
    '问题在哪',
  ];
  return keywords.some(k => t.includes(k));
}

function parseDateInText(text) {
  const t = String(text || '');
  const m = t.match(/\b(20\d{2}-\d{2}-\d{2})\b/);
  return m ? m[1] : new Date().toISOString().slice(0, 10);
}

function formatOpsDecisionReport(report, dateStr) {
  const r = report && typeof report === 'object' ? report : {};
  const top = Array.isArray(r.top_3_issues) ? r.top_3_issues : [];
  const actions = Array.isArray(r.actions) ? r.actions : [];
  const warnings = Array.isArray(r.warnings) ? r.warnings : [];

  const lines = [];
  lines.push(`📊 营运诊断（${dateStr}）`);
  lines.push('');
  lines.push(`核心问题：${String(r.core_problem || '未识别到明确核心问题')}`);
  lines.push('');
  lines.push('Top3问题：');
  if (top.length) top.slice(0, 3).forEach((x, i) => lines.push(`${i + 1}. ${x}`));
  else lines.push('1. 暂无');
  lines.push('');
  lines.push('可执行动作：');
  if (actions.length) {
    actions.slice(0, 5).forEach((a, i) => {
      lines.push(`${i + 1}) [${a.role}] ${a.action}`);
      lines.push(`   截止：${a.deadline}；指标：${a.metric}`);
    });
  } else {
    lines.push('1) 暂无（AI暂时不可用）');
  }
  if (warnings.length) {
    lines.push('');
    lines.push('风险提示：');
    warnings.slice(0, 3).forEach((w, i) => lines.push(`${i + 1}. ${w}`));
  }
  return lines.join('\n');
}

function canViewAllStores(role) {
  const r = String(role || '').trim().toLowerCase();
  return r === 'admin' || r === 'hq_manager' || r === 'hr_manager';
}

// ── Card Action Normalization ──

export function normalizeCardActionBody(raw) {
  if (!raw || typeof raw !== 'object') return { open_id: '', action: {} };
  if (raw.schema === '2.0' && raw.event && typeof raw.event === 'object') {
    const ev = raw.event;
    const op = ev.operator && typeof ev.operator === 'object' ? ev.operator : {};
    const opId = op.operator_id && typeof op.operator_id === 'object' ? op.operator_id : {};
    return {
      open_id: String(op.open_id || opId.open_id || '').trim(),
      action: ev.action && typeof ev.action === 'object' ? ev.action : {}
    };
  }
  return {
    open_id: String(raw.open_id || '').trim(),
    action: raw.action && typeof raw.action === 'object' ? raw.action : {}
  };
}

async function ensurePllmPendingDecisionTable() {
  await query(`
    CREATE TABLE IF NOT EXISTS feishu_pending_pllm_decisions (
      open_id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      decision TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `).catch(() => {});
}

async function upsertPendingPllmDecision(openId, taskId, decision) {
  await ensurePllmPendingDecisionTable();
  await query(
    `INSERT INTO feishu_pending_pllm_decisions (open_id, task_id, decision, created_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (open_id)
     DO UPDATE SET task_id = EXCLUDED.task_id, decision = EXCLUDED.decision, created_at = NOW()`,
    [openId, taskId, decision]
  ).catch(() => {});
}

async function popPendingPllmDecision(openId) {
  if (!openId) return null;
  await ensurePllmPendingDecisionTable();
  const r = await query(
    `SELECT task_id, decision, created_at FROM feishu_pending_pllm_decisions WHERE open_id = $1 LIMIT 1`,
    [openId]
  ).catch(() => ({ rows: [] }));
  const row = r.rows?.[0];
  if (!row) return null;
  const createdAt = new Date(row.created_at).getTime();
  if (!Number.isFinite(createdAt) || Date.now() - createdAt > 30 * 60 * 1000) {
    await query(`DELETE FROM feishu_pending_pllm_decisions WHERE open_id = $1`, [openId]).catch(() => {});
    return null;
  }
  return {
    taskId: String(row.task_id || '').trim(),
    decision: String(row.decision || '').trim().toLowerCase()
  };
}

async function clearPendingPllmDecision(openId) {
  if (!openId) return;
  await query(`DELETE FROM feishu_pending_pllm_decisions WHERE open_id = $1`, [openId]).catch(() => {});
}

// ── Webhook Event Handler ──

export async function handleWebhookEvent(body) {
  let raw = body;
  const { decryptFeishuEncryptPayload } = await import('./feishu-auth.js');
  if (body?.encrypt) {
    try {
      const decrypted = decryptFeishuEncryptPayload(body.encrypt);
      raw = JSON.parse(decrypted);
      logger.info({ encrypt: true }, 'Feishu payload decrypted');
    } catch (e) {
      logger.error({ err: e?.message }, 'Feishu decrypt failed');
      return { toast: { type: 'error', content: '解密失败，请稍后重试' } };
    }
  }
  if (raw?.type === 'url_verification' || raw?.challenge) return { challenge: raw.challenge };
  const hdr = raw?.header || raw?.event?.header || {};
  const evt = raw?.event || {};
  const eventId = String(hdr?.event_id || raw?.uuid || '').trim();
  const eventType = String(hdr?.event_type || evt?.type || '').trim();
  if (!eventType) {
    const topKeys = raw && typeof raw === 'object' ? Object.keys(raw).slice(0, 20) : [];
    const evtKeys = evt && typeof evt === 'object' ? Object.keys(evt).slice(0, 20) : [];
    logger.warn({ topKeys, evtKeys, hasEncrypt: !!raw?.encrypt, hasChallenge: !!raw?.challenge }, 'Feishu webhook unknown event schema');
    if (raw?.action && typeof raw.action === 'object') {
      return handleCardAction(raw);
    }
  }

  if (eventType === 'card.action.trigger') {
    logger.info({ eventId, schema: raw?.schema }, 'Feishu card.action.trigger');
    const normalized = normalizeCardActionBody(raw);
    return handleCardAction(normalized);
  }

  if (eventId && _processedEvents.has(eventId)) return { toast: { type: 'info', content: 'ok' } };
  if (eventId) { _processedEvents.add(eventId); setTimeout(() => _processedEvents.delete(eventId), 300000); }
  logger.info({ eventType, eventId }, 'Feishu webhook');
  if (eventType === 'im.message.receive_v1') {
    const msg = evt?.message || {}, sender = evt?.sender || {};
    const openId = String(sender?.sender_id?.open_id || '').trim();
    const chatType = String(msg?.chat_type || '').trim();
    const msgType = String(msg?.message_type || '');
    logger.info(
      {
        eventType,
        eventId,
        messageId: msg?.message_id || '',
        chatType,
        openIdPresent: !!openId,
        msgType
      },
      'Feishu receive_v1 precheck'
    );
    if (!openId) {
      logger.info({ eventType, eventId, chatType }, 'Feishu webhook skipped (openId missing)');
      return { ok: true, skipped: true };
    }
    let text = '', imageKey = '';
    const rawContent = msg?.content;
    try {
      if (rawContent && typeof rawContent === 'object') {
        text = rawContent?.text ?? '';
        imageKey = rawContent?.image_key ?? rawContent?.imageKey ?? '';
      } else if (typeof rawContent === 'string') {
        const c = JSON.parse(rawContent || '{}');
        text = c?.text ?? '';
        imageKey = c?.image_key ?? c?.imageKey ?? '';
      } else if (rawContent != null) {
        text = String(rawContent);
      }
    } catch (e) {
      if (typeof rawContent === 'string') text = rawContent;
    }
    logger.info(
      {
        eventType,
        eventId,
        messageId: msg?.message_id || '',
        msgType,
        chatType,
        openIdPresent: !!openId,
        textLen: String(text || '').length,
        imageKeyPresent: !!imageKey
      },
      'Feishu message parsed'
    );

    const parsedText = String(text || '').trim();
    const hasParsedText = parsedText.length > 0;

    try {
      const candidateMessageIds = [
        msg?.message_id,
        msg?.root_id,
        msg?.parent_id,
        msg?.reply_to_message_id,
        msg?.root_message_id,
        msg?.quoted_message_id,
        msg?.referenced_message_id,
        msg?.reply_to?.message_id,
        msg?.reply_to?.root_message_id,
        msg?.root_message?.message_id,
        msg?.root?.message_id,
        msg?.quoted?.message_id,
        msg?.quoted_message?.message_id,
        msg?.referenced?.message_id,
        msg?.referenced_message?.message_id
      ]
        .map(v => (v == null ? '' : String(v).trim()))
        .filter(Boolean);

      logger.info(
        {
          eventId,
          eventType,
          messageId: msg?.message_id || '',
          candidateMessageIds,
          rootId: msg?.root_id,
          parentId: msg?.parent_id,
          replyToMessageId: msg?.reply_to_message_id,
          replyToObjMessageId: msg?.reply_to?.message_id,
          rootMessageId: msg?.root_message_id,
          rootMessageObjMessageId: msg?.root_message?.message_id,
          quotedMessageId: msg?.quoted_message_id,
          referencedMessageId: msg?.referenced_message_id
        },
        'Feishu direct-reply candidate message ids'
      );

      let taskId = null;
      let matchedCardMessageId = null;

      if (candidateMessageIds.length) {
        const hit = await query(
          `SELECT task_id
           FROM master_tasks
           WHERE status IN ('pending_response','pending_review')
             AND source IN ('random_inspection','scheduled_inspection','bi_anomaly')
             AND EXISTS (
               SELECT 1 FROM jsonb_array_elements_text(COALESCE(feishu_msg_ids, '[]'::jsonb)) AS mid
               WHERE mid = ANY($1::text[])
             )
           LIMIT 1`,
          [candidateMessageIds]
        ).catch(() => ({ rows: [] }));
        const foundTaskId = hit?.rows?.[0]?.task_id || null;
        if (foundTaskId) {
          taskId = foundTaskId;
          matchedCardMessageId = candidateMessageIds.find((c) => c) || null;
        }
      }

      if (!taskId && hasParsedText && openId) {
        const idMatch = parsedText.match(/\b(ANO-\d{8}-\d{4}|SCHED-\d{8}-\d{4})\b/);
        if (idMatch) {
          const tid = idMatch[1];
          const hit = await query(
            `SELECT mt.task_id
             FROM master_tasks mt
             LEFT JOIN feishu_users fu ON fu.open_id = $2 AND fu.registered = TRUE
             WHERE mt.task_id = $1
               AND mt.status IN ('pending_response','pending_review')
               AND mt.source IN ('random_inspection','scheduled_inspection','bi_anomaly')
               AND (
                  fu.role IN ('admin','hq_manager')
                  AND fu.open_id NOT LIKE '%probe%'
                  OR (COALESCE(fu.store,'') <> '' AND fu.store = mt.store)
                 OR lower(COALESCE(mt.assignee_username,'')) = lower(COALESCE(fu.username,''))
                 OR (
                   jsonb_typeof(COALESCE(mt.source_data->'assignee_open_ids', '[]'::jsonb)) = 'array'
                   AND COALESCE(mt.source_data->'assignee_open_ids', '[]'::jsonb) @> jsonb_build_array($2::text)
                 )
               )
             LIMIT 1`,
            [tid, openId]
          ).catch(() => ({ rows: [] }));
          const found = hit?.rows?.[0]?.task_id || null;
          if (found) {
            taskId = found;
            matchedCardMessageId = null;
          }
        }
      }

      if (!taskId && hasParsedText && openId) {
        try {
          const { resolveFoodSafetyHqReplyTask } = await import('./food-safety-hq-ruling.js');
          const hqRes = await resolveFoodSafetyHqReplyTask({ openId, parsedText });
          if (hqRes?.taskId) {
            taskId = hqRes.taskId;
            matchedCardMessageId = null;
            logger.info({ eventId, taskId, mode: 'food_safety_hq_fallback_resolve' }, 'direct reply: HQ food safety task resolved without thread match');
          }
        } catch (e) {
          logger.warn({ err: e?.message, eventId }, 'food_safety_hq_fallback_resolve failed');
        }
      }

      if (taskId) {
          const responseText = hasParsedText ? parsedText : null;
          const responseImages = msgType === 'image' && imageKey
            ? JSON.stringify([{ imageKey, messageId: msg?.message_id || '' }])
            : null;

          try {
            const { tryHandleFoodSafetyHqRuling } = await import('./food-safety-hq-ruling.js');
            const ruled = await tryHandleFoodSafetyHqRuling({
              taskId,
              responseText,
              openId: openId || null,
              replyMsg: (t) => replyMsg(msg?.message_id || '', t)
            });
            if (ruled?.handled) {
              const outcome = ruled.outcome || 'recorded';
              const terminal = outcome === 'dismissed' || outcome === 'recorded';
              const msgStatus = terminal ? 'resolved' : 'pending_response';
              const recordId = msg?.message_id ? String(msg.message_id) : '';
              if (recordId) {
                await query(
                  `INSERT INTO agent_messages (direction, channel, content_type, content, agent_data, record_id)
                   VALUES ('in','feishu','task_response', $1, $2::jsonb, $3)
                   ON CONFLICT DO NOTHING`,
                  [
                    `任务回复(食安${outcome}): ${taskId}`,
                    JSON.stringify({
                      taskId,
                      reply: responseText,
                      outcome,
                      status: msgStatus,
                      recordId,
                      raw: { messageId: msg?.message_id || '', chatType }
                    }),
                    recordId
                  ]
                ).catch(() => {});
              }
              logger.info(
                { eventId, taskId, recordId, outcome, mode: 'food_safety_hq_ruling' },
                'Feishu direct reply: food safety HQ ruling handled'
              );
              return { ok: true, eventType, mode: 'food_safety_hq_ruling', taskId, outcome };
            }

            const fsHit = await query(
              `SELECT 1 FROM master_tasks WHERE task_id = $1 AND source = 'bi_anomaly' AND category = 'food_safety' LIMIT 1`,
              [taskId]
            ).catch(() => ({ rows: [] }));
            if (fsHit.rows?.length && openId) {
              const ur = await query(
                `SELECT role FROM feishu_users WHERE open_id = $1 AND registered = true LIMIT 1`,
                [openId]
              ).catch(() => ({ rows: [] }));
              if (String(ur.rows?.[0]?.role || '').trim() === 'admin') {
                if (msg?.message_id) {
                  await replyMsg(
                    msg.message_id,
                    `📋 食安异常任务 **${taskId}** 仅可由 **总部营运** 回复「记录/不记录」判罚；管理员为只读通知，无需回复本条。`
                  ).catch(() => {});
                }
                logger.info({ eventId, taskId, openId }, 'Feishu: food_safety task reply ignored (admin read-only)');
                return { ok: true, eventType, mode: 'food_safety_admin_readonly', taskId };
              }
            }
          } catch (e) {
            logger.warn({ err: e?.message, taskId }, 'food_safety_hq_ruling branch failed');
          }

          const { addTaskEvidence } = await import('./task-orchestrator.js');
          await addTaskEvidence(taskId, {
            evidenceType: responseImages?.length ? 'photo' : 'text',
            content: responseText,
            submittedBy: openId,
            submittedRole: 'feishu_user',
            metadata: { responseImages, source: 'feishu_direct_task_reply', messageId: msg?.message_id || null }
          }).catch(async () => {
            await query(
              `UPDATE master_tasks
               SET responded_at = NOW(),
                   updated_at = NOW(),
                   response_text = COALESCE($2, response_text),
                   response_images = COALESCE($3::jsonb, response_images)
                WHERE task_id = $1`,
              [taskId, responseText, responseImages]
            ).catch(() => {});
          });

          const recordId = matchedCardMessageId ? String(matchedCardMessageId) : (msg?.message_id ? String(msg.message_id) : '');
          if (recordId) {
            await query(
              `INSERT INTO agent_messages (direction, channel, content_type, content, agent_data, record_id)
               VALUES ('in','feishu','task_response', $1, $2::jsonb, $3)
               ON CONFLICT DO NOTHING`,
              [
                `任务回复: ${taskId}`,
                JSON.stringify({
                  taskId,
                  reply: responseText,
                  status: 'pending_review',
                  recordId,
                  raw: { messageId: msg?.message_id || '', chatType }
                }),
                recordId
              ]
            ).catch(() => {});
          }

          if (msg?.message_id) {
            await replyMsg(
              msg.message_id,
              `✅ 已收到你的回复，系统正在审核内容质量，任务：${taskId}。`
            ).catch(() => {});
          }
          logger.info(
            {
              eventId,
              taskId,
              recordId: recordId ? String(recordId) : '',
              responseTextLen: responseText ? String(responseText).length : 0
            },
            'Feishu direct reply captured'
          );

          const hasTaskImage = !!String(imageKey || '').trim();
          const { reviewTaskReply } = await import('./feishu-client.js');
          setImmediate(() => {
            reviewTaskReply(
              taskId,
              responseText,
              hasTaskImage,
              msg?.message_id || null,
              hasTaskImage ? String(imageKey).trim() : null
            ).catch(() => {});
          });

          return { ok: true, eventType, mode: 'task_reply_captured', taskId };
        }

    } catch (e) {
      logger.error(
        { eventType, eventId, openIdPresent: !!openId, err: e?.message },
        'direct-reply capture failed'
      );
    }

    const isBotDirectChat = chatType === 'private' || chatType === 'p2p';
    if (!isBotDirectChat) {
      logger.info(
        { eventType, eventId, chatType },
        'Feishu webhook: non-direct chat, skip LLM pipeline (task reply already attempted)'
      );
      return { ok: true, skipped: true, reason: 'non_direct_chat' };
    }

    try {
      const hrmsEmpMc = await getHrmsEmployeeByFeishuOpenId(openId);
      const fuMc = await lookupUser(openId);
      const feishuUserMc = {
        role: String(hrmsEmpMc?.role || fuMc?.role || '').trim(),
        username: String(hrmsEmpMc?.username || fuMc?.username || '').trim()
      };
      const { tryV2FeishuMarketingCopyRound } = await import('./feishu-marketing-copy.js');
      const mcRes = await tryV2FeishuMarketingCopyRound({
        openId,
        feishuUser: feishuUserMc,
        text: parsedText,
        msgType,
        imageKey,
        messageId: msg?.message_id,
        downloadImage
      });
      if (mcRes?.handled) {
        return { ok: true, eventType, mode: 'marketing_copy', ...(mcRes.extra || {}) };
      }
    } catch (e) {
      logger.error({ err: e?.message }, 'feishu marketing_copy round failed');
    }

    if (msgType === 'image' && imageKey && msg?.message_id) {
      const imageData = await downloadImage(msg.message_id, imageKey);
      if (imageData) {
        const { callVisionLLM } = await import('./llm-provider.js');
        const visionResult = await callVisionLLM(imageData, '请识别这张图片中的内容,判断是否为餐厅厨房环境或整改照片。如果能识别出具体内容,请详细描述。');
        if (visionResult.ok && visionResult.content) {
          await replyMsg(msg.message_id, '🔍 图片分析结果:\n' + visionResult.content.slice(0, 2000));
          return { ok: true, eventType, imageAnalyzed: true };
        }
        await replyMsg(msg.message_id, '图片已收到,但分析暂时不可用,请稍后重试或发送文字描述。');
        return { ok: true, eventType, imageReceived: true };
      }
    }
    if (!text) return { ok: true, skipped: 'no_text' };

    try {
      const pendingPllm = await popPendingPllmDecision(openId);
      const parsedTextLocal = String(text || '').trim();
      if (pendingPllm && parsedTextLocal && msg?.message_id) {
        const u = await lookupUser(openId);
        const role = String(u?.role || '').trim();
        if (u && ['admin', 'hq_manager'].includes(role)) {
          const { applyPllmDecision } = await import('./proactive-v2/pllm-workflow.js');
          const op = String(u.username || '').trim() || 'unknown';
          let decision = pendingPllm.decision;
          let planText = parsedTextLocal;
          if (decision === 'choose') {
            const m = parsedTextLocal.match(/^\s*(执行|不适合)\s*[:：,，\s]*(.+)?$/);
            if (!m) {
              await replyMsg(msg.message_id, `请以「执行：具体计划」或「不适合：具体原因」回复，任务：${pendingPllm.taskId}`).catch(() => {});
              return { ok: true, eventType, mode: 'pllm_pending_decision_need_choice', taskId: pendingPllm.taskId };
            }
            decision = m[1] === '执行' ? 'execute' : 'not_suitable';
            planText = String(m[2] || '').trim();
            if (!planText) {
              await replyMsg(msg.message_id, `请补充具体${decision === 'execute' ? '执行计划' : '不适合原因'}，任务：${pendingPllm.taskId}`).catch(() => {});
              return { ok: true, eventType, mode: 'pllm_pending_decision_need_detail', taskId: pendingPllm.taskId };
            }
          }
          const r = await applyPllmDecision(pendingPllm.taskId, decision, op, planText);
          await clearPendingPllmDecision(openId);
          if (r?.ok) {
            const okText =
              decision === 'execute'
                ? `✅ 已记录执行计划并进入跟踪：${pendingPllm.taskId}`
                : `✅ 已记录不适合原因并结案：${pendingPllm.taskId}`;
            await replyMsg(msg.message_id, okText).catch(() => {});
            return { ok: true, eventType, mode: 'pllm_pending_decision_committed', taskId: pendingPllm.taskId };
          }
          await replyMsg(msg.message_id, `⚠️ PLLM 提交失败：${String(r?.error || 'unknown')}`).catch(() => {});
          return { ok: true, eventType, mode: 'pllm_pending_decision_failed' };
        }
      }
    } catch (e) {
      logger.warn({ err: e?.message, openId }, 'consume pending PLLM decision failed');
    }

    if (shouldTriggerOpsDiagnosis(text) && msg?.message_id) {
      try {
        const dateStr = parseDateInText(text);
        const { getAIOperationsReport } = await import('./ai-operations.js');
        const hrmsEmp = await getHrmsEmployeeByFeishuOpenId(openId);
        const role = String(hrmsEmp?.role || '').trim();
        const store = String(hrmsEmp?.store || '').trim();
        const scoped = canViewAllStores(role) ? {} : (store ? { store } : {});
        const { report } = await getAIOperationsReport(dateStr, scoped);
        const reply = formatOpsDecisionReport(report, dateStr);
        await replyMsg(msg.message_id, reply.slice(0, 3000));
        return { ok: true, eventType, mode: 'ops_diagnosis' };
      } catch (e) {
        logger.error({ err: e?.message }, 'ops_diagnosis failed');
        await replyMsg(msg.message_id, '营运诊断暂时不可用，请稍后重试。');
        return { ok: true, eventType, mode: 'ops_diagnosis_failed' };
      }
    }

    const { processMessage } = await import('./message-pipeline.js');
    const slowTimer = setTimeout(() => {
      if (msg?.message_id) {
        replyMsg(msg.message_id, '✅ 已收到消息，正在处理中，请稍等约10~30秒。').catch(() => {});
      }
    }, 8000);
    let result;
    try {
      result = await processMessage({
        text,
        messageId: msg?.message_id,
        chatId: msg?.chat_id,
        userId: openId,
        chatType,
        hasImage: msgType === 'image',
        eventId: eventId || undefined,
        replyMsg: msg?.message_id ? (t) => replyMsg(msg.message_id, t) : undefined,
      });
    } finally {
      clearTimeout(slowTimer);
    }
    return { ok: true, eventType, ...result };
  }
  return { toast: { type: 'info', content: 'ok' } };
}

// ── Card Action Callback Handler ──

export async function handleCardAction(body) {
  const norm = body?.open_id !== undefined || body?.action !== undefined ? body : normalizeCardActionBody(body);
  const openId = String(norm?.open_id || '').trim();
  const action = norm?.action || {};
  const callbackMessageId = String(
    norm?.open_message_id ||
    norm?.openMessageId ||
    body?.open_message_id ||
    body?.openMessageId ||
    body?.event?.context?.open_message_id ||
    body?.event?.open_message_id ||
    ''
  ).trim();
  let value = {};
  try {
    value =
      typeof action.value === 'string'
        ? JSON.parse(action.value || '{}')
        : action.value && typeof action.value === 'object'
          ? action.value
          : {};
  } catch (e) {
    value = {};
  }
  const formValue =
    action?.form_value && typeof action.form_value === 'object'
      ? action.form_value
      : {};
  const pickFormText = (keys = []) => {
    for (const k of keys) {
      const v = formValue?.[k];
      if (typeof v === 'string' && v.trim()) return v.trim();
      if (v && typeof v === 'object') {
        const t = String(v.value || v.text || v.content || '').trim();
        if (t) return t;
      }
    }
    return '';
  };
  const actionName = String(action?.name || action?.tag || '').trim();
  let actionType = String(value.action || '').trim();
  let taskId = String(value.taskId || '').trim();
  if (!actionType && actionName) actionType = actionName;
  if (!taskId) {
    taskId = String(value.task_id || value.id || action?.task_id || '').trim();
  }
  if (!taskId && callbackMessageId) {
    const hit = await query(
      `SELECT task_id
       FROM master_tasks
       WHERE source = 'proactive_llm'
         AND EXISTS (
           SELECT 1 FROM jsonb_array_elements_text(COALESCE(feishu_msg_ids, '[]'::jsonb)) AS mid
           WHERE mid = $1
         )
       ORDER BY created_at DESC
       LIMIT 1`,
      [callbackMessageId]
    ).catch(() => ({ rows: [] }));
    taskId = String(hit.rows?.[0]?.task_id || '').trim();
  }
  logger.info(
    {
      openId,
      actionType,
      taskId,
      actionName,
      callbackMessageId,
      actionHasValue: !!action?.value,
      formKeys: Object.keys(formValue || {})
    },
    'Card action callback'
  );

  const blockObserverTaskActions = openId ? await feishuOpenIdIsMajixianPmObserver(openId) : false;
  const observerTaskToast = {
    toast: {
      type: 'info',
      content: '观察账号仅同步接收绩效与说明；任务操作与整改回复请使用黎永荣主账号。'
    }
  };

  if (actionType === 'ack_anomaly' && taskId) {
    if (blockObserverTaskActions) return observerTaskToast;
    try {
      const { transitionTask } = await import('./task-state-machine.js');
      await transitionTask(taskId, 'viewed');
      return { toast: { type: 'success', content: '已标记为已查看' } };
    } catch(e) { return { toast: { type: 'error', content: '操作失败: ' + (e?.message || '') } }; }
  }
  if (actionType === 'reply_anomaly' && taskId) {
    if (blockObserverTaskActions) return observerTaskToast;
    setImmediate(async () => {
      try {
        await query(
          `INSERT INTO feishu_pending_replies (open_id, task_id, created_at)
           VALUES ($1, $2, NOW())
           ON CONFLICT (open_id) DO UPDATE SET task_id = EXCLUDED.task_id, created_at = NOW()`,
          [openId, taskId]
        ).catch(() => {});
        if (openId) {
          await sendText(
            openId,
            `📝 任务 ${taskId}\n请直接在此对话中回复您的整改措施，系统将自动记录到该任务。\n\n示例回复：「已安排……，预计……完成」`,
            'open_id'
          ).catch(() => {});
        }
      } catch (e) {
        logger.warn({ err: e?.message, taskId, openId }, 'reply_anomaly background failed');
      }
    });
    return { toast: { type: 'info', content: '请在对话中回复整改措施，系统将自动关联到该任务' } };
  }
  if (actionType === 'start_task' && taskId) {
    if (blockObserverTaskActions) return observerTaskToast;
    try {
      const { transitionTask } = await import('./task-state-machine.js');
      await transitionTask(taskId, 'in_progress');
      return { toast: { type: 'success', content: '任务已开始处理' } };
    } catch(e) { return { toast: { type: 'error', content: '操作失败: ' + (e?.message || '') } }; }
  }
  if (actionType === 'view_task' && taskId) {
    try {
      const { getTask } = await import('./task-state-machine.js');
      const task = await getTask(taskId);
      if (task && openId) await sendText(openId, `📋 任务详情\n标题: ${task.title || '-'}\n状态: ${task.status || '-'}\n创建: ${task.created_at || '-'}\n详情: ${(task.description || '').slice(0, 500)}`);
      return { toast: { type: 'success', content: '已发送任务详情' } };
    } catch(e) { return { toast: { type: 'error', content: '查询失败' } }; }
  }

  if (actionType === 'approve_task' && taskId) {
    if (blockObserverTaskActions) return observerTaskToast;
    try {
      const { transitionTask } = await import('./task-state-machine.js');
      await transitionTask(taskId, 'pending_dispatch');
      return { toast: { type: 'success', content: '已同意执行' } };
    } catch (e) { return { toast: { type: 'error', content: '审批失败: ' + (e?.message || '') } }; }
  }

  if (actionType === 'reject_task' && taskId) {
    if (blockObserverTaskActions) return observerTaskToast;
    try {
      const { transitionTask } = await import('./task-state-machine.js');
      await transitionTask(taskId, 'rejected');
      return { toast: { type: 'info', content: '已驳回' } };
    } catch (e) { return { toast: { type: 'error', content: '审批失败: ' + (e?.message || '') } }; }
  }

  if (!actionType && taskId) {
    const taskHit = await query(
      `SELECT 1 FROM master_tasks WHERE task_id = $1 AND source = 'proactive_llm' LIMIT 1`,
      [taskId]
    ).catch(() => ({ rows: [] }));
    if (taskHit.rows?.length) {
      if (openId) {
        await upsertPendingPllmDecision(openId, taskId, 'choose');
        sendText(
          openId,
          `这张 PLLM 旧卡的飞书回调没有带上"执行/不适合"的按钮字段，系统已识别任务：${taskId}。\n\n请直接回复：\n执行：写明执行计划（何时/谁负责/怎么做/目标）\n或\n不适合：写明原因\n\n我会自动记录。`,
          'open_id'
        ).catch(() => {});
      }
      return { toast: { type: 'info', content: '旧卡缺少按钮字段，请按聊天提示回复' } };
    }
  }

  if ((actionType === 'pllm_execute' || actionType === 'pllm_not_suitable') && taskId) {
    try {
      const u = await lookupUser(openId);
      const role = String(u?.role || '').trim();
      if (!u || !['admin', 'hq_manager'].includes(role)) {
        return { toast: { type: 'error', content: '仅管理员或总部营运可操作 PLLM 决策' } };
      }
      const op = String(u.username || '').trim() || 'unknown';
      const { applyPllmDecision } = await import('./proactive-v2/pllm-workflow.js');
      const decision = actionType === 'pllm_execute' ? 'execute' : 'not_suitable';
      const executePlan = pickFormText(['pllm_execute_plan', 'execute_plan', 'plan', 'plan_text']);
      const rejectReason = pickFormText(['pllm_not_suitable_reason', 'not_suitable_reason', 'reason', 'reason_text']);
      const planText = decision === 'execute' ? executePlan : rejectReason;
      if (!planText) {
        await upsertPendingPllmDecision(openId, taskId, decision);
        if (openId) {
          const ask =
            decision === 'execute'
              ? `请回复该任务执行计划（何时/谁负责/怎么做/目标），我会自动记录。\n任务ID：${taskId}`
              : `请回复该任务不适合原因（门店定位/执行可行性/时机），我会自动记录。\n任务ID：${taskId}`;
          sendText(openId, ask, 'open_id').catch(() => {});
        }
        return {
          toast: {
            type: 'info',
            content: decision === 'execute' ? '请在聊天中补充执行计划' : '请在聊天中补充不适合原因'
          }
        };
      }
      const r = await applyPllmDecision(taskId, decision, op, planText);
      if (!r?.ok) {
        return { toast: { type: 'error', content: String(r?.error || '操作失败') } };
      }
      if (openId) {
        const ack =
          decision === 'execute'
            ? `✅ PLLM任务 ${taskId} 已登记为「执行」。\n执行计划：${planText}`
            : `✅ PLLM任务 ${taskId} 已登记为「不适合」。\n原因：${planText}`;
        sendText(openId, ack.slice(0, 1600), 'open_id').catch(() => {});
      }
      return {
        toast: {
          type: 'success',
          content: decision === 'execute' ? '已提交执行计划，进入跟踪模式' : '已提交不适合原因并结案'
        }
      };
    } catch (e) {
      return { toast: { type: 'error', content: 'PLLM 操作失败: ' + (e?.message || '') } };
    }
  }

  // ── SOP 考试：提交答案 ──
  if (actionType === 'sop_submit_exam') {
    try {
      const { scoreExam, saveTrainingRecord, pickExamQuestions } = await import('./sop-engine.js');
      const { buildExamResultCard } = await import('./exam-engine.js');
      const answers = value.answers || [];
      const questions = value.questions || [];
      const sopId = value.sopId || '';
      const sopTitle = value.sopTitle || '';
      const attempts = parseInt(value.attempts || '1');
      const employeeName = value.employeeName || openId;
      const store = value.store || '';
      const problemDesc = value.problemDesc || '';

      if (!answers.length || !questions.length) {
        return { toast: { type: 'error', content: '答题数据异常，请重新考试' } };
      }

      const result = scoreExam(questions, answers);
      const passed = result.score >= 95;

      const record = await saveTrainingRecord({
        employeeId: openId,
        employeeName,
        store,
        trainingType: 'sop_remediation',
        sopId,
        sopTitle,
        triggerSource: 'table_visit',
        problemDescription: problemDesc,
        examScore: result.score,
        totalQuestions: result.total,
        correctCount: result.correct,
        attempts,
        passed,
        deadline: new Date().toISOString().slice(0, 10)
      });

      if (openId) {
        const card = buildExamResultCard(
          { title: sopTitle, problem: problemDesc },
          result,
          record?.id || ''
        );
        await sendCard(openId, card, 'open_id').catch(() => {});
      }

      return { toast: { type: passed ? 'success' : 'warning', content: passed ? '✅ 考试通过！' : `得分 ${result.score}分，未达 95 分` } };
    } catch (e) {
      logger.warn({ err: e?.message }, 'sop_submit_exam handler failed');
      return { toast: { type: 'error', content: '考试提交失败: ' + (e?.message || '') } };
    }
  }

  // ── SOP 考试：重考 ──
  if (actionType === 'sop_retry_exam') {
    try {
      const { buildSopExamCard } = await import('./exam-engine.js');
      const { pickExamQuestions } = await import('./sop-engine.js');
      const sopId = value.sopId || '';
      const sopTitle = value.sopTitle || '';
      const employeeName = value.employeeName || openId;
      const store = value.store || '';
      const problemDesc = value.problemDesc || '';
      const attempts = parseInt(value.attempts || '1') + 1;

      const questions = await pickExamQuestions(sopId, 20);
      if (!questions?.length) {
        return { toast: { type: 'error', content: '该 SOP 暂无可用的考试题目，请联系管理员' } };
      }

      if (openId) {
        const card = buildSopExamCard(
          { id: sopId, title: sopTitle, problem: problemDesc, store },
          questions,
          { openId, employeeName, store, attempts, problemDesc }
        );
        await sendCard(openId, card, 'open_id').catch(() => {});
      }

      return { toast: { type: 'info', content: '新题目已发送，请查看飞书消息' } };
    } catch (e) {
      logger.warn({ err: e?.message }, 'sop_retry_exam handler failed');
      return { toast: { type: 'error', content: '重考失败: ' + (e?.message || '') } };
    }
  }
  const hasPllmForm = pllmFormKeys.some(k => Object.prototype.hasOwnProperty.call(formValue, k));
  if ((taskId || callbackMessageId || hasPllmForm) && openId) {
    try {
      let matchedTaskId = String(taskId || '').trim();
      if (!matchedTaskId && callbackMessageId) {
        const msgHit = await query(
          `SELECT task_id FROM master_tasks WHERE source = 'proactive_llm' AND status NOT IN ('closed','settled') AND feishu_msg_ids @> $1::jsonb LIMIT 1`,
          [JSON.stringify([callbackMessageId])]
        ).catch(() => ({ rows: [] }));
        if (msgHit.rows?.[0]) matchedTaskId = String(msgHit.rows[0].task_id || '').trim();
      }
      if (matchedTaskId) {
        await upsertPendingPllmDecision(openId, matchedTaskId, 'choose');
        sendText(
          openId,
          `PLLM 任务 ${matchedTaskId}：按钮类型未识别，请直接回复：\n执行：写明执行计划\n或\n不适合：写明原因`,
          'open_id'
        ).catch(() => {});
        return { toast: { type: 'info', content: '请在聊天中回复「执行」或「不适合」' } };
      }
      if (hasPllmForm) {
        sendText(
          openId,
          `检测到 PLLM 任务卡片，请回复「执行：计划」或「不适合：原因」，并注明任务ID（如有）。`,
          'open_id'
        ).catch(() => {});
        return { toast: { type: 'info', content: '请在聊天中回复 PLLM 决策与理由' } };
      }
    } catch (_) { /* fallback silent */ }
  }

  return { toast: { type: 'info', content: '已收到' } };
}

// ── Task Reply Review ──

async function ensureReviewColumns() {
  const cols = [
    `ALTER TABLE master_tasks ADD COLUMN IF NOT EXISTS review_count INTEGER DEFAULT 0`,
    `ALTER TABLE master_tasks ADD COLUMN IF NOT EXISTS review_passed BOOLEAN`,
    `ALTER TABLE master_tasks ADD COLUMN IF NOT EXISTS review_feedback TEXT`,
    `ALTER TABLE master_tasks ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMPTZ`,
    `ALTER TABLE master_tasks ADD COLUMN IF NOT EXISTS response_text TEXT`,
    `ALTER TABLE master_tasks ADD COLUMN IF NOT EXISTS response_at TIMESTAMPTZ`
  ];
  for (const sql of cols) {
    await query(sql).catch(() => {});
  }
}

export async function reviewTaskReply(taskId, responseText, hasImages, replyMessageId, imageKey = null) {
  await ensureReviewColumns();
  try {
    const tr = await query(
      `SELECT task_id, title, detail, source, category, store, assignee_username, assignee_role,
              COALESCE(review_count, 0) AS review_count
       FROM master_tasks WHERE task_id = $1 LIMIT 1`,
      [taskId]
    );
    if (!tr.rows.length) return;
    const task = tr.rows[0];
    const rc = parseInt(task.review_count || 0);

    const t = String(responseText || '').trim();
    const MIN_TEXT = 20;
    const src = String(task.source || '').trim();
    const isScheduledOrInspectionOrBi =
      src === 'scheduled_inspection' || src === 'random_inspection' || src === 'bi_anomaly';
    const isPlaceholder = /^(无|没有|ok|好的|收到|test|测试|了解|\d+)$/i.test(t);
    const textMeetsMin = t.length >= MIN_TEXT;

    let passed = false;
    let reason = '';
    let feedback = '';

    let imageRelevant = true;
    let imageVisionReason = '';
    if (hasImages) {
      const ik = String(imageKey || '').trim();
      if (!replyMessageId || !ik) {
        imageRelevant = false;
        imageVisionReason = '无法校验图片，请使用飞书直接发送图片消息重新提交';
      } else {
        const dataUrl = await downloadImage(replyMessageId, ik);
        if (!dataUrl) {
          imageRelevant = false;
          imageVisionReason = '图片下载失败，请重新上传';
        } else {
          const vPrompt =
            `你是餐饮连锁总部质检。判断图片是否可作为本条任务的「有效佐证」，且**与任务所问/所述问题一致**。

任务标题：${String(task.title || '未知').slice(0, 200)}
任务类型：${String(task.source || '未知')}
任务详情：${String(task.detail || '').slice(0, 500)}
门店：${String(task.store || '')}

判定（须同时满足才算 relevant=true）：
1) 图片内容与**本任务主题相关**（能体现任务要求的整改/异常/巡检/试味/出品等要点之一），而非泛泛门店照但与任务无关。
2) 属于餐饮门店现场合理范畴（菜品、档口、后厨、餐桌、试味、清洁、设备、食材、环境、工装等）。
3) 明显无关（表情包、纯风景、网图、无关商品、非本场景截图等）→ relevant=false。
4) 不确定或与任务要点对不上 → relevant=false（偏严格）。

只输出 JSON：
{"relevant":true或false,"reason":"一句话中文说明"}`;
          const { callVisionLLM } = await import('./llm-provider.js');
          const vr = await callVisionLLM(dataUrl, vPrompt);
          if (!vr.ok || !String(vr.content || '').trim()) {
            imageRelevant = false;
            imageVisionReason = '图片识别失败或服务不可用，请稍后重试';
          } else {
            const vraw = String(vr.content || '').trim().replace(/^```json\s*/i, '').replace(/```$/i, '').trim();
            try {
              const vp = JSON.parse(vraw);
              imageRelevant = vp.relevant === true;
              imageVisionReason = String(vp.reason || '').trim();
            } catch {
              imageRelevant = false;
              imageVisionReason = '图片审核结果无法解析，请重新上传清晰现场照片';
            }
          }
        }
      }
    }

    if (hasImages && !imageRelevant) {
      passed = false;
      reason = imageVisionReason || '附图未通过与任务内容一致性的校验';
      feedback = `请上传**与本任务问题直接相关**的现场照片，并配合至少 ${MIN_TEXT} 字说明（须能看出在回应本任务要求）。`;
    } else if (isPlaceholder) {
      passed = false;
      reason = '回复仅为占位词，无实质内容';
      feedback = `请针对本任务写明情况与处理（至少 ${MIN_TEXT} 字），内容与任务卡片要求一致。`;
    } else if (!textMeetsMin) {
      passed = false;
      reason = `回复未满 ${MIN_TEXT} 字`;
      feedback = `请至少回复 **${MIN_TEXT} 字**，且内容与任务卡片要求一致；有附图时附图也须与任务一致。`;
    } else {
      try {
        const imgNote = hasImages
          ? `\n（已附图：${imageRelevant ? '已与任务内容一致性校验通过' : '未通过'}${imageVisionReason ? ` — ${imageVisionReason}` : ''}）`
          : '\n（无图片）';
        const prompt = `任务标题：${task.title || '未知'}\n任务类型：${task.source || '未知'}\n门店：${String(task.store || '')}\n任务详情：${(task.detail || '').slice(0, 500)}\n\n负责人回复：\n${t.slice(0, 1000)}${imgNote}`;
        const { callLLM } = await import('./llm-provider.js');
        const r = await callLLM([
          {
            role: 'system',
            content: `你是餐饮连锁总部「任务回复」审核员（已通过字数≥${MIN_TEXT}、占位词与附图一致性等前置校验）。

【审核原则 — 按优先级】
1) **整改方案三要素（必检）**：回复必须包含以下三项，缺一即判不通过：
   - **具体措施**：明确说明已做或将做什么（禁止"已开会讨论""会跟进""关注中"等虚话）
   - **完成时间**：有明确时间节点（如"本周五前""5月10日前"），不允许"尽快""后续""适时"等模糊时间
   - **责任人**：指出谁负责执行（如"店长张三""出品经理李四"），不允许"团队""大家""相关人员"
2) **与任务卡片一致**：回复须针对本任务「标题+详情」中的核心要求（问题点、整改项），不得明显跑题。
3) **字数**：已由系统保证 ≥${MIN_TEXT} 字，你无需再以「字数不足」为由判不通过。
4) **通过标准**：三要素齐全 + 内容与任务方向一致 = passed=true。
   **不通过标准**：三要素缺任一项、或内容明显敷衍/跑题/套话 = passed=false。
5) 不通过时 reason 一句话点明缺什么，feedback 简短说明需补哪一点（禁止长篇模板）。

只输出 JSON，勿 markdown：
{"passed":true或false,"reason":"...","feedback":"..."}`
          },
          { role: 'user', content: prompt }
        ], { temperature: 0.12, max_tokens: 520, purpose: 'routing' });
        const raw = String(r.content || '').trim().replace(/^```json\s*/i, '').replace(/```$/i, '').trim();
        const parsed = JSON.parse(raw);
        passed = !!parsed.passed;
        reason = parsed.reason || '';
        feedback = parsed.feedback || '';
      } catch (_) {
        passed = !hasImages && textMeetsMin;
        reason = passed
          ? '审核服务暂不可用，已按「无图且满字数」自动通过（请确保内容真实）'
          : '智能审核暂时不可用，请稍后重试';
        feedback = passed ? '' : '有附图时请稍后重试（须校验图片与任务一致性）；无附图时已满足字数可再试。';
      }
    }

    if (passed) {
      const cat = String(task.category || '').trim();
      const isFoodSafetyBi = src === 'bi_anomaly' && cat === 'food_safety';
      const isHrmsBoard = src === 'hrms_task_board';

      if (isHrmsBoard) {
        await query(
          `UPDATE master_tasks SET
             review_passed = true,
             review_feedback = $2,
             review_count = COALESCE(review_count, 0) + 1,
             updated_at = NOW()
           WHERE task_id = $1`,
          [taskId, `${reason ? reason + '；' : ''}门店整改方案已收到，Agent将持续跟踪出品问题趋势，改善后再提交管理员验收。`]
        ).catch(() => {});
        const { evaluateBoardTaskAfterStoreFeedback } = await import('./task-orchestrator.js');
        await evaluateBoardTaskAfterStoreFeedback(taskId).catch(() => {});
        if (replyMessageId) {
          replyMsg(replyMessageId, `✅ 已收到整改方案。Agent会继续跟踪桌访/差评/出品数据趋势，改善后提交管理员验收；未改善会继续催办。任务 ${taskId}`).catch(() => {});
        }
      } else if (isFoodSafetyBi) {
        await query(
          `UPDATE master_tasks SET
             review_passed = true, review_feedback = $2,
             review_count = COALESCE(review_count, 0) + 1,
             updated_at = NOW()
           WHERE task_id = $1`,
          [
            taskId,
            `${reason ? reason + '；' : ''}门店整改说明已通过，**待总部营运**在本任务线程回复「记录」并写明店长/出品/双方，或「不记录」结案（未判罚前不扣绩效分）。`
          ]
        ).catch(() => {});
        if (replyMessageId) {
          replyMsg(
            replyMessageId,
            `✅ 整改说明审核已通过。**食安任务尚未结案**：请 **总部营运** 回复「记录+责任岗位」或「不记录」完成判罚（任务 ${taskId}）。`
          ).catch(() => {});
        }
      } else {
        const { transitionTask: doTransition } = await import('./task-state-machine.js');
        const tr = await doTransition(taskId, 'resolved', 'review_handler', {
          reviewPassed: true,
          reviewFeedback: reason,
          reviewCount: true
        }).catch(() => null);
        if (!tr?.ok) {
          await query(
            `UPDATE master_tasks SET
               review_passed = true, review_feedback = $2,
               review_count = COALESCE(review_count, 0) + 1,
               status = 'resolved',
               resolved_at = COALESCE(resolved_at, NOW()),
               updated_at = NOW()
             WHERE task_id = $1`,
            [taskId, reason]
          ).catch(() => {});
        }
        setImmediate(() => {
          import('./proactive-v2/proactive-task-outcome-on-close.js')
            .then((m) => m.scheduleProactiveOutcomeOnClose(taskId, { newStatus: 'resolved' }))
            .catch(() => {});
        });
        if (replyMessageId) {
          replyMsg(replyMessageId, `✅ 审核通过，任务已闭环：${taskId}`).catch(() => {});
        }
      }
    } else {
      const { transitionTask: doTransition } = await import('./task-state-machine.js');
      const tr = await doTransition(taskId, 'pending_response', 'review_handler', {
        reviewPassed: false,
        reviewFeedback: reason,
        reviewCount: true
      }).catch(() => null);
      if (!tr?.ok) {
        await query(
          `UPDATE master_tasks SET
             review_passed = false, review_feedback = $2,
             review_count = COALESCE(review_count, 0) + 1,
             status = 'pending_response', updated_at = NOW()
           WHERE task_id = $1`,
          [taskId, reason]
        ).catch(() => {});
      }

      const rejectCard = {
        config: { wide_screen_mode: true },
        header: {
          title: { tag: 'plain_text', content: `⚠️ 回复审核未通过 · ${task.title || '任务'}` },
          template: 'orange'
        },
        elements: [
          {
            tag: 'div',
            text: {
              tag: 'lark_md',
              content: `**审核结论**：${reason}\n\n**需要补充的内容**：\n${feedback || '请提供更详细的处理记录，包括实际情况描述、处理措施、现场照片（如适用）。'}`
            }
          },
          ...(isScheduledOrInspectionOrBi
            ? [
                {
                  tag: 'div',
                  text: {
                    tag: 'lark_md',
                    content:
                      '**审核参照（定时/抽检/BI 等）**\n' +
                      `1. 不少于 **${MIN_TEXT}** 字且非占位敷衍\n` +
                      '2. 内容须**针对本任务标题与详情中的核心要求**\n' +
                      '3. **不强制**「时间+地点+事件」格式；能看出在落实本任务关切且方向一致即可'
                  }
                }
              ]
            : []),
          { tag: 'hr' },
          {
            tag: 'div',
            text: {
              tag: 'lark_md',
              content: `📝 请**直接回复本消息**提交完整记录\n⚠️ 任务：${task.task_id}\n🏪 门店：${task.store}`
            }
          },
          {
            tag: 'note',
            elements: [{ tag: 'plain_text', content: `审核次数：${rc + 1}/3 · 三次不合格将备案工作态度（不计绩效分）` }]
          }
        ]
      };

      if (replyMessageId) {
        const t2 = await getTenantToken();
        if (t2) {
          await axios.post(
            BASE + '/im/v1/messages/' + replyMessageId + '/reply',
            { msg_type: 'interactive', content: JSON.stringify(rejectCard) },
            { headers: { Authorization: 'Bearer ' + t2 }, timeout: 10000 }
          ).catch(() => {
            replyMsg(replyMessageId, `⚠️ 回复审核未通过：${reason}\n\n${feedback || '请补充完整处理记录（实际情况+处理措施+照片）。'}\n审核次数：${rc + 1}/3，三次不合格将备案工作态度（不计绩效分）。`).catch(() => {});
          });
        }
      }

      if (rc + 1 >= 3) {
        try {
          const { transitionTask: doTransition } = await import('./task-state-machine.js');
          const tr = await doTransition(taskId, 'hr_filed', 'review_handler', {
            resolutionCode: 'hr_attitude_review_fail_3x'
          }).catch(() => null);
          if (!tr?.ok) {
            await query(
              `UPDATE master_tasks SET
                 hr_performance_recorded = true,
                 status = 'hr_filed',
                 resolution_code = 'hr_attitude_review_fail_3x',
                 updated_at = NOW()
               WHERE task_id = $1`,
              [taskId]
            );
          }
          logger.info({ taskId, store: task.store }, 'Task reply review: 3x fail → attitude record (no score deduction)');
          let monthlyAtt = 0;
          try {
            const { getShanghaiYmd } = await import('./report-delivery.js');
            const { getMonthlyAttitudeFilingCount } = await import('../utils/performance-filing-counts.js');
            const ymd = getShanghaiYmd();
            const au = String(task.assignee_username || '').trim();
            if (au) monthlyAtt = await getMonthlyAttitudeFilingCount(au, ymd);
          } catch (_e) {
            monthlyAtt = 0;
          }
          const ym = new Date().toLocaleString('en-CA', { timeZone: 'Asia/Shanghai' }).slice(0, 7);
          const au0 = String(task.assignee_username || '').trim();
          let dispName = au0;
          if (au0) {
            try {
              const nr = await query(
                `SELECT COALESCE(NULLIF(TRIM(name),''), username) AS disp FROM feishu_users
                 WHERE lower(trim(username)) = lower(trim($1)) AND coalesce(registered, false) = true LIMIT 1`,
                [au0]
              );
              dispName = String(nr.rows?.[0]?.disp || au0).trim() || au0;
            } catch {
              dispName = au0;
            }
          }
          const whoShort = au0 ? `${dispName}（${au0}）` : '责任人未填';
          const attitudeBody = [
            `【工作态度备案】统计主体：${whoShort}；**仅统计该账号本人**本月（${ym}）工作态度备案累计 **${monthlyAtt}** 次（全门店不同任务去重，与月度评级同一口径；不含他人、不含执行力）。`,
            '因任务回复连续三次审核不合格，已记入工作态度备案（影响月度工作态度评级；不计周度绩效分/agent_scores）。',
            `门店：${task.store}`,
            `任务ID：${taskId}`,
            `标题：${String(task.title || '').slice(0, 280)}`
          ].join('\n');
          await sendCompanyNoticeToAssignees(task, attitudeBody, {
            title: `工作态度备案｜${whoShort} · ${ym} · 本人累计${monthlyAtt}次`,
            type: 'attitude_filing'
          }).catch((e) => logger.warn({ err: e?.message, taskId }, 'review penalty: company notice failed'));
        } catch (e) {
          logger.error({ taskId, store: task.store, err: e?.message }, 'Task reply review: 3x fail → DB update FAILED');
        }
      }
    }

    logger.info({ taskId, passed, reason, reviewCount: rc + 1 }, 'Task reply review complete');
  } catch (e) {
    logger.warn({ err: e?.message, taskId }, 'reviewTaskReply failed');
  }
}
