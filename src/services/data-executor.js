/**
 * Data Executor — agents-service-v2
 * 指标字典驱动的SQL查询构建器 + 缓存 + 时间范围解析
 * 从 HRMS data-executor.js 提取核心逻辑
 */
import { query } from '../utils/db.js';
import { logger } from '../utils/logger.js';
import { toFeishuStoreName } from '../config/store-mapping.js';

// ── 指标字典缓存 ──
const _dictCache = new Map();
const CACHE_TTL = 5 * 60 * 1000;

export async function getMetricDef(metricId) {
  const c = _dictCache.get(metricId);
  if (c && Date.now() - c.ts < CACHE_TTL) return c.def;
  try {
    const r = await query('SELECT * FROM metric_dictionary WHERE metric_id = $1 AND enabled = TRUE LIMIT 1', [metricId]);
    const def = r.rows?.[0] || null;
    if (def) _dictCache.set(metricId, { def, ts: Date.now() });
    return def;
  } catch (e) { return null; }
}

export async function getAllMetricDefs() {
  try { const r = await query('SELECT * FROM metric_dictionary WHERE enabled = TRUE ORDER BY metric_id'); return r.rows || []; }
  catch (e) { return []; }
}

// ── 时间范围解析 ──
export function parseTimeRange(timeRange) {
  if (!timeRange) {
    const now = new Date(); const y = now.getFullYear(); const m = String(now.getMonth()+1).padStart(2,'0'); const d = String(now.getDate()).padStart(2,'0');
    return { start: `${y}-${m}-${d}`, end: `${y}-${m}-${d}`, label: '今天' };
  }
  if (/^\d{4}-\d{2}$/.test(timeRange)) {
    const [y, mo] = timeRange.split('-');
    const lastDay = new Date(Number(y), Number(mo), 0).getDate();
    return { start: `${y}-${mo}-01`, end: `${y}-${mo}-${String(lastDay).padStart(2,'0')}`, label: `${y}年${mo}月` };
  }
  if (/^\d{4}-\d{2}-\d{2}~\d{4}-\d{2}-\d{2}$/.test(timeRange)) {
    const [s, e] = timeRange.split('~'); return { start: s, end: e, label: `${s} 至 ${e}` };
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(timeRange)) return { start: timeRange, end: timeRange, label: timeRange };
  return { start: timeRange, end: timeRange, label: timeRange };
}

// ── 自然语言时间提取 ──
export function extractTimeRangeFromText(text) {
  const t = String(text || '');
  const now = new Date();
  const fmt = d => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  if (/昨[天日]/.test(t)) { const d = new Date(now); d.setDate(d.getDate()-1); return fmt(d); }
  if (/前[天日]/.test(t)) { const d = new Date(now); d.setDate(d.getDate()-2); return fmt(d); }
  if (/今[天日]/.test(t)) return fmt(now);
  if (/最近|近期|近来/.test(t)) { const d = new Date(now); d.setDate(d.getDate()-7); return `${fmt(d)}~${fmt(now)}`; }
  if (/本周|这周/.test(t)) { const d = new Date(now); d.setDate(d.getDate()-d.getDay()+1); return `${fmt(d)}~${fmt(now)}`; }
  if (/上周/.test(t)) { const d = new Date(now); d.setDate(d.getDate()-d.getDay()-6); const e = new Date(d); e.setDate(e.getDate()+6); return `${fmt(d)}~${fmt(e)}`; }
  if (/本月|这个月/.test(t)) return `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}`;
  if (/上月|上个月/.test(t)) { const d = new Date(now.getFullYear(), now.getMonth()-1, 1); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`; }
  const dateMatch = t.match(/(\d{4})[年-](\d{1,2})[月-](\d{1,2})/);
  if (dateMatch) return `${dateMatch[1]}-${dateMatch[2].padStart(2,'0')}-${dateMatch[3].padStart(2,'0')}`;
  const monthMatch = t.match(/(\d{4})[年-](\d{1,2})月/);
  if (monthMatch) return `${monthMatch[1]}-${monthMatch[2].padStart(2,'0')}`;
  // 默认昨天
  const d = new Date(now); d.setDate(d.getDate()-1); return fmt(d);
}

/** 时间范围 → 中文展示标签（昨天、上周、本周、最近7天等） */
export function getTimeLabelChinese(timeRange) {
  if (!timeRange) return '今天';
  const now = new Date();
  const fmt = d => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  const yesterday = new Date(now); yesterday.setDate(now.getDate()-1);
  const todayStr = fmt(now);
  const yesterdayStr = fmt(yesterday);
  if (timeRange === yesterdayStr || timeRange === todayStr) return timeRange === yesterdayStr ? '昨日' : '今日';
  if (/^\d{4}-\d{2}-\d{2}$/.test(timeRange)) return timeRange;
  if (/^\d{4}-\d{2}$/.test(timeRange)) {
    const [y, m] = timeRange.split('-');
    return `${y}年${m}月`;
  }
  if (/^\d{4}-\d{2}-\d{2}~\d{4}-\d{2}-\d{2}$/.test(timeRange)) {
    const [s, e] = timeRange.split('~');
    const weekStart = new Date(now); weekStart.setDate(now.getDate()-now.getDay()+1);
    const weekEnd = new Date(weekStart); weekEnd.setDate(weekStart.getDate()+6);
    const lastWeekStart = new Date(now); lastWeekStart.setDate(now.getDate()-now.getDay()-6);
    const lastWeekEnd = new Date(lastWeekStart); lastWeekEnd.setDate(lastWeekStart.getDate()+6);
    if (s === fmt(weekStart) && e === fmt(weekEnd)) return '本周';
    if (s === fmt(lastWeekStart) && e === fmt(lastWeekEnd)) return '上周';
    const sevenDaysAgo = new Date(now); sevenDaysAgo.setDate(now.getDate()-7);
    if (s === fmt(sevenDaysAgo) && e === todayStr) return '最近7天';
    return `${s.slice(5)}～${e.slice(5)}`;
  }
  return timeRange;
}

// ── 门店模糊匹配 ──
function normalizeStore(s) { return String(s||'').trim().toLowerCase().replace(/\s+/g,''); }

// ── 核心: 单指标查询 ──
async function executeOneMetric(metricId, timeRange, store, depResults) {
  const def = await getMetricDef(metricId);
  if (!def) return { metric_id: metricId, value: null, error: `指标 ${metricId} 不存在` };
  const { start, end, label } = parseTimeRange(timeRange);
  try {
    let value = null;
    if (def.data_source === 'computed') value = computeMetric(def, depResults);
    else if (def.data_source === 'daily_reports') value = await queryDailyReports(def, start, end, store);
    else if (def.data_source === 'sales_raw') value = await querySalesRaw(def, start, end, store);
    else if (def.data_source === 'feishu_generic_records') value = await queryFeishuRecords(def, start, end, store);
    else if (def.data_source === 'schedules') value = await querySchedules(def, start, end, store);
    return { metric_id: metricId, name: def.name, value, time_range: timeRange, time_range_label: label, source: def.data_source, unit: def.metadata?.unit || null };
  } catch (e) {
    return { metric_id: metricId, name: def?.name, value: null, error: e?.message, source: def?.data_source };
  }
}

// ── 子查询: daily_reports ──
async function queryDailyReports(def, start, end, store) {
  const formula = def.formula || '';
  const aggMatch = formula.match(/^(SUM|AVG|MAX)\((.+)\)$/i);
  if (!aggMatch) return null;
  const params = [start, end];
  let sql = `SELECT ${aggMatch[1].toUpperCase()}(${aggMatch[2]})::numeric(12,2) AS val FROM daily_reports WHERE date BETWEEN $1::date AND $2::date`;
  if (store) { params.push(`%${normalizeStore(store)}%`); sql += ` AND lower(regexp_replace(coalesce(store,''),'\\s+','','g')) LIKE $3`; }
  const r = await query(sql, params);
  return r.rows?.[0]?.val !== null ? Number(r.rows[0].val) : null;
}

// ── 子查询: sales_raw ──
async function querySalesRaw(def, start, end, store) {
  const formula = def.formula || '';
  const fieldMatch = formula.match(/SUM\((\w+)\)/);
  if (!fieldMatch) return null;
  const col = { actual_revenue: 'revenue', expected_revenue: 'sales_amount', gross_revenue: 'sales_amount' }[fieldMatch[1]] || fieldMatch[1];
  const params = [start, end];
  let sql = `SELECT COALESCE(SUM(${col}),0)::numeric(12,2) AS val FROM sales_raw WHERE date BETWEEN $1 AND $2`;
  if (store) { params.push(`%${normalizeStore(store)}%`); sql += ` AND lower(regexp_replace(coalesce(store,''),'\\s+','','g')) LIKE $3`; }
  const r = await query(sql, params);
  return Number(r.rows?.[0]?.val || 0);
}

// ── 子查询: feishu_generic_records ──
async function queryFeishuRecords(def, start, end, store) {
  const formula = def.formula || '';
  const tableIdMatch = formula.match(/table_id\s*(?:=\s*'([^']+)'|IN\s*\(([^)]+)\))/);
  if (!tableIdMatch) return null;
  const tableIds = tableIdMatch[1] ? [tableIdMatch[1]] : tableIdMatch[2].split(',').map(s=>s.trim().replace(/'/g,''));
  const ph = tableIds.map((_,i)=>`$${i+1}`).join(',');
  const dIdx = tableIds.length + 1;
  const dateFilter = `(to_timestamp((fields->>'日期')::bigint/1000)::date BETWEEN $${dIdx}::date AND $${dIdx+1}::date OR (fields->>'收货日期')::date BETWEEN $${dIdx}::date AND $${dIdx+1}::date)`;
  const params = [...tableIds, start, end];
  
  const storeCond = (() => {
    if (!store) return { sql: '', params: [] };
    const storeNorm = `%${normalizeStore(store)}%`.toLowerCase();
    const feishuStore = toFeishuStoreName(store);
    const feishuNorm = feishuStore && feishuStore !== store ? `%${normalizeStore(feishuStore)}%`.toLowerCase() : null;
    const fieldExpr = `lower(regexp_replace(coalesce(fields->>'所属门店',fields->>'门店',''),'\\s+','','g'))`;
    if (feishuNorm) {
      params.push(storeNorm, feishuNorm);
      return { sql: ` AND (${fieldExpr} LIKE $${params.length - 1} OR ${fieldExpr} LIKE $${params.length})`, params: [] };
    }
    params.push(storeNorm);
    return { sql: ` AND ${fieldExpr} LIKE $${params.length}`, params: [] };
  })();

  if (/^COUNT\(\*\)/.test(formula.trim())) {
    let sql = `SELECT COUNT(*)::int AS val FROM feishu_generic_records WHERE table_id IN (${ph}) AND ${dateFilter}${storeCond.sql}`;
    const r = await query(sql, params);
    return Number(r.rows?.[0]?.val || 0);
  }
  if (/^AVG\(/.test(formula.trim())) {
    const fm = formula.match(/fields->>'([^']+)'/); if (!fm) return null;
    let sql = `SELECT AVG(NULLIF(fields->>'${fm[1]}','')::numeric)::numeric(8,2) AS val FROM feishu_generic_records WHERE table_id IN (${ph}) AND ${dateFilter} AND (fields->>'${fm[1]}') ~ '^[0-9.]+'${storeCond.sql}`;
    const r = await query(sql, params);
    return r.rows?.[0]?.val !== null ? Number(r.rows[0].val) : null;
  }
  return null;
}

// ── 子查询: schedules ──
async function querySchedules(def, start, end, store) {
  const params = [start, end];
  let sql = `SELECT COUNT(DISTINCT employee_username)::int AS val FROM schedules WHERE shift_date BETWEEN $1 AND $2 AND status = 'present'`;
  if (store) { params.push(`%${normalizeStore(store)}%`); sql += ` AND lower(regexp_replace(coalesce(store,''),'\\s+','','g')) LIKE $3`; }
  const r = await query(sql, params);
  return Number(r.rows?.[0]?.val || 0);
}

// ── 计算型指标 ──
function computeMetric(def, depResults) {
  const deps = def.dependencies || [];
  if (deps.length < 2) return null;
  const formula = def.formula || '';
  if (formula.includes('/')) {
    const [a, b] = formula.split('/').map(s=>s.trim().split(' ')[0]);
    const aV = depResults[a]?.value, bV = depResults[b]?.value;
    if (aV == null || !bV) return null;
    return Math.round((Number(aV)/Number(bV))*100)/100;
  }
  if (formula.includes('-')) {
    const [a, b] = formula.split('-').map(s=>s.trim().split(' ')[0]);
    const aV = depResults[a]?.value;
    if (aV == null) return null;
    return Number(aV) - Number(depResults[b]?.value || 0);
  }
  return null;
}

// ── 公开接口: 批量执行指标 ──
export async function executeMetrics(metricIds, timeRange, store) {
  const results = {};
  // 先解析依赖顺序
  const allDefs = {};
  for (const id of metricIds) { allDefs[id] = await getMetricDef(id); }
  // 先执行非计算型
  for (const id of metricIds) {
    if (allDefs[id]?.data_source !== 'computed') {
      results[id] = await executeOneMetric(id, timeRange, store, results);
    }
  }
  // 再执行计算型
  for (const id of metricIds) {
    if (allDefs[id]?.data_source === 'computed') {
      results[id] = await executeOneMetric(id, timeRange, store, results);
    }
  }
  return results;
}

// ── 便捷: 快速查询常用数据 ──
export async function quickQuery(table, agg, column, store, startDate, endDate) {
  const params = [startDate, endDate];
  let sql = `SELECT ${agg}(${column})::numeric(12,2) AS val FROM ${table} WHERE date BETWEEN $1::date AND $2::date`;
  if (store) { params.push(`%${normalizeStore(store)}%`); sql += ` AND lower(regexp_replace(coalesce(store,''),'\\s+','','g')) LIKE $3`; }
  const r = await query(sql, params);
  return r.rows?.[0]?.val !== null ? Number(r.rows[0].val) : null;
}

export async function getStoreRevenue(store, timeRange) {
  const { start, end } = parseTimeRange(timeRange || extractTimeRangeFromText('昨天'));
  return quickQuery('daily_reports', 'SUM', 'actual_revenue', store, start, end);
}

export async function getStoreMargin(store, timeRange) {
  const { start, end } = parseTimeRange(timeRange || extractTimeRangeFromText('昨天'));
  return quickQuery('daily_reports', 'AVG', 'CASE WHEN actual_revenue > 0 THEN gross_profit::numeric / actual_revenue * 100 ELSE 0 END', store, start, end);
}
