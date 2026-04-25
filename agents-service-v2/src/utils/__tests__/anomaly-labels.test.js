import { anomalyRuleLabelZh } from '../anomaly-labels.js';

describe('anomalyRuleLabelZh', () => {
  test('returns Chinese name for known rule key', () => {
    expect(anomalyRuleLabelZh('revenue_achievement')).toBe('实收营收异常');
    expect(anomalyRuleLabelZh('labor_efficiency')).toBe('人效值异常');
    expect(anomalyRuleLabelZh('recharge_zero')).toBe('充值异常');
    expect(anomalyRuleLabelZh('food_safety')).toBe('食品安全评价异常');
    expect(anomalyRuleLabelZh('bad_review_product')).toBe('差评报告产品异常');
    expect(anomalyRuleLabelZh('bad_review_service')).toBe('差评报告服务异常');
    expect(anomalyRuleLabelZh('gross_margin')).toBe('总实收毛利率异常');
    expect(anomalyRuleLabelZh('traffic_decline')).toBe('客流量/订单数异常');
    expect(anomalyRuleLabelZh('table_visit_product')).toBe('桌访产品异常');
    expect(anomalyRuleLabelZh('table_visit_ratio')).toBe('桌访占比异常');
  });

  test('resolves alias table_visit_prod to table_visit_product', () => {
    expect(anomalyRuleLabelZh('table_visit_prod')).toBe('桌访产品异常');
  });

  test('returns raw key for unknown key', () => {
    expect(anomalyRuleLabelZh('nonexistent_rule')).toBe('nonexistent_rule');
  });

  test('handles empty string', () => {
    expect(anomalyRuleLabelZh('')).toBe('');
  });

  test('handles null/undefined', () => {
    expect(anomalyRuleLabelZh(null)).toBe('');
    expect(anomalyRuleLabelZh(undefined)).toBe('');
  });
});
