import axios from 'axios';
import crypto from 'crypto';
import dns from 'node:dns';
import { query } from '../utils/db.js';
import { resolveAssigneeOpenIdsForTask } from '../utils/feishu-assignee-resolve.js';
import { anomalyRuleLabelZh } from '../utils/anomaly-labels.js';
import { logger } from '../utils/logger.js';
import { isMarketingPlanningIntent } from '../utils/marketing-intent.js';
import { isExternalEnabled } from '../utils/safety.js';
import { isMajixianPmObserverUsername } from '../utils/scoring-assignee.js';
import { callLLM, callVisionLLM } from './llm-provider.js';
import {
  isOpenIdCrossAppFeishuError,
  normalizeMobileForFeishuBatchGet
} from '../utils/feishu-open-id-helpers.js';

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

function feishuSkipOpenIdResolve() {
  const v = String(process.env.FEISHU_SKIP_OPEN_ID_RESOLVE || '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

/**
 * 用当前应用 tenant_access_token 调通讯录 batch_get_id，得到本应用可用的 open_id，并尽量回写 feishu_users。
 * 解决「DB 里存了另一套飞书应用写入的 open_id」导致的 IM 报错 open_id cross app（晨报/达成率等定时任务常见）。
 */
export async function resolveOpenIdForCurrentFeishuApp(row) {
  const username = String(row?.username || '').trim();
  let current = String(row?.open_id || '').trim();
  if (!username && !current) return current;

  let mobile = normalizeMobileForFeishuBatchGet(row?.mobile);
  if (!mobile && username) {
    try {
      const r = await query(
        `SELECT NULLIF(trim(mobile), '') AS m FROM feishu_users WHERE lower(trim(username)) = lower(trim($1)) LIMIT 1`,
        [username]
      );
      mobile = normalizeMobileForFeishuBatchGet(r.rows?.[0]?.m);
    } catch (e) {
      logger.warn({ err: e?.message, username }, 'resolveOpenId: feishu_users mobile lookup failed');
    }
  }
  let emails = [];
  if (!mobile && username) {
    try {
      const r = await query(
        `SELECT NULLIF(trim(phone), '') AS p FROM users WHERE lower(trim(username)) = lower(trim($1)) LIMIT 1`,
        [username]
      );
      mobile = normalizeMobileForFeishuBatchGet(r.rows?.[0]?.p);
    } catch (e) {
      logger.warn({ err: e?.message, username }, 'resolveOpenId: users.phone lookup failed');
    }
    if (!mobile) {
      try {
        const r2 = await query(
          `SELECT NULLIF(trim(lower(email)), '') AS e FROM users WHERE lower(trim(username)) = lower(trim($1)) LIMIT 1`,
          [username]
        );
        const e = r2.rows?.[0]?.e;
        if (e) emails.push(String(e).trim());
      } catch (e) {
        logger.warn({ err: e?.message, username }, 'resolveOpenId: users.email lookup failed');
      }
    }
  }

  const body = {};
  if (mobile) body.mobiles = [mobile];
  if (emails.length) body.emails = emails;
  if (!body.mobiles && !body.emails) {
    logger.warn({ username, hasOpenId: !!current }, 'resolveOpenId: no mobile/email to batch_get_id');
    return current;
  }

  const t = await getTenantToken();
  if (!t) return current;

  try {
    const r = await axios.post(
      `${BASE}/contact/v3/users/batch_get_id`,
      body,
      {
        headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json; charset=utf-8' },
        params: { user_id_type: 'open_id' },
        timeout: 15000
      }
    );
    if (r.data?.code !== 0) {
      logger.warn(
        { username, code: r.data?.code, msg: r.data?.msg },
        'resolveOpenId: batch_get_id failed'
      );
      return current;
    }
    const list = r.data?.data?.user_list;
    const item = Array.isArray(list) ? list[0] : null;
    const resolved = String(item?.user_id || '').trim();
    if (!resolved) {
      logger.warn({ username }, 'resolveOpenId: batch_get_id returned empty user_id');
      return current;
    }
    if (resolved === current) return current;

    if (username) {
      try {
        const conflict = await query(
          `SELECT username FROM feishu_users
           WHERE open_id = $1 AND lower(trim(username)) <> lower(trim($2)) LIMIT 1`,
          [resolved, username]
        );
        if (conflict.rows?.length) {
          logger.warn(
            { username, resolved, other: conflict.rows[0].username },
            'resolveOpenId: resolved open_id already bound to another row; skip DB update, still use for send'
          );
          return resolved;
        }
        await query(
          `UPDATE feishu_users SET open_id = $1, updated_at = NOW(), registered = TRUE
           WHERE lower(trim(username)) = lower(trim($2))`,
          [resolved, username]
        );
        logger.info({ username, from: current, to: resolved }, 'resolveOpenId: feishu_users.open_id updated for current app');
      } catch (e) {
        logger.warn({ err: e?.message, username }, 'resolveOpenId: feishu_users UPDATE failed (send may still succeed)');
      }
    }
    return resolved;
  } catch (e) {
    logger.warn({ err: e?.message, username }, 'resolveOpenId: batch_get_id exception');
    return current;
  }
}

/** IM 投递失败且为 cross-app 时，按 feishu_users.open_id 反查行并解析本应用 open_id */
export async function refreshFeishuUserOpenIdForImDelivery(staleOpenId) {
  const stale = String(staleOpenId || '').trim();
  if (!stale) return null;
  let r;
  try {
    r = await query(
      `SELECT username, open_id, mobile FROM feishu_users WHERE open_id = $1 LIMIT 1`,
      [stale]
    );
  } catch (e) {
    logger.warn({ err: e?.message }, 'refreshFeishuOpenId: lookup failed');
    return null;
  }
  const row = r.rows?.[0];
  if (!row?.username) {
    logger.warn({ stale }, 'refreshFeishuOpenId: no feishu_users row for this open_id');
    return null;
  }
  const resolved = await resolveOpenIdForCurrentFeishuApp(row);
  if (resolved && resolved !== stale) return resolved;

  // 降级：手机号/邮箱解析失败时，尝试同一 username 其他行（可能由正确应用写入）
  try {
    const altR = await query(
      `SELECT open_id FROM feishu_users
       WHERE lower(trim(username)) = lower(trim($1))
       AND open_id IS NOT NULL AND trim(open_id) <> ''
       AND open_id <> $2
       ORDER BY updated_at DESC NULLS LAST LIMIT 1`,
      [row.username, stale]
    );
    if (altR.rows?.[0]?.open_id) {
      const alt = String(altR.rows[0].open_id).trim();
      logger.warn(
        { username: row.username, from: stale, to: alt },
        'refreshFeishuOpenId: fallback to alternative row open_id'
      );
      return alt;
    }
  } catch (e) {
    logger.warn({ err: e?.message, username: row.username }, 'refreshFeishuOpenId: fallback lookup failed');
  }

  return null;
}

export async function sendText(receiveId, text, idType = 'open_id') {
  if (!isExternalEnabled()) return { ok: false, error: 'external_disabled' };
  const t = await getTenantToken(); if (!t) return { ok: false, error: 'no_token' };
  const post = async (rid) => {
    try {
      const r = await axios.post(BASE + '/im/v1/messages', { receive_id: rid, msg_type: 'text', content: JSON.stringify({ text }) }, { headers: { Authorization: 'Bearer ' + t }, params: { receive_id_type: idType }, timeout: 10000 });
      return { ok: r.data?.code === 0, data: r.data, error: r.data?.code === 0 ? undefined : String(r.data?.msg || '').trim() || `feishu_code_${r.data?.code ?? '?'}` };
    } catch (e) {
      return { ok: false, error: e?.response?.data?.msg || e?.message, data: e?.response?.data };
    }
  };
  let rid = String(receiveId || '').trim();
  let out = await post(rid);
  if (out.ok || idType !== 'open_id' || feishuSkipOpenIdResolve()) return out;
  const code = out.data?.code;
  if (isOpenIdCrossAppFeishuError(code, out.error)) {
    const fixed = await refreshFeishuUserOpenIdForImDelivery(rid);
    if (fixed && fixed !== rid) {
      logger.warn({ from: rid, to: fixed }, 'sendText: retry after cross-app open_id resolve');
      out = await post(fixed);
    }
  }
  return out;
}

export async function sendCard(receiveId, card, idType = 'open_id') {
  if (!isExternalEnabled()) return { ok: false, error: 'external_disabled' };
  const t = await getTenantToken(); if (!t) return { ok: false, error: 'no_token' };
  const post = async (rid) => {
    try {
      const r = await axios.post(BASE + '/im/v1/messages', { receive_id: rid, msg_type: 'interactive', content: JSON.stringify(card) }, { headers: { Authorization: 'Bearer ' + t }, params: { receive_id_type: idType }, timeout: 10000 });
      const ok = r.data?.code === 0;
      const msg = String(r.data?.msg || '').trim();
      return {
        ok,
        data: r.data,
        error: ok ? undefined : (msg || `feishu_code_${r.data?.code ?? '?'}`)
      };
    } catch (e) {
      const respData = e?.response?.data;
      if (respData) {
        logger.warn({ receiveId: rid, idType, feishuCode: respData.code, feishuMsg: respData.msg }, 'sendCard Feishu API error response');
      }
      return { ok: false, error: respData?.msg || e?.message, data: respData };
    }
  };
  let rid = String(receiveId || '').trim();
  let out = await post(rid);
  if (out.ok || idType !== 'open_id' || feishuSkipOpenIdResolve()) return out;
  const code = out.data?.code;
  if (isOpenIdCrossAppFeishuError(code, out.error)) {
    const fixed = await refreshFeishuUserOpenIdForImDelivery(rid);
    if (fixed && fixed !== rid) {
      logger.warn({ from: rid, to: fixed }, 'sendCard: retry after cross-app open_id resolve');
      out = await post(fixed);
    }
  }
  return out;
}

export async function sendGroup(chatId, text) { return sendText(chatId, text, 'chat_id'); }

/** 群聊发送交互卡片（receive_id 为群 chat_id，与 sendText(..., 'chat_id') 一致） */
export async function sendGroupCard(chatId, card) {
  return sendCard(chatId, card, 'chat_id');
}

/**
 * 绩效/扣分「公司通知」：与任务卡催办共用门店别名解析（洪潮/马己仙等）
 */
export async function lookupAssigneeOpenIds(task) {
  return resolveAssigneeOpenIdsForTask(task);
}

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

/** 与责任人卡片正文一致，仅标题改为「管理层抄送」（与产品约定：版式对齐责任人侧）。 */
function cloneMgmtCcInteractiveCard(baseCard, noticeTitle) {
  const card = JSON.parse(JSON.stringify(baseCard));
  card.header = card.header || {};
  card.header.title = { tag: 'plain_text', content: `【管理层抄送·${noticeTitle}】` };
  if (card.header.template == null) card.header.template = 'blue';
  return card;
}

/**
 * 向责任人发送【公司通知】：默认一条交互卡片（lark_md 正文）；卡片失败时降级为文本。
 * opts.card：可选，传入完整交互卡片（如工作态度备案专用卡片）；管理层抄送使用同结构卡片并加标题/门店/责任人前缀。
 */
export async function sendCompanyNoticeToAssignees(task, body, opts = {}) {
  const text = String(body || '').trim();
  if (!text) return { targets: 0, sentCards: 0, sentTexts: 0 };
  const sendToAssignee = opts.sendToAssignee !== false;
  const sendToManagement = opts.sendToManagement !== false;
  const oids = await lookupAssigneeOpenIds(task);

  // 同时写入 HRMS 档案公司通知表，使责任人在 HRMS 里也能看到
  const noticeTitle = opts.title || '公司通知';
  const noticeType = opts.type || 'task_attitude_notice';
  const assigneeUsernames = [];
  try {
    // 从 feishu_users 反查 open_id 对应的 username，以及 task.assignee_username
    const un = String(task?.assignee_username || '').trim();
    if (un) assigneeUsernames.push(un.toLowerCase());
    // 额外从 feishu_users 拿同 open_id 的 username
    for (const oid of oids) {
      const fu = await query(
        `SELECT username FROM feishu_users WHERE open_id = $1 AND registered = true LIMIT 1`,
        [oid]
      ).catch(() => ({ rows: [] }));
      const fu_un = String(fu.rows?.[0]?.username || '').trim().toLowerCase();
      if (fu_un && !assigneeUsernames.includes(fu_un)) assigneeUsernames.push(fu_un);
    }
    // 写 hrms_user_notifications（按 task_id+username 防止同一任务重复写入）
    const taskId = task?.task_id;
    for (const username of assigneeUsernames) {
      if (!username) continue;
      // 如果同任务同用户已有记录则跳过
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

  // 管理层抄送：admin + hq_manager 实时收到绩效/工作态度通知
  try {
    if (!sendToManagement) return { targets: sendToAssignee ? oids.length : 0, sentCards, sentTexts };
    const mgR = await query(
      `SELECT DISTINCT open_id, COALESCE(NULLIF(TRIM(name),''), username) AS name
       FROM feishu_users WHERE role IN ('admin','hq_manager') AND registered = true AND open_id IS NOT NULL AND open_id NOT LIKE '%probe%'`
    );
    const mgRows = mgR.rows || [];
    if (mgRows.length) {
      // 找责任人姓名（供抄送消息显示）
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
        if (oids.includes(mg.open_id)) continue; // 管理员本人已是责任人则跳过重复
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

/** 自助绑定飞书用户到HRMS员工账号 */
export async function bindFeishuUserToEmployee(openId, username) {
  if (!openId || !username) return { ok: false, error: 'missing_params' };
  try {
    const r = await query(
      `SELECT data FROM hrms_state WHERE key = $1 LIMIT 1`,
      ['default']
    );
    const data = r.rows?.[0]?.data;
    if (!data || typeof data !== 'object') return { ok: false, error: 'hrms_state_not_found' };
    const employees = Array.isArray(data.employees) ? data.employees : [];
    const emp = employees.find(
      e => String(e?.username || '').trim().toLowerCase() === String(username).trim().toLowerCase()
    );
    if (!emp) return { ok: false, error: 'employee_not_found' };
    
    const name = String(emp.name || '').trim();
    const store = String(emp.store || '').trim();
    const role = String(emp.role || '').trim();
    
    await query(
      `INSERT INTO feishu_users (open_id, username, name, store, role, registered, updated_at)
       VALUES ($1, $2, $3, $4, $5, TRUE, NOW())
       ON CONFLICT (open_id) DO UPDATE SET
         username = EXCLUDED.username,
         name = EXCLUDED.name,
         store = EXCLUDED.store,
         role = EXCLUDED.role,
         registered = TRUE,
         updated_at = NOW()`,
      [openId, username, name, store, role]
    );
    return { ok: true, user: emp };
  } catch (e) {
    logger.warn({ err: e?.message, openId, username }, 'bindFeishuUserToEmployee failed');
    return { ok: false, error: e?.message };
  }
}

export async function pushAnomalyAlert(store, anomalyKey, severity, detail, taskId) {
  const emoji = severity === 'high' ? '🚨' : '⚠️';
  const users = await query('SELECT open_id FROM feishu_users WHERE store = $1 AND role IN (\'store_manager\',\'admin\',\'hq_manager\') AND registered = TRUE AND open_id NOT LIKE \'%probe%\'', [store]);
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

/** 飞书 BI 扣分类卡片：岗位中文（与周度 periodic-scoring 一致） */
export function roleLabelZhForBiCard(role) {
  if (role === 'store_manager') return '店长';
  if (role === 'store_production_manager') return '出品经理';
  if (role === 'hq_manager') return '总部营运';
  if (role === 'admin') return '管理员';
  return String(role || '—');
}

/**
 * 周度 BI 异常扣分卡片；可选 taskId 时追加任务引用说明、「已查看」按钮与催办脚注（充值等即时触发与周度版式一致）。
 */
export function buildBiDeductionCard({
  store,
  assigneeName,
  role,
  period,
  reason,
  keyZh,
  severity,
  points,
  currentScore,
  remainingScore,
  taskId = null,
  dataSourceNote,
  bizDates
} = {}) {
  const roleLabel = roleLabelZhForBiCard(role);
  const color = severity === '高' ? 'red' : 'orange';
  const defaultWeeklyNote = '数据来源：异常触发汇总（anomaly_triggers）· 周度自动计算';
  const noteText = dataSourceNote != null ? dataSourceNote : defaultWeeklyNote;

  const bizDateLine = bizDates ? `**业务日期**：${bizDates}\n` : '';
  const content = `**备案类型**：BI异常情况扣分
**门店**：${store}
**岗位**：${roleLabel} · ${assigneeName}
**周期**：${period}
${bizDateLine}**异常类型**：${reason}（${keyZh}，严重度 ${severity}）

**分数情况**
• 现有分数：${currentScore} 分
• 本次扣分：${points} 分
• 剩余分数：${remainingScore} 分`;

  const elements = [{ tag: 'div', text: { tag: 'lark_md', content } }];

  if (taskId) {
    elements.push({ tag: 'hr' });
    elements.push({ tag: 'note', elements: [{ tag: 'plain_text', content: noteText }] });
  } else {
    elements.push({ tag: 'note', elements: [{ tag: 'plain_text', content: noteText }] });
  }

  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: '📋 BI异常情况扣分' },
      template: color
    },
    elements
  };
}

/**
 * 与 BI异常情况扣分 同版式：月度「异常未触发」加分备案（绿头）
 */
export function buildBiBonusCard({
  store,
  assigneeName,
  role,
  period,
  bonusLines,
  rollupScore,
  bonusPoints,
  recordedTotal,
  dataSourceNote
} = {}) {
  const roleLabel = roleLabelZhForBiCard(role);
  const noteText =
    dataSourceNote ||
    '数据来源：anomaly_triggers 上月命中情况 · anomaly_item_monthly_bonus · 每月10日00:30';

  const content = `**备案类型**：BI异常未触发加分
**门店**：${store}
**岗位**：${roleLabel} · ${assigneeName}
**周期**：${period}

**加分项（上月对应异常未触发）**
${bonusLines}

**分数情况**
• 周度绩效参考分：${rollupScore} 分（anomaly_rollups_v2 最新）
• 本次加分：+${bonusPoints} 分
• 备案写入总分：${recordedTotal} 分（独立 score_model，不与周度行合并）`;

  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: '📋 BI异常未触发加分' },
      template: 'green'
    },
    elements: [
      { tag: 'div', text: { tag: 'lark_md', content } },
      { tag: 'note', elements: [{ tag: 'plain_text', content: noteText }] }
    ]
  };
}

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

/**
 * 差评新记录通知卡片 — 简洁信息卡（无按钮）
 * 在 Bitable 轮询检测到新差评时由 bitable-poller 调用
 */
export function buildBadReviewCard({ store, date, platform, rating, responsibility, content, weekCount, monthCount }) {
  const starNum = Math.min(Math.max(parseInt(String(rating || '').replace(/[^0-9.]/g, ''), 10) || 0, 0), 5);
  const stars = '★'.repeat(starNum) + '☆'.repeat(5 - starNum);
  const respLabels = [];
  if (responsibility?.isProduct) respLabels.push('🔴 出品问题');
  if (responsibility?.isService) respLabels.push('🟡 服务问题');
  if (!respLabels.length) respLabels.push('⚪ 无法确定');
  const respText = respLabels.join('、');

  const body = `**门店**：${store}
**差评日期**：${date || '-'}
**平台**：${platform || '-'}
**星级**：${stars || '-'}
**责任归属**：${respText}

**差评内容**：
${content || '-'}

📊 本周累计差评：${weekCount}条
📊 本月累计差评：${monthCount}条`;

  return {
    header: { title: { tag: 'plain_text', content: `⭐ 新差评通知 · ${store}` }, template: 'red' },
    elements: [
      { tag: 'div', text: { tag: 'lark_md', content: body } },
      { tag: 'hr' },
      { tag: 'note', elements: [{ tag: 'plain_text', content: '差评对我们很重要，下次不要再发生！' }] }
    ]
  };
}

/**
 * 不满意桌访通知卡片 — 简洁信息卡（无按钮）
 * 在 Bitable 轮询检测到新桌访含不满意菜品时由 bitable-poller 调用
 */
export function buildTableVisitCard({ store, fields, dishes, monthCount }) {
  // Helper: extract text from field with multiple name variations
  const ext = (variants) => {
    for (const v of variants) {
      const val = fields[v];
      if (val == null) continue;
      if (typeof val === 'string' && val.trim()) return val.trim();
      if (typeof val === 'number') return String(val);
      if (Array.isArray(val)) return val.map(x => (typeof x === 'object' && x?.text) || String(x)).join(', ');
      if (typeof val === 'object' && val.text) return String(val.text);
      if (typeof val === 'object' && val.name) return String(val.name);
    }
    return '-';
  };

  const date = ext(['就餐时间', '用餐时段', '餐段', '用餐时间']);
  const tableNo = ext(['桌号', '台号']);
  const amount = ext(['消费金额', '消费', '金额', '人均消费', '总消费']);
  const guests = ext(['人数', '用餐人数', '就餐人数', '客人人数']);
  const reservation = ext(['是否有预定', '是否有预订', '预订', '预定']);
  const referral = ext(['哪里知道我们的', '怎么知道我们的', '来源', '渠道']);
  const firstVisit = ext(['是否第一次来', '第一次来', '第几次来']);
  const dishText = ext(['今天不满意的菜品', '今天不满意菜品', '今天 不满意的菜品', '今天 不满意菜品', '不满意菜品', '产品不满意项']);
  const reason = ext(['不满意的主要原因是什么', '不满意的主要原因', '不满意原因']);
  const mealReason = ext(['今天吃饭的原因', '吃饭的原因', '就餐原因']);
  const rushDish = ext(['今天催菜内容', '催菜内容', '催菜']);

  const hasRush = rushDish && rushDish !== '-' ? rushDish : '无';

  const body = `**门店**：${store}
**就餐时间**：${date}
**桌号**：${tableNo}
**消费金额**：${amount}元
**人数**：${guests}位
**是否有预订**：${reservation}
**怎么知道我们**：${referral}
**第几次来**：${firstVisit}
**今天不满意菜品**：${dishText}
**该产品本月投诉次数**：${monthCount}次
**不满意的主要原因**：${reason}
**今天吃饭的原因**：${mealReason}
**今天是否有催菜**：${hasRush}`;

  return {
    header: { title: { tag: 'plain_text', content: `🍽️ 不满意桌访通知 · ${store}` }, template: 'red' },
    elements: [
      { tag: 'div', text: { tag: 'lark_md', content: body } },
      { tag: 'hr' },
      { tag: 'note', elements: [{ tag: 'plain_text', content: '差评对我们很重要，下次不要再发生' }] }
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

/** 周度/月度绩效摘要卡片（仅 anomaly_rollups_v2；管理汇总勿用「—」加粗，飞书 lark_md 会误渲染成「一」） */
export function buildPerformanceSummaryCard({
  title,
  store,
  periodLabel,
  totalScore,
  role,
  detailMd,
  managementDigest = false,
  dimensionRatings = null,
  /** 周度 anomaly 卡：与 HRMS 周报一致，展示自然月至今备案次数 */
  monthlyFilingSummary = null
}) {
  const scoreBlock = managementDigest
    ? `**说明**：下列为各岗位 **上周异常触发汇总得分**（基准 100，扣减后可为负；与人力资源「执行力/态度/能力」月度模型分无关）。`
    : `**周度异常汇总得分**：**${totalScore}** 分（基准 100，按异常规则扣减，**可为负**；与月度综合模型分独立）`;
  
  let ratingBlock = '';
  if (
    monthlyFilingSummary &&
    typeof monthlyFilingSummary === 'object' &&
    (monthlyFilingSummary.executionCount != null || monthlyFilingSummary.attitudeCount != null)
  ) {
    const ex = Number(monthlyFilingSummary.executionCount) || 0;
    const at = Number(monthlyFilingSummary.attitudeCount) || 0;
    ratingBlock = `\n**本月累计备案（自然月至今）**\n• 工作执行力：**${ex}** 次\n• 工作态度：**${at}** 次`;
  } else if (dimensionRatings && typeof dimensionRatings === 'object') {
    const lines = [];
    if (dimensionRatings.store_rating) lines.push(`• 门店级别：${dimensionRatings.store_rating}级`);
    if (dimensionRatings.ability_rating) lines.push(`• 工作能力：${dimensionRatings.ability_rating}级`);
    if (dimensionRatings.attitude_rating) lines.push(`• 工作态度：${dimensionRatings.attitude_rating}级`);
    if (dimensionRatings.execution_rating) lines.push(`• 执行力：${dimensionRatings.execution_rating}级`);
    if (lines.length) ratingBlock = `\n**核心评级（A-D）**\n${lines.join('\n')}`;
  }
  
  return {
    header: { title: { tag: 'plain_text', content: title || '📊 绩效周度汇总' }, template: 'blue' },
    elements: [
      { tag: 'div', text: { tag: 'lark_md', content: `**门店**：${store || '-'}\n**周期**：${periodLabel}\n**岗位**：${role || '-'}\n${scoreBlock}` } },
      { tag: 'hr' },
      ...(ratingBlock ? [{ tag: 'div', text: { tag: 'lark_md', content: ratingBlock } }] : []),
      { tag: 'div', text: { tag: 'lark_md', content: `**扣分明细**\n${detailMd || '本周无异常扣分项。'}` } },
      {
        tag: 'note',
        elements: [
          {
            tag: 'plain_text',
            content:
              '数据来自上周各门店异常触发记录汇总；「本月累计备案」来自执行力日评与任务态度备案；核心评级（若有）来自人力资源综合模型。'
          }
        ]
      }
    ]
  };
}

export async function pushRhythmReport(content) {
  const chatId = process.env.FEISHU_HQ_OPS_CHAT_ID;
  if (chatId) return sendGroup(chatId, content);
  try {
    const r = await (await import('../utils/db.js')).query(
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
    const r = await (await import('../utils/db.js')).query(
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
    if (raw?.action && typeof raw.action === 'object') {
      return handleCardAction(raw);
    }
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

      // 2b) 总部营运 · 食安 BI 判罚：引用/thread 未回传时无法命中 feishu_msg_ids（commit 97bfdc1 已移除「门店责任人 24h bi_anomaly」兜底以避免私聊问数误绑）。
      //     resolveFoodSafetyHqReplyTask：hq_manager + 判罚语气 → 按门店或 pending_review 优先 + 最新更新绑定任务。
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

      // 已移除 3)「同店+责任人+24h 内最新 bi_anomaly」兜底：私聊里正常问数（如「昨天开档情况」）会被误判为任务回复并触发字数审核。
      // 提交任务处理记录请：① 引用/回复任务卡片（message_id 命中 feishu_msg_ids）；② 或在正文中写任务号 ANO-xxxxxxxx-xxxx / SCHED-xxxxxxxx-xxxx。

      // 若无 thread 匹配且无任务ID正文，则走普通消息 pipeline，避免误记为任务。

      if (taskId) {
          const responseText = hasParsedText ? parsedText : null;
          const responseImages = msgType === 'image' && imageKey
            ? JSON.stringify([{ imageKey, messageId: msg?.message_id || '' }])
            : null;

          // 食品安全 BI 异常：仅总部营运（hq_manager）判罚；管理员只读，不得进入 LLM 审核当判罚
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

    // PLLM 二段式：按钮先选择执行/不适合，再在聊天里补充原因/计划
    try {
      const pendingPllm = await popPendingPllmDecision(openId);
      const parsedText = String(text || '').trim();
      if (pendingPllm && parsedText && msg?.message_id) {
        const u = await lookupUser(openId);
        const role = String(u?.role || '').trim();
        if (u && ['admin', 'hq_manager'].includes(role)) {
          const { applyPllmDecision } = await import('./proactive-v2/pllm-workflow.js');
          const op = String(u.username || '').trim() || 'unknown';
          let decision = pendingPllm.decision;
          let planText = parsedText;
          if (decision === 'choose') {
            const m = parsedText.match(/^\s*(执行|不适合)\s*[:：,，\s]*(.+)?$/);
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
        eventId: eventId || undefined
      });
    } finally {
      clearTimeout(slowTimer);
    }
    return { ok: true, eventType, ...result };
  }
  return { toast: { type: 'info', content: 'ok' } };
}

/** 马己仙出品观察账号：不参与任务类卡片操作与对话内任务整改关联 */
export async function feishuOpenIdIsMajixianPmObserver(openId) {
  const oid = String(openId || '').trim();
  if (!oid) return false;
  try {
    const r = await query(
      `SELECT LOWER(TRIM(username)) AS u FROM feishu_users WHERE open_id = $1 LIMIT 1`,
      [oid]
    );
    return isMajixianPmObserverUsername(r.rows?.[0]?.u);
  } catch (_e) {
    return false;
  }
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

  /** PLLM 智能经营助手：移动端按钮（与食安任务卡一致走 card action 回调） */
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
          `这张 PLLM 旧卡的飞书回调没有带上“执行/不适合”的按钮字段，系统已识别任务：${taskId}。\n\n请直接回复：\n执行：写明执行计划（何时/谁负责/怎么做/目标）\n或\n不适合：写明原因\n\n我会自动记录。`,
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

  /* PLLM 兜底：检测三种场景
       1) taskId 在手且匹配 PLLM 任务（新卡 action.value 正确时）
       2) callbackMessageId 匹配 feishu_msg_ids（存储了 msg_id 的老卡）
       3) formValue 含 pllm_execute_plan/pllm_not_suitable_reason 键（input 在 action 内的旧卡） */
  const pllmFormKeys = ['pllm_execute_plan', 'pllm_not_suitable_reason'];
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
      /* 能识别到 PLLM 表单键但无法匹配 taskId（老卡且未存 msg_id），引导用户 */
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
    /** 不再对定时/抽检/BI 强制「时间+地点+事件」三要素；与任务详情一致即可（见 LLM 审核说明） */
    const isScheduledOrInspectionOrBi =
      src === 'scheduled_inspection' || src === 'random_inspection' || src === 'bi_anomaly';
    const isPlaceholder = /^(无|没有|ok|好的|收到|test|测试|了解|\d+)$/i.test(t);
    const textMeetsMin = t.length >= MIN_TEXT;

    let passed = false;
    let reason = '';
    let feedback = '';

    /** 有附图时：须与任务内容一致（底线），不凭长文绕过 */
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
        const r = await callLLM([
          {
            role: 'system',
            content: `你是餐饮连锁总部「任务回复」审核员（已通过字数≥${MIN_TEXT}、占位词与附图一致性等前置校验）。

【审核原则 — 按优先级】
1) **与任务卡片一致（最原则）**：回复须针对本任务「标题 + 详情」中的核心要求（问题点、整改项、抽检要点、试味范围等），不得明显跑题；允许用一段话概括，不要求逐条复述任务全文。
2) **字数**：已由系统保证 ≥${MIN_TEXT} 字，你无需再以「字数不足」为由判不通过。
3) **不强制格式**：不要求必须写出「具体时间点 + 店内精确位置 + 事件」三要素；若回复能看出在落实本任务关切（例如已做试味/检查/沟通/整改中的若干项），且与详情方向一致，应判 **通过**。
4) **不通过**仅适用于：明显敷衍套话、与任务主题无关、或任务明确要求某关键动作但回复完全未触及该要点（须在 reason 中点名缺的是哪一条任务要求，不得笼统说「不够详细」）。
5) 输出：passed=true 时 feedback 必须为空字符串；不通过时 reason 一句话，feedback 简短说明需补哪一点即可（禁止长篇模板折磨一线）。

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

    // 更新审核结果到 master_tasks
    if (passed) {
      const cat = String(task.category || '').trim();
      const isFoodSafetyBi = src === 'bi_anomaly' && cat === 'food_safety';

      if (isFoodSafetyBi) {
        /** 食安：店长/出品整改说明审核通过 ≠ 结案；须等 hq_manager「记录/不记录」才 resolved，否则会无扣分闭环 */
        await query(
          `UPDATE master_tasks SET
             review_passed = true, review_feedback = $2,
             review_count = COALESCE(review_count, 0) + 1,
             status = 'pending_review',
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
        setImmediate(() => {
          import('./proactive-v2/proactive-task-outcome-on-close.js')
            .then((m) => m.scheduleProactiveOutcomeOnClose(taskId, { newStatus: 'resolved' }))
            .catch(() => {});
        });
        if (replyMessageId) {
          replyMsg(replyMessageId, `✅ 审核通过，任务已闭环：${taskId}`).catch(() => {});
        }
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
               status = 'hr_filed',
               resolution_code = 'hr_attitude_review_fail_3x',
               updated_at = NOW()
             WHERE task_id = $1`,
            [taskId]
          );
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
