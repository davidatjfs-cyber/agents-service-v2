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
 */
export async function saveOutcome(agentId, store, content, outcome, score) {
  try {
    await query(
      `INSERT INTO agent_memory (agent_id, store, memory_type, content, outcome, outcome_score)
       VALUES ($1, $2, 'outcome', $3, $4, $5)`,
      [agentId, store, content.slice(0, 2000), outcome, score]
    );
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
