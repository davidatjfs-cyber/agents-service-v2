import { isMarketingPlanningIntent } from '../marketing-intent.js';

describe('isMarketingPlanningIntent', () => {
  test('detects 营销策划 intent', () => {
    expect(isMarketingPlanningIntent('帮我做一个营销策划')).toBe(true);
  });

  test('detects 营销方案 intent', () => {
    expect(isMarketingPlanningIntent('写一份营销方案')).toBe(true);
  });

  test('detects 营销活动 intent', () => {
    expect(isMarketingPlanningIntent('下个月的营销活动安排')).toBe(true);
  });

  test('detects 推广方案 intent', () => {
    expect(isMarketingPlanningIntent('有没有推广方案推荐')).toBe(true);
  });

  test('detects 引流 intent', () => {
    expect(isMarketingPlanningIntent('如何做引流')).toBe(true);
  });

  test('detects 拉新 intent', () => {
    expect(isMarketingPlanningIntent('拉新活动怎么做')).toBe(true);
  });

  test('detects 会员活动 intent', () => {
    expect(isMarketingPlanningIntent('会员活动方案')).toBe(true);
    expect(isMarketingPlanningIntent('会员的活动')).toBe(true);
  });

  test('detects 促销活动 intent', () => {
    expect(isMarketingPlanningIntent('促销活动计划')).toBe(true);
  });

  test('detects 外卖营收/growth intent', () => {
    expect(isMarketingPlanningIntent('外卖营收最近下降了')).toBe(true);
    expect(isMarketingPlanningIntent('外卖增长策略')).toBe(true);
  });

  test('detects ROI intent', () => {
    expect(isMarketingPlanningIntent('这个活动的ROI如何')).toBe(true);
  });

  test('detects "给我" + 方案 pattern', () => {
    expect(isMarketingPlanningIntent('给我一个方案')).toBe(true);
    expect(isMarketingPlanningIntent('给我计划')).toBe(true);
  });

  test('detects 制定+方案/计划 pattern', () => {
    expect(isMarketingPlanningIntent('制定营销方案')).toBe(true);
    expect(isMarketingPlanningIntent('制定推广计划')).toBe(true);
  });

  test('detects 怎么/如何+营销/推广 pattern', () => {
    expect(isMarketingPlanningIntent('怎么营销我的门店')).toBe(true);
    expect(isMarketingPlanningIntent('如何推广新菜品')).toBe(true);
  });

  test('returns false for non-marketing text', () => {
    expect(isMarketingPlanningIntent('昨天的营收数据怎么样')).toBe(false);
    expect(isMarketingPlanningIntent('分析一下人效')).toBe(false);
    expect(isMarketingPlanningIntent('有什么问题需要处理')).toBe(false);
  });

  test('returns false for empty input', () => {
    expect(isMarketingPlanningIntent('')).toBe(false);
    expect(isMarketingPlanningIntent(null)).toBe(false);
    expect(isMarketingPlanningIntent(undefined)).toBe(false);
  });

  test('returns false for whitespace-only input', () => {
    expect(isMarketingPlanningIntent('   ')).toBe(false);
  });
});
