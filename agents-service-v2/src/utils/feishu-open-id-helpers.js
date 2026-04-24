/**
 * 飞书 IM 使用 DB 中「其他应用」写入的 open_id 时会返回 open_id cross app / 99992361。
 * 纯函数：供 feishu-client 与单测复用。
 */

export function isOpenIdCrossAppFeishuError(code, msg) {
  const c = Number(code);
  const m = String(msg || '').toLowerCase();
  return (
    c === 99992361 ||
    m.includes('open_id cross app') ||
    m.includes('cross app') ||
    m.includes('cross_app')
  );
}

/** 转为 batch_get_id 可接受的 mainland 手机号（文档示例为 11 位不带 +86） */
export function normalizeMobileForFeishuBatchGet(raw) {
  const s = String(raw || '').replace(/\s/g, '');
  if (!s) return null;
  if (/^1[3-9]\d{9}$/.test(s)) return s;
  if (/^\+861[3-9]\d{9}$/.test(s)) return s.slice(3);
  if (/^86-?1[3-9]\d{9}$/.test(s)) return s.replace(/^86-?/, '');
  if (/^\+[1-9]\d{6,14}$/.test(s)) return s;
  return null;
}
