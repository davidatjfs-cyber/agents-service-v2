/**
 * 用户是否在问「变差/异常」类问题（优先于纯「昨天」日报触发）。
 */

export function detectAnalysisIntent(text) {
  return /下降|下滑|变差|不好|异常/.test(String(text || ''));
}

/**
 * 从问句推断指标树根 metric_id（与 metric_dictionary 种子对齐）；无法识别时返回 null，由调用方默认 revenue。
 */
export function detectMetricFromQuestion(text) {
  const t = String(text || '');
  if (/客单价|桌均|人均|AOV|aov/.test(t)) return 'avg_order_value';
  if (/客流|进店|人流量|翻台/.test(t)) return 'traffic';
  if (/订单|单量|单数/.test(t)) return 'orders';
  if (/营业额|营收|实收|流水|生意额|收入/.test(t)) return 'revenue';
  return null;
}
