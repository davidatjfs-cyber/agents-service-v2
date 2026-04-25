import { anomalyToScenario, formatTemplateOptions } from '../action-templates.js';

describe('anomalyToScenario', () => {
  test('maps revenue anomalies to 午市客流不足', () => {
    expect(anomalyToScenario('revenue_achievement')).toBe('午市客流不足');
    expect(anomalyToScenario('revenue_achievement_monthly')).toBe('午市客流不足');
    expect(anomalyToScenario('revenue_drop')).toBe('午市客流不足');
    expect(anomalyToScenario('traffic_decline')).toBe('午市客流不足');
  });

  test('maps bad_review_service to 差评-服务', () => {
    expect(anomalyToScenario('bad_review_service')).toBe('差评-服务');
  });

  test('maps bad_review_product to 差评-出品', () => {
    expect(anomalyToScenario('bad_review_product')).toBe('差评-出品');
  });

  test('maps food_safety to 食品安全', () => {
    expect(anomalyToScenario('food_safety')).toBe('食品安全');
  });

  test('returns null for unknown key', () => {
    expect(anomalyToScenario('unknown_key')).toBeNull();
    expect(anomalyToScenario('')).toBeNull();
    expect(anomalyToScenario(null)).toBeNull();
  });
});

describe('formatTemplateOptions', () => {
  test('returns null for empty inputs', () => {
    expect(formatTemplateOptions([], [])).toBeNull();
  });

  test('formats template options with title and description', () => {
    const templates = [{
      scenario: '午市客流不足',
      brand: '马己仙',
      priority: 1,
      options: [{
        title: '午市双人套餐引流',
        description: '推98元双人餐',
        success_metric: '午市订单≥45单/日',
        assignee: 'store_manager',
        deadline: '明午市前',
      }]
    }];

    const result = formatTemplateOptions(templates, []);
    expect(result).toContain('建议方案');
    expect(result).toContain('午市双人套餐引流');
    expect(result).toContain('推98元双人餐');
    expect(result).toContain('验收');
    expect(result).toContain('店长');
  });

  test('formats dbSuccesses when provided', () => {
    const templates = [{
      scenario: '差评-服务',
      brand: '洪潮',
      priority: 1,
      options: [{
        title: '服务流程复训',
        description: '培训重点',
        success_metric: '差评清零',
        assignee: 'store_manager',
        deadline: '今天下午',
      }]
    }];

    const dbSuccesses = [{
      title: '洪潮服务改善',
      scoreLabel: '良好',
      score: 2,
      metric: '差评数',
      change: -50
    }];

    const result = formatTemplateOptions(templates, dbSuccesses);
    expect(result).toContain('服务流程复训');
    expect(result).toContain('近期成功案例');
    expect(result).toContain('洪潮服务改善');
  });

  test('maps store_production_manager to 厨师长', () => {
    const templates = [{
      scenario: '差评-出品',
      brand: '马己仙',
      priority: 1,
      options: [{
        title: '出品标准复检',
        description: '复检出品',
        success_metric: '出品类差评清零',
        assignee: 'store_production_manager',
        deadline: '今天开始',
      }]
    }];

    const result = formatTemplateOptions(templates, []);
    expect(result).toContain('厨师长');
    expect(result).not.toContain('store_production_manager');
  });
});
