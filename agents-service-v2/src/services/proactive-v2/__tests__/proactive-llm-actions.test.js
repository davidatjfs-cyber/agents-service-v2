import { scoreActionQuality, filterQualityActions } from '../proactive-llm-actions.js';

describe('PLLM 质量筛选', () => {
  const ctx = {
    metricFocus: 'revenue',
    profile: {
      brand: '洪潮',
      positioning: '中高端正餐',
      avgPrice: 260,
      hasTakeout: false,
      coreStrategy: '走质，客单价和包房利用率是核心',
      topDishes: [{ name: '生腌膏蟹' }]
    }
  };

  test('品牌与定位匹配动作得分更高', () => {
    const high = '晚市包房推出生腌膏蟹双人宴请套餐，客单价目标提升到260元以上，每晚复盘成交桌数';
    const low = '优化服务体验并加强管理';
    expect(scoreActionQuality(high, ctx)).toBeGreaterThan(scoreActionQuality(low, ctx));
  });

  test('过滤掉抽象低质量动作', () => {
    const actions = [
      '优化服务体验并加强管理',
      '今晚19:00前完成包房宴请菜品结构复盘，调高高毛利酒水连带率到25%'
    ];
    const out = filterQualityActions(actions, ctx);
    expect(out).toHaveLength(1);
    expect(out[0]).toContain('包房');
  });
});
