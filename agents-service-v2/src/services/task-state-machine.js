/**
 * Task State Machine — agents-service-v2
 * 任务生命周期状态流转 + 升级链(从DB配置读取) + 事件日志
 */
import { query } from '../utils/db.js';
import { logger } from '../utils/logger.js';
import { getConfig } from './config-service.js';
import { pushAnomalyAlert, sendCard, buildApprovalTaskCard } from './feishu-client.js';

// ─── Status Flow Definition (从 master-agent.js 提取) ───

const STATUS_FLOW = {
  pending_audit:      { next: ['auditing', 'pending_dispatch'], agent: 'data_auditor' },
  auditing:           { next: ['pending_dispatch', 'closed'], agent: 'data_auditor' },
  pending_dispatch:   { next: ['dispatched'], agent: 'master' },
  dispatched:         { next: ['viewed', 'in_progress', 'pending_response'], agent: 'ops_supervisor' },
  viewed:             { next: ['in_progress', 'pending_response'], agent: 'ops_supervisor' },
  in_progress:        { next: ['waiting_evidence', 'pending_response'], agent: 'ops_supervisor' },
  waiting_evidence:   { next: ['pending_review', 'pending_response'], agent: 'ops_supervisor' },
  pending_response:   { next: ['pending_review', 'escalated', 'hr_filed', 'closed', 'resolved'], agent: 'master' },
  pending_review:     { next: ['resolved', 'rejected', 'pending_response', 'hr_filed'], agent: 'ops_supervisor' },
  awaiting_approval: { next: ['pending_dispatch', 'rejected'], agent: 'master' },
  resolved:           { next: ['pending_settlement', 'closed'], agent: 'master' },
  rejected:           { next: ['pending_dispatch'], agent: 'master' },
  escalated:          { next: ['pending_dispatch', 'closed'], agent: 'master' },
  hr_filed:           { next: ['closed'], agent: 'master' },
  pending_settlement: { next: ['settled'], agent: 'chief_evaluator' },
  settled:            { next: ['closed'], agent: 'master' },
  closed:             { next: [], agent: null },
};

// ─── Create Task ───

export async function createTask({ taskId, source, category, severity, store, brand, title, detail, sourceData, assigneeUsername, assigneeRole }) {
  const id = taskId || `MT-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  try {
    const r = await query(
      `INSERT INTO master_tasks (task_id, status, source, category, severity, store, brand, title, detail, source_data, assignee_username, assignee_role, current_agent)
       VALUES ($1, 'pending_audit', $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, 'data_auditor')
       ON CONFLICT (task_id) DO NOTHING RETURNING id, task_id`,
      [id, source || 'anomaly_engine', category, severity || 'medium', store, brand, title, detail, JSON.stringify({ ...(sourceData || {}), created_via: 'task_state_machine' }), assigneeUsername, assigneeRole]
    );
    if (r.rows?.[0]) {
      await logEvent(id, 'task_created', null, 'data_auditor', null, 'pending_audit', { source, category, severity });
      logger.info({ taskId: id, store, category }, 'Task created');
    }
    return { ok: true, taskId: id };
  } catch (e) {
    logger.error({ err: e?.message }, 'Create task failed');
    return { ok: false, error: e?.message };
  }
}

// ─── Transition Task Status ───

export async function transitionTask(taskId, newStatus, agentName, payload = {}) {
  try {
    const task = await getTask(taskId);
    if (!task) return { ok: false, error: 'task_not_found' };

    const current = task.status;
    const flow = STATUS_FLOW[current];
    if (!flow) return { ok: false, error: `invalid current status: ${current}` };
    if (!flow.next.includes(newStatus)) {
      return { ok: false, error: `invalid transition: ${current} → ${newStatus}`, allowed: flow.next };
    }

    const updates = [`status = $2`, `updated_at = NOW()`];
    const params = [taskId, newStatus];
    let idx = 3;

    if (newStatus === 'dispatched') { updates.push(`dispatched_at = NOW()`); updates.push(`current_agent = 'ops_supervisor'`); }
    if (newStatus === 'pending_response') {
      updates.push(`responded_at = NOW()`);
      updates.push(`first_response_at = COALESCE(first_response_at, NOW())`);
    }
    if (newStatus === 'resolved') { updates.push(`resolved_at = NOW()`); }
    if (newStatus === 'settled') { updates.push(`settled_at = NOW()`); }
    if (newStatus === 'closed') { updates.push(`closed_at = NOW()`); }
    if (newStatus === 'hr_filed') { updates.push(`hr_performance_recorded = TRUE`); }

    if (payload.reviewResult) { params.push(JSON.stringify(payload.reviewResult)); updates.push(`review_result = $${idx++}::jsonb`); }
    if (payload.reviewPassed !== undefined) { params.push(payload.reviewPassed); updates.push(`review_passed = $${idx++}`); }
    if (payload.reviewFeedback) { params.push(payload.reviewFeedback); updates.push(`review_feedback = $${idx++}`); }
    if (payload.reviewCount !== undefined) { updates.push(`review_count = COALESCE(review_count, 0) + 1`); }
    if (payload.responseText) { params.push(payload.responseText); updates.push(`response_text = COALESCE($${idx++}, response_text)`); }
    if (payload.responseImages) { params.push(JSON.stringify(payload.responseImages)); updates.push(`response_images = COALESCE($${idx++}::jsonb, response_images)`); }
    if (payload.resolutionCode) { params.push(payload.resolutionCode); updates.push(`resolution_code = $${idx++}`); }
    if (payload.scoreImpact !== undefined) { params.push(payload.scoreImpact); updates.push(`score_impact = $${idx++}`); }

    await query(`UPDATE master_tasks SET ${updates.join(', ')} WHERE task_id = $1`, params);
    const targetAgent = payload.toAgent || task.assignee_agent || task.current_agent || STATUS_FLOW[newStatus]?.agent;
    await logEvent(taskId, 'status_transition', agentName, targetAgent, current, newStatus, payload);

    // 进入审批等待：发送同意/驳回卡片（若能拿到审批人）
    if (newStatus === 'awaiting_approval') {
      await notifyApprovalNeeded(task);
    }

    logger.info({ taskId, from: current, to: newStatus, agent: agentName }, 'Task transitioned');
    if (['closed', 'resolved', 'settled', 'completed'].includes(newStatus)) {
      import('./proactive-v2/proactive-task-outcome-on-close.js')
        .then((m) => m.scheduleProactiveOutcomeOnClose(taskId, { newStatus }))
        .catch(() => {});
      if (newStatus === 'closed') {
        import('./task-orchestrator.js')
          .then((m) => m.logTaskExperience(taskId))
          .catch(() => {});
        import('./task-board-queue.js')
          .then((m) => m.enqueueTaskSummary(taskId))
          .catch(() => {});
      }
    }
    return { ok: true, from: current, to: newStatus };
  } catch (e) {
    logger.error({ err: e?.message, taskId }, 'Transition failed');
    return { ok: false, error: e?.message };
  }
}

function requiresApproval(task) {
  const t = task?.source_data?.task_type || task?.source_data?.suggestion_task_type || task?.category || '';
  return ['inventory_update', 'schedule_change'].includes(String(t));
}

async function notifyApprovalNeeded(task) {
  try {
    // 审批人优先：使用任务的 assignee_role，其次店长
    const role = task?.assignee_role || 'store_manager';
    const usersR = await query(
      `SELECT open_id FROM feishu_users
       WHERE store = $1 AND role = $2 AND registered = TRUE AND open_id IS NOT NULL
       LIMIT 5`,
      [task?.store, role]
    );
    let users = usersR.rows || [];
    if (!users.length) {
      const fb = await query(
        `SELECT open_id FROM feishu_users
         WHERE store = $1 AND role = 'store_manager' AND registered = TRUE AND open_id IS NOT NULL
         LIMIT 5`,
        [task?.store]
      );
      users = fb.rows || [];
    }
    if (!users.length || !task?.task_id) return;

    const card = buildApprovalTaskCard(task);
    for (const u of users) {
      await sendCard(u.open_id, card).catch(() => {});
    }
  } catch (e) {
    logger.warn({ err: e?.message, taskId: task?.task_id }, 'notifyApprovalNeeded failed');
  }
}

// ─── Escalation Check (从DB配置读取升级链) ───

export async function checkEscalation(taskId) {
  try {
    const task = await getTask(taskId);
    if (!task || task.status === 'closed') return { escalated: false };

    const escalationCfg = await getConfig('escalation_config');
    if (!escalationCfg) return { escalated: false };

    const category = task.category || 'default';
    const ageMinutes = (Date.now() - new Date(task.created_at).getTime()) / 60000;
    const currentLevel = task.source_data?.escalation_level || task.escalation_level || 0;

    let levels = [];
    if (escalationCfg[category]?.levels) {
      levels = escalationCfg[category].levels;
    } else if (escalationCfg.default?.levels) {
      levels = escalationCfg.default.levels;
    } else if (Array.isArray(escalationCfg.chains?.[category])) {
      levels = escalationCfg.chains[category].map((role, i) => ({ notify_role: role, after_minutes: 60 * (i + 1) }));
    } else if (Array.isArray(escalationCfg.chains?.default)) {
      levels = escalationCfg.chains.default.map((role, i) => ({ notify_role: role, after_minutes: 60 * (i + 1) }));
    }
    if (!levels.length) return { escalated: false };

    for (let i = currentLevel; i < levels.length; i++) {
      const level = levels[i];
      if (ageMinutes >= (level.after_minutes || 60)) {
        const newLevel = i + 1;
        await query(
          `UPDATE master_tasks SET source_data = jsonb_set(COALESCE(source_data,'{}'), '{escalation_level}', $2::jsonb), escalation_level = $3, updated_at = NOW() WHERE task_id = $1`,
          [taskId, JSON.stringify(newLevel), newLevel]
        );
        await logEvent(taskId, 'escalation', 'system', level.notify_role, task.status, task.status, { level: newLevel, role: level.notify_role, after_minutes: level.after_minutes });

        const detail = `任务 ${taskId} 超时${Math.round(ageMinutes)}分钟，升级至 ${level.notify_role}`;
        await pushAnomalyAlert(task.store, task.category, 'high', detail);

        logger.warn({ taskId, level: newLevel, role: level.notify_role, ageMinutes }, 'Task escalated');
        return { escalated: true, level: newLevel, role: level.notify_role };
      }
    }
    return { escalated: false };
  } catch (e) {
    logger.error({ err: e?.message, taskId }, 'Escalation check failed');
    return { escalated: false, error: e?.message };
  }
}

// ─── Batch Escalation Scan ───

export async function scanEscalations() {
  try {
    const openTasks = await query(
      `SELECT task_id FROM master_tasks WHERE status NOT IN ('closed','settled','resolved') AND created_at < NOW() - INTERVAL '30 minutes' ORDER BY created_at ASC LIMIT 100`
    );
    const results = [];
    for (const row of (openTasks.rows || [])) {
      const r = await checkEscalation(row.task_id);
      if (r.escalated) results.push({ taskId: row.task_id, ...r });
    }
    if (results.length) logger.info({ count: results.length }, 'Escalation scan completed');
    return { scanned: openTasks.rows?.length || 0, escalated: results };
  } catch (e) {
    logger.error({ err: e?.message }, 'Escalation scan failed');
    return { scanned: 0, escalated: [], error: e?.message };
  }
}

// ─── Helpers ───

export async function getTask(taskId) {
  const r = await query('SELECT * FROM master_tasks WHERE task_id = $1 LIMIT 1', [taskId]);
  return r.rows?.[0] || null;
}

export async function getTasksByStore(store, status, limit = 50) {
  let sql = 'SELECT * FROM master_tasks WHERE store = $1';
  const params = [store];
  if (status) { params.push(status); sql += ` AND status = $${params.length}`; }
  sql += ` ORDER BY created_at DESC LIMIT $${params.length + 1}`;
  params.push(limit);
  const r = await query(sql, params);
  return r.rows || [];
}

export async function getTaskStats() {
  const r = await query(`SELECT status, COUNT(*) as count FROM master_tasks GROUP BY status ORDER BY count DESC`);
  return r.rows || [];
}

export async function logEvent(taskId, eventType, fromAgent, toAgent, statusBefore, statusAfter, payload) {
  try {
    await query(
      `INSERT INTO master_events (task_id, event_type, from_agent, to_agent, status_before, status_after, payload) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)`,
      [taskId, eventType, fromAgent, toAgent, statusBefore, statusAfter, JSON.stringify(payload || {})]
    );
  } catch (e) { /* silent */ }
}

export { STATUS_FLOW };
