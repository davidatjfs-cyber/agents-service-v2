/**
 * Agent 健康评估
 *
 * 数据来源：
 *  - agent_task_logs（agents-service-v2 飞书管线真实写入）→ 各 Agent 调用量与证据链
 *  - agent_messages.routed_to（若 HRMS 旧链路有写）→ 辅助
 *  - master_tasks（仅营运相关 source）→ ops_supervisor 任务闭环率
 *  - anomaly_triggers → data_auditor / BI 侧活跃度
 */
import { query } from '../utils/db.js';
import { logger } from '../utils/logger.js';

const PLANNED_AGENTS = new Set(['procurement_advisor']);

/** 与飞书任务卡、催办、绩效一致的营运任务来源 */
const OPS_TASK_SOURCES = `('random_inspection','scheduled_inspection','bi_anomaly','auto_collab')`;

/** 视为已闭环的状态（不含 pending_review：仍在待审核不算闭环） */
const TASK_DONE_STATUSES = `('resolved','settled','closed','completed')`;

export async function evaluateAgent(agentId) {
  let inCount = 0;
  let outCount = 0;
  try {
    const r = await query(
      `SELECT
         COUNT(*) FILTER (WHERE direction = 'in')  AS in_count,
         COUNT(*) FILTER (WHERE direction = 'out') AS out_count
       FROM agent_messages
       WHERE routed_to = $1 AND created_at >= NOW() - INTERVAL '30 days'`,
      [agentId]
    );
    inCount = parseInt(r.rows[0]?.in_count) || 0;
    outCount = parseInt(r.rows[0]?.out_count) || 0;
  } catch (e) { /* ignore */ }

  let deterministicCount = 0;
  if (agentId === 'data_auditor') {
    try {
      const r = await query(
        `SELECT COUNT(*) AS cnt FROM agent_messages
         WHERE (routed_to IS NULL OR routed_to = 'deterministic')
           AND direction = 'in'
           AND created_at >= NOW() - INTERVAL '30 days'`
      );
      deterministicCount = parseInt(r.rows[0]?.cnt) || 0;
      inCount += deterministicCount;
      outCount += deterministicCount;
    } catch (e) { /* ignore */ }
  }

  // ── agent_task_logs：V2 主路径真实调用（Master 调度在日志里可能记为 planner_workflow / master_planner）
  const taskLogAgents =
    agentId === 'master'
      ? ['master', 'planner_workflow', 'master_planner']
      : [agentId];
  let logsTotal = 0;
  let logsOk = 0;
  try {
    const r = await query(
      `SELECT COUNT(*)::int AS c,
              COUNT(*) FILTER (WHERE COALESCE(evidence_violation,false) = false)::int AS ok
       FROM agent_task_logs
       WHERE agent = ANY($1::text[]) AND created_at >= NOW() - INTERVAL '30 days'`,
      [taskLogAgents]
    );
    logsTotal = parseInt(r.rows[0]?.c) || 0;
    logsOk = parseInt(r.rows[0]?.ok) || 0;
  } catch (e) { /* 表可能不存在 */ }

  const totalMsgs = inCount + outCount;

  // ── 任务完成率：仅 ops_supervisor 使用「营运任务」子集，避免全库 master_tasks 污染 ──
  let taskTotal = 0;
  let taskDone = 0;
  if (agentId === 'ops_supervisor') {
    try {
      const r = await query(`
        SELECT
          COUNT(*)::int AS total,
          COUNT(*) FILTER (WHERE status IN ${TASK_DONE_STATUSES})::int AS done
        FROM master_tasks
        WHERE dispatched_at >= NOW() - INTERVAL '30 days'
          AND source IN ${OPS_TASK_SOURCES}
      `);
      taskTotal = parseInt(r.rows[0]?.total) || 0;
      taskDone = parseInt(r.rows[0]?.done) || 0;
    } catch (e) { /* ignore */ }
  }
  // master：不用全库任务比率（易与 Planner/其它任务混淆），避免误报「15%」
  if (agentId === 'master') {
    taskTotal = 0;
    taskDone = 0;
  }

  let anomalyCount = 0;
  if (agentId === 'data_auditor') {
    try {
      const r = await query(
        `SELECT COUNT(*)::int AS cnt FROM anomaly_triggers
         WHERE trigger_date >= (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Shanghai')::date - 30`
      );
      anomalyCount = parseInt(r.rows[0]?.cnt) || 0;
    } catch (e) { /* ignore */ }
  }

  const isPlanned = PLANNED_AGENTS.has(agentId);
  const isActive =
    !isPlanned &&
    (totalMsgs > 0 || anomalyCount > 0 || logsTotal > 0 || (agentId === 'ops_supervisor' && taskTotal > 0));

  let healthScore = 50;
  let successRate = 0;

  if (isPlanned) {
    healthScore = 50;
    successRate = 0;
  } else if (!isActive) {
    healthScore = 30;
    successRate = 0;
  } else if (agentId === 'ops_supervisor' && taskTotal > 0) {
    const rate = taskDone / taskTotal;
    successRate = Math.round(rate * 100);
    healthScore = Math.min(100, 45 + Math.round(rate * 55));
  } else if (
    agentId === 'marketing_planner' ||
    agentId === 'marketing_executor' ||
    agentId === 'chief_evaluator' ||
    agentId === 'train_advisor' ||
    agentId === 'appeal' ||
    agentId === 'master'
  ) {
    if (logsTotal > 0) {
      successRate = Math.round((logsOk / logsTotal) * 100);
      healthScore = Math.min(100, 40 + Math.round((logsOk / logsTotal) * 60));
    } else if (inCount > 0 && outCount > 0) {
      const rate = Math.min(1, outCount / inCount);
      successRate = Math.round(rate * 100);
      healthScore = Math.min(100, 55 + Math.round(rate * 45));
    } else if (inCount > 0 || logsTotal > 0) {
      successRate = 75;
      healthScore = 72;
    } else {
      successRate = 80;
      healthScore = 75;
    }
  } else if (taskTotal > 0) {
    const rate = taskDone / taskTotal;
    successRate = Math.round(rate * 100);
    healthScore = Math.min(100, 50 + Math.round(rate * 50));
  } else if (inCount > 0 && outCount > 0) {
    const rate = Math.min(1, outCount / inCount);
    successRate = Math.round(rate * 100);
    healthScore = Math.min(100, 60 + Math.round(rate * 40));
  } else {
    healthScore = 72;
    successRate = 72;
  }

  const suggestions = [];
  if (isPlanned) {
    suggestions.push({ type: 'planned', reason: '该 Agent 已配置但尚未正式启用' });
  } else if (!isActive) {
    suggestions.push({ type: 'inactive', reason: '近30天无活动记录，请确认配置是否正确' });
  } else if (healthScore < 60) {
    suggestions.push({ type: 'low_response', reason: `综合得分偏低（成功率约${successRate}%），建议关注处理质量` });
  }
  if (agentId === 'ops_supervisor' && taskTotal > 0 && taskDone / taskTotal < 0.35) {
    suggestions.push({
      type: 'task_completion',
      reason: `营运任务闭环率约${Math.round((taskDone / taskTotal) * 100)}%（仅统计抽检/定时/BI任务），建议跟进待回复任务`
    });
  }

  const report = {
    agentId,
    healthScore,
    stats: {
      total: inCount,
      messages: totalMsgs,
      avgLatencySeconds: 0,
      anomalyCount,
      taskTotal,
      taskDone,
      taskLogs30d: logsTotal,
      taskLogsOk30d: logsOk
    },
    successRate,
    suggestions,
    recentMemories: 0,
    evaluatedAt: new Date().toISOString()
  };

  logger.info({ agentId, healthScore, successRate, totalMsgs, logsTotal, isActive }, 'Agent evaluation completed');
  return report;
}

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

export async function autoTuneAgent(agentId, evaluation) {
  if (!evaluation || evaluation.healthScore >= 70) return null;

  const adjustments = {};
  for (const s of evaluation.suggestions || []) {
    if (s.type === 'performance') adjustments.maxTokens = 600;
    if (s.type === 'prompt_review') adjustments.temperature = 0.2;
  }

  if (Object.keys(adjustments).length > 0) {
    try {
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
