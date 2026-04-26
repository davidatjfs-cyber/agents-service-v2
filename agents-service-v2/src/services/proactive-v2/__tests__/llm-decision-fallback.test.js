import { fallbackDecision, fallbackActionsForAnomaly } from '../llm-decision.js';

const cfg = { llm: { revenueDropThreshold: 20, badReviewSpikeThreshold: 5 } };

describe('fallbackActionsForAnomaly', () => {
  test('至少返回 2 条可执行动作且含门店名', () => {
    const a = fallbackActionsForAnomaly({ store: '测试店A', type: 'unknown', severity: 'medium' });
    expect(Array.isArray(a)).toBe(true);
    expect(a.length).toBeGreaterThanOrEqual(2);
    expect(a.every((x) => String(x).includes('测试店A'))).toBe(true);
  });
});

describe('fallbackDecision', () => {
  test('高严重度兜底时 actions 非空（可建 PLLM 任务）', () => {
    const d = fallbackDecision(
      { store: '马己仙上海音乐广场店', type: 'revenue_achievement', severity: 'high', triggered: true },
      cfg
    );
    expect(d.triggered).toBe(true);
    expect(d.actions.length).toBeGreaterThanOrEqual(2);
  });

  test('业务规则命中 seriousRules 时 actions 非空', () => {
    const d = fallbackDecision(
      { store: '洪潮大宁久光店', type: 'recharge_zero', severity: 'medium', triggered: true },
      cfg
    );
    expect(d.triggered).toBe(true);
    expect(d.actions.length).toBeGreaterThanOrEqual(2);
  });
});
