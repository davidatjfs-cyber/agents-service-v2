/**
 * Config Service — 统一配置管理
 * 
 * 核心原则：前端配置 → DB存储 → 后端读取执行
 * 所有配置从 agent_v2_configs 表读取，带内存缓存（TTL 60s）
 * 彻底消除 hardcoded 配置
 */
import { query } from '../utils/db.js';
import { logger } from '../utils/logger.js';

// ─── 内存缓存 ───
const cache = new Map();
const CACHE_TTL_MS = 60_000; // 60秒

function getCached(key) {
  const entry = cache.get(key);
  if (entry && Date.now() - entry.ts < CACHE_TTL_MS) return entry.value;
  cache.delete(key);
  return null;
}

function setCache(key, value) {
  cache.set(key, { value, ts: Date.now() });
}

/**
 * 强制刷新缓存（配置变更后调用）
 */
export function invalidateCache(key) {
  if (key) cache.delete(key);
  else cache.clear();
  logger.info({ key: key || 'ALL' }, 'Config cache invalidated');
}

// ─── 通用读取 ───

/**
 * 获取指定config_key的配置
 */
export async function getConfig(configKey) {
  const cached = getCached(configKey);
  if (cached) return cached;

  const r = await query(
    `SELECT config_value, version, updated_at FROM agent_v2_configs WHERE config_key = $1`,
    [configKey]
  );
  if (r.rows.length === 0) return null;

  const value = r.rows[0].config_value;
  setCache(configKey, value);
  return value;
}

/**
 * 获取所有配置
 */
export async function getAllConfigs() {
  const r = await query(
    `SELECT config_key, config_value, description, version, updated_by, updated_at FROM agent_v2_configs ORDER BY config_key`
  );
  return r.rows;
}

// ─── 写入 ───

/**
 * 创建或更新配置（含审计日志）
 */
export async function upsertConfig(configKey, configValue, description, updatedBy) {
  // 读取旧值用于审计
  const old = await query(`SELECT config_value FROM agent_v2_configs WHERE config_key = $1`, [configKey]);
  const oldValue = old.rows[0]?.config_value || null;
  const action = oldValue ? 'update' : 'create';

  await query(`
    INSERT INTO agent_v2_configs (config_key, config_value, description, updated_by, version, updated_at)
    VALUES ($1, $2, $3, $4, 1, now())
    ON CONFLICT (config_key) DO UPDATE SET
      config_value = EXCLUDED.config_value,
      description = COALESCE(EXCLUDED.description, agent_v2_configs.description),
      updated_by = EXCLUDED.updated_by,
      version = agent_v2_configs.version + 1,
      updated_at = now()
  `, [configKey, JSON.stringify(configValue), description, updatedBy]);

  // 审计日志
  await query(`
    INSERT INTO config_audit_log (config_key, action, old_value, new_value, changed_by)
    VALUES ($1, $2, $3, $4, $5)
  `, [configKey, action, oldValue ? JSON.stringify(oldValue) : null, JSON.stringify(configValue), updatedBy]);

  invalidateCache(configKey);
  logger.info({ configKey, action, updatedBy }, 'Config updated');
  return { configKey, action, version: (old.rows[0]?.version || 0) + 1 };
}

/**
 * 删除配置
 */
export async function deleteConfig(configKey, deletedBy) {
  const old = await query(`SELECT config_value FROM agent_v2_configs WHERE config_key = $1`, [configKey]);
  if (old.rows.length === 0) return { deleted: false };

  await query(`DELETE FROM agent_v2_configs WHERE config_key = $1`, [configKey]);
  await query(`
    INSERT INTO config_audit_log (config_key, action, old_value, new_value, changed_by)
    VALUES ($1, 'delete', $2, NULL, $3)
  `, [configKey, JSON.stringify(old.rows[0].config_value), deletedBy]);

  invalidateCache(configKey);
  return { deleted: true };
}

// ─── 便捷方法：特定配置 ───

export async function getAnomalyRules() {
  return await getConfig('anomaly_rules');
}

export async function getSlaConfig() {
  return await getConfig('sla_config');
}

export async function getEscalationConfig() {
  return await getConfig('escalation_config');
}

export async function getPushConfig() {
  return await getConfig('push_config');
}

export async function getRhythmSchedule() {
  return await getConfig('rhythm_schedule');
}

export async function getAutoDecision() {
  return await getConfig('auto_decision');
}

export async function getStoreMapping() {
  return await getConfig('store_mapping');
}

// ─── 门店名映射（从DB配置读取） ───

export async function toFeishuStoreName(storeName) {
  const mapping = await getStoreMapping();
  if (!mapping) return storeName;
  return mapping.daily_reports_to_feishu?.[storeName] || storeName;
}

export async function getBrandForStore(storeName) {
  const mapping = await getStoreMapping();
  if (!mapping) {
    if (/洪潮/.test(storeName)) return '洪潮';
    if (/马己仙/.test(storeName)) return '马己仙';
    return null;
  }
  return mapping.store_brands?.[storeName] || null;
}

// ─── KPI Targets ───

/**
 * 获取指定指标的目标值（门店级 > 品牌级 > 公司级）
 */
export async function getKpiTarget(metricKey, store, brand) {
  // 优先级：门店 > 品牌 > 公司默认
  const r = await query(`
    SELECT target_value, warning_value, unit, direction, period
    FROM kpi_targets
    WHERE metric_key = $1
      AND (effective_to IS NULL OR effective_to >= CURRENT_DATE)
      AND effective_from <= CURRENT_DATE
      AND (
        (store = $2) OR
        (store IS NULL AND brand = $3) OR
        (store IS NULL AND brand IS NULL)
      )
    ORDER BY
      CASE WHEN store IS NOT NULL THEN 1
           WHEN brand IS NOT NULL THEN 2
           ELSE 3 END,
      effective_from DESC
    LIMIT 1
  `, [metricKey, store, brand]);

  return r.rows[0] || null;
}

/**
 * 获取所有KPI目标
 */
export async function getAllKpiTargets(filters = {}) {
  let sql = `SELECT * FROM kpi_targets WHERE (effective_to IS NULL OR effective_to >= CURRENT_DATE)`;
  const params = [];

  if (filters.store) { params.push(filters.store); sql += ` AND store = $${params.length}`; }
  if (filters.brand) { params.push(filters.brand); sql += ` AND brand = $${params.length}`; }
  if (filters.metric_key) { params.push(filters.metric_key); sql += ` AND metric_key = $${params.length}`; }

  sql += ` ORDER BY COALESCE(store, brand, '___'), metric_key`;
  const r = await query(sql, params);
  return r.rows;
}

/**
 * 创建/更新KPI目标
 */
export async function upsertKpiTarget({ store, brand, metric_key, target_value, warning_value, unit, direction, period, effective_from, effective_to, created_by }) {
  const r = await query(`
    INSERT INTO kpi_targets (store, brand, metric_key, target_value, warning_value, unit, direction, period, effective_from, effective_to, created_by)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
    ON CONFLICT (COALESCE(store,'__all__'), COALESCE(brand,'__all__'), metric_key, effective_from)
    DO UPDATE SET
      target_value = EXCLUDED.target_value,
      warning_value = EXCLUDED.warning_value,
      unit = COALESCE(EXCLUDED.unit, kpi_targets.unit),
      direction = COALESCE(EXCLUDED.direction, kpi_targets.direction),
      period = COALESCE(EXCLUDED.period, kpi_targets.period),
      effective_to = EXCLUDED.effective_to,
      updated_at = now()
    RETURNING *
  `, [store || null, brand || null, metric_key, target_value, warning_value || null, unit, direction || 'lower_better', period || 'monthly', effective_from || new Date().toISOString().slice(0, 10), effective_to || null, created_by]);
  return r.rows[0];
}

/**
 * 删除KPI目标
 */
export async function deleteKpiTarget(id) {
  const r = await query(`DELETE FROM kpi_targets WHERE id = $1 RETURNING *`, [id]);
  return r.rows[0] || null;
}

/**
 * KPI达成率计算：实际值 vs 目标值
 */
export async function calculateKpiAchievement(store, brand, snapshotDate) {
  // 获取最近的KPI快照
  const snapshot = await query(`
    SELECT * FROM kpi_snapshots
    WHERE store = $1 AND snapshot_date <= $2
    ORDER BY snapshot_date DESC LIMIT 1
  `, [store, snapshotDate || new Date().toISOString().slice(0, 10)]);

  if (snapshot.rows.length === 0) return { store, achievements: [], message: '无KPI快照数据' };

  const snap = snapshot.rows[0];

  // 对每个KPI指标计算达成率
  const metrics = [
    { key: 'ttfr_p90', actual: parseFloat(snap.ttfr_p90_minutes), label: '首次响应P90' },
    { key: 'ttc_p90', actual: parseFloat(snap.ttc_p90_hours), label: '闭环时长P90' },
    { key: 'timeout_rate', actual: parseFloat(snap.timeout_rate), label: '超时率' },
    { key: 'false_positive_rate', actual: parseFloat(snap.false_positive_rate), label: '误报率' },
    { key: 'evidence_coverage', actual: parseFloat(snap.evidence_coverage_rate), label: '证据链完整率' },
    { key: 'first_pass_rate', actual: parseFloat(snap.first_pass_rate), label: '一次通过率' },
    { key: 'escalation_rate', actual: parseFloat(snap.escalation_rate), label: '升级率' },
  ];

  const achievements = [];
  for (const m of metrics) {
    const target = await getKpiTarget(m.key, store, brand);
    if (!target) {
      achievements.push({ ...m, target: null, status: 'no_target' });
      continue;
    }

    const t = parseFloat(target.target_value);
    const w = target.warning_value ? parseFloat(target.warning_value) : null;
    const dir = target.direction;

    let status = 'on_track';
    if (dir === 'lower_better') {
      if (m.actual > t) status = 'off_track';
      else if (w && m.actual > w) status = 'warning';
    } else {
      if (m.actual < t) status = 'off_track';
      else if (w && m.actual < w) status = 'warning';
    }

    const achievementPct = dir === 'lower_better'
      ? (t > 0 ? Math.max(0, (1 - (m.actual - t) / t) * 100) : 100)
      : (t > 0 ? (m.actual / t * 100) : 0);

    achievements.push({
      ...m,
      target: t,
      warning: w,
      direction: dir,
      unit: target.unit,
      status,
      achievement_pct: parseFloat(achievementPct.toFixed(1))
    });
  }

  return { store, snapshot_date: snap.snapshot_date, achievements };
}

// ─── 配置审计日志查询 ───
export async function getConfigAuditLog(configKey, limit = 50) {
  let sql = `SELECT * FROM config_audit_log`;
  const params = [];
  if (configKey) { params.push(configKey); sql += ` WHERE config_key = $1`; }
  params.push(parseInt(limit));
  sql += ` ORDER BY changed_at DESC LIMIT $${params.length}`;
  const r = await query(sql, params);
  return r.rows;
}
