import { recallMemories } from '../agent-memory.js';
import { retrieveWikiKnowledge } from './wiki-retriever.js';
import { getStrategyStats } from './strategy-stats.js';

export async function buildExperienceBlock({ agent, store, query }) {
  let memoryText = '';
  let wikiText = '';
  let strategyStatsBlock = '';

  try {
    const mem = await recallMemories(agent, store, query, 3);
    if (mem?.length) {
      memoryText = mem.map((m) => `- ${m.content}`).join('\n');
    }
  } catch (e) { /* silent */ }

  try {
    const wiki = await retrieveWikiKnowledge({ store, query });
    if (wiki?.length) {
      wikiText = wiki
        .map((w) => `- 结论：${w.summary}\n  策略：${w.strategy}`)
        .join('\n');
    }
  } catch (e) { /* silent */ }

  if (store) {
    try {
      const stats = await getStrategyStats({ store, problem: String(query || '').slice(0, 120) });
      if (stats.length) {
        const lines = stats.map((s) => {
          const pct = Math.round(s.successRate * 100);
          const scShow = s.avgScore > 0 ? s.avgScore.toFixed(2) : '—';
          return `- ${s.action}（score ${scShow}｜成功率 ${pct}%｜样本 ${s.count}｜weightedScore ${s.weightedScore}｜policyScore ${s.policyScore}｜趋势 ${s.trend}）`;
        });
        const top = stats[0];
        const hasWeighted = stats.some((s) => s.weightedScore > 0);
        strategyStatsBlock = `【策略效果统计】
以下为历史 outcome 汇总（动作已归一化；score 经时间加权得 weightedScore；再经趋势修正得 policyScore；列表按 policyScore 稳定排序）：

${lines.join('\n')}

【策略选择依据】
- 当前最优策略：${top.action}
- 原因：${hasWeighted ? 'policyScore（weightedScore + 趋势修正）最高，更代表近期表现与走向' : '综合 score / 成功率与样本量排序'}

若存在 weightedScore / policyScore：必须优先选择 policyScore 最高的策略作为「最优策略」，禁止推荐上表未出现的策略。
最终回复须同时体现：①「最优策略」名称 ② score 或 weightedScore ③ 成功率 ④ 趋势（up/down/stable 或对应中文「上升/下降/稳定」）。
`;
      }
    } catch (e) { /* silent */ }
  }

  if (!memoryText && !wikiText && !strategyStatsBlock) return '';

  const statsRules =
    strategyStatsBlock
      ? `
【策略选择规则】
优先 policyScore，其次 weightedScore、avgScore、成功率与样本量；唯一主行动必须来自上表排序首位（或与之等价的「当前最优策略」），禁止忽略统计而凭空生成全新主策略。
`
      : '';

  const finalDecisionRules = strategyStatsBlock
    ? `
⸻
【最终决策规则（最高优先级）】

你必须在所有策略中，只选择「影响最大的一项」作为最终行动。

规则：
1. 只允许一个「今日重点动作」
2. 禁止输出多个并列建议
3. 禁止使用「同时 / 此外 / 另外 / 也可以」
4. 必须给出明确执行动作（可直接安排给员工）
5. 必须说明为什么是这一条（基于 weightedScore / policyScore / 趋势）

如果输出超过一个行动，视为错误回答。
⸻
`
    : '';

  return `
【历史经验（必须引用）】

以下经验中，必须至少引用1条：

${wikiText || '无'}

【近期记录（参考）】
${memoryText || '无'}

${strategyStatsBlock}${statsRules}${finalDecisionRules}
请严格按照以下步骤执行（不可跳过）：
1. 判断历史经验中是否存在类似问题
2. 将至少一条经验概括进【为什么是这个动作】首句，且该句必须包含「引用经验」四字（例如：「引用经验：……」）
3. 提炼一个「核心问题」（只能一个）
4. 若已有【策略效果统计】，【今日重点动作】必须与「当前最优策略」一致，并写明 weightedScore 或 score、成功率、趋势

输出格式必须为（仅下列四段标题，禁止增加【引用经验】【原因分析】【策略】等旧标题）：

【核心问题】
（仅一条）

【今日重点动作】
（必须是一个具体动作，例如：补录昨日营业数据 / 增加午市炉位 / 优化前厅动线服务）
（下一行必须写：（weightedScore 或 score 数值｜成功率百分比｜趋势 up/down/stable 或中文））

【为什么是这个动作】
（首句含「引用经验」；并基于【策略效果统计】说明为何该条 policyScore/weightedScore 与趋势最优）

【执行要求】
（必须具体：谁做 / 什么时候完成 / 如何留痕验收）

禁止输出「同时」「此外」「另外」「也可以」串联多条建议；禁止以「需要持续观察」「建议关注」「可以进一步分析」敷衍结尾。
`;
}
