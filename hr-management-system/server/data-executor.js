/**
 * Data Executor — 数据执行层
 * BUILD_VERSION: 2026-03-02-v2
 *
 * 职责（严格边界）：
 *   1. 根据 metric_id 从指标字典查定义
 *   2. 自动展开依赖链，按顺序查询
 *   3. 查缓存 → 命中直接返回 → 未命中查库 → 写缓存
 *   4. 返回结构化 JSON，禁止分析/解释
 *
 * v2 新增：
 *   - extractTimeRangeFromText()  ：从自然语言问题提取时间范围
 *   - runBusinessDiagnosis()      ：Business Diagnosis Agent（LLM约束分析层）
 *   - 结构化日志埋点（task_id全链路）
 *
 * 禁止：
 *   - 推断、猜测任何数值
 *   - Diagnosis 层引用未查询的指标
 *   - 修改口径（一切以 metric_dictionary 为准）
 */

import { randomUUID } from 'crypto';

let _pool = null;
export function setDataExecutorPool(p) { _pool = p; }
function pool() {
  if (!_pool) throw new Error('data-executor: pool not set');
  return _pool;
}

// ── 1. 指标字典读取 ──────────────────────────────────────────

const _dictCache = new Map(); // 内存缓存，避免每次查库
const _dictCacheTtl = 5 * 60 * 1000; // 5分钟

export async function getMetricDef(metricId) {
  const cached = _dictCache.get(metricId);
  if (cached && Date.now() - cached.ts < _dictCacheTtl) return cached.def;
  try {
    const r = await pool().query(
      `SELECT * FROM metric_dictionary WHERE metric_id = $1 AND enabled = TRUE LIMIT 1`,
      [metricId]
    );
    const def = r.rows?.[0] || null;
    if (def) _dictCache.set(metricId, { def, ts: Date.now() });
    return def;
  } catch (e) {
    console.error('[data-executor] getMetricDef error:', e?.message);
    return null;
  }
}

export async function getAllMetricDefs() {
  try {
    const r = await pool().query(
      `SELECT * FROM metric_dictionary WHERE enabled = TRUE ORDER BY metric_id`
    );
    return r.rows || [];
  } catch (e) {
    return [];
  }
}

// ── 2. 查询结果缓存 ──────────────────────────────────────────

async function getCachedResult(taskId, metricId, timeRange, store) {
  try {
    const r = await pool().query(
      `SELECT result, metric_version FROM agent_metric_cache
       WHERE task_id = $1 AND metric_id = $2 AND time_range = $3
         AND COALESCE(store,'') = COALESCE($4,'')
         AND expires_at > NOW()
       LIMIT 1`,
      [taskId, metricId, timeRange, store || '']
    );
    if (r.rows?.[0]) {
      // 更新命中次数
      await pool().query(
        `UPDATE agent_metric_cache SET hit_count = hit_count + 1
         WHERE task_id = $1 AND metric_id = $2 AND time_range = $3 AND COALESCE(store,'') = COALESCE($4,'')`,
        [taskId, metricId, timeRange, store || '']
      ).catch(() => {});
      return r.rows[0].result;
    }
    return null;
  } catch (e) {
    return null;
  }
}

async function setCachedResult(taskId, metricId, timeRange, store, result, metricVersion, ttlMinutes) {
  const ttl = (ttlMinutes && ttlMinutes > 0) ? `${ttlMinutes} minutes` : '120 minutes';
  try {
    await pool().query(
      `INSERT INTO agent_metric_cache
         (task_id, metric_id, time_range, store, result, metric_version, created_at, expires_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, NOW(), NOW() + $7::interval)
       ON CONFLICT (task_id, metric_id, time_range, store)
       DO UPDATE SET result = EXCLUDED.result, metric_version = EXCLUDED.metric_version,
                     expires_at = NOW() + $7::interval`,
      [taskId, metricId, timeRange, store || '', JSON.stringify(result), metricVersion || 1, ttl]
    );
  } catch (e) {
    console.error('[data-executor] setCachedResult error:', e?.message);
  }
}

// ── 2b. 指标版本变更：写 change_log + 清理旧缓存 ──────────────

export async function updateMetricVersion(metricId, changes, changedBy) {
  try {
    const cur = await getMetricDef(metricId);
    if (!cur) return { ok: false, error: 'metric_not_found' };
    const newVersion = (cur.version || 1) + 1;
    const entry = {
      version: newVersion,
      changed_by: changedBy || 'system',
      changed_at: new Date().toISOString(),
      changes: changes || {}
    };
    // 追加 change_log（保留最近20条）
    const existingLog = Array.isArray(cur.metadata?.change_log) ? cur.metadata.change_log : [];
    const newLog = [...existingLog, entry].slice(-20);
    await pool().query(
      `UPDATE metric_dictionary
         SET version = $1,
             metadata = jsonb_set(COALESCE(metadata,'{}'), '{change_log}', $2::jsonb),
             updated_at = NOW()
       WHERE metric_id = $3`,
      [newVersion, JSON.stringify(newLog), metricId]
    );
    // 清理该指标所有缓存（版本变更，旧缓存全部失效）
    const deleted = await pool().query(
      `DELETE FROM agent_metric_cache WHERE metric_id = $1`,
      [metricId]
    );
    // 清除内存字典缓存
    _dictCache.delete(metricId);
    logExecutorEvent('metric_version_bumped', {
      metric_id: metricId,
      old_version: cur.version || 1,
      new_version: newVersion,
      cache_cleared: deleted.rowCount || 0,
      changed_by: changedBy || 'system'
    });
    return { ok: true, metric_id: metricId, new_version: newVersion, cache_cleared: deleted.rowCount || 0 };
  } catch (e) {
    console.error('[data-executor] updateMetricVersion error:', e?.message);
    return { ok: false, error: e?.message };
  }
}

// ── 3. 时间范围解析 ──────────────────────────────────────────

export function parseTimeRange(timeRange) {
  if (!timeRange) {
    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, '0');
    const d = String(now.getDate()).padStart(2, '0');
    const today = `${y}-${m}-${d}`;
    return { start: today, end: today, label: '今天' };
  }
  // 支持 "2026-02" 月格式
  if (/^\d{4}-\d{2}$/.test(timeRange)) {
    const [y, m] = timeRange.split('-');
    const start = `${y}-${m}-01`;
    const lastDay = new Date(Number(y), Number(m), 0).getDate();
    const end = `${y}-${m}-${String(lastDay).padStart(2, '0')}`;
    return { start, end, label: `${y}年${m}月` };
  }
  // 支持 "2026-02-01~2026-02-28" 范围格式
  if (/^\d{4}-\d{2}-\d{2}~\d{4}-\d{2}-\d{2}$/.test(timeRange)) {
    const [start, end] = timeRange.split('~');
    return { start, end, label: `${start} 至 ${end}` };
  }
  // 支持单日 "2026-02-14"
  if (/^\d{4}-\d{2}-\d{2}$/.test(timeRange)) {
    return { start: timeRange, end: timeRange, label: timeRange };
  }
  return { start: timeRange, end: timeRange, label: timeRange };
}

// ── 4. 门店名标准化（模糊匹配） ──────────────────────────────

function normalizeStore(s) {
  return String(s || '').trim().toLowerCase().replace(/\s+/g, '');
}

function buildStoreFilter(store) {
  if (!store) return { sql: '', params: [] };
  const n = normalizeStore(store);
  return {
    sql: `AND lower(regexp_replace(coalesce(record_data->>'门店', record_data->>'所属门店', ''), '\\s+', '', 'g')) LIKE $STORE_PLACEHOLDER`,
    placeholder: `%${n}%`
  };
}

// ── 5. 核心：单指标查询 ──────────────────────────────────────

async function executeOneMetric(metricId, timeRange, store, depResults) {
  const def = await getMetricDef(metricId);
  if (!def) {
    return {
      metric_id: metricId,
      value: null,
      error: `指标 ${metricId} 不存在于字典`,
      time_range: timeRange,
      source: null,
      version: null
    };
  }

  const { start, end, label } = parseTimeRange(timeRange);

  try {
    let value = null;

    // 计算型指标（依赖其他指标）
    if (def.data_source === 'computed') {
      value = computeMetricValue(def, depResults);
    }
    // feishu_generic_records 型指标
    else if (def.data_source === 'feishu_generic_records') {
      value = await queryFeishuGenericRecords(def, start, end, store);
    }
    // sales_raw 型指标
    else if (def.data_source === 'sales_raw') {
      value = await querySalesRaw(def, start, end, store);
    }
    // daily_reports 型指标
    else if (def.data_source === 'daily_reports') {
      value = await queryDailyReports(def, start, end, store);
    }
    // schedules 型指标
    else if (def.data_source === 'schedules') {
      value = await querySchedules(def, start, end, store);
    }
    else {
      value = null;
    }

    return {
      metric_id: metricId,
      name: def.name,
      value,
      time_range: timeRange,
      time_range_label: label,
      source: def.data_source,
      version: def.version,
      include_discount: def.include_discount,
      unit: def.metadata?.unit || null,
      notes: def.include_discount === false ? '已扣优惠' : '含优惠前金额'
    };
  } catch (e) {
    console.error(`[data-executor] executeOneMetric error for ${metricId}:`, e?.message);
    return {
      metric_id: metricId,
      name: def?.name || metricId,
      value: null,
      error: e?.message,
      time_range: timeRange,
      source: def?.data_source,
      version: def?.version
    };
  }
}

// ── 6. 子查询：feishu_generic_records ───────────────────────
// 注意：表中数据字段为 fields（JSONB），不是 record_data
// 日期字段"日期"存的是毫秒时间戳，需要用 to_timestamp(val::bigint/1000)::date 转换
// 收货日期字段存的是字符串 'YYYY-MM-DD'

// 统一的日期过滤条件片段（兼容毫秒时间戳和字符串两种格式）
function buildFeishuDateFilter(alias, startParamIdx = 2) {
  const f = alias ? `${alias}.fields` : 'fields';
  const p1 = `$${startParamIdx}`;
  const p2 = `$${startParamIdx + 1}`;
  return `(
    to_timestamp((${f}->>'日期')::bigint/1000)::date BETWEEN ${p1}::date AND ${p2}::date
    OR (${f}->>'收货日期')::date BETWEEN ${p1}::date AND ${p2}::date
    OR (${f}->>'创建日期')::date BETWEEN ${p1}::date AND ${p2}::date
    OR to_timestamp((${f}->>'提交时间')::bigint/1000)::date BETWEEN ${p1}::date AND ${p2}::date
  )`;
}

// 统一的门店过滤条件片段
function buildFeishuStoreFilter(paramIdx, alias) {
  const f = alias ? `${alias}.fields` : 'fields';
  return `lower(regexp_replace(coalesce(${f}->>'所属门店', ${f}->>'门店', ''), '\\s+', '', 'g')) LIKE $${paramIdx}`;
}

async function queryFeishuGenericRecords(def, start, end, store) {
  const formula = def.formula || '';

  // 提取 table_id（支持单个或 IN 列表）
  const tableIdMatch = formula.match(/table_id\s*(?:=\s*'([^']+)'|IN\s*\(([^)]+)\))/);
  if (!tableIdMatch) return null;
  let tableIds;
  if (tableIdMatch[1]) {
    tableIds = [tableIdMatch[1]];
  } else {
    tableIds = tableIdMatch[2].split(',').map(s => s.trim().replace(/'/g, ''));
  }
  const tableIdPlaceholders = tableIds.map((_, i) => `$${i + 1}`).join(', ');

  const dateStartParamIdx = tableIds.length + 1; // dates start after table IDs
  const storeParamIdx = tableIds.length + 3; // $1...$N = tableIds, $N+1=start, $N+2=end, $N+3=store

  // COUNT(*)
  if (/^COUNT\(\*\)/.test(formula.trim())) {
    const params = [...tableIds, start, end];
    let sql = `SELECT COUNT(*)::int AS val FROM feishu_generic_records
               WHERE table_id IN (${tableIdPlaceholders})
                 AND ${buildFeishuDateFilter(null, dateStartParamIdx)}`;

    if (store) {
      const n = normalizeStore(store);
      sql += ` AND ${buildFeishuStoreFilter(storeParamIdx)}`;
      params.push(`%${n}%`);
    }

    if (formula.includes('异常原料名称')) {
      sql += ` AND fields->>'异常原料名称' IS NOT NULL AND fields->>'异常原料名称' != ''`;
    }

    const r = await pool().query(sql, params);
    return Number(r.rows?.[0]?.val || 0);
  }

  // AVG(...)
  if (/^AVG\(/.test(formula.trim())) {
    const fieldMatch = formula.match(/record_data->>'([^']+)'/) || formula.match(/fields->>'([^']+)'/);
    if (!fieldMatch) return null;
    const field = fieldMatch[1];
    const params = [...tableIds, start, end];
    let sql = `SELECT AVG(NULLIF(fields->>'${field}', '')::numeric)::numeric(8,2) AS val
               FROM feishu_generic_records
               WHERE table_id IN (${tableIdPlaceholders})
                 AND ${buildFeishuDateFilter(null, dateStartParamIdx)}
                 AND (fields->>'${field}') ~ '^[0-9.]+$'`;
    if (store) {
      const n = normalizeStore(store);
      sql += ` AND ${buildFeishuStoreFilter(storeParamIdx)}`;
      params.push(`%${n}%`);
    }
    const r = await pool().query(sql, params);
    return r.rows?.[0]?.val !== null ? Number(r.rows[0].val) : null;
  }

  // COUNT(CASE WHEN ...) / NULLIF — 合格率
  if (/COUNT\(CASE WHEN/.test(formula)) {
    const condMatch = formula.match(/(?:record_data|fields)->>'([^']+)'='([^']+)'/);
    if (!condMatch) return null;
    const [, field, val] = condMatch;
    const params = [...tableIds, start, end];
    let sql = `SELECT ROUND(
      COUNT(CASE WHEN fields->>'${field}' = '${val}' THEN 1 END)::numeric
      / NULLIF(COUNT(*), 0) * 100, 1
    ) AS val
    FROM feishu_generic_records
    WHERE table_id IN (${tableIdPlaceholders})
      AND ${buildFeishuDateFilter(null, dateStartParamIdx)}`;
    if (store) {
      const n = normalizeStore(store);
      sql += ` AND ${buildFeishuStoreFilter(storeParamIdx)}`;
      params.push(`%${n}%`);
    }
    const r = await pool().query(sql, params);
    return r.rows?.[0]?.val !== null ? Number(r.rows[0].val) : null;
  }

  // SUM(COALESCE(...)) — 客流（就餐人数字段含"3人"等文字，需提取数字）
  if (/^SUM\(COALESCE\(/.test(formula.trim())) {
    const params = [...tableIds, start, end];
    let sql = `SELECT SUM(
      COALESCE(
        NULLIF(regexp_replace(fields->>'就餐人数', '[^0-9]', '', 'g'), '')::int,
        NULLIF(regexp_replace(fields->>'人数', '[^0-9]', '', 'g'), '')::int,
        0
      )
    )::int AS val
    FROM feishu_generic_records
    WHERE table_id IN (${tableIdPlaceholders})
      AND ${buildFeishuDateFilter(null, dateStartParamIdx)}`;
    if (store) {
      const n = normalizeStore(store);
      sql += ` AND ${buildFeishuStoreFilter(storeParamIdx)}`;
      params.push(`%${n}%`);
    }
    const r = await pool().query(sql, params);
    return Number(r.rows?.[0]?.val || 0);
  }

  return null;
}

// ── 7. 子查询：sales_raw ──────────────────────────────────────

// 列名兼容映射：处理 formula 中可能存在的旧名/错误名
const SALES_RAW_COLUMN_ALIASES = {
  actual_revenue: 'revenue',
  expected_revenue: 'sales_amount',
  gross_revenue: 'sales_amount'
};

function fixSalesRawColumnName(col) {
  return SALES_RAW_COLUMN_ALIASES[col] || col;
}

async function querySalesRaw(def, start, end, store) {
  const formula = def.formula || '';

  // 支持 SUM(x - y) 差值公式，如 SUM(sales_amount - revenue)
  const diffMatch = formula.match(/SUM\((\w+)\s*-\s*(\w+)\)/);
  if (diffMatch) {
    const colA = fixSalesRawColumnName(diffMatch[1]);
    const colB = fixSalesRawColumnName(diffMatch[2]);
    const params = [start, end];
    let sql = `SELECT COALESCE(SUM(${colA} - ${colB}), 0)::numeric(12,2) AS val FROM sales_raw WHERE date BETWEEN $1 AND $2`;
    if (store) {
      const n = normalizeStore(store);
      sql += ` AND lower(regexp_replace(coalesce(store,''), '\\s+', '', 'g')) LIKE $3`;
      params.push(`%${n}%`);
    }
    const r = await pool().query(sql, params);
    return Number(r.rows?.[0]?.val || 0);
  }

  // 支持 SUM(x) 单列公式
  const fieldMatch = formula.match(/SUM\((\w+)\)/);
  if (!fieldMatch) return null;
  const field = fixSalesRawColumnName(fieldMatch[1]);

  const params = [start, end];
  let sql = `SELECT COALESCE(SUM(${field}), 0)::numeric(12,2) AS val FROM sales_raw WHERE date BETWEEN $1 AND $2`;
  if (store) {
    const n = normalizeStore(store);
    sql += ` AND lower(regexp_replace(coalesce(store,''), '\\s+', '', 'g')) LIKE $3`;
    params.push(`%${n}%`);
  }
  const r = await pool().query(sql, params);
  return Number(r.rows?.[0]?.val || 0);
}

// ── 7b. 子查询：daily_reports ─────────────────────────────────

async function queryDailyReports(def, start, end, store) {
  const formula = def.formula || '';

  // 支持 SUM(col), AVG(col), MAX(col), AVG(expr)
  const aggMatch = formula.match(/^(SUM|AVG|MAX)\((.+)\)$/i);
  if (!aggMatch) return null;
  const [, agg, expr] = aggMatch;

  const params = [start, end];
  let sql = `SELECT ${agg.toUpperCase()}(${expr})::numeric(12,2) AS val FROM daily_reports WHERE date BETWEEN $1::date AND $2::date`;
  if (store) {
    const n = normalizeStore(store);
    sql += ` AND lower(regexp_replace(coalesce(store,''), '\\s+', '', 'g')) LIKE $3`;
    params.push(`%${n}%`);
  }
  const r = await pool().query(sql, params);
  const v = r.rows?.[0]?.val;
  return v !== null && v !== undefined ? Number(v) : null;
}

// ── 8. 子查询：schedules ──────────────────────────────────────

async function querySchedules(def, start, end, store) {
  const params = [start, end];
  let sql = `SELECT COUNT(DISTINCT employee_username)::int AS val FROM schedules WHERE shift_date BETWEEN $1 AND $2 AND status = 'present'`;
  if (store) {
    const n = normalizeStore(store);
    sql += ` AND lower(regexp_replace(coalesce(store,''), '\\s+', '', 'g')) LIKE $3`;
    params.push(`%${n}%`);
  }
  const r = await pool().query(sql, params);
  return Number(r.rows?.[0]?.val || 0);
}

// ── 9. 计算型指标 ─────────────────────────────────────────────

function computeMetricValue(def, depResults) {
  const deps = def.dependencies || [];
  if (deps.length < 2) return null;

  const formula = def.formula || '';
  // 形如 "A / B"
  if (formula.includes('/')) {
    const parts = formula.split('/').map(s => s.trim().split(' ')[0]);
    const [a, b] = parts;
    const aResult = depResults[a];
    const bResult = depResults[b];
    const aVal = aResult?.value;
    const bVal = bResult?.value;
    if (aVal === null || aVal === undefined || !bVal) return null;
    return Math.round((Number(aVal) / Number(bVal)) * 100) / 100;
  }
  // 形如 "A - B"
  if (formula.includes('-')) {
    const parts = formula.split('-').map(s => s.trim().split(' ')[0]);
    const [a, b] = parts;
    const aVal = depResults[a]?.value;
    const bVal = depResults[b]?.value;
    if (aVal === null || aVal === undefined) return null;
    return Number(aVal) - Number(bVal || 0);
  }
  return null;
}

// ── 10. 公开接口：批量执行指标 ───────────────────────────────

/**
 * 核心执行入口
 * @param {string[]} metricIds  - 需要查询的指标 ID 列表
 * @param {string}   timeRange  - 时间范围（"2026-02" / "2026-02-01~2026-02-28" / "2026-02-14"）
 * @param {string}   store      - 门店名（可空）
 * @param {string}   taskId     - 本次 session 的任务 ID（用于缓存）
 * @returns {{ results: object[], metrics_returned: string[], metric_versions: object }}
 */
export async function executeMetrics(metricIds, timeRange, store, taskId) {
  const ids = Array.isArray(metricIds) ? metricIds : [metricIds];
  const tId = taskId || randomUUID();
  const t0 = Date.now();
  const results = [];
  const depResultsMap = {};
  const cacheHits = [];
  const cacheMisses = [];

  logExecutorEvent('executor_start', { task_id: tId, metric_ids: ids, time_range: timeRange, store: store || null });

  for (const metricId of ids) {
    // 1. 查缓存
    const cached = await getCachedResult(tId, metricId, timeRange || '', store);
    if (cached) {
      results.push(cached);
      depResultsMap[metricId] = cached;
      cacheHits.push(metricId);
      logExecutorEvent('metric_cache_hit', { task_id: tId, metric_id: metricId, time_range: timeRange });
      continue;
    }
    cacheMisses.push(metricId);

    // 2. 展开依赖
    const def = await getMetricDef(metricId);
    const deps = def?.dependencies || [];
    for (const depId of deps) {
      if (!depResultsMap[depId]) {
        const depCached = await getCachedResult(tId, depId, timeRange || '', store);
        if (depCached) {
          depResultsMap[depId] = depCached;
          logExecutorEvent('metric_cache_hit', { task_id: tId, metric_id: depId, time_range: timeRange, is_dep: true });
        } else {
          const depResult = await executeOneMetric(depId, timeRange, store, depResultsMap);
          depResultsMap[depId] = depResult;
          const depDef = await getMetricDef(depId);
          await setCachedResult(tId, depId, timeRange || '', store, depResult, depDef?.version, depDef?.cache_ttl_minutes);
          logExecutorEvent('metric_queried', { task_id: tId, metric_id: depId, value: depResult.value, error: depResult.error || null, is_dep: true });
        }
      }
    }

    // 3. 执行本指标
    const result = await executeOneMetric(metricId, timeRange, store, depResultsMap);
    depResultsMap[metricId] = result;
    results.push(result);
    await setCachedResult(tId, metricId, timeRange || '', store, result, def?.version, def?.cache_ttl_minutes);
    logExecutorEvent('metric_queried', { task_id: tId, metric_id: metricId, value: result.value, error: result.error || null });
  }

  const metricVersions = {};
  for (const r of results) {
    if (r.metric_id && r.version != null) {
      metricVersions[r.metric_id] = r.version;
    }
  }

  const metricsReturned = results.filter(r => r.value !== null && r.value !== undefined).map(r => r.metric_id);
  const duration = Date.now() - t0;

  logExecutorEvent('executor_complete', {
    task_id: tId,
    metrics_returned: metricsReturned,
    cache_hits: cacheHits,
    cache_misses: cacheMisses,
    duration_ms: duration
  });

  return {
    task_id: tId,
    store: store || null,
    time_range: timeRange || null,
    results,
    metrics_returned: metricsReturned,
    metric_versions: metricVersions
  };
}

// ── 11. 分析规则匹配 ──────────────────────────────────────────

const _rulesCache = { rules: null, ts: 0 };

export async function matchAnalysisRule(text) {
  // 缓存规则 5 分钟
  if (!_rulesCache.rules || Date.now() - _rulesCache.ts > 5 * 60 * 1000) {
    try {
      const r = await pool().query(
        `SELECT * FROM analysis_rules WHERE enabled = TRUE ORDER BY priority DESC, id ASC`
      );
      _rulesCache.rules = r.rows || [];
      _rulesCache.ts = Date.now();
    } catch (e) {
      _rulesCache.rules = [];
    }
  }

  const t = String(text || '').toLowerCase();
  const matched = [];
  for (const rule of _rulesCache.rules) {
    const keywords = Array.isArray(rule.trigger_keywords) ? rule.trigger_keywords : [];
    if (keywords.some(kw => t.includes(String(kw).toLowerCase()))) {
      matched.push(rule);
    }
  }
  if (matched.length === 0) return null;
  // 已按 priority DESC 排序，取最高优先级；若同优先级有多条记录冲突
  if (matched.length > 1) {
    logExecutorEvent('rule_conflict', {
      matched_rules: matched.map(r => r.intent),
      selected: matched[0].intent,
      text_snippet: text.slice(0, 60)
    });
  }
  return matched[0];
}

// ── 12. Session State 管理 ────────────────────────────────────

export async function getSessionState(username) {
  try {
    const r = await pool().query(
      `SELECT memory_value FROM agent_long_memory WHERE user_key = $1 AND memory_key = 'session_state' LIMIT 1`,
      [String(username || '').toLowerCase()]
    );
    const val = r.rows?.[0]?.memory_value;
    return val && typeof val === 'object' ? val : null;
  } catch (e) {
    return null;
  }
}

export async function setSessionState(username, state) {
  const u = String(username || '').toLowerCase();
  if (!u) return;
  const payload = {
    task_id: state.task_id || randomUUID(),
    route: state.route || null,
    intent: state.intent || null,
    metrics_requested: Array.isArray(state.metrics_requested) ? state.metrics_requested : [],
    metrics_returned: Array.isArray(state.metrics_returned) ? state.metrics_returned : [],
    metric_versions: state.metric_versions || {},
    time_range: state.time_range || null,
    store: state.store || null,
    status: state.status || 'active',
    created_at: state.created_at || new Date().toISOString(),
    updated_at: new Date().toISOString()
  };
  try {
    await pool().query(
      `INSERT INTO agent_long_memory (user_key, memory_key, memory_value, created_at, updated_at)
       VALUES ($1, 'session_state', $2::jsonb, NOW(), NOW())
       ON CONFLICT (user_key, memory_key)
       DO UPDATE SET memory_value = EXCLUDED.memory_value, updated_at = NOW()`,
      [u, JSON.stringify(payload)]
    );
  } catch (e) {
    console.error('[data-executor] setSessionState error:', e?.message);
  }
}

export async function resetSessionState(username) {
  const u = String(username || '').toLowerCase();
  if (!u) return;
  try {
    await pool().query(
      `UPDATE agent_long_memory SET memory_value = '{}'::jsonb, updated_at = NOW()
       WHERE user_key = $1 AND memory_key = 'session_state'`,
      [u]
    );
  } catch (e) {}
}

// ── 13. 清理过期缓存（定时任务调用） ─────────────────────────

export async function purgeExpiredCache() {
  try {
    const r = await pool().query(`DELETE FROM agent_metric_cache WHERE expires_at < NOW()`);
    return r.rowCount || 0;
  } catch (e) {
    return 0;
  }
}

// ── 14. 结构化日志 ─────────────────────────────────────────────

export function logExecutorEvent(event, data) {
  const ts = new Date().toISOString();
  const safe = {};
  for (const [k, v] of Object.entries(data || {})) {
    safe[k] = v === undefined ? null : v;
  }
  console.log(JSON.stringify({ ts, event, ...safe }));
}

// ── 15. 自然语言时间范围提取 ─────────────────────────────────
//  对齐 agents.js 中 resolveDateRangeFromQuestion 的逻辑
//  返回 "YYYY-MM-DD~YYYY-MM-DD" 格式字符串，供 executeMetrics 使用

export function extractTimeRangeFromText(text) {
  const q = String(text || '').trim();
  const now = new Date();
  const ms = 86400000;
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  function fmt(d) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  // ── 新增：日期范围识别（优先级最高）──────────────────────────
  // 支持 "15-22号"、"15号-22号"、"15日-22日"、"2月15日-22日"、"2月15-22号" 等
  const rangePatterns = [
    // "2月15日-22日" / "2月15-22号" / "2月15日至22日"
    /(\d{1,2})[月](\d{1,2})(?:[日号])?[-~至到](\d{1,2})[日号]/,
    // "15-22号" / "15号-22号" / "15日-22日" / "15至22号"
    /(\d{1,2})(?:[日号])?[-~至到](\d{1,2})[日号]/,
    // "2月15日-2月22日"
    /(\d{1,2})[月](\d{1,2})[日号][-~至到](\d{1,2})[月](\d{1,2})[日号]/
  ];

  for (const pattern of rangePatterns) {
    const match = q.match(pattern);
    if (match) {
      let startMonth, startDay, endMonth, endDay;
      
      if (match.length === 4 && pattern.source.includes('月')) {
        // "2月15日-22日" 或 "2月15-22号"
        startMonth = parseInt(match[1], 10);
        startDay = parseInt(match[2], 10);
        endMonth = startMonth;
        endDay = parseInt(match[3], 10);
      } else if (match.length === 5) {
        // "2月15日-2月22日"
        startMonth = parseInt(match[1], 10);
        startDay = parseInt(match[2], 10);
        endMonth = parseInt(match[3], 10);
        endDay = parseInt(match[4], 10);
      } else {
        // "15-22号" / "15日-22日"
        startMonth = now.getMonth() + 1;
        startDay = parseInt(match[1], 10);
        endMonth = startMonth;
        endDay = parseInt(match[2], 10);
      }

      const year = now.getFullYear();
      const start = new Date(year, startMonth - 1, startDay);
      const end = new Date(year, endMonth - 1, endDay);
      
      return {
        timeRange: `${fmt(start)}~${fmt(end)}`,
        label: `${startMonth}月${startDay}日-${endMonth === startMonth ? '' : endMonth + '月'}${endDay}日`
      };
    }
  }

  if (/今[天日]/.test(q)) {
    const s = fmt(today);
    return { timeRange: `${s}~${s}`, label: '今日' };
  }
  if (/昨[天日]/.test(q)) {
    const y = new Date(today - ms);
    const s = fmt(y);
    return { timeRange: `${s}~${s}`, label: '昨日' };
  }
  if (/前[天日]/.test(q)) {
    const d = new Date(today - 2 * ms);
    const s = fmt(d);
    return { timeRange: `${s}~${s}`, label: '前天' };
  }
  if (/上周/.test(q)) {
    const dow = today.getDay() || 7; // 1=周一 ... 7=周日
    const mon = new Date(+today - (dow - 1 + 7) * ms); // 上周一
    const sun = new Date(+mon + 6 * ms);               // 上周日
    return { timeRange: `${fmt(mon)}~${fmt(sun)}`, label: '上周' };
  }
  if (/本周/.test(q)) {
    const dow = today.getDay() || 7;
    const mon = new Date(today - (dow - 1) * ms);
    return { timeRange: `${fmt(mon)}~${fmt(today)}`, label: '本周' };
  }
  if (/上[个]?月/.test(q)) {
    const firstThisMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const lastLastMonth = new Date(firstThisMonth - ms);
    const firstLastMonth = new Date(lastLastMonth.getFullYear(), lastLastMonth.getMonth(), 1);
    return { timeRange: `${fmt(firstLastMonth)}~${fmt(lastLastMonth)}`, label: '上月' };
  }
  if (/本月/.test(q)) {
    const s = fmt(new Date(now.getFullYear(), now.getMonth(), 1));
    return { timeRange: `${s}~${fmt(today)}`, label: '本月' };
  }
  // 近N天
  const nm = q.match(/近\s*(\d+)\s*天/);
  if (nm) {
    const n = parseInt(nm[1], 10) || 7;
    return { timeRange: `${fmt(new Date(today - (n - 1) * ms))}~${fmt(today)}`, label: `近${n}天` };
  }
  // 具体月份 "2月" "2月份" "二月"
  const chMonthMap = { '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9, '十': 10, '十一': 11, '十二': 12 };
  const chMonthMatch = q.match(/(十[一二]|[一二三四五六七八九十])[月]/);
  if (chMonthMatch) {
    const mNum = chMonthMap[chMonthMatch[1]];
    if (mNum) {
      const y = now.getFullYear();
      const s = `${y}-${String(mNum).padStart(2, '0')}-01`;
      const lastDay = new Date(y, mNum, 0).getDate();
      const e = `${y}-${String(mNum).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
      return { timeRange: `${s}~${e}`, label: `${mNum}月` };
    }
  }
  // 具体单日："2月15日"、"3月1号" — 必须在 numMonthMatch 之前，否则"2月"会先匹配
  const singleDayMatch = q.match(/(\d{1,2})[月](\d{1,2})[日号]/);
  if (singleDayMatch) {
    const mNum = parseInt(singleDayMatch[1], 10);
    const dNum = parseInt(singleDayMatch[2], 10);
    if (mNum >= 1 && mNum <= 12 && dNum >= 1 && dNum <= 31) {
      const y = now.getFullYear();
      const s = `${y}-${String(mNum).padStart(2, '0')}-${String(dNum).padStart(2, '0')}`;
      return { timeRange: `${s}~${s}`, label: `${mNum}月${dNum}日` };
    }
  }
  // 数字月份 "3月" "3月份"
  const numMonthMatch = q.match(/(\d{1,2})[月]/);
  if (numMonthMatch) {
    const mNum = parseInt(numMonthMatch[1], 10);
    if (mNum >= 1 && mNum <= 12) {
      const y = now.getFullYear();
      const s = `${y}-${String(mNum).padStart(2, '0')}-01`;
      const lastDay = new Date(y, mNum, 0).getDate();
      const e = `${y}-${String(mNum).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
      return { timeRange: `${s}~${e}`, label: `${mNum}月` };
    }
  }
  // 默认：近7天
  const defaultStart = fmt(new Date(today - 6 * ms));
  return { timeRange: `${defaultStart}~${fmt(today)}`, label: '近7天' };
}

// ── 16. LLM 调用桥接（注入方式，避免循环依赖）─────────────────

let _callLLMFn = null;
export function setCallLLMBridge(fn) { _callLLMFn = fn; }

// ── 17. Business Diagnosis Agent ──────────────────────────────
//
// 职责：接收 Data Executor 的结构化数据结果，
//       在严格约束下调用 LLM 做分析推理。
//
// 约束：
//   1. LLM 只能引用 execResult.metrics_returned 中的指标
//   2. 若 LLM 输出引用了未查询指标，自动过滤/报错
//   3. 禁止 LLM 自行估算任何数值

export async function runBusinessDiagnosis(execResult, userQuery, options = {}) {
  const t0 = Date.now();
  const taskId = execResult.task_id || randomUUID();
  const availableMetrics = execResult.metrics_returned || [];
  const validResults = (execResult.results || []).filter(r => r.value !== null && r.value !== undefined);

  if (!_callLLMFn) {
    logExecutorEvent('diagnosis_skip', { task_id: taskId, reason: 'llm_bridge_not_set' });
    return null;
  }
  if (!validResults.length) {
    logExecutorEvent('diagnosis_skip', { task_id: taskId, reason: 'no_valid_data' });
    return null;
  }

  // 构建数据摘要给 LLM（只含已查到的指标）
  const dataSummary = validResults.map(r => ({
    metric_id: r.metric_id,
    name: r.name,
    value: r.value,
    time_range_label: r.time_range_label || execResult.time_range,
    store: execResult.store || '全部门店',
    notes: r.notes || ''
  }));

  const systemPrompt = `你是年年有喜餐饮集团的经营诊断专家"小年"。
你的任务：基于下方【已查数据】，对用户问题给出专业、简洁的分析结论和行动建议。

【已查数据】（仅此为据，禁止引用或估算其他数字）：
${JSON.stringify(dataSummary, null, 2)}

【严格约束】：
1. 只能基于以上数据得出结论，禁止编造、推断未查询的指标值
2. 如发现数据不足以回答某个问题，必须明确说明"该数据暂未查询，建议另行核实"
3. 结论必须量化，引用上方具体数字，不得笼统描述
4. 建议必须可执行，对应具体岗位（店长/厨师长/营运等）
5. 禁止输出任何JSON，直接输出简洁的中文分析（200字以内）

用户问题：${userQuery}
门店范围：${execResult.store || '全部门店'}
时间范围：${execResult.time_range || '近7天'}`;

  try {
    const llm = await _callLLMFn([
      { role: 'system', content: systemPrompt }
    ], { temperature: 0.15, max_tokens: 350, purpose: 'analysis' });

    const diagnosisText = String(llm?.content || '').trim();

    // 校验：LLM 回复中不能出现未查询指标的 metric_id
    const allMetricIds = (await getAllMetricDefs()).map(d => d.metric_id);
    const referencedUnavailable = allMetricIds.filter(id =>
      !availableMetrics.includes(id) && diagnosisText.includes(id)
    );
    if (referencedUnavailable.length > 0) {
      logExecutorEvent('diagnosis_validation_fail', {
        task_id: taskId,
        referenced_unavailable: referencedUnavailable
      });
      // 不阻断返回，只记录警告
    }

    const duration = Date.now() - t0;
    logExecutorEvent('diagnosis_complete', {
      task_id: taskId,
      available_metrics: availableMetrics,
      duration_ms: duration,
      text_len: diagnosisText.length
    });

    // P1B: 写入 diagnosis_feedback 表供质量监控
    try {
      await pool().query(
        `INSERT INTO diagnosis_feedback
           (task_id, user_key, store, time_range, metrics_used, diagnosis, char_count, metric_count, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, NOW(), NOW())
         ON CONFLICT DO NOTHING`,
        [
          taskId,
          options.username || 'unknown',
          execResult.store || null,
          execResult.time_range || null,
          JSON.stringify(availableMetrics),
          diagnosisText.slice(0, 2000),
          diagnosisText.length,
          availableMetrics.length
        ]
      );
    } catch (fe) {
      // 不阻断主流程
    }

    return {
      task_id: taskId,
      diagnosis: diagnosisText,
      data_basis: availableMetrics,
      generated_at: new Date().toISOString()
    };
  } catch (e) {
    logExecutorEvent('diagnosis_error', { task_id: taskId, error: e?.message });
    return null;
  }
}
