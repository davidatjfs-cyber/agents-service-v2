/**
 * 飞书多维表 / 公式字段常见两种写法：小数比率（0.6396=63.96%）或已为百分数（63.96）。
 * 统一为 0–100 的数值供库存储与阈值比较。
 */
export function parseFeishuRatioOrPercentString(s) {
  const t = String(s ?? '')
    .replace(/%/g, '')
    .replace(/,/g, '')
    .trim();
  if (!t) return null;
  const n = parseFloat(t);
  if (!Number.isFinite(n)) return null;
  if (n > 0 && n <= 1) return n * 100;
  return n;
}

/** 0–100 数值 → 展示用「xx.xx%」 */
export function formatPercentDisplay(n, digits = 2) {
  if (n == null || Number.isNaN(Number(n))) return '—';
  return `${Number(n).toFixed(digits)}%`;
}
