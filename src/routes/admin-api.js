import { Router } from 'express';
import { getConfig, getAllConfigs, upsertConfig, getConfigAuditLog } from '../services/config-service.js';
import { authRequired, requireRole } from '../middleware/auth.js';
import { query } from '../utils/db.js';
import { getBitableStatus, pollAllBitableTables } from '../services/bitable-poller.js';

const r = Router();
const admin = [authRequired, requireRole('admin','hq_manager')];

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
  const date = req.query.date || new Date().toISOString().slice(0, 10);
  const agent = req.query.agent || null;
  try {
    // 1. Task logs (agent interactions)
    let taskSql = `SELECT agent, store, username, latency_ms, has_evidence, evidence_violation, created_at
                   FROM agent_task_logs WHERE created_at::date = $1::date`;
    const taskParams = [date];
    if (agent) { taskParams.push(agent); taskSql += ` AND agent = $${taskParams.length}`; }
    taskSql += ` ORDER BY created_at DESC LIMIT 200`;
    const taskLogs = await query(taskSql, taskParams).catch(() => ({ rows: [] }));

    // 2. Rhythm execution logs
    let rhySql = `SELECT rhythm_type, status, result_summary, error_message, execution_time, created_at
                  FROM rhythm_logs WHERE execution_date = $1::date ORDER BY created_at DESC LIMIT 50`;
    const rhythmLogs = await query(rhySql, [date]).catch(() => ({ rows: [] }));

    // 3. Anomaly triggers
    let anomSql = `SELECT anomaly_key, store, severity, trigger_value, status, category, description, created_at
                   FROM anomaly_triggers WHERE trigger_date = $1::date ORDER BY created_at DESC LIMIT 100`;
    const anomalyTriggers = await query(anomSql, [date]).catch(() => ({ rows: [] }));

    // 4. Master tasks created/updated today
    let mtSql = `SELECT task_id, title, store, severity, status, agent, created_at, closed_at
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
      masterTasks: masterTasks.rows,
      collabEvents: collabEvents.rows,
      totalInteractions: taskLogs.rows.length,
      totalAnomalies: anomalyTriggers.rows.length,
      totalRhythm: rhythmLogs.rows.length
    });
  } catch (e) { res.status(500).json({ error: e?.message }); }
});

// ─── Dashboard drill-through: detailed data per metric ───
r.get('/dashboard-detail/:type', ...admin, async (req, res) => {
  const type = req.params.type;
  try {
    if (type === 'anomalies') {
      const r2 = await query(`SELECT anomaly_key, store, severity, description, trigger_date, status, category, created_at
                              FROM anomaly_triggers WHERE trigger_date >= CURRENT_DATE - 7
                              ORDER BY created_at DESC LIMIT 100`);
      return res.json({ items: r2.rows });
    }
    if (type === 'tasks') {
      const r2 = await query(`SELECT task_id, title, store, severity, status, agent, created_at, timeout_at, closed_at,
                                     EXTRACT(EPOCH FROM (COALESCE(closed_at,now()) - created_at))/3600 AS hours_open
                              FROM master_tasks WHERE status NOT IN ('closed','settled')
                              ORDER BY CASE severity WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END, created_at ASC LIMIT 100`);
      return res.json({ items: r2.rows });
    }
    if (type === 'messages') {
      const r2 = await query(`SELECT agent, store, username, latency_ms, has_evidence, evidence_violation, created_at
                              FROM agent_task_logs WHERE created_at > NOW() - INTERVAL '24h'
                              ORDER BY created_at DESC LIMIT 100`);
      return res.json({ items: r2.rows });
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
