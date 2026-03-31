// Master 任务看板 CRUD API + 超时/升级机制
import { pool as getPool } from './utils/database.js';
function pool() { return getPool(); }

// ─── 超时配置（分钟） ───
const TIMEOUT_CONFIG = {
  pending_audit:     30,   // 审核超时
  pending_dispatch:  10,   // 派单超时
  dispatched:        60,   // 等待接收超时
  pending_response: 1440,  // 24h 未回复
  pending_review:    60,   // 审核回复超时
  pending_settlement:120   // 结算超时
};

const ESCALATION_CHAIN = ['store_manager', 'hq_manager', 'admin'];

// ─── 确保超时相关列存在 ───
export async function ensureTaskBoardSchema() {
  const p = pool();
  try {
    await p.query(`DO $$ BEGIN ALTER TABLE master_tasks ADD COLUMN IF NOT EXISTS timeout_at TIMESTAMPTZ; EXCEPTION WHEN others THEN NULL; END $$;`);
    await p.query(`DO $$ BEGIN ALTER TABLE master_tasks ADD COLUMN IF NOT EXISTS escalation_level INT DEFAULT 0; EXCEPTION WHEN others THEN NULL; END $$;`);
    await p.query(`DO $$ BEGIN ALTER TABLE master_tasks ADD COLUMN IF NOT EXISTS escalated_to TEXT; EXCEPTION WHEN others THEN NULL; END $$;`);
    await p.query(`DO $$ BEGIN ALTER TABLE master_tasks ADD COLUMN IF NOT EXISTS escalation_history JSONB DEFAULT '[]'::jsonb; EXCEPTION WHEN others THEN NULL; END $$;`);
    await p.query(`CREATE INDEX IF NOT EXISTS idx_mt_timeout ON master_tasks (timeout_at) WHERE timeout_at IS NOT NULL AND status NOT IN ('resolved','closed','settled');`);
    console.log('[TaskBoard] Schema ensured');
  } catch (e) { console.error('[TaskBoard] schema error:', e?.message); }
}

// ─── CRUD ───
export async function createTask(data) {
  const p = pool();
  const taskId = data.taskId || `task_${Date.now()}_${Math.random().toString(36).slice(2,8)}`;
  const timeoutMin = TIMEOUT_CONFIG[data.status || 'pending_audit'] || 30;
  const timeoutAt = new Date(Date.now() + timeoutMin * 60000).toISOString();
  try {
    const r = await p.query(
      `INSERT INTO master_tasks (task_id,status,source,source_ref,current_agent,category,severity,store,brand,assignee_username,assignee_role,title,detail,source_data,timeout_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       RETURNING *`,
      [taskId, data.status||'pending_audit', data.source||'api', data.sourceRef||null, data.currentAgent||'master',
       data.category||null, data.severity||'medium', data.store||null, data.brand||null,
       data.assigneeUsername||null, data.assigneeRole||null, data.title||'', data.detail||'',
       JSON.stringify(data.sourceData||{}), timeoutAt]
    );
    return { success: true, task: r.rows[0] };
  } catch (e) { return { success: false, error: e?.message }; }
}

export async function getTask(taskId) {
  try {
    const r = await pool().query('SELECT * FROM master_tasks WHERE task_id=$1 LIMIT 1', [taskId]);
    return r.rows[0] || null;
  } catch (e) { return null; }
}

export async function listTasks(filters = {}) {
  const conds = [], vals = [];
  let idx = 1;
  if (filters.status) { conds.push(`status=$${idx++}`); vals.push(filters.status); }
  if (filters.store) { conds.push(`store=$${idx++}`); vals.push(filters.store); }
  if (filters.assignee) { conds.push(`assignee_username=$${idx++}`); vals.push(filters.assignee); }
  if (filters.severity) { conds.push(`severity=$${idx++}`); vals.push(filters.severity); }
  if (filters.currentAgent) { conds.push(`current_agent=$${idx++}`); vals.push(filters.currentAgent); }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  const limit = Math.min(filters.limit || 50, 200);
  const offset = filters.offset || 0;
  try {
    const r = await pool().query(`SELECT * FROM master_tasks ${where} ORDER BY created_at DESC LIMIT $${idx++} OFFSET $${idx}`, [...vals, limit, offset]);
    const countR = await pool().query(`SELECT COUNT(*)::int as total FROM master_tasks ${where}`, vals);
    return { success: true, tasks: r.rows, total: countR.rows[0]?.total || 0 };
  } catch (e) { return { success: false, tasks: [], error: e?.message }; }
}

export async function updateTask(taskId, updates) {
  const allowed = ['status','current_agent','assignee_username','assignee_role','response_text','response_images','review_result','settlement_data','score_impact','detail'];
  const sets = [], vals = [];
  let idx = 1;
  for (const [k, v] of Object.entries(updates)) {
    if (!allowed.includes(k)) continue;
    const isJson = ['response_images','review_result','settlement_data'].includes(k);
    sets.push(`${k}=$${idx++}`);
    vals.push(isJson ? JSON.stringify(v) : v);
  }
  if (!sets.length) return { success: false, error: 'no_valid_fields' };

  // 自动更新时间戳
  const status = updates.status;
  if (status === 'dispatched') { sets.push(`dispatched_at=NOW()`); }
  if (status === 'pending_review') { sets.push(`responded_at=NOW()`); }
  if (status === 'resolved' || status === 'rejected') { sets.push(`resolved_at=NOW()`); }
  if (status === 'settled') { sets.push(`settled_at=NOW()`); }
  if (status === 'closed') { sets.push(`closed_at=NOW()`); }

  // 更新超时时间
  if (status && TIMEOUT_CONFIG[status]) {
    const timeoutAt = new Date(Date.now() + TIMEOUT_CONFIG[status] * 60000).toISOString();
    sets.push(`timeout_at=$${idx++}`);
    vals.push(timeoutAt);
  } else if (status && ['resolved','closed','settled'].includes(status)) {
    sets.push(`timeout_at=NULL`);
  }

  sets.push(`updated_at=NOW()`);
  vals.push(taskId);

  try {
    const r = await pool().query(`UPDATE master_tasks SET ${sets.join(',')} WHERE task_id=$${idx} RETURNING *`, vals);
    if (!r.rows.length) return { success: false, error: 'task_not_found' };
    return { success: true, task: r.rows[0] };
  } catch (e) { return { success: false, error: e?.message }; }
}

// ─── 超时检测 + 标记（停用人工升级） ───
export async function checkTimeoutsAndEscalate(notifyFn) {
  const p = pool();
  try {
    const r = await p.query(
      `SELECT * FROM master_tasks WHERE timeout_at < NOW() AND status NOT IN ('resolved','closed','settled','rejected') ORDER BY timeout_at ASC LIMIT 20`
    );
    const timedOut = [];
    for (const task of r.rows || []) {
      const level = Number(task.escalation_level || 0);
      const history = Array.isArray(task.escalation_history) ? task.escalation_history : [];
      history.push({
        level,
        escalatedTo: task.escalated_to || null,
        at: new Date().toISOString(),
        previousAssignee: task.assignee_username,
        status: task.status,
        mode: 'timeout_mark_only'
      });

      const newTimeout = new Date(Date.now() + (TIMEOUT_CONFIG[task.status] || 60) * 60000).toISOString();
      await p.query(
        `UPDATE master_tasks
         SET escalation_level = $1,
             escalated_to = NULL,
             escalation_history = $2,
             timeout_at = $3,
             source_data = COALESCE(source_data, '{}'::jsonb) || $4::jsonb,
             updated_at = NOW()
         WHERE id = $5`,
        [
          level,
          JSON.stringify(history),
          newTimeout,
          JSON.stringify({
            timed_out: true,
            timeout_marked_at: new Date().toISOString(),
            timeout_status: task.status
          }),
          task.id
        ]
      );

      timedOut.push({ taskId: task.task_id, level, title: task.title, store: task.store, status: task.status });

      // 保持通知回调兼容，但不再升级到任何人工角色
      if (notifyFn) {
        try { await notifyFn({ type: 'timeout_marked', task, level, escalateTo: null }); } catch (e) {}
      }
    }
    return { escalated: timedOut, count: timedOut.length };
  } catch (e) { console.error('[TaskBoard] checkTimeouts error:', e?.message); return { escalated: [], count: 0 }; }
}

// ─── 任务统计 ───
export async function taskStats(filters = {}) {
  const conds = [], vals = [];
  let idx = 1;
  if (filters.store) { conds.push(`store=$${idx++}`); vals.push(filters.store); }
  if (filters.brand) { conds.push(`brand=$${idx++}`); vals.push(filters.brand); }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  try {
    const r = await pool().query(`SELECT status, severity, COUNT(*)::int as count FROM master_tasks ${where} GROUP BY status, severity`, vals);
    const timeoutR = await pool().query(`SELECT COUNT(*)::int as count FROM master_tasks WHERE timeout_at < NOW() AND status NOT IN ('resolved','closed','settled','rejected') ${conds.length ? 'AND ' + conds.join(' AND ') : ''}`, vals);
    return { success: true, byStatusSeverity: r.rows, overdueCount: timeoutR.rows[0]?.count || 0 };
  } catch (e) { return { success: false, error: e?.message }; }
}

// ─── 注册 Express 路由 ───
export function registerTaskBoardRoutes(app, authMiddleware) {
  const auth = authMiddleware;

  app.get('/api/task-board/tasks', auth, async (req, res) => {
    const result = await listTasks({ status: req.query.status, store: req.query.store, assignee: req.query.assignee, severity: req.query.severity, currentAgent: req.query.agent, limit: Number(req.query.limit)||50, offset: Number(req.query.offset)||0 });
    res.json(result);
  });

  app.get('/api/task-board/tasks/:taskId', auth, async (req, res) => {
    const task = await getTask(req.params.taskId);
    if (!task) return res.status(404).json({ error: 'not_found' });
    res.json({ success: true, task });
  });

  app.post('/api/task-board/tasks', auth, async (req, res) => {
    const role = req.user?.role;
    if (!['admin','hq_manager','hr_manager'].includes(role)) return res.status(403).json({ error: 'forbidden' });
    const result = await createTask(req.body);
    res.status(result.success ? 201 : 400).json(result);
  });

  app.put('/api/task-board/tasks/:taskId', auth, async (req, res) => {
    const result = await updateTask(req.params.taskId, req.body);
    res.json(result);
  });

  app.get('/api/task-board/stats', auth, async (req, res) => {
    const result = await taskStats({ store: req.query.store, brand: req.query.brand });
    res.json(result);
  });

  app.post('/api/task-board/check-timeouts', auth, async (req, res) => {
    const role = req.user?.role;
    if (!['admin','hq_manager'].includes(role)) return res.status(403).json({ error: 'forbidden' });
    const result = await checkTimeoutsAndEscalate();
    res.json(result);
  });
}
