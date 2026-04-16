import { Router } from 'express';
import { getConfig, getAllConfigs, upsertConfig, getConfigAuditLog } from '../services/config-service.js';
import { authRequired, requireRole } from '../middleware/auth.js';
import { query } from '../utils/db.js';
import { getBitableStatus, pollAllBitableTables } from '../services/bitable-poller.js';
import { logger } from '../utils/logger.js';
import { getShanghaiYmdParts } from '../utils/anomaly-week-bounds.js';
import { startRandomInspections } from '../services/random-inspection.js';
import { scheduleProactiveOutcomeOnClose } from '../services/proactive-v2/proactive-task-outcome-on-close.js';

const r = Router();
const admin = [authRequired, requireRole('admin','hq_manager')];

/** 与 canViewAllStores 对齐：可手动关闭任务的角色（JWT / feishu_users.role） */
const CLOSE_TASK_ROLES = ['admin', 'hq_manager', 'hr_manager'];

function isMissingColumnError(e) {
  return /column .* does not exist/i.test(String(e?.message || ''));
}

/**
 * V2：`agent, store, username, latency_ms, has_evidence, evidence_violation`
 * 旧 HRMS 同表名：`agent_id, task_type, status, execution_time_ms`（无 agent/store 等）
 */
async function selectAgentTaskLogsV2(whereClause, params) {
  const r2 = await query(
    `SELECT agent, store, username, latency_ms, has_evidence, evidence_violation, created_at
     FROM agent_task_logs ${whereClause}`,
    params
  );
  return r2.rows;
}

async function selectAgentTaskLogsLegacy(whereClause, params) {
  const r2 = await query(
    `SELECT agent_id AS agent, NULL::text AS store, NULL::text AS username,
            execution_time_ms AS latency_ms, false AS has_evidence,
            (COALESCE(lower(status), '') NOT IN ('success', 'ok', 'completed', 'done')) AS evidence_violation,
            created_at
     FROM agent_task_logs ${whereClause}`,
    params
  );
  return r2.rows;
}

async function fetchAgentTaskLogsForDashboard24h() {
  try {
    return await selectAgentTaskLogsV2(`WHERE created_at > NOW() - INTERVAL '24 hours' ORDER BY created_at DESC LIMIT 100`, []);
  } catch (e) {
    if (!isMissingColumnError(e)) throw e;
    return await selectAgentTaskLogsLegacy(`WHERE created_at > NOW() - INTERVAL '24 hours' ORDER BY created_at DESC LIMIT 100`, []);
  }
}

/** 001 迁移版 anomaly_triggers 无 description/category；充值类用中文摘要 */
const ANOMALY_DESC_EXPR = `CASE WHEN anomaly_key = 'recharge_zero' THEN
  '判定营业日' || COALESCE(
    NULLIF(trim(trigger_value->>'evaluated_business_day'), ''),
    NULLIF(trim(trigger_value->>'evaluationYmd'), ''),
    NULLIF(trim(trigger_value->>'dateToday'), ''),
    trigger_date::text
  ) || '：充值' || COALESCE(trigger_value->'today'->>'count', '0')
  || '笔、金额¥' || COALESCE(trigger_value->'today'->>'amount', '0')
  || '；自' || COALESCE(trigger_value->>'month_start', '（未知）')
  || '起连续无充值' || COALESCE(trigger_value->>'consecutive_zero_days', '?')
  || '日，扣绩效' || COALESCE(trigger_value->>'penalty_points', '?') || '分。'
ELSE COALESCE(trigger_value::text, task_id::text, '') END`;

const SQL_ANOMALY_DRILL = `SELECT anomaly_key, store, severity,
  ${ANOMALY_DESC_EXPR} AS description,
  trigger_date, status, anomaly_key AS category, created_at
  FROM anomaly_triggers WHERE trigger_date >= CURRENT_DATE - 7
  ORDER BY created_at DESC LIMIT 100`;

const SQL_ANOMALY_ACTIVITY_DAY = `SELECT anomaly_key, store, severity, trigger_value, status,
  trigger_date::text AS trigger_date,
  ${ANOMALY_DESC_EXPR} AS description, created_at
  FROM anomaly_triggers WHERE trigger_date = $1::date ORDER BY created_at DESC LIMIT 100`;

/** 管理员或总部主管：手动关闭 master_tasks（测试 / 误报 / 下钻列表逐条关闭） */
r.post('/admin/task/:taskId/close', authRequired, requireRole(...CLOSE_TASK_ROLES), async (req, res) => {
  try {
    const taskId = String(req.params.taskId || '').trim();
    if (!taskId) return res.status(400).json({ error: 'taskId required' });
    const reason = String(req.body?.reason || '管理员手动关闭').trim().slice(0, 500);
    const by = String(req.user?.username || 'admin').trim().slice(0, 120);
    const suffix = `\n\n【管理员关闭】${reason} — ${by}`;
    const upd = await query(
      `UPDATE master_tasks
       SET status = 'closed',
           closed_at = NOW(),
           updated_at = NOW(),
           resolution_code = COALESCE(resolution_code, 'admin_closed'),
           detail = COALESCE(detail, '') || $2::text
       WHERE task_id = $1
         AND status NOT IN ('closed', 'settled')
       RETURNING task_id`,
      [taskId, suffix]
    );
    if (!upd.rows?.length) {
      return res.status(404).json({ error: '任务不存在或已关闭' });
    }
    scheduleProactiveOutcomeOnClose(upd.rows[0].task_id, { newStatus: 'closed' });
    return res.json({ ok: true, taskId: upd.rows[0].task_id });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

// Agent configs
r.get('/agent-config', ...admin, async (req,res) => {
  const ids=['master','data_auditor','ops_supervisor','chief_evaluator','train_advisor','appeal','marketing_planner','marketing_executor','procurement_advisor'];
  const c={}; for(const id of ids) c[id]=await getConfig(`agent_config_${id}`)||{enabled:true,prompt:'',temperature:0.3,maxTokens:800};
  res.json({agents:c});
});
r.put('/agent-config/:id', ...admin, async (req,res) => {
  await upsertConfig(`agent_config_${req.params.id}`,req.body,req.user?.username);
  res.json({ok:true});
});

// Routing rules
r.get('/routing-rules', ...admin, async (req,res) => {
  res.json({rules: await getConfig('routing_rules')||[]});
});
r.put('/routing-rules', ...admin, async (req,res) => {
  await upsertConfig('routing_rules',req.body.rules||[],req.user?.username);
  res.json({ok:true});
});

// Scoring rules
r.get('/scoring-rules', ...admin, async (req,res) => {
  res.json({rules: await getConfig('scoring_rules')||{}});
});
r.put('/scoring-rules', ...admin, async (req,res) => {
  await upsertConfig('scoring_rules',req.body.rules||{},req.user?.username);
  res.json({ok:true});
});

// System stats
r.get('/system-stats', authRequired, async (req,res) => {
  const [t,m,a] = await Promise.all([
    query('SELECT status,COUNT(*)::int as c FROM master_tasks GROUP BY status').catch(()=>({rows:[]})),
    query("SELECT COUNT(*)::int as c FROM agent_task_logs WHERE created_at>NOW()-INTERVAL '24h'").catch(()=>({rows:[{c:0}]})),
    query("SELECT COUNT(*)::int as c FROM anomaly_triggers WHERE trigger_date=CURRENT_DATE").catch(()=>({rows:[{c:0}]}))
  ]);
  res.json({tasks:t.rows, messages24h:m.rows[0]?.c||0, anomaliesToday:a.rows[0]?.c||0});
});

// Audit log
r.get('/audit-log', ...admin, async (req,res) => {
  const log = await getConfigAuditLog(req.query.key||null, parseInt(req.query.limit)||50);
  res.json({log});
});

// All configs list
r.get('/config', ...admin, async (req,res) => {
  res.json({configs: await getAllConfigs()});
});
// Single config by key
r.get('/config/:key', ...admin, async (req,res) => {
  const val = await getConfig(req.params.key);
  res.json({ config_key: req.params.key, config_value: val });
});
r.put('/config/:key', ...admin, async (req,res) => {
  const val = req.body.config_value ?? req.body.value ?? req.body;
  const desc = req.body.description || null;
  await upsertConfig(req.params.key, val, desc, req.user?.username);
  if (req.params.key === 'random_inspections') {
    try {
      await startRandomInspections();
      logger.info('random_inspections saved — scheduler restarted from DB');
    } catch (e) {
      logger.warn({ err: e?.message }, 'random_inspections restart after save failed');
    }
  }
  res.json({ok:true});
});

// ─── Marketing Campaigns CRUD ───
r.get('/campaigns', ...admin, async (req, res) => {
  const store = req.query.store || null;
  const status = req.query.status || null;
  let sql = 'SELECT * FROM marketing_campaigns WHERE 1=1';
  const params = [];
  if (store) { params.push(`%${store}%`); sql += ` AND store ILIKE $${params.length}`; }
  if (status) { params.push(status); sql += ` AND status = $${params.length}`; }
  sql += ' ORDER BY created_at DESC LIMIT 50';
  const result = await query(sql, params);
  res.json({ campaigns: result.rows });
});

r.post('/campaigns', ...admin, async (req, res) => {
  const { store, title, description, status, start_date, end_date, target_metric, target_value, budget_amount, notes } = req.body;
  const result = await query(
    `INSERT INTO marketing_campaigns (store, title, description, status, start_date, end_date, target_metric, target_value, budget_amount, notes, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
    [store, title, description, status || 'planned', start_date, end_date, target_metric, target_value, budget_amount, notes, req.user?.username || 'admin']
  );
  res.json({ ok: true, campaign: result.rows[0] });
});

r.put('/campaigns/:id', ...admin, async (req, res) => {
  const { title, description, status, start_date, end_date, target_metric, target_value, actual_value, budget_amount, spent_amount, notes } = req.body;
  await query(
    `UPDATE marketing_campaigns SET title=COALESCE($1,title), description=COALESCE($2,description),
     status=COALESCE($3,status), start_date=COALESCE($4,start_date), end_date=COALESCE($5,end_date),
     target_metric=COALESCE($6,target_metric), target_value=COALESCE($7,target_value),
     actual_value=COALESCE($8,actual_value), budget_amount=COALESCE($9,budget_amount),
     spent_amount=COALESCE($10,spent_amount), notes=COALESCE($11,notes), updated_at=NOW()
     WHERE id=$12`,
    [title, description, status, start_date, end_date, target_metric, target_value, actual_value, budget_amount, spent_amount, notes, req.params.id]
  );
  res.json({ ok: true });
});

r.delete('/campaigns/:id', ...admin, async (req, res) => {
  await query('DELETE FROM marketing_campaigns WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
});

// ─── Marketing Templates ───
r.get('/templates', ...admin, async (req, res) => {
  const result = await query('SELECT * FROM marketing_templates ORDER BY success_rate DESC');
  res.json({ templates: result.rows });
});
r.post('/templates', ...admin, async (req, res) => {
  const { name, category, description, actions, expected_roi, budget_range, duration_days } = req.body;
  const result = await query(
    `INSERT INTO marketing_templates (name, category, description, actions, expected_roi, budget_range, duration_days)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [name, category, description, JSON.stringify(actions), expected_roi, budget_range, duration_days]
  );
  res.json({ ok: true, template: result.rows[0] });
});
r.delete('/templates/:id', ...admin, async (req, res) => {
  await query('DELETE FROM marketing_templates WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
});

// ─── Store-level Metrics Filtering ───
r.get('/metrics', authRequired, async (req, res) => {
  const user = req.user;
  const store = req.query.store || user?.store || null;
  // 门店级权限: 非admin/hq_manager只能看自己门店
  const isHQ = ['admin', 'hq_manager'].includes(user?.role);
  let sql = `SELECT date, store, actual_revenue, budget_rate, dine_traffic, dine_orders,
             delivery_actual, efficiency, actual_margin FROM daily_reports WHERE 1=1`;
  const params = [];
  if (!isHQ && user?.store) {
    params.push(user.store);
    sql += ` AND store = $${params.length}`;
  } else if (store) {
    params.push(`%${store}%`);
    sql += ` AND store ILIKE $${params.length}`;
  }
  sql += ' ORDER BY date DESC LIMIT 60';
  const result = await query(sql, params);
  res.json({ metrics: result.rows, filtered: !isHQ });
});

// ─── Idempotency Key Persistence ───
r.get('/idempotency/:key', authRequired, async (req, res) => {
  const result = await query(
    `SELECT key, result, created_at FROM idempotency_keys WHERE key = $1 AND created_at > NOW() - INTERVAL '24h'`,
    [req.params.key]
  ).catch(() => ({ rows: [] }));
  res.json({ exists: result.rows.length > 0, data: result.rows[0] || null });
});

// ─── Agent Evaluation (Phase 7) ───
r.get('/agent-evaluation', ...admin, async (req, res) => {
  try {
    const { evaluateAllAgents } = await import('../services/agent-evaluation.js');
    const report = await evaluateAllAgents();
    res.json(report);
  } catch (e) { res.json({ error: e?.message }); }
});
r.get('/agent-evaluation/:id', ...admin, async (req, res) => {
  try {
    const { evaluateAgent } = await import('../services/agent-evaluation.js');
    const report = await evaluateAgent(req.params.id);
    res.json(report);
  } catch (e) { res.json({ error: e?.message }); }
});

// ─── Procurement Advice (Phase 7) ───
r.get('/procurement/:store', ...admin, async (req, res) => {
  try {
    const { generateProcurementAdvice } = await import('../services/procurement-agent.js');
    const advice = await generateProcurementAdvice(req.params.store);
    res.json(advice);
  } catch (e) { res.json({ error: e?.message }); }
});

// ─── Platform Data (Phase 6) ───
r.get('/platform/:platform/:store', ...admin, async (req, res) => {
  try {
    const { fetchPlatformData } = await import('../services/platform-integration.js');
    const result = await fetchPlatformData(req.params.platform, req.params.store);
    res.json(result);
  } catch (e) { res.json({ ok: false, error: e?.message }); }
});

// ─── Delivery Data Manual Upload ───
r.post('/delivery-data', ...admin, async (req, res) => {
  const { store, date, delivery_avg_rating, delivery_bad_reviews, delivery_commission,
          delivery_new_followers, delivery_promotion_cost, delivery_cancel_count,
          delivery_actual, delivery_orders, delivery_pre_revenue } = req.body;
  if (!store || !date) return res.status(400).json({ error: 'store and date required' });
  try {
    const setClauses = [];
    const params = [store, date];
    const fields = { delivery_avg_rating, delivery_bad_reviews, delivery_commission,
      delivery_new_followers, delivery_promotion_cost, delivery_cancel_count,
      delivery_actual, delivery_orders, delivery_pre_revenue };
    for (const [k, v] of Object.entries(fields)) {
      if (v !== undefined && v !== null && v !== '') {
        params.push(v);
        setClauses.push(`${k} = $${params.length}`);
      }
    }
    if (!setClauses.length) return res.status(400).json({ error: 'No delivery fields provided' });
    const result = await query(
      `UPDATE daily_reports SET ${setClauses.join(', ')}, updated_at = NOW()
       WHERE store ILIKE $1 AND date = $2::date RETURNING id, store, date`,
      params
    );
    if (!result.rows?.length) return res.status(404).json({ error: 'No daily_report found for this store/date' });
    res.json({ ok: true, updated: result.rows[0] });
  } catch (e) { res.status(500).json({ error: e?.message }); }
});

r.get('/delivery-data/:store', ...admin, async (req, res) => {
  const result = await query(
    `SELECT date, delivery_actual, delivery_orders, delivery_pre_revenue,
            delivery_avg_rating, delivery_bad_reviews, delivery_commission,
            delivery_new_followers, delivery_promotion_cost, delivery_cancel_count
     FROM daily_reports WHERE store ILIKE $1 AND date >= CURRENT_DATE - 30
     ORDER BY date DESC LIMIT 30`,
    [`%${req.params.store}%`]
  );
  res.json({ records: result.rows });
});

// ─── Agent Memory ───
r.get('/agent-memory/:agentId', ...admin, async (req, res) => {
  try {
    const { recallMemories } = await import('../services/agent-memory.js');
    const memories = await recallMemories(req.params.agentId, req.query.store || '', req.query.topic || '', 20);
    res.json({ memories });
  } catch (e) { res.json({ memories: [], error: e?.message }); }
});

// ─── Knowledge Base CRUD ───
r.get('/knowledge-base', ...admin, async (req, res) => {
  const result = await query('SELECT id, title, category, enabled, created_at, updated_at, LENGTH(content) as content_length FROM knowledge_base ORDER BY updated_at DESC LIMIT 100').catch(() => ({ rows: [] }));
  res.json({ items: result.rows });
});
r.get('/knowledge-base/:id', ...admin, async (req, res) => {
  const result = await query('SELECT * FROM knowledge_base WHERE id = $1', [req.params.id]).catch(() => ({ rows: [] }));
  res.json(result.rows[0] || {});
});
r.post('/knowledge-base', ...admin, async (req, res) => {
  const { title, content, category } = req.body;
  if (!title || !content) return res.status(400).json({ error: 'title and content required' });
  const result = await query('INSERT INTO knowledge_base (title, content, category, enabled) VALUES ($1,$2,$3,true) RETURNING id', [title, content, category || 'sop']);
  res.json({ ok: true, id: result.rows[0]?.id });
});
r.put('/knowledge-base/:id', ...admin, async (req, res) => {
  const { title, content, category, enabled } = req.body;
  await query('UPDATE knowledge_base SET title=COALESCE($1,title), content=COALESCE($2,content), category=COALESCE($3,category), enabled=COALESCE($4,enabled), updated_at=NOW() WHERE id=$5',
    [title, content, category, enabled, req.params.id]);
  res.json({ ok: true });
});
r.delete('/knowledge-base/:id', ...admin, async (req, res) => {
  await query('DELETE FROM knowledge_base WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
});

// ─── Feature Flags ───
r.get('/feature-flags', ...admin, async (req, res) => {
  const flags = await getConfig('feature_flags') || {};
  res.json({ flags });
});
r.put('/feature-flags', ...admin, async (req, res) => {
  await upsertConfig('feature_flags', req.body.flags || {}, req.user?.username);
  res.json({ ok: true });
});

// ─── Agent Activity (每日任务执行清单) ───
r.get('/agent-activity', ...admin, async (req, res) => {
  const date = String(req.query.date || '').trim() || getShanghaiYmdParts().ymd;
  const agent = req.query.agent || null;
  try {
    // 1. Task logs（兼容 V2 列名与旧 HRMS agent_task_logs）
    let taskLogs = { rows: [] };
    try {
      let taskSql = `SELECT agent, store, username, latency_ms, has_evidence, evidence_violation, created_at
                     FROM agent_task_logs WHERE created_at::date = $1::date`;
      const taskParams = [date];
      if (agent) { taskParams.push(agent); taskSql += ` AND agent = $${taskParams.length}`; }
      taskSql += ` ORDER BY created_at DESC LIMIT 200`;
      taskLogs = await query(taskSql, taskParams);
    } catch (e) {
      if (!isMissingColumnError(e)) throw e;
      let legSql = `SELECT agent_id AS agent, NULL::text AS store, NULL::text AS username,
                           execution_time_ms AS latency_ms, false AS has_evidence, false AS evidence_violation, created_at
                    FROM agent_task_logs WHERE created_at::date = $1::date`;
      const taskParams = [date];
      if (agent) { taskParams.push(agent); legSql += ` AND agent_id = $${taskParams.length}`; }
      legSql += ` ORDER BY created_at DESC LIMIT 200`;
      taskLogs = await query(legSql, taskParams).catch(() => ({ rows: [] }));
    }

    // 2. Rhythm execution logs
    let rhySql = `SELECT rhythm_type, status, result_summary, error_message, execution_time, created_at
                  FROM rhythm_logs WHERE execution_date = $1::date ORDER BY created_at DESC LIMIT 50`;
    const rhythmLogs = await query(rhySql, [date]).catch(() => ({ rows: [] }));

    // 3. Anomaly triggers（按业务 trigger_date，与次日凌晨落库的周/月规则一致）
    const anomalyTriggers = await query(SQL_ANOMALY_ACTIVITY_DAY, [date]).catch(() => ({ rows: [] }));

    // 3b. A/B/C 管理数据告警（飞书已成功发出后写入 agent_admin_alert_log）
    let adminAlerts = { rows: [] };
    try {
      adminAlerts = await query(
        `SELECT id, priority, alert_type, title,
                LEFT(body, 2500) AS body_preview, dedupe_key, recipient_count, sent_count, sent_at
         FROM agent_admin_alert_log
         WHERE DATE(timezone('Asia/Shanghai', sent_at)) = $1::date
         ORDER BY sent_at DESC
         LIMIT 100`,
        [date]
      );
    } catch (e) {
      if (!/relation .+ does not exist/i.test(String(e.message))) throw e;
    }

    // 4. Master tasks created/updated today
    let mtSql = `SELECT task_id, title, store, severity, status, current_agent AS agent, created_at, closed_at
                 FROM master_tasks WHERE created_at::date = $1::date OR closed_at::date = $1::date
                 ORDER BY created_at DESC LIMIT 100`;
    const masterTasks = await query(mtSql, [date]).catch(() => ({ rows: [] }));

    // 5. Agent-to-agent collaboration (marketing campaigns auto-created)
    let collabSql = `SELECT id, store, title, status, notes, created_at
                     FROM marketing_campaigns WHERE created_at::date = $1::date AND notes LIKE '%auto:%'
                     ORDER BY created_at DESC LIMIT 20`;
    const collabEvents = await query(collabSql, [date]).catch(() => ({ rows: [] }));

    // Build per-agent summary
    const agentSummary = {};
    for (const log of taskLogs.rows) {
      const a = log.agent || 'unknown';
      if (!agentSummary[a]) agentSummary[a] = { interactions: 0, stores: new Set(), avgLatency: 0, totalLatency: 0, evidenceViolations: 0 };
      agentSummary[a].interactions++;
      if (log.store) agentSummary[a].stores.add(log.store);
      agentSummary[a].totalLatency += (log.latency_ms || 0);
      if (log.evidence_violation) agentSummary[a].evidenceViolations++;
    }
    for (const [a, s] of Object.entries(agentSummary)) {
      s.avgLatency = s.interactions ? Math.round(s.totalLatency / s.interactions) : 0;
      s.stores = [...s.stores];
    }

    res.json({
      date,
      summary: agentSummary,
      taskLogs: taskLogs.rows,
      rhythmLogs: rhythmLogs.rows,
      anomalyTriggers: anomalyTriggers.rows,
      adminAlerts: adminAlerts.rows || [],
      masterTasks: masterTasks.rows,
      collabEvents: collabEvents.rows,
      totalInteractions: taskLogs.rows.length,
      totalAnomalies: anomalyTriggers.rows.length,
      totalRhythm: rhythmLogs.rows.length,
      totalAdminAlerts: (adminAlerts.rows || []).length
    });
  } catch (e) { res.status(500).json({ error: e?.message }); }
});

// ─── Dashboard drill-through: detailed data per metric ───
// 与 /system-stats 一致：仅需登录即可下钻（避免能看汇总却 403 且前端吞错显示「暂无数据」）
r.get('/dashboard-detail/:type', authRequired, async (req, res) => {
  const type = req.params.type;
  try {
    if (type === 'anomalies') {
      const r2 = await query(SQL_ANOMALY_DRILL);
      return res.json({ items: r2.rows });
    }
    if (type === 'tasks') {
      // 表字段为 current_agent（V2）；旧库若有 agent 列可再扩展 COALESCE
      const r2 = await query(`SELECT task_id, title, store, severity, status, current_agent AS agent, created_at, timeout_at, closed_at,
                                     EXTRACT(EPOCH FROM (COALESCE(closed_at,now()) - created_at))/3600 AS hours_open
                              FROM master_tasks WHERE status NOT IN ('closed','settled')
                              ORDER BY CASE severity WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END, created_at ASC LIMIT 100`);
      return res.json({ items: r2.rows });
    }
    if (type === 'messages') {
      const rows = await fetchAgentTaskLogsForDashboard24h();
      return res.json({ items: rows });
    }
    if (type === 'rhythm') {
      const r2 = await query(`SELECT rhythm_type, status, result_summary, error_message, execution_date, execution_time, created_at
                              FROM rhythm_logs WHERE execution_date >= CURRENT_DATE - 7
                              ORDER BY created_at DESC LIMIT 50`);
      return res.json({ items: r2.rows });
    }
    res.json({ items: [] });
  } catch (e) { res.status(500).json({ error: e?.message }); }
});

/**
 * P0/P1：知识源「体检」— RAG 表、Wiki 目录、MemPalace、近期 agent_memory、可选知识图谱行数；不含密钥。
 * GET /api/admin/knowledge-sources
 */
r.get('/admin/knowledge-sources', ...admin, async (req, res) => {
  const out = {
    ok: true,
    generatedAt: new Date().toISOString(),
    checklist: [
      'knowledge_base：HRMS 上传 PDF/文本后 train_advisor 才会在「<<< 文档」块中命中；扫描件需可复制文字。',
      'Wiki：knowledge/wiki 下 .md 由 data_auditor 等高质量输出写入；train_advisor / data_auditor 的 buildExperienceBlock 会检索。',
      'MemPalace：需 ENABLE_MEMPALACE=true 且进程可达；主要服务 marketing_planner 高分策略记忆。',
      '触发词清单见仓库 agents-service-v2/docs/AGENT_KNOWLEDGE_TRIGGER_KEYWORDS.md'
    ]
  };
  try {
    const kbScopes = await query(
      `SELECT COALESCE(NULLIF(TRIM(scope), ''), '(null)') AS scope, COUNT(*)::int AS cnt
       FROM knowledge_base WHERE enabled IS DISTINCT FROM false
       GROUP BY 1 ORDER BY cnt DESC`
    ).catch(() => ({ rows: [] }));
    const kbTotal = await query(
      `SELECT COUNT(*)::int AS c, MAX(updated_at) AS last_updated FROM knowledge_base WHERE enabled IS DISTINCT FROM false`
    ).catch(() => ({ rows: [{}] }));
    out.knowledgeBaseRag = {
      byScope: kbScopes.rows || [],
      totalRows: Number(kbTotal.rows?.[0]?.c || 0),
      lastUpdated: kbTotal.rows?.[0]?.last_updated || null
    };
  } catch (e) {
    out.knowledgeBaseRag = { error: String(e?.message || e) };
  }

  try {
    const memR = await query(
      `SELECT agent_id, COUNT(*)::int AS cnt
       FROM agent_memory
       WHERE created_at > NOW() - INTERVAL '7 days'
       GROUP BY agent_id
       ORDER BY cnt DESC
       LIMIT 24`
    ).catch(() => ({ rows: [] }));
    const memTotal = await query(
      `SELECT COUNT(*)::int AS c FROM agent_memory WHERE created_at > NOW() - INTERVAL '7 days'`
    ).catch(() => ({ rows: [{ c: 0 }] }));
    out.agentMemoryPg = {
      last7DaysTotal: Number(memTotal.rows?.[0]?.c || 0),
      byAgentId: memR.rows || []
    };
  } catch (e) {
    out.agentMemoryPg = { error: String(e?.message || e) };
  }

  try {
    const ex = await query(`SELECT COUNT(*)::int AS c FROM agent_experience`).catch(() => ({ rows: [{ c: 0 }] }));
    out.agentExperience = { totalRows: Number(ex.rows?.[0]?.c || 0) };
  } catch (e) {
    out.agentExperience = { error: String(e?.message || e) };
  }

  try {
    const ber = await query(`SELECT COUNT(*)::int AS c FROM business_entity_relations`).catch(() => null);
    if (ber && ber.rows?.length) {
      out.knowledgeGraphPg = { businessEntityRelationRows: Number(ber.rows[0].c || 0) };
    } else {
      out.knowledgeGraphPg = { businessEntityRelationRows: 0, note: '表不存在或无行' };
    }
  } catch (e) {
    out.knowledgeGraphPg = { error: String(e?.message || e), note: 'HRMS 知识图谱表可能未迁移到当前库' };
  }

  try {
    const { probeWikiKnowledgeHealth } = await import('../services/knowledge/wiki-retriever.js');
    out.wikiMd = probeWikiKnowledgeHealth();
  } catch (e) {
    out.wikiMd = { error: String(e?.message || e) };
  }

  try {
    const { probeMemPalaceHealth } = await import('../services/memory-adapter.js');
    out.mempalace = await probeMemPalaceHealth();
  } catch (e) {
    out.mempalace = { error: String(e?.message || e) };
  }

  out.envHints = {
    ENABLE_MEMPALACE: process.env.ENABLE_MEMPALACE === 'true',
    MEMPALACE_URL_SET: !!String(process.env.MEMPALACE_URL || '').trim(),
    KNOWLEDGE_USE_DEEPSEEK: String(process.env.KNOWLEDGE_USE_DEEPSEEK || '').trim().toLowerCase() !== 'false',
    WIKI_DATA_DIR_SET: !!String(process.env.WIKI_DATA_DIR || '').trim()
  };

  res.json(out);
});

/**
 * 定时报告飞书投递明细（来自 report-delivery.js 落库）。
 * 例：查某日考勤日报谁未送达 — GET /api/admin/report-delivery?run_ymd=2026-04-15&failures_only=1
 */
r.get('/admin/report-delivery', ...admin, async (req, res) => {
  try {
    const { getShanghaiNowClock } = await import('../utils/cron-run-monitor.js');
    const jobKey = String(req.query?.job_key || 'daily_attendance_report').trim().slice(0, 120);
    let runYmd = String(req.query?.run_ymd || '').trim().slice(0, 12);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(runYmd)) {
      runYmd = getShanghaiNowClock().ymd;
    }
    const failuresOnly = String(req.query?.failures_only ?? '1').trim() === '1';
    const lim = Math.min(500, Math.max(1, parseInt(String(req.query?.limit || '200'), 10) || 200));
    const whereFail = failuresOnly ? 'AND s.ok = false' : '';
    const r2 = await query(
      `SELECT s.job_key, s.run_ymd, s.username, s.scope, s.ok, s.attempts, s.last_error,
              s.updated_at,
              u.name AS feishu_name,
              u.role AS feishu_role,
              u.store AS feishu_store,
              u.open_id IS NOT NULL AND btrim(u.open_id) <> '' AS has_open_id
       FROM agent_v2_scheduled_report_sends s
       LEFT JOIN feishu_users u ON lower(trim(COALESCE(u.username,''))) = lower(trim(COALESCE(s.username,'')))
       WHERE s.job_key = $1 AND s.run_ymd = $2 ${whereFail}
       ORDER BY s.ok ASC, s.updated_at DESC
       LIMIT ${lim}`,
      [jobKey, runYmd]
    );
    const rows = r2.rows || [];
    res.json({
      jobKey,
      runYmd,
      failuresOnly,
      count: rows.length,
      items: rows,
      note: 'ok=false 表示该用户在当日该任务下最终未成功送达（已重试）。若 has_open_id=false 多为未绑定飞书 open_id。'
    });
  } catch (e) {
    if (/does not exist|relation.*agent_v2_scheduled_report_sends/i.test(String(e?.message || ''))) {
      return res.status(404).json({ error: '表尚未创建（尚无定时报告投递记录）', detail: String(e?.message || e) });
    }
    res.status(500).json({ error: String(e?.message || e) });
  }
});

// ─── Bitable Polling Status & Manual Trigger ───
r.get('/bitable-status', ...admin, async (req, res) => {
  const status = getBitableStatus();
  const recentCount = await query(
    `SELECT COUNT(*) as cnt FROM feishu_generic_records WHERE created_at > NOW() - INTERVAL '24h'`
  ).catch(() => ({ rows: [{ cnt: 0 }] }));
  res.json({ ...status, recentRecords24h: parseInt(recentCount.rows[0]?.cnt || 0) });
});
r.post('/bitable-poll', ...admin, async (req, res) => {
  pollAllBitableTables().catch(() => {});
  res.json({ ok: true, message: 'Poll triggered in background' });
});

// ─── Delete config ───
r.delete('/config/:key', ...admin, async (req, res) => {
  await query('DELETE FROM agent_v2_configs WHERE config_key = $1', [req.params.key]).catch(() => {});
  res.json({ ok: true });
});

export default r;
