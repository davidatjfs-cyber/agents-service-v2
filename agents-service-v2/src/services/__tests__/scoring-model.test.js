import { calcDeductions, storeRating, calcBonus } from '../scoring-model.js';

// ── calcDeductions ──────────────────────────────────────────
describe('calcDeductions', () => {
  const anomalies = [
    { category: 'revenue_anomaly', severity: 'high' },
    { category: 'food_safety', severity: 'medium' },
    { category: 'table_visit_anomaly', severity: 'medium' }
  ];

  test('空异常数组返回扣分0', () => {
    expect(calcDeductions([], 'store_manager')).toEqual({ total: 0, details: [] });
  });

  test('null/undefined 返回扣分0', () => {
    expect(calcDeductions(null, 'store_manager')).toEqual({ total: 0, details: [] });
    expect(calcDeductions(undefined, 'store_manager')).toEqual({ total: 0, details: [] });
  });

  test('店长角色：只扣店长相关的异常', () => {
    const r = calcDeductions(anomalies, 'store_manager');
    // revenue_anomaly(40) + food_safety(10) = 50, table_visit_anomaly 是出品经理的不管
    expect(r.total).toBe(50);
    expect(r.details).toHaveLength(2);
  });

  test('出品经理角色：只扣出品经理相关的异常', () => {
    const r = calcDeductions(anomalies, 'store_production_manager');
    // food_safety(10) + table_visit_anomaly(5) = 15
    expect(r.total).toBe(15);
    expect(r.details).toHaveLength(2);
  });

  test('customPoints 覆盖默认分值', () => {
    const items = [{ category: 'revenue_anomaly', severity: 'medium', customPoints: 99 }];
    const r = calcDeductions(items, 'store_manager');
    expect(r.total).toBe(99);
  });

  test('customPoints = 0 不扣分', () => {
    const items = [{ category: 'revenue_anomaly', severity: 'high', customPoints: 0 }];
    const r = calcDeductions(items, 'store_manager');
    expect(r.total).toBe(0);
  });

  test('未知 category 跳过不报错', () => {
    const r = calcDeductions([{ category: 'nonexistent', severity: 'high' }], 'store_manager');
    expect(r.total).toBe(0);
  });

  test('未知 severity 跳过不报错', () => {
    const r = calcDeductions([{ category: 'revenue_anomaly', severity: 'catastrophic' }], 'store_manager');
    expect(r.total).toBe(0);
  });
});

// ── storeRating ─────────────────────────────────────────────
describe('storeRating', () => {
  test('>0.95 → A', () => {
    expect(storeRating(0.96)).toBe('A');
    expect(storeRating(1.0)).toBe('A');
  });

  test('>0.9 → B', () => {
    expect(storeRating(0.91)).toBe('B');
    expect(storeRating(0.95)).toBe('B');
  });

  test('>=0.85 → C', () => {
    expect(storeRating(0.85)).toBe('C');
    expect(storeRating(0.89)).toBe('C');
    expect(storeRating(0.9)).toBe('C');
  });

  test('<0.85 → D', () => {
    expect(storeRating(0.84)).toBe('D');
    expect(storeRating(0)).toBe('D');
    expect(storeRating(-1)).toBe('D');
  });
});

// ── calcBonus ───────────────────────────────────────────────
describe('calcBonus', () => {
  test('马己仙 brand 基础奖金 1500', () => {
    const r = calcBonus(100, '马己仙上海音乐广场店', 'A');
    expect(r.bonus).toBe(1500);
    expect(r.note).toBe('normal');
  });

  test('其他品牌基础奖金 2000', () => {
    const r = calcBonus(100, '洪潮大宁久光店', 'A');
    expect(r.bonus).toBe(2000);
  });

  test('评分 80 / A 级 → bonus = round(80/100 * base)', () => {
    const r = calcBonus(80, '洪潮大宁久光店', 'A');
    expect(r.bonus).toBe(1600); // 80/100 * 2000 = 1600
  });

  test('D 级 → 0 bonus, wage_80pct', () => {
    const r = calcBonus(50, '洪潮大宁久光店', 'D');
    expect(r.bonus).toBe(0);
    expect(r.note).toBe('wage_80pct');
  });

  test('C 级 → 0 bonus, no_bonus', () => {
    const r = calcBonus(80, '洪潮大宁久光店', 'C');
    expect(r.bonus).toBe(0);
    expect(r.note).toBe('no_bonus');
  });

  test('无 brand 时默认 base=2000', () => {
    const r = calcBonus(100, null, 'A');
    expect(r.bonus).toBe(2000);
  });

  test('majixin 不区分大小写', () => {
    const r = calcBonus(100, 'MaJiXin', 'A');
    expect(r.bonus).toBe(1500);
  });
});
