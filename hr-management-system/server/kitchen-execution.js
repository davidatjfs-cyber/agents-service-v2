// 厨房备料执行模块
// 功能：岗位菜品映射 + 每日备料确认 + SOP步骤打点卡 + 完成率看板
import { pool as getPool } from './utils/database.js';
function pool() { return getPool(); }

function normalizeStation(value) {
  return String(value || '').replace(/\/.*/, '').trim();
}

function parseScheduleTimes(input) {
  const raw = Array.isArray(input)
    ? input
    : String(input || '').split(/[，,\s]+/);
  const normalized = Array.from(new Set(
    raw
      .map((item) => String(item || '').trim())
      .filter((item) => /^([01]\d|2[0-3]):([0-5]\d)$/.test(item))
  )).sort();
  return normalized.length ? normalized : ['09:00'];
}

function canManageKitchenConfig(role) {
  return String(role || '') === 'admin';
}

async function getRuntimeUserContext(username) {
  const uname = String(username || '').trim().toLowerCase();
  if (!uname) return null;
  const r = await pool().query(`SELECT data FROM hrms_state WHERE key = $1 LIMIT 1`, ['default']);
  const data = r.rows?.[0]?.data;
  if (!data || typeof data !== 'object') return null;
  const people = []
    .concat(Array.isArray(data.employees) ? data.employees : [])
    .concat(Array.isArray(data.users) ? data.users : []);
  const found = people.find((item) => String(item?.username || '').trim().toLowerCase() === uname);
  if (!found) return null;
  return {
    username: String(found.username || '').trim(),
    role: String(found.role || '').trim(),
    store: String(found.store || '').trim(),
    position: String(found.position || found.station || '').trim(),
    department: String(found.department || '').trim(),
    name: String(found.name || found.real_name || '').trim()
  };
}

// ─── Schema ───────────────────────────────────────────────
export async function ensureKitchenExecutionSchema() {
  try {
    // 菜品岗位映射表
    await pool().query(`
      CREATE TABLE IF NOT EXISTS dish_station_mapping (
        id BIGSERIAL PRIMARY KEY,
        store VARCHAR(200) NOT NULL,
        station VARCHAR(100) NOT NULL,
        dish_name VARCHAR(255) NOT NULL,
        assignee_username VARCHAR(120) NOT NULL DEFAULT '',
        assignee_name VARCHAR(120) NOT NULL DEFAULT '',
        scheduled_times JSONB NOT NULL DEFAULT '["09:00"]'::jsonb,
        is_prep BOOLEAN DEFAULT false,
        critical_step_name TEXT,
        sop_id TEXT,
        enabled BOOLEAN DEFAULT TRUE,
        created_by VARCHAR(120),
        created_at TIMESTAMPTZ DEFAULT NOW(),
        CONSTRAINT uq_dish_station UNIQUE (store, station, dish_name)
      )
    `);
    await pool().query(`ALTER TABLE dish_station_mapping ADD COLUMN IF NOT EXISTS assignee_username VARCHAR(120) NOT NULL DEFAULT ''`);
    await pool().query(`ALTER TABLE dish_station_mapping ADD COLUMN IF NOT EXISTS assignee_name VARCHAR(120) NOT NULL DEFAULT ''`);
    await pool().query(`ALTER TABLE dish_station_mapping ADD COLUMN IF NOT EXISTS scheduled_times JSONB NOT NULL DEFAULT '["09:00"]'::jsonb`);
    await pool().query(`UPDATE dish_station_mapping SET assignee_username='' WHERE assignee_username IS NULL`);
    await pool().query(`UPDATE dish_station_mapping SET assignee_name='' WHERE assignee_name IS NULL`);
    await pool().query(`ALTER TABLE dish_station_mapping DROP CONSTRAINT IF EXISTS uq_dish_station`);
    await pool().query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_dsm_unique_assignment ON dish_station_mapping (store, station, dish_name, assignee_username)`);
    await pool().query(`
      CREATE INDEX IF NOT EXISTS idx_dsm_lookup
        ON dish_station_mapping (store, station, assignee_username, enabled)
    `);

    // SOP步骤表（从飞书多维表同步过来，厨房打点卡数据源）
    // 用 kitchen_sop_steps 避免与 sop-engine 的旧 sop_steps 表冲突
    await pool().query(`
      CREATE TABLE IF NOT EXISTS kitchen_sop_steps (
        id BIGSERIAL PRIMARY KEY,
        dish_name VARCHAR(255) NOT NULL,
        store VARCHAR(200) NOT NULL DEFAULT '*',
        station VARCHAR(100) NOT NULL,
        step_seq INT NOT NULL,
        action TEXT NOT NULL,
        time_limit_seconds INT,
        quality_standard TEXT,
        common_failure TEXT,
        failure_action TEXT,
        is_critical BOOLEAN DEFAULT FALSE,
        feishu_record_id VARCHAR(120),
        enabled BOOLEAN DEFAULT TRUE,
        synced_at TIMESTAMPTZ DEFAULT NOW(),
        CONSTRAINT uq_kitchen_sop_step UNIQUE (dish_name, store, step_seq)
      )
    `);
    await pool().query(`
      CREATE INDEX IF NOT EXISTS idx_kitchen_sop_steps_dish
        ON kitchen_sop_steps (dish_name, store, enabled)
    `);

    // 执行确认记录表（整菜层面：今天备了没）
    await pool().query(`
      CREATE TABLE IF NOT EXISTS kitchen_exec_logs (
        id BIGSERIAL PRIMARY KEY,
        store VARCHAR(200) NOT NULL,
        station VARCHAR(100) NOT NULL,
        dish_name VARCHAR(255) NOT NULL,
        schedule_time VARCHAR(20) NOT NULL DEFAULT '',
        employee_username VARCHAR(120) NOT NULL,
        employee_name VARCHAR(120),
        task_date DATE NOT NULL DEFAULT CURRENT_DATE,
        confirmed_at TIMESTAMPTZ DEFAULT NOW(),
        note TEXT,
        sop_id TEXT
      )
    `);
    await pool().query(`ALTER TABLE kitchen_exec_logs ADD COLUMN IF NOT EXISTS schedule_time VARCHAR(20) NOT NULL DEFAULT ''`);
    await pool().query(`
      CREATE INDEX IF NOT EXISTS idx_kel_date_station
        ON kitchen_exec_logs (store, station, task_date, schedule_time)
    `);
    await pool().query(`DROP INDEX IF EXISTS idx_kel_one_per_day`);
    await pool().query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_kel_one_per_slot
        ON kitchen_exec_logs (store, station, dish_name, employee_username, task_date, schedule_time)
    `);

    // 打点卡记录表（步骤层面：每步打了没）
    await pool().query(`
      CREATE TABLE IF NOT EXISTS kitchen_step_logs (
        id BIGSERIAL PRIMARY KEY,
        store VARCHAR(200) NOT NULL,
        station VARCHAR(100) NOT NULL,
        dish_name VARCHAR(255) NOT NULL,
        schedule_time VARCHAR(20) NOT NULL DEFAULT '',
        step_seq INT NOT NULL,
        step_action TEXT,
        employee_username VARCHAR(120) NOT NULL,
        employee_name VARCHAR(120),
        task_date DATE NOT NULL DEFAULT CURRENT_DATE,
        punched_at TIMESTAMPTZ DEFAULT NOW(),
        CONSTRAINT uq_step_punch UNIQUE (store, dish_name, step_seq, employee_username, task_date)
      )
    `);
    await pool().query(`ALTER TABLE kitchen_step_logs ADD COLUMN IF NOT EXISTS schedule_time VARCHAR(20) NOT NULL DEFAULT ''`);
    await pool().query(`ALTER TABLE kitchen_step_logs DROP CONSTRAINT IF EXISTS uq_step_punch`);
    await pool().query(`
      CREATE INDEX IF NOT EXISTS idx_ksl_lookup
        ON kitchen_step_logs (store, dish_name, employee_username, task_date, schedule_time)
    `);
    await pool().query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_ksl_unique_slot
        ON kitchen_step_logs (store, dish_name, step_seq, employee_username, task_date, schedule_time)
    `);

    console.log('[KitchenExec] Schema ensured');
  } catch (e) {
    console.error('[KitchenExec] schema error:', e?.message);
  }
}

// ─── 查询：我今天的任务清单 ────────────────────────────────
export async function getMyTasks({ store, station, username, date }) {
  try {
    const taskDate = date || new Date().toISOString().slice(0, 10);

    // 取该岗位所有启用菜品
    const mappings = await pool().query(
      `SELECT id, dish_name, assignee_username, assignee_name, scheduled_times, is_prep, critical_step_name, sop_id
       FROM dish_station_mapping
       WHERE store=$1 AND station=$2 AND enabled=TRUE
         AND (assignee_username='' OR assignee_username=$3)
       ORDER BY assignee_username ASC, is_prep DESC, dish_name ASC`,
      [store, station, username]
    );

    if (!mappings.rows.length) {
      return { success: true, tasks: [], station, date: taskDate };
    }

    const dishNames = mappings.rows.map(r => r.dish_name);

    // 查今日已确认的记录
    const confirmed = await pool().query(
      `SELECT dish_name, schedule_time, confirmed_at, employee_name FROM kitchen_exec_logs
       WHERE store=$1 AND station=$2 AND employee_username=$3 AND task_date=$4`,
      [store, station, username, taskDate]
    );
    const confirmedMap = new Map(confirmed.rows.map((r) => [`${r.dish_name}@@${r.schedule_time || ''}`, r]));

    const tasks = mappings.rows.flatMap((r) => {
      const scheduledTimes = parseScheduleTimes(r.scheduled_times);
      return scheduledTimes.map((scheduleTime) => {
        const confirmedRow = confirmedMap.get(`${r.dish_name}@@${scheduleTime}`);
        return {
          dish_name: r.dish_name,
          schedule_time: scheduleTime,
          assignee_username: r.assignee_username || '',
          assignee_name: r.assignee_name || '',
          is_prep: r.is_prep,
          critical_step_name: r.critical_step_name || null,
          sop_id: r.sop_id || null,
          confirmed: !!confirmedRow,
          confirmed_at: confirmedRow?.confirmed_at || null,
          operator_name: confirmedRow?.employee_name || ''
        };
      });
    }).sort((a, b) => String(a.schedule_time).localeCompare(String(b.schedule_time)) || Number(b.is_prep) - Number(a.is_prep) || String(a.dish_name).localeCompare(String(b.dish_name)));

    return { success: true, tasks, station, date: taskDate };
  } catch (e) {
    return { success: false, error: e?.message };
  }
}

// ─── 操作：确认一项任务 ────────────────────────────────────
export async function confirmTask({ store, station, dishName, username, employeeName, note, scheduleTime }) {
  try {
    const taskDate = new Date().toISOString().slice(0, 10);
    const normalizedScheduleTime = parseScheduleTimes([scheduleTime || ''])[0] || '';
    await pool().query(
      `INSERT INTO kitchen_exec_logs
         (store, station, dish_name, schedule_time, employee_username, employee_name, task_date, note)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (store, station, dish_name, employee_username, task_date, schedule_time) DO NOTHING`,
      [store, station, dishName, normalizedScheduleTime, username, employeeName || null, taskDate, note || null]
    );
    return { success: true };
  } catch (e) {
    return { success: false, error: e?.message };
  }
}

// ─── 管理员：查询各岗位完成率看板 ─────────────────────────
export async function getStationDashboard({ store, date }) {
  try {
    const taskDate = date || new Date().toISOString().slice(0, 10);
    const mappings = await pool().query(
      `SELECT id, store, station, dish_name, assignee_username, assignee_name, scheduled_times, is_prep, critical_step_name
       FROM dish_station_mapping
       WHERE store=$1 AND enabled=TRUE
       ORDER BY station, assignee_username, dish_name`,
      [store]
    );
    const logs = await pool().query(
      `SELECT store, station, dish_name, schedule_time, employee_username, employee_name, confirmed_at
       FROM kitchen_exec_logs
       WHERE store=$1 AND task_date=$2`,
      [store, taskDate]
    );

    const expandedTasks = mappings.rows.flatMap((row) => {
      const scheduledTimes = parseScheduleTimes(row.scheduled_times);
      return scheduledTimes.map((scheduleTime) => ({
        station: row.station,
        dish_name: row.dish_name,
        schedule_time: scheduleTime,
        assignee_username: row.assignee_username || '',
        assignee_name: row.assignee_name || '',
        is_prep: !!row.is_prep,
        critical_step_name: row.critical_step_name || ''
      }));
    });

    const logMap = new Map();
    for (const row of logs.rows) {
      logMap.set(`${row.station}@@${row.dish_name}@@${row.schedule_time || ''}`, row);
    }

    const stationMap = new Map();
    for (const task of expandedTasks) {
      const key = `${task.station}@@${task.dish_name}@@${task.schedule_time}`;
      const logRow = logMap.get(key);
      if (!stationMap.has(task.station)) {
        stationMap.set(task.station, { total: 0, confirmed: 0, completed_details: [], unchecked_details: [] });
      }
      const bucket = stationMap.get(task.station);
      bucket.total += 1;
      if (logRow) {
        bucket.confirmed += 1;
        bucket.completed_details.push({
          dish_name: task.dish_name,
          schedule_time: task.schedule_time,
          employee_username: logRow.employee_username || '',
          employee_name: logRow.employee_name || task.assignee_name || '',
          confirmed_at: logRow.confirmed_at,
          is_prep: task.is_prep
        });
      } else {
        bucket.unchecked_details.push({
          station: task.station,
          dish_name: task.dish_name,
          schedule_time: task.schedule_time,
          assignee_username: task.assignee_username,
          assignee_name: task.assignee_name,
          is_prep: task.is_prep,
          critical_step_name: task.critical_step_name
        });
      }
    }

    const summary = Array.from(stationMap.entries()).map(([station, bucket]) => ({
      station,
      total: bucket.total,
      confirmed: bucket.confirmed,
      rate: bucket.total > 0 ? Math.round((bucket.confirmed / bucket.total) * 100) : 0,
      completed_details: bucket.completed_details.sort((a, b) => String(a.schedule_time).localeCompare(String(b.schedule_time)) || String(a.confirmed_at || '').localeCompare(String(b.confirmed_at || ''))),
      unchecked_details: bucket.unchecked_details.sort((a, b) => String(a.schedule_time).localeCompare(String(b.schedule_time)) || String(a.dish_name).localeCompare(String(b.dish_name)))
    })).sort((a, b) => String(a.station).localeCompare(String(b.station)));

    const unchecked = summary.flatMap((row) => row.unchecked_details);
    const completed = summary.flatMap((row) => row.completed_details.map((item) => ({ ...item, station: row.station })));

    return { success: true, date: taskDate, summary, unchecked, completed };
  } catch (e) {
    return { success: false, error: e?.message };
  }
}

// ─── 管理员：新增菜品岗位映射 ─────────────────────────────
export async function addStationDish({ store, station, dishNames, isPrep, criticalStepName, sopId, createdBy, assigneeUsername, assigneeName, scheduledTimes }) {
  try {
    const inserted = [];
    const normalizedDishes = Array.from(new Set((Array.isArray(dishNames) ? dishNames : [dishNames]).map((name) => String(name || '').trim()).filter(Boolean)));
    const normalizedTimes = parseScheduleTimes(scheduledTimes);
    for (const dishName of normalizedDishes) {
      const r = await pool().query(
        `INSERT INTO dish_station_mapping
           (store, station, dish_name, assignee_username, assignee_name, scheduled_times, is_prep, critical_step_name, sop_id, created_by)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10)
         ON CONFLICT (store, station, dish_name, assignee_username) DO UPDATE SET
           assignee_name=EXCLUDED.assignee_name,
           scheduled_times=EXCLUDED.scheduled_times,
           is_prep=EXCLUDED.is_prep,
           critical_step_name=EXCLUDED.critical_step_name,
           sop_id=EXCLUDED.sop_id,
           enabled=TRUE
         RETURNING *`,
        [store, station, dishName, String(assigneeUsername || '').trim(), String(assigneeName || '').trim(), JSON.stringify(normalizedTimes), !!isPrep, criticalStepName || null, sopId || null, createdBy || null]
      );
      inserted.push(r.rows[0]);
    }
    return { success: true, rows: inserted };
  } catch (e) {
    return { success: false, error: e?.message };
  }
}

export async function updateStationDish({ id, store, station, dishName, isPrep, criticalStepName, sopId, assigneeUsername, assigneeName, scheduledTimes }) {
  try {
    const normalizedTimes = parseScheduleTimes(scheduledTimes);
    const r = await pool().query(
      `UPDATE dish_station_mapping
       SET station=$3,
           dish_name=$4,
           assignee_username=$5,
           assignee_name=$6,
           scheduled_times=$7::jsonb,
           is_prep=$8,
           critical_step_name=$9,
           sop_id=$10,
           enabled=TRUE
       WHERE id=$1 AND store=$2
       RETURNING *`,
      [id, store, station, dishName, String(assigneeUsername || '').trim(), String(assigneeName || '').trim(), JSON.stringify(normalizedTimes), !!isPrep, criticalStepName || null, sopId || null]
    );
    if (!r.rows.length) return { success: false, error: 'not_found' };
    return { success: true, row: r.rows[0] };
  } catch (e) {
    return { success: false, error: e?.message };
  }
}

export async function listStationDishes({ store }) {
  try {
    const r = await pool().query(
      `SELECT id, store, station, dish_name, assignee_username, assignee_name, scheduled_times, is_prep, critical_step_name, sop_id, enabled
       FROM dish_station_mapping
       WHERE store=$1 AND enabled=TRUE
       ORDER BY station, assignee_username, dish_name`,
      [store]
    );
    return { success: true, rows: r.rows.map((row) => ({ ...row, scheduled_times: parseScheduleTimes(row.scheduled_times) })) };
  } catch (e) {
    return { success: false, error: e?.message };
  }
}

export async function listStationEmployees({ store, station }) {
  try {
    const r = await pool().query(
      `SELECT username, name, position, store
       FROM employees
       WHERE status='active' AND store=$1
       ORDER BY name ASC, username ASC`,
      [store]
    );
    const rows = r.rows.filter((row) => normalizeStation(row.position) === normalizeStation(station));
    return { success: true, rows };
  } catch (e) {
    return { success: false, error: e?.message };
  }
}

// ─── 管理员：停用菜品岗位映射 ─────────────────────────────
export async function removeStationDish({ id, store }) {
  try {
    await pool().query(
      `UPDATE dish_station_mapping SET enabled=FALSE WHERE id=$1 AND store=$2`,
      [id, store]
    );
    return { success: true };
  } catch (e) {
    return { success: false, error: e?.message };
  }
}

// ─── 打点卡：查询某道菜的步骤 + 今日打点状态 ──────────────
export async function getDishSteps({ dishName, store, username, date, scheduleTime }) {
  try {
    const taskDate = date || new Date().toISOString().slice(0, 10);
    const storeKey = store || '*';
    const normalizedScheduleTime = parseScheduleTimes([scheduleTime || ''])[0] || '';

    // 优先取门店专属，回退到通用（store='*'）
    const steps = await pool().query(
      `SELECT * FROM kitchen_sop_steps
       WHERE dish_name=$1
         AND (store=$2 OR store='*')
         AND enabled=TRUE
       ORDER BY (CASE WHEN store=$2 THEN 0 ELSE 1 END), step_seq ASC`,
      [dishName, storeKey]
    );

    if (!steps.rows.length) {
      return { success: true, steps: [], hasData: false, message: '该菜品暂无SOP步骤，请先在飞书表格录入' };
    }

    // 今日已打点的步骤
    const punched = await pool().query(
      `SELECT step_seq FROM kitchen_step_logs
       WHERE dish_name=$1 AND store=$2 AND employee_username=$3 AND task_date=$4 AND schedule_time=$5`,
      [dishName, storeKey, username, taskDate, normalizedScheduleTime]
    );
    const punchedSet = new Set(punched.rows.map(r => r.step_seq));

    const result = steps.rows.map(s => ({
      step_seq: s.step_seq,
      action: s.action,
      time_limit_seconds: s.time_limit_seconds,
      quality_standard: s.quality_standard,
      common_failure: s.common_failure,
      failure_action: s.failure_action,
      is_critical: s.is_critical,
      punched: punchedSet.has(s.step_seq),
    }));

    const allDone = result.every(s => s.punched);
    return { success: true, steps: result, hasData: true, allDone, date: taskDate };
  } catch (e) {
    return { success: false, error: e?.message };
  }
}

// ─── 打点卡：打一个步骤 ────────────────────────────────────
export async function punchStep({ store, station, dishName, stepSeq, stepAction, username, employeeName, scheduleTime }) {
  try {
    const taskDate = new Date().toISOString().slice(0, 10);
    const normalizedScheduleTime = parseScheduleTimes([scheduleTime || ''])[0] || '';
    await pool().query(
      `INSERT INTO kitchen_step_logs
         (store, station, dish_name, schedule_time, step_seq, step_action, employee_username, employee_name, task_date)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (store, dish_name, step_seq, employee_username, task_date, schedule_time) DO NOTHING`,
      [store, station, dishName, normalizedScheduleTime, stepSeq, stepAction || null, username, employeeName || null, taskDate]
    );

    // 如果该菜品所有步骤都打完了，自动写入整菜确认（kitchen_exec_logs）
    const total = await pool().query(
      `SELECT COUNT(*) as cnt FROM kitchen_sop_steps
       WHERE dish_name=$1 AND (store=$2 OR store='*') AND enabled=TRUE`,
      [dishName, store]
    );
    const done = await pool().query(
      `SELECT COUNT(*) as cnt FROM kitchen_step_logs
       WHERE dish_name=$1 AND store=$2 AND employee_username=$3 AND task_date=$4 AND schedule_time=$5`,
      [dishName, store, username, taskDate, normalizedScheduleTime]
    );
    const allDone = Number(done.rows[0]?.cnt) >= Number(total.rows[0]?.cnt);

    if (allDone) {
      await pool().query(
        `INSERT INTO kitchen_exec_logs
           (store, station, dish_name, schedule_time, employee_username, employee_name, task_date, note)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'步骤全部打点完成自动确认')
         ON CONFLICT (store, station, dish_name, employee_username, task_date, schedule_time) DO NOTHING`,
        [store, station, dishName, normalizedScheduleTime, username, employeeName || null, taskDate]
      );
    }

    return { success: true, allDone };
  } catch (e) {
    return { success: false, error: e?.message };
  }
}

// ─── 飞书同步：写入SOP步骤（由 feishu-sync.js 调用）────────
export async function upsertSopSteps(rows) {
  // rows: [{ dish_name, store, station, step_seq, action, time_limit_seconds,
  //           quality_standard, common_failure, failure_action, is_critical, feishu_record_id }]
  let upserted = 0;
  for (const r of rows) {
    await pool().query(
      `INSERT INTO kitchen_sop_steps
         (dish_name, store, station, step_seq, action, time_limit_seconds,
          quality_standard, common_failure, failure_action, is_critical, feishu_record_id, synced_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW())
       ON CONFLICT (dish_name, store, step_seq) DO UPDATE SET
         station=EXCLUDED.station,
         action=EXCLUDED.action,
         time_limit_seconds=EXCLUDED.time_limit_seconds,
         quality_standard=EXCLUDED.quality_standard,
         common_failure=EXCLUDED.common_failure,
         failure_action=EXCLUDED.failure_action,
         is_critical=EXCLUDED.is_critical,
         feishu_record_id=EXCLUDED.feishu_record_id,
         enabled=TRUE,
         synced_at=NOW()`,
      [r.dish_name, r.store||'*', r.station, r.step_seq, r.action,
       r.time_limit_seconds||null, r.quality_standard||null,
       r.common_failure||null, r.failure_action||null,
       !!r.is_critical, r.feishu_record_id||null]
    );
    upserted++;
  }
  return { success: true, upserted };
}

// ─── 注册 Express 路由 ─────────────────────────────────────
export function registerKitchenExecutionRoutes(app, authMiddleware) {
  const auth = authMiddleware;

  // 员工：我的今日任务
  app.get('/api/kitchen/my-tasks', auth, async (req, res) => {
    const user = req.user;
    if (!user) return res.status(401).json({ error: 'unauthorized' });
    const runtimeUser = await getRuntimeUserContext(user.username);

    // admin/hq_manager 的 store 可能是"总部"，允许通过 query 参数覆盖
    const station = req.query.station || runtimeUser?.position || user.position || '';
    const effectiveStore = runtimeUser?.store || user.store || '';
    const store = (String(effectiveStore || '') === '总部' && req.query.store)
      ? req.query.store
      : (effectiveStore || req.query.store || '');

    // Normalize station: "烧味/卤水" → "烧味"
    const normalizedStation = String(station).replace(/\/.*/, '').trim();
    if (!station || !store) {
      return res.status(400).json({ error: 'station and store required', tip: '请确认员工档案中已填写岗位和门店' });
    }

    res.json(await getMyTasks({ store, station: normalizedStation, username: user.username, date: req.query.date }));
  });

  // 员工：确认完成一项
  app.post('/api/kitchen/confirm', auth, async (req, res) => {
    const user = req.user;
    if (!user) return res.status(401).json({ error: 'unauthorized' });

    const { dishName, station, store, note, scheduleTime } = req.body;
    if (!dishName || !station || !store) {
      return res.status(400).json({ error: 'dishName, station, store required' });
    }
    res.json(await confirmTask({
      store, station, dishName,
      username: user.username,
      employeeName: user.name || user.realName || '',
      note,
      scheduleTime
    }));
  });

  // 出品经理/店长：完成率看板
  app.get('/api/kitchen/dashboard', auth, async (req, res) => {
    const user = req.user;
    const role = String(user?.role || '');
    const allowed = ['admin', 'hq_manager', 'store_manager', 'store_production_manager'];
    if (!allowed.includes(role)) {
      return res.status(403).json({ error: 'forbidden' });
    }
    const runtimeUser = await getRuntimeUserContext(user.username);
    const effectiveStore = runtimeUser?.store || user.store || '';
    // admin/hq_manager 的 store 可能是"总部"，允许通过 query 参数覆盖
    const store = (String(effectiveStore || '') === '总部' && req.query.store)
      ? req.query.store
      : (effectiveStore || req.query.store || '');
    if (!store) return res.status(400).json({ error: 'store required' });
    res.json(await getStationDashboard({ store, date: req.query.date }));
  });

  // 管理员：新增菜品岗位映射
  app.post('/api/kitchen/station-dish', auth, async (req, res) => {
    const role = String(req.user?.role || '');
    if (role !== 'admin') {
      return res.status(403).json({ error: '仅管理员可配置菜品' });
    }
    const { store, station, dishName, dishNames, isPrep, criticalStepName, sopId, assigneeUsername, assigneeName, scheduledTimes } = req.body;
    if (!store || !station || !(dishName || (Array.isArray(dishNames) && dishNames.length))) {
      return res.status(400).json({ error: 'store, station, dishName required' });
    }
    res.json(await addStationDish({
      store, station, dishNames: dishNames || [dishName], isPrep, criticalStepName, sopId,
      assigneeUsername, assigneeName, scheduledTimes,
      createdBy: req.user?.username
    }));
  });

  app.put('/api/kitchen/station-dish/:id', auth, async (req, res) => {
    const role = String(req.user?.role || '');
    if (role !== 'admin') {
      return res.status(403).json({ error: '仅管理员可编辑菜品' });
    }
    const { store, station, dishName, isPrep, criticalStepName, sopId, assigneeUsername, assigneeName, scheduledTimes } = req.body;
    if (!store || !station || !dishName) {
      return res.status(400).json({ error: 'store, station, dishName required' });
    }
    res.json(await updateStationDish({
      id: Number(req.params.id), store, station, dishName, isPrep, criticalStepName, sopId, assigneeUsername, assigneeName, scheduledTimes
    }));
  });

  app.get('/api/kitchen/station-dish', auth, async (req, res) => {
    if (!canManageKitchenConfig(req.user?.role)) {
      return res.status(403).json({ error: 'forbidden' });
    }
    const store = req.query.store || req.user?.store || '';
    if (!store) return res.status(400).json({ error: 'store required' });
    res.json(await listStationDishes({ store }));
  });

  app.get('/api/kitchen/station-employees', auth, async (req, res) => {
    if (!canManageKitchenConfig(req.user?.role)) {
      return res.status(403).json({ error: 'forbidden' });
    }
    const store = req.query.store || req.user?.store || '';
    const station = req.query.station || '';
    if (!store || !station) return res.status(400).json({ error: 'store and station required' });
    res.json(await listStationEmployees({ store, station }));
  });

  // 管理员：停用菜品岗位映射
  app.delete('/api/kitchen/station-dish/:id', auth, async (req, res) => {
    const role = String(req.user?.role || '');
    if (role !== 'admin') {
      return res.status(403).json({ error: '仅管理员可配置菜品' });
    }
    const store = req.user?.store || req.query.store || '';
    res.json(await removeStationDish({ id: req.params.id, store }));
  });

  // 获取可选菜品列表（来自 kitchen_sop_steps，用于下拉选择）
  app.get('/api/kitchen/available-dishes', auth, async (req, res) => {
    if (!canManageKitchenConfig(req.user?.role)) {
      return res.status(403).json({ error: 'forbidden' });
    }
    try {
      const r = await pool().query(
        `SELECT DISTINCT station, dish_name FROM kitchen_sop_steps WHERE enabled=TRUE ORDER BY station, dish_name`
      );
      return res.json({ success: true, dishes: r.rows });
    } catch (e) {
      return res.json({ success: false, error: e?.message });
    }
  });

  // ── 打点卡：查询菜品步骤 + 今日打点状态 ──────────────────
  app.get('/api/kitchen/dish-steps', auth, async (req, res) => {
    const user = req.user;
    const { dishName, store } = req.query;
    if (!dishName) return res.status(400).json({ error: 'dishName required' });
    res.json(await getDishSteps({
      dishName,
      store: store || user?.store || '',
      username: user?.username,
      date: req.query.date,
      scheduleTime: req.query.scheduleTime
    }));
  });

  // ── 打点卡：打一个步骤 ────────────────────────────────────
  app.post('/api/kitchen/punch-step', auth, async (req, res) => {
    const user = req.user;
    const { dishName, station, store, stepSeq, stepAction, scheduleTime } = req.body;
    if (!dishName || stepSeq == null) {
      return res.status(400).json({ error: 'dishName and stepSeq required' });
    }
    res.json(await punchStep({
      store: store || user?.store || '',
      station: (station || user?.position || '').replace(/\/.*/, '').trim(),
      dishName,
      stepSeq: Number(stepSeq),
      stepAction,
      scheduleTime,
      username: user?.username,
      employeeName: user?.name || user?.realName || ''
    }));
  });
}
