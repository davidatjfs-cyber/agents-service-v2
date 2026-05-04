import axios from 'axios';
import { logger } from '../utils/logger.js';
import { isExternalEnabled } from '../utils/safety.js';
import { getTenantToken, BASE } from './feishu-auth.js';
import { isOpenIdCrossAppFeishuError } from '../utils/feishu-open-id-helpers.js';
import { refreshFeishuUserOpenIdForImDelivery } from './feishu-users.js';

function feishuSkipOpenIdResolve() {
  const v = String(process.env.FEISHU_SKIP_OPEN_ID_RESOLVE || '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
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
