import axios from 'axios';
import crypto from 'crypto';
import dns from 'node:dns';
import { query } from '../utils/db.js';
import { anomalyRuleLabelZh } from '../utils/anomaly-labels.js';
import { logger } from '../utils/logger.js';
import { isMarketingPlanningIntent } from '../utils/marketing-intent.js';
import { isExternalEnabled } from '../utils/safety.js';
import { callLLM, callVisionLLM } from './llm-provider.js';

/** ECS 偶发 resolv 异常导致 ENOTFOUND：可用 FEISHU_DNS_SERVERS=223.5.5.5,114.114.114.114 */
const _dnsList = String(process.env.FEISHU_DNS_SERVERS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const _appEnv = String(process.env.APP_ENV || process.env.NODE_ENV || '').trim().toLowerCase();
const _useProdDnsDefault =
  _appEnv === 'production' ||
  _appEnv === 'prod' ||
  String(process.env.CONFIRM_PRODUCTION || '').trim().toLowerCase() === 'true';
if (_dnsList.length) {
  try {
    dns.setServers(_dnsList);
    logger.info({ servers: _dnsList }, 'Feishu: custom DNS resolvers');
  } catch (e) {
    logger.warn({ err: e?.message }, 'Feishu: dns.setServers failed');
  }
} else if (_useProdDnsDefault) {
  try {
    dns.setServers(['223.5.5.5', '114.114.114.114', '8.8.8.8']);
    logger.info('Feishu: production default public DNS (223.5.5.5 / 114.114.114.114 / 8.8.8.8)');
  } catch (e) {
    logger.warn({ err: e?.message }, 'Feishu: default dns.setServers failed');
  }
}
if (String(process.env.FEISHU_IPV4_FIRST || '').toLowerCase() === 'true') {
  try {
    dns.setDefaultResultOrder('ipv4first');
    logger.info('Feishu: DNS result order ipv4first');
  } catch (e) {
    logger.warn({ err: e?.message }, 'Feishu: setDefaultResultOrder failed');
  }
}

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

let BASE = process.env.FEISHU_OPEN_BASE || 'https://open.feishu.cn/open-apis';
const BASE_CANDIDATES = [
  BASE,
  'https://open.larksuite.com/open-apis',
  'https://open.feishu.cn/open-apis'
].filter((v, i, arr) => v && arr.indexOf(v) === i);
const APP_ID = process.env.FEISHU_APP_ID || process.env.LARK_APP_ID || '';
const APP_SECRET = process.env.FEISHU_APP_SECRET || process.env.LARK_APP_SECRET || '';
let _token = '', _tokenExp = 0;

let _warnedExternalOff = false;
export async function getTenantToken() {
  if (!isExternalEnabled()) {
    if (!_warnedExternalOff) {
      logger.error('getTenantToken: ENABLE_EXTERNAL!=true，飞书外呼已关闭，无法回复消息');
      _warnedExternalOff = true;
    }
    return '';
  }
  if (_token && Date.now() < _tokenExp) return _token;
  if (!APP_ID || !APP_SECRET) return '';
  for (const candidate of BASE_CANDIDATES) {
    try {
      const r = await axios.post(
        candidate + '/auth/v3/tenant_access_token/internal',
        { app_id: APP_ID, app_secret: APP_SECRET },
        { timeout: 10000 }
      );
      _token = r.data?.tenant_access_token || '';
      _tokenExp = Date.now() + (r.data?.expire || 7000) * 1000;
      BASE = candidate;
      if (_token) {
        logger.info({ base: candidate }, 'tenant token acquired');
      }
      return _token;
    } catch (e) {
      logger.warn({ err: e?.message, base: candidate }, 'tenant token attempt failed');
    }
  }
  logger.error('token fail');
  return '';
}

export async function sendText(receiveId, text, idType = 'open_id') {
  if (!isExternalEnabled()) return { ok: false, error: 'external_disabled' };
  const t = await getTenantToken(); if (!t) return { ok: false, error: 'no_token' };
  try {
    const r = await axios.post(BASE + '/im/v1/messages', { receive_id: receiveId, msg_type: 'text', content: JSON.stringify({ text }) }, { headers: { Authorization: 'Bearer ' + t }, params: { receive_id_type: idType }, timeout: 10000 });
    return { ok: r.data?.code === 0, data: r.data };
  } catch (e) { return { ok: false, error: e?.message }; }
}

export async function sendCard(receiveId, card, idType = 'open_id') {
  if (!isExternalEnabled()) return { ok: false, error: 'external_disabled' };
  const t = await getTenantToken(); if (!t) return { ok: false, error: 'no_token' };
  try {
    const r = await axios.post(BASE + '/im/v1/messages', { receive_id: receiveId, msg_type: 'interactive', content: JSON.stringify(card) }, { headers: { Authorization: 'Bearer ' + t }, params: { receive_id_type: idType }, timeout: 10000 });
    return { ok: r.data?.code === 0, data: r.data };
  } catch (e) { return { ok: false, error: e?.message }; }
}

export async function sendGroup(chatId, text) { return sendText(chatId, text, 'chat_id'); }

/**
 * 绩效/扣分「公司通知」：解析任务责任人飞书 open_id（username 优先，其次门店+角色精确/模糊）
 */
export async function lookupAssigneeOpenIds(task) {
  const un = String(task?.assignee_username || '').trim();
  if (un) {
    const r = await query(
      `SELECT open_id FROM feishu_users
       WHERE lower(username) = lower($1) AND registered = true AND open_id IS NOT NULL AND trim(open_id) <> ''
       LIMIT 3`,
      [un]
    );
    if (r.rows?.length) return r.rows.map((x) => x.open_id).filter(Boolean);
  }
  const role = String(task?.assignee_role || 'store_manager').trim();
  const st = String(task?.store || '').trim();
  const r2 = await query(
    `SELECT open_id FROM feishu_users
     WHERE store = $1 AND role = $2 AND registered = true AND open_id IS NOT NULL AND trim(open_id) <> ''
     LIMIT 5`,
    [st, role]
  );
  if (r2.rows?.length) return r2.rows.map((x) => x.open_id).filter(Boolean);
  const sk = st.trim().toLowerCase().replace(/\s+/g, '');
  if (!sk) return [];
  const r3 = await query(
    `SELECT open_id FROM feishu_users
     WHERE registered = true AND open_id IS NOT NULL AND trim(open_id) <> '' AND role = $2
       AND lower(regexp_replace(coalesce(store,''), '\\s+', '', 'g')) LIKE $1
     LIMIT 5`,
    [`%${sk}%`, role]
  );
  return (r3.rows || []).map((x) => x.open_id).filter(Boolean);
}

/**
 * 向责任人发送【公司通知】：飞书交互卡片 + 文本各一条（卡片失败则仅文本），便于会话列表与富文本同时可见。
 */
export async function sendCompanyNoticeToAssignees(task, body) {
  const text = String(body || '').trim();
  if (!text) return { targets: 0, sentCards: 0, sentTexts: 0 };
  const oids = await lookupAssigneeOpenIds(task);
  let sentCards = 0;
  let sentTexts = 0;
  const plain = text.length > 3500 ? `${text.slice(0, 3497)}…` : text;
  const card = {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: '【公司通知】' },
      template: 'blue'
    },
    elements: [
      {
        tag: 'div',
        text: { tag: 'plain_text', content: plain }
      },
      {
        tag: 'note',
        elements: [{ tag: 'plain_text', content: '请妥善留存；如有异议请联系营运或 HR。' }]
      }
    ]
  };
  for (const oid of oids) {
    const cardRes = await sendCard(oid, card, 'open_id');
    if (cardRes?.ok) sentCards += 1;
    const txtRes = await sendText(oid, `【公司通知】\n${text}`, 'open_id');
    if (txtRes?.ok) sentTexts += 1;
  }
  if (!oids.length) {
    logger.warn({ taskId: task?.task_id, store: task?.store }, 'company notice: no assignee open_id');
  } else {
    logger.info(
      { taskId: task?.task_id, targets: oids.length, sentCards, sentTexts },
      'company notice to assignee'
    );
  }
  return { targets: oids.length, sentCards, sentTexts };
}

export async function replyMsg(messageId, text) {
  if (!isExternalEnabled()) return { ok: false, reason: 'external_disabled' };
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
  if (!isExternalEnabled()) return null;
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
    if (!r.ok) {
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

// ── Card Template Builders ──
export function buildAnomalyCard(store, anomalyKey, severity, detail, taskId) {
  const typeZh = anomalyRuleLabelZh(anomalyKey);
  const sevColor = severity === 'high' ? 'red' : severity === 'medium' ? 'orange' : 'yellow';
  const sevEmoji = severity === 'high' ? '🚨' : '⚠️';
  const taskHint = taskId
    ? `\n\n📌 **任务ID**：\`${taskId}\`\n✅ 与定时任务、随机抽检相同：请**引用/回复本条卡片消息**（或在新消息里带上任务ID）直接发送整改措施，系统将自动记录并审核。`
    : '';
  // 食安类需展示「来源表 + 日期 + 原文摘录」，字数显著多于其它异常
  const detailLimit = anomalyKey === 'food_safety' ? 3800 : 900;
  const elements = [
    { tag: 'div', text: { tag: 'lark_md', content: `**门店**: ${store}\n**类型**: ${typeZh}\n**严重度**: ${sevEmoji} ${severity}` } },
    { tag: 'div', text: { tag: 'lark_md', content: `**详情**: ${(detail || '').slice(0, detailLimit)}${taskHint}` } },
    { tag: 'hr' },
    { tag: 'note', elements: [{ tag: 'plain_text', content: '⏰ 催办规则：下发后每间隔1小时提醒，共3次；仍未有效闭环将提交HR记入绩效' }] }
  ];
  if (taskId) {
    elements.splice(3, 0, {
      tag: 'action',
      actions: [
        { tag: 'button', text: { tag: 'plain_text', content: '✅ 已查看' }, type: 'primary', value: JSON.stringify({ action: 'ack_anomaly', taskId }) }
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

export function buildApprovalTaskCard(task) {
  const taskId = task?.task_id || task?.taskId || '';
  const store = task?.store || '-';
  const title = task?.title || '待审批任务';
  const source = task?.source_data && typeof task.source_data === 'object' ? task.source_data : {};
  const aiSuggestion = source?.ai_suggestion || source?.suggestion || task?.detail || '';
  const riskDescription = source?.risk_description || source?.risk || '';

  const elements = [
    { tag: 'div', text: { tag: 'lark_md', content: `**门店**：${store}\n**任务**：${title}\n**任务ID**：${String(taskId).slice(0, 8)}` } },
    { tag: 'div', text: { tag: 'lark_md', content: `**AI建议**：${String(aiSuggestion).slice(0, 800)}` } },
    ...(riskDescription
      ? [{ tag: 'div', text: { tag: 'lark_md', content: `**风险说明**：${String(riskDescription).slice(0, 800)}` } }]
      : []),
    { tag: 'hr' },
    {
      tag: 'action',
      actions: [
        { tag: 'button', text: { tag: 'plain_text', content: '✅ 同意执行' }, type: 'primary', value: JSON.stringify({ action: 'approve_task', taskId }) },
        { tag: 'button', text: { tag: 'plain_text', content: '❌ 驳回' }, type: 'default', value: JSON.stringify({ action: 'reject_task', taskId }) }
      ]
    }
  ];

  return { header: { title: { tag: 'plain_text', content: '🧾 需要审批' }, template: 'red' }, elements };
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

/** 周度/月度绩效摘要卡片（仅 anomaly_rollups_v2；管理汇总勿用「—」加粗，飞书 lark_md 会误渲染成「一」） */
export function buildPerformanceSummaryCard({
  title,
  store,
  periodLabel,
  totalScore,
  role,
  detailMd,
  managementDigest = false
}) {
  const scoreBlock = managementDigest
    ? `**口径说明**：下列为各岗位 **上周异常触发汇总后的周度扣分得分**（与人力资源「执行力/态度/能力」月度模型分无关，避免混看）。`
    : `**周度异常汇总得分**：**${totalScore}** 分（满分 100，按异常规则扣减后）`;
  return {
    header: { title: { tag: 'plain_text', content: title || '📊 绩效周度汇总' }, template: 'blue' },
    elements: [
      { tag: 'div', text: { tag: 'lark_md', content: `**门店**：${store || '-'}\n**周期**：${periodLabel}\n**岗位**：${role || '-'}\n${scoreBlock}` } },
      { tag: 'hr' },
      { tag: 'div', text: { tag: 'lark_md', content: detailMd || '（无扣分项）' } },
      {
        tag: 'note',
        elements: [
          {
            tag: 'plain_text',
            content: '数据来自上周各门店异常触发记录汇总；月度执行力/态度/能力请在人力资源档案中查看（每月 1 日更新）。'
          }
        ]
      }
    ]
  };
}

export async function pushRhythmReport(content) {
  const chatId = process.env.FEISHU_HQ_OPS_CHAT_ID;
  if (chatId) return sendGroup(chatId, content);
  return { ok: false, reason: 'no_hq_chat_id' };
}

const _processedEvents = new Set();

function shouldTriggerOpsDiagnosis(text) {
  const t = String(text || '').trim().toLowerCase();
  if (!t) return false;
  // 「生意下滑 + 要营销活动计划」曾被误判：只命中「生意下滑」而走空壳营运诊断，绕过真实营业数据
  if (isMarketingPlanningIntent(text)) return false;
  const keywords = [
    '生意下滑',
    '经营下滑',
    '运营诊断',
    '营运诊断',
    '门店诊断',
    '达成率',
    '业绩下滑',
    '问题在哪',
    '怎么提升'
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

/** 飞书卡片 2.0 回调：open_id / action 在 event 下；独立 /card 路由可能是扁平结构 */
export function normalizeCardActionBody(raw) {
  if (!raw || typeof raw !== 'object') return { open_id: '', action: {} };
  if (raw.schema === '2.0' && raw.event && typeof raw.event === 'object') {
    const ev = raw.event;
    const op = ev.operator && typeof ev.operator === 'object' ? ev.operator : {};
    return {
      open_id: String(op.open_id || '').trim(),
      action: ev.action && typeof ev.action === 'object' ? ev.action : {}
    };
  }
  return {
    open_id: String(raw.open_id || '').trim(),
    action: raw.action && typeof raw.action === 'object' ? raw.action : {}
  };
}

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
      return { toast: { type: 'error', content: '解密失败，请稍后重试' } };
    }
  }
  if (raw?.type === 'url_verification' || raw?.challenge) return { challenge: raw.challenge };
  // 兼容两种飞书事件体：
  // 1) v2: { header: { event_id, event_type }, event: {...} }
  // 2) callback: { type: 'event_callback', uuid, event: { type, ... } }
  const hdr = raw?.header || raw?.event?.header || {};
  const evt = raw?.event || {};
  const eventId = String(hdr?.event_id || raw?.uuid || '').trim();
  const eventType = String(hdr?.event_type || evt?.type || '').trim();
  if (!eventType) {
    const topKeys = raw && typeof raw === 'object' ? Object.keys(raw).slice(0, 20) : [];
    const evtKeys = evt && typeof evt === 'object' ? Object.keys(evt).slice(0, 20) : [];
    logger.warn({ topKeys, evtKeys, hasEncrypt: !!raw?.encrypt, hasChallenge: !!raw?.challenge }, 'Feishu webhook unknown event schema');
  }

  // 卡片交互必须返回飞书认可的 toast/card 结构；且不可套用 im 消息的 dedup 体（会导致 200672）
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
    // msgType already computed above
    let text = '', imageKey = '';
    const rawContent = msg?.content;
    try {
      if (rawContent && typeof rawContent === 'object') {
        // Some Feishu payloads may already be parsed into an object.
        text = rawContent?.text ?? '';
        imageKey = rawContent?.image_key ?? rawContent?.imageKey ?? '';
      } else if (typeof rawContent === 'string') {
        const c = JSON.parse(rawContent || '{}');
        text = c?.text ?? '';
        imageKey = c?.image_key ?? c?.imageKey ?? '';
      } else if (rawContent != null) {
        // Fallback: treat as plain string.
        text = String(rawContent);
      }
    } catch (e) {
      // Fallback: if content isn't valid JSON but is a string, treat it as plain text.
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

    // ── 直接回复：把“对任务卡片的回复”落到 master_tasks（随机抽检） ──
    // 依赖 Feishu 回传的 reply_to_message_id / root_message_id 等字段；若不存在则跳过
    try {
      // 飞书在“卡片消息回复”场景下，不同字段有时指向不同层级（卡片/父消息/引用消息）。
      // 因此不能只取第一个非空值，而要对所有候选 message_id 逐个精确匹配 feishu_msg_ids。
      const candidateMessageIds = [
        // 兜底：有些飞书回复结构里，用户回复本身的 message_id 可能就是可匹配的那条
        msg?.message_id,
        // ── 飞书标准字段（最重要，必须在最前）──
        msg?.root_id,           // 飞书 p2p 回复时标准字段：线程根消息 ID
        msg?.parent_id,         // 飞书 p2p 回复时标准字段：直接父消息 ID
        // 其余兜底字段（v1/v2 事件格式差异）
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

      // 1) 线程/引用 任一 message_id 落在 feishu_msg_ids 内即视为对该任务卡的回复（含群聊；用 jsonb 展开避免 @> 类型不兼容）
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

      // 2) 消息正文含任务ID（ANO-/SCHED-）：与「引用回复卡片」等价，避免部分客户端 thread 字段缺失
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
                 OR (COALESCE(fu.store,'') <> '' AND fu.store = mt.store)
                 OR lower(COALESCE(mt.assignee_username,'')) = lower(COALESCE(fu.username,''))
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

      // 3) 兜底：bi_anomaly 的“引用 message_id”有时不会回传
      //    此时按「发消息的人=任务 assignee，且最近 24h 内仍 pending_response/pending_review 的最新任务」匹配落库
      if (!taskId && hasParsedText && openId) {
        const hit = await query(
          `SELECT mt.task_id
           FROM master_tasks mt
           JOIN feishu_users fu ON fu.open_id = $1 AND fu.registered = TRUE
           WHERE mt.source = 'bi_anomaly'
             AND mt.status IN ('pending_response','pending_review')
             AND mt.store = fu.store
             AND lower(COALESCE(mt.assignee_username,'')) = lower(COALESCE(fu.username,''))
             AND COALESCE(mt.dispatched_at, mt.created_at) >= NOW() - INTERVAL '24 hours'
           ORDER BY COALESCE(mt.dispatched_at, mt.created_at) DESC
           LIMIT 1`,
          [openId]
        ).catch(() => ({ rows: [] }));

        const found = hit?.rows?.[0]?.task_id || null;
        if (found) {
          taskId = found;
          matchedCardMessageId = null;
        }
      }

      // 若无 thread 匹配且无任务ID正文，则走普通消息 pipeline，避免误记为任务。

      if (taskId) {
          const responseText = hasParsedText ? parsedText : null;
          const responseImages = msgType === 'image' && imageKey
            ? JSON.stringify([{ imageKey, messageId: msg?.message_id || '' }])
            : null;

          await query(
            `UPDATE master_tasks
             SET status = 'pending_review',
                 responded_at = NOW(),
                 updated_at = NOW(),
                 response_text = COALESCE($2, response_text),
                 response_images = COALESCE($3::jsonb, response_images)
             WHERE task_id = $1`,
            [taskId, responseText, responseImages]
          ).catch(() => {});

          // 兼容前端/审计链路：直接回复也要落到 agent_messages，供任务卡片与历史展示使用
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

          // 用户侧仍需要“我已收到”的即时反馈；避免用户误以为系统未处理。
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

          // 非阻塞：异步进行回复质量审核
          const hasTaskImage = !!String(imageKey || '').trim();
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

      // 未精确匹配到任务卡 → 不拦截；私聊再走 pipeline，群聊仅结束（避免群消息触发全员问答）
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

    // ── 飞书「营销文案」固定表单：先于 pipeline / 通用识图，避免误入 marketing_planner（📊 营销活动计划）──
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

    // Keyword-triggered operations diagnosis:
    // keeps existing flow intact for all non-matching messages.
    if (shouldTriggerOpsDiagnosis(text) && msg?.message_id) {
      try {
        const dateStr = parseDateInText(text);
        const { getAIOperationsReport } = await import('./ai-operations.js');
        // Role/store isolation: store manager & production manager can only view own store.
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
    const result = await processMessage({
      text,
      messageId: msg?.message_id,
      chatId: msg?.chat_id,
      userId: openId,
      chatType,
      hasImage: msgType === 'image',
      eventId: eventId || undefined
    });
    return { ok: true, eventType, ...result };
  }
  return { toast: { type: 'info', content: 'ok' } };
}

// ── Card Action Callback Handler ──
export async function handleCardAction(body) {
  const norm = body?.open_id !== undefined || body?.action !== undefined ? body : normalizeCardActionBody(body);
  const openId = String(norm?.open_id || '').trim();
  const action = norm?.action || {};
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
    // 立即响应避免超时；后台存储待回复状态并发送提示
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
    try {
      const { transitionTask } = await import('./task-state-machine.js');
      await transitionTask(taskId, 'pending_dispatch');
      return { toast: { type: 'success', content: '已同意执行' } };
    } catch (e) { return { toast: { type: 'error', content: '审批失败: ' + (e?.message || '') } }; }
  }

  if (actionType === 'reject_task' && taskId) {
    try {
      const { transitionTask } = await import('./task-state-machine.js');
      await transitionTask(taskId, 'rejected');
      return { toast: { type: 'info', content: '已驳回' } };
    } catch (e) { return { toast: { type: 'error', content: '审批失败: ' + (e?.message || '') } }; }
  }
  return { toast: { type: 'info', content: '已收到' } };
}

export function getFeishuStatus() { return { configured: !!(APP_ID && APP_SECRET), hasToken: !!_token, tokenExpires: _tokenExp ? new Date(_tokenExp).toISOString() : null }; }

// ── 任务回复质量审核 ──
// 当负责人回复任务卡后，由此函数对回复内容（文字+图片）进行 AI 审核
// 审核不通过→飞书反馈，3次不合格→记录HR绩效

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

/**
 * 对任务卡回复内容进行质量审核（异步，不阻塞 webhook 响应）
 * @param {string} taskId
 * @param {string|null} responseText  - 回复文字
 * @param {boolean} hasImages         - 是否附带图片
 * @param {string|null} replyMessageId - 用于 replyMsg 线程回复
 * @param {string|null} imageKey - 飞书图片 resource key（有图时必传，用于下载并做现场相关性校验）
 */
export async function reviewTaskReply(taskId, responseText, hasImages, replyMessageId, imageKey = null) {
  await ensureReviewColumns();
  try {
    // 获取任务详情
    const tr = await query(
      `SELECT task_id, title, detail, source, store, assignee_username, assignee_role,
              COALESCE(review_count, 0) AS review_count
       FROM master_tasks WHERE task_id = $1 LIMIT 1`,
      [taskId]
    );
    if (!tr.rows.length) return;
    const task = tr.rows[0];
    const rc = parseInt(task.review_count || 0);

    const t = String(responseText || '').trim();
    const isTooShort = t.length < 15 && !hasImages;
    const isPlaceholder = /^(无|没有|ok|好的|收到|test|测试|了解|\d+)$/i.test(t);

    let passed = false;
    let reason = '';
    let feedback = '';

    /** 附图须与餐饮门店任务场景相关，禁止用无关图「凑数」通过 */
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
            `你是餐饮连锁总部质检。判断下面图片是否可作为本条门店任务的「有效现场佐证」。

任务标题：${String(task.title || '未知').slice(0, 200)}
任务类型：${String(task.source || '未知')}
任务详情：${String(task.detail || '').slice(0, 400)}
门店：${String(task.store || '')}

判定规则：
- 与餐饮门店现场强相关（菜品、档口、后厨、餐桌、试味、清洁、厨房设备、食材、价签、门店环境、员工工装等）→ relevant=true
- 明显无关（家用呼吸机/医疗设备、纯风景、表情包、与餐饮无关的商品特写、电脑/手机截图、汽车、宠物等）→ relevant=false
- 不确定时偏严格，判 relevant=false

只输出 JSON，不要其他文字：
{"relevant":true或false,"reason":"一句话中文说明"}`;
          const vr = await callVisionLLM(dataUrl, vPrompt);
          if (!vr.ok || !String(vr.content || '').trim()) {
            imageRelevant = false;
            imageVisionReason = '图片识别失败或服务不可用，请稍后重试';
          } else {
            const vraw = String(vr.content || '').trim().replace(/^```json\s*/i, '').replace(/```$/i, '').trim();
            try {
              const vp = JSON.parse(vraw);
              // 必须显式 relevant:true，缺字段或模糊输出一律不通过（防止模型省略字段时误放行）
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
      reason = imageVisionReason || '附图与任务现场不相关，不能作为有效凭证';
      feedback =
        '请上传与任务相关的门店现场照片（如试味、档口出品、后厨、餐品、环境整改前后等）。勿使用无关图片或网图凑数。';
    } else if (isTooShort || isPlaceholder) {
      // 规则直接判定：明显不合格
      passed = false;
      reason = isPlaceholder ? '回复仅为占位词，无实质内容' : '回复文字过短（<15字）且无图片';
      feedback = `回复需包含：①实际情况描述（至少20字）②处理措施③现场问题须附**与任务相关的**照片。`;
    } else {
      const trivialText = t.length < 12;
      if (hasImages && imageRelevant && trivialText) {
        passed = true;
        reason = imageVisionReason ? `附图已通过现场校验：${imageVisionReason}` : '附图已通过现场相关性校验';
      } else {
        // LLM 语义审核（已带图且非琐碎文字时，仍审文字是否具体）
        try {
          const imgNote = hasImages
            ? `\n（已附图，且图片已通过「门店现场相关性」校验${imageVisionReason ? `：${imageVisionReason}` : ''}）`
            : '\n（无图片）';
          const prompt = `任务标题：${task.title || '未知'}\n任务类型：${task.source || '未知'}\n任务详情：${(task.detail || '').slice(0, 200)}\n\n负责人回复：\n${t.slice(0, 800)}${imgNote}`;
          const r = await callLLM([
            { role: 'system', content: `你是HRMS任务审核员，对门店负责人的任务卡回复进行质量审核。

合格标准（必须全部满足）：
1. 内容具体，描述了实际情况（非泛泛而谈）
2. 有具体处理措施或行动结果
3. 若是巡检/抽检/试味/异常类任务，须说明发现与处理结果
4. 若仅声称「有图」但文字明显敷衍、与任务无关，判不通过
5. 无附图时：字数须充足（≥20字）且满足 1–3

输出 JSON（不要输出其他内容）：
{"passed": true或false, "reason": "一句话说明", "feedback": "给用户的改进建议（不合格时才填，合格时空字符串）"}` },
            { role: 'user', content: prompt }
          ], { temperature: 0.1, max_tokens: 200, purpose: 'routing' });
          const raw = String(r.content || '').trim().replace(/^```json\s*/i, '').replace(/```$/i, '').trim();
          const parsed = JSON.parse(raw);
          passed = !!parsed.passed;
          reason = parsed.reason || '';
          feedback = parsed.feedback || '';
        } catch (_) {
          passed = false;
          reason = '智能审核暂时不可用，请稍后重新提交';
          feedback = '若多次失败请联系总部信息部；请勿使用无关图片代替文字说明。';
        }
      }
    }

    // 更新审核结果到 master_tasks
    if (passed) {
      // 审核通过须闭环：此前错误地仍为 pending_review，导致晨报/待办里永远「待处理」
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
      if (replyMessageId) {
        replyMsg(replyMessageId, `✅ 审核通过，任务已闭环：${taskId}`).catch(() => {});
      }
      // 合格：不发额外消息，之前的"已收到"已足够
    } else {
      await query(
        `UPDATE master_tasks SET
           review_passed = false, review_feedback = $2,
           review_count = COALESCE(review_count, 0) + 1,
           status = 'pending_response', updated_at = NOW()
         WHERE task_id = $1`,
        [taskId, reason]
      ).catch(() => {});

      // 发送不合格反馈给责任人
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
        // 用飞书卡片回复在同一对话线程中
        const t2 = await getTenantToken();
        if (t2) {
          await axios.post(
            BASE + '/im/v1/messages/' + replyMessageId + '/reply',
            { msg_type: 'interactive', content: JSON.stringify(rejectCard) },
            { headers: { Authorization: 'Bearer ' + t2 }, timeout: 10000 }
          ).catch(() => {
            // 降级：文本回复
            replyMsg(replyMessageId, `⚠️ 回复审核未通过：${reason}\n\n${feedback || '请补充完整处理记录（实际情况+处理措施+照片）。'}\n审核次数：${rc + 1}/3，三次不合格将备案工作态度（不计绩效分）。`).catch(() => {});
          });
        }
      }

      // 若已满3次不合格 → 工作态度备案（与任务卡审核说明一致：不计 agent_scores 绩效分）
      if (rc + 1 >= 3) {
        try {
          await query(
            `UPDATE master_tasks SET
               hr_performance_recorded = true,
               resolution_code = 'hr_attitude_review_fail_3x',
               updated_at = NOW()
             WHERE task_id = $1`,
            [taskId]
          ).catch(() => {});
          logger.info({ taskId, store: task.store }, 'Task reply review: 3x fail → attitude record (no score deduction)');
          await sendCompanyNoticeToAssignees(
            task,
            `因任务回复连续三次审核不合格，已记入工作态度备案（影响月度工作态度评级；不计周度绩效分/agent_scores）。\n门店：${task.store}\n任务ID：${taskId}\n标题：${String(task.title || '').slice(0, 280)}`
          ).catch((e) => logger.warn({ err: e?.message, taskId }, 'review penalty: company notice failed'));
        } catch (_) {}
      }
    }

    logger.info({ taskId, passed, reason, reviewCount: rc + 1 }, 'Task reply review complete');
  } catch (e) {
    logger.warn({ err: e?.message, taskId }, 'reviewTaskReply failed');
  }
}
