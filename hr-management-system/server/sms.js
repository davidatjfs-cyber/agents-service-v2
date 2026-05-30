// 阿里云短信发送适配器（dysmsapi SendSms, RPC 签名 HMAC-SHA1）
// 凭证全部来自环境变量，未配置时 sendAliyunSms 抛错（上层捕获，不影响主流程）：
//   ALIYUN_SMS_ACCESS_KEY_ID
//   ALIYUN_SMS_ACCESS_KEY_SECRET
//   ALIYUN_SMS_SIGN_NAME            短信签名（如「马己仙」）
//   ALIYUN_SMS_TEMPLATE_DEFAULT     默认模板 CODE（如 SMS_123456789）
//   ALIYUN_SMS_ENABLED              规则引擎是否允许自动发短信（'1'/'true' 才放开）
// 单条 action 可用 payload.sms_template_code 覆盖默认模板。
import crypto from 'crypto';

// RFC3986 百分号编码（阿里云 RPC 要求）
function percentEncode(str) {
  return encodeURIComponent(str)
    .replace(/\+/g, '%20')
    .replace(/\*/g, '%2A')
    .replace(/%7E/g, '~');
}

export function isAliyunSmsAutoSendEnabled() {
  const v = String(process.env.ALIYUN_SMS_ENABLED || '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

export function isAliyunSmsConfigured() {
  return Boolean(
    process.env.ALIYUN_SMS_ACCESS_KEY_ID &&
    process.env.ALIYUN_SMS_ACCESS_KEY_SECRET &&
    process.env.ALIYUN_SMS_SIGN_NAME
  );
}

// 发送短信。
// opts: { phoneNumbers, templateCode?, templateParam?(object), signName? }
// 成功返回 { provider_msg_id, raw }；失败抛 Error。
export async function sendAliyunSms(opts = {}) {
  const accessKeyId = String(process.env.ALIYUN_SMS_ACCESS_KEY_ID || '').trim();
  const accessKeySecret = String(process.env.ALIYUN_SMS_ACCESS_KEY_SECRET || '').trim();
  const signName = String(opts.signName || process.env.ALIYUN_SMS_SIGN_NAME || '').trim();
  const templateCode = String(opts.templateCode || process.env.ALIYUN_SMS_TEMPLATE_DEFAULT || '').trim();
  const phoneNumbers = String(opts.phoneNumbers || '').replace(/[^0-9,]/g, '');

  if (!accessKeyId || !accessKeySecret) throw new Error('missing_aliyun_sms_credentials');
  if (!signName) throw new Error('missing_aliyun_sms_sign_name');
  if (!templateCode) throw new Error('missing_aliyun_sms_template_code');
  if (!phoneNumbers) throw new Error('missing_sms_phone');

  const params = {
    Action: 'SendSms',
    Version: '2017-05-25',
    RegionId: 'cn-hangzhou',
    Format: 'JSON',
    SignatureMethod: 'HMAC-SHA1',
    SignatureVersion: '1.0',
    SignatureNonce: crypto.randomUUID(),
    Timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    AccessKeyId: accessKeyId,
    PhoneNumbers: phoneNumbers,
    SignName: signName,
    TemplateCode: templateCode
  };
  if (opts.templateParam && typeof opts.templateParam === 'object' && Object.keys(opts.templateParam).length) {
    params.TemplateParam = JSON.stringify(opts.templateParam);
  }

  // 规范化查询串（按 key 排序）
  const canonical = Object.keys(params)
    .sort()
    .map((k) => `${percentEncode(k)}=${percentEncode(params[k])}`)
    .join('&');
  const stringToSign = `GET&${percentEncode('/')}&${percentEncode(canonical)}`;
  const signature = crypto
    .createHmac('sha1', `${accessKeySecret}&`)
    .update(stringToSign)
    .digest('base64');

  const url = `https://dysmsapi.aliyuncs.com/?Signature=${percentEncode(signature)}&${canonical}`;
  const resp = await fetch(url, { method: 'GET' });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok || String(data?.Code) !== 'OK') {
    throw new Error(data?.Message || data?.Code || 'aliyun_sms_send_failed');
  }
  return { provider_msg_id: String(data?.BizId || data?.RequestId || ''), raw: data };
}
