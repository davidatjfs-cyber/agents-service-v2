/**
 * Agent Memory System — 让Agent记住历史交互和效果
 * 
 * 功能:
 * 1. 保存每次Agent交互的关键信息
 * 2. 检索相关历史记忆供Agent决策参考
 * 3. 记录方案执行效果，供后续优化
 */
import { query } from '../utils/db.js';
import { logger } from '../utils/logger.js';
import { recordAgentExperience } from './agent-experience.js';

/**
 * 保存Agent交互记忆
 */
export async function saveMemory(agentId, store, content, context = {}) {
  try {
    await query(
      `INSERT INTO agent_memory (agent_id, store, memory_type, content, context)
       VALUES ($1, $2, 'interaction', $3, $4)`,
      [agentId, store, content.slice(0, 2000), JSON.stringify(context)]
    );
  } catch (e) {
    logger.warn({ err: e?.message }, 'saveMemory failed');
  }
}

/**
 * 保存方案执行结果
 * @param {{ tags?: string[] }} [options] 可选；传入 tags 时同步写入 agent_experience.tags
 */
export async function saveOutcome(agentId, store, content, outcome, score, options = {}) {
  try {
    await query(
      `INSERT INTO agent_memory (agent_id, store, memory_type, content, outcome, outcome_score)
       VALUES ($1, $2, 'outcome', $3, $4, $5)`,
      [agentId, store, content.slice(0, 2000), outcome, score]
    );
    try {
      const scenario =
        agentId === 'data_auditor' ? 'revenue_drop' : agentId === 'ops_supervisor' ? 'ops_quality' : String(agentId || 'generic');
      const tags = Array.isArray(options?.tags) ? options.tags : null;
      await recordAgentExperience(
        scenario,
        String(outcome || '').slice(0, 500),
        String(content || '').slice(0, 500),
        score,
        tags
      );
    } catch (e) {
      logger.warn({ err: e?.message }, 'saveOutcome agent_experience skipped');
    }
  } catch (e) {
    logger.warn({ err: e?.message }, 'saveOutcome failed');
  }
}

/**
 * 检索相关历史记忆 — 基于agent+store+关键词
 */
export async function recallMemories(agentId, store, keywords = '', limit = 5) {
  try {
    let sql = `SELECT content, outcome, outcome_score, created_at FROM agent_memory
               WHERE agent_id = $1`;
    const params = [agentId];

    if (store) {
      params.push(store);
      sql += ` AND (store = $${params.length} OR store IS NULL)`;
    }

    if (keywords) {
      params.push(`%${keywords}%`);
      sql += ` AND content ILIKE $${params.length}`;
    }

    sql += ` ORDER BY created_at DESC LIMIT $${params.length + 1}`;
    params.push(limit);

    const r = await query(sql, params);
    return r.rows || [];
  } catch (e) {
    logger.warn({ err: e?.message }, 'recallMemories failed');
    return [];
  }
}

/**
 * 获取某Agent对某门店的历史方案效果统计
 */
/**
 * 闭环后回写：与 saveOutcome 一致，入参贴近业务语义（action / outcome_score / store）。
 */
export async function saveProactiveActionOutcome({ action, outcome_score, store, outcome = 'evaluated', options = {} }) {
  return saveOutcome(
    'proactive_llm',
    String(store || '').trim(),
    String(action || '').slice(0, 2000),
    outcome,
    Number(outcome_score),
    options
  );
}

/** 取同店 proactive_llm 历史 outcome，供提示词高/低分降权 */
export async function getProactiveLlmOutcomeHints(store, limit = 12) {
  const s = String(store || '').trim();
  if (!s) return { high: [], low: [], recent: [] };
  try {
    const r = await query(
      `SELECT content, outcome_score, outcome, created_at
       FROM agent_memory
       WHERE agent_id = 'proactive_llm' AND store = $1 AND memory_type = 'outcome'
       ORDER BY created_at DESC
       LIMIT $2`,
      [s, limit]
    );
    const rows = r.rows || [];
    const high = rows.filter((x) => x.outcome_score != null && Number(x.outcome_score) >= 7);
    const low = rows.filter((x) => x.outcome_score != null && Number(x.outcome_score) < 5);
    return { high, low, recent: rows };
  } catch (e) {
    logger.warn({ err: e?.message }, 'getProactiveLlmOutcomeHints failed');
    return { high: [], low: [], recent: [] };
  }
}

export async function formatProactiveLlmPromptHints(store) {
  const s = String(store || '').trim();
  if (!s) return '';
  const { high, low } = await getProactiveLlmOutcomeHints(store, 14);
  let notSuitableReasons = [];
  try {
    const rr = await query(
      `SELECT response_text
       FROM master_tasks
       WHERE source = 'proactive_llm'
         AND store = $1
         AND resolution_code = 'pllm_not_suitable'
         AND response_text IS NOT NULL
         AND trim(response_text) <> ''
       ORDER BY updated_at DESC
       LIMIT 6`,
      [s]
    );
    notSuitableReasons = (rr.rows || [])
      .map((x) => String(x.response_text || '').trim())
      .filter(Boolean);
  } catch (e) {
    logger.warn({ err: e?.message, store: s }, 'formatProactiveLlmPromptHints: not suitable reasons load failed');
  }
  if (!high.length && !low.length && !notSuitableReasons.length) return '';
  let block = '\n【同店历史方案反馈（proactive_llm，用于优先参考 / 低分降权）】\n';
  if (high.length) {
    block += '高评分（≥7）可优先参考类似可执行动作：\n';
    block += high
      .slice(0, 4)
      .map((x) => `- [${x.outcome_score}分] ${String(x.content || '').slice(0, 160)}`)
      .join('\n');
    block += '\n';
  }
  if (low.length) {
    block += '低评分（<5）应降权，避免重复同质建议，需换渠道/价格带或验证数据后再给动作：\n';
    block += low
      .slice(0, 4)
      .map((x) => `- [${x.outcome_score}分] ${String(x.content || '').slice(0, 160)}`)
      .join('\n');
    block += '\n';
  }
  if (notSuitableReasons.length) {
    block += '门店标记「不适合」的历史原因（应避免同类建议）：\n';
    block += notSuitableReasons
      .slice(0, 4)
      .map((x) => `- ${x.slice(0, 160)}`)
      .join('\n');
    block += '\n';
  }
  return block;
}

export async function getOutcomeStats(agentId, store) {
  try {
    const r = await query(
      `SELECT COUNT(*)::int as total,
              AVG(outcome_score)::numeric(3,1) as avg_score,
              COUNT(CASE WHEN outcome_score >= 7 THEN 1 END)::int as success_count
       FROM agent_memory
       WHERE agent_id = $1 AND store = $2 AND memory_type = 'outcome' AND outcome_score IS NOT NULL`,
      [agentId, store]
    );
    return r.rows[0] || { total: 0, avg_score: null, success_count: 0 };
  } catch (e) { return { total: 0, avg_score: null, success_count: 0 }; }
}

/**
 * 构建统一的记忆上下文块（供所有 Agent handler 入口调用）
 * 替代零散的手动 recall，确保风格和数量一致
 *
 * @param {string} agentId
 * @param {string} store
 * @param {string} query
 * @param {number} [limit=3]
 * @returns {Promise<string>} 拼好的文本块，空则返回 ''
 */
export async function buildMemoryContextBlock(agentId, store, query, limit = 3) {
  const s = String(store || '').trim();
  if (!s) return '';
  try {
    const [outcomes, memories] = await Promise.all([
      getOutcomeStats(agentId, s).catch(() => ({ total: 0, avg_score: null, success_count: 0 })),
      recallMemories(agentId, s, '', limit),
    ]);
    const parts = [];
    if (outcomes.total > 0) {
      const rate = outcomes.total > 0 ? ((outcomes.success_count / outcomes.total) * 100).toFixed(0) : 'N/A';
      parts.push(`[历史执行统计] 共${outcomes.total}条建议，成功率${rate}%，平均分${outcomes.avg_score || 'N/A'}`);
    }
    if (memories.length) {
      parts.push('[近期记录] ' + memories.map(m => String(m.content || '').slice(0, 100)).join(' | '));
    }
    return parts.length ? `\n${parts.join('\n')}\n` : '';
  } catch (e) {
    logger.warn({ err: e?.message, agentId, store }, 'buildMemoryContextBlock failed');
    return '';
  }
}

/**
 * 清理90天前的低价值记忆
 */
export async function cleanupOldMemories() {
  try {
    const r = await query(
      `DELETE FROM agent_memory WHERE created_at < NOW() - INTERVAL '90 days' AND outcome_score IS NULL`
    );
    return r.rowCount || 0;
  } catch (e) { return 0; }
}
