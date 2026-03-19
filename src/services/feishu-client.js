import axios from 'axios';
import crypto from 'crypto';
import { query } from '../utils/db.js';
import { logger } from '../utils/logger.js';

// ── 飞书加密消息解密（从 V1 移植） ──
const FEISHU_ENCRYPT_KEY = process.env.FEISHU_ENCRYPT_KEY || '';
function decryptFeishuEncryptPayload(encryptValue) {
  if (!FEISHU_ENCRYPT_KEY) {
    logger.warn('FEISHU_ENCRYPT_KEY not set, encrypted messages cannot be decrypted');
    throw new Error('FEISHU_ENCRYPT_KEY not configured');
  }
  const cipherBuf = Buffer.from(String(encryptValue || ''), 'base64');
  if (!cipherBuf.length) throw new Error('invalid_encrypt_payload');
  let keyBuf = Buffer.from(String(FEISHU_ENCRYPT_KEY || ''), 'base64');
  if (keyBuf.length !== 32) {
    keyBuf = Buffer.from(String(FEISHU_ENCRYPT_KEY || ''), 'utf8');
    if (keyBuf.length < 32) keyBuf = Buffer.concat([keyBuf, Buffer.alloc(32 - keyBuf.length)]);
    if (keyBuf.length > 32) keyBuf = keyBuf.subarray(0, 32);
  }
  const iv = keyBuf.subarray(0, 16);
  const decipher = crypto.createDecipheriv('aes-256-cbc', keyBuf, iv);
  let decrypted = decipher.update(cipherBuf, undefined, 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

const BASE = 'https://open.feishu.cn/open-apis';
const APP_ID = process.env.FEISHU_APP_ID || process.env.LARK_APP_ID || '';
const APP_SECRET = process.env.FEISHU_APP_SECRET || process.env.LARK_APP_SECRET || '';
let _token = '', _tokenExp = 0;

export async function getTenantToken() {
  if (_token && Date.now() < _tokenExp) return _token;
  if (!APP_ID || !APP_SECRET) return '';
  try {
    const r = await axios.post(BASE + '/auth/v3/tenant_access_token/internal', { app_id: APP_ID, app_secret: APP_SECRET }, { timeout: 10000 });
    _token = r.data?.tenant_access_token || ''; _tokenExp = Date.now() + (r.data?.expire || 7000) * 1000;
    return _token;
  } catch (e) { logger.error({ err: e?.message }, 'token fail'); return ''; }
}

export async function sendText(receiveId, text, idType = 'open_id') {
  const t = await getTenantToken(); if (!t) return { ok: false, error: 'no_token' };
  try {
    const r = await axios.post(BASE + '/im/v1/messages', { receive_id: receiveId, msg_type: 'text', content: JSON.stringify({ text }) }, { headers: { Authorization: 'Bearer ' + t }, params: { receive_id_type: idType }, timeout: 10000 });
    return { ok: r.data?.code === 0, data: r.data };
  } catch (e) { return { ok: false, error: e?.message }; }
}

export async function sendCard(receiveId, card, idType = 'open_id') {
  const t = await getTenantToken(); if (!t) return { ok: false, error: 'no_token' };
  try {
    const r = await axios.post(BASE + '/im/v1/messages', { receive_id: receiveId, msg_type: 'interactive', content: JSON.stringify(card) }, { headers: { Authorization: 'Bearer ' + t }, params: { receive_id_type: idType }, timeout: 10000 });
    return { ok: r.data?.code === 0, data: r.data };
  } catch (e) { return { ok: false, error: e?.message }; }
}

export async function sendGroup(chatId, text) { return sendText(chatId, text, 'chat_id'); }

export async function replyMsg(messageId, text) {
  const t = await getTenantToken(); if (!t) {
    logger.error({ messageId }, 'replyMsg: no tenant token');
    return { ok: false, reason: 'no_token' };
  }
  try {
    const r = await axios.post(BASE + '/im/v1/messages/' + messageId + '/reply', { msg_type: 'text', content: JSON.stringify({ text }) }, { headers: { Authorization: 'Bearer ' + t }, timeout: 10000 });
    logger.info({ messageId, code: r.data?.code, msg: r.data?.msg }, 'replyMsg response');
    return { ok: r.data?.code === 0 };
  } catch (e) { 
    logger.error({ messageId, err: e?.message }, 'replyMsg failed');
    return { ok: false, error: e?.message }; 
  }
}

export async function downloadImage(messageId, imageKey) {
  const t = await getTenantToken(); if (!t) return null;
  try {
    const r = await axios.get(BASE + '/im/v1/messages/' + messageId + '/resources/' + imageKey, { headers: { Authorization: 'Bearer ' + t }, params: { type: 'image' }, responseType: 'arraybuffer', timeout: 30000 });
    return 'data:image/jpeg;base64,' + Buffer.from(r.data).toString('base64');
  } catch (e) { return null; }
}

export async function lookupUser(openId) {
  try { const r = await query('SELECT * FROM feishu_users WHERE open_id = $1 LIMIT 1', [openId]); return r.rows?.[0] || null; } catch (e) { return null; }
}

/** 从 HRMS 员工信息(hrms_state.employees) 按 username 取姓名，优先于 feishu_users.name */
export async function getHrmsEmployeeName(username) {
  if (!username || !String(username).trim()) return null;
  try {
    const r = await query(
      `SELECT data FROM hrms_state WHERE key = $1 LIMIT 1`,
      ['default']
    );
    const data = r.rows?.[0]?.data;
    if (!data || typeof data !== 'object') return null;
    const employees = Array.isArray(data.employees) ? data.employees : [];
    const emp = employees.find(
      e => String(e?.username || '').trim().toLowerCase() === String(username).trim().toLowerCase()
    );
    const name = emp?.name != null ? String(emp.name).trim() : null;
    return name || null;
  } catch (e) {
    logger.warn({ err: e?.message, username }, 'getHrmsEmployeeName failed (hrms_state may not exist)');
    return null;
  }
}

/** 通过飞书通讯录 API 获取用户姓名（open_id → name），DB 无 name 时用此兜底 */
export async function getFeishuUserName(openId) {
  if (!openId) return null;
  const t = await getTenantToken();
  if (!t) return null;
  try {
    const r = await axios.get(
      BASE + '/contact/v3/users/' + encodeURIComponent(openId),
      { headers: { Authorization: 'Bearer ' + t }, params: { user_id_type: 'open_id' }, timeout: 5000 }
    );
    const data = r.data?.data?.user;
    if (data && (data.name || data.en_name)) return (data.name || data.en_name || '').trim() || null;
    return null;
  } catch (e) {
    logger.warn({ err: e?.message, openId }, 'getFeishuUserName failed');
    return null;
  }
}

/** 从 HRMS 员工信息获取完整员工记录（含 status） */
export async function getHrmsEmployeeByUsername(username) {
  if (!username || !String(username).trim()) return null;
  try {
    const r = await query(
      `SELECT data FROM hrms_state WHERE key = $1 LIMIT 1`,
      ['default']
    );
    const data = r.rows?.[0]?.data;
    if (!data || typeof data !== 'object') return null;
    const employees = Array.isArray(data.employees) ? data.employees : [];
    const emp = employees.find(
      e => String(e?.username || '').trim().toLowerCase() === String(username).trim().toLowerCase()
    );
    return emp || null;
  } catch (e) {
    logger.warn({ err: e?.message, username }, 'getHrmsEmployeeByUsername failed (hrms_state may not exist)');
    return null;
  }
}

/** 检查 HRMS 员工是否在职（排除 离职/inactive） */
export function isHrmsEmployeeActive(emp) {
  if (!emp) return false;
  const status = String(emp.status || '').trim().toLowerCase();
  const inactiveList = ['离职', 'inactive', 'resigned', 'deleted', 'terminated', '已离职', '已删除', '禁用', '停用'];
  return !inactiveList.includes(status);
}

/** 通过 Feishu open_id 查找已绑定的 HRMS 员工信息（含状态校验） */
export async function getHrmsEmployeeByFeishuOpenId(openId) {
  if (!openId) return null;
  try {
    // 1. 先查 feishu_users 看是否已绑定 username
    const fu = await query('SELECT username FROM feishu_users WHERE open_id = $1 AND registered = TRUE LIMIT 1', [openId]);
    if (fu.rows?.[0]?.username) {
      // 已绑定，直接查 HRMS
      return await getHrmsEmployeeByUsername(fu.rows[0].username);
    }
    // 2. 未绑定：尝试通过飞书用户名匹配 HRMS（模糊匹配）
    const feishuName = await getFeishuUserName(openId);
    if (feishuName) {
      const empByName = await findHrmsEmployeeByName(feishuName);
      if (empByName) return empByName;
    }
    // 3. 仍找不到，返回 null（需要绑定）
    return null;
  } catch (e) {
    logger.warn({ err: e?.message, openId }, 'getHrmsEmployeeByFeishuOpenId failed');
    return null;
  }
}

/** 在 HRMS 中通过姓名模糊匹配员工（用于未绑定时的兜底） */
async function findHrmsEmployeeByName(name) {
  if (!name) return null;
  try {
    const r = await query(`SELECT data FROM hrms_state WHERE key = $1 LIMIT 1`, ['default']);
    const data = r.rows?.[0]?.data;
    if (!data || typeof data !== 'object') return null;
    const employees = Array.isArray(data.employees) ? data.employees : [];
    // 模糊匹配：姓名包含或被包含
    const nameTrim = name.trim().toLowerCase();
    const emp = employees.find(e => {
      const empName = String(e?.name || '').trim().toLowerCase();
      return empName && (empName.includes(nameTrim) || nameTrim.includes(empName));
    });
    return emp || null;
  } catch (e) {
    logger.warn({ err: e?.message, name }, 'findHrmsEmployeeByName failed');
    return null;
  }
}

export async function lookupUserByUsername(username) {
  try { const r = await query('SELECT * FROM feishu_users WHERE lower(username) = lower($1) AND registered = TRUE ORDER BY updated_at DESC LIMIT 1', [username]); return r.rows?.[0] || null; } catch (e) { return null; }
}

export async function pushAnomalyAlert(store, anomalyKey, severity, detail, taskId) {
  const emoji = severity === 'high' ? '🚨' : '⚠️';
  const users = await query('SELECT open_id FROM feishu_users WHERE store = $1 AND role IN (\'store_manager\',\'admin\',\'hq_manager\') AND registered = TRUE', [store]);
  const results = [];
  for (const u of (users.rows || [])) {
    const card = buildAnomalyCard(store, anomalyKey, severity, detail, taskId);
    let r = await sendCard(u.open_id, card);
    if (!r.ok) r = await sendText(u.open_id, emoji + ' 【异常告警】' + store + '\n类型: ' + anomalyKey + '\n严重度: ' + severity + '\n详情: ' + detail);
    results.push(r);
  }
  return { ok: true, sent: results.length };
}

// ── Card Template Builders ──
export function buildAnomalyCard(store, anomalyKey, severity, detail, taskId) {
  const sevColor = severity === 'high' ? 'red' : severity === 'medium' ? 'orange' : 'yellow';
  const sevEmoji = severity === 'high' ? '🚨' : '⚠️';
  const elements = [
    { tag: 'div', text: { tag: 'lark_md', content: `**门店**: ${store}\n**类型**: ${anomalyKey}\n**严重度**: ${sevEmoji} ${severity}` } },
    { tag: 'div', text: { tag: 'lark_md', content: `**详情**: ${(detail || '').slice(0, 500)}` } },
    { tag: 'hr' },
    { tag: 'note', elements: [{ tag: 'plain_text', content: '⏰ 请在1小时内查看并回复整改措施' }] }
  ];
  if (taskId) {
    elements.splice(3, 0, {
      tag: 'action', actions: [
        { tag: 'button', text: { tag: 'plain_text', content: '✅ 已查看' }, type: 'primary', value: JSON.stringify({ action: 'ack_anomaly', taskId }) },
        { tag: 'button', text: { tag: 'plain_text', content: '📝 回复整改' }, type: 'default', value: JSON.stringify({ action: 'reply_anomaly', taskId }) }
      ]
    });
  }
  return { header: { title: { tag: 'plain_text', content: `${sevEmoji} 异常告警 — ${store}` }, template: sevColor }, elements };
}

export function buildTaskCard(title, detail, taskId, store) {
  return {
    header: { title: { tag: 'plain_text', content: '📋 ' + title }, template: 'blue' },
    elements: [
      { tag: 'div', text: { tag: 'lark_md', content: `**门店**: ${store || '-'}\n${detail || ''}` } },
      { tag: 'action', actions: [
        { tag: 'button', text: { tag: 'plain_text', content: '✅ 开始处理' }, type: 'primary', value: JSON.stringify({ action: 'start_task', taskId }) },
        { tag: 'button', text: { tag: 'plain_text', content: '🔍 查看详情' }, type: 'default', value: JSON.stringify({ action: 'view_task', taskId }) }
      ] },
      { tag: 'note', elements: [{ tag: 'plain_text', content: '任务ID: ' + (taskId || '-').slice(0, 8) }] }
    ]
  };
}

export function buildRhythmReportCard(title, content, rhythmType) {
  return {
    header: { title: { tag: 'plain_text', content: title }, template: 'turquoise' },
    elements: [
      { tag: 'div', text: { tag: 'lark_md', content } },
      { tag: 'note', elements: [{ tag: 'plain_text', content: '🕐 ' + new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) + ' | ' + (rhythmType || '') }] }
    ]
  };
}

export async function pushRhythmReport(content) {
  const chatId = process.env.FEISHU_HQ_OPS_CHAT_ID;
  if (chatId) return sendGroup(chatId, content);
  return { ok: false, reason: 'no_hq_chat_id' };
}

const _processedEvents = new Set();
export async function handleWebhookEvent(body) {
  // 处理飞书加密请求（从 V1 移植）
  let raw = body;
  if (body?.encrypt) {
    try {
      const decrypted = decryptFeishuEncryptPayload(body.encrypt);
      raw = JSON.parse(decrypted);
      logger.info({ encrypt: true }, 'Feishu payload decrypted');
    } catch (e) {
      logger.error({ err: e?.message }, 'Feishu decrypt failed');
      return { error: 'decrypt_failed', message: e?.message };
    }
  }
  if (raw?.type === 'url_verification' || raw?.challenge) return { challenge: raw.challenge };
  const hdr = raw?.header || {}, evt = raw?.event || {};
  const eventId = String(hdr?.event_id || '').trim(), eventType = String(hdr?.event_type || '').trim();
  if (eventId && _processedEvents.has(eventId)) return { ok: true, dedup: true };
  if (eventId) { _processedEvents.add(eventId); setTimeout(() => _processedEvents.delete(eventId), 300000); }
  logger.info({ eventType, eventId }, 'Feishu webhook');
  if (eventType === 'im.message.receive_v1') {
    const msg = evt?.message || {}, sender = evt?.sender || {};
    const openId = String(sender?.sender_id?.open_id || '').trim();
    const chatType = String(msg?.chat_type || '').trim();
    if (!openId || (chatType !== 'private' && chatType !== 'p2p')) return { ok: true, skipped: true };
    const msgType = String(msg?.message_type || '');
    let text = '', imageKey = '';
    try { const c = JSON.parse(msg?.content || '{}'); text = c?.text || ''; imageKey = c?.image_key || ''; } catch(e) {}
    // Handle image messages — download and pass to Vision LLM
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
    const { processMessage } = await import('./message-pipeline.js');
    const result = await processMessage({ text, messageId: msg?.message_id, chatId: msg?.chat_id, userId: openId, chatType, hasImage: msgType === 'image' });
    return { ok: true, eventType, ...result };
  }
  return { ok: true, unhandled: eventType };
}

// ── Card Action Callback Handler ──
export async function handleCardAction(body) {
  const openId = String(body?.open_id || '').trim();
  const action = body?.action || {};
  let value = {};
  try { value = typeof action.value === 'string' ? JSON.parse(action.value) : (action.value || {}); } catch(e) {}
  const actionType = String(value.action || '').trim();
  const taskId = String(value.taskId || '').trim();
  logger.info({ openId, actionType, taskId }, 'Card action callback');

  if (actionType === 'ack_anomaly' && taskId) {
    try {
      const { transitionTask } = await import('./task-state-machine.js');
      await transitionTask(taskId, 'viewed');
      return { toast: { type: 'success', content: '已标记为已查看' } };
    } catch(e) { return { toast: { type: 'error', content: '操作失败: ' + (e?.message || '') } }; }
  }
  if (actionType === 'reply_anomaly' && taskId) {
    if (openId) await sendText(openId, '请直接回复整改措施,系统将自动记录。');
    return { toast: { type: 'info', content: '请在对话中回复整改措施' } };
  }
  if (actionType === 'start_task' && taskId) {
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
  return {};
}

export function getFeishuStatus() { return { configured: !!(APP_ID && APP_SECRET), hasToken: !!_token, tokenExpires: _tokenExp ? new Date(_tokenExp).toISOString() : null }; }
