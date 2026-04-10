/**
 * 营销策划（strategy_agent）规则决策引擎：Memory + 输入 → 结构化策略；不调用 LLM。
 * 与 DB 侧 strategy-engine.js（scenario/root_cause 规则库）分离。
 */

/**
 * @param {{ input?: string, memories?: Array<{ content?: string, score?: number }> }} opts
 * @returns {Array<{ action: string, source: string, reason: string }>}
 */
export function decideStrategy({ input, memories = [] }) {
  const strategies = [];
  const text = String(input || '');
  const mem = Array.isArray(memories) ? memories : [];

  if (text.includes('下雨') || text.includes('雨天')) {
    const rainMemory = mem.find((m) => String(m.content || '').includes('雨天'));
    if (rainMemory) {
      strategies.push({
        action: '推出“雨天免配送费”活动',
        source: 'memory',
        reason: '历史经验显示雨天该策略可提升订单'
      });
    }
  }

  if (text.includes('复购') || text.includes('老客户')) {
    const vipMemory = mem.find((m) => String(m.content || '').includes('隐藏菜单'));
    if (vipMemory) {
      strategies.push({
        action: '推出“隐藏菜单老板推荐套餐”',
        source: 'memory',
        reason: '历史经验显示可提升复购率'
      });
    }
  }

  if (strategies.length === 0) {
    strategies.push({
      action: '推出限时套餐',
      source: 'default',
      reason: '通用转化策略'
    });
  }

  const extras = [
    { action: '强化会员触达与回访节奏', source: 'default', reason: '通用留存' },
    { action: '优化高峰排班与出餐动线', source: 'default', reason: '通用体验' }
  ];
  for (const ex of extras) {
    if (strategies.length >= 3) break;
    strategies.push(ex);
  }
  let k = 0;
  while (strategies.length < 3) {
    k += 1;
    strategies.push({
      action: `门店引流补充动作${k}`,
      source: 'default',
      reason: '保证方案条数'
    });
  }

  return strategies.slice(0, 8);
}
