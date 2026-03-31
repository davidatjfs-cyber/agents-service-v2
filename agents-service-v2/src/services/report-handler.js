/**
 * Report Handler — 经营分析计算逻辑（稳定、可复用）
 *
 * 说明：
 * - 不做 LLM、不发卡片、不做任务状态机
 * - 只做“指标计算 + 异常归因的简单判定”
 */

function detectAnomalies(metrics) {
  const issues = [];

  // profitRate 为 0~1 的毛利率分数（0.6 => 60%）
  if (metrics.profitRate != null && Number.isFinite(metrics.profitRate) && metrics.profitRate < 0.6) {
    issues.push('利润率偏低');
  }
  if (metrics.avgTicket != null && Number.isFinite(metrics.avgTicket) && metrics.avgTicket < 80) {
    issues.push('客单价偏低');
  }
  if (metrics.tableTurnover != null && Number.isFinite(metrics.tableTurnover) && metrics.tableTurnover < 2) {
    issues.push('翻台率不足');
  }

  return issues;
}

export function analyzeDailyBusiness(data) {
  const revenue = Number(data?.revenue || 0);
  const cost = Number(data?.cost || 0);
  const profit = revenue - cost;
  const profitRate = revenue > 0 ? profit / revenue : null;

  const avgTicket = data?.avgTicket != null ? Number(data.avgTicket) : null;
  const tableTurnover = data?.tableTurnover != null ? Number(data.tableTurnover) : null;

  const anomalies = detectAnomalies({
    profitRate,
    avgTicket,
    tableTurnover
  });

  return {
    revenue,
    cost,
    profit,
    profitRate,
    avgTicket,
    tableTurnover,
    anomalies
  };
}

