// 厨房备料执行模块
// 功能：岗位菜品映射 + 每日备料确认 + SOP步骤打点卡 + 完成率看板
import { pool as getPool } from './utils/database.js';
function pool() { return getPool(); }

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
        is_prep BOOLEAN DEFAULT false,
        critical_step_name TEXT,
        sop_id TEXT,
        enabled BOOLEAN DEFAULT TRUE,
        created_by VARCHAR(120),
        created_at TIMESTAMPTZ DEFAULT NOW(),
        CONSTRAINT uq_dish_station UNIQUE (store, station, dish_name)
      )
    `);
    await pool().query(`
      CREATE INDEX IF NOT EXISTS idx_dsm_lookup
        ON dish_station_mapping (store, station, enabled)
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
        employee_username VARCHAR(120) NOT NULL,
        employee_name VARCHAR(120),
        task_date DATE NOT NULL DEFAULT CURRENT_DATE,
        confirmed_at TIMESTAMPTZ DEFAULT NOW(),
        note TEXT,
        sop_id TEXT
      )
    `);
    await pool().query(`
      CREATE INDEX IF NOT EXISTS idx_kel_date_station
        ON kitchen_exec_logs (store, station, task_date)
    `);
    await pool().query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_kel_one_per_day
        ON kitchen_exec_logs (store, station, dish_name, employee_username, task_date)
    `);

    // 打点卡记录表（步骤层面：每步打了没）
    await pool().query(`
      CREATE TABLE IF NOT EXISTS kitchen_step_logs (
        id BIGSERIAL PRIMARY KEY,
        store VARCHAR(200) NOT NULL,
        station VARCHAR(100) NOT NULL,
        dish_name VARCHAR(255) NOT NULL,
        step_seq INT NOT NULL,
        step_action TEXT,
        employee_username VARCHAR(120) NOT NULL,
        employee_name VARCHAR(120),
        task_date DATE NOT NULL DEFAULT CURRENT_DATE,
        punched_at TIMESTAMPTZ DEFAULT NOW(),
        CONSTRAINT uq_step_punch UNIQUE (store, dish_name, step_seq, employee_username, task_date)
      )
    `);
    await pool().query(`
      CREATE INDEX IF NOT EXISTS idx_ksl_lookup
        ON kitchen_step_logs (store, dish_name, employee_username, task_date)
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
      `SELECT id, dish_name, is_prep, critical_step_name, sop_id
       FROM dish_station_mapping
       WHERE store=$1 AND station=$2 AND enabled=TRUE
       ORDER BY is_prep DESC, dish_name ASC`,
      [store, station]
    );

    if (!mappings.rows.length) {
      return { success: true, tasks: [], station, date: taskDate };
    }

    const dishNames = mappings.rows.map(r => r.dish_name);

    // 查今日已确认的记录
    const confirmed = await pool().query(
      `SELECT dish_name FROM kitchen_exec_logs
       WHERE store=$1 AND station=$2 AND employee_username=$3 AND task_date=$4`,
      [store, station, username, taskDate]
    );
    const confirmedSet = new Set(confirmed.rows.map(r => r.dish_name));

    const tasks = mappings.rows.map(r => ({
      dish_name: r.dish_name,
      is_prep: r.is_prep,
      critical_step_name: r.critical_step_name || null,
      sop_id: r.sop_id || null,
      confirmed: confirmedSet.has(r.dish_name),
    }));

    return { success: true, tasks, station, date: taskDate };
  } catch (e) {
    return { success: false, error: e?.message };
  }
}

// ─── 操作：确认一项任务 ────────────────────────────────────
export async function confirmTask({ store, station, dishName, username, employeeName, note }) {
  try {
    const taskDate = new Date().toISOString().slice(0, 10);
    await pool().query(
      `INSERT INTO kitchen_exec_logs
         (store, station, dish_name, employee_username, employee_name, task_date, note)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (store, station, dish_name, employee_username, task_date) DO NOTHING`,
      [store, station, dishName, username, employeeName || null, taskDate, note || null]
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

    // 各岗位菜品总数
    const totals = await pool().query(
      `SELECT station, COUNT(*) as total
       FROM dish_station_mapping
       WHERE store=$1 AND enabled=TRUE
       GROUP BY station`,
      [store]
    );

    // 今日已确认数（按岗位）
    const done = await pool().query(
      `SELECT station, COUNT(DISTINCT dish_name) as confirmed
       FROM kitchen_exec_logs
       WHERE store=$1 AND task_date=$2
       GROUP BY station`,
      [store, taskDate]
    );

    const doneMap = {};
    for (const row of done.rows) doneMap[row.station] = Number(row.confirmed);

    const summary = totals.rows.map(r => ({
      station: r.station,
      total: Number(r.total),
      confirmed: doneMap[r.station] || 0,
      rate: Number(r.total) > 0
        ? Math.round(((doneMap[r.station] || 0) / Number(r.total)) * 100)
        : 0,
    }));

    // 近期未确认的菜品明细（预警用）
    const unchecked = await pool().query(
      `SELECT dsm.station, dsm.dish_name, dsm.is_prep
       FROM dish_station_mapping dsm
       WHERE dsm.store=$1 AND dsm.enabled=TRUE
         AND NOT EXISTS (
           SELECT 1 FROM kitchen_exec_logs kel
           WHERE kel.store=dsm.store
             AND kel.station=dsm.station
             AND kel.dish_name=dsm.dish_name
             AND kel.task_date=$2
         )
       ORDER BY dsm.is_prep DESC, dsm.station, dsm.dish_name`,
      [store, taskDate]
    );

    return { success: true, date: taskDate, summary, unchecked: unchecked.rows };
  } catch (e) {
    return { success: false, error: e?.message };
  }
}

// ─── 管理员：新增菜品岗位映射 ─────────────────────────────
export async function addStationDish({ store, station, dishName, isPrep, criticalStepName, sopId, createdBy }) {
  try {
    const r = await pool().query(
      `INSERT INTO dish_station_mapping
         (store, station, dish_name, is_prep, critical_step_name, sop_id, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (store, station, dish_name) DO UPDATE SET
         is_prep=EXCLUDED.is_prep,
         critical_step_name=EXCLUDED.critical_step_name,
         sop_id=EXCLUDED.sop_id,
         enabled=TRUE
       RETURNING *`,
      [store, station, dishName, !!isPrep, criticalStepName || null, sopId || null, createdBy || null]
    );
    return { success: true, row: r.rows[0] };
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
export async function getDishSteps({ dishName, store, username, date }) {
  try {
    const taskDate = date || new Date().toISOString().slice(0, 10);
    const storeKey = store || '*';

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
       WHERE dish_name=$1 AND store=$2 AND employee_username=$3 AND task_date=$4`,
      [dishName, storeKey, username, taskDate]
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
export async function punchStep({ store, station, dishName, stepSeq, stepAction, username, employeeName }) {
  try {
    const taskDate = new Date().toISOString().slice(0, 10);
    await pool().query(
      `INSERT INTO kitchen_step_logs
         (store, station, dish_name, step_seq, step_action, employee_username, employee_name, task_date)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (store, dish_name, step_seq, employee_username, task_date) DO NOTHING`,
      [store, station, dishName, stepSeq, stepAction || null, username, employeeName || null, taskDate]
    );

    // 如果该菜品所有步骤都打完了，自动写入整菜确认（kitchen_exec_logs）
    const total = await pool().query(
      `SELECT COUNT(*) as cnt FROM kitchen_sop_steps
       WHERE dish_name=$1 AND (store=$2 OR store='*') AND enabled=TRUE`,
      [dishName, store]
    );
    const done = await pool().query(
      `SELECT COUNT(*) as cnt FROM kitchen_step_logs
       WHERE dish_name=$1 AND store=$2 AND employee_username=$3 AND task_date=$4`,
      [dishName, store, username, taskDate]
    );
    const allDone = Number(done.rows[0]?.cnt) >= Number(total.rows[0]?.cnt);

    if (allDone) {
      await pool().query(
        `INSERT INTO kitchen_exec_logs
           (store, station, dish_name, employee_username, employee_name, task_date, note)
         VALUES ($1,$2,$3,$4,$5,$6,'步骤全部打点完成自动确认')
         ON CONFLICT (store, station, dish_name, employee_username, task_date) DO NOTHING`,
        [store, station, dishName, username, employeeName || null, taskDate]
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

    // admin/hq_manager 的 store 可能是"总部"，允许通过 query 参数覆盖
    const station = req.query.station || user.position || '';
    const store = (String(user.store || '') === '总部' && req.query.store)
      ? req.query.store
      : (user.store || req.query.store || '');

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

    const { dishName, station, store, note } = req.body;
    if (!dishName || !station || !store) {
      return res.status(400).json({ error: 'dishName, station, store required' });
    }
    res.json(await confirmTask({
      store, station, dishName,
      username: user.username,
      employeeName: user.name || user.realName || '',
      note
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
    // admin/hq_manager 的 store 可能是"总部"，允许通过 query 参数覆盖
    const store = (String(user.store || '') === '总部' && req.query.store)
      ? req.query.store
      : (user.store || req.query.store || '');
    if (!store) return res.status(400).json({ error: 'store required' });
    res.json(await getStationDashboard({ store, date: req.query.date }));
  });

  // 管理员：新增菜品岗位映射
  app.post('/api/kitchen/station-dish', auth, async (req, res) => {
    const role = String(req.user?.role || '');
    if (role !== 'admin') {
      return res.status(403).json({ error: '仅管理员可配置菜品' });
    }
    const { store, station, dishName, isPrep, criticalStepName, sopId } = req.body;
    if (!store || !station || !dishName) {
      return res.status(400).json({ error: 'store, station, dishName required' });
    }
    res.json(await addStationDish({
      store, station, dishName, isPrep, criticalStepName, sopId,
      createdBy: req.user?.username
    }));
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
      date: req.query.date
    }));
  });

  // ── 打点卡：打一个步骤 ────────────────────────────────────
  app.post('/api/kitchen/punch-step', auth, async (req, res) => {
    const user = req.user;
    const { dishName, station, store, stepSeq, stepAction } = req.body;
    if (!dishName || stepSeq == null) {
      return res.status(400).json({ error: 'dishName and stepSeq required' });
    }
    res.json(await punchStep({
      store: store || user?.store || '',
      station: (station || user?.position || '').replace(/\/.*/, '').trim(),
      dishName,
      stepSeq: Number(stepSeq),
      stepAction,
      username: user?.username,
      employeeName: user?.name || user?.realName || ''
    }));
  });
}
