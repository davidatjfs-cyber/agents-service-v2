import { query } from '../utils/db.js';
import { logger } from '../utils/logger.js';
import { createTask, transitionTask, getTask, logEvent } from './task-state-machine.js';
import { parseTaskText, mapBoardStatus } from './task-parser.js';
import { dispatchTaskAsync } from './master-agent-dispatcher.js';
import { enrichFromTemplate } from './task-templates.js';
import { resolveAgentCanonicalStore } from '../config/store-mapping.js';
import { findRegisteredFeishuUsersForStoreManagers } from '../utils/feishu-assignee-resolve.js';

/** 已在业务侧发过「定时/抽检/BI 告警」卡片的来源，不再由任务板派发重复「整改任务」卡 */
const SOURCES_SKIP_DUPLICATE_RECTIFICATION_CARD = new Set(['scheduled_inspection', 'random_inspection', 'bi_anomaly']);

export async function createBoardTask({ content, priority, store, deadline, createdBy, createdByRole }) {
  const text = String(content || '').trim();
  if (!text) return { ok: false, error: 'content_required' };

  const seed = parseTaskText(text, { priority, store });
  const boardStore =
    resolveAgentCanonicalStore(String(seed.store || '').trim()) || String(seed.store || '').trim();
  const seedMeta = { ...seed, store: boardStore };
  const result = await createTask({
    source: 'hrms_task_board',
    category: seed.category,
    severity: priority || seed.priority || 'medium',
    store: boardStore,
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
    [result.taskId, priority || seed.priority || 'medium', JSON.stringify(seedMeta)]
  ).catch((e) => logger.warn({ err: e?.message, taskId: result.taskId }, 'board task metadata update failed'));

  const { enqueueTaskParse } = await import('./task-board-queue.js');
  const enqueue = await enqueueTaskParse(result.taskId);
  return { ok: true, taskId: result.taskId, boardStatus: '待解析', enqueue };
}

export async function parseAndDispatchTask(taskId) {
  const task = await getTask(taskId);
  if (!task) return { ok: false, error: 'task_not_found' };
  if (task.status === 'pending_dispatch') {
    const decision = await dispatchTaskAsync({
      category: task.category,
      store: task.store,
      priority: task.priority || task.severity,
      title: task.title,
      detail: task.detail
    });
    await query(
      `UPDATE master_tasks SET assignee_agent = $2, current_agent = $2, last_activity_at = NOW(), updated_at = NOW() WHERE task_id = $1`,
      [taskId, decision.assigneeAgent]
    );
    const dispatched = await transitionTask(taskId, 'dispatched', 'master', { dispatch: decision, reDispatch: true });
    if (dispatched.ok) {
      const { enqueueTaskExecution } = await import('./task-board-queue.js');
      await enqueueTaskExecution(taskId, { agent: decision.assigneeAgent, source: 're_dispatch' });
    }
    return dispatched;
  }
  if (!['pending_audit', 'pending_dispatch'].includes(task.status)) return { ok: true, skipped: true, status: task.status };

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
    const { enqueueTaskExecution } = await import('./task-board-queue.js');
    await enqueueTaskExecution(taskId, { agent: decision.assigneeAgent, source: 'parse_dispatch' });
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
  const storeNorm = resolveAgentCanonicalStore(String(store || '').trim()) || String(store || '').trim();
  const result = await createTask({
    taskId,
    source: source || 'system',
    category,
    severity,
    store: storeNorm,
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
                    timeout_at, created_at, updated_at, last_activity_at
             FROM master_tasks WHERE source = 'hrms_task_board'`;
  if (status) {
    const statuses = String(status).split(',').map((s) => s.trim()).filter(Boolean);
    if (statuses.length === 1) {
      params.push(statuses[0]);
      sql += ` AND status = $${params.length}`;
    } else if (statuses.length > 1) {
      params.push(statuses);
      sql += ` AND status = ANY($${params.length}::text[])`;
    }
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

  const source = String(task.source || '').trim();
  const role = String(submittedRole || '').trim();
  const isStoreReply = source === 'hrms_task_board' && ['feishu_user', 'store_manager', 'store_production_manager', 'store', 'bitable'].includes(role);
  if (isStoreReply) {
    if (task.status === 'dispatched' || task.status === 'viewed') {
      await transitionTask(taskId, 'in_progress', submittedBy || 'store', { storeReplyReceived: true, evidenceSubmitted: true });
    }
    const latestStore = await getTask(taskId);
    if (latestStore?.status === 'in_progress') {
      await transitionTask(taskId, 'waiting_evidence', 'task_orchestrator', { storeReplyReceived: true, trackingRequired: true });
    }
    setImmediate(() => evaluateBoardTaskAfterStoreFeedback(taskId).catch((e) => logger.warn({ taskId, err: e?.message }, 'store feedback evaluation failed')));
  } else {
    if (task.status === 'dispatched') {
      await transitionTask(taskId, 'pending_response', submittedBy || 'task_board', { evidenceSubmitted: true });
    }
    const latest = await getTask(taskId);
    if (latest?.status === 'pending_response') {
      await transitionTask(taskId, 'pending_review', 'task_orchestrator', { evidenceSubmitted: true });
    }
  }
  return { ok: true };
}

export async function reviewBoardTask(taskId, { decision, comment, reviewer, reviewerRole, createRevisionTask = false } = {}) {
  const task = await getTask(taskId);
  if (!task) return { ok: false, error: 'task_not_found' };
  const normalized = String(decision || '').trim();
  if (!['approved', 'rejected'].includes(normalized)) return { ok: false, error: 'invalid_decision' };

  if (task.status === 'closed') {
    return { ok: true, skipped: true, reason: 'already_closed' };
  }

  await query(
    `INSERT INTO task_reviews (task_id, decision, comment, reviewed_by, reviewed_role)
     VALUES ($1,$2,$3,$4,$5)`,
    [taskId, normalized, comment || null, reviewer || null, reviewerRole || null]
  );

  if (normalized === 'approved') {
    let current = (await getTask(taskId)).status;
    // 仅补齐状态机缺口：waiting_evidence 允许进入待验收，再走原有 dispatched→pending_response→pending_review→结案 链
    if (current === 'waiting_evidence') {
      const bridged = await transitionTask(taskId, 'pending_review', reviewer || 'task_orchestrator', { bridgeFromWaitingEvidence: true });
      if (!bridged.ok) return bridged;
      current = 'pending_review';
    }
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
    return { ok: false, error: `cannot_approve_from_${current}` };
  }

  let current = (await getTask(taskId)).status;
  if (current === 'waiting_evidence') {
    const bridged = await transitionTask(taskId, 'pending_review', reviewer || 'task_orchestrator', { bridgeFromWaitingEvidenceReject: true });
    if (!bridged.ok) return bridged;
    current = 'pending_review';
  }
  if (current === 'dispatched') {
    await transitionTask(taskId, 'pending_response', reviewer || 'reviewer', { autoAdvanceForReject: true });
    current = 'pending_response';
  }
  if (current === 'pending_response') {
    await transitionTask(taskId, 'pending_review', 'task_orchestrator', { autoAdvanceForReject: true });
    current = 'pending_review';
  }
  if (current !== 'pending_review') return { ok: false, error: `cannot_reject_from_${current}` };
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

/** 仅清理测试/历史：直接结案，不走验收闭环（避免改变正常任务的 settle/score 业务流程） */
export async function bulkCloseOpenHrmsBoardTasks({ reviewer = 'admin', comment = '管理员批量关闭（测试任务清理）', confirm } = {}) {
  if (confirm !== 'bulk_close_hrms_board_open') {
    return { ok: false, error: 'confirmation_required', hint: 'Set confirm to bulk_close_hrms_board_open' };
  }
  const sel = await query(
    `SELECT task_id, status FROM master_tasks WHERE source = 'hrms_task_board' AND status <> 'closed' ORDER BY created_at ASC LIMIT 500`,
    []
  );
  const rows = sel.rows || [];
  if (!rows.length) return { ok: true, closed: 0, note: 'no_open_tasks' };

  const upd = await query(
    `UPDATE master_tasks
     SET status = 'closed',
         closed_at = COALESCE(closed_at, NOW()),
         updated_at = NOW(),
         review_passed = COALESCE(review_passed, TRUE),
         quality_score = COALESCE(quality_score, 4)
     WHERE source = 'hrms_task_board' AND status <> 'closed'`,
    []
  );

  const closed = Number(upd.rowCount ?? rows.length) || rows.length;
  for (const row of rows) {
    await logEvent(row.task_id, 'admin_bulk_closed', reviewer || 'admin', null, row.status, 'closed', { comment, sqlCleanup: true }).catch(() => {});
  }
  return { ok: true, closed, note: 'sql_cleanup_only_not_review_flow', sampleTaskIds: rows.slice(0, 25).map((r) => r.task_id) };
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
  const out = { total: 0, byStatus: {}, byBoardStatus: {}, overdue: 0, stale: 0 };
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
  const stale = await query(
    `SELECT COUNT(*)::int AS count FROM master_tasks WHERE source = 'hrms_task_board' AND status IN ('pending_dispatch','dispatched','pending_response') AND COALESCE(last_activity_at, updated_at, created_at) < NOW() - INTERVAL '4 hours'`
  );
  out.stale = stale.rows?.[0]?.count || 0;
  return out;
}

export async function runTaskBoardWatchdog({ staleHours = 24 } = {}) {
  const hours = Math.max(1, Math.min(Number(staleHours) || 24, 168));
  const r = await query(
    `SELECT task_id, status, assignee_agent, current_agent, source FROM master_tasks
     WHERE source IN ('hrms_task_board', 'proactive_llm')
        AND status IN ('dispatched','pending_response','in_progress')
        AND COALESCE(last_activity_at, updated_at, created_at) < NOW() - ($1::int || ' hours')::interval
       AND (last_reminder_at IS NULL OR last_reminder_at < NOW() - INTERVAL '1 hour')
     ORDER BY COALESCE(last_activity_at, updated_at, created_at) ASC
     LIMIT 100`,
    [hours]
  );
  const touched = [];
  for (const row of (r.rows || [])) {
    if (row.source === 'proactive_llm') {
      const task = await getTask(row.task_id);
      const timeoutAt = task?.timeout_at || task?.source_data?.timeout_at;
      if (timeoutAt && new Date(timeoutAt) < new Date()) {
        await query(`UPDATE master_tasks SET status = 'closed', updated_at = NOW(), last_activity_at = NOW() WHERE task_id = $1`, [row.task_id]);
        await logEvent(row.task_id, 'auto_closed', 'task_watchdog', 'system', row.status, 'closed', { reason: 'proactive_llm expired timeout' });
        touched.push(row.task_id);
        continue;
      }
    }
    const reminder = await sendTaskReminders(row.task_id, row.assignee_agent || row.current_agent || 'task_watchdog');
    if (reminder.ok && !reminder.skipped) touched.push(row.task_id);
  }
  return { ok: true, scanned: r.rows?.length || 0, remindedOrFiled: touched };
}

/** 将 master_tasks.store 归一为与 daily_reports / feishu_users 一致的规范店名 */
async function normalizeTaskStoreInDb(taskId, task) {
  if (!task?.store) return { canon: '', task };
  const raw = String(task.store).trim();
  const canon = resolveAgentCanonicalStore(raw) || raw;
  if (canon && canon !== raw) {
    await query(`UPDATE master_tasks SET store = $1, updated_at = NOW() WHERE task_id = $2`, [canon, taskId]).catch((e) =>
      logger.warn({ err: e?.message, taskId }, 'canonicalize master_tasks.store failed')
    );
    return { canon, task: { ...task, store: canon } };
  }
  return { canon, task };
}

async function sendTaskCardToAssignee(taskId, { reminder = false, reminderCount = 0, trend = null } = {}) {
  try {
    const task0 = await getTask(taskId);
    if (!task0?.store || !task0?.assignee_agent) return;
    const { canon, task } = await normalizeTaskStoreInDb(taskId, task0);
    if (!canon) return;

    const { rows: mgrRows } = await findRegisteredFeishuUsersForStoreManagers(canon, { limit: 16 });
    const users = { rows: mgrRows.map((r) => ({ open_id: r.open_id, role: r.role })) };
    if (!users.rows?.length) {
      const raw = String(task0.store || '').trim();
      logger.info({ taskId, rawStore: raw, canon }, 'sendTaskCard: no registered feishu users for store');
      const aliasNote = raw && raw !== canon ? `（录入「${raw}」已归一为规范店名）` : '';
      await notifyAdminsBoardIssue(
        `⚠️ Agent任务无法派发：门店未绑定飞书负责人\n门店：${canon}${aliasNote}\n任务：${task.title || taskId}\n任务ID：${taskId}`
      );
      return;
    }
    const { sendCard } = await import('./feishu-client.js');
    const priorityEmoji = { high: '🔴', medium: '🟡', low: '🟢' }[task.priority || task.severity || 'medium'] || '⚪';
    const trendText = trend
      ? `\n\n**出品问题趋势**：近3天问题 ${trend.currentIssueCount} 条 / 总记录 ${trend.currentTotalCount} 条；前3天问题 ${trend.previousIssueCount} 条 / 总记录 ${trend.previousTotalCount} 条；判断：${trend.label}`
      : '';
    const required = `\n\n**请门店必须回复**：\n1. 具体整改方案\n2. 完成时间\n3. 责任人\n4. 现场照片/文件证据（可在飞书回复或管理端补充）`;
    const card = {
      config: { wide_screen_mode: true },
      header: {
        title: { tag: 'plain_text', content: `${priorityEmoji} ${reminder ? `第${reminderCount}次催办` : '整改任务'} · ${canon}` },
        template: reminder ? 'red' : (task.priority === 'high' ? 'red' : task.priority === 'low' ? 'green' : 'orange')
      },
      elements: [
        { tag: 'div', text: { tag: 'lark_md', content: `**${task.title || '任务'}**\n${String(task.detail || '').slice(0, 500)}${trendText}${required}` } },
        { tag: 'hr' },
        {
          tag: 'action',
          actions: [
            {
              tag: 'button',
              text: { tag: 'plain_text', content: '已收到' },
              type: 'primary',
              value: JSON.stringify({ action: 'ack_anomaly', task_id: taskId })
            },
            {
              tag: 'button',
              text: { tag: 'plain_text', content: '开始整改' },
              type: 'primary',
              value: JSON.stringify({ action: 'start_task', task_id: taskId })
            },
            {
              tag: 'button',
              text: { tag: 'plain_text', content: '提交整改方案' },
              type: 'default',
              value: JSON.stringify({ action: 'reply_anomaly', task_id: taskId })
            }
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
    await logEvent(taskId, reminder ? 'reminder_card_sent' : 'card_sent', 'task_orchestrator', task.assignee_agent, task.status, task.status, { recipients: users.rows.length, sent, reminder, reminderCount, trend });
    return { recipients: users.rows.length, sent };
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

export async function executeBoardTask(taskId, { agent } = {}) {
  const task = await getTask(taskId);
  if (!task) return { ok: false, error: 'task_not_found' };
  if (!taskId || !String(taskId).trim()) return { ok: false, error: 'task_id_required' };
  if (['closed', 'settled', 'resolved', 'pending_review', 'rejected', 'hr_filed'].includes(task.status)) {
    return { ok: true, skipped: true, taskId, status: task.status };
  }
  const agentKey = agent || task.assignee_agent || task.current_agent || 'general_agent';
  if (task.status !== 'dispatched' && task.status !== 'viewed') {
    return { ok: true, skipped: true, taskId, status: task.status, reason: `not_dispatchable_from_${task.status}` };
  }
  const { canon } = await normalizeTaskStoreInDb(taskId, task);
  const trend = await getProductionIssueTrend(canon || task.store);
  let sent = { skipped: true, reason: 'noop', recipients: 0, sent: 0 };
  if (SOURCES_SKIP_DUPLICATE_RECTIFICATION_CARD.has(String(task.source || '').trim())) {
    sent = { skipped: true, reason: 'operational_feishu_card_already_sent', recipients: 0, sent: 0 };
    logger.info({ taskId, source: task.source }, 'executeBoardTask: skip duplicate rectification card (source has primary operational card)');
  } else {
    sent = (await sendTaskCardToAssignee(taskId, { reminder: false, trend })) || sent;
  }
  await query(
    `UPDATE master_tasks SET
       source_data = COALESCE(source_data, '{}'::jsonb) || $2::jsonb,
       last_activity_at = NOW(), updated_at = NOW()
     WHERE task_id = $1`,
    [taskId, JSON.stringify({ board_tracking: { agentKey, trend, dispatchedToStoreAt: new Date().toISOString(), cardSent: sent } })]
  );
  await logEvent(taskId, 'store_task_card_dispatched', agentKey, task.store || 'store', task.status, task.status, { trend, sent });
  return { ok: true, taskId, agent: agentKey, status: (await getTask(taskId))?.status, sent, trend };
}

async function buildAgentInvestigation(task, agentKey) {
  const category = String(task?.category || 'general');
  const store = String(task?.store || '').trim();
  const title = String(task?.title || task?.detail || task?.task_id || '任务');
  const findings = [];
  const sources = [];

  const anomalyRows = await query(
    `SELECT anomaly_key, severity, trigger_date, trigger_value, status, created_at
     FROM anomaly_triggers
     WHERE ($1::text = '' OR store ILIKE '%' || $1 || '%')
       AND created_at >= NOW() - INTERVAL '14 days'
     ORDER BY created_at DESC LIMIT 10`,
    [store]
  ).catch(() => ({ rows: [] }));
  if (anomalyRows.rows?.length) {
    sources.push(`异常记录 ${anomalyRows.rows.length} 条`);
    findings.push('近14天异常: ' + anomalyRows.rows.slice(0, 5).map(r => `${r.anomaly_key}/${r.severity || '-'}(${formatTaskDate(r.trigger_date || r.created_at)})`).join('；'));
  }

  if (category === 'food_quality' || agentKey === 'food_quality') {
    const genericRows = await query(
      `SELECT config_key, fields, created_at
       FROM feishu_generic_records
       WHERE config_key IN ('material_majixian','material_hongchao','bad_review')
         AND ($1::text = '' OR fields::text ILIKE '%' || $1 || '%')
         AND created_at >= NOW() - INTERVAL '14 days'
       ORDER BY created_at DESC LIMIT 10`,
      [store]
    ).catch(() => ({ rows: [] }));
    if (genericRows.rows?.length) {
      sources.push(`飞书食安/差评记录 ${genericRows.rows.length} 条`);
      findings.push('近14天飞书记录: ' + genericRows.rows.slice(0, 5).map(r => `${r.config_key}(${formatTaskDate(r.created_at)})`).join('；'));
    }
  }

  const similarRows = await query(
    `SELECT task_id, title, status, created_at
     FROM master_tasks
     WHERE task_id <> $1
       AND ($2::text = '' OR store ILIKE '%' || $2 || '%')
       AND ($3::text = '' OR category = $3)
       AND created_at >= NOW() - INTERVAL '30 days'
     ORDER BY created_at DESC LIMIT 5`,
    [task.task_id, store, category]
  ).catch(() => ({ rows: [] }));
  if (similarRows.rows?.length) {
    sources.push(`历史同类任务 ${similarRows.rows.length} 条`);
    findings.push('近30天同类任务: ' + similarRows.rows.map(r => `${r.title || r.task_id}/${r.status}`).join('；'));
  }

  if (!findings.length) findings.push('未在近14天异常、飞书记录或近30天同类任务中检索到可直接关联的数据，需要门店补充现场照片/批次/菜品信息。');
  const suggestedAction = category === 'food_quality'
    ? '请门店补充具体菜品、批次、出品时间和现场照片；食安专员按批次/原料/操作流程复核。'
    : '请责任人按任务要求补充执行说明和现场证据，管理员复核后关闭。';
  const summary = `${agentNameZh(agentKey)}已完成自动核查：${findings.join(' ')} 当前建议进入管理员验收/追问。`;
  return {
    summary,
    riskPoints: findings,
    suggestedAction,
    evidenceSummary: sources.length ? sources.join('；') : '无直接命中数据源',
    content: [
      `执行Agent：${agentNameZh(agentKey)}(${agentKey})`,
      `核查任务：${title}`,
      `核查门店：${store || '-'}`,
      `核查类型：${category}`,
      `实际动作：查询近14天异常记录、相关飞书业务记录、近30天同类任务。`,
      `核查结果：${findings.join(' ')}`,
      `下一步建议：${suggestedAction}`
    ].join('\n'),
    metadata: { agentKey, category, store, sources, findingCount: findings.length, executedAt: new Date().toISOString() }
  };
}

export async function evaluateBoardTaskAfterStoreFeedback(taskId) {
  const task = await getTask(taskId);
  if (!task || task.source !== 'hrms_task_board') return { ok: true, skipped: true };
  const trend = await getProductionIssueTrend(task.store);
  const improved = trend.currentIssueCount < trend.previousIssueCount || (trend.previousIssueCount > 0 && trend.currentIssueCount === 0);
  const enoughData = trend.currentIssueCount + trend.previousIssueCount > 0;
  if (improved && enoughData) {
    const summary = `${agentNameZh(task.assignee_agent || task.current_agent)}跟踪结果：${task.store || '-'}出品问题已有改善，近3天问题${trend.currentIssueCount}条/总记录${trend.currentTotalCount}条，前3天问题${trend.previousIssueCount}条/总记录${trend.previousTotalCount}条。已收到门店整改反馈，建议管理员验收。`;
    await submitAgentFeedback(taskId, {
      executionSummary: summary,
      currentStatus: 'pending_review',
      agentJudgment: task.assignee_agent || task.current_agent || 'agent',
      riskPoints: [`出品问题趋势：${trend.label}`],
      suggestedAction: '管理员可结合门店整改方案和现场证据进行验收。',
      evidenceSummary: trend.summary
    });
    await addTaskEvidence(taskId, {
      evidenceType: 'agent_followup',
      content: summary,
      submittedBy: task.assignee_agent || 'agent',
      submittedRole: 'agent',
      metadata: { trend, improved: true }
    });
    const latest = await getTask(taskId);
    if (latest?.status === 'waiting_evidence' || latest?.status === 'in_progress') {
      const r1 = await transitionTask(taskId, 'pending_response', task.assignee_agent || 'agent', { agentFollowup: true, trend });
      if (!r1.ok) return r1;
    }
    const after = await getTask(taskId);
    if (after?.status === 'pending_response') {
      const r2 = await transitionTask(taskId, 'pending_review', 'task_orchestrator', { agentFollowup: true, trend });
      if (!r2.ok) return r2;
    }
    await logEvent(taskId, 'agent_trend_improved', task.assignee_agent || 'agent', 'admin', task.status, (await getTask(taskId))?.status, { trend });
    return { ok: true, improved: true, trend };
  }

  const current = await getTask(taskId);
  const prevStatus = current?.status || task.status;

  const notImprovedSummary = `${agentNameZh(task.assignee_agent || task.current_agent)}跟踪结果：${task.store || '-'}出品问题${enoughData ? '未明显改善' : '数据不足无法判断'}。近3天问题${trend.currentIssueCount}条/总记录${trend.currentTotalCount}条，前3天问题${trend.previousIssueCount}条/总记录${trend.previousTotalCount}条，${trend.label}。已要求门店重新提交整改方案。`;
  await submitAgentFeedback(taskId, {
    executionSummary: notImprovedSummary,
    currentStatus: 'pending_response',
    agentJudgment: task.assignee_agent || task.current_agent || 'agent',
    riskPoints: [`出品问题趋势：${trend.label}`, enoughData ? '当前整改方案未达到预期效果' : '整改效果数据不足以判断'],
    suggestedAction: '门店需重新提交整改方案，Agent继续跟踪趋势。',
    evidenceSummary: trend.summary
  });

  if (['waiting_evidence', 'in_progress', 'pending_response'].includes(prevStatus)) {
    await transitionTask(taskId, 'pending_response', task.assignee_agent || 'agent', { agentFollowup: true, trend, notImproved: true });
  }

  const msgBody = `【任务跟踪】${task.store || '-'}「${task.title || ''}」\n\n系统评估：您提交的执行计划经数据对比${enoughData ? '未达到预期效果' : '数据不足以判断效果'}。\n${trend.summary}\n\n请重新提交整改方案（须包含：具体措施、完成时间、责任人、现场照片）。`;
  try {
    const { sendCompanyNoticeToAssignees } = await import('./feishu-client.js');
    await sendCompanyNoticeToAssignees(task, msgBody, {
      title: `整改计划需重新提交 · ${task.store || ''}`,
      type: 'task_plan_rejected'
    }).catch(() => {});
  } catch (e) {
    logger.warn({ taskId, err: e?.message }, 'evaluateBoardTask: sendCompanyNotice failed');
  }

  await notifyAdminsBoardIssue(`📋 Agent评估：门店整改方案未达预期\n门店：${task.store || '-'}\n任务：${task.title || taskId}\n任务ID：${taskId}\n${trend.summary}\n已通知门店重新提交整改方案，Agent将继续跟踪。`);

  await logEvent(taskId, 'agent_trend_not_improved', task.assignee_agent || 'agent', task.store || 'store', prevStatus, 'pending_response', { trend, adminNotified: true });
  return { ok: true, improved: false, trend };
}

export async function getProductionIssueTrend(store) {
  const s = String(store || '').trim();
  const params = [s];
  const countSql = `
    SELECT
      COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '3 days')::int AS current_total_count,
      COUNT(*) FILTER (WHERE created_at < NOW() - INTERVAL '3 days' AND created_at >= NOW() - INTERVAL '6 days')::int AS previous_total_count,
      COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '3 days' AND ${productionIssueWhereSql()})::int AS current_issue_count,
      COUNT(*) FILTER (WHERE created_at < NOW() - INTERVAL '3 days' AND created_at >= NOW() - INTERVAL '6 days' AND ${productionIssueWhereSql()})::int AS previous_issue_count
    FROM feishu_generic_records
    WHERE config_key IN ('table_visit','bad_review','material_majixian','material_hongchao')
      AND ($1::text = '' OR fields::text ILIKE '%' || $1 || '%')
      AND created_at >= NOW() - INTERVAL '6 days'`;
  const r = await query(countSql, params).catch(() => ({ rows: [] }));
  const currentTotalCount = Number(r.rows?.[0]?.current_total_count || 0);
  const previousTotalCount = Number(r.rows?.[0]?.previous_total_count || 0);
  const currentIssueCount = Number(r.rows?.[0]?.current_issue_count || 0);
  const previousIssueCount = Number(r.rows?.[0]?.previous_issue_count || 0);
  let direction = 'flat';
  if (currentIssueCount < previousIssueCount) direction = 'down';
  if (currentIssueCount > previousIssueCount) direction = 'up';
  const label = direction === 'down' ? '减少/改善' : direction === 'up' ? '增加/未改善' : '持平/需继续观察';
  return { store: s, currentTotalCount, previousTotalCount, currentIssueCount, previousIssueCount, direction, label, summary: `近3天问题${currentIssueCount}条/总记录${currentTotalCount}条，前3天问题${previousIssueCount}条/总记录${previousTotalCount}条，${label}` };
}

function productionIssueWhereSql() {
  return `(
    (config_key = 'table_visit' AND fields::text ILIKE '%"今天用餐是否满意": "不满意"%') OR
    (config_key = 'bad_review') OR
    (config_key IN ('material_majixian','material_hongchao') AND fields::text ILIKE '%"今天原料情况": "有异常情况"%')
  )`;
}

async function notifyAdminsBoardIssue(content) {
  try {
    const { pushRhythmReport } = await import('./feishu-client.js');
    await pushRhythmReport(content).catch(() => {});
  } catch (e) {
    logger.warn({ err: e?.message }, 'notifyAdminsBoardIssue failed');
  }
}

function agentNameZh(agentKey) {
  return ({
    ops_supervisor: '运营督导',
    food_quality: '食安专员',
    train_advisor: '培训顾问',
    marketing_planner: '营销策划',
    marketing_executor: '营销执行',
    data_auditor: '数据审计'
  })[agentKey] || agentKey || 'Agent';
}

function formatTaskDate(value) {
  if (!value) return '-';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value).slice(0, 10);
  return d.toISOString().slice(0, 10);
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
  const task0 = await getTask(taskId);
  if (!task0 || ['closed', 'settled', 'resolved', 'rejected', 'hr_filed'].includes(task0.status)) return { ok: true, skipped: true };
  if (task0.last_reminder_at && new Date(task0.last_reminder_at) > new Date(Date.now() - 3600000)) {
    return { ok: true, skipped: true, reason: 'last_reminder_within_1h' };
  }
  const { canon, task } = await normalizeTaskStoreInDb(taskId, task0);
  const currentReminders = Number(task.remind_count || 0);
  const trend = await getProductionIssueTrend(canon || task.store);
  if (currentReminders >= 3) {
    const filed = ['pending_response', 'pending_review'].includes(task.status)
      ? await transitionTask(taskId, 'hr_filed', 'task_watchdog', { noStoreReply: true, reminders: currentReminders, trend })
      : null;
    if (!filed?.ok) {
      await query(`UPDATE master_tasks SET status = 'hr_filed', hr_performance_recorded = TRUE, updated_at = NOW() WHERE task_id = $1`, [taskId]);
      await logEvent(taskId, 'status_transition', 'task_watchdog', task.assignee_agent, task.status, 'hr_filed', { noStoreReply: true, reminders: currentReminders, trend, forced: true });
    }
    await notifyAdminsBoardIssue(`🚨 门店未响应Agent任务，已三次催办并备案\n门店：${canon || task.store || '-'}\n任务：${task.title || taskId}\n任务ID：${taskId}\n当前趋势：${trend.label}（近3天问题${trend.currentIssueCount}条/总记录${trend.currentTotalCount}条，前3天问题${trend.previousIssueCount}条/总记录${trend.previousTotalCount}条）`);
    const derived = await createBoardTask({
      content: `继续追踪：${task.title || task.detail || taskId}\n原因：门店三次催办未回复，需重新派发并升级关注。`,
      priority: task.priority || task.severity || 'high',
      store: canon || task.store,
      createdBy: 'task_watchdog',
      createdByRole: 'system'
    });
    if (derived.ok) {
      await query(`UPDATE master_tasks SET parent_task_id = $2, related_task_ids = COALESCE(related_task_ids,'[]'::jsonb) || $3::jsonb WHERE task_id = $1`, [derived.taskId, taskId, JSON.stringify([taskId])]).catch(() => {});
      await logEvent(taskId, 'no_reply_revision_task_created', 'task_watchdog', 'master', 'hr_filed', 'hr_filed', { revisionTaskId: derived.taskId });
    }
    return { ok: true, filed: true, revisionTask: derived };
  }
  const nextCount = currentReminders + 1;
  const sent = await sendTaskCardToAssignee(taskId, { reminder: true, reminderCount: nextCount, trend });
  await query(`UPDATE master_tasks SET remind_count = COALESCE(remind_count, 0) + 1, last_reminder_at = NOW(), updated_at = NOW() WHERE task_id = $1`, [taskId]);
  await logEvent(taskId, 'reminder_sent', 'reminder_queue', task.assignee_agent, task.status, task.status, { agent, reminderCount: nextCount, trend, sent });
  return { ok: true, reminderCount: nextCount, sent };
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
