/**
 * 从用户消息中推断门店全名（与 feishu_users.store 对齐）。
 * message-pipeline / 食安 HQ 兜底等共用，避免漂移。
 */
export function extractStoreFromText(text, storeNames) {
  if (!text || !storeNames?.length) return '';
  for (const s of storeNames) {
    if (text.includes(s)) return s;
  }
  for (const s of storeNames) {
    const short = s.replace(/店$/, '').trim();
    if (short && text.includes(short)) return s;
  }
  for (const s of storeNames) {
    const noSuffix = s.replace(/店$/, '').trim();
    for (let len = 2; len <= Math.min(6, noSuffix.length); len++) {
      const prefix = noSuffix.slice(0, len);
      if (text.includes(prefix)) return s;
    }
  }
  return '';
}
