/**
 * 指标树分析：按 metric_dictionary.analysis_children 递归拆解（有终止条件），
 * 数值委托 data-executor.executeMetrics；返回 tree + root_causes + confidence。
 */
import { getMetricDef, executeMetrics, parseTimeRange } from './data-executor.js';
import { logger } from '../utils/logger.js';

const MAX_DEPTH = 3; // level >= 3 不再向下拆

function normalizeChildren(raw) {
  if (raw == null) return [];
  if (Array.isArray(raw)) return raw.map((x) => String(x || '').trim()).filter(Boolean);
  if (typeof raw === 'string') {
    try {
      const p = JSON.parse(raw);
      return Array.isArray(p) ? p.map((x) => String(x || '').trim()).filter(Boolean) : [];
    } catch {
      return [];
    }
  }
  return [];
}

function normalizeDeps(def) {
  try {
    const d = def?.dependencies;
    if (Array.isArray(d)) return d.map((x) => String(x || '').trim()).filter(Boolean);
    if (typeof d === 'string') {
      const p = JSON.parse(d);
      return Array.isArray(p) ? p.map((x) => String(x || '').trim()).filter(Boolean) : [];
    }
  } catch (_) {}
  return [];
}

/** 上一段等长对比区间（用于「下降 >10%」） */
export function previousPeriodRange(dateRange) {
  try {
    const { start, end } = parseTimeRange(dateRange);
    const t0 = Date.UTC(
      Number(start.slice(0, 4)),
      Number(start.slice(5, 7)) - 1,
      Number(start.slice(8, 10))
    );
    const t1 = Date.UTC(
      Number(end.slice(0, 4)),
      Number(end.slice(5, 7)) - 1,
      Number(end.slice(8, 10))
    );
    const spanDays = Math.max(1, Math.round((t1 - t0) / 86400000) + 1);
    const prevEnd = new Date(t0 - 86400000);
    const prevStart = new Date(t0 - spanDays * 86400000);
    const fmt = (d) => d.toISOString().slice(0, 10);
    return `${fmt(prevStart)}~${fmt(prevEnd)}`;
  } catch (e) {
    logger.warn({ err: e?.message }, 'analysis-engine: previousPeriodRange failed');
    return null;
  }
}

/**
 * value 较 baseline 下降超过 10% 视为异常；value/baseline 无效则不判断。
 */
export function isAbnormal(_metric, value, baseline) {
  try {
    if (value == null || baseline == null) return false;
    const v = Number(value);
    const b = Number(baseline);
    if (!Number.isFinite(v) || !Number.isFinite(b)) return false;
    if (b === 0) return false;
    const drop = (b - v) / Math.abs(b);
    return drop > 0.1;
  } catch {
    return false;
  }
}

function reasonForDrop(value, baseline) {
  try {
    if (value == null || baseline == null) return '数据不足';
    const v = Number(value);
    const b = Number(baseline);
    if (!Number.isFinite(v) || !Number.isFinite(b) || b === 0) return '环比下降';
    const pct = ((b - v) / Math.abs(b)) * 100;
    return `下降约 ${pct.toFixed(1)}%（对比上一周期）`;
  } catch {
    return '环比下降';
  }
}

function orderIdsForExecute(ids, defMap) {
  const uniq = [...new Set(ids)];
  const nonComputed = uniq.filter((i) => defMap.get(i)?.data_source !== 'computed');
  const computed = uniq.filter((i) => defMap.get(i)?.data_source === 'computed');
  return [...nonComputed, ...computed];
}

async function expandClosureWithDeps(seedIds, defMapMemo) {
  const expanded = new Set();
  async function walk(mid) {
    const id = String(mid || '').trim();
    if (!id || expanded.has(id)) return;
    expanded.add(id);
    let def = defMapMemo.get(id);
    if (def === undefined) {
      try {
        def = await getMetricDef(id);
      } catch {
        def = null;
      }
      defMapMemo.set(id, def);
    }
    for (const d of normalizeDeps(def)) await walk(d);
  }
  for (const s of seedIds) await walk(s);
  return [...expanded];
}

async function ensureExecuted(seedIds, dateRange, store, valueCache, defMapMemo) {
  try {
    const expanded = await expandClosureWithDeps(seedIds, defMapMemo);
    const missing = expanded.filter((id) => !valueCache.has(id));
    if (!missing.length) return;
    const ordered = orderIdsForExecute(expanded, defMapMemo);
    let r = {};
    try {
      r = await executeMetrics(ordered, dateRange, store || '');
    } catch (e) {
      logger.warn({ err: e?.message }, 'analysis-engine: executeMetrics batch failed');
    }
    for (const mid of ordered) {
      const v = r[mid]?.value;
      valueCache.set(
        mid,
        v != null && Number.isFinite(Number(v)) ? Number(v) : null
      );
    }
    for (const mid of expanded) {
      if (!valueCache.has(mid)) valueCache.set(mid, null);
    }
  } catch (e) {
    logger.warn({ err: e?.message }, 'analysis-engine: ensureExecuted failed');
  }
}

/**
 * 从先根序列构建 parent -> children metric_id 列表
 */
function buildChildrenMap(flat) {
  try {
    const childrenMap = new Map();
    const stack = [];
    for (const n of flat) {
      while (stack.length && stack[stack.length - 1].level >= n.level) stack.pop();
      if (stack.length) {
        const p = stack[stack.length - 1].metric;
        if (!childrenMap.has(p)) childrenMap.set(p, []);
        childrenMap.get(p).push(n.metric);
      }
      stack.push(n);
    }
    return childrenMap;
  } catch {
    return new Map();
  }
}

function nodeByMetric(flat) {
  const m = new Map();
  for (const n of flat) m.set(n.metric, n);
  return m;
}

/**
 * root_causes：最深异常节点；无则 fallback 子全 null 且有值父节点；忽略 value null。
 */
function computeRootCauses(flat, baselineByMetric) {
  try {
    const withData = flat.filter((n) => n.value != null);
    const abnormalWithData = withData.filter((n) => n.is_abnormal);
    const causes = [];
    if (abnormalWithData.length) {
      const maxLv = Math.max(...abnormalWithData.map((n) => n.level));
      for (const n of abnormalWithData) {
        if (n.level === maxLv) {
          causes.push({
            metric: n.metric,
            reason: reasonForDrop(n.value, baselineByMetric.get(n.metric))
          });
        }
      }
      return causes;
    }

    const childrenMap = buildChildrenMap(flat);
    const byM = nodeByMetric(flat);
    for (const n of withData) {
      const kids = childrenMap.get(n.metric) || [];
      if (!kids.length) continue;
      const allChildNull = kids.every((k) => byM.get(k)?.value == null);
      if (allChildNull && n.is_abnormal) {
        causes.push({
          metric: n.metric,
          reason: `${reasonForDrop(n.value, baselineByMetric.get(n.metric))}；子指标均暂无`
        });
      }
    }
    return causes;
  } catch (e) {
    logger.warn({ err: e?.message }, 'analysis-engine: computeRootCauses failed');
    return [];
  }
}

function computeConfidence(flat, rootMetric) {
  try {
    const rootIdx = flat.findIndex((n) => n.metric === rootMetric && n.level === 0);
    if (rootIdx < 0) return 'low';
    const lvl1 = [];
    for (let i = rootIdx + 1; i < flat.length; i++) {
      if (flat[i].level <= 0) break;
      if (flat[i].level === 1) lvl1.push(flat[i]);
    }
    if (!lvl1.length) return 'low';
    const ok = lvl1.filter((n) => n.value != null).length;
    if (ok === lvl1.length) return 'high';
    if (ok === 0) return 'low';
    return 'medium';
  } catch {
    return 'low';
  }
}

async function dfsTraverse(
  id,
  level,
  store,
  dateRange,
  baselineRange,
  valueCur,
  valueBase,
  defMapMemo
) {
  const mid = String(id || '').trim();
  if (!mid) return [];

  try {
    await ensureExecuted([mid], dateRange, store, valueCur, defMapMemo);
    if (baselineRange) await ensureExecuted([mid], baselineRange, store, valueBase, defMapMemo);
  } catch (e) {
    logger.warn({ err: e?.message, mid }, 'analysis-engine: dfsTraverse ensure failed');
  }

  const value = valueCur.has(mid) ? valueCur.get(mid) : null;
  const baseline = baselineRange && valueBase.has(mid) ? valueBase.get(mid) : null;
  let def = defMapMemo.get(mid);
  if (def === undefined) {
    try {
      def = await getMetricDef(mid);
    } catch {
      def = null;
    }
    defMapMemo.set(mid, def);
  }

  const abnormal = isAbnormal(mid, value, baseline);
  const node = { metric: mid, value, level, is_abnormal: !!abnormal };
  const out = [node];

  const children = normalizeChildren(def?.analysis_children);
  const stopNull = value == null;
  const stopDepth = level >= MAX_DEPTH;
  const stopLeaf = !children.length;
  if (stopNull || stopDepth || stopLeaf) return out;

  for (const c of children) {
    const sub = await dfsTraverse(
      c,
      level + 1,
      store,
      dateRange,
      baselineRange,
      valueCur,
      valueBase,
      defMapMemo
    );
    out.push(...sub);
  }
  return out;
}

/**
 * @returns {Promise<{ tree: Array, root_causes: Array, confidence: string }>}
 */
export async function analyzeMetricTree(metricCode, store, dateRange) {
  const empty = { tree: [], root_causes: [], confidence: 'low' };
  try {
    const root = String(metricCode || '').trim();
    if (!root) return empty;

    const baselineRange = previousPeriodRange(dateRange);
    const valueCur = new Map();
    const valueBase = new Map();
    const defMapMemo = new Map();

    const flat = await dfsTraverse(
      root,
      0,
      store,
      dateRange,
      baselineRange,
      valueCur,
      valueBase,
      defMapMemo
    );

    const baselineByMetric = new Map();
    for (const n of flat) {
      baselineByMetric.set(n.metric, valueBase.get(n.metric) ?? null);
    }

    const root_causes = computeRootCauses(flat, baselineByMetric);
    const confidence = computeConfidence(flat, root);

    return { tree: flat, root_causes, confidence };
  } catch (e) {
    logger.warn({ err: e?.message }, 'analysis-engine: analyzeMetricTree failed');
    return empty;
  }
}

/**
 * 将拆解结果格式化为可拼入 system prompt 的文本（兼容旧版数组或新版对象）。
 */
export function formatMetricAnalysisForPrompt(payload) {
  try {
    if (payload == null) return '';
    const rows = Array.isArray(payload) ? payload : payload.tree;
    const rc = Array.isArray(payload) ? [] : payload.root_causes || [];
    const conf = Array.isArray(payload) ? null : payload.confidence;

    const hasTree = Array.isArray(rows) && rows.length > 0;
    const hasRc = rc.length > 0;
    if (!hasTree && !hasRc) return '';

    let s = '\n【指标拆解】（metric_dictionary.analysis_children，带终止条件与异常标记）\n';
    if (hasTree) {
      for (const r of rows) {
        const level = Math.max(0, Number(r.level) || 0);
        const indent = '  '.repeat(level);
        const v = r.value != null && !Number.isNaN(r.value) ? r.value : '暂无';
        const flag = r.is_abnormal ? ' ⚠异常(较上周期↓>10%)' : '';
        s += `${indent}* ${r.metric}: ${v}${flag}\n`;
      }
    }

    if (hasRc) {
      s += '\n【关键问题 root_causes】\n';
      for (const x of rc) {
        s += `* ${x.metric}: ${x.reason || '异常'}\n`;
      }
    }

    if (conf && (hasTree || hasRc)) {
      s += `\n【拆解置信度】${conf}（high=子指标齐；medium=部分缺失；low=子指标多缺失）\n`;
    }

    return s;
  } catch (e) {
    logger.warn({ err: e?.message }, 'formatMetricAnalysisForPrompt failed');
    return '';
  }
}
