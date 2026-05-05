/**
 * Training Service — 新员工培训计划管理
 *
 * 职责：
 *   1. 培训计划 CRUD（含自动创建4周阶段）
 *   2. 每日学习任务调度（按当前周推送对应SOP）
 *   3. 进度统计 & 门店周报
 */
import { query } from '../utils/db.js';
import { logger } from '../utils/logger.js';

/* ── 启动时确保表存在 ── */
export async function ensureTrainingTables() {
  try {
    await query(`
      CREATE TABLE IF NOT EXISTS training_plans (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        employee_id TEXT NOT NULL, employee_name TEXT NOT NULL, store TEXT,
        start_date DATE NOT NULL, status TEXT DEFAULT 'active',
        current_week INT DEFAULT 1, created_by TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await query(`
      CREATE TABLE IF NOT EXISTS training_plan_phases (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        plan_id UUID REFERENCES training_plans(id) ON DELETE CASCADE,
        week INT NOT NULL, phase_name TEXT NOT NULL, sop_ids UUID[],
        exam_count INT DEFAULT 20, pass_score NUMERIC(5,2) DEFAULT 90,
        status TEXT DEFAULT 'pending',
        started_at TIMESTAMPTZ, completed_at TIMESTAMPTZ
      )
    `);
    await query(`CREATE INDEX IF NOT EXISTS idx_training_plans_employee ON training_plans(employee_id)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_training_plans_status ON training_plans(status)`);
    logger.info('training-service: tables ensured');
  } catch (e) {
    logger.warn({ err: e?.message }, 'training-service: ensureTrainingTables failed');
  }
}

/* ── 4周培训阶段定义 ── */
const PHASE_DEFS = [
  { week: 1, phaseName: '基础通识', examCount: 20, passScore: 90 },
  { week: 2, phaseName: '岗位SOP', examCount: 20, passScore: 90 },
  { week: 3, phaseName: '跨岗联动', examCount: 20, passScore: 90 },
  { week: 4, phaseName: '综合考核', examCount: 30, passScore: 85 }
];

/* ── 培训计划 CRUD ── */

export async function createTrainingPlan({ employeeId, employeeName, store, startDate, createdBy }) {
  const planR = await query(
    `INSERT INTO training_plans (employee_id, employee_name, store, start_date, created_by)
     VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [employeeId, employeeName, store || null, startDate, createdBy || null]
  );
  const plan = planR.rows?.[0];
  if (!plan) return null;

  for (const p of PHASE_DEFS) {
    await query(
      `INSERT INTO training_plan_phases (plan_id, week, phase_name, exam_count, pass_score)
       VALUES ($1,$2,$3,$4,$5)`,
      [plan.id, p.week, p.phaseName, p.examCount, p.passScore]
    );
  }

  return getTrainingPlan(plan.id);
}

export async function listTrainingPlans({ status, store, page = 1, limit = 50 } = {}) {
  const conds = [];
  const params = [];
  let idx = 1;
  if (status) { conds.push(`status = $${idx++}`); params.push(status); }
  if (store) { conds.push(`store = $${idx++}`); params.push(store); }
  const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
  const offset = (page - 1) * limit;

  const countR = await query(`SELECT COUNT(*)::int AS c FROM training_plans ${where}`, params);
  const rowsR = await query(
    `SELECT * FROM training_plans ${where} ORDER BY created_at DESC LIMIT $${idx++} OFFSET $${idx++}`,
    [...params, limit, offset]
  );
  return { rows: rowsR.rows || [], total: countR.rows?.[0]?.c || 0, page, limit };
}

export async function getTrainingPlan(id) {
  const planR = await query(`SELECT * FROM training_plans WHERE id = $1`, [id]);
  const plan = planR.rows?.[0];
  if (!plan) return null;
  const phasesR = await query(
    `SELECT * FROM training_plan_phases WHERE plan_id = $1 ORDER BY week`,
    [id]
  );
  return { ...plan, phases: phasesR.rows || [] };
}

export async function updateTrainingPlanStatus(id, status) {
  const r = await query(
    `UPDATE training_plans SET status = $1, updated_at = NOW() WHERE id = $2 RETURNING *`,
    [status, id]
  );
  return r.rows?.[0] || null;
}

/* ── 进度统计 ── */

export async function getTrainingProgress(employeeId) {
  const planR = await query(
    `SELECT * FROM training_plans WHERE employee_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [employeeId]
  );
  const plan = planR.rows?.[0];
  if (!plan) return null;

  const [recordsR, phasesR] = await Promise.all([
    query(
      `SELECT COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE passed = true)::int AS passed_count,
              COALESCE(AVG(exam_score), 0)::numeric(5,2) AS avg_score
       FROM employee_training_records WHERE employee_id = $1`,
      [employeeId]
    ),
    query(
      `SELECT * FROM training_plan_phases WHERE plan_id = $1 ORDER BY week`,
      [plan.id]
    )
  ]);

  const stats = recordsR.rows?.[0] || { total: 0, passed_count: 0, avg_score: 0 };

  return {
    planId: plan.id,
    employeeId: plan.employee_id,
    employeeName: plan.employee_name,
    store: plan.store,
    startDate: plan.start_date,
    status: plan.status,
    currentWeek: plan.current_week,
    phases: phasesR.rows || [],
    trainingStats: {
      totalExams: stats.total,
      passedCount: stats.passed_count,
      averageScore: Number(stats.avg_score),
      passRate: stats.total > 0 ? Math.round((stats.passed_count / stats.total) * 10000) / 100 : 0
    }
  };
}

/* ── 每日学习任务 ── */

export async function getTodayLearningTasks() {
  const plansR = await query(`SELECT * FROM training_plans WHERE status = 'active'`);
  const plans = plansR.rows || [];
  if (!plans.length) return [];

  const results = [];
  for (const plan of plans) {
    const phaseR = await query(
      `SELECT * FROM training_plan_phases WHERE plan_id = $1 AND week = $2`,
      [plan.id, plan.current_week]
    );
    const phase = phaseR.rows?.[0];
    if (!phase) continue;

    let suggestedSops = [];
    switch (plan.current_week) {
      case 2:
        // 岗位SOP — 按档口筛选，每个 active SOP 都在候选池
        suggestedSops = await querySopsByStation(null, plan.store);
        break;
      case 3:
        // 跨岗联动 — 跨不同档口的 SOP
        suggestedSops = await querySopsCrossStation(plan.store);
        break;
      default:
        // 基础通识 / 综合考核 — general 类目 SOP
        suggestedSops = await querySopsByCategory('general', plan.store);
    }

    results.push({
      planId: plan.id,
      employeeId: plan.employee_id,
      employeeName: plan.employee_name,
      store: plan.store,
      currentWeek: plan.current_week,
      phaseName: phase.phase_name,
      phaseStatus: phase.status,
      examCount: phase.exam_count,
      passScore: Number(phase.pass_score),
      suggestedSops: suggestedSops.slice(0, 10)
    });
  }
  return results;
}

/* ── 门店周报 ── */

export async function getWeeklyProgress(store) {
  const params = [];
  const conds = [];
  let idx = 1;
  if (store) { conds.push(`tp.store = $${idx++}`); params.push(store); }
  const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';

  const r = await query(`
    SELECT
      tp.store,
      COUNT(DISTINCT tp.id)::int AS total_employees,
      COUNT(DISTINCT tp.id) FILTER (WHERE tp.status = 'active')::int AS active_count,
      COUNT(DISTINCT tp.id) FILTER (WHERE tp.status = 'completed')::int AS completed_count,
      COUNT(DISTINCT tp.id) FILTER (WHERE tp.status = 'paused')::int AS paused_count,
      COALESCE(AVG(tp.current_week), 0)::numeric(5,2) AS avg_week,
      COUNT(tpp.id) FILTER (WHERE tpp.status = 'completed')::int AS completed_phases
    FROM training_plans tp
    LEFT JOIN training_plan_phases tpp ON tpp.plan_id = tp.id
    ${where}
    GROUP BY tp.store
    ORDER BY tp.store
  `, params);

  return r.rows || [];
}

/* ── SOP 查询 Helpers（供阶段内容建议使用） ── */

/**
 * 按档口查询 SOP 定义
 * @param {string|null} station
 * @param {string|null} store
 * @returns {Promise<Array>}
 */
export async function querySopsByStation(station, store) {
  const conds = ["status = 'active'"];
  const params = [];
  let idx = 1;
  if (station) { conds.push(`station = $${idx++}`); params.push(station); }
  if (store) { conds.push(`(store IS NULL OR store = $${idx++})`); params.push(store); }
  const r = await query(
    `SELECT * FROM sop_definitions WHERE ${conds.join(' AND ')} ORDER BY category, dish_name`,
    params
  );
  return r.rows || [];
}

/**
 * 按类目查询 SOP 定义
 * @param {string|null} category
 * @param {string|null} store
 * @returns {Promise<Array>}
 */
export async function querySopsByCategory(category, store) {
  const conds = ["status = 'active'"];
  const params = [];
  let idx = 1;
  if (category) { conds.push(`category = $${idx++}`); params.push(category); }
  if (store) { conds.push(`(store IS NULL OR store = $${idx++})`); params.push(store); }
  const r = await query(
    `SELECT * FROM sop_definitions WHERE ${conds.join(' AND ')} ORDER BY station, dish_name`,
    params
  );
  return r.rows || [];
}

/**
 * 跨档口 SOP 查询（周3学习推荐 — 每个档口取一部分）
 * @param {string|null} store
 * @returns {Promise<Array>}
 */
async function querySopsCrossStation(store) {
  const conds = ["status = 'active'"];
  const params = [];
  let idx = 1;
  if (store) { conds.push(`(store IS NULL OR store = $${idx++})`); params.push(store); }
  const r = await query(
    `SELECT * FROM sop_definitions WHERE ${conds.join(' AND ')} ORDER BY station, dish_name`,
    params
  );
  return r.rows || [];
}
