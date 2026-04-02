import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import path from 'path';
import { fileURLToPath } from 'url';
import cron from 'node-cron';
import { logger } from './utils/logger.js';
import { checkDbHealth } from './utils/db.js';
import { checkRedisHealth } from './utils/queue.js';
import { authRequired, requireRole } from './middleware/auth.js';
import { startRhythmScheduler, morningStandup, patrol, endOfDay, weeklyReport, monthlyEvaluation } from './services/rhythm-engine.js';
import { runAnomalyChecks, checkFoodSafetyFromMessage } from './services/anomaly-engine.js';
import { calculateAllStoresKPI } from './services/kpi-calculator.js';
import {
  getConfig, getAllConfigs, upsertConfig, deleteConfig, invalidateCache,
  getAnomalyRules, getSlaConfig, getEscalationConfig, getPushConfig, getRhythmSchedule, getAutoDecision,
  getAllKpiTargets, upsertKpiTarget, deleteKpiTarget, getKpiTarget,
  calculateKpiAchievement, getConfigAuditLog
} from './services/config-service.js';
import { verifyLLMHealth, getProviderHealthStatus, getCostStats, getPerformanceMetrics } from './services/llm-provider.js';
import { handleWebhookEvent, handleCardAction, getFeishuStatus, sendText as feishuSendText } from './services/feishu-client.js';
import { routeMessage, checkPermission, VALID_ROUTES } from './services/message-router.js';
import { createTask, transitionTask, getTask, getTasksByStore, getTaskStats, scanEscalations, STATUS_FLOW } from './services/task-state-machine.js';
import { processMessage } from './services/message-pipeline.js';
import { dispatchToAgent } from './services/agent-handlers.js';
import { ensureKnowledgeTable, searchKnowledge, addKnowledge, listKnowledge } from './services/knowledge-base.js';
import { calcDeductions, storeRating, calcBonus } from './services/scoring-model.js';
import { getAllMetricDefs, executeMetrics, extractTimeRangeFromText } from './services/data-executor.js';
import { startEscalationScheduler } from './workers/escalation-worker.js';
import { startBitablePolling, stopBitablePolling, getBitableStatus, pollAllBitableTables } from './services/bitable-poller.js';
import { startRandomInspections, getRandomInspectionStatus, triggerManualInspection } from './services/random-inspection.js';
import adminApi from './routes/admin-api.js';

const app = express();
const PORT = parseInt(process.env.PORT || '3100');

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'", "https://cdn.tailwindcss.com"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://cdn.tailwindcss.com"],
      imgSrc: ["'self'", "data:", "https:"],
      connectSrc: ["'self'", "https:", "http:"],
      fontSrc: ["'self'", "https:", "data:"],
      scriptSrcAttr: ["'self'", "'unsafe-inline'"],
      upgradeInsecureRequests: null,
    }
  }
}));
app.use(cors());
app.use(express.json({ limit: '5mb' }));
// 用于接收飞书加密请求（需要 raw body 来解密）
app.use('/api/webhook/feishu', express.raw({ type: 'application/json' }));

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
app.use(express.static(path.join(__dirname, '..', 'public'), {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.js') || filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    }
  }
}));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'admin.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'admin.html')));

// ─── Health Check ───
app.get('/health', async (req, res) => {
  const db = await checkDbHealth();
  const redis = await checkRedisHealth();
  res.json({
    ok: db,
    service: 'agents-service-v2',
    version: '1.0.0',
    database: db,
    redis,
    uptime: process.uptime(),
    now: new Date().toISOString()
  });
});

// ─── Admin Login (username/password → JWT) ───
import jwt from 'jsonwebtoken';
import { query } from './utils/db.js';

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Missing credentials' });
  try {
    // Check hardcoded admin first
    const adminUser = process.env.ADMIN_USERNAME || 'admin';
    const adminPass = process.env.ADMIN_PASSWORD || 'admin123';
    if (username === adminUser && password === adminPass) {
      const token = jwt.sign({ username, role: 'admin' }, process.env.JWT_SECRET, { expiresIn: '30d' });
      return res.json({ ok: true, token, user: { username, role: 'admin' } });
    }
    // Check DB users (feishu_users or employees)
    const r = await query(
      `SELECT username, role, store FROM feishu_users WHERE lower(username) = lower($1) AND registered = TRUE LIMIT 1`,
      [username]
    ).catch(() => ({ rows: [] }));
    if (r.rows?.[0]) {
      const u = r.rows[0];
      // For DB users, password is their username (simple) or can be extended
      if (password === username || password === adminPass) {
        const token = jwt.sign({ username: u.username, role: u.role, store: u.store }, process.env.JWT_SECRET, { expiresIn: '30d' });
        return res.json({ ok: true, token, user: { username: u.username, role: u.role, store: u.store } });
      }
    }
    res.status(401).json({ error: '用户名或密码错误' });
  } catch (e) {
    logger.error({ err: e?.message }, 'Login failed');
    res.status(500).json({ error: 'Login error' });
  }
});

// ═══════════════════════════════════════════════════════
// Config CRUD API — 前端配置 → DB存储 → 后端执行
// ═══════════════════════════════════════════════════════

// 读取所有配置（设置中心首页）
app.get('/api/config', authRequired, async (req, res) => {
  try {
    const configs = await getAllConfigs();
    res.json({ configs });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 读取单个配置
app.get('/api/config/:key', authRequired, async (req, res) => {
  try {
    const value = await getConfig(req.params.key);
    if (!value) return res.status(404).json({ error: `Config '${req.params.key}' not found` });
    res.json({ config_key: req.params.key, config_value: value });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 创建/更新配置（前端设置中心写入）
app.put('/api/config/:key', authRequired, requireRole('admin', 'hq_manager'), async (req, res) => {
  try {
    const { config_value, description } = req.body;
    if (!config_value) return res.status(400).json({ error: 'config_value is required' });
    const result = await upsertConfig(req.params.key, config_value, description, req.user?.username || 'unknown');
    res.json({ ok: true, ...result });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 删除配置
app.delete('/api/config/:key', authRequired, requireRole('admin'), async (req, res) => {
  try {
    const result = await deleteConfig(req.params.key, req.user?.username || 'unknown');
    res.json({ ok: true, ...result });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 刷新配置缓存
app.post('/api/config/cache/invalidate', authRequired, requireRole('admin', 'hq_manager'), (req, res) => {
  invalidateCache(req.body?.key);
  res.json({ ok: true, message: 'Cache invalidated' });
});

// 配置变更审计日志
app.get('/api/config-audit', authRequired, async (req, res) => {
  try {
    const { key, limit = 50 } = req.query;
    const logs = await getConfigAuditLog(key, limit);
    res.json({ logs });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 便捷读取（向后兼容）
app.get('/api/config/anomaly-rules', authRequired, async (req, res) => {
  try { res.json({ rules: await getAnomalyRules() }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/config/sla', authRequired, async (req, res) => {
  try { res.json(await getSlaConfig()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/config/escalation', authRequired, async (req, res) => {
  try { res.json(await getEscalationConfig()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/config/push', authRequired, async (req, res) => {
  try { res.json(await getPushConfig()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/config/rhythm-schedule', authRequired, async (req, res) => {
  try { res.json(await getRhythmSchedule()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/config/auto-decision', authRequired, async (req, res) => {
  try { res.json(await getAutoDecision()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Anomaly API ───
app.post('/api/anomaly/run', authRequired, requireRole('admin', 'hq_manager'), async (req, res) => {
  try {
    const { frequency = 'daily', stores } = req.body;
    const storeList = stores || await getActiveStores();
    const results = await runAnomalyChecks(frequency, storeList);
    res.json({ ok: true, results });
  } catch (e) {
    logger.error({ err: e }, 'Manual anomaly run failed');
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/anomaly/food-safety-check', authRequired, async (req, res) => {
  try {
    const { store, content } = req.body;
    const result = await checkFoodSafetyFromMessage(store, content);
    res.json({ ok: true, result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/anomaly/triggers', authRequired, async (req, res) => {
  try {
    const { store, status, severity, limit = 50 } = req.query;
    let sql = `SELECT * FROM anomaly_triggers WHERE 1=1`;
    const params = [];
    if (store) { params.push(store); sql += ` AND store = $${params.length}`; }
    if (status) { params.push(status); sql += ` AND status = $${params.length}`; }
    if (severity) { params.push(severity); sql += ` AND severity = $${params.length}`; }
    params.push(parseInt(limit));
    sql += ` ORDER BY created_at DESC LIMIT $${params.length}`;
    const { query: dbQuery } = await import('./utils/db.js');
    const r = await dbQuery(sql, params);
    res.json({ triggers: r.rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Rhythm API (手动触发节奏) ───
app.post('/api/rhythm/morning', authRequired, requireRole('admin', 'hq_manager'), async (req, res) => {
  try {
    const result = await morningStandup();
    res.json({ ok: true, result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/rhythm/patrol', authRequired, requireRole('admin', 'hq_manager'), async (req, res) => {
  try {
    const result = await patrol(req.body?.wave || 'manual');
    res.json({ ok: true, result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/rhythm/end-of-day', authRequired, requireRole('admin', 'hq_manager'), async (req, res) => {
  try {
    const result = await endOfDay();
    res.json({ ok: true, result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/rhythm/weekly', authRequired, requireRole('admin', 'hq_manager'), async (req, res) => {
  try {
    const result = await weeklyReport();
    res.json({ ok: true, result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/rhythm/monthly', authRequired, requireRole('admin', 'hq_manager'), async (req, res) => {
  try {
    const result = await monthlyEvaluation();
    res.json({ ok: true, result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Random Inspection API ───
app.get('/api/inspection/status', authRequired, (req, res) => {
  res.json(getRandomInspectionStatus());
});

app.post('/api/inspection/trigger', authRequired, requireRole('admin', 'hq_manager'), async (req, res) => {
  try {
    await triggerManualInspection(req.body);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/inspection/restart', authRequired, requireRole('admin'), async (req, res) => {
  try {
    await startRandomInspections();
    res.json({ ok: true, status: getRandomInspectionStatus() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── KPI API ───
app.get('/api/kpi/snapshots', authRequired, async (req, res) => {
  try {
    const { store, days = 7 } = req.query;
    const { query: dbQuery } = await import('./utils/db.js');
    let sql = `SELECT * FROM kpi_snapshots WHERE snapshot_date >= CURRENT_DATE - ($1 || ' days')::interval`;
    const params = [parseInt(days)];
    if (store) { params.push(store); sql += ` AND store = $${params.length}`; }
    sql += ` ORDER BY snapshot_date DESC, store`;
    const r = await dbQuery(sql, params);
    res.json({ snapshots: r.rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/kpi/calculate', authRequired, requireRole('admin', 'hq_manager'), async (req, res) => {
  try {
    const results = await calculateAllStoresKPI(req.body?.date || 'yesterday');
    res.json({ ok: true, results });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// KPI达成率（实际 vs 目标）
app.get('/api/kpi/achievement', authRequired, async (req, res) => {
  try {
    const { store, date } = req.query;
    if (!store) return res.status(400).json({ error: 'store is required' });
    const { getBrandForStore } = await import('./services/config-service.js');
    const brand = await getBrandForStore(store);
    const result = await calculateKpiAchievement(store, brand, date);
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════
// KPI Target CRUD API — 前端设置 KPI 目标值
// ═══════════════════════════════════════════════════════

app.get('/api/kpi/targets', authRequired, async (req, res) => {
  try {
    const { store, brand, metric_key } = req.query;
    const targets = await getAllKpiTargets({ store, brand, metric_key });
    res.json({ targets });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/kpi/targets/:metricKey', authRequired, async (req, res) => {
  try {
    const { store, brand } = req.query;
    const target = await getKpiTarget(req.params.metricKey, store, brand);
    if (!target) return res.status(404).json({ error: 'No target found' });
    res.json(target);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/kpi/targets', authRequired, requireRole('admin', 'hq_manager'), async (req, res) => {
  try {
    const result = await upsertKpiTarget({ ...req.body, created_by: req.user?.username || 'unknown' });
    res.json({ ok: true, target: result });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/kpi/targets/:id', authRequired, requireRole('admin'), async (req, res) => {
  try {
    const deleted = await deleteKpiTarget(req.params.id);
    res.json({ ok: !!deleted, deleted });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════
// LLM Provider API — 健康检查 / 成本 / 性能
// ═══════════════════════════════════════════════════════

app.get('/api/llm/health', authRequired, async (req, res) => {
  try { res.json(await verifyLLMHealth()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/llm/status', authRequired, (req, res) => {
  res.json({ providers: getProviderHealthStatus(), metrics: getPerformanceMetrics() });
});

app.get('/api/llm/cost', authRequired, (req, res) => {
  const days = parseInt(req.query.days || '7');
  res.json({ cost: getCostStats(days) });
});

// ─── Feishu API ───
// GET：飞书/健康检查可快速探测可达性，避免“请求超时”
app.get('/api/webhook/feishu', (_req, res) => {
  res.status(200).json({ ok: true, service: 'agents-v2', message: 'use POST for events' });
});
app.post('/api/webhook/feishu', async (req, res) => {
  try { res.json(await handleWebhookEvent(req.body)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/webhook/feishu/card', async (req, res) => {
  try { res.json(await handleCardAction(req.body)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/feishu/status', authRequired, (req, res) => {
  res.json(getFeishuStatus());
});

app.post('/api/feishu/send', authRequired, requireRole('admin', 'hq_manager'), async (req, res) => {
  try {
    const { openId, text } = req.body;
    if (!openId || !text) return res.status(400).json({ error: 'missing params' });
    res.json(await feishuSendText(openId, text));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Message Router API ───

app.post('/api/router/test', authRequired, async (req, res) => {
  try {
    const { text, hasImage, username } = req.body;
    if (!text) return res.status(400).json({ error: 'text required' });
    const result = await routeMessage(text, !!hasImage, username || req.user?.username);
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/router/routes', authRequired, (req, res) => {
  res.json({ routes: VALID_ROUTES });
});

// ─── Task State Machine API ───

app.post('/api/tasks', authRequired, async (req, res) => {
  try { res.json(await createTask(req.body)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/tasks/stats', authRequired, async (req, res) => {
  try { res.json({ stats: await getTaskStats() }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/tasks/flow', authRequired, (req, res) => {
  res.json({ statusFlow: STATUS_FLOW });
});

app.get('/api/tasks/:taskId', authRequired, async (req, res) => {
  const t = await getTask(req.params.taskId);
  t ? res.json(t) : res.status(404).json({ error: 'not found' });
});

app.put('/api/tasks/:taskId/transition', authRequired, async (req, res) => {
  const { status, agent, payload } = req.body;
  if (!status) return res.status(400).json({ error: 'status required' });
  res.json(await transitionTask(req.params.taskId, status, agent || req.user?.username, payload || {}));
});

app.get('/api/tasks/store/:store', authRequired, async (req, res) => {
  res.json({ tasks: await getTasksByStore(req.params.store, req.query.status) });
});

app.post('/api/tasks/escalation-scan', authRequired, requireRole('admin', 'hq_manager'), async (req, res) => {
  res.json(await scanEscalations());
});

// ─── Agent Config API ───
app.use('/api', adminApi);

// ─── Agent Dispatch API ───
app.post('/api/agent/chat', authRequired, async (req, res) => {
  try {
    const { text, route, store, hasImage } = req.body;
    if (!text) return res.status(400).json({ error: 'text required' });
    const ctx = { store: store || req.user?.store, username: req.user?.username, role: req.user?.role };
    if (route) {
      res.json(await dispatchToAgent(route, text, ctx));
    } else {
      const rt = await routeMessage(text, !!hasImage, req.user?.username);
      res.json({ ...await dispatchToAgent(rt.route, text, ctx), routing: rt });
    }
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/agent/process', authRequired, async (req, res) => {
  try { res.json(await processMessage(req.body)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Knowledge Base API ───
app.get('/api/knowledge', authRequired, async (req, res) => {
  try { res.json({ items: await listKnowledge(req.query.category) }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/knowledge/search', authRequired, async (req, res) => {
  try { res.json({ results: await searchKnowledge(req.query.q || '') }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/knowledge', authRequired, requireRole('admin', 'hq_manager'), async (req, res) => {
  try {
    const { title, content, category, tags } = req.body;
    if (!title || !content) return res.status(400).json({ error: 'title+content required' });
    res.json(await addKnowledge(title, content, category, tags));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Scoring API ───
app.post('/api/scoring/calculate', authRequired, async (req, res) => {
  try {
    const { anomalies, role, brand, achievementRate } = req.body;
    const ded = calcDeductions(anomalies || [], role);
    const score = Math.max(0, 100 - ded.total);
    const rating = storeRating(achievementRate || 0);
    const bonus = calcBonus(score, brand, rating);
    res.json({ score, deductions: ded, storeRating: rating, bonus });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Data Executor API ───
app.get('/api/metrics', authRequired, async (req, res) => {
  try { res.json({ metrics: await getAllMetricDefs() }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/metrics/query', authRequired, async (req, res) => {
  try {
    const { metricIds, timeRange, store } = req.body;
    if (!metricIds?.length) return res.status(400).json({ error: 'metricIds required' });
    res.json(await executeMetrics(metricIds, timeRange, store));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Rhythm Logs API ───
app.get('/api/rhythm/logs', authRequired, async (req, res) => {
  try {
    const { days = 7, type } = req.query;
    const { query: dbQuery } = await import('./utils/db.js');
    let sql = `SELECT * FROM rhythm_logs WHERE execution_date >= CURRENT_DATE - ($1 || ' days')::interval`;
    const params = [parseInt(days)];
    if (type) { params.push(type); sql += ` AND rhythm_type = $${params.length}`; }
    sql += ` ORDER BY created_at DESC LIMIT 100`;
    const r = await dbQuery(sql, params);
    res.json({ logs: r.rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Helper ───
async function getActiveStores() {
  const { query: dbQuery } = await import('./utils/db.js');
  const r = await dbQuery(`SELECT DISTINCT store FROM daily_reports WHERE date >= CURRENT_DATE - 30 AND store IS NOT NULL`);
  return r.rows.map(r => r.store);
}

// ─── Stores + Brands API (for admin dropdowns) ───
app.get('/api/stores-brands', authRequired, async (req, res) => {
  try {
    const stores = await getActiveStores();
    const { getStoreMapping } = await import('./services/config-service.js');
    const mapping = await getStoreMapping().catch(() => null);
    const storeBrands = mapping?.store_brands || {};
    const brands = [...new Set(Object.values(storeBrands).filter(Boolean))].sort();
    res.json({ stores: stores.sort(), brands, storeBrands });
  } catch (e) {
    res.status(500).json({ error: e?.message });
  }
});

// ─── KPI daily cron (凌晨1:00 计算昨日KPI) ───
function startKpiScheduler() {
  cron.schedule('0 1 * * *', async () => {
    try {
      logger.info('📊 Running daily KPI calculation');
      await calculateAllStoresKPI('yesterday');
    } catch (e) {
      logger.error({ err: e }, 'Daily KPI calculation failed');
    }
  }, { timezone: 'Asia/Shanghai' });
  logger.info('✅ KPI Scheduler started (每日01:00计算)');
}

// ─── Startup ───
async function start() {
  const db = await checkDbHealth();
  if (!db) {
    logger.fatal('Database connection failed, exiting');
    process.exit(1);
  }
  logger.info('✅ Database connected');

  const redis = await checkRedisHealth();
  if (redis) {
    logger.info('✅ Redis connected');
  } else {
    logger.warn('⚠️ Redis not available, queues will not work');
  }

  // LLM health check on startup
  verifyLLMHealth().then(r => {
    if (r.allOk) logger.info('✅ All LLM providers healthy');
    else logger.warn({ results: r.results }, '⚠️ Some LLM providers unhealthy');
  }).catch(() => {});

  startRhythmScheduler();
  startKpiScheduler();
  startEscalationScheduler();
  startBitablePolling(120000);
  startRandomInspections().catch(e => logger.warn({ err: e?.message }, 'random-inspection start failed'));
  ensureKnowledgeTable().catch(() => {});

  app.listen(PORT, () => {
    logger.info({ port: PORT }, `🚀 agents-service-v2 running on port ${PORT}`);
  });
}

// Graceful shutdown
process.on('SIGTERM', () => {
  logger.info('SIGTERM received, shutting down...');
  stopBitablePolling();
  process.exit(0);
});
process.on('SIGINT', () => {
  logger.info('SIGINT received, shutting down...');
  stopBitablePolling();
  process.exit(0);
});

start().catch(err => {
  logger.fatal({ err }, 'Failed to start');
  process.exit(1);
});
