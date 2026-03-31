/**
 * 管线层粗粒度意图（先于 deterministic / 子 Agent）。
 * 顺序：analysis → query → strategy → unknown
 */
export function detectIntent(text) {
  const t = String(text || '');
  // 「营销文案」表单含「提升/优化」等词时不应判为 strategy 以免强制走 marketing_planner
  if (/^\s*营销文案/m.test(t)) return 'unknown';
  if (/下降|下滑|变差|不好|异常|问题/.test(t)) {
    return 'analysis';
  }
  if (/多少|多少单|数据|情况|报表/.test(t)) {
    return 'query';
  }
  if (/怎么做|怎么办|优化|提升/.test(t)) {
    return 'strategy';
  }
  return 'unknown';
}
