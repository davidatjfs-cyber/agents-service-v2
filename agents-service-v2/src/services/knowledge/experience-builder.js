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

  if (agent === 'data_auditor' && store) {
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
优先 weightedScore，其次 avgScore、成功率与样本量；在【策略】中写明「最优策略」、score 或 weightedScore、成功率及趋势；禁止忽略统计而凭空生成全新主策略。
`
      : '';

  return `
【历史经验（必须引用）】

以下经验中，必须至少引用1条：

${wikiText || '无'}

【近期记录（参考）】
${memoryText || '无'}

${strategyStatsBlock}${statsRules}
请严格按照以下步骤执行（不可跳过）：
1. 判断历史经验中是否存在类似问题
2. 必须引用至少1条经验（写在「引用经验」部分）
3. 提炼一个「核心问题」（只能一个）
4. 基于该核心问题进行分析；若已有【策略效果统计】，必须结合「最优策略」、weightedScore/score、成功率与趋势作答

输出格式必须为：

【引用经验】
（引用具体经验内容）

【核心问题】
（只能一个）

【原因分析】

【策略】
（须写明「最优策略」、score 或 weightedScore、成功率、趋势；不得省略）

如果没有引用经验，则视为错误回答。
`;
}
