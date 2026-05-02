/**
 * Message Router 单元测试 — 复合路由
 */
import { jest } from '@jest/globals';

jest.unstable_mockModule('../../utils/db.js', () => ({
  query: jest.fn().mockResolvedValue({ rows: [] }),
  __esModule: true,
}));

jest.unstable_mockModule('../llm-provider.js', () => ({
  callLLM: jest.fn().mockResolvedValue({ content: '{"route":"master","confidence":0.5,"reason":"unknown"}' }),
  __esModule: true,
}));

const { routeMessage, inferRouteByRules, checkPermission, COMPOSITE_PATTERNS } = await import('../message-router.js');

describe('COMPOSITE_PATTERNS', () => {
  test('定义了3种复合模式', () => {
    expect(COMPOSITE_PATTERNS).toHaveLength(3);
    expect(COMPOSITE_PATTERNS[0].routes).toEqual(['chief_evaluator', 'data_auditor']);
    expect(COMPOSITE_PATTERNS[1].routes).toEqual(['ops_supervisor', 'train_advisor']);
    expect(COMPOSITE_PATTERNS[2].routes).toEqual(['data_auditor', 'marketing_planner']);
  });

  test('每条模式有label', () => {
    COMPOSITE_PATTERNS.forEach(p => {
      expect(typeof p.label).toBe('string');
      expect(p.label.length).toBeGreaterThan(0);
    });
  });
});

describe('routeMessage — 复合路由', () => {
  test('绩效分析类触发composite路由', async () => {
    const r = await routeMessage('帮我分析绩效扣分原因并给出改进方案', false, 'test_user');
    expect(r.route).toBe('composite');
    expect(r.routes).toEqual(['chief_evaluator', 'data_auditor']);
    expect(r.confidence).toBeGreaterThanOrEqual(0.9);
  });

  test('巡检培训类触发composite路由', async () => {
    const r = await routeMessage('巡检发现卫生问题，需要对照标准培训员工', false, 'test_user');
    expect(r.route).toBe('composite');
    expect(r.routes).toEqual(['ops_supervisor', 'train_advisor']);
  });

  test('营收下滑方案类触发composite路由', async () => {
    const r = await routeMessage('最近营收下滑，帮我制定提升方案', false, 'test_user');
    expect(r.route).toBe('composite');
    expect(r.routes).toEqual(['data_auditor', 'marketing_planner']);
  });

  test('普通查询不走复合路由', async () => {
    const r = await routeMessage('今天的营收数据是多少', false, 'test_user');
    expect(r.route).toBe('data_auditor');
  });

  test('简单问候不走复合路由', async () => {
    const r = await routeMessage('你好', false, 'test_user');
    expect(r.route).not.toBe('composite');
  });
});

describe('checkPermission — composite route', () => {
  test('所有角色都有composite权限', () => {
    expect(checkPermission('store_manager', 'composite').allowed).toBe(true);
    expect(checkPermission('store_production_manager', 'composite').allowed).toBe(true);
    expect(checkPermission('front_manager', 'composite').allowed).toBe(true);
    expect(checkPermission('employee', 'composite').allowed).toBe(true);
    expect(checkPermission('admin', 'composite').allowed).toBe(true);
  });

  test('未知角色走employee默认权限', () => {
    const r = checkPermission('unknown_role', 'composite');
    expect(r.allowed).toBe(true);
  });
});

describe('inferRouteByRules', () => {
  test('图片输入走ops_supervisor', () => {
    const r = inferRouteByRules('随便什么文字', true);
    expect(r.route).toBe('ops_supervisor');
    expect(r.confidence).toBe(1);
  });

  test('空文本返回null', () => {
    expect(inferRouteByRules('', false)).toBeNull();
    expect(inferRouteByRules('   ', false)).toBeNull();
  });

  test('差评关键词走data_auditor', () => {
    const r = inferRouteByRules('最近差评多吗', false);
    expect(r.route).toBe('data_auditor');
  });

  test('绩效关键词走chief_evaluator', () => {
    const r = inferRouteByRules('我的绩效评分是多少', false);
    expect(r.route).toBe('chief_evaluator');
  });
});
