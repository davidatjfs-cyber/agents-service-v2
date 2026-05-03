import { query } from '../utils/db.js';
import { logger } from '../utils/logger.js';
import { createTask, transitionTask, getTask, logEvent } from './task-state-machine.js';
import { parseTaskText, mapBoardStatus } from './task-parser.js';
import { dispatchTaskAsync } from './master-agent-dispatcher.js';
import { enrichFromTemplate } from './task-templates.js';

export async function createBoardTask({ content, priority, store, deadline, createdBy, createdByRole }) {
  const text = String(content || '').trim();
  if (!text) return { ok: false, error: 'content_required' };

  const seed = parseTaskText(text, { priority, store });
  const result = await createTask({
    source: 'hrms_task_board',
    category: seed.category,
    severity: priority || seed.priority || 'medium',
    store: seed.store,
    title: seed.title,
    detail: text,
    sourceData: {
      created_from: 'hrms_task_board',
      created_by: createdBy || 'unknown',
      created_by_role: createdByRole || null,
      raw_content: text,
      requested_deadline: deadline || null,
      orchestrator_version: 'v0'
    }
  });
  if (!result.ok) return result;

  await query(
    `UPDATE master_tasks
     SET created_from = 'hrms_task_board', priority = $2, task_intent = $3::jsonb, last_activity_at = NOW(), updated_at = NOW()
     WHERE task_id = $1`,
    [result.taskId, priority || seed.priority || 'medium', JSON.stringify(seed)]
  ).catch((e) => logger.warn({ err: e?.message, taskId: result.taskId }, 'board task metadata update failed'));

  const { enqueueTaskParse } = await import('./task-board-queue.js');
  const enqueue = await enqueueTaskParse(result.taskId);
  return { ok: true, taskId: result.taskId, boardStatus: '待解析', enqueue };
}

export async function parseAndDispatchTask(taskId) {
  const task = await getTask(taskId);
  if (!task) return { ok: false, error: 'task_not_found' };
  if (task.status !== 'pending_audit') return { ok: true, skipped: true, status: task.status };

  const parsed0 = parseTaskText(task.detail || task.title || '', {
    store: task.store,
    priority: task.priority || task.severity
  });
  const preserveExistingShape = task.source && task.source !== 'hrms_task_board';
  const parsed = preserveExistingShape
    ? { ...parsed0, category: task.category || parsed0.category, store: task.store || parsed0.store }
    : enrichFromTemplate(parsed0);

  const similarExperiences = await findSimilarTasks({ category: parsed.category, store: parsed.store, limit: 3 });
  if (similarExperiences.length > 0) {
    const withScore = similarExperiences.filter(e => e.quality_score !== null && e.quality_score > 0);
    const topExp = (withScore.length > 0 ? withScore : similarExperiences)
      .sort((a, b) => (b.quality_score || 0) - (a.quality_score || 0))[0];
    parsed.similarExperience = { id: topExp.id, qualityScore: topExp.quality_score, timeToClose: topExp.time_to_close_hours, titlePattern: topExp.title_pattern, totalSimilar: similarExperiences.length };
    if (withScore.length > 0 && withScore[0].quality_score >= 7 && !parsed.acceptanceRules?.length) {
      parsed.acceptanceRules = ['参考历史高质量任务执行'];
    }
  }

  const decision = await dispatchTaskAsync(parsed);

  await query(
    `UPDATE master_tasks
     SET category = $2,
         store = COALESCE($3, store),
         assignee_agent = $4,
         current_agent = $4,
         task_intent = $5::jsonb,
         acceptance_rules = $6::jsonb,
         evidence_requirements = $7::jsonb,
         timeout_at = COALESCE(timeout_at, $8::timestamptz),
         last_activity_at = NOW(),
         updated_at = NOW()
     WHERE task_id = $1`,
    [
      taskId,
      parsed.category,
      parsed.store,
      decision.assigneeAgent,
      JSON.stringify({ ...parsed, dispatch: decision }),
      JSON.stringify(parsed.acceptanceRules || []),
      JSON.stringify(parsed.evidenceRequirements || []),
      parsed.deadlineAt
    ]
  );
  await logEvent(taskId, 'task_parsed', 'task_orchestrator', 'master', task.status, task.status, { parsed });
  await logEvent(taskId, 'agent_assigned', 'master', decision.assigneeAgent, task.status, task.status, decision);

  const transitioned = await transitionTask(taskId, 'pending_dispatch', 'task_orchestrator', { parsed, dispatch: decision });
  if (!transitioned.ok) return transitioned;
  const dispatched = await transitionTask(taskId, 'dispatched', 'master', { dispatch: decision });
  if (dispatched.ok) {
    await query(
      `UPDATE master_tasks SET current_agent = $2, assignee_agent = $2, last_activity_at = NOW(), updated_at = NOW() WHERE task_id = $1`,
      [taskId, decision.assigneeAgent]
    );
    setImmediate(() => sendTaskCardToAssignee(taskId).catch(() => {}));
  }
  return dispatched;
}

export async function createUnifiedTask({
  taskId,
  source,
  category,
  severity,
  store,
  brand,
  title,
  detail,
  sourceData,
  assigneeUsername,
  assigneeRole,
  assigneeAgent,
  feishuMsgIds,
  timeoutAt,
  timeoutHours,
  targetStatus = 'dispatched',
  createdFrom
} = {}) {
  const result = await createTask({
    taskId,
    source: source || 'system',
    category,
    severity,
    store,
    brand,
    title,
    detail,
    sourceData: {
      ...(sourceData || {}),
      unified_task_center: true,
      orchestrator_version: 'v1'
    },
    assigneeUsername,
    assigneeRole
  });
  if (!result.ok) return result;
  const id = result.taskId;
  const computedTimeoutAt = timeoutAt
    ? new Date(timeoutAt).toISOString()
    : timeoutHours
      ? new Date(Date.now() + Number(timeoutHours) * 3600 * 1000).toISOString()
      : null;
  await query(
    `UPDATE master_tasks
     SET created_from = $2,
         assignee_agent = COALESCE($3, assignee_agent),
         current_agent = COALESCE($3, current_agent),
         feishu_msg_ids = COALESCE($4::jsonb, feishu_msg_ids),
         timeout_at = COALESCE($7::timestamptz, timeout_at),
         priority = COALESCE($5, priority),
         last_activity_at = NOW(),
         updated_at = NOW(),
         source_data = COALESCE(source_data, '{}'::jsonb) || $6::jsonb
     WHERE task_id = $1`,
    [
      id,
      createdFrom || source || 'system',
      assigneeAgent || null,
      feishuMsgIds ? JSON.stringify(feishuMsgIds) : null,
      severity || null,
      JSON.stringify({ assignee_agent_hint: assigneeAgent || null }),
      computedTimeoutAt
    ]
  );
  await logEvent(id, 'unified_task_created', createdFrom || source || 'system', assigneeAgent || 'master', null, 'pending_audit', { source, targetStatus });

  const dispatch = await parseAndDispatchTask(id);
  if (!dispatch.ok && !dispatch.skipped) return dispatch;
  if (targetStatus === 'pending_response') {
    const latest = await getTask(id);
    if (latest?.status === 'dispatched') {
      const moved = await transitionTask(id, 'pending_response', 'task_orchestrator', { targetStatus, source });
      return { ...moved, taskId: id, status: (await getTask(id))?.status };
    }
  }
  return { ok: true, taskId: id, status: (await getTask(id))?.status };
}

export async function listBoardTasks({ status, limit = 50 } = {}) {
  const params = [];
  let sql = `SELECT task_id, title, detail, status, source, category, severity, store, current_agent, assignee_agent,
                    timeout_at, created_at, updated_at, last_activity_at, task_intent
             FROM master_tasks WHERE source = 'hrms_task_board'`;
  if (status) {
    params.push(status);
    sql += ` AND status = $${params.length}`;
  }
  params.push(Math.min(Number(limit) || 50, 200));
  sql += ` ORDER BY COALESCE(last_activity_at, updated_at, created_at) DESC LIMIT $${params.length}`;
  const r = await query(sql, params);
  return (r.rows || []).map((row) => ({ ...row, board_status: mapBoardStatus(row.status) }));
}

export async function getBoardTask(taskId) {
  const task = await getTask(taskId);
  if (!task) return null;
  const events = await query(
    `SELECT event_type, from_agent, to_agent, status_before, status_after, payload, created_at
     FROM master_events WHERE task_id = $1 ORDER BY created_at ASC LIMIT 200`,
    [taskId]
  ).catch(() => ({ rows: [] }));
  const evidences = await query(
    `SELECT id, evidence_type, content, file_url, submitted_by, submitted_role, review_status, metadata, created_at
     FROM task_evidences WHERE task_id = $1 ORDER BY created_at DESC LIMIT 100`,
    [taskId]
  ).catch(() => ({ rows: [] }));
  const reviews = await query(
    `SELECT id, decision, comment, reviewed_by, reviewed_role, metadata, created_at
     FROM task_reviews WHERE task_id = $1 ORDER BY created_at DESC LIMIT 50`,
    [taskId]
  ).catch(() => ({ rows: [] }));
  return { ...task, board_status: mapBoardStatus(task.status), events: events.rows || [], evidences: evidences.rows || [], reviews: reviews.rows || [] };
}

export async function addTaskEvidence(taskId, { evidenceType = 'text', content, fileUrl, submittedBy, submittedRole, metadata } = {}) {
  const task = await getTask(taskId);
  if (!task) return { ok: false, error: 'task_not_found' };
  await query(
    `INSERT INTO task_evidences (task_id, evidence_type, content, file_url, submitted_by, submitted_role, metadata)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)`,
    [taskId, evidenceType, content || null, fileUrl || null, submittedBy || null, submittedRole || null, JSON.stringify(metadata || {})]
  );
  await query(
    `UPDATE master_tasks SET
       evidence_refs = COALESCE(evidence_refs, '[]'::jsonb) || $2::jsonb,
       last_activity_at = NOW(), updated_at = NOW()
     WHERE task_id = $1`,
    [taskId, JSON.stringify([{ type: evidenceType, content: content?.slice(0, 200) || null, file_url: fileUrl || null, at: new Date().toISOString() }])]
  );
  await logEvent(taskId, 'evidence_submitted', submittedBy || 'unknown', task.current_agent || task.assignee_agent, task.status, task.status, { evidenceType, hasFile: !!fileUrl });

  if (task.status === 'dispatched') {
    await transitionTask(taskId, 'pending_response', submittedBy || 'task_board', { evidenceSubmitted: true });
  }
  const latest = await getTask(taskId);
  if (latest?.status === 'pending_response') {
    await transitionTask(taskId, 'pending_review', 'task_orchestrator', { evidenceSubmitted: true });
  }
  return { ok: true };
}

export async function reviewBoardTask(taskId, { decision, comment, reviewer, reviewerRole, createRevisionTask = false } = {}) {
  const task = await getTask(taskId);
  if (!task) return { ok: false, error: 'task_not_found' };
  const normalized = String(decision || '').trim();
  if (!['approved', 'rejected'].includes(normalized)) return { ok: false, error: 'invalid_decision' };

  await query(
    `INSERT INTO task_reviews (task_id, decision, comment, reviewed_by, reviewed_role)
     VALUES ($1,$2,$3,$4,$5)`,
    [taskId, normalized, comment || null, reviewer || null, reviewerRole || null]
  );

  if (normalized === 'approved') {
    let current = task.status;
    if (current === 'dispatched') {
      await transitionTask(taskId, 'pending_response', reviewer || 'reviewer', { autoAdvanceForReview: true });
      current = 'pending_response';
    }
    if (current === 'pending_response') {
      await transitionTask(taskId, 'pending_review', 'task_orchestrator', { autoAdvanceForReview: true });
      current = 'pending_review';
    }
    if (current === 'pending_review') {
      await transitionTask(taskId, 'resolved', reviewer || 'reviewer', { reviewResult: { decision: normalized, comment } });
      await transitionTask(taskId, 'pending_settlement', 'task_orchestrator', { reviewResult: { decision: normalized } });
      await transitionTask(taskId, 'settled', 'chief_evaluator', { reviewResult: { decision: normalized } });
      const evidenceR = await query('SELECT COUNT(*)::int AS cnt FROM task_evidences WHERE task_id = $1', [taskId]);
      const evidenceCount = evidenceR.rows?.[0]?.cnt || 0;
      const autoScore = evidenceCount >= 3 ? 8 : evidenceCount >= 1 ? 6 : 4;
      await query('UPDATE master_tasks SET quality_score = $2, review_passed = TRUE, updated_at = NOW() WHERE task_id = $1', [taskId, autoScore]);
      await logEvent(taskId, 'quality_score_auto', 'task_orchestrator', task.assignee_agent, 'pending_review', 'closed', { score: autoScore, reason: 'approved_with_evidence', evidenceCount });
      return transitionTask(taskId, 'closed', 'master', { reviewResult: { decision: normalized, comment } });
    }
    return { ok: false, error: `cannot_approve_from_${task.status}` };
  }

  let current = task.status;
  if (current === 'dispatched') {
    await transitionTask(taskId, 'pending_response', reviewer || 'reviewer', { autoAdvanceForReject: true });
    current = 'pending_response';
  }
  if (current === 'pending_response') {
    await transitionTask(taskId, 'pending_review', 'task_orchestrator', { autoAdvanceForReject: true });
    current = 'pending_review';
  }
  if (current !== 'pending_review') return { ok: false, error: `cannot_reject_from_${task.status}` };
  const rejected = await transitionTask(taskId, 'rejected', reviewer || 'reviewer', { reviewResult: { decision: normalized, comment } });
  if (!rejected.ok) return rejected;
  if (createRevisionTask) {
    const derived = await createBoardTask({
      content: `修订任务：${task.title || task.detail || taskId}\n打回原因：${comment || '未填写'}`,
      priority: task.priority || task.severity || 'medium',
      store: task.store,
      createdBy: reviewer,
      createdByRole: reviewerRole
    });
    if (derived.ok) {
      await query(`UPDATE master_tasks SET parent_task_id = $2, related_task_ids = COALESCE(related_task_ids,'[]'::jsonb) || $3::jsonb WHERE task_id = $1`, [derived.taskId, taskId, JSON.stringify([taskId])]);
      await logEvent(taskId, 'revision_task_created', reviewer || 'reviewer', 'master', 'rejected', 'rejected', { revisionTaskId: derived.taskId });
    }
    return { ok: true, rejected: true, revisionTask: derived };
  }
  return { ok: true, rejected: true };
}

export async function deriveBoardTask(taskId, { content, priority, createdBy, createdByRole } = {}) {
  const task = await getTask(taskId);
  if (!task) return { ok: false, error: 'task_not_found' };
  const derived = await createBoardTask({
    content: content || `衍生任务：${task.title || task.detail || taskId}`,
    priority: priority || task.priority || task.severity || 'medium',
    store: task.store,
    createdBy,
    createdByRole
  });
  if (derived.ok) {
    await query(`UPDATE master_tasks SET parent_task_id = $2, related_task_ids = COALESCE(related_task_ids,'[]'::jsonb) || $3::jsonb WHERE task_id = $1`, [derived.taskId, taskId, JSON.stringify([taskId])]);
    await logEvent(taskId, 'derived_task_created', createdBy || 'unknown', 'master', task.status, task.status, { derivedTaskId: derived.taskId });
  }
  return derived;
}

export async function getBoardSummary() {
  const r = await query(
    `SELECT status, COUNT(*)::int AS count FROM master_tasks WHERE source = 'hrms_task_board' GROUP BY status`
  );
  const out = { total: 0, byStatus: {}, byBoardStatus: {}, overdue: 0 };
  for (const row of (r.rows || [])) {
    out.total += row.count;
    out.byStatus[row.status] = row.count;
    const board = mapBoardStatus(row.status);
    out.byBoardStatus[board] = (out.byBoardStatus[board] || 0) + row.count;
  }
  const overdue = await query(
    `SELECT COUNT(*)::int AS count FROM master_tasks WHERE source = 'hrms_task_board' AND timeout_at < NOW() AND status NOT IN ('closed','settled','resolved')`
  );
  out.overdue = overdue.rows?.[0]?.count || 0;
  return out;
}

export async function runTaskBoardWatchdog({ staleHours = 24 } = {}) {
  const hours = Math.max(1, Math.min(Number(staleHours) || 24, 168));
  const r = await query(
    `SELECT task_id, status FROM master_tasks
     WHERE source = 'hrms_task_board'
       AND status NOT IN ('closed','settled','resolved','escalated')
       AND COALESCE(last_activity_at, updated_at, created_at) < NOW() - ($1::int || ' hours')::interval
     ORDER BY COALESCE(last_activity_at, updated_at, created_at) ASC
     LIMIT 100`,
    [hours]
  );
  const touched = [];
  for (const row of (r.rows || [])) {
    let current = row.status;
    if (current === 'dispatched') {
      const step = await transitionTask(row.task_id, 'pending_response', 'task_watchdog', { staleHours: hours, watchdogAdvance: true });
      if (step.ok) current = 'pending_response';
    }
    if (current === 'pending_dispatch') {
      const step1 = await transitionTask(row.task_id, 'dispatched', 'task_watchdog', { staleHours: hours, watchdogAdvance: true });
      if (step1.ok) {
        const step2 = await transitionTask(row.task_id, 'pending_response', 'task_watchdog', { staleHours: hours, watchdogAdvance: true });
        if (step2.ok) current = 'pending_response';
      }
    }
    const t = current === 'pending_response'
      ? await transitionTask(row.task_id, 'escalated', 'task_watchdog', { staleHours: hours })
      : { ok: false };
    if (t.ok) touched.push(row.task_id);
  }
  return { ok: true, scanned: r.rows?.length || 0, escalated: touched };
}

async function sendTaskCardToAssignee(taskId) {
  try {
    const task = await getTask(taskId);
    if (!task?.store || !task?.assignee_agent) return;
    const users = await query(
      `SELECT open_id FROM feishu_users WHERE store = $1 AND registered = TRUE AND open_id IS NOT NULL LIMIT 5`,
      [task.store]
    ).catch(() => ({ rows: [] }));
    if (!users.rows?.length) {
      logger.info({ taskId, store: task.store }, 'sendTaskCard: no registered feishu users for store');
      return;
    }
    const { sendCard } = await import('./feishu-client.js');
    const priorityEmoji = { high: '🔴', medium: '🟡', low: '🟢' }[task.priority || task.severity || 'medium'] || '⚪';
    const card = {
      config: { wide_screen_mode: true },
      header: {
        title: { tag: 'plain_text', content: `${priorityEmoji} 新任务 · ${task.store}` },
        template: task.priority === 'high' ? 'red' : task.priority === 'low' ? 'green' : 'orange'
      },
      elements: [
        { tag: 'div', text: { tag: 'lark_md', content: `**${task.title || '任务'}**\n${String(task.detail || '').slice(0, 500)}` } },
        { tag: 'hr' },
        {
          tag: 'action',
          actions: [
            { tag: 'button', text: { tag: 'plain_text', content: '已查看' }, type: 'primary', value: { action: 'ack_anomaly', task_id: taskId } },
            { tag: 'button', text: { tag: 'plain_text', content: '开始处理' }, type: 'primary', value: { action: 'start_task', task_id: taskId } },
            { tag: 'button', text: { tag: 'plain_text', content: '回复' }, type: 'default', value: { action: 'reply_anomaly', task_id: taskId } }
          ]
        },
        { tag: 'note', elements: [{ tag: 'plain_text', content: `任务ID：${taskId} · 来源：${task.source || '系统'} · 请及时处理` }] }
      ]
    };
    let sent = 0;
    for (const u of users.rows) {
      try {
        await sendCard(u.open_id, card);
        sent++;
      } catch (e) {
        logger.warn({ taskId, openId: u.open_id, err: e?.message }, 'sendTaskCard: failed to send card to user');
      }
    }
    await logEvent(taskId, 'card_sent', 'task_orchestrator', task.assignee_agent, 'dispatched', 'dispatched', { recipients: users.rows.length, sent });
  } catch (e) {
    logger.error({ taskId, err: e?.message }, 'sendTaskCardToAssignee failed');
  }
}

// ─── Reassign Task Agent ───

export async function reassignTask(taskId, { newAgent, reason, reassignedBy } = {}) {
  const task = await getTask(taskId);
  if (!task) return { ok: false, error: 'task_not_found' };
  const oldAgent = task.assignee_agent || task.current_agent;
  if (!newAgent) return { ok: false, error: 'new_agent_required' };
  await query(
    `UPDATE master_tasks SET assignee_agent = $2, current_agent = $2, last_activity_at = NOW(), updated_at = NOW() WHERE task_id = $1`,
    [taskId, newAgent]
  );
  await query(
    `INSERT INTO task_assignments (task_id, assignee_type, assignee_key, assigned_by, assignment_reason)
     VALUES ($1, 'agent', $2, $3, $4)`,
    [taskId, newAgent, reassignedBy || 'admin', reason || `从 ${oldAgent} 重新分配`]
  ).catch(() => {});
  await logEvent(taskId, 'agent_reassigned', reassignedBy || 'admin', newAgent, task.status, task.status, { oldAgent, newAgent, reason });
  const newTask = await getTask(taskId);
  return { ok: true, taskId, oldAgent, newAgent, task: newTask };
}

// ─── Add Comment to Task ───

export async function addTaskComment(taskId, { content, commentBy, commentRole, commentType = 'note' } = {}) {
  const task = await getTask(taskId);
  if (!task) return { ok: false, error: 'task_not_found' };
  await query(
    `INSERT INTO task_evidences (task_id, evidence_type, content, submitted_by, submitted_role, metadata)
     VALUES ($1, 'comment', $2, $3, $4, $5::jsonb)`,
    [taskId, content || null, commentBy || 'unknown', commentRole || null, JSON.stringify({ comment_type: commentType })]
  );
  await query(`UPDATE master_tasks SET last_activity_at = NOW(), updated_at = NOW() WHERE task_id = $1`, [taskId]);
  await logEvent(taskId, 'comment_added', commentBy || 'unknown', task.current_agent || task.assignee_agent, task.status, task.status, { content: String(content || '').slice(200), commentType });
  return { ok: true };
}

// ─── Set Quality Score ───

export async function setTaskQualityScore(taskId, { score, scoredBy } = {}) {
  if (score === undefined || score === null) return { ok: false, error: 'score_required' };
  const s = Math.max(0, Math.min(10, Number(score)));
  await query(
    `UPDATE master_tasks SET quality_score = $2, updated_at = NOW() WHERE task_id = $1`,
    [taskId, s]
  );
  await logEvent(taskId, 'quality_score_set', scoredBy || 'system', null, null, null, { score: s });
  return { ok: true, taskId, qualityScore: s };
}

// ─── Agent Auto-Claim ───

export async function claimNextTask(agentKey) {
  const candidate = await query(
    `SELECT task_id, title, store, category, detail, source FROM master_tasks
     WHERE status = 'dispatched'
       AND (assignee_agent = $1 OR assignee_agent IS NULL)
     ORDER BY priority ASC NULLS LAST, created_at ASC
     LIMIT 1
     FOR UPDATE SKIP LOCKED`,
    [agentKey]
  );
  if (!candidate.rows?.[0]) return { ok: true, claimed: false, reason: 'no_available_tasks' };
  const taskId = candidate.rows[0].task_id;
  const updateResult = await query(
    `UPDATE master_tasks SET
       current_agent = $2, assignee_agent = $2,
       status = 'in_progress',
       last_activity_at = NOW(), updated_at = NOW()
     WHERE task_id = $1`,
    [taskId, agentKey]
  );
  if (!updateResult.rowCount) return { ok: true, claimed: false, reason: 'concurrent_claim' };
  await query(
    `INSERT INTO task_assignments (task_id, assignee_type, assignee_key, assigned_by, assignment_reason)
     VALUES ($1, 'agent', $2, 'auto_claim', 'agent auto-claimed')`,
    [taskId, agentKey]
  ).catch(() => {});
  await logEvent(taskId, 'agent_auto_claimed', agentKey, agentKey, 'dispatched', 'in_progress', { agentKey });
  return { ok: true, claimed: true, task: candidate.rows[0] };
}

// ─── Log Task Completion Experience ───

export async function logTaskExperience(taskId) {
  const task = await getTask(taskId);
  if (!task || task.status !== 'closed') return null;
  const evidenceR = await query('SELECT COUNT(*)::int AS cnt FROM task_evidences WHERE task_id = $1', [taskId]);
  const evidenceCount = evidenceR.rows?.[0]?.cnt || 0;
  const timeToClose = task.closed_at && task.created_at
    ? Math.round((new Date(task.closed_at).getTime() - new Date(task.created_at).getTime()) / 3600000 * 100) / 100
    : null;
  const row = await query(
    `INSERT INTO task_experience_logs (category, store, title_pattern, assignee_agent, resolution_code, quality_score, time_to_close_hours, review_passed, evidence_count, reminder_count, was_escalated)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     RETURNING id`,
    [
      task.category || 'general',
      task.store,
      String(task.title || '').slice(0, 100),
      task.assignee_agent,
      task.resolution_code,
      task.quality_score,
      timeToClose,
      task.review_passed || null,
      evidenceCount,
      task.remind_count || 0,
      (task.escalation_level || 0) > 0
    ]
  ).catch(() => ({ rows: [] }));
  return row.rows?.[0] || null;
}

// ─── Send Task Reminders (called by reminder queue) ───

export async function sendTaskReminders(taskId, agent) {
  const task = await getTask(taskId);
  if (!task || ['closed', 'settled', 'resolved'].includes(task.status)) return { ok: true, skipped: true };
  const overdue = task.timeout_at && new Date(task.timeout_at) < new Date();
  if (!overdue && task.status === 'in_progress') return { ok: true, skipped: true };
  try {
    const { pushRhythmReport } = await import('./feishu-client.js');
    const label = overdue ? '逾期' : '待处理';
    await pushRhythmReport(`⏰ 任务提醒：${task.store || ''} ${task.title || taskId} [${label}] 状态=${task.status} Agent=${task.assignee_agent || agent || '?'}`).catch(() => {});
  } catch {}
  await query(`UPDATE master_tasks SET remind_count = COALESCE(remind_count, 0) + 1, last_activity_at = NOW() WHERE task_id = $1`, [taskId]);
  await logEvent(taskId, 'reminder_sent', 'reminder_queue', task.assignee_agent, task.status, task.status, { agent, overdue });
  return { ok: true };
}

// ─── Summarize Task On Close (called by summary queue) ───

export async function summarizeTaskOnClose(taskId) {
  const task = await getTask(taskId);
  if (!task) return null;
  const experience = await logTaskExperience(taskId);
  if (!experience) return null;
  await logEvent(taskId, 'experience_logged', 'summary_queue', task.assignee_agent, 'closed', 'closed', { experienceId: experience.id });
  return experience;
}

// ─── Find Similar Tasks (experience reuse) ───

export async function findSimilarTasks({ category, store, limit = 5 } = {}) {
  if (!category) return [];
  const r = await query(
    `SELECT id, category, store, title_pattern, assignee_agent, resolution_code,
            quality_score, time_to_close_hours, review_passed, evidence_count, was_escalated, created_at
     FROM task_experience_logs
     WHERE category = $1 AND ($2::text IS NULL OR store = $2)
     ORDER BY quality_score DESC NULLS LAST, created_at DESC
     LIMIT $3`,
    [category, store || null, Math.min(limit, 20)]
  );
  return r.rows || [];
}

// ─── Standardized Agent Feedback Template ───

export function buildAgentFeedback(taskId, { executionSummary, currentStatus, agentJudgment, riskPoints, suggestedAction, evidenceSummary } = {}) {
  return {
    taskId,
    feedbackVersion: '1.0',
    generatedAt: new Date().toISOString(),
    executionSummary: executionSummary || '',
    currentStatus: currentStatus || 'in_progress',
    agentJudgment: agentJudgment || null,
    riskPoints: riskPoints || [],
    suggestedAction: suggestedAction || null,
    evidenceSummary: evidenceSummary || null
  };
}

export async function submitAgentFeedback(taskId, feedback) {
  const task = await getTask(taskId);
  if (!task) return { ok: false, error: 'task_not_found' };
  const structured = buildAgentFeedback(taskId, feedback);
  await query(
    `UPDATE master_tasks SET source_data = COALESCE(source_data, '{}'::jsonb) || $2::jsonb, last_activity_at = NOW(), updated_at = NOW() WHERE task_id = $1`,
    [taskId, JSON.stringify({ agent_feedback: structured })]
  );
  await logEvent(taskId, 'agent_feedback_submitted', feedback.agentJudgment || 'unknown', task.assignee_agent, task.status, task.status, structured);
  return { ok: true };
}

// ─── Get Task Metrics ───

export async function getTaskMetrics({ days = 7 } = {}) {
  const d = Math.max(1, Math.min(Number(days) || 7, 365));
  const interval = `${d} days`;
  const [statusCounts, avgCloseTime, evidenceCoverage, qualityAvg, bySource, byCategory] = await Promise.all([
    query(`SELECT status, COUNT(*)::int AS cnt FROM master_tasks WHERE created_at >= NOW() - INTERVAL '${interval}' GROUP BY status ORDER BY cnt DESC`).catch(() => ({ rows: [] })),
    query(`SELECT AVG(EXTRACT(EPOCH FROM (closed_at - created_at)) / 3600)::numeric(10,2) AS avg_hours FROM master_tasks WHERE closed_at IS NOT NULL AND created_at >= NOW() - INTERVAL '${interval}'`).catch(() => ({ rows: [] })),
    query(`SELECT COUNT(*) FILTER (WHERE evidence_refs IS NOT NULL AND evidence_refs::text != '[]')::int AS with_evidence, COUNT(*)::int AS total FROM master_tasks WHERE created_at >= NOW() - INTERVAL '${interval}' AND status IN ('closed','settled','resolved')`).catch(() => ({ rows: [] })),
    query(`SELECT AVG(quality_score)::numeric(10,2) AS avg_quality FROM master_tasks WHERE quality_score IS NOT NULL AND created_at >= NOW() - INTERVAL '${interval}'`).catch(() => ({ rows: [] })),
    query(`SELECT source, COUNT(*)::int AS cnt FROM master_tasks WHERE created_at >= NOW() - INTERVAL '${interval}' GROUP BY source ORDER BY cnt DESC`).catch(() => ({ rows: [] })),
    query(`SELECT category, COUNT(*)::int AS cnt, AVG(quality_score)::numeric(10,2) AS avg_quality FROM master_tasks WHERE created_at >= NOW() - INTERVAL '${interval}' GROUP BY category ORDER BY cnt DESC`).catch(() => ({ rows: [] }))
  ]);
  return {
    period: `last_${d}_days`,
    statusCounts: Object.fromEntries((statusCounts.rows || []).map((r) => [r.status, r.cnt])),
    avgCloseTimeHours: avgCloseTime.rows?.[0]?.avg_hours || null,
    evidenceCoverage: evidenceCoverage.rows?.[0] ? `${evidenceCoverage.rows[0].with_evidence}/${evidenceCoverage.rows[0].total}` : null,
    avgQuality: qualityAvg.rows?.[0]?.avg_quality || null,
    bySource: Object.fromEntries((bySource.rows || []).map((r) => [r.source, r.cnt])),
    byCategory: (byCategory.rows || []).map((r) => ({ category: r.category, count: r.cnt, avgQuality: r.avg_quality }))
  };
}
