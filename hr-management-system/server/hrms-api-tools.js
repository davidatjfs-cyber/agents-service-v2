// HRMS 排班/打卡/入离职 API 工具 (HR & OP 接入)
import { pool as getPool } from './utils/database.js';
function pool() { return getPool(); }

// ─── 确保表结构 ───
export async function ensureHRMSApiSchema() {
  const p = pool();
  try {
    // 排班表
    await p.query(`CREATE TABLE IF NOT EXISTS schedules (
      id SERIAL PRIMARY KEY,
      store TEXT NOT NULL,
      employee_username TEXT NOT NULL,
      employee_name TEXT,
      shift_date DATE NOT NULL,
      shift_type TEXT NOT NULL DEFAULT 'normal',
      start_time TIME,
      end_time TIME,
      is_rest BOOLEAN DEFAULT false,
      notes TEXT,
      created_by TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(store, employee_username, shift_date)
    )`);

    // 打卡记录表（补充 checkin_records 如果缺少字段）
    await p.query(`CREATE TABLE IF NOT EXISTS attendance_records (
      id SERIAL PRIMARY KEY,
      employee_username TEXT NOT NULL,
      employee_name TEXT,
      store TEXT,
      record_date DATE NOT NULL,
      clock_in TIMESTAMPTZ,
      clock_out TIMESTAMPTZ,
      status TEXT DEFAULT 'normal',
      late_minutes INT DEFAULT 0,
      early_leave_minutes INT DEFAULT 0,
      overtime_minutes INT DEFAULT 0,
      notes TEXT,
      source TEXT DEFAULT 'system',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(employee_username, record_date)
    )`);

    // 入离职记录表
    await p.query(`CREATE TABLE IF NOT EXISTS employment_records (
      id SERIAL PRIMARY KEY,
      employee_username TEXT NOT NULL,
      employee_name TEXT,
      store TEXT,
      brand TEXT,
      action_type TEXT NOT NULL,
      action_date DATE NOT NULL,
      position TEXT,
      department TEXT,
      reason TEXT,
      handover_to TEXT,
      handover_status TEXT DEFAULT 'pending',
      documents JSONB DEFAULT '[]'::jsonb,
      salary_info JSONB DEFAULT '{}'::jsonb,
      created_by TEXT,
      approved_by TEXT,
      status TEXT DEFAULT 'pending',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )`);

    // 临时增员申请表
    await p.query(`CREATE TABLE IF NOT EXISTS temp_staffing_requests (
      id SERIAL PRIMARY KEY,
      store TEXT NOT NULL,
      brand TEXT,
      requested_by TEXT NOT NULL,
      request_date DATE NOT NULL,
      needed_count INT DEFAULT 1,
      shift_type TEXT,
      reason TEXT,
      priority TEXT DEFAULT 'normal',
      status TEXT DEFAULT 'pending',
      approved_by TEXT,
      assigned_staff JSONB DEFAULT '[]'::jsonb,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )`);

    await p.query(`CREATE INDEX IF NOT EXISTS idx_sched_store_date ON schedules (store, shift_date)`);
    await p.query(`CREATE INDEX IF NOT EXISTS idx_attend_user_date ON attendance_records (employee_username, record_date)`);
    await p.query(`CREATE INDEX IF NOT EXISTS idx_employ_user ON employment_records (employee_username, action_type)`);
    await p.query(`CREATE INDEX IF NOT EXISTS idx_temp_staff_store ON temp_staffing_requests (store, status)`);

    console.log('[HRMS-API] Tables ensured');
  } catch (e) { console.error('[HRMS-API] schema error:', e?.message); }
}

// ─── 排班 CRUD ───
export async function getSchedule(store, startDate, endDate) {
  try {
    const r = await pool().query(
      `SELECT * FROM schedules WHERE store=$1 AND shift_date BETWEEN $2 AND $3 ORDER BY shift_date, start_time`,
      [store, startDate, endDate]
    );
    return { success: true, schedules: r.rows };
  } catch (e) { return { success: false, error: e?.message }; }
}

export async function upsertSchedule(data) {
  try {
    const r = await pool().query(
      `INSERT INTO schedules (store,employee_username,employee_name,shift_date,shift_type,start_time,end_time,is_rest,notes,created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (store,employee_username,shift_date) DO UPDATE SET
         shift_type=EXCLUDED.shift_type, start_time=EXCLUDED.start_time, end_time=EXCLUDED.end_time,
         is_rest=EXCLUDED.is_rest, notes=EXCLUDED.notes, updated_at=NOW()
       RETURNING *`,
      [data.store, data.employeeUsername, data.employeeName||null, data.shiftDate,
       data.shiftType||'normal', data.startTime||null, data.endTime||null,
       data.isRest||false, data.notes||null, data.createdBy||null]
    );
    return { success: true, schedule: r.rows[0] };
  } catch (e) { return { success: false, error: e?.message }; }
}

// ─── 考勤查询 ───
export async function getAttendance(filters = {}) {
  const conds = [], vals = [];
  let idx = 1;
  if (filters.store) { conds.push(`store=$${idx++}`); vals.push(filters.store); }
  if (filters.employee) { conds.push(`employee_username=$${idx++}`); vals.push(filters.employee); }
  if (filters.startDate) { conds.push(`record_date>=$${idx++}`); vals.push(filters.startDate); }
  if (filters.endDate) { conds.push(`record_date<=$${idx++}`); vals.push(filters.endDate); }
  if (filters.status) { conds.push(`status=$${idx++}`); vals.push(filters.status); }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  try {
    const r = await pool().query(`SELECT * FROM attendance_records ${where} ORDER BY record_date DESC LIMIT $${idx}`, [...vals, filters.limit||50]);
    return { success: true, records: r.rows };
  } catch (e) { return { success: false, error: e?.message }; }
}

export async function recordAttendance(data) {
  try {
    const r = await pool().query(
      `INSERT INTO attendance_records (employee_username,employee_name,store,record_date,clock_in,clock_out,status,late_minutes,early_leave_minutes,overtime_minutes,notes,source)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (employee_username,record_date) DO UPDATE SET
         clock_out=COALESCE(EXCLUDED.clock_out,attendance_records.clock_out),
         status=EXCLUDED.status, late_minutes=EXCLUDED.late_minutes,
         early_leave_minutes=EXCLUDED.early_leave_minutes, overtime_minutes=EXCLUDED.overtime_minutes,
         notes=EXCLUDED.notes
       RETURNING *`,
      [data.employeeUsername, data.employeeName||null, data.store||null, data.recordDate,
       data.clockIn||null, data.clockOut||null, data.status||'normal',
       data.lateMinutes||0, data.earlyLeaveMinutes||0, data.overtimeMinutes||0,
       data.notes||null, data.source||'system']
    );
    return { success: true, record: r.rows[0] };
  } catch (e) { return { success: false, error: e?.message }; }
}

// ─── 考勤统计（HR 薪资计算用） ───
export async function getAttendanceSummary(store, month) {
  try {
    const startDate = `${month}-01`;
    const endDate = `${month}-31`;
    const r = await pool().query(
      `SELECT employee_username, employee_name,
              COUNT(*) FILTER (WHERE status='normal')::int as normal_days,
              COUNT(*) FILTER (WHERE status='late')::int as late_days,
              COUNT(*) FILTER (WHERE status='absent')::int as absent_days,
              COUNT(*) FILTER (WHERE status='early_leave')::int as early_days,
              SUM(overtime_minutes)::int as total_overtime_min,
              SUM(late_minutes)::int as total_late_min
       FROM attendance_records
       WHERE store=$1 AND record_date BETWEEN $2 AND $3
       GROUP BY employee_username, employee_name`,
      [store, startDate, endDate]
    );
    return { success: true, summary: r.rows };
  } catch (e) { return { success: false, error: e?.message }; }
}

// ─── 入离职管理 ───
export async function createEmploymentRecord(data) {
  try {
    const r = await pool().query(
      `INSERT INTO employment_records (employee_username,employee_name,store,brand,action_type,action_date,position,department,reason,handover_to,salary_info,created_by,status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
      [data.employeeUsername, data.employeeName||null, data.store||null, data.brand||null,
       data.actionType, data.actionDate, data.position||null, data.department||null,
       data.reason||null, data.handoverTo||null, JSON.stringify(data.salaryInfo||{}),
       data.createdBy||null, data.status||'pending']
    );
    return { success: true, record: r.rows[0] };
  } catch (e) { return { success: false, error: e?.message }; }
}

export async function listEmploymentRecords(filters = {}) {
  const conds = [], vals = [];
  let idx = 1;
  if (filters.store) { conds.push(`store=$${idx++}`); vals.push(filters.store); }
  if (filters.actionType) { conds.push(`action_type=$${idx++}`); vals.push(filters.actionType); }
  if (filters.status) { conds.push(`status=$${idx++}`); vals.push(filters.status); }
  if (filters.employee) { conds.push(`employee_username=$${idx++}`); vals.push(filters.employee); }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  try {
    const r = await pool().query(`SELECT * FROM employment_records ${where} ORDER BY action_date DESC LIMIT $${idx}`, [...vals, filters.limit||50]);
    return { success: true, records: r.rows };
  } catch (e) { return { success: false, error: e?.message }; }
}

export async function updateEmploymentStatus(id, status, approvedBy) {
  try {
    const r = await pool().query(
      `UPDATE employment_records SET status=$1, approved_by=$2, updated_at=NOW() WHERE id=$3 RETURNING *`,
      [status, approvedBy, id]
    );
    return { success: true, record: r.rows[0] };
  } catch (e) { return { success: false, error: e?.message }; }
}

// ─── 离职率计算 ───
export async function getTurnoverRate(store, months = 3) {
  try {
    const r = await pool().query(
      `SELECT COUNT(*) FILTER (WHERE action_type='resign' OR action_type='terminate')::int as departures,
              COUNT(*) FILTER (WHERE action_type='onboard')::int as hires
       FROM employment_records
       WHERE ($1='' OR store=$1) AND action_date >= CURRENT_DATE - ($2||' months')::interval AND status='approved'`,
      [store || '', months]
    );
    const row = r.rows[0] || {};
    const emp = await pool().query(`SELECT COUNT(*)::int as total FROM users WHERE ($1='' OR store=$1) AND is_active=true`, [store||'']);
    const total = emp.rows[0]?.total || 1;
    const rate = total > 0 ? ((row.departures || 0) / total * 100).toFixed(1) : '0.0';
    return { success: true, departures: row.departures||0, hires: row.hires||0, totalEmployees: total, turnoverRate: parseFloat(rate), periodMonths: months };
  } catch (e) { return { success: false, error: e?.message }; }
}

// ─── 临时增员申请（OP 高峰期用） ───
export async function createTempStaffingRequest(data) {
  try {
    const r = await pool().query(
      `INSERT INTO temp_staffing_requests (store,brand,requested_by,request_date,needed_count,shift_type,reason,priority)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [data.store, data.brand||null, data.requestedBy, data.requestDate||new Date().toISOString().slice(0,10),
       data.neededCount||1, data.shiftType||null, data.reason||null, data.priority||'normal']
    );
    return { success: true, request: r.rows[0] };
  } catch (e) { return { success: false, error: e?.message }; }
}

export async function listTempStaffingRequests(store, status) {
  try {
    const conds = [], vals = [];
    let idx = 1;
    if (store) { conds.push(`store=$${idx++}`); vals.push(store); }
    if (status) { conds.push(`status=$${idx++}`); vals.push(status); }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    const r = await pool().query(`SELECT * FROM temp_staffing_requests ${where} ORDER BY created_at DESC LIMIT 50`, vals);
    return { success: true, requests: r.rows };
  } catch (e) { return { success: false, error: e?.message }; }
}

// ─── 注册 Express 路由 ───
export function registerHRMSApiRoutes(app, authMiddleware) {
  const auth = authMiddleware;

  // 排班
  app.get('/api/hrms/schedules', auth, async (req, res) => {
    const { store, start_date, end_date } = req.query;
    if (!store) return res.status(400).json({ error: 'store required' });
    res.json(await getSchedule(store, start_date || new Date().toISOString().slice(0,10), end_date || new Date(Date.now()+7*86400000).toISOString().slice(0,10)));
  });
  app.post('/api/hrms/schedules', auth, async (req, res) => {
    res.json(await upsertSchedule(req.body));
  });

  // 考勤
  app.get('/api/hrms/attendance', auth, async (req, res) => {
    res.json(await getAttendance({ store: req.query.store, employee: req.query.employee, startDate: req.query.start_date, endDate: req.query.end_date, status: req.query.status }));
  });
  app.post('/api/hrms/attendance', auth, async (req, res) => {
    res.json(await recordAttendance(req.body));
  });
  app.get('/api/hrms/attendance/summary', auth, async (req, res) => {
    if (!req.query.store || !req.query.month) return res.status(400).json({ error: 'store and month required' });
    res.json(await getAttendanceSummary(req.query.store, req.query.month));
  });

  // 入离职
  app.get('/api/hrms/employment', auth, async (req, res) => {
    res.json(await listEmploymentRecords({ store: req.query.store, actionType: req.query.type, status: req.query.status, employee: req.query.employee }));
  });
  app.post('/api/hrms/employment', auth, async (req, res) => {
    if (!req.body.employeeUsername || !req.body.actionType) return res.status(400).json({ error: 'employeeUsername and actionType required' });
    res.json(await createEmploymentRecord({ ...req.body, createdBy: req.user?.username }));
  });
  app.put('/api/hrms/employment/:id/status', auth, async (req, res) => {
    res.json(await updateEmploymentStatus(req.params.id, req.body.status, req.user?.username));
  });

  // 离职率
  app.get('/api/hrms/turnover', auth, async (req, res) => {
    res.json(await getTurnoverRate(req.query.store, Number(req.query.months)||3));
  });

  // 临时增员
  app.get('/api/hrms/temp-staffing', auth, async (req, res) => {
    res.json(await listTempStaffingRequests(req.query.store, req.query.status));
  });
  app.post('/api/hrms/temp-staffing', auth, async (req, res) => {
    if (!req.body.store) return res.status(400).json({ error: 'store required' });
    res.json(await createTempStaffingRequest({ ...req.body, requestedBy: req.user?.username }));
  });
}
