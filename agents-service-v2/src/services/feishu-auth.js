import axios from 'axios';
import crypto from 'crypto';
import dns from 'node:dns';
import { logger } from '../utils/logger.js';
import { isExternalEnabled } from '../utils/safety.js';

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

export function getFeishuStatus() { return { configured: !!(APP_ID && APP_SECRET), hasToken: !!_token, tokenExpires: _tokenExp ? new Date(_tokenExp).toISOString() : null }; }

export { decryptFeishuEncryptPayload, BASE, APP_ID, APP_SECRET };
