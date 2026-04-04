// ═══════════════════════════════════════════════════════
// Deterministic Reply Builders — V2
// Ported from V1 agents.js for consistent data-grounded responses
// ═══════════════════════════════════════════════════════
import { query } from '../utils/db.js';
import { logger } from '../utils/logger.js';
import { isMarketingPlanningIntent } from '../utils/marketing-intent.js';
import { feishuStoreSearchPatterns } from '../utils/store-sql-patterns.js';
import { expandAgentStoreLabels, resolveAgentCanonicalStore } from '../config/store-mapping.js';
import { detectAnalysisIntent } from './analysis-intent.js';
import { parseFeishuRatioOrPercentString, formatPercentDisplay } from '../utils/feishu-percent.js';

const TABLE_VISIT_TABLE_ID = process.env.BITABLE_TABLE_VISIT_TABLE_ID || 'tblpx5Efqc6eHo3L';

// ── Helpers ───────────────────────────────────────────

function fmt(d) {
  const dt = d instanceof Date ? d : new Date(d);
  if (isNaN(dt.getTime())) return '';
  // 强制按北京时间（Asia/Shanghai）输出 YYYY-MM-DD，避免服务器时区导致“昨日/今天”错位
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(dt);
  return parts;
}

function toD(v) {
  // 强制按北京时间（Asia/Shanghai）输出 YYYY-MM-DD
  if (v instanceof Date) {
    if (isNaN(v.getTime())) return '';
    return fmt(v);
  }
  const s = String(v || '').trim();
  if (!s) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  try {
    const d0 = new Date(s);
    if (!Number.isFinite(d0.getTime())) return '';
    return toD(d0);
  } catch {
    return '';
  }
}

function inRange(v, start, end) {
  const d = toD(v); if (!d) return false;
  if (start && d < start) return false;
  if (end && d > end) return false;
  return true;
}

function storeKey(v) { return String(v||'').trim().toLowerCase().replace(/\s+/g,''); }
function storeLike(v) { return `%${storeKey(v)}%`; }
function storeAlias(v) { return storeKey(v).replace(/(上海|北京|深圳|广州|大宁|门店|店铺|店|商场|广场|购物中心)/g,''); }

export function sameStore(a, b) {
  const x = storeKey(a), y = storeKey(b);
  if (!x || !y) return false;
  if (x === y || x.includes(y) || y.includes(x)) return true;
  const ax = storeAlias(a), by = storeAlias(b);
  return !!(ax && by && (ax === by || ax.includes(by) || by.includes(ax)));
}

/** 与 revenue_targets.period 常见写法对齐（2026-04 / 202604 / 2026/04），避免查不到月目标退回「日目标加总」 */
export function monthPeriodVariants(ym) {
  const s = String(ym || '').trim();
  const m = s.match(/^(\d{4})-(\d{2})$/);
  if (!m) return s ? [s] : [];
  const y = m[1];
  const mo = m[2];
  const compact = `${y}${mo}`;
  return [...new Set([s, compact, `${y}/${mo}`])];
}

/** 统一成 YYYY-MM，供月份先后比较（避免 202604 与 2026-04 混用） */
export function normalizePeriodToYm(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  const m = s.match(/^(\d{4})-(\d{2})$/);
  if (m) return `${m[1]}-${m[2]}`;
  const m2 = s.match(/^(\d{4})(\d{2})$/);
  if (m2) return `${m2[1]}-${m2[2]}`;
  const m3 = s.match(/^(\d{4})\/(\d{1,2})/);
  if (m3) return `${m3[1]}-${m3[2].padStart(2, '0')}`;
  return '';
}

/**
 * 当月 revenue_targets 尚未录入时：取「不晚于 refMonth」的最近一期月目标，避免退回日报单日 target（如 1.8 万）。
 */
async function matchLatestRevenueTargetAtOrBefore(labels, refMonthYm) {
  const refNorm = normalizePeriodToYm(refMonthYm) || String(refMonthYm || '').trim();
  if (!refNorm || refNorm.length < 7) return 0;
  try {
    const r = await query(`SELECT store, period, target_revenue FROM revenue_targets`, []);
    let bestYm = '';
    let bestVal = 0;
    for (const row of r.rows || []) {
      const tr = parseFloat(row.target_revenue);
      if (!Number.isFinite(tr) || tr <= 0) continue;
      const rs = String(row.store || '');
      let matched = false;
      for (const lab of labels) {
        if (sameStore(rs, lab)) {
          matched = true;
          break;
        }
      }
      if (!matched) continue;
      const pn = normalizePeriodToYm(row.period);
      if (!pn || pn > refNorm) continue;
      if (pn > bestYm) {
        bestYm = pn;
        bestVal = tr;
      }
    }
    if (bestVal > 0) {
      logger.info(
        { refMonth: refNorm, pickedPeriod: bestYm, bestVal },
        'resolveMonthlyRevenueTargetYuan: no exact row; using latest revenue_targets period <= ref month'
      );
    }
    return bestVal;
  } catch (e) {
    logger.warn({ err: e?.message }, 'matchLatestRevenueTargetAtOrBefore failed');
    return 0;
  }
}

/**
 * 本月实收目标（元）：以 revenue_targets 为权威口径；period 多格式 + 门店 sameStore / 别名；与晨报逻辑一致。
 */
export async function resolveMonthlyRevenueTargetYuan(displayStore, refMonth) {
  const store = String(displayStore || '').trim();
  const curMo = String(refMonth || '').trim();
  if (!store || !curMo) return 0;
  const variants = monthPeriodVariants(curMo);
  if (!variants.length) return 0;
  const labels = [...new Set([store, ...expandAgentStoreLabels(store)])].filter(Boolean);

  const matchRows = async () => {
    try {
      const r = await query(
        `SELECT store, target_revenue FROM revenue_targets WHERE period = ANY($1::text[])`,
        [variants]
      );
      let best = 0;
      for (const row of r.rows || []) {
        const tr = parseFloat(row.target_revenue);
        if (!Number.isFinite(tr) || tr <= 0) continue;
        const rs = String(row.store || '');
        for (const lab of labels) {
          if (sameStore(rs, lab)) {
            if (tr > best) best = tr;
            break;
          }
        }
      }
      return best;
    } catch (e) {
      logger.warn({ err: e?.message, store, curMo }, 'resolveMonthlyRevenueTargetYuan query failed');
      return 0;
    }
  };

  let v = await matchRows();
  if (v > 0) return v;
  try {
    const resolved = await resolveDbStoreName('revenue_targets', store);
    if (resolved && !sameStore(resolved, store)) {
      v = await resolveMonthlyRevenueTargetYuan(resolved, refMonth);
    }
  } catch (_) {}
  if (v > 0) return v;
  v = await matchLatestRevenueTargetAtOrBefore(labels, curMo);
  return v || 0;
}

/** 桌访行门店是否与用户查询门店为同一店（含 马己仙↔马己仙大宁店、洪潮↔洪潮久光店） */
export function visitEntryStoreMatches(rowStore, userStore) {
  const r = String(rowStore || '').trim();
  if (!r) return false;
  const labels = expandAgentStoreLabels(userStore);
  for (const lab of labels) {
    if (sameStore(r, lab)) return true;
  }
  const rCanon = resolveAgentCanonicalStore(r);
  for (const lab of labels) {
    if (sameStore(rCanon, lab)) return true;
  }
  return false;
}

function bitableDate(v, fb) {
  if (v == null || v === '') return toD(fb);
  if (typeof v === 'number' && Number.isFinite(v)) return toD(new Date(v > 1e12 ? v : v * 1000));
  const s = String(v).trim(); if (!s) return toD(fb);
  if (/^\d{10,13}$/.test(s)) { const n = Number(s); return toD(new Date(s.length === 13 ? n : n * 1000)); }
  return toD(s) || toD(fb);
}

export function ext(val) {
  if (!val) return '';
  if (typeof val === 'string') return val.trim();
  if (typeof val === 'number') return String(val);
  if (Array.isArray(val)) {
    const p = [];
    for (const it of val) {
      if (typeof it === 'string') { p.push(it); continue; }
      if (it && typeof it === 'object') {
        if (Array.isArray(it.text_arr) && it.text_arr.length) p.push(...it.text_arr.map(t=>String(t||'').trim()).filter(Boolean));
        else if (it.text) p.push(String(it.text).trim());
        else if (it.name) p.push(String(it.name).trim());
      }
    }
    return p.join('，').trim();
  }
  if (typeof val === 'object' && val && Array.isArray(val.value)) {
    const p = [];
    for (const it of val.value) {
      if (typeof it === 'string') p.push(it.trim());
      else if (it && typeof it === 'object') {
        if (it.text) p.push(String(it.text).trim());
        else if (it.name) p.push(String(it.name).trim());
      }
    }
    const j = p.filter(Boolean).join('，').trim();
    if (j) return j;
  }
  if (typeof val === 'object' && val.text != null) return String(val.text).trim();
  if (typeof val === 'object' && val.name != null) return String(val.name).trim();
  if (typeof val === 'object' && val.value != null && typeof val.value !== 'object')
    return String(val.value).trim();
  return String(val).trim();
}

/** 合并桌访条目中的「不满意菜品」：优先飞书「今天不满意的菜品」等，再回落结构化 dish（避免结构化误写入盖过正确空值） */
export function dissatisfactionDishFromMergedEntry(e) {
  const f = e?.fields && typeof e.fields === 'object' ? e.fields : {};
  const fromForm = ext(
    f['今天不满意的菜品'] ||
      f['今天 不满意的菜品'] ||
      f['今天 不满意菜品'] ||
      f['今天不满意菜品'] ||
      f['不满意菜品'] ||
      f['今天有问题的菜品'] ||
      f['产品不满意项'] ||
      ''
  ).trim();
  if (fromForm) return fromForm;
  return String(e?.dish || '').trim();
}

/** 不满意主要原因：与业务表「不满意的主要原因是什么」对齐 */
export function dissatisfactionMainReasonFromEntry(e) {
  const f = e?.fields && typeof e.fields === 'object' ? e.fields : {};
  const fromField = ext(
    f['不满意的主要原因是什么'] ||
      f['不满意的主要原因'] ||
      f['满意或不满意的主要原因是什么？'] ||
      f['满意或不满意的主要原因'] ||
      f['满意/不满意的主要原因'] ||
      f['不满意原因'] ||
      f['顾客反馈'] ||
      f['unsatisfied_items'] ||
      ''
  ).trim();
  if (fromField) return fromField;
  return String(e?.fb || '').trim();
}

export function isPositiveTableVisitSatisfaction(s) {
  const t = String(s || '').trim();
  if (!t) return false;
  if (/不满意|很差|糟糕|差劲/.test(t) && !/满意|挺好/.test(t)) return false;
  return /满意|挺好的|挺好|很好|不错|好|赞|是|^\s*y(es)?\s*$/i.test(t);
}

/**
 * 是否计为桌访「不满意」（BI / 桌访产品异常 / TOP 统计同源）：
 * - 满意度明确为好 → 否（避免误填「不满意菜品」列）
 * - 满意度明确为差 → 有结构化不满意菜品 或 有主要原因 即算不满意
 * - 满意度未填/模糊 → 须同时有「今天不满意的菜品」类字段的有效菜品 + 「不满意的主要原因是什么」类有效说明
 */
export function tableVisitEntryIsDissatisfied(e) {
  const f = e?.fields && typeof e.fields === 'object' ? e.fields : {};
  const satRaw = String(
    (e && e.sat != null && String(e.sat).trim() !== '') ? e.sat : ext(f['今天用餐是否满意'] || f['满意度'] || '')
  ).trim();
  if (satRaw && isPositiveTableVisitSatisfaction(satRaw)) return false;

  const rawDish = dissatisfactionDishFromMergedEntry(e);
  const blocked = new Set(['无', '没有', '暂无', '不清楚', '未知', '其他', '无菜品', '/', '-', '—', '无。', 'none', 'n/a', 'N/A']);
  const parts = String(rawDish || '')
    .split(/[,，、/]/)
    .map((x) => x.trim())
    .filter((x) => x && !blocked.has(x));

  const reason = String(dissatisfactionMainReasonFromEntry(e) || '').trim();
  const reasonMeaningful =
    reason.length >= 2 && !/^(无|没有|暂无|不详|未知|-|—|你好|谢谢|ok|OK)$/i.test(reason);

  if (satRaw && /不满意|很差|糟糕|差劲|^否$/i.test(satRaw) && !isPositiveTableVisitSatisfaction(satRaw)) {
    return parts.length > 0 || reasonMeaningful;
  }

  return parts.length > 0 && reasonMeaningful;
}

/** 原料收货行是否属于「需关注的异常」（收紧口径，避免正常备注被计成多条异常） */
export function materialReceiptFieldsIndicateAnomaly(fields) {
  if (!fields || typeof fields !== 'object') return false;
  const fb = ext(fields['今日异常反馈'] || fields['今天原料情况']);
  const t = String(fb || '').trim();
  if (!t || t === '-' || t === '——') return false;
  const compact = t.replace(/\s/g, '');
  if (/^(正常|无异常|无问题|一切正常|未见异常|合格|良好|ok|OK|无|没有|暂无)+$/i.test(compact)) return false;
  if (/正常|无异常|无问题|一切正常|未见异常/.test(t) && !/异常|不合格|缺货|变质|损坏|拒收|问题|偏离|投诉/.test(t)) return false;
  const sev = ext(fields['严重情况']);
  if (sev && /严重|中等|轻微|需关注|异常|不合格/.test(sev)) return true;
  const matName = ext(fields['异常原料名称']);
  if (matName && !/^(无|没有|暂无|无异常|-+|—+)$/.test(matName.trim())) return true;
  if (/异常|不合格|缺货|退货|变质|损坏|拒收|偏离|投诉|问题|隐患|瑕疵/i.test(t)) return true;
  return false;
}

export function resolveDateRange(text, dd = 7) {
  const q = String(text||'').trim();
  const now = new Date();
  const ms = 86400000;
  const toYMD = (d) => fmt(d);
  const fromYMD = (ymd) => {
    const [y, m, da] = String(ymd).split('-').map(Number);
    // 用 Date.UTC(y,m-1,d) 让该 YMD 在 Asia/Shanghai 下对应到“当天 08:00”（UTC+8），便于做日加减
    return Date.UTC(y, m - 1, da);
  };
  const shiftShanghaiYMD = (baseYmd, deltaDays) => {
    const t = fromYMD(baseYmd) + deltaDays * ms;
    return toYMD(new Date(t));
  };
  const todayYmd = toYMD(now);
  const today = todayYmd; // keep name used later

  const mr = (y, m) => {
    if (!Number.isFinite(y)||!Number.isFinite(m)||m<1||m>12) return null;
    const start = `${y}-${String(m).padStart(2,'0')}-01`;
    const endDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const end = `${y}-${String(m).padStart(2,'0')}-${String(endDay).padStart(2,'0')}`;
    return { start, end };
  };
  const rm = q.match(/(?:(\d{4})\s*年\s*)?(\d{1,2})\s*月\s*(?:到|至|~|～|-|—)\s*(?:(\d{4})\s*年\s*)?(\d{1,2})\s*月/);
  if (rm) {
    let sy=parseInt(rm[1]||now.getFullYear(),10), sm=parseInt(rm[2],10);
    let ey=parseInt(rm[3]||sy,10), em=parseInt(rm[4],10);
    if (!rm[3]&&em<sm) ey++;
    const s=mr(sy,sm), e=mr(ey,em);
    if (s&&e) return {label:`${sy}年${sm}月-${ey}年${em}月`,start:s.start,end:e.end};
  }

  // 1) 先识别“月+日”（如：3月17日/3月10号/2026年3月17日），避免被下面“仅匹配 X月”误吞成整月
  //    说明：用户近期反馈的“3月17日桌访被当成整月”就是该顺序问题。
  const mdZh = q.match(/(?:(\d{4})\s*年\s*)?(\d{1,2})\s*月\s*(\d{1,2})\s*(?:日|号)/);
  if (mdZh) {
    const y = Number(mdZh[1] || now.getFullYear());
    const m = Number(mdZh[2]);
    const d = Number(mdZh[3]);
    const start = `${y}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
    const label = mdZh[1] ? `${y}年${m}月${d}日` : `${m}月${d}日`;
    return { label, start, end: start };
  }

  // 2) 识别 “M/D” 或 “YYYY/M/D”（如：3/19、2026/3/19）
  const mdSlash = q.match(/(?:(\d{4})[\/-])?(\d{1,2})[\/-](\d{1,2})/);
  if (mdSlash) {
    const y = Number(mdSlash[1] || now.getFullYear());
    const m = Number(mdSlash[2]);
    const d = Number(mdSlash[3]);
    const start = `${y}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
    const label = mdSlash[1] ? `${y}年${m}月${d}日` : `${m}月${d}日`;
    return { label, start, end: start };
  }

  const sm2 = q.match(/(?:(\d{4})\s*年\s*)?(\d{1,2})\s*月/);
  if (sm2 && !/上[个]?月|本月/.test(q)) {
    const y=parseInt(sm2[1]||now.getFullYear(),10), m=parseInt(sm2[2],10);
    const r=mr(y,m); if (r) return {label:`${y}年${m}月`,start:r.start,end:r.end};
  }
  if (/今[天日]/.test(q)) return {label:'今日',start:today,end:today};
  if (/昨[天日]/.test(q)) { const y=shiftShanghaiYMD(today,-1); return {label:'昨日',start:y,end:y}; }
  if (/前[天日]/.test(q)) { const d=shiftShanghaiYMD(today,-2); return {label:'前天',start:d,end:d}; }
  // 周/月/近N天：仍以北京时间 YMD 做加减，保证跨时区一致
  if (/上周/.test(q)) {
    const d = new Date(fromYMD(today));
    const dow = (() => {
      // JS getUTCDay: 0=Sun
      const x = d.getUTCDay();
      return x === 0 ? 7 : x;
    })();
    const start = shiftShanghaiYMD(today, -(dow + 6));
    const end = shiftShanghaiYMD(start, 6);
    return { label:'上周', start, end };
  }
  if (/本周/.test(q)) {
    const d = new Date(fromYMD(today));
    const dow = (() => {
      const x = d.getUTCDay();
      return x === 0 ? 7 : x;
    })();
    const start = shiftShanghaiYMD(today, -(dow - 1));
    return { label:'本周', start, end: today };
  }
  if (/上[个]?月/.test(q)) {
    const n = new Date(now);
    // Shanghai 下的“本月第一天/上月最后一天”用 UTC YMD 推导
    const y = Number(toYMD(now).slice(0,4));
    const m = Number(toYMD(now).slice(5,7));
    const firstThisMonth = `${y}-${String(m).padStart(2,'0')}-01`;
    const lastPrevMonth = shiftShanghaiYMD(firstThisMonth,-1);
    const prevYear = Number(lastPrevMonth.slice(0,4));
    const prevMonth = Number(lastPrevMonth.slice(5,7));
    const firstPrevMonth = `${prevYear}-${String(prevMonth).padStart(2,'0')}-01`;
    return { label:'上月', start:firstPrevMonth, end:lastPrevMonth };
  }
  if (/本月/.test(q)) {
    const y = Number(today.slice(0,4));
    const m = Number(today.slice(5,7));
    return { label:'本月', start:`${y}-${String(m).padStart(2,'0')}-01`, end: today };
  }
  const nm = q.match(/近\s*(\d+)\s*天/);
  if (nm) {
    const n = parseInt(nm[1],10) || dd;
    const start = shiftShanghaiYMD(today, -(n-1));
    return { label:`近${n}天`, start, end: today };
  }
  if (/最近/.test(q)) {
    const start = shiftShanghaiYMD(today, -(dd-1));
    return { label:`近${dd}天`, start, end: today };
  }
  const start = shiftShanghaiYMD(today, -(dd-1));
  return { label:`近${dd}天`, start, end: today };
}

/** 桌访展示用时间副标题：单日 → 今日/昨日/具体 YYYY-MM-DD；区间 → 起止 */
export function tableVisitSubheadingPeriod(startYmd, endYmd, _ctx) {
  const s = String(startYmd || '').trim();
  const e = String(endYmd || '').trim();
  if (!s || !e) return '近期';
  if (s !== e) return `${s}～${e}`;
  const todayYmd = new Date().toLocaleString('en-CA', { timeZone: 'Asia/Shanghai' }).slice(0, 10);
  const [yy, mm, dd] = todayYmd.split('-').map(Number);
  const prev = new Date(Date.UTC(yy, mm - 1, dd));
  prev.setUTCDate(prev.getUTCDate() - 1);
  const yestYmd = prev.toLocaleString('en-CA', { timeZone: 'Asia/Shanghai' }).slice(0, 10);
  if (s === todayYmd) return '今日';
  if (s === yestYmd) return '昨日';
  return s;
}

function topN(map, n=5) { return Array.from(map.entries()).sort((a,b)=>b[1]-a[1]).slice(0,n); }

/** 桌访是否落在查询时段：优先使用业务日期字段，仅当字段缺失或无法解析时才降级用入库时间。
 *  严禁用 OR 同时命中两个条件——否则今天同步入库的历史记录会被误计入今天。 */
function visitRowInDateRange(row, start, end) {
  const f = row.fields && typeof row.fields === 'object' ? row.fields : {};
  const raw =
    f['日期'] ?? f['记录日期'] ?? f['提交时间'] ?? f['巡台日期'] ?? f['桌访日期'] ?? f['填表时间'];
  if (raw != null && String(raw).trim() !== '') {
    const dField = bitableDate(raw, row.created_at);
    if (dField) return inRange(dField, start, end); // 业务日期解析成功 → 只用业务日期
  }
  // 业务日期字段缺失或无法解析 → 降级用入库时间
  const dCreated = toD(row.created_at);
  return !!(dCreated && inRange(dCreated, start, end));
}

// Resolve store name against daily_reports / sales_raw actual store values
export async function resolveDbStoreName(tableName, storeInput) {
  const s = String(storeInput||'').trim();
  if (!s) return '';
  try {
    const r = await query(`SELECT DISTINCT store FROM ${tableName} WHERE store IS NOT NULL LIMIT 50`);
    const stores = (r.rows||[]).map(x => x.store).filter(Boolean);
    // exact match first
    const exact = stores.find(x => storeKey(x) === storeKey(s));
    if (exact) return exact;
    // fuzzy match via sameStore
    const fuzzy = stores.find(x => sameStore(x, s));
    if (fuzzy) return fuzzy;
  } catch(_e) {}
  return s;
}

// ── 1. Identity (我是谁) ─────────────────────────────

async function buildIdentityReply(text, ctx) {
  if (!/(我是谁|你知道我|我叫什么|我的名字|我的信息)/.test(text)) return '';
  const roleMap = { admin:'管理员', hq_manager:'总部营运经理', store_manager:'店长',
    store_production_manager:'出品经理', front_manager:'前厅经理', employee:'员工' };
  const name = ctx.realName || ctx.username || '未知';
  const roleName = roleMap[ctx.role] || ctx.role || '未知';
  const lines = [`您好！您的信息如下：`, `- 姓名：${name}`, `- 角色：${roleName}`];
  if (ctx.store && ctx.store !== '总部') lines.push(`- 所属门店：${ctx.store}`);
  else if (ctx.store === '总部') lines.push(`- 所属：总部`);
  return lines.join('\n');
}

// ── 2. Table Visit (桌访) ────────────────────────────

/** 飞书多维表字段 → 与结构化表一致的一行（含满意度） */
function tableVisitFlatFromFields(f) {
  const dish = ext(
    f['今天不满意的菜品'] ||
      f['今天 不满意的菜品'] ||
      f['今天 不满意菜品'] ||
      f['今天不满意菜品'] ||
      f['不满意菜品'] ||
      f['今天有问题的菜品'] ||
      f['产品不满意项'] ||
      ''
  );
  const fb = ext(
    f['不满意的主要原因是什么'] ||
      f['不满意的主要原因'] ||
      f['满意或不满意的主要原因是什么？'] ||
      f['满意或不满意的主要原因'] ||
      f['满意/不满意的主要原因'] ||
      f['不满意原因'] ||
      f['顾客反馈'] ||
      f['unsatisfied_items'] ||
      ''
  ).trim();
  const sat = String(ext(f['今天用餐是否满意'] || f['满意度'] || '') || '').trim();
  return { dish, fb, sat };
}

/** HRMS table_visit_records 一行（含满意度） */
function tableVisitFlatFromStructured(r) {
  const dish = String(r.dissatisfaction_dish || '').trim();
  const u = String(r.unsatisfied_items || '').trim();
  const legacy = String(r.feedback || '').trim();
  const fb = u || legacy;
  const sat = String(r.satisfaction_level || '').trim();
  return { dish, fb, sat };
}

/** 结构化行 → 与 feishu fields 对齐的 json，供 V1 桌访 TOP 抽取 */
function syntheticFieldsFromStructuredRow(r) {
  const dish = String(r.dissatisfaction_dish || '').trim();
  const u = String(r.unsatisfied_items || '').trim();
  const legacy = String(r.feedback || '').trim();
  const sat = String(r.satisfaction_level || '').trim();
  const promo = String(r.promotion_info || '').trim();
  const ctype = String(r.customer_type || '').trim();
  const pref = String(r.preferred_dishes || '').trim();
  const rush = String(r.rush_dish_content || '').trim();
  const positiveSat = isPositiveTableVisitSatisfaction(sat);
  const out = {
    '服务不满意项': u || legacy || undefined,
    '满意或不满意的主要原因是什么？': u || legacy || undefined,
    '不满意的主要原因是什么': u || legacy || undefined,
    '不满意的主要原因': u || legacy || undefined,
    '今天用餐是否满意': sat || undefined,
    '满意度': sat || undefined
  };
  // 满意度为正向时，不把库内 dissatisfaction_dish 写回「不满意菜品」类字段，避免盖过飞书空值、与「喜欢菜品」冲突产生假异常
  if (!positiveSat && dish) {
    out['今天不满意的菜品'] = dish;
    out['今天 不满意菜品'] = dish;
    out['今天不满意菜品'] = dish;
    out['不满意菜品'] = dish;
    out['产品不满意项'] = dish;
  }
  if (rush) out['今天催菜内容'] = rush;
  if (promo) {
    out['哪里知道我们的'] = promo;
    out['促销活动'] = promo;
  }
  if (ctype) {
    out['是否第一次来'] = ctype;
    out['客户类型'] = ctype;
  }
  if (pref) {
    out['今天比较喜欢的菜'] = pref;
    out['偏好菜品'] = pref;
    out['比较喜欢菜品'] = pref;
  }
  const hr = r.has_reservation;
  if (hr === true) out['是否有预订'] = '是';
  else if (hr === false) out['是否有预订'] = '否';
  return out;
}

const TV_FIELD_BLOCKED = new Set(['无', '没有', '暂无', '不清楚', '未知', '其他', '', '/', '-', '—', 'none', 'n/a', 'N/A']);

/** 客流渠道（多维表常见字段名 + 入库列别名） */
function tableVisitChannelFromFields(f) {
  const keys = [
    '哪里知道我们的',
    '如何知道我们',
    '客流渠道',
    '渠道',
    '怎么知道我们',
    '从哪里知道',
    '获知渠道',
    '推广渠道',
    '促销活动',
    'promotion_info'
  ];
  for (const k of keys) {
    if (!Object.prototype.hasOwnProperty.call(f, k)) continue;
    const t = ext(f[k]).trim();
    if (t && !TV_FIELD_BLOCKED.has(t)) return t;
  }
  return '';
}

/** 是否第一次来 / 新老客户（客户类型放最后，避免「商务/家庭」等误判） */
function tableVisitFirstVisitFromFields(f) {
  const keys = [
    '是否第一次来',
    '是否首访',
    '第一次来',
    '新老客户',
    '新客老客',
    'customer_type',
    '客户类型'
  ];
  for (const k of keys) {
    if (!Object.prototype.hasOwnProperty.call(f, k)) continue;
    const t = ext(f[k]).trim();
    if (t && !TV_FIELD_BLOCKED.has(t)) return t;
  }
  return '';
}

/**
 * 新客/老客归类：必须先排除「非第一次」等含「第一次」子串的老客表述，再判新客。
 * 常见误伤：「非第一次」「并非第一次」曾被 /第一次/ 判成新客 → 全量新客占比失真。
 */
function classifyNewOldFromVisitText(t0) {
  const t = String(t0 || '').trim();
  if (!t) return null;

  const oldStrong =
    /不\s*是\s*第一次|已经不是第一次|并非第一次|不是第一次|非第一次|非首访|不是首|从没来过|没来过|来过很多次|来了很多次|好多次|很多次|第\s*\d+\s*次|第\s*[二三四五六七八九十两叁]+次|第二次|第三次|第四次|第五次|反复来|总来|常来|经常来|时常来|老是来|之前来过|以前来过|来过这儿|来过的/.test(t) ||
    /老客户|老客人|^老客$|回头客|^回头$|常客|熟客|复购|老主顾|老用户|旧客/.test(t) ||
    /^否$|^不$|^没$|^non$/i.test(t) ||
    /^来过$|^有来过$|^来过啊$/.test(t) ||
    (/老|回头|熟/.test(t) && !/^新客|^新客户|^新顾客/.test(t));

  if (oldStrong) return 'old';

  const newStrong =
    /^是$|^对$|^是的$|^有$|是第一次|^第一次来$|^第一次$|第一次来|首访|^新客$|^新客户$|^新顾客$|^首次$|从没吃过|第一次到店|首次到店/.test(t) ||
    (/^新/.test(t) && !/老|旧|回头|熟/.test(t));

  if (newStrong) return 'new';

  if (/第一次/.test(t)) {
    if (/[不非否没]\s*.{0,2}第一次|第一次\s*.{0,2}[不否]/.test(t)) return 'old';
    return 'new';
  }

  return null;
}

/** 比较喜欢 / 偏好菜品 */
function tableVisitFavoriteDishesFromFields(f) {
  const keys = [
    '今天比较喜欢的菜',
    '比较喜欢菜品',
    '偏好菜品',
    '喜欢的菜',
    '今日喜欢菜品',
    '喜欢菜品',
    '今天喜欢菜',
    'preferred_dishes'
  ];
  for (const k of keys) {
    if (!Object.prototype.hasOwnProperty.call(f, k)) continue;
    const t = ext(f[k]).trim();
    if (t && !TV_FIELD_BLOCKED.has(t)) return t;
  }
  return '';
}

function tableVisitReservationFromFields(f) {
  const keys = ['是否有预订', '有无预订'];
  for (const k of keys) {
    if (!Object.prototype.hasOwnProperty.call(f, k)) continue;
    const raw = f[k];
    if (typeof raw === 'boolean') return raw;
    const t = ext(raw).trim();
    if (/有|是|已/.test(t) && !/无|否|没有|未/.test(t)) return true;
    if (/无|否|没有|未/.test(t)) return false;
  }
  return null;
}

function dailyReportsIlikePatterns(store) {
  return expandAgentStoreLabels(store).map((lab) => `%${String(lab).replace(/%/g, '')}%`);
}

/**
 * 桌访经营 KPI Markdown（周报/月报/对话侧附表）。
 * 依赖 fetchMergedTableVisitEntries：已合并飞书 fields，避免结构化表缺渠道/新老客/喜欢菜。
 */
export async function buildTableVisitKpiMarkdownSection(store, start, end, opts = {}) {
  const s = String(store || '').trim();
  const skipIfEmpty = opts.skipIfEmpty !== false;
  if (!s || !start || !end) return '';
  let entries;
  try {
    entries = await fetchMergedTableVisitEntries(s, start, end);
  } catch (e) {
    logger.warn({ err: e?.message, store: s }, 'buildTableVisitKpiMarkdownSection fetch failed');
    return '';
  }
  if (!entries.length) return skipIfEmpty ? '' : `**【${s}】** 暂无桌访样本。`;

  const n = entries.length;
  const unsatisfied = entries.filter(tableVisitEntryIsDissatisfied);
  const dissatRate = n ? ((unsatisfied.length / n) * 100).toFixed(1) : '0';

  let dineOrders = 0;
  try {
    const pats = dailyReportsIlikePatterns(s);
    const dr = await query(
      `SELECT COALESCE(SUM(dine_orders), 0)::bigint AS total_orders
       FROM daily_reports
       WHERE store ILIKE ANY($1::text[]) AND date >= $2::date AND date <= $3::date`,
      [pats.length ? pats : [`%${String(s).replace(/%/g, '')}%`], start, end]
    );
    dineOrders = parseInt(dr.rows?.[0]?.total_orders || 0, 10) || 0;
  } catch (e) {
    logger.warn({ err: e?.message }, 'buildTableVisitKpiMarkdownSection dine_orders');
  }

  const visitRatio =
    dineOrders > 0 ? `${((n / dineOrders) * 100).toFixed(1)}%（${n}/${dineOrders}）` : '—（本时段堂食单为 0，无法算占比）';

  let resvKnown = 0;
  let resvYes = 0;
  for (const e of entries) {
    const f = e.fields && typeof e.fields === 'object' ? e.fields : {};
    const r = tableVisitReservationFromFields(f);
    if (r === null) continue;
    resvKnown += 1;
    if (r) resvYes += 1;
  }
  const resvRate =
    resvKnown > 0 ? `${((resvYes / resvKnown) * 100).toFixed(1)}%（${resvYes}/${resvKnown} 条有预订字段）` : '—（无有效预订字段）';

  const channelMap = new Map();
  for (const e of entries) {
    const f = e.fields && typeof e.fields === 'object' ? e.fields : {};
    const ch = tableVisitChannelFromFields(f);
    if (!ch) continue;
    ch.split(/[,，、;/]/).forEach((p) => {
      const x = p.trim();
      if (x && !TV_FIELD_BLOCKED.has(x)) channelMap.set(x, (channelMap.get(x) || 0) + 1);
    });
  }
  const channelTop = topN(channelMap, 8);

  let newC = 0;
  let oldC = 0;
  let unknC = 0;
  for (const e of entries) {
    const f = e.fields && typeof e.fields === 'object' ? e.fields : {};
    const raw = tableVisitFirstVisitFromFields(f);
    const cls = classifyNewOldFromVisitText(raw);
    if (cls === 'new') newC += 1;
    else if (cls === 'old') oldC += 1;
    else if (raw) unknC += 1;
  }
  const mNewOldField = newC + oldC + unknC;
  const storeTitle = resolveAgentCanonicalStore(s);
  const pct = (a, b) => (b > 0 ? `${((a / b) * 100).toFixed(1)}%` : '—');
  let newLine;
  let oldLine;
  if (mNewOldField > 0) {
    newLine = `新客 **${newC}** 条｜占全样本 ${pct(newC, n)}（${newC}/${n}）｜占「新老客」有效填写 ${pct(newC, mNewOldField)}（${newC}/${mNewOldField}）`;
    oldLine = `老客 **${oldC}** 条｜占全样本 ${pct(oldC, n)}（${oldC}/${n}）｜占「新老客」有效填写 ${pct(oldC, mNewOldField)}（${oldC}/${mNewOldField}）`;
  } else {
    const anyFv = entries.some((e) => tableVisitFirstVisitFromFields(e.fields && typeof e.fields === 'object' ? e.fields : {}));
    newLine = anyFv ? '—（有填写但未能识别为新/老）' : '—（无有效填写）';
    oldLine = newLine;
  }

  const dishMapAll = new Map();
  for (const e of entries.filter(tableVisitEntryIsDissatisfied)) {
    const line = dissatisfactionDishFromMergedEntry(e);
    if (!line) continue;
    line.split(/[,，、/]/).forEach((p) => {
      const x = p.trim();
      if (x && !TV_FIELD_BLOCKED.has(x)) dishMapAll.set(x, (dishMapAll.get(x) || 0) + 1);
    });
  }
  const dishTop = topN(dishMapAll, 15);

  const favMap = new Map();
  for (const e of entries) {
    const f = e.fields && typeof e.fields === 'object' ? e.fields : {};
    const line = tableVisitFavoriteDishesFromFields(f);
    if (!line) continue;
    line.split(/[,，、/]/).forEach((p) => {
      const x = p.trim();
      if (x && !TV_FIELD_BLOCKED.has(x)) favMap.set(x, (favMap.get(x) || 0) + 1);
    });
  }
  const favTop = topN(favMap, 12);

  const period = start === end ? start : `${start} ～ ${end}`;
  const lines = [];
  lines.push(`### 桌访经营指标`);
  lines.push(`**门店** ${storeTitle}${storeTitle !== s ? `（查询：${s}）` : ''}`);
  lines.push(`**统计周期** ${period}`);
  lines.push(`**全样本** ${n} 条　**堂食单（营业日报汇总）** ${dineOrders} 单`);
  lines.push('');
  lines.push(`#### 1. 核心比率`);
  lines.push(`1. 桌访占比（桌访条数/堂食单）：${visitRatio}`);
  lines.push(`2. 就餐不满意率：**${dissatRate}%**（${unsatisfied.length}/${n}）`);
  lines.push(`3. 预订占比：${resvRate}`);
  lines.push('');
  lines.push(`#### 2. 客流渠道`);
  if (channelTop.length) {
    channelTop.forEach(([k, v], i) => {
      const pr = n ? ((v / n) * 100).toFixed(1) : '0.0';
      lines.push(`- ${i + 1}. **${k}**　**${v}** 次　·　占全样本 **${pr}%**（${v}/${n}）`);
    });
  } else {
    lines.push(`- 本时段无有效渠道填写。`);
  }
  lines.push('');
  lines.push(`#### 3. 新客 / 老客`);
  lines.push(`- ${newLine}`);
  lines.push(`- ${oldLine}`);
  if (unknC) lines.push(`- 未自动归类：**${unknC}** 条（请核对表单选项原文）`);
  lines.push('');
  lines.push(`#### 4. 不满意菜品（结构化字段汇总）`);
  if (dishTop.length) {
    dishTop.forEach(([k, v], i) => lines.push(`- ${i + 1}. ${k}（${v} 次）`));
  } else {
    lines.push(`- 无不满意菜品字段记录。`);
  }
  lines.push('');
  lines.push(`#### 5. 比较喜欢 / 喜欢的菜品`);
  if (favTop.length) {
    favTop.forEach(([k, v], i) => lines.push(`- ${i + 1}. ${k}（${v} 次）`));
  } else {
    lines.push(`- 本时段无有效喜欢菜品字段记录。`);
  }

  return lines.join('\n');
}

/**
 * 合并 table_visit_records + feishu_generic_records（按 feishu_record_id/record_id 去重）。
 * 结构化表：业务日 date 在范围内，或入库日（上海日历）在范围内，避免漏同步/时区导致的漏数。
 * 飞书缓存：visitRowInDateRange（业务日或 created_at 任一命中）。
 * @returns {Promise<Array<{ dish: string, fb: string, fields: object }>>}
 */
export async function fetchMergedTableVisitEntries(store, start, end) {
  const s = String(store || '').trim();
  if (!s || !start || !end) return [];

  let tvRows = [];
  const tvSql = (withSat, extraCols) => `
    SELECT id, feishu_record_id, date::text AS date, store,
           dissatisfaction_dish, unsatisfied_items, feedback${withSat ? ', satisfaction_level' : ''},
           created_at${extraCols}
    FROM table_visit_records
    WHERE (
      (date IS NOT NULL AND date >= $1::date AND date <= $2::date)
      OR (date IS NULL AND (timezone('Asia/Shanghai', created_at))::date >= $1::date
          AND (timezone('Asia/Shanghai', created_at))::date <= $2::date)
    )
    ORDER BY date DESC NULLS LAST, created_at DESC
    LIMIT 20000`;
  const extraCols = ', promotion_info, customer_type, preferred_dishes, has_reservation, rush_dish_content';
  try {
    const tv = await query(tvSql(true, extraCols), [start, end]);
    tvRows = (tv.rows || []).filter((row) => visitEntryStoreMatches(String(row.store || '').trim(), s));
  } catch (_e) {
    try {
      const tv1b = await query(tvSql(true, ''), [start, end]);
      tvRows = (tv1b.rows || []).filter((row) => visitEntryStoreMatches(String(row.store || '').trim(), s));
    } catch (_e1) {
      try {
        const tv2 = await query(tvSql(false, ''), [start, end]);
        tvRows = (tv2.rows || []).filter((row) => visitEntryStoreMatches(String(row.store || '').trim(), s));
      } catch (_e2) {
        tvRows = [];
      }
    }
  }

  const fidList = [...new Set(tvRows.map((r) => String(r.feishu_record_id || '').trim()).filter(Boolean))];
  let genByFid = new Map();
  if (fidList.length) {
    try {
      const gr = await query(
        `SELECT record_id, fields FROM feishu_generic_records
         WHERE (config_key = 'table_visit' OR table_id = $2)
           AND record_id = ANY($1::text[])`,
        [fidList, TABLE_VISIT_TABLE_ID]
      );
      for (const row of gr.rows || []) {
        const id = String(row.record_id || '').trim();
        if (!id) continue;
        genByFid.set(id, row.fields && typeof row.fields === 'object' ? row.fields : {});
      }
    } catch (_e) {
      genByFid = new Map();
    }
  }

  const patterns = feishuStoreSearchPatterns(s);
  let matched = [];
  try {
    const r = await query(
      `SELECT record_id, fields, created_at, updated_at FROM feishu_generic_records
       WHERE (config_key = 'table_visit' OR table_id = $1)
         AND (created_at >= NOW() - INTERVAL '120 days' OR updated_at >= NOW() - INTERVAL '120 days')
         AND (
           coalesce(fields->>'所属门店', '') ILIKE ANY ($2::text[])
           OR coalesce(fields->>'门店', '') ILIKE ANY ($2::text[])
           OR coalesce(fields->>'门店名称', '') ILIKE ANY ($2::text[])
           OR coalesce(fields->>'店名', '') ILIKE ANY ($2::text[])
           OR coalesce(fields->>'店铺', '') ILIKE ANY ($2::text[])
         )
       ORDER BY updated_at DESC
       LIMIT 12000`,
      [TABLE_VISIT_TABLE_ID, patterns]
    );
    matched = (r.rows || []).filter((row) => {
      const f = row.fields && typeof row.fields === 'object' ? row.fields : {};
      return visitEntryStoreMatches(ext(f['门店'] || f['所属门店'] || f['门店名称'] || f['店名'] || f['店铺']), s);
    });
  } catch (_e) {
    matched = [];
  }

  const byKey = new Map();
  const structuredFeishuIds = new Set();
  for (const row of tvRows) {
    const fid = String(row.feishu_record_id || '').trim();
    if (fid) structuredFeishuIds.add(fid);
    // 结构化表按 table_visit_records.id 全量保留；避免同一 feishu_record_id 对应多行时被错误去重。
    const key = `tv:${row.id}`;
    const flat = tableVisitFlatFromStructured(row);
    const syn = syntheticFieldsFromStructuredRow(row);
    const rawG = fid ? genByFid.get(fid) : null;
    const mergedFields = rawG && typeof rawG === 'object' ? { ...rawG, ...syn } : syn;
    const dishForEntry =
      isPositiveTableVisitSatisfaction(flat.sat) ? '' : flat.dish;
    byKey.set(key, { dish: dishForEntry, fb: flat.fb, sat: flat.sat, fields: mergedFields });
  }
  for (const row of matched) {
    if (!visitRowInDateRange(row, start, end)) continue;
    const fid = String(row.record_id || '').trim();
    // 结构化表已覆盖的 feishu_record_id 不再重复计数
    if (fid && structuredFeishuIds.has(fid)) continue;
    const f = row.fields && typeof row.fields === 'object' ? row.fields : {};
    const key = fid ? `gen:${fid}` : `gen:${row.created_at}|${JSON.stringify(f).slice(0, 160)}`;
    if (byKey.has(key)) continue;
    const flat = tableVisitFlatFromFields(f);
    byKey.set(key, { dish: flat.dish, fb: flat.fb, sat: flat.sat, fields: f });
  }

  return [...byKey.values()];
}

async function buildTableVisitReply(store, text) {
  const q = String(text||'').trim(), s = String(store||'').trim();
  if (!s) return '';
  if (!/(桌访|桌巡|巡台|不满意.*菜|菜品.*不满意|出品.*不满意|最不满意|不满意在哪|不满意.*原因|哪里不满意|什么不满意|什么.*产品.*不满意|产品.*不满意|不满意.*产品)/.test(q)) return '';
  const p = resolveDateRange(q, 7);
  try {
    const entries = await fetchMergedTableVisitEntries(s, p.start, p.end);
    if (!entries.length) return `📋 ${p.label}桌访记录（${s}）：暂无桌访数据。`;

    const blocked = new Set(['无','没有','暂无','不清楚','未知','其他','']);

    const unsatisfied = entries.filter(tableVisitEntryIsDissatisfied);
    const satisfiedCnt = entries.length - unsatisfied.length;

    // 产品问题：仅从不满意记录的 dish 字段（结构化字段，无歧义）
    const dishMap = new Map();
    for (const e of unsatisfied) {
      const dline = dissatisfactionDishFromMergedEntry(e);
      if (dline) {
        dline.split(/[，,、/]+/).map((x) => x.trim()).filter((d) => d && !blocked.has(d))
          .forEach((d) => dishMap.set(d, (dishMap.get(d) || 0) + 1));
      }
    }
    const dishSorted = topN(dishMap, 8);

    // 不满意原因：仅从不满意记录的 fb 字段提取
    const badFbMap = new Map();
    for (const e of unsatisfied) {
      const fb = String(e.fb || '').trim();
      if (fb && !blocked.has(fb)) fb.split(/[，,、]+/).map(x=>x.trim()).filter(Boolean)
        .forEach(x => badFbMap.set(x, (badFbMap.get(x)||0)+1));
    }
    const badFbSorted = topN(badFbMap, 5);

    const periodWord = p.start === p.end ? '昨日' : p.label;

    // 若查询问题中点名某菜品，返回该菜品专项分析
    const mentioned = dishSorted.map(([d])=>d).find(d => q.includes(d));
    if (mentioned) {
      const dEntries = unsatisfied.filter((e) =>
        String(dissatisfactionDishFromMergedEntry(e) || '').includes(mentioned)
      );
      const dFb = new Map();
      for (const e of dEntries) {
        const fb = String(e.fb||'').trim();
        if (fb && !blocked.has(fb)) fb.split(/[，,、]+/).map(x=>x.trim()).filter(Boolean)
          .forEach(x => dFb.set(x, (dFb.get(x)||0)+1));
      }
      const dl = [
        `📋 「${mentioned}」桌访专项（${s}·${periodWord}）`,
        `共 ${dEntries.length} 条不满意记录中提及该菜品（总 ${entries.length} 条）。`,
      ];
      const dFbSorted = topN(dFb, 5);
      if (dFbSorted.length) {
        dl.push('', '💬 主要不满意原因：');
        dFbSorted.slice(0, 3).forEach(([d,c],i) => dl.push(`${i+1}. ${d}（${c}次）`));
      } else {
        dl.push('', '桌访记录中未填写该菜品的具体原因。');
      }
      return dl.join('\n');
    }

    // 总览格式（与 data_auditor 桌访回复对齐）
    const lines = [
      `**桌访内容总结**　${s}　·　${periodWord}`,
      `数据来源：桌访巡台记录（结构化表 + 飞书缓存去重）　｜　共 **${entries.length}** 条`,
      '',
      `**满意度**　满意 ${satisfiedCnt} 条　｜　有问题 ${unsatisfied.length} 条`,
    ];

    lines.push('');
    if (dishSorted.length) {
      lines.push('**产品问题（不满意记录 · 不满意菜品字段）**');
      dishSorted.forEach(([d, c], i) => {
        const ex = unsatisfied.find((e) => String(dissatisfactionDishFromMergedEntry(e) || '').includes(d));
        const sample = ex?.fb ? (ex.fb.length > 20 ? `${ex.fb.slice(0, 20)}…` : ex.fb) : '';
        lines.push(`${i + 1}. ${d}　${c} 次${sample ? `　｜　反馈：${sample}` : ''}`);
      });
    } else {
      lines.push('**产品问题**　本时段未记录明确不满意菜品。');
    }

    if (badFbSorted.length) {
      lines.push('', '**不满意原因摘要**（字段：不满意的主要原因）');
      badFbSorted.forEach(([x, c], i) => lines.push(`${i + 1}. ${x}　${c} 次`));
    }

    const kpi = await buildTableVisitKpiMarkdownSection(s, p.start, p.end, { skipIfEmpty: false }).catch(() => '');
    if (kpi) {
      lines.push('', '────────────────', '', kpi);
    }

    return lines.join('\n');
  } catch(e) { return `桌访数据查询失败：${e?.message||'未知错误'}`; }
}

// ── 3. Closing Report (收档) ─────────────────────────

async function buildClosingReportReply(store, text) {
  const q = String(text||'').trim(), s = String(store||'').trim();
  if (!s) return '';
  if (!/(收档|收市|闭档|清洁|卫生|档口.*得分|得分.*档口|谁没.*收档|没收档)/.test(q)) return '';
  const p = resolveDateRange(q, 7);
  try {
    const patterns = feishuStoreSearchPatterns(s);
    const r = await query(
      `SELECT fields, created_at FROM feishu_generic_records
       WHERE config_key='closing_reports'
         AND (
           coalesce(fields->>'所属门店', '') ILIKE ANY ($1::text[])
           OR coalesce(fields->>'门店', '') ILIKE ANY ($1::text[])
         )
         AND created_at >= NOW() - INTERVAL '180 days'
       ORDER BY updated_at DESC
       LIMIT 12000`,
      [patterns]
    );
    const all = (r.rows||[]).map(row => ({ f: row.fields && typeof row.fields==='object' ? row.fields : {}, ca: row.created_at }));
    const matched = all.filter(x => sameStore(ext(x.f['门店']||x.f['所属门店']), s));
    const rows = matched.filter(x => {
      const d = bitableDate(x.f['提交时间']||x.f['日期'], x.ca);
      return d && inRange(d, p.start, p.end);
    });
    if (!rows.length) return `${p.label}收档报告（${s}）：0条记录。该时间段暂无收档报告入库。`;
    // Collect all known stations and per-date submissions
    const stationSet = new Set();
    const dateMap = {};
    for (const x of rows) {
      const station = ext(x.f['档口']);
      const d = bitableDate(x.f['提交时间']||x.f['日期'], x.ca);
      if (station) stationSet.add(station);
      if (d) {
        if (!dateMap[d]) dateMap[d] = new Map();
        if (station) {
          const submitter = ext(x.f['提交人']||x.f['姓名']||x.f['负责人']||'');
          dateMap[d].set(station, submitter);
        }
      }
    }
    const stations = Array.from(stationSet);
    const wantWhoMissed = /(谁没|没收档|缺失|漏)/.test(q);
    if (wantWhoMissed && stations.length > 0) {
      const dates = Object.keys(dateMap).sort();
      const lines = [`${p.label}收档提交情况（${s}）`, `已知岗位：${stations.join('、')}`];
      let missTotal = 0;
      for (const d of dates) {
        const submitted = dateMap[d];
        const missing = stations.filter(st => !submitted.has(st));
        if (missing.length === 0) {
          lines.push(`\n📅 ${d}：✅ 全部已提交`);
        } else {
          missTotal += missing.length;
          const missList = missing.map(st => {
            const people = rows.filter(x => ext(x.f['档口']) === st)
              .map(x => ext(x.f['提交人']||x.f['姓名']||x.f['负责人'])).filter(Boolean);
            const uniquePeople = [...new Set(people)];
            return `${st}${uniquePeople.length ? ' ('+uniquePeople.join('/')+')' : ''}`;
          }).join('、');
          lines.push(`\n📅 ${d}：缺失 ${missList}`);
        }
      }
      lines.push(`\n共缺失 ${missTotal} 次收档提交`);
      return lines.join('\n');
    }
    // Default: per-date view showing which stations submitted / missed
    const dates = Object.keys(dateMap).sort();
    if (stations.length > 0 && dates.length > 0) {
      const lines = [`${p.label}收档提交情况（${s}）`, `已知岗位：${stations.join('、')}`];
      let missTotal = 0;
      for (const d of dates) {
        const submitted = dateMap[d];
        const missing = stations.filter(st => !submitted.has(st));
        if (missing.length === 0) {
          lines.push(`\n📅 ${d}：✅ 全部已提交`);
        } else {
          missTotal += missing.length;
          const missList = missing.map(st => {
            const people = rows.filter(x => ext(x.f['档口']) === st)
              .map(x => ext(x.f['提交人']||x.f['姓名']||x.f['负责人'])).filter(Boolean);
            const uniquePeople = [...new Set(people)];
            return `${st}${uniquePeople.length ? ' ('+uniquePeople.join('/')+')' : ''}`;
          }).join('、');
          lines.push(`\n📅 ${d}：缺失 ${missList}`);
        }
      }
      lines.push(`\n共缺失 ${missTotal} 次收档提交`);
      return lines.join('\n');
    }
    // Fallback: simple summary
    const lines = [`${p.label}收档报告（${s}）`, `- 收档记录：${rows.length}条`];
    return lines.join('\n');
  } catch(e) { return `收档报告查询失败：${e?.message||'未知错误'}`; }
}

// ── 4. Opening Report (开档) ─────────────────────────

async function buildOpeningReportReply(store, text) {
  const q = String(text||'').trim(), s = String(store||'').trim();
  if (!s) return '';
  if (!/(开档|开市|备餐|谁没.*开档|没开档)/.test(q)) return '';
  const p = resolveDateRange(q, 7);
  try {
    const patterns = feishuStoreSearchPatterns(s);
    const r = await query(
      `SELECT fields, created_at FROM feishu_generic_records
       WHERE config_key='opening_reports'
         AND (
           coalesce(fields->>'所属门店', '') ILIKE ANY ($1::text[])
           OR coalesce(fields->>'门店', '') ILIKE ANY ($1::text[])
         )
         AND created_at >= NOW() - INTERVAL '180 days'
       ORDER BY updated_at DESC
       LIMIT 12000`,
      [patterns]
    );
    const all = (r.rows||[]).map(row => ({ f: row.fields && typeof row.fields==='object' ? row.fields : {}, ca: row.created_at }));
    const matched = all.filter(x => sameStore(ext(x.f['门店']||x.f['所属门店']), s));
    const rows = matched.filter(x => {
      const d = bitableDate(x.f['记录日期']||x.f['提交时间']||x.f['日期'], x.ca);
      return d && inRange(d, p.start, p.end);
    });
    if (!rows.length) {
      return `${p.label}开档报告（${s}）：0条记录。该时间段暂无开档报告入库。\n（说明：数据依赖飞书多维表变更 Webhook 写入 DB；若飞书刚提交，请确认 HRMS 已订阅 bitable.record.changed，或由管理员执行「飞书手动同步」。）`;
    }
    // Collect all known stations
    const stationSet = new Set();
    const dateMap = {};
    for (const x of rows) {
      const station = ext(x.f['岗位']||x.f['档口']);
      const d = bitableDate(x.f['记录日期']||x.f['提交时间']||x.f['日期'], x.ca);
      if (station) stationSet.add(station);
      if (d) {
        if (!dateMap[d]) dateMap[d] = new Map();
        if (station) {
          const submitter = ext(x.f['提交人']||x.f['姓名']||x.f['负责人']||'');
          dateMap[d].set(station, submitter);
        }
      }
    }
    const stations = Array.from(stationSet);
    const wantWhoMissed = /(谁没|没开档|缺失|漏)/.test(q);
    if (wantWhoMissed && stations.length > 0) {
      const dates = Object.keys(dateMap).sort();
      const lines = [`${p.label}开档提交情况（${s}）`, `已知岗位：${stations.join('、')}`];
      let missTotal = 0;
      for (const d of dates) {
        const submitted = dateMap[d];
        const missing = stations.filter(st => !submitted.has(st));
        if (missing.length === 0) {
          lines.push(`\n📅 ${d}：✅ 全部已提交`);
        } else {
          missTotal += missing.length;
          const missList = missing.map(st => {
            const people = rows.filter(x => {
              const xst = ext(x.f['岗位']||x.f['档口']);
              return xst === st;
            }).map(x => ext(x.f['提交人']||x.f['姓名']||x.f['负责人'])).filter(Boolean);
            const uniquePeople = [...new Set(people)];
            return `${st}${uniquePeople.length ? ' ('+uniquePeople.join('/')+')' : ''}`;
          }).join('、');
          lines.push(`\n📅 ${d}：缺失 ${missList}`);
        }
      }
      lines.push(`\n共缺失 ${missTotal} 次开档提交`);
      return lines.join('\n');
    }
    // Default: summary
    const stationTop = new Map();
    rows.forEach(x => { const st = ext(x.f['岗位']||x.f['档口']); if (st) stationTop.set(st,(stationTop.get(st)||0)+1); });
    const mealTop = new Map();
    rows.forEach(x => { const m = ext(x.f['饭市']); if (m) mealTop.set(m,(mealTop.get(m)||0)+1); });
    return [`${p.label}开档报告（${s}）`,
      `- 开档记录：${rows.length}条`,
      `- 岗位分布：${topN(stationTop,5).map(([k,v])=>`${k}(${v})`).join('、')||'无'}`,
      `- 饭市分布：${Array.from(mealTop.entries()).map(([k,v])=>`${k}(${v})`).join('、')||'无'}`
    ].join('\n');
  } catch(e) { return `开档报告查询失败：${e?.message||'未知错误'}`; }
}

// ── 5. Meeting Report (例会) ─────────────────────────

async function buildMeetingReportReply(store, text) {
  const q = String(text||'').trim(), s = String(store||'').trim();
  if (!s) return '';
  if (!/(例会|早会|班会|会议|开会|例会.*得分|例会.*合格)/.test(q)) return '';
  const p = resolveDateRange(q, 7);
  try {
    const r = await query(`SELECT fields, created_at FROM feishu_generic_records WHERE config_key='meeting_reports' ORDER BY updated_at DESC LIMIT 500`);
    const rows = (r.rows||[]).filter(row => {
      const f = row.fields && typeof row.fields==='object' ? row.fields : {};
      if (!sameStore(ext(f['所属门店']||f['门店']), s)) return false;
      const d = bitableDate(f['记录日期']||f['提交时间']||f['日期']||f['例会日期'], row.created_at);
      return d && inRange(d, p.start, p.end);
    });
    if (!rows.length) return `📊 ${p.label}例会数据（${s}）：暂无例会记录入库。`;
    const scores = rows.map(row => {
      const f = row.fields||{};
      let v = parseFloat(ext(f['得分']));
      if (isNaN(v)) { const m = String(f['是否合格的例会']||'').match(/(\d+(?:\.\d+)?)\s*分/); if (m) v = parseFloat(m[1]); }
      return v;
    }).filter(n=>!isNaN(n));
    const avg = scores.length ? (scores.reduce((a,b)=>a+b,0)/scores.length).toFixed(1) : '-';
    const qual = rows.filter(row => { const t = String(row.fields?.['是否合格的例会']||''); return t.includes('合格')&&!t.includes('不合格'); });
    const qualRate = rows.length ? `${qual.length}/${rows.length}次合格` : null;
    const hosts = new Map(), absentees = new Map();
    rows.forEach(row => {
      const f = row.fields||{};
      const h = ext(f['主持人']); if (h) hosts.set(h,(hosts.get(h)||0)+1);
      const abs = ext(f['缺席人员姓名']);
      if (abs && abs !== '无') abs.split(/[,，、]/).forEach(n => { n=n.trim(); if(n) absentees.set(n,(absentees.get(n)||0)+1); });
    });
    const lines = [`📊 ${p.label}例会数据（${s}）`, `- 例会记录：${rows.length}次`];
    if (avg !== '-') lines.push(`- 平均得分：${avg}分`);
    if (qualRate) lines.push(`- 合格情况：${qualRate}`);
    if (hosts.size) lines.push(`- 主持人：${topN(hosts,3).map(([k,v])=>`${k}(${v}次)`).join('、')}`);
    if (absentees.size) lines.push(`- 缺席频次Top：${topN(absentees,5).map(([k,v])=>`${k}(${v}次)`).join('、')}`);
    return lines.join('\n');
  } catch(e) { return `例会数据查询失败：${e?.message||'未知错误'}`; }
}

// ── 6. Material Report (原料收货) ────────────────────

async function buildMaterialReportReply(store, text) {
  const q = String(text||'').trim(), s = String(store||'').trim();
  if (!s) return '';
  if (!/(原料|收货|食材|进货|供应商|原材料)/.test(q)) return '';
  const p = resolveDateRange(q, 7);
  try {
    const r = await query(`SELECT fields, created_at FROM feishu_generic_records WHERE config_key LIKE 'material_%' ORDER BY updated_at DESC LIMIT 3000`);
    const all = (r.rows||[]).map(row => ({ f: row.fields && typeof row.fields==='object' ? row.fields : {}, ca: row.created_at }));
    const matched = all.filter(x => sameStore(ext(x.f['所属门店']||x.f['门店']), s));
    const rows = matched.filter(x => {
      const d = bitableDate(x.f['收货日期']||x.f['日期'], x.ca);
      return d && inRange(d, p.start, p.end);
    });
    if (!rows.length) return `${p.label}原料收货日报（${s}）：0条记录。该时间段暂无原料异常数据入库。`;
    const hasIssue = rows.filter((x) => materialReceiptFieldsIndicateAnomaly(x.f));
    const matTop = new Map();
    hasIssue.forEach(x => { const n = ext(x.f['异常原料名称']); if (n) matTop.set(n,(matTop.get(n)||0)+1); });
    const sevTop = new Map();
    hasIssue.forEach(x => { const sv = ext(x.f['严重情况']); if (sv) sevTop.set(sv,(sevTop.get(sv)||0)+1); });
    return [`${p.label}原料收货日报（${s}）`,
      `- 收货记录：${rows.length}条`,
      `- 异常记录：${hasIssue.length}条`,
      `- 异常原料Top：${topN(matTop,5).map(([k,v])=>`${k}(${v}次)`).join('、')||'无'}`,
      `- 严重程度：${Array.from(sevTop.entries()).map(([k,v])=>`${k}(${v})`).join('、')||'无'}`
    ].join('\n');
  } catch(e) { return `原料收货日报查询失败：${e?.message||'未知错误'}`; }
}

// ── 7. Bad Review (差评) ─────────────────────────────

async function buildBadReviewReply(store, text) {
  const q = String(text||'').trim(), s = String(store||'').trim();
  if (!s) return '';
  if (!/(差评|负评|投诉|点评|评价.*差|差.*评价|大众点评|美团|评价.*情况|差评.*产品|差评.*多)/.test(q)) return '';
  const p = resolveDateRange(q, 7);
  try {
    const r = await query(`SELECT fields, created_at FROM feishu_generic_records WHERE config_key='bad_review' ORDER BY updated_at DESC LIMIT 3000`);
    const rows = (r.rows||[]).filter(row => {
      const f = row.fields && typeof row.fields==='object' ? row.fields : {};
      if (!sameStore(ext(f['差评门店']||f['门店']||f['所属门店']), s)) return false;
      const d = bitableDate(f['创建日期']||f['日期']||f['提交时间']||f['评价日期'], row.created_at);
      return d && inRange(d, p.start, p.end);
    });
    if (!rows.length) return `📊 ${p.label}差评数据（${s}）：暂无差评记录入库。`;
    const prodTop = new Map(), kwTop = new Map(), platTop = new Map();
    const samples = [];
    rows.forEach(row => {
      const f = row.fields||{};
      const prod = ext(f['差评产品']||f['product_name']);
      const kw = ext(f['差评关键词']||f['keywords']);
      const plat = ext(f['差评平台']||f['platform']);
      const reason = ext(f['差评原因']||f['content']||f['reason']||f['评价内容']);
      if (prod && prod !== '无') prodTop.set(prod,(prodTop.get(prod)||0)+1);
      if (kw) kw.split(/[,，、]/).forEach(k => { k=k.trim(); if(k) kwTop.set(k,(kwTop.get(k)||0)+1); });
      if (plat) {
        const pText = Array.isArray(plat) ? plat.join('') : String(plat);
        pText.split(/[,，、]/).forEach(pp => { pp=pp.trim(); if(pp) platTop.set(pp,(platTop.get(pp)||0)+1); });
      }
      if (reason && samples.length < 3) samples.push(String(reason).slice(0,80));
    });
    const tn = (m,n=5) => topN(m,n).map(([k,v])=>`${k}(${v})`).join('、') || '无';
    const lines = [`📊 差评数据（${s}·${p.label}）`, `- 差评总数：${rows.length}条`];
    if (platTop.size) lines.push(`- 来源平台：${tn(platTop,3)}`);
    if (prodTop.size) lines.push(`- 差评产品Top：${tn(prodTop)}`);
    if (kwTop.size) lines.push(`- 关键词Top：${tn(kwTop)}`);
    if (samples.length) { lines.push(`- 最新样例：`); samples.forEach(s2=>lines.push(`  · ${s2}`)); }
    return lines.join('\n');
  } catch(e) { return `差评数据查询失败：${e?.message||'未知错误'}`; }
}

/** 晨报等：按门店 + 日期区间取差评行（与 buildBadReviewReply 同源口径） */
export async function getBadReviewRowsForStoreDateRange(store, startYmd, endYmd) {
  const s = String(store || '').trim();
  if (!s || !startYmd || !endYmd) return [];
  try {
    const r = await query(`SELECT fields, created_at FROM feishu_generic_records WHERE config_key='bad_review' ORDER BY updated_at DESC LIMIT 3000`);
    return (r.rows || []).filter(row => {
      const f = row.fields && typeof row.fields === 'object' ? row.fields : {};
      if (!sameStore(ext(f['差评门店'] || f['门店'] || f['所属门店']), s)) return false;
      const d = bitableDate(f['创建日期'] || f['日期'] || f['提交时间'] || f['评价日期'], row.created_at);
      return d && inRange(d, startYmd, endYmd);
    });
  } catch (e) {
    logger.warn({ err: e?.message }, 'getBadReviewRowsForStoreDateRange');
    return [];
  }
}

// ═══════════════════════════════════════════════════════
// 晨报：昨日桌访 / 开档 / 收档 / 例会 / 原料（与聊天侧确定性回复同源数据口径）
// ═══════════════════════════════════════════════════════

/** 单日桌访 Markdown（与 buildTableVisitReply 总览格式一致，供晨报引用） */
export async function buildTableVisitBriefingBlock(store, ymd, opts = {}) {
  const s = String(store || '').trim();
  const day = String(ymd || '').trim();
  const who = String(opts.displayName || '').trim();
  if (!s || !day) return '';
  const blocked = new Set(['无', '没有', '暂无', '不清楚', '未知', '其他', '']);
  try {
    const entries = await fetchMergedTableVisitEntries(s, day, day);
    const head = [];
    head.push(`**🪑 昨天桌访（${day}）**`);
    head.push(`_${who ? `${who}：` : ''}📋 桌访内容总结（${s} · 昨日）_`);
    head.push(`来源：桌访巡台记录（结构化表 + 飞书缓存去重）。共 **${entries.length}** 条。`);
    if (!entries.length) {
      head.push('⚠️ 本日暂无桌访数据入库。');
      return head.join('\n');
    }

    const unsatisfied = entries.filter(tableVisitEntryIsDissatisfied);
    const satisfiedCnt = entries.length - unsatisfied.length;

    const dishMap = new Map();
    for (const e of unsatisfied) {
      const dline = dissatisfactionDishFromMergedEntry(e);
      if (dline) {
        dline.split(/[，,、/]+/).map((x) => x.trim()).filter((d) => d && !blocked.has(d))
          .forEach((d) => dishMap.set(d, (dishMap.get(d) || 0) + 1));
      }
    }
    const dishSorted = topN(dishMap, 8);

    const badFbMap = new Map();
    for (const e of unsatisfied) {
      const fb = String(e.fb || '').trim();
      if (fb && !blocked.has(fb)) {
        fb.split(/[，,、]+/).map((x) => x.trim()).filter(Boolean)
          .forEach((x) => badFbMap.set(x, (badFbMap.get(x) || 0) + 1));
      }
    }
    const badFbSorted = topN(badFbMap, 5);

    const lines = [...head, '', `📊 **满意度：** 满意 **${satisfiedCnt}** 条 · 有问题 **${unsatisfied.length}** 条`];

    lines.push('');
    if (dishSorted.length) {
      lines.push('🍽️ **产品问题**（不满意记录明确填写）：');
      dishSorted.forEach(([d, c], i) => {
        const ex = unsatisfied.find((e) => String(dissatisfactionDishFromMergedEntry(e) || '').includes(d));
        const sample = ex?.fb ? (ex.fb.length > 36 ? `${ex.fb.slice(0, 36)}…` : ex.fb) : '';
        lines.push(`${i + 1}. ${d}（${c}次）${sample ? `｜反馈：${sample}` : ''}`);
      });
    } else {
      lines.push('🍽️ **产品问题：** 本日未记录明确不满意菜品。');
    }

    if (badFbSorted.length) {
      lines.push('', '💬 **不满意原因摘要：**');
      badFbSorted.forEach(([x, c], i) => lines.push(`${i + 1}. ${x}（${c}次）`));
    }

    const rushMap = new Map();
    for (const e of entries) {
      const ff = e.fields && typeof e.fields === 'object' ? e.fields : {};
      const t = ext(ff['今天催菜内容'] || '').trim();
      if (!t || blocked.has(t)) continue;
      rushMap.set(t, (rushMap.get(t) || 0) + 1);
    }
    const rushSorted = topN(rushMap, 10);
    lines.push('', '⏱️ **催菜内容（昨日汇总）**');
    lines.push('_字段：今天催菜内容_');
    if (rushSorted.length) {
      rushSorted.forEach(([x, c], i) => lines.push(`${i + 1}. ${x}（${c}次）`));
    } else {
      lines.push('本日无催菜记录或字段未填写。');
    }

    const kpi = await buildTableVisitKpiMarkdownSection(s, day, day, { skipIfEmpty: false }).catch(() => '');
    if (kpi) {
      lines.push('', '────────────────', '', kpi);
    }

    return lines.join('\n');
  } catch (e) {
    return `**🪑 昨天桌访（${day}）**\n⚠️ 查询失败：${e?.message || '未知错误'}`;
  }
}

function filterFeishuRowsByStoreAndDate(rows, store, ymd, storeFieldPickers, dateFieldPickers) {
  const s = String(store || '').trim();
  const day = String(ymd || '').trim();
  return (rows || []).filter((row) => {
    const f = row.fields && typeof row.fields === 'object' ? row.fields : {};
    let storeOk = false;
    for (const pick of storeFieldPickers) {
      if (sameStore(ext(pick(f)), s)) {
        storeOk = true;
        break;
      }
    }
    if (!storeOk) return false;
    let d = '';
    for (const pick of dateFieldPickers) {
      d = bitableDate(pick(f), row.created_at);
      if (d) break;
    }
    return d && inRange(d, day, day);
  });
}

export async function buildOpeningBriefingBlock(store, ymd) {
  const s = String(store || '').trim();
  const day = String(ymd || '').trim();
  if (!s || !day) return '';
  try {
    const patterns = feishuStoreSearchPatterns(s);
    const r = await query(
      `SELECT fields, created_at FROM feishu_generic_records
       WHERE config_key='opening_reports'
         AND (
           coalesce(fields->>'所属门店', '') ILIKE ANY ($1::text[])
           OR coalesce(fields->>'门店', '') ILIKE ANY ($1::text[])
         )
         AND created_at >= NOW() - INTERVAL '180 days'
       ORDER BY updated_at DESC
       LIMIT 12000`,
      [patterns]
    );
    const rows = filterFeishuRowsByStoreAndDate(
      r.rows || [],
      s,
      day,
      [(f) => f['门店'] || f['所属门店']],
      [(f) => f['记录日期'] || f['提交时间'] || f['日期']]
    );
    const stationTop = new Map();
    const mealTop = new Map();
    rows.forEach((x) => {
      const f = x.fields || {};
      const st = ext(f['岗位'] || f['档口']);
      if (st) stationTop.set(st, (stationTop.get(st) || 0) + 1);
      const m = ext(f['饭市']);
      if (m) mealTop.set(m, (mealTop.get(m) || 0) + 1);
    });
    const stStr = topN(stationTop, 6).map(([k, v]) => `${k}(${v})`).join('、') || '—';
    const mealStr = topN(mealTop, 4).map(([k, v]) => `${k}(${v})`).join('、') || '—';
    if (!rows.length) {
      return `**📂 昨天开档（${day}）**\n· ⚠️ 无记录（依赖飞书同步；也可在助手内发送「昨天开档」查询）`;
    }
    return `**📂 昨天开档（${day}）**\n· 记录 **${rows.length}** 条｜岗位：${stStr}\n· 饭市：${mealStr}`;
  } catch (e) {
    return `**📂 昨天开档**\n· ⚠️ ${e?.message || '查询失败'}`;
  }
}

export async function buildClosingBriefingBlock(store, ymd) {
  const s = String(store || '').trim();
  const day = String(ymd || '').trim();
  if (!s || !day) return '';
  try {
    const patterns = feishuStoreSearchPatterns(s);
    const r = await query(
      `SELECT fields, created_at FROM feishu_generic_records
       WHERE config_key='closing_reports'
         AND (
           coalesce(fields->>'所属门店', '') ILIKE ANY ($1::text[])
           OR coalesce(fields->>'门店', '') ILIKE ANY ($1::text[])
         )
         AND created_at >= NOW() - INTERVAL '180 days'
       ORDER BY updated_at DESC
       LIMIT 12000`,
      [patterns]
    );
    const rows = filterFeishuRowsByStoreAndDate(
      r.rows || [],
      s,
      day,
      [(f) => f['门店'] || f['所属门店']],
      [(f) => f['提交时间'] || f['日期']]
    );
    if (!rows.length) {
      return `**📥 昨天收档（${day}）**\n· ⚠️ 无记录（依赖飞书同步；也可在助手内发送「昨天收档」查询）`;
    }
    const stationTop = new Map();
    rows.forEach((x) => {
      const f = x.fields || {};
      const st = ext(f['档口']);
      if (st) stationTop.set(st, (stationTop.get(st) || 0) + 1);
    });
    const stStr = topN(stationTop, 8).map(([k, v]) => `${k}(${v})`).join('、') || '—';
    return `**📥 昨天收档（${day}）**\n· 记录 **${rows.length}** 条｜档口：${stStr}`;
  } catch (e) {
    return `**📥 昨天收档**\n· ⚠️ ${e?.message || '查询失败'}`;
  }
}

export async function buildMeetingBriefingBlock(store, ymd) {
  const s = String(store || '').trim();
  const day = String(ymd || '').trim();
  if (!s || !day) return '';
  try {
    const r = await query(
      `SELECT fields, created_at FROM feishu_generic_records
       WHERE config_key='meeting_reports'
       ORDER BY updated_at DESC
       LIMIT 500`
    );
    const rows = filterFeishuRowsByStoreAndDate(
      r.rows || [],
      s,
      day,
      [(f) => f['所属门店'] || f['门店']],
      [(f) => f['记录日期'] || f['提交时间'] || f['日期'] || f['例会日期']]
    );
    if (!rows.length) {
      return `**📣 昨天例会（${day}）**\n· ⚠️ 无例会记录入库`;
    }
    const scores = rows.map((row) => {
      const f = row.fields || {};
      let v = parseFloat(ext(f['得分']));
      if (isNaN(v)) {
        const m = String(f['是否合格的例会'] || '').match(/(\d+(?:\.\d+)?)\s*分/);
        if (m) v = parseFloat(m[1]);
      }
      return v;
    }).filter((n) => !isNaN(n));
    const avg = scores.length ? (scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(1) : '—';
    const qual = rows.filter((row) => {
      const t = String(row.fields?.['是否合格的例会'] || '');
      return t.includes('合格') && !t.includes('不合格');
    });
    const qualStr = `${qual.length}/${rows.length} 次标注合格`;
    return `**📣 昨天例会（${day}）**\n· 记录 **${rows.length}** 次｜平均 **${avg}** 分｜${qualStr}`;
  } catch (e) {
    return `**📣 昨天例会**\n· ⚠️ ${e?.message || '查询失败'}`;
  }
}

export async function buildMaterialBriefingBlock(store, ymd) {
  const s = String(store || '').trim();
  const day = String(ymd || '').trim();
  if (!s || !day) return '';
  try {
    const r = await query(
      `SELECT fields, created_at FROM feishu_generic_records
       WHERE config_key LIKE 'material_%'
       ORDER BY updated_at DESC
       LIMIT 3000`
    );
    const rows = filterFeishuRowsByStoreAndDate(
      r.rows || [],
      s,
      day,
      [(f) => f['所属门店'] || f['门店']],
      [(f) => f['收货日期'] || f['日期']]
    );
    if (!rows.length) {
      return `**🥬 昨天原料收货（${day}）**\n· ⚠️ 无记录`;
    }
    const hasIssue = rows.filter((x) => materialReceiptFieldsIndicateAnomaly(x.fields || {}));
    const matTop = new Map();
    hasIssue.forEach((x) => {
      const f = x.fields || {};
      const n = ext(f['异常原料名称']);
      if (n) matTop.set(n, (matTop.get(n) || 0) + 1);
    });
    const topStr = topN(matTop, 4).map(([k, v]) => `${k}(${v})`).join('、') || '无';
    return `**🥬 昨天原料收货（${day}）**\n· 收货 **${rows.length}** 条｜异常 **${hasIssue.length}** 条${hasIssue.length ? `｜异常原料：${topStr}` : ''}`;
  } catch (e) {
    return `**🥬 昨天原料收货**\n· ⚠️ ${e?.message || '查询失败'}`;
  }
}

/** 合并昨日五项（晨报专用，块间分隔线） */
export async function buildYesterdayOpsBriefingSection(store, ymd, opts = {}) {
  const [tv, op, cl, mt, mat] = await Promise.all([
    buildTableVisitBriefingBlock(store, ymd, opts),
    buildOpeningBriefingBlock(store, ymd),
    buildClosingBriefingBlock(store, ymd),
    buildMeetingBriefingBlock(store, ymd),
    buildMaterialBriefingBlock(store, ymd)
  ]);
  const blocks = [tv, op, cl, mt, mat].filter(Boolean);
  return (
    '**──────── 昨日营运速览 ────────**\n\n' +
    blocks.join('\n\n---\n\n')
  );
}

// ── 8. Daily Report (营收分析) ───────────────────────

/** 基于已有指标生成可执行经营建议（确定性文案，不依赖 LLM） */
function buildDailyReportSuggestionBlock(ctx) {
  const {
    mBudget = 0,
    cumRev = 0,
    totalDays = 30,
    mDays = 0,
    actualMargin = null,
    dineOrd = null,
    delOrd = null
  } = ctx;
  const lines = ['─────────────────────', '💡 **经营建议**'];
  const tips = [];
  if (mBudget > 0 && totalDays > 0) {
    const ar = (cumRev / mBudget) * 100;
    const tr = (mDays / totalDays) * 100;
    const gap = ar - tr;
    if (gap < -5) {
      tips.push(`本月实收达成相对理论进度落后约 ${Math.abs(gap).toFixed(1)}%，建议今日复盘高峰排班、引流与折扣，并锁定 1～2 条明日可执行动作。`);
    } else if (gap >= 2) {
      tips.push('进度正常或超前，可把精力放在会员沉淀、储值复购与点评口碑维护。');
    } else {
      tips.push('达成与日历进度接近，建议持续盯紧客单结构变化，适时微调套餐与加购话术。');
    }
  }
  const d0 = dineOrd != null ? Number(dineOrd) : null;
  const o0 = delOrd != null ? Number(delOrd) : null;
  if (d0 != null && o0 != null && !Number.isNaN(d0) && !Number.isNaN(o0) && o0 > d0 * 1.5 && d0 < 25) {
    tips.push('堂食单量相对外卖偏少，可检查午晚市进店动线、等位体验与门口展示是否影响转化。');
  }
  const mg = actualMargin != null ? Number(actualMargin) : null;
  if (mg != null && !Number.isNaN(mg) && mg < 48) {
    tips.push(`毛利率约 ${mg.toFixed(1)}% 偏低，建议结合销售明细排查高折、高损耗品项，并与出品对齐备量。`);
  }
  if (tips.length < 2) {
    tips.push('对照客流与评价，检查主推菜与套餐曝光是否需要轮换，避免结构老化。');
  }
  if (tips.length < 2) {
    tips.push('收档后前厅与出品各记一条昨日根因（慢单/退菜/断货），开档前落实一项小改进。');
  }
  tips.slice(0, 3).forEach((s, i) => lines.push(`${i + 1}. ${s}`));
  return lines;
}

/** 毛利日期 → YYYY-MM（上海时区，与 bitable-poller 一致） */
function periodYmFromMarginDateRaw(raw) {
  const t = ext(raw).trim();
  if (!t) return '';
  const n = Number(t);
  if (Number.isFinite(n) && n > 1e11) {
    const ms = n > 1e12 ? n : n * 1000;
    const sh = new Date(ms).toLocaleString('en-CA', { timeZone: 'Asia/Shanghai' }).slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(sh)) return sh.slice(0, 7);
  }
  const m = t.match(/(\d{4})[年/-\s](\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}`;
  const m2 = t.match(/^(\d{4})-(\d{2})-\d{2}/);
  if (m2) return `${m2[1]}-${m2[2]}`;
  return '';
}

/** 飞书百分比/小数比率 → 0–100 数值（供 monthly_margins、BI 与展示） */
export function parsePctField(raw) {
  return parseFeishuRatioOrPercentString(ext(raw));
}

/**
 * 从飞书同步的「实际毛利率表」取门店某自然月一行（供营收卡片与 BI 兜底）
 */
/** 问题原文若包含更完整的门店全称（feishu_users 登记名），优先用于确定性取数 */
export async function pickStoreFromQuestionText(text, fallback) {
  const t = String(text || '');
  const fb = String(fallback || '').trim();
  if (!t) return fb;
  try {
    const r = await query(
      `SELECT DISTINCT store FROM feishu_users WHERE store IS NOT NULL AND store != '' AND store != '总部'`
    );
    let best = '';
    for (const row of r.rows || []) {
      const sn = String(row.store || '').trim();
      if (!sn || !t.includes(sn)) continue;
      if (sn.length > best.length) best = sn;
    }
    if (best) return best;
  } catch (_) {}
  return fb;
}

export async function fetchActualGrossMarginForStorePeriod(storeInput, periodYm) {
  const sIn = String(storeInput || '').trim();
  const py = String(periodYm || '').trim();
  if (!sIn || !py) return null;
  try {
    const r = await query(
      `SELECT fields FROM feishu_generic_records
       WHERE config_key = 'actual_gross_margin'
       ORDER BY updated_at DESC LIMIT 500`,
      []
    );
    for (const row of r.rows || []) {
      const f = row.fields || {};
      const rowStore = ext(f['门店']);
      if (!rowStore) continue;
      if (!visitEntryStoreMatches(rowStore, sIn) && !sameStore(rowStore, sIn)) continue;
      if (periodYmFromMarginDateRaw(f['毛利日期']) !== py) continue;
      return {
        preDiscountTurnover: ext(f['折前营业额']),
        actualRevenue: ext(f['实收营业额']),
        preDiscountMarginPct: parsePctField(f['折前毛利率'] ?? f['毛利率']),
        actualReceivedMarginPct: parsePctField(f['实收毛利率']),
        consumablesRatioPct: parsePctField(f['耗材占比率']),
        inventoryAmount: ext(f['本月库存金额']),
        purchaseNonQjc: ext(f['非权金城采购金额']),
        purchaseQjc: ext(f['权金城采购金额']),
        purchaseCons: ext(f['耗材采购金额'])
      };
    }
  } catch (e) {
    logger.warn({ err: e?.message }, 'fetchActualGrossMarginForStorePeriod failed');
  }
  return null;
}

export function formatActualGrossMarginBitableLines(b, periodLabel = '') {
  if (!b) return [];
  const sub = periodLabel ? ` · ${periodLabel}` : '';
  const lines = ['─────────────────────', `📗 **实际毛利率表（飞书同步${sub}）**`];
  if (b.preDiscountTurnover) lines.push(`- 折前营业额：${b.preDiscountTurnover}`);
  if (b.actualRevenue) lines.push(`- 实收营业额：${b.actualRevenue}`);
  if (b.preDiscountMarginPct != null) lines.push(`- **折前毛利率**：${formatPercentDisplay(b.preDiscountMarginPct)}`);
  if (b.actualReceivedMarginPct != null) lines.push(`- **实收毛利率**：${formatPercentDisplay(b.actualReceivedMarginPct)}`);
  if (b.consumablesRatioPct != null) lines.push(`- **耗材占比率**：${formatPercentDisplay(b.consumablesRatioPct)}`);
  if (b.inventoryAmount) lines.push(`- 本月库存金额：${b.inventoryAmount}`);
  return lines;
}

async function buildDailyReportReply(store, text, ctx = {}) {
  const q = String(text||'').trim(), s = String(store||'').trim();
  if (!s) return '';
  // 分析类意图：不走营业日报式汇总（ctx.forceAnalysis 由 intent-classifier 同步；无 ctx 时兼容旧关键词）
  if (ctx?.forceAnalysis === true || detectAnalysisIntent(q)) return '';
  if (!/(营业额|营收|日报|毛利|点评评分|revenue|翻台|客单价|业绩|达成率|目标|生意|经营情况|经营)/.test(q)) return '';
  // 理论毛利率/成本库推导口径 → 交给 data_auditor（sales_raw + dish_library_costs），避免此处用飞书「实际毛利率表」抢先答成「实际数据」
  if (/理论\s*毛|理论折前|理论实收|成本库.*毛利|按销售明细.*毛利|菜品.*理论.*毛/.test(q)) return '';
  const p = resolveDateRange(q, 7);
  // 不在这里做“模糊选一个门店”，避免把用户输入映射到错误的 daily_reports 行。
  // 对日/月目标等关键口径，优先使用用户传入的门店字符串进行 LIKE 匹配；若 daily_reports 没查到，后续再走销售兜底。
  let sl = storeLike(s);
  /** 今日/昨日日报未同步时改用最近一条已入库日报时的提示（插在报告最前） */
  let stalenessBanner = '';
  try {
    let sql = `SELECT * FROM daily_reports WHERE lower(regexp_replace(coalesce(store,''),'\\s+','','g')) LIKE $1`;
    const params = [sl];
    if (p.start) { sql += ` AND date >= $${params.length+1}`; params.push(p.start); }
    if (p.end) { sql += ` AND date <= $${params.length+1}`; params.push(p.end); }
    sql += ' ORDER BY date DESC LIMIT 60';
    const r = await query(sql, params);
    let rows = r.rows || [];
    if (!rows.length) {
      // 回退到 resolveDbStoreName：处理 store 值中缺少“店/门店/前台/后厨”等后缀导致的 LIKE 不命中。
      try {
        const resolvedStore = await resolveDbStoreName('daily_reports', s);
        const sl2 = storeLike(resolvedStore);
        if (sl2 && sl2 !== sl) {
          sl = sl2;
          let sql2 = `SELECT * FROM daily_reports WHERE lower(regexp_replace(coalesce(store,''),'\\s+','','g')) LIKE $1`;
          const params2 = [sl2];
          if (p.start) { sql2 += ` AND date >= $${params2.length+1}`; params2.push(p.start); }
          if (p.end) { sql2 += ` AND date <= $${params2.length+1}`; params2.push(p.end); }
          sql2 += ' ORDER BY date DESC LIMIT 60';
          const r2 = await query(sql2, params2);
          rows = r2.rows || [];
        }
      } catch(_e) {}

      // 单日（今日/昨日）查询：当天行未入库时，用「截至查询日」最近一条日报，避免长期误报「暂无营业数据」
      if (
        !rows.length &&
        p.start &&
        p.end &&
        p.start === p.end &&
        (p.label === '今日' || p.label === '昨日')
      ) {
        try {
          const st = await query(
            `SELECT * FROM daily_reports WHERE lower(regexp_replace(coalesce(store,''),'\\s+','','g')) LIKE $1
             AND date <= $2::date
             ORDER BY date DESC LIMIT 1`,
            [sl, p.end]
          );
          if (st.rows?.length) {
            rows = st.rows;
            const rawD = st.rows[0].date;
            const d0 =
              rawD instanceof Date
                ? rawD.toLocaleString('en-CA', { timeZone: 'Asia/Shanghai' }).slice(0, 10)
                : String(rawD || '').slice(0, 10);
            const ask = String(p.end).slice(0, 10);
            if (d0 && ask && d0 !== ask) {
              stalenessBanner =
                `⚠️ **${p.label}（${ask}）**营业日报尚未入库或未同步，以下为该店**最近一条**已入库日报（**${d0}**）。\n\n`;
            }
          }
        } catch (_e) {}
      }

      if (rows.length) {
        // retry 成功，继续走后续“有数据”逻辑
      } else {
      try {
        // 与 daily_reports 一致用 LIKE，避免 sales_raw.store 写法与 HRMS 全称略有不同时「昨天无日报行」却查不到销售
        const sr = await query(
          `SELECT s.date::text AS date, ROUND(SUM(COALESCE(s.revenue,0))::numeric,2) AS day_rev,
                  ROUND(SUM(COALESCE(s.sales_amount,0))::numeric,2) AS day_sales
           FROM sales_raw s WHERE lower(regexp_replace(coalesce(s.store,''),'\\s+','','g')) LIKE $1
             AND s.date BETWEEN $2 AND $3 GROUP BY s.date ORDER BY s.date DESC LIMIT 60`,
          [sl, p.start, p.end]);
        const sRows = sr.rows||[];
        if (sRows.length) {
          const tRev = sRows.reduce((a,x)=>a+(parseFloat(x.day_rev)||0),0);
          const tSales = sRows.reduce((a,x)=>a+(parseFloat(x.day_sales)||0),0);
          const ln = [`📊 营收分析（${s} | ${p.label}）`, `\n- **实收营业额**: ${tRev.toFixed(2)} (已扣优惠)`];
          if (tSales>0) ln.push(`- **折前营业额**: ${tSales.toFixed(1)}`);
          ln.push(`\n> 数据源：sales_raw（共${sRows.length}天）`);
          const refYm = (p.start && String(p.start).length >= 7) ? String(p.start).slice(0, 7) : '';
          const bit = refYm ? await fetchActualGrossMarginForStorePeriod(s, refYm) : null;
          if (bit) ln.push(...formatActualGrossMarginBitableLines(bit, p.label));
          else if (/(毛利|毛利率)/.test(q)) {
            ln.push('\n> 毛利率：暂无多维表「实际毛利率表」该月数据（请确认表中已有该门店该月一行并已同步）');
          }
          ln.push(...buildDailyReportSuggestionBlock({ mBudget: 0, cumRev: 0, totalDays: 30, mDays: 0 }));
          return ln.join('\n');
        }
      } catch(_e){}
      return `📊 ${p.label}营收分析（${s}）：暂无营业数据。`;
      }
    }
    const todayStr = fmt(new Date());
    // 目标分母以“用户请求的月份”为准（避免 3月10日被计算成别的月份目标）。
    const refMonth = (p.start && /^\d{4}-\d{2}-\d{2}$/.test(p.start)) ? p.start.slice(0, 7)
      : ((p.start && /^\d{4}-\d{2}-01$/.test(p.start)) ? p.start.slice(0, 7) : todayStr.slice(0, 7));
    const monthStart = `${refMonth}-01`;
    const yM = Number(refMonth.slice(0, 4));
    const mM = Number(refMonth.slice(5, 7));
    const totalDays = new Date(yM, mM, 0).getDate();
    const monthEnd = `${refMonth}-${String(totalDays).padStart(2,'0')}`;
    /** revenue_targets 本月实收目标（与 period 写法 2026-04 / 202604 无关，一律能命中） */
    const configMonthTarget = await resolveMonthlyRevenueTargetYuan(s, refMonth);

    let cumRev=0, cumPre=0, mBudget=0, mDays=0, cumLabor=0;
    try {
      // 累计实际：从月初到用户请求的结束日期
      const mR = await query(`SELECT COALESCE(SUM(actual_revenue),0) cr, COALESCE(SUM(pre_discount_revenue),0) cp,
        COUNT(*) d, COALESCE(SUM(labor_total),0) cl
        FROM daily_reports
        WHERE lower(regexp_replace(coalesce(store,''),'\\s+','','g')) LIKE $1
          AND date>=$2 AND date<=$3`,
        [sl, monthStart, p.end||monthEnd]);
      const m = mR.rows?.[0]||{};
      cumRev=parseFloat(m.cr)||0;
      cumPre=parseFloat(m.cp)||0;
      mDays=parseInt(m.d)||0;
      cumLabor=parseFloat(m.cl)||0;
    } catch(_e){}

    // 月度目标分母：优先用 daily_reports.target_revenue 的整月 SUM。
    // （如果 target_revenue 在 daily_reports 里存的是“日目标”，那么 SUM 才是月目标。）
    try {
      const bR = await query(
        `SELECT COALESCE(SUM(target_revenue),0) AS b
         FROM daily_reports
         WHERE lower(regexp_replace(coalesce(store,''),'\\s+','','g')) LIKE $1
           AND date>= $2 AND date<= $3`,
        [sl, monthStart, monthEnd]
      );
      mBudget = parseFloat(bR.rows?.[0]?.b || 0) || 0;
    } catch(_e) {}

    if (!mBudget) {
      try {
        const bR = await query(
          `SELECT COALESCE(MAX(budget),0) AS b
           FROM daily_reports
           WHERE lower(regexp_replace(coalesce(store,''),'\\s+','','g')) LIKE $1
             AND date>= $2 AND date<= $3`,
          [sl, monthStart, monthEnd]
        );
        mBudget = parseFloat(bR.rows?.[0]?.b || 0) || 0;
      } catch(_e) {}
    }

    // 实收达成率分母：优先 revenue_targets 月目标；否则 daily_reports 整月日目标加总（可能仅部分日期有行，会偏小）
    let achievementDenominator = configMonthTarget > 0 ? configMonthTarget : mBudget;

    if (rows.length <= 2) {
      const row = rows[0];
      const aRev = parseFloat(row.actual_revenue)||0;
      const pDis = parseFloat(row.pre_discount_revenue)||0;
      const tDis = parseFloat(row.total_discount)||0;
      if (!mBudget) mBudget = parseFloat(row.budget)||0;
      achievementDenominator = configMonthTarget > 0 ? configMonthTarget : mBudget;
      const lines = [];
      if (stalenessBanner) lines.push(stalenessBanner);
      lines.push(`📊 **营收分析 | ${s}**`, `📅 ${p.label}`, '─────────────────────');
      lines.push(`💰 **实收营业额**: ¥${aRev.toLocaleString('zh-CN',{minimumFractionDigits:2,maximumFractionDigits:2})}（已扣优惠）`);
      if (pDis>0) lines.push(`💳 **折前营业额**: ¥${pDis.toLocaleString('zh-CN',{minimumFractionDigits:1,maximumFractionDigits:1})}`);
      if (tDis>0) lines.push(`🏷️ **总折扣金额**: ¥${tDis.toLocaleString('zh-CN',{minimumFractionDigits:2,maximumFractionDigits:2})}`);
      lines.push('─────────────────────','📈 **目标达成情况**');
      if (achievementDenominator>0) {
        const ar = (cumRev/achievementDenominator*100).toFixed(1), tr = (mDays/totalDays*100).toFixed(1);
        const an=parseFloat(ar), tn=parseFloat(tr);
        lines.push(`${an>=tn?'✅':an>=tn-5?'⚠️':'🔴'} **实收达成率**: ${ar}%（本月累计实收 ¥${cumRev.toLocaleString('zh-CN',{minimumFractionDigits:0})} / 本月实收目标 ¥${achievementDenominator.toLocaleString('zh-CN',{minimumFractionDigits:0})}）`);
        lines.push(`📐 **理论达成率**: ${tr}%（${mDays}/${totalDays}天）`);
        const gap = an-tn;
        lines.push(`${gap>=0?'🟢':'🔴'} **进度差值**: ${gap>=0?'+':''}${gap.toFixed(1)}%（${gap>=0?'超前':'落后'}目标进度）`);
      }
      lines.push('─────────────────────','🔍 **其他指标**');
      const mg = row.actual_margin!=null ? parseFloat(row.actual_margin) : null;
      lines.push(mg!=null&&!isNaN(mg) ? `📊 **毛利率**: ${mg.toFixed(1)}%` : `📊 **毛利率**: 暂无`);
      const dp = row.dianping_rating!=null ? parseFloat(row.dianping_rating) : null;
      if (dp!=null&&!isNaN(dp)) lines.push(`⭐ **大众点评**: ${dp.toFixed(2)} 分`);
      const ef = row.efficiency!=null ? parseFloat(row.efficiency) : null;
      const lb = row.labor_total!=null ? parseFloat(row.labor_total) : null;
      if (ef!=null&&!isNaN(ef)&&ef>0) {
        lines.push(`👥 **今日人效值**: ¥${Math.round(ef).toLocaleString('zh-CN')}${lb!=null&&!isNaN(lb)&&lb>0?`（出勤 ${lb.toFixed(0)} 工时）`:''}`);
      } else if (lb!=null&&!isNaN(lb)&&lb>0&&aRev>0) {
        lines.push(`👥 **今日人效值**: ¥${Math.round(aRev/lb).toLocaleString('zh-CN')}（出勤 ${lb.toFixed(0)} 工时）`);
      }
      const nw = row.new_wechat_members!=null ? parseInt(row.new_wechat_members) : null;
      if (nw!=null&&!isNaN(nw)) lines.push(`📱 **新增企微会员**: ${nw}人`);
      const dineOrd = row.dine_orders!=null ? parseInt(row.dine_orders) : null;
      const delOrd = row.delivery_orders!=null ? parseInt(row.delivery_orders) : null;
      if (dineOrd!=null&&!isNaN(dineOrd)) lines.push(`🍽 **堂食单数**: ${dineOrd}`);
      if (delOrd!=null&&!isNaN(delOrd)) lines.push(`🛵 **外卖单数**: ${delOrd}`);
      const bit = await fetchActualGrossMarginForStorePeriod(s, refMonth);
      if (bit) lines.push(...formatActualGrossMarginBitableLines(bit, refMonth));
      else if (mg == null || Number.isNaN(mg)) {
        lines.push('─────────────────────', '📗 **实际毛利率表**：本时段日报无毛利率字段，且未命中飞书同步行');
      }
      lines.push(...buildDailyReportSuggestionBlock({
        mBudget: achievementDenominator,
        cumRev,
        totalDays,
        mDays,
        actualMargin: mg ?? (bit?.actualReceivedMarginPct ?? bit?.preDiscountMarginPct),
        dineOrd,
        delOrd
      }));
      return lines.join('\n');
    }
    // Multi-day
    const totRev = rows.reduce((a,r2)=>a+(parseFloat(r2.actual_revenue)||0),0);
    const totPre = rows.reduce((a,r2)=>a+(parseFloat(r2.pre_discount_revenue)||0),0);
    const totDisc = rows.reduce((a,r2)=>a+(parseFloat(r2.total_discount)||0),0);
    const amArr = rows.filter(r2=>r2.actual_margin!=null);
    const amVal = amArr.length ? (amArr.reduce((a,r2)=>a+parseFloat(r2.actual_margin),0)/amArr.length).toFixed(1) : null;
    const dpR = rows.filter(r2=>r2.dianping_rating!=null);
    const avgDp = dpR.length ? (dpR.reduce((a,r2)=>a+parseFloat(r2.dianping_rating),0)/dpR.length).toFixed(2) : null;
    const lines = [];
    if (stalenessBanner) lines.push(stalenessBanner);
    lines.push(`📊 **营收分析 | ${s}**`, `📅 ${p.label}`, '─────────────────────');
    lines.push(`💰 **实收营业额**: ¥${totRev.toLocaleString('zh-CN',{minimumFractionDigits:0})}（${rows.length}天合计）`);
    if (totPre>0) lines.push(`💳 **折前营业额**: ¥${totPre.toLocaleString('zh-CN',{minimumFractionDigits:0})}`);
    if (totDisc>0) lines.push(`🏷️ **总折扣金额**: ¥${totDisc.toLocaleString('zh-CN',{minimumFractionDigits:0})}`);
    lines.push(`📆 **日均实收**: ¥${Math.round(totRev/rows.length).toLocaleString('zh-CN')}`);
    lines.push('─────────────────────','📈 **目标达成情况**');
    if (achievementDenominator>0) {
      const ar=(cumRev/achievementDenominator*100).toFixed(1), tr=(mDays/totalDays*100).toFixed(1);
      const an=parseFloat(ar), tn=parseFloat(tr);
      lines.push(`${an>=tn?'✅':an>=tn-5?'⚠️':'🔴'} **实收达成率**: ${ar}%（本月累计实收 ¥${cumRev.toLocaleString('zh-CN',{minimumFractionDigits:0})} / 本月实收目标 ¥${achievementDenominator.toLocaleString('zh-CN',{minimumFractionDigits:0})}）`);
      lines.push(`📐 **理论达成率**: ${tr}%（${mDays}/${totalDays}天）`);
    }
    if (amVal) lines.push(`📊 **平均毛利率**: ${amVal}%`);
    if (avgDp) lines.push(`⭐ **大众点评均分**: ${avgDp}`);
    const totLabor = rows.reduce((a,r2)=>a+(parseFloat(r2.labor_total)||0),0);
    if (totLabor>0&&totRev>0) lines.push(`👥 **累计人效值**: ¥${Math.round(totRev/totLabor).toLocaleString('zh-CN')}（累计 ${totLabor.toFixed(0)} 工时）`);
    const totWechat = rows.reduce((a,r2)=>a+(parseInt(r2.new_wechat_members)||0),0);
    if (totWechat>0) lines.push(`📱 **新增企微会员**: ${totWechat}人`);
    const lastRow = rows[0] || {};
    const dineL = lastRow.dine_orders != null ? parseInt(lastRow.dine_orders, 10) : null;
    const delL = lastRow.delivery_orders != null ? parseInt(lastRow.delivery_orders, 10) : null;
    const amForTip = amVal != null ? parseFloat(amVal) : (lastRow.actual_margin != null ? parseFloat(lastRow.actual_margin) : null);
    const bitMulti = await fetchActualGrossMarginForStorePeriod(s, refMonth);
    if (bitMulti) lines.push(...formatActualGrossMarginBitableLines(bitMulti, refMonth));
    else if (!amVal) lines.push('─────────────────────', '📗 **实际毛利率表**：未命中该月同步行（可核对飞书表中门店名与「毛利日期」月份）');
    lines.push(...buildDailyReportSuggestionBlock({
      mBudget: achievementDenominator,
      cumRev,
      totalDays,
      mDays,
      actualMargin: amForTip ?? (bitMulti?.actualReceivedMarginPct ?? bitMulti?.preDiscountMarginPct),
      dineOrd: dineL,
      delOrd: delL
    }));
    return lines.join('\n');
  } catch(e) { return `营收分析查询失败：${e?.message||'未知错误'}`; }
}

// ── 9. Sales Top (销售排行) ──────────────────────────

async function buildSalesTopReply(store, text) {
  const q = String(text||'').trim(), s = String(store||'').trim();
  if (!s) return '';
  if (/(投诉|差评|负评|客诉)/.test(q)) return '';
  if (!/(热销|畅销|top|TOP|销量|卖得|卖的|销售明细|销售排行|销售排名|卖得最好|卖得最差|最好.*(产品|菜品)|最差.*(产品|菜品)|前\d+|后\d+|外卖.*最差|外卖.*最好)/.test(q)) return '';
  const p = resolveDateRange(q, 30);
  const resolvedStore = await resolveDbStoreName('sales_raw', s);
  let bizSql = '';
  if (/(外卖|delivery)/i.test(q)) bizSql = ` AND lower(regexp_replace(COALESCE(s.biz_type,''),'\\s+','','g')) IN ('takeaway','delivery','外卖','外送')`;
  else if (/(堂食|dinein|店内)/i.test(q)) bizSql = ` AND lower(regexp_replace(COALESCE(s.biz_type,''),'\\s+','','g')) IN ('dinein','堂食','店内','堂食点餐')`;
  const limMatch = q.match(/(top|TOP|前)\s*(\d{1,2})/);
  const limit = Math.max(1, Math.min(20, Number(limMatch?.[2]||10)||10));
  const worst = /(最差|最不好卖|倒数|垫底|卖不动|后\d+)/.test(q);
  const sort = worst ? 'ASC' : 'DESC';
  try {
    const r = await query(
      `SELECT s.dish_name, ROUND(SUM(COALESCE(s.qty,0))::numeric,2) AS tq,
              ROUND(SUM(COALESCE(s.sales_amount,0))::numeric,2) AS ts,
              ROUND(SUM(COALESCE(s.revenue,0))::numeric,2) AS tr
       FROM sales_raw s WHERE lower(regexp_replace(COALESCE(s.store,''),'\\s+','','g'))=$1
         AND s.date BETWEEN $2 AND $3 ${bizSql} AND COALESCE(s.dish_name,'')<>''
       GROUP BY s.dish_name HAVING SUM(COALESCE(s.qty,0))>0
       ORDER BY SUM(COALESCE(s.sales_amount,0)) ${sort} LIMIT ${limit}`,
      [storeKey(resolvedStore), p.start, p.end]);
    const rows = r.rows||[];
    if (!rows.length) return `📦 ${p.label}销售数据（${s}）：暂无可用销售明细数据。`;
    const title = worst ? `销售倒数${limit}` : `销售TOP${limit}`;
    const lines = [`📦 ${title}（${s}·${p.label}）`];
    rows.forEach((x,i) => lines.push(`${i+1}. ${x.dish_name}｜折前¥${Number(x.ts||0).toFixed(0)}｜实收¥${Number(x.tr||0).toFixed(0)}｜销量${Number(x.tq||0).toFixed(0)}份`));
    lines.push('> 数据源：sales_raw（门店销售明细）');
    return lines.join('\n');
  } catch(e) { return `销售排行查询失败：${e?.message||'未知错误'}`; }
}

// ── 10. Loss Report (报损) ─────────────────────────────

async function buildLossReportReply(store, text) {
  const q = String(text||'').trim(), s = String(store||'').trim();
  if (!s) return '';
  if (!/(报损|损耗|废弃|丢弃|浪费|loss)/.test(q)) return '';
  const p = resolveDateRange(q, 7);
  try {
    const r = await query(`SELECT fields, created_at FROM feishu_generic_records WHERE config_key='loss_report' ORDER BY updated_at DESC LIMIT 3000`);
    const all = (r.rows||[]).map(row => ({ f: row.fields && typeof row.fields==='object' ? row.fields : {}, ca: row.created_at }));
    const matched = all.filter(x => sameStore(ext(x.f['所属门店']||x.f['门店']), s));
    const rows = matched.filter(x => {
      const d = bitableDate(x.f['日期'], x.ca);
      return d && inRange(d, p.start, p.end);
    });
    if (!rows.length) return `📦 ${p.label}报损记录（${s}）：暂无报损数据。`;
    const dishMap = new Map(), deptMap = new Map(), reasonMap = new Map();
    let totalQty = 0;
    for (const x of rows) {
      const dish = ext(x.f['报损菜品']); 
      const qty = parseFloat(ext(x.f['报损数量'])) || 1;
      const dept = ext(x.f['报损部门']);
      const reason = ext(x.f['报损原因']);
      if (dish) dishMap.set(dish, (dishMap.get(dish)||0) + qty);
      if (dept) deptMap.set(dept, (deptMap.get(dept)||0) + 1);
      if (reason) reasonMap.set(reason, (reasonMap.get(reason)||0) + 1);
      totalQty += qty;
    }
    const dishSorted = topN(dishMap, 10);
    const lines = [`📦 报损记录（${s}·${p.label}）`, `- 报损记录：${rows.length}条`, `- 报损总数量：${totalQty}`];
    if (deptMap.size) lines.push(`- 报损部门：${topN(deptMap,5).map(([k,v])=>`${k}(${v}次)`).join('、')}`);
    if (dishSorted.length) {
      lines.push('','🍽 报损产品明细：');
      dishSorted.forEach(([dish, qty], i) => {
        const reasons = [];
        for (const x of rows) {
          if (ext(x.f['报损菜品']) === dish) {
            const r2 = ext(x.f['报损原因']);
            if (r2) reasons.push(r2);
          }
        }
        const uniqueReasons = [...new Set(reasons)].slice(0, 2);
        lines.push(`${i+1}. ${dish}（${qty}${uniqueReasons.length ? '，原因：'+uniqueReasons.join('、') : ''}）`);
      });
    }
    if (reasonMap.size) {
      lines.push('','📋 报损原因汇总：');
      topN(reasonMap, 5).forEach(([r2,c], i) => lines.push(`${i+1}. ${r2}（${c}次）`));
    }
    return lines.join('\n');
  } catch(e) { return `报损数据查询失败：${e?.message||'未知错误'}`; }
}

// ── 11. Sales Analysis (销售分析+高峰期) ──────────────

async function buildSalesAnalysisReply(store, text) {
  const q = String(text||'').trim(), s = String(store||'').trim();
  if (!s) return '';
  if (!/(什么.*卖.*好|什么.*卖.*差|高峰|几点.*忙|几点.*多|堂食.*产品|外卖.*产品|产品.*销售|销售.*分析|卖.*最好|卖.*最差)/.test(q)) return '';
  const p = resolveDateRange(q, 7);
  const resolvedStore = await resolveDbStoreName('sales_raw', s);
  const sk = storeKey(resolvedStore);
  try {
    // Determine biz type filter
    let bizFilter = '';
    let bizLabel = '全渠道';
    if (/(外卖|delivery)/i.test(q)) { bizFilter = ` AND lower(regexp_replace(COALESCE(s.biz_type,''),'\\s+','','g')) IN ('takeaway','delivery','外卖','外送')`; bizLabel = '外卖'; }
    else if (/(堂食|dinein|店内)/i.test(q)) { bizFilter = ` AND lower(regexp_replace(COALESCE(s.biz_type,''),'\\s+','','g')) IN ('dinein','堂食','店内','堂食点餐')`; bizLabel = '堂食'; }

    // Top products
    const topR = await query(
      `SELECT s.dish_name, ROUND(SUM(COALESCE(s.qty,0))::numeric,2) AS tq,
              ROUND(SUM(COALESCE(s.sales_amount,0))::numeric,2) AS ts
       FROM sales_raw s WHERE lower(regexp_replace(COALESCE(s.store,''),'\\s+','','g'))=$1
         AND s.date BETWEEN $2 AND $3 ${bizFilter} AND COALESCE(s.dish_name,'')<>''
       GROUP BY s.dish_name HAVING SUM(COALESCE(s.qty,0))>0
       ORDER BY SUM(COALESCE(s.sales_amount,0)) DESC LIMIT 10`,
      [sk, p.start, p.end]);
    const botR = await query(
      `SELECT s.dish_name, ROUND(SUM(COALESCE(s.qty,0))::numeric,2) AS tq,
              ROUND(SUM(COALESCE(s.sales_amount,0))::numeric,2) AS ts
       FROM sales_raw s WHERE lower(regexp_replace(COALESCE(s.store,''),'\\s+','','g'))=$1
         AND s.date BETWEEN $2 AND $3 ${bizFilter} AND COALESCE(s.dish_name,'')<>''
       GROUP BY s.dish_name HAVING SUM(COALESCE(s.qty,0))>0
       ORDER BY SUM(COALESCE(s.sales_amount,0)) ASC LIMIT 5`,
      [sk, p.start, p.end]);

    // Peak hours
    const peakR = await query(
      `SELECT EXTRACT(HOUR FROM s.order_time::time) AS hr, COUNT(*) AS cnt,
              ROUND(SUM(COALESCE(s.revenue,0))::numeric,2) AS rev
       FROM sales_raw s WHERE lower(regexp_replace(COALESCE(s.store,''),'\\s+','','g'))=$1
         AND s.date BETWEEN $2 AND $3 ${bizFilter} AND s.order_time IS NOT NULL
       GROUP BY hr ORDER BY cnt DESC LIMIT 5`,
      [sk, p.start, p.end]);

    const topRows = topR.rows||[], botRows = botR.rows||[], peakRows = peakR.rows||[];
    if (!topRows.length && !peakRows.length) return '';

    const lines = [`📊 ${bizLabel}销售分析（${s}·${p.label}）`];
    if (topRows.length) {
      lines.push('','🔥 **畅销产品TOP10**：');
      topRows.forEach((x,i) => lines.push(`${i+1}. ${x.dish_name}｜¥${Number(x.ts||0).toFixed(0)}｜${Number(x.tq||0).toFixed(0)}份`));
    }
    if (botRows.length) {
      lines.push('','📉 **滞销产品TOP5**：');
      botRows.forEach((x,i) => lines.push(`${i+1}. ${x.dish_name}｜¥${Number(x.ts||0).toFixed(0)}｜${Number(x.tq||0).toFixed(0)}份`));
    }
    if (peakRows.length) {
      lines.push('','⏰ **高峰时段**：');
      peakRows.forEach((x) => {
        const h = parseInt(x.hr);
        lines.push(`- ${h}:00-${h+1}:00｜${x.cnt}笔｜¥${Number(x.rev||0).toFixed(0)}`);
      });
    }
    return lines.join('\n');
  } catch(e) { return `销售分析查询失败：${e?.message||'未知错误'}`; }
}

// ── 待办任务（按当前用户过滤，避免出品经理看到店长专属 BI 任务等）────────────────

function isLikelyLegacyTestMasterTask(row) {
  const blob = `${row.title || ''} ${row.detail || ''} ${row.category || ''}`;
  return /测试\s*112233|112233\s*检查|agent[\s_-]*v1/i.test(blob);
}

function masterTaskStatusZh(s) {
  const x = String(s || '');
  if (x === 'pending_response') return '待回复';
  if (x === 'pending_review') return '待审核';
  if (x === 'pending_dispatch') return '待派发';
  if (x === 'pending_audit') return '待稽核';
  return x || '进行中';
}

/** master_tasks 时间戳 → 上海日历 yyyy-mm-dd（便于回答「几月几号派的」） */
function fmtShanghaiYmdFromTaskTs(v) {
  if (v == null) return '—';
  const d = v instanceof Date ? v : new Date(v);
  if (Number.isNaN(d.getTime())) return String(v).slice(0, 10);
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(d);
}

async function buildPendingTasksReply(q, ctx) {
  if (!/(待办|我的任务|查看待办|未完成.*任务|任务列表)/.test(String(q || ''))) return '';
  const store = String(ctx.store || '').trim();
  const username = String(ctx.username || '').trim();
  const role = String(ctx.role || '').trim();
  if (!store || store === '总部') {
    return '当前未绑定具体经营门店，无法列出待办。请确认人事系统中的门店后再试。';
  }
  const pats = feishuStoreSearchPatterns(store);
  const hq = role === 'admin' || role === 'hq_manager';
  let r;
  try {
    if (hq) {
      r = await query(
        `SELECT task_id, title, status, assignee_username, assignee_role, source, category, timeout_at, dispatched_at, created_at
         FROM master_tasks
         WHERE store ILIKE ANY($1::text[])
           AND status NOT IN ('closed','settled','resolved','cancelled')
         ORDER BY dispatched_at DESC NULLS LAST, created_at DESC
         LIMIT 30`,
        [pats]
      );
    } else if (username || role) {
      r = await query(
        `SELECT task_id, title, status, assignee_username, assignee_role, source, category, timeout_at, dispatched_at, created_at
         FROM master_tasks
         WHERE store ILIKE ANY($1::text[])
           AND status NOT IN ('closed','settled','resolved','cancelled')
           AND (
             (COALESCE(TRIM(assignee_username),'') <> '' AND LOWER(assignee_username) = LOWER($2))
             OR (COALESCE(TRIM(assignee_username),'') = '' AND $3 <> '' AND assignee_role = $3)
           )
         ORDER BY dispatched_at DESC NULLS LAST, created_at DESC
         LIMIT 30`,
        [pats, username, role]
      );
    } else {
      return '无法识别当前登录账号，请完成员工绑定后再查看待办。';
    }
  } catch (e) {
    logger.warn({ err: e?.message, store }, 'buildPendingTasksReply query failed');
    return '待办任务查询暂时失败，请稍后重试或联系管理员。';
  }
  const rows = (r.rows || []).filter((row) => !isLikelyLegacyTestMasterTask(row));
  const lines = [`**【${store}】与您相关的待办任务**`, ''];
  if (!rows.length) {
    lines.push('✅ 暂无未闭环任务（已排除常见测试编号类残留项）。');
    lines.push('');
    lines.push(
      '_若您认为仍有任务未显示：可能责任人写的是其他同事账号，或任务已关闭。总部账号可查看本店全部待办。_'
    );
    return lines.join('\n');
  }
  rows.forEach((t, i) => {
    const deadline = t.timeout_at ? String(t.timeout_at).slice(0, 16).replace('T', ' ') : '无';
    const who = t.assignee_username
      ? `${t.assignee_username}（${masterTaskStatusZh(t.status)}）`
      : `岗位：${t.assignee_role || '—'}（${masterTaskStatusZh(t.status)}）`;
    const sentDay = fmtShanghaiYmdFromTaskTs(t.dispatched_at || t.created_at);
    const cat = (t.category && String(t.category).trim()) || '—';
    lines.push(
      `${i + 1}. **${(t.title || '').slice(0, 80)}**｜${who}｜派发 ${sentDay}｜类型键 ${cat}｜截止 ${deadline}｜来源 ${t.source || '—'}`
    );
  });
  lines.push('');
  lines.push(
    '_说明：列表已按您的账号/岗位过滤。「派发」为上海日期（优先取 dispatched_at，否则 created_at）。来源 scheduled_inspection=曾保存过的「每日巡检」配置触发；random_inspection=随机抽检；auto_collab=接受行动计划；bi_anomaly=BI 异常。后台删掉巡检配置不会删除库里已生成的任务。_'
  );
  return lines.join('\n');
}

// ── Main Dispatcher ──────────────────────────────────

export async function tryDeterministicReply(text, ctx) {
  const q = String(text||'').trim();
  if (!q) return '';
  // 管线判定为「策略生成」：不走确定性片段，交给 marketing_planner
  if (ctx?.forceStrategy === true) return '';
  // 营销/活动/方案类问题必须走 marketing_planner，禁止被「营收分析」确定性回复抢先返回
  if (isMarketingPlanningIntent(q)) return '';
  const store = await pickStoreFromQuestionText(q, ctx.store || '');
  try {
    // Identity
    let reply = await buildIdentityReply(q, ctx);
    if (reply) return reply;
    let pending = await buildPendingTasksReply(q, ctx);
    if (pending) return pending;
    // Table visit
    reply = await buildTableVisitReply(store, q);
    if (reply) return reply;
    // Bad review
    reply = await buildBadReviewReply(store, q);
    if (reply) return reply;
    // Closing report
    reply = await buildClosingReportReply(store, q);
    if (reply) return reply;
    // Opening report
    reply = await buildOpeningReportReply(store, q);
    if (reply) return reply;
    // Meeting report
    reply = await buildMeetingReportReply(store, q);
    if (reply) return reply;
    // Material report
    reply = await buildMaterialReportReply(store, q);
    if (reply) return reply;
    // Loss report
    reply = await buildLossReportReply(store, q);
    if (reply) return reply;
    // Sales analysis (产品销售+高峰期)
    reply = await buildSalesAnalysisReply(store, q);
    if (reply) return reply;
    // Daily report (revenue)
    reply = await buildDailyReportReply(store, q, ctx);
    if (reply) return reply;
    // Sales top
    reply = await buildSalesTopReply(store, q);
    if (reply) return reply;
  } catch(e) {
    logger.error({ err: e?.message }, 'deterministic reply error');
  }
  return '';
}
