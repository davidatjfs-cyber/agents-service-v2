/**
 * 复杂业务场景 mock：多指标异动、子指标缺失、方向冲突等。
 * 供决策质量、分析引擎、prompt 鲁棒性等测试引用（非生产数据）。
 */

/** 多指标同时异动：营收↓、客流↓、差评↑（真实门店常见组合） */
export const SCENARIO_MULTI_SIGNAL_ANOMALY = {
  id: 'multi_signal_anomaly',
  description: '营收与堂食客流同步下滑，同期差评量上升',
  store: '测试门店A',
  period: { current: '2026-03-10~2026-03-16', baseline: '2026-03-03~2026-03-09' },
  metrics: {
    revenue: { current: 812000, baseline: 991000, trend: 'down' },
    orders: { current: 3760, baseline: 4120, trend: 'down' },
    traffic: { current: 4180, baseline: 5050, trend: 'down' },
    avg_order_value: { current: 215.9, baseline: 240.5, trend: 'down' },
    bad_reviews: { current: 27, baseline: 11, trend: 'up' },
    conversion_rate: { current: 0.9, baseline: 0.816, trend: 'up' }
  },
  narrative:
    '客流与订单双降拖累营收；差评上升可能压制转化与复购，需区分「获客」与「体验」两条线。'
};

/**
 * 下钻时子指标缺失：traffic 有值，exposure / walk_in_rate 为 null（字典有子节点但数仓未就绪）
 */
export const SCENARIO_PARTIAL_TREE_NULL = {
  id: 'partial_tree_null',
  description: '客流可算，曝光/到店率暂无数据',
  store: '测试门店B',
  period: { current: '2026-03-17~2026-03-23', baseline: '2026-03-10~2026-03-16' },
  metrics: {
    revenue: { current: 745000, baseline: 802000, trend: 'down' },
    traffic: { current: 3920, baseline: 4680, trend: 'down' },
    exposure: { current: null, baseline: null, trend: null },
    walk_in_rate: { current: null, baseline: null, trend: null },
    orders: { current: 3580, baseline: 3980, trend: 'down' },
    avg_order_value: { current: 208.1, baseline: 201.5, trend: 'up' }
  },
  narrative:
    '根因指向客流下滑，但无法从曝光/到店率拆解，应避免臆造子指标数值，建议从投放与引流动作侧给建议。'
};

/**
 * 方向冲突：营收↑、客流↓、客单价↑（结构性拉动，解读易误判）
 */
export const SCENARIO_CONFLICTING_DIRECTIONS = {
  id: 'conflicting_directions',
  description: '客流下降但客单价上升，总营收仍增长',
  store: '测试门店C',
  period: { current: '2026-02-01~2026-02-28', baseline: '2026-01-04~2026-01-31' },
  metrics: {
    revenue: { current: 1085000, baseline: 996000, trend: 'up' },
    traffic: { current: 3650, baseline: 4520, trend: 'down' },
    orders: { current: 3520, baseline: 3950, trend: 'down' },
    avg_order_value: { current: 308.2, baseline: 252.2, trend: 'up' },
    bad_reviews: { current: 6, baseline: 7, trend: 'down' }
  },
  narrative:
    '人少单少但单笔抬高；若用户问「客流」仍应承认客流问题，不可因营收涨而否定引流压力。'
};

/**
 * 将场景指标压成可拼入 system prompt 的短文本
 * @param {typeof SCENARIO_MULTI_SIGNAL_ANOMALY} scenario
 */
export function formatScenarioMetricsForPrompt(scenario) {
  const lines = [];
  const p = scenario.period || {};
  lines.push(`门店：${scenario.store || '未命名'}`);
  lines.push(`对比区间：本期 ${p.current || '-'} vs 基期 ${p.baseline || '-'}`);
  lines.push(scenario.description || scenario.id);
  const m = scenario.metrics || {};
  for (const [key, v] of Object.entries(m)) {
    if (!v || typeof v !== 'object') continue;
    const cur = v.current !== undefined ? v.current : v.value;
    const base = v.baseline !== undefined ? v.baseline : v.baseline_value;
    const tri = v.trend != null ? ` 趋势:${v.trend}` : '';
    const curS = cur === null || cur === undefined ? 'null' : String(cur);
    const baseS = base === null || base === undefined ? 'null' : String(base);
    lines.push(`- ${key}: 本期=${curS} 基期=${baseS}${tri}`);
  }
  if (scenario.narrative) lines.push(`说明：${scenario.narrative}`);
  return lines.join('\n');
}
