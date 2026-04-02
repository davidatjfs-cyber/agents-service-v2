/**
 * Agent Self-Evaluation & Continuous Learning (Phase 7)
 * 
 * 每个Agent定期评估自身表现，基于历史记忆调整策略
 * - 统计每个Agent的响应质量、任务完成率
 * - 基于outcome统计自动调整温度/prompt等参数
 * - 生成Agent健康报告
 */
import { query } from '../utils/db.js';
import { logger } from '../utils/logger.js';
import { recallMemories, getOutcomeStats } from './agent-memory.js';

/**
 * 评估单个Agent表现
 */
export async function evaluateAgent(agentId) {
  const stats = await getOutcomeStats(agentId);
  
  // 拉取近30天的消息处理记录
  let msgStats = { total: 0, avgLatency: 0 };
  try {
    const r = await query(
      `SELECT COUNT(*) as total,
              AVG(EXTRACT(EPOCH FROM (updated_at - created_at))) as avg_latency
       FROM message_log WHERE agent = $1 AND created_at >= CURRENT_DATE - 30`,
      [agentId]
    );
    if (r.rows?.[0]) {
      msgStats.total = parseInt(r.rows[0].total) || 0;
      msgStats.avgLatency = parseFloat(r.rows[0].avg_latency) || 0;
    }
  } catch (e) { /* table may not exist */ }

  // 拉取近期记忆
  const memories = await recallMemories(agentId, 'self-evaluation', 5);

  // 计算健康评分
  const successRate = stats.total > 0 ? (stats.positive / stats.total) : 0;
  let healthScore = 50; // 基础分
  if (stats.total >= 10) {
    healthScore = Math.min(100, Math.round(successRate * 100));
  }
  
  // 建议调整
  const suggestions = [];
  if (successRate < 0.5 && stats.total >= 5) {
    suggestions.push({ type: 'prompt_review', reason: `成功率仅${(successRate*100).toFixed(0)}%，建议审核prompt` });
  }
  if (msgStats.avgLatency > 10) {
    suggestions.push({ type: 'performance', reason: `平均响应${msgStats.avgLatency.toFixed(1)}s，考虑降低max_tokens` });
  }
  if (stats.total === 0) {
    suggestions.push({ type: 'inactive', reason: '近30天无活动记录' });
  }

  const report = {
    agentId,
    healthScore,
    stats: { ...stats, messages: msgStats.total, avgLatencySeconds: Math.round(msgStats.avgLatency * 10) / 10 },
    successRate: Math.round(successRate * 100),
    suggestions,
    recentMemories: memories.length,
    evaluatedAt: new Date().toISOString()
  };

  logger.info({ agentId, healthScore, successRate: report.successRate }, 'Agent evaluation completed');
  return report;
}

/**
 * 批量评估所有Agent
 */
export async function evaluateAllAgents() {
  const agentIds = [
    'data_auditor', 'ops_supervisor', 'chief_evaluator',
    'train_advisor', 'appeal', 'marketing_planner',
    'marketing_executor', 'procurement_advisor', 'master'
  ];
  
  const reports = {};
  for (const id of agentIds) {
    reports[id] = await evaluateAgent(id);
  }

  // 生成汇总
  const avgHealth = Object.values(reports).reduce((s, r) => s + r.healthScore, 0) / agentIds.length;
  const totalSuggestions = Object.values(reports).reduce((s, r) => s + r.suggestions.length, 0);

  return {
    summary: {
      avgHealthScore: Math.round(avgHealth),
      totalAgents: agentIds.length,
      totalSuggestions,
      evaluatedAt: new Date().toISOString()
    },
    agents: reports
  };
}

/**
 * 自动优化Agent参数（基于评估结果）
 */
export async function autoTuneAgent(agentId, evaluation) {
  if (!evaluation || evaluation.healthScore >= 70) return null; // 不需要调整

  const adjustments = {};
  
  for (const s of (evaluation.suggestions || [])) {
    if (s.type === 'performance') {
      adjustments.maxTokens = 600; // 降低token限制
    }
    if (s.type === 'prompt_review') {
      adjustments.temperature = 0.2; // 降低温度使输出更确定
    }
  }

  if (Object.keys(adjustments).length > 0) {
    try {
      // 写入agent_config表
      for (const [key, val] of Object.entries(adjustments)) {
        await query(
          `INSERT INTO agent_config (agent_id, config_key, config_value)
           VALUES ($1, $2, $3)
           ON CONFLICT (agent_id, config_key) DO UPDATE SET config_value = $3, updated_at = NOW()`,
          [agentId, key, String(val)]
        );
      }
      logger.info({ agentId, adjustments }, 'Agent auto-tuned');
    } catch (e) {
      logger.warn({ err: e?.message, agentId }, 'Auto-tune write failed');
    }
  }

  return adjustments;
}
