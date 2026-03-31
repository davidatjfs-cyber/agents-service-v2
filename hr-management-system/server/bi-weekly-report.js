let _pool = null;
export function setReportPool(p) { _pool = p; }
function pool() { if (!_pool) throw new Error('bi-weekly-report: pool not set'); return _pool; }

const EXCLUDE_DISHES_EXACT = [
  '打包盒','打包袋','餐具费','米饭','白米饭','赠品','饮品','赠品生日面',
  '咸蛋','烧鹅头','烧鸭头','咖喱鱼蛋','鹅颈',
  '腊味煲仔饭','肉饼蒸膏蟹','白灼基围虾','汤圆','赠-桂花姜汤番薯糖水',
  '莲藕发菜猪手','北菇扒菜胆','清蒸老虎斑','点评抽奖-港式柠檬茶（冰）','五指毛桃炖老鸡'
];
const EXCLUDE_DISH_PATTERNS = ['赠', '饮品', '饮料', '点评抽奖'];
const WEEKDAY_CN = {1:"周一",2:"周二",3:"周三",4:"周四",5:"周五",6:"周六",7:"周日"};
const BIZ_TYPES = ['dinein', 'takeaway'];
const BIZ_CN = { dinein: '堂食', takeaway: '外卖' };
const SLOT_TYPES = ['lunch', 'afternoon', 'dinner'];
const SLOT_CN = { lunch: '午市', afternoon: '下午茶', dinner: '晚市', other: '其他时段' };

// 门店级配置：哪些门店没有外卖业务
const STORE_NO_TAKEAWAY = new Set(['洪潮大宁久光店']);

const BIZ_NORMALIZE_SQL = `
  CASE
    WHEN lower(regexp_replace(COALESCE(s.biz_type, ''), '\\s+', '', 'g')) IN ('takeaway','delivery','外卖','外送') THEN 'takeaway'
    WHEN lower(regexp_replace(COALESCE(s.biz_type, ''), '\\s+', '', 'g')) IN ('dinein','堂食','店内','堂食点餐') THEN 'dinein'
    ELSE lower(regexp_replace(COALESCE(s.biz_type, ''), '\\s+', '', 'g'))
  END
`;

const COST_COVERAGE_WARN_THRESHOLD_PCT = 90;
const COST_COVERAGE_GOOD_THRESHOLD_PCT = 95;

const BIZ_PRIORITY_SQL = (bizExpr, targetBizExpr) => `
  CASE
    WHEN lower(regexp_replace(COALESCE(${bizExpr}, ''), '\\s+', '', 'g')) IN ('takeaway','delivery','外卖','外送') AND ${targetBizExpr} = 'takeaway' THEN 0
    WHEN lower(regexp_replace(COALESCE(${bizExpr}, ''), '\\s+', '', 'g')) IN ('dinein','堂食','店内','堂食点餐') AND ${targetBizExpr} = 'dinein' THEN 0
    WHEN COALESCE(NULLIF(trim(${bizExpr}), ''), '*') IN ('*', 'all', 'ALL', '全部', '通用') THEN 1
    ELSE 2
  END
`;

const BIZ_MATCH_WHERE_SQL = (bizExpr, targetBizExpr) => `
  (
    (lower(regexp_replace(COALESCE(${bizExpr}, ''), '\\s+', '', 'g')) IN ('takeaway','delivery','外卖','外送') AND ${targetBizExpr} = 'takeaway')
    OR (lower(regexp_replace(COALESCE(${bizExpr}, ''), '\\s+', '', 'g')) IN ('dinein','堂食','店内','堂食点餐') AND ${targetBizExpr} = 'dinein')
    OR COALESCE(NULLIF(trim(${bizExpr}), ''), '*') IN ('*', 'all', 'ALL', '全部', '通用')
  )
`;

const DISH_NAME_NORMALIZE_SQL = (expr) => `
  lower(
    regexp_replace(
      regexp_replace(
        regexp_replace(
          translate(
            COALESCE(${expr}, ''),
            '魚雞鴨鵝雜滷燒湯飯麵餅凍鮮廣銷順蔥薑蝦蠔鍋鑊龍條頭頸腩風號東0123456789',
            '鱼鸡鸭鹅杂卤烧汤饭面饼冻鲜广销顺葱姜虾蚝锅镬龙条头颈腩风号东零一二三四五六七八九'
          ),
          '【[^】]*】|（[^）]*）|\\([^)]*\\)|\\[[^\\]]*\\]',
          '',
          'g'
        ),
        '[\\s_/+·,，。、“”‘’!！?？:：;；''"~～()（）\\[\\]【】-]',
        '',
        'g'
      ),
      '\\s+',
      '',
      'g'
    )
  )
`;

const SLOT_NORMALIZE_SQL = `
  CASE
    WHEN lower(regexp_replace(COALESCE(s.slot, ''), '\\s+', '', 'g')) IN ('lunch','午市','午餐') THEN 'lunch'
    WHEN lower(regexp_replace(COALESCE(s.slot, ''), '\\s+', '', 'g')) IN ('afternoon','afternoontea','下午茶') THEN 'afternoon'
    WHEN lower(regexp_replace(COALESCE(s.slot, ''), '\\s+', '', 'g')) IN ('dinner','晚市','晚餐') THEN 'dinner'
    ELSE 'other'
  END
`;

function toNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function pct(numerator, denominator) {
  if (!denominator) return null;
  return (numerator / denominator) * 100;
}

function fmtDate(d) {
  return new Date(d).toISOString().slice(0, 10);
}

function daysBetweenInclusive(start, end) {
  const a = new Date(start);
  const b = new Date(end);
  return Math.max(1, Math.round((b - a) / 86400000) + 1);
}

function shiftRangeBackward(start, end, days) {
  const ds = Math.max(1, Number(days) || 1);
  const s = new Date(start);
  const e = new Date(end);
  s.setDate(s.getDate() - ds);
  e.setDate(e.getDate() - ds);
  return { start: fmtDate(s), end: fmtDate(e) };
}

function normalizeDishName(v) {
  return String(v || '').replace(/\s+/g, '').trim();
}

/** 门店名归一（对齐洪湖/洪潮、空格差异等） */
function normStoreKey(s) {
  return String(s || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '');
}

/**
 * 将配置/展示用店名对齐到 sales_raw ∪ daily_reports 中的实际 store 字符串
 */
export async function resolveStoreKeyForReports(requested) {
  const want = String(requested || '').trim();
  const r = await pool().query(`
    SELECT store FROM (
      SELECT DISTINCT TRIM(store) AS store FROM sales_raw WHERE TRIM(COALESCE(store, '')) <> ''
      UNION
      SELECT DISTINCT TRIM(store) AS store FROM daily_reports WHERE TRIM(COALESCE(store, '')) <> ''
    ) u
    ORDER BY length(store), store
  `);
  const all = (r.rows || []).map((x) => String(x.store || '').trim()).filter(Boolean);
  const nk = normStoreKey(want);
  if (!want) {
    return { useStore: '', note: '未提供门店名称', candidates: all.slice(0, 40) };
  }
  const exact = all.find((s) => s === want);
  if (exact) return { useStore: exact, note: null, candidates: [exact] };
  const normHit = all.find((s) => normStoreKey(s) === nk);
  if (normHit) {
    return {
      useStore: normHit,
      note: `已将展示店名「${want}」与库中「${normHit}」对齐（空格/大小写等差异）。`,
      candidates: [normHit]
    };
  }
  const partial = all.filter(
    (s) => normStoreKey(s).includes(nk) || nk.includes(normStoreKey(s))
  );
  if (partial.length === 1) {
    return {
      useStore: partial[0],
      note: `已将「${want}」模糊对齐为库中「${partial[0]}」。`,
      candidates: partial
    };
  }
  if (partial.length > 1) {
    return {
      useStore: want,
      note:
        `**【需确认】**「${want}」在库中有多条相似店名，系统**未自动替换**，本期按原名查询（可能全空）。候选：${partial.slice(0, 10).join('、')}`,
      candidates: partial
    };
  }
  return {
    useStore: want,
    note:
      `**【需确认】** 在 sales_raw / daily_reports 中**未找到**与「${want}」匹配的店名。请核对上传销售与营业日报中的门店字段。库中店名示例：${all.slice(0, 18).join('、')}${all.length > 18 ? '…' : ''}`,
    candidates: all.slice(0, 40)
  };
}

function shouldExcludeDish(name = '') {
  const normalized = normalizeDishName(name);
  if (!normalized) return true;
  if (EXCLUDE_DISHES_EXACT.map(normalizeDishName).includes(normalized)) return true;
  return EXCLUDE_DISH_PATTERNS.some((k) => normalized.includes(normalizeDishName(k)));
}

function wow(curr, prev) {
  if (!Number.isFinite(curr) || !Number.isFinite(prev) || prev === 0) return null;
  return ((curr - prev) / Math.abs(prev)) * 100;
}

function buildAnalysisSummary(report) {
  const m = report?.sections?.theoreticalMargins || {};
  const totals = m.totals || {};
  const wowSec = report?.sections?.wow || {};
  const dinein = report?.sections?.ranking_dinein || {};
  const takeaway = report?.sections?.ranking_takeaway || {};
  const takeTop = takeaway?.top10?.[0];
  const dineTop = dinein?.top10?.[0];
  const insights = [];

  const netMargin = Number(m.totalNetMarginPct);
  if (Number.isFinite(netMargin)) {
    if (netMargin >= 60) insights.push('整体实收毛利率维持高位，成本控制表现稳定。');
    else if (netMargin >= 45) insights.push('整体实收毛利率处于健康区间，可继续优化高折扣品类。');
    else insights.push('整体实收毛利率偏低，建议排查高成本/低毛利菜品与异常折扣。');
  }

  const discountRatio = pct(toNum(totals.total?.discount), toNum(totals.total?.sales));
  if (discountRatio !== null) {
    if (discountRatio >= 20) insights.push(`折扣率约 ${discountRatio.toFixed(1)}%，偏高，建议复核促销策略与核销口径。`);
    else insights.push(`折扣率约 ${discountRatio.toFixed(1)}%，整体在可控范围。`);
  }

  const revWow = wowSec.revenueWowPct;
  if (revWow !== null && revWow !== undefined) {
    if (revWow >= 5) insights.push(`实收营收环比增长 ${Math.abs(revWow).toFixed(1)}%，增长动能良好。`);
    else if (revWow <= -5) insights.push(`实收营收环比下降 ${Math.abs(revWow).toFixed(1)}%，建议重点复盘低峰时段与低销菜品。`);
    else insights.push('实收营收环比基本持平，建议通过菜品结构优化提升增长弹性。');
  }

  if (takeTop?.dish_name) {
    insights.push(`外卖主力单品为「${takeTop.dish_name}」，可考虑作为线上流量锚点持续运营。`);
  }
  if (dineTop?.dish_name) {
    insights.push(`堂食主力单品为「${dineTop.dish_name}」，建议联动套餐或加价购提升客单。`);
  }

  return insights.slice(0, 6);
}

/** 与 generatePeriodReport 相同 SQL 口径：sales_raw + 别名 + dish_library_costs，仅统计命中成本的行。 */
export async function queryMarginByBiz(store, startDate, endDate) {
  const rows = await pool().query(`
    WITH sales AS (
      SELECT
        s.store,
        ${BIZ_NORMALIZE_SQL} AS biz_type,
        s.dish_name,
        SUM(COALESCE(s.qty, 0)) AS qty,
        SUM(COALESCE(s.sales_amount, 0)) AS sales_amount,
        SUM(COALESCE(s.revenue, 0)) AS revenue,
        SUM(COALESCE(s.discount, 0)) AS recorded_discount,
        SUM(GREATEST(COALESCE(s.sales_amount, 0) - COALESCE(s.revenue, 0), 0)) AS derived_discount
      FROM sales_raw s
      WHERE s.store = $1
        AND s.date BETWEEN $2 AND $3
      GROUP BY s.store, s.biz_type, s.dish_name
    ), resolved AS (
      SELECT
        x.*,
        COALESCE(a.canonical_name, x.dish_name) AS resolved_dish_name
      FROM sales x
      LEFT JOIN LATERAL (
        SELECT da.canonical_name
        FROM dish_name_aliases da
        WHERE da.enabled = TRUE
          AND ${DISH_NAME_NORMALIZE_SQL('da.alias_name')} = ${DISH_NAME_NORMALIZE_SQL('x.dish_name')}
          AND (
            lower(regexp_replace(COALESCE(da.store, '*'), '\\s+', '', 'g')) = lower(regexp_replace(COALESCE(x.store, ''), '\\s+', '', 'g'))
            OR COALESCE(NULLIF(trim(da.store), ''), '*') = '*'
          )
          AND ${BIZ_MATCH_WHERE_SQL('da.biz_type', 'x.biz_type')}
        ORDER BY
          ${BIZ_PRIORITY_SQL('da.biz_type', 'x.biz_type')},
          CASE WHEN COALESCE(NULLIF(trim(da.store), ''), '*') = '*' THEN 2 ELSE 1 END,
          da.updated_at DESC
        LIMIT 1
      ) a ON TRUE
    ), priced AS (
      SELECT
        x.biz_type,
        x.sales_amount,
        x.revenue,
        x.recorded_discount,
        x.derived_discount,
        x.qty,
        c.unit_cost AS matched_unit_cost,
        COALESCE(c.unit_cost, 0) AS unit_cost
      FROM resolved x
      LEFT JOIN LATERAL (
        SELECT dlc.unit_cost
        FROM dish_library_costs dlc
        WHERE dlc.enabled = TRUE
          AND ${DISH_NAME_NORMALIZE_SQL('dlc.dish_name')} = ${DISH_NAME_NORMALIZE_SQL('x.resolved_dish_name')}
          AND (
            lower(regexp_replace(COALESCE(dlc.store, '*'), '\\s+', '', 'g')) = lower(regexp_replace(COALESCE(x.store, ''), '\\s+', '', 'g'))
            OR COALESCE(NULLIF(trim(dlc.store), ''), '*') = '*'
          )
          AND ${BIZ_MATCH_WHERE_SQL('dlc.biz_type', 'x.biz_type')}
        ORDER BY
          ${BIZ_PRIORITY_SQL('dlc.biz_type', 'x.biz_type')},
          CASE WHEN COALESCE(NULLIF(trim(dlc.store), ''), '*') = '*' THEN 2 ELSE 1 END,
          dlc.updated_at DESC
        LIMIT 1
      ) c ON TRUE
    )
    SELECT
      biz_type,
      ROUND(SUM(CASE WHEN matched_unit_cost IS NOT NULL THEN sales_amount ELSE 0 END)::numeric, 2) AS total_sales_amount,
      ROUND(SUM(CASE WHEN matched_unit_cost IS NOT NULL THEN revenue ELSE 0 END)::numeric, 2) AS total_revenue,
      ROUND(SUM(CASE WHEN matched_unit_cost IS NOT NULL THEN recorded_discount ELSE 0 END)::numeric, 2) AS total_discount_recorded,
      ROUND(SUM(CASE WHEN matched_unit_cost IS NOT NULL THEN derived_discount ELSE 0 END)::numeric, 2) AS total_discount_derived,
      ROUND(SUM(CASE WHEN matched_unit_cost IS NOT NULL THEN qty * unit_cost ELSE 0 END)::numeric, 2) AS total_cost
    FROM priced
    GROUP BY biz_type
  `, [store, startDate, endDate]);

  const byBiz = {
    dinein: { sales: 0, revenue: 0, cost: 0, discount: 0, discountRecorded: 0 },
    takeaway: { sales: 0, revenue: 0, cost: 0, discount: 0, discountRecorded: 0 }
  };
  for (const row of rows.rows || []) {
    const biz = String(row.biz_type || '').trim();
    if (!byBiz[biz]) continue;
    const sales = toNum(row.total_sales_amount);
    const revenue = toNum(row.total_revenue);
    const derivedDiscount = toNum(row.total_discount_derived);
    const recordedDiscount = toNum(row.total_discount_recorded);
    byBiz[biz] = {
      sales,
      revenue,
      cost: toNum(row.total_cost),
      discount: Math.max(derivedDiscount, recordedDiscount, Math.max(0, sales - revenue)),
      discountRecorded: recordedDiscount
    };
  }

  const total = {
    sales: byBiz.dinein.sales + byBiz.takeaway.sales,
    revenue: byBiz.dinein.revenue + byBiz.takeaway.revenue,
    cost: byBiz.dinein.cost + byBiz.takeaway.cost,
    discount: byBiz.dinein.discount + byBiz.takeaway.discount,
    discountRecorded: byBiz.dinein.discountRecorded + byBiz.takeaway.discountRecorded
  };

  return {
    byBiz,
    total,
    margins: {
      totalPreDiscountMarginPct: pct(total.sales - total.cost, total.sales),
      totalNetMarginPct: pct(total.revenue - total.cost, total.revenue),
      dineinPreDiscountMarginPct: pct(byBiz.dinein.sales - byBiz.dinein.cost, byBiz.dinein.sales),
      dineinNetMarginPct: pct(byBiz.dinein.revenue - byBiz.dinein.cost, byBiz.dinein.revenue),
      takeawayPreDiscountMarginPct: pct(byBiz.takeaway.sales - byBiz.takeaway.cost, byBiz.takeaway.sales),
      takeawayNetMarginPct: pct(byBiz.takeaway.revenue - byBiz.takeaway.cost, byBiz.takeaway.revenue)
    }
  };
}

async function queryMarginBySlot(store, startDate, endDate) {
  const rows = await pool().query(`
    WITH sales AS (
      SELECT
        s.store,
        ${SLOT_NORMALIZE_SQL} AS slot,
        ${BIZ_NORMALIZE_SQL} AS biz_type,
        s.dish_name,
        SUM(COALESCE(s.qty, 0)) AS qty,
        SUM(COALESCE(s.sales_amount, 0)) AS sales_amount,
        SUM(COALESCE(s.revenue, 0)) AS revenue,
        SUM(COALESCE(s.discount, 0)) AS recorded_discount,
        SUM(GREATEST(COALESCE(s.sales_amount, 0) - COALESCE(s.revenue, 0), 0)) AS derived_discount
      FROM sales_raw s
      WHERE s.store = $1
        AND s.date BETWEEN $2 AND $3
      GROUP BY s.store, slot, biz_type, s.dish_name
    ), resolved AS (
      SELECT
        x.*,
        COALESCE(a.canonical_name, x.dish_name) AS resolved_dish_name
      FROM sales x
      LEFT JOIN LATERAL (
        SELECT da.canonical_name
        FROM dish_name_aliases da
        WHERE da.enabled = TRUE
          AND ${DISH_NAME_NORMALIZE_SQL('da.alias_name')} = ${DISH_NAME_NORMALIZE_SQL('x.dish_name')}
          AND (
            lower(regexp_replace(COALESCE(da.store, '*'), '\\s+', '', 'g')) = lower(regexp_replace(COALESCE(x.store, ''), '\\s+', '', 'g'))
            OR COALESCE(NULLIF(trim(da.store), ''), '*') = '*'
          )
          AND ${BIZ_MATCH_WHERE_SQL('da.biz_type', 'x.biz_type')}
        ORDER BY
          ${BIZ_PRIORITY_SQL('da.biz_type', 'x.biz_type')},
          CASE WHEN COALESCE(NULLIF(trim(da.store), ''), '*') = '*' THEN 2 ELSE 1 END,
          da.updated_at DESC
        LIMIT 1
      ) a ON TRUE
    ), priced AS (
      SELECT
        x.slot,
        x.biz_type,
        x.sales_amount,
        x.revenue,
        x.recorded_discount,
        x.derived_discount,
        x.qty,
        c.unit_cost AS matched_unit_cost,
        COALESCE(c.unit_cost, 0) AS unit_cost
      FROM resolved x
      LEFT JOIN LATERAL (
        SELECT dlc.unit_cost
        FROM dish_library_costs dlc
        WHERE dlc.enabled = TRUE
          AND ${DISH_NAME_NORMALIZE_SQL('dlc.dish_name')} = ${DISH_NAME_NORMALIZE_SQL('x.resolved_dish_name')}
          AND (
            lower(regexp_replace(COALESCE(dlc.store, '*'), '\\s+', '', 'g')) = lower(regexp_replace(COALESCE(x.store, ''), '\\s+', '', 'g'))
            OR COALESCE(NULLIF(trim(dlc.store), ''), '*') = '*'
          )
          AND ${BIZ_MATCH_WHERE_SQL('dlc.biz_type', 'x.biz_type')}
        ORDER BY
          ${BIZ_PRIORITY_SQL('dlc.biz_type', 'x.biz_type')},
          CASE WHEN COALESCE(NULLIF(trim(dlc.store), ''), '*') = '*' THEN 2 ELSE 1 END,
          dlc.updated_at DESC
        LIMIT 1
      ) c ON TRUE
    )
    SELECT
      slot,
      biz_type,
      ROUND(SUM(CASE WHEN matched_unit_cost IS NOT NULL THEN sales_amount ELSE 0 END)::numeric, 2) AS total_sales_amount,
      ROUND(SUM(CASE WHEN matched_unit_cost IS NOT NULL THEN revenue ELSE 0 END)::numeric, 2) AS total_revenue,
      ROUND(SUM(CASE WHEN matched_unit_cost IS NOT NULL THEN recorded_discount ELSE 0 END)::numeric, 2) AS total_discount_recorded,
      ROUND(SUM(CASE WHEN matched_unit_cost IS NOT NULL THEN derived_discount ELSE 0 END)::numeric, 2) AS total_discount_derived,
      ROUND(SUM(CASE WHEN matched_unit_cost IS NOT NULL THEN qty * unit_cost ELSE 0 END)::numeric, 2) AS total_cost
    FROM priced
    GROUP BY slot, biz_type
  `, [store, startDate, endDate]);

  const bySlot = {};
  for (const slot of SLOT_TYPES) {
    bySlot[slot] = {
      total: { sales: 0, revenue: 0, cost: 0, discount: 0 },
      byBiz: {
        dinein: { sales: 0, revenue: 0, cost: 0, discount: 0 },
        takeaway: { sales: 0, revenue: 0, cost: 0, discount: 0 }
      },
      margins: { preDiscountMarginPct: null, netMarginPct: null }
    };
  }

  for (const row of rows.rows || []) {
    const slot = String(row.slot || '').trim();
    const biz = String(row.biz_type || '').trim();
    if (!bySlot[slot] || !bySlot[slot].byBiz[biz]) continue;
    const sales = toNum(row.total_sales_amount);
    const revenue = toNum(row.total_revenue);
    const derivedDiscount = toNum(row.total_discount_derived);
    const recordedDiscount = toNum(row.total_discount_recorded);
    const cost = toNum(row.total_cost);
    const discount = Math.max(derivedDiscount, recordedDiscount, Math.max(0, sales - revenue));

    bySlot[slot].byBiz[biz] = { sales, revenue, cost, discount };
    bySlot[slot].total.sales += sales;
    bySlot[slot].total.revenue += revenue;
    bySlot[slot].total.cost += cost;
    bySlot[slot].total.discount += discount;
  }

  for (const slot of SLOT_TYPES) {
    const t = bySlot[slot].total;
    bySlot[slot].margins = {
      preDiscountMarginPct: pct(t.sales - t.cost, t.sales),
      netMarginPct: pct(t.revenue - t.cost, t.revenue)
    };
  }

  return bySlot;
}

/** 折前/实收维度上「命中菜品成本库」的占比，用于数据审计门槛。 */
export async function queryCostCoverageDiagnostics(store, startDate, endDate, unmatchedLimit = 12) {
  const summary = await pool().query(`
    WITH sales AS (
      SELECT
        s.store,
        ${BIZ_NORMALIZE_SQL} AS biz_type,
        s.dish_name,
        SUM(COALESCE(s.qty, 0)) AS qty,
        SUM(COALESCE(s.sales_amount, 0)) AS sales_amount,
        SUM(COALESCE(s.revenue, 0)) AS revenue
      FROM sales_raw s
      WHERE s.store = $1
        AND s.date BETWEEN $2 AND $3
      GROUP BY s.store, s.biz_type, s.dish_name
    ), resolved AS (
      SELECT
        x.*,
        COALESCE(a.canonical_name, x.dish_name) AS resolved_dish_name
      FROM sales x
      LEFT JOIN LATERAL (
        SELECT da.canonical_name
        FROM dish_name_aliases da
        WHERE da.enabled = TRUE
          AND ${DISH_NAME_NORMALIZE_SQL('da.alias_name')} = ${DISH_NAME_NORMALIZE_SQL('x.dish_name')}
          AND (
            lower(regexp_replace(COALESCE(da.store, '*'), '\\s+', '', 'g')) = lower(regexp_replace(COALESCE(x.store, ''), '\\s+', '', 'g'))
            OR COALESCE(NULLIF(trim(da.store), ''), '*') = '*'
          )
          AND ${BIZ_MATCH_WHERE_SQL('da.biz_type', 'x.biz_type')}
        ORDER BY
          ${BIZ_PRIORITY_SQL('da.biz_type', 'x.biz_type')},
          CASE WHEN COALESCE(NULLIF(trim(da.store), ''), '*') = '*' THEN 2 ELSE 1 END,
          da.updated_at DESC
        LIMIT 1
      ) a ON TRUE
    ), priced AS (
      SELECT
        x.biz_type,
        x.dish_name,
        x.resolved_dish_name,
        x.qty,
        x.sales_amount,
        x.revenue,
        c.unit_cost
      FROM resolved x
      LEFT JOIN LATERAL (
        SELECT dlc.unit_cost
        FROM dish_library_costs dlc
        WHERE dlc.enabled = TRUE
          AND ${DISH_NAME_NORMALIZE_SQL('dlc.dish_name')} = ${DISH_NAME_NORMALIZE_SQL('x.resolved_dish_name')}
          AND (
            lower(regexp_replace(COALESCE(dlc.store, '*'), '\\s+', '', 'g')) = lower(regexp_replace(COALESCE(x.store, ''), '\\s+', '', 'g'))
            OR COALESCE(NULLIF(trim(dlc.store), ''), '*') = '*'
          )
          AND ${BIZ_MATCH_WHERE_SQL('dlc.biz_type', 'x.biz_type')}
        ORDER BY
          ${BIZ_PRIORITY_SQL('dlc.biz_type', 'x.biz_type')},
          CASE WHEN COALESCE(NULLIF(trim(dlc.store), ''), '*') = '*' THEN 2 ELSE 1 END,
          dlc.updated_at DESC
        LIMIT 1
      ) c ON TRUE
    )
    SELECT
      biz_type,
      ROUND(SUM(sales_amount)::numeric, 2) AS total_sales,
      ROUND(SUM(CASE WHEN unit_cost IS NOT NULL THEN sales_amount ELSE 0 END)::numeric, 2) AS covered_sales,
      ROUND(SUM(revenue)::numeric, 2) AS total_revenue,
      ROUND(SUM(CASE WHEN unit_cost IS NOT NULL THEN revenue ELSE 0 END)::numeric, 2) AS covered_revenue
    FROM priced
    GROUP BY biz_type
  `, [store, startDate, endDate]);

  const unmatched = await pool().query(`
    WITH sales AS (
      SELECT
        s.store,
        ${BIZ_NORMALIZE_SQL} AS biz_type,
        s.dish_name,
        SUM(COALESCE(s.qty, 0)) AS qty,
        SUM(COALESCE(s.sales_amount, 0)) AS sales_amount,
        SUM(COALESCE(s.revenue, 0)) AS revenue
      FROM sales_raw s
      WHERE s.store = $1
        AND s.date BETWEEN $2 AND $3
      GROUP BY s.store, s.biz_type, s.dish_name
    ), resolved AS (
      SELECT
        x.*,
        COALESCE(a.canonical_name, x.dish_name) AS resolved_dish_name
      FROM sales x
      LEFT JOIN LATERAL (
        SELECT da.canonical_name
        FROM dish_name_aliases da
        WHERE da.enabled = TRUE
          AND ${DISH_NAME_NORMALIZE_SQL('da.alias_name')} = ${DISH_NAME_NORMALIZE_SQL('x.dish_name')}
          AND (
            lower(regexp_replace(COALESCE(da.store, '*'), '\\s+', '', 'g')) = lower(regexp_replace(COALESCE(x.store, ''), '\\s+', '', 'g'))
            OR COALESCE(NULLIF(trim(da.store), ''), '*') = '*'
          )
          AND ${BIZ_MATCH_WHERE_SQL('da.biz_type', 'x.biz_type')}
        ORDER BY
          ${BIZ_PRIORITY_SQL('da.biz_type', 'x.biz_type')},
          CASE WHEN COALESCE(NULLIF(trim(da.store), ''), '*') = '*' THEN 2 ELSE 1 END,
          da.updated_at DESC
        LIMIT 1
      ) a ON TRUE
    ), priced AS (
      SELECT
        x.biz_type,
        x.dish_name,
        x.resolved_dish_name,
        x.qty,
        x.sales_amount,
        x.revenue,
        c.unit_cost
      FROM resolved x
      LEFT JOIN LATERAL (
        SELECT dlc.unit_cost
        FROM dish_library_costs dlc
        WHERE dlc.enabled = TRUE
          AND ${DISH_NAME_NORMALIZE_SQL('dlc.dish_name')} = ${DISH_NAME_NORMALIZE_SQL('x.resolved_dish_name')}
          AND (
            lower(regexp_replace(COALESCE(dlc.store, '*'), '\\s+', '', 'g')) = lower(regexp_replace(COALESCE(x.store, ''), '\\s+', '', 'g'))
            OR COALESCE(NULLIF(trim(dlc.store), ''), '*') = '*'
          )
          AND ${BIZ_MATCH_WHERE_SQL('dlc.biz_type', 'x.biz_type')}
        ORDER BY
          ${BIZ_PRIORITY_SQL('dlc.biz_type', 'x.biz_type')},
          CASE WHEN COALESCE(NULLIF(trim(dlc.store), ''), '*') = '*' THEN 2 ELSE 1 END,
          dlc.updated_at DESC
        LIMIT 1
      ) c ON TRUE
    )
    SELECT
      biz_type,
      dish_name,
      resolved_dish_name,
      ROUND(SUM(sales_amount)::numeric, 2) AS sales,
      ROUND(SUM(revenue)::numeric, 2) AS revenue,
      ROUND(SUM(qty)::numeric, 2) AS qty
    FROM priced
    WHERE unit_cost IS NULL
    GROUP BY biz_type, dish_name, resolved_dish_name
    ORDER BY SUM(sales_amount) DESC
    LIMIT $4
  `, [store, startDate, endDate, Math.max(1, Math.min(30, Number(unmatchedLimit) || 12))]);

  const byBiz = {
    dinein: { totalSales: 0, coveredSales: 0, totalRevenue: 0, coveredRevenue: 0, salesCoveragePct: null, revenueCoveragePct: null },
    takeaway: { totalSales: 0, coveredSales: 0, totalRevenue: 0, coveredRevenue: 0, salesCoveragePct: null, revenueCoveragePct: null }
  };

  for (const row of summary.rows || []) {
    const biz = String(row.biz_type || '').trim();
    if (!byBiz[biz]) continue;
    const totalSales = toNum(row.total_sales);
    const coveredSales = toNum(row.covered_sales);
    const totalRevenue = toNum(row.total_revenue);
    const coveredRevenue = toNum(row.covered_revenue);
    byBiz[biz] = {
      totalSales,
      coveredSales,
      totalRevenue,
      coveredRevenue,
      salesCoveragePct: pct(coveredSales, totalSales),
      revenueCoveragePct: pct(coveredRevenue, totalRevenue)
    };
  }

  const totalSales = byBiz.dinein.totalSales + byBiz.takeaway.totalSales;
  const coveredSales = byBiz.dinein.coveredSales + byBiz.takeaway.coveredSales;
  const totalRevenue = byBiz.dinein.totalRevenue + byBiz.takeaway.totalRevenue;
  const coveredRevenue = byBiz.dinein.coveredRevenue + byBiz.takeaway.coveredRevenue;

  return {
    byBiz,
    total: {
      totalSales,
      coveredSales,
      totalRevenue,
      coveredRevenue,
      salesCoveragePct: pct(coveredSales, totalSales),
      revenueCoveragePct: pct(coveredRevenue, totalRevenue)
    },
    unmatchedTop: (unmatched.rows || []).map((row) => ({
      bizType: String(row.biz_type || '').trim(),
      dishName: String(row.dish_name || '').trim(),
      resolvedDishName: String(row.resolved_dish_name || '').trim(),
      sales: toNum(row.sales),
      revenue: toNum(row.revenue),
      qty: toNum(row.qty)
    }))
  };
}

async function generatePeriodReport(store, startDate, endDate, reportType = 'weekly') {
  const align = await resolveStoreKeyForReports(store);
  const storeKey = String(align.useStore || store).trim() || String(store).trim();
  const p = [storeKey, startDate, endDate];
  const report = {
    store,
    storeDbKey: storeKey,
    storeAlignment: align,
    weekStart: startDate,
    weekEnd: endDate,
    reportType,
    sections: {}
  };
  const hasTakeaway = !STORE_NO_TAKEAWAY.has(store) && !STORE_NO_TAKEAWAY.has(storeKey);
  report.hasTakeaway = hasTakeaway;

  // 0) 检测实际数据日期范围 + 数据质量
  const rangeQ = await pool().query(`
    SELECT MIN(date)::text AS actual_start, MAX(date)::text AS actual_end,
      COUNT(DISTINCT date) AS data_days,
      COUNT(*) AS total_rows,
      COUNT(CASE WHEN COALESCE(revenue,0)=0 AND COALESCE(sales_amount,0)>0 THEN 1 END) AS missing_revenue_rows,
      COUNT(CASE WHEN COALESCE(sales_amount,0)>0 THEN 1 END) AS valid_sales_rows
    FROM sales_raw WHERE store=$1 AND date BETWEEN $2 AND $3`, p);
  const rng = rangeQ.rows[0] || {};
  report.actualDateRange = { start: rng.actual_start || startDate, end: rng.actual_end || endDate, dataDays: Number(rng.data_days || 0) };
  const missingRevRows = Number(rng.missing_revenue_rows || 0);
  const validSalesRows = Number(rng.valid_sales_rows || 0);
  const missingRevPct = validSalesRows > 0 ? (missingRevRows / validSalesRows * 100) : 0;
  report.dataQualityWarnings = [];
  if (missingRevPct > 10) {
    report.dataQualityWarnings.push(`${missingRevRows}/${validSalesRows} 行(${missingRevPct.toFixed(0)}%)的实收(revenue)为0，可能影响实收营业额和实收毛利率的准确性。请检查数据导入是否完整。`);
  }

  // 0b) 营业日报兜底（sales_raw 无行或极少时，仍展示可核对口径）
  try {
    const drCurr = await pool().query(
      `SELECT COUNT(*)::int AS dr_days,
              COALESCE(SUM(actual_revenue), 0)::numeric AS revenue,
              COALESCE(SUM(dine_orders), 0)::numeric AS orders
       FROM daily_reports
       WHERE TRIM(store) = $1 AND date BETWEEN $2 AND $3`,
      [storeKey, startDate, endDate]
    );
    const periodDays = daysBetweenInclusive(startDate, endDate);
    const prev = shiftRangeBackward(startDate, endDate, periodDays);
    const drPrev = await pool().query(
      `SELECT COALESCE(SUM(actual_revenue), 0)::numeric AS revenue,
              COALESCE(SUM(dine_orders), 0)::numeric AS orders
       FROM daily_reports
       WHERE TRIM(store) = $1 AND date BETWEEN $2 AND $3`,
      [storeKey, prev.start, prev.end]
    );
    const c = drCurr.rows?.[0] || {};
    const pr = drPrev.rows?.[0] || {};
    const curRev = toNum(c.revenue);
    const curOrd = toNum(c.orders);
    const prevRev = toNum(pr.revenue);
    const prevOrd = toNum(pr.orders);
    report.sections.fallbackDaily = {
      current: { days: Number(c.dr_days || 0), revenue: curRev, orders: curOrd },
      previous: { revenue: prevRev, orders: prevOrd },
      revenueWowPct: wow(curRev, prevRev),
      ordersWowPct: wow(curOrd, prevOrd)
    };
  } catch (_e) {
    report.sections.fallbackDaily = null;
  }

  if (align.note) {
    report.dataQualityWarnings = report.dataQualityWarnings || [];
    report.dataQualityWarnings.unshift(align.note);
  }
  if (Number(rng.data_days || 0) === 0) {
    report.dataQualityWarnings = report.dataQualityWarnings || [];
    report.dataQualityWarnings.push(
      `**【需确认】** 统计周期内 sales_raw **零行**。若你已在其它系统上传销售，请核对「门店」字段是否与库中一致（当前用于查询：**${storeKey}**）。`
    );
  }

  // a) 用餐时长 (堂食only, has checkout_time)
  const dur = await pool().query(`
    SELECT slot,
      ROUND(AVG(EXTRACT(EPOCH FROM (checkout_time - order_time))/60)::numeric, 1) as avg_min,
      COUNT(*) as cnt
    FROM sales_raw
    WHERE store=$1 AND date BETWEEN $2 AND $3
      AND biz_type='dinein' AND order_time IS NOT NULL AND checkout_time IS NOT NULL
      AND checkout_time > order_time
    GROUP BY slot ORDER BY slot`, p);
  report.sections.diningDuration = dur.rows;

  // b) TOP10 / Bottom10 per biz (过滤赠品/饮品/指定菜品 + 过滤0金额)
  const rankingRaw = await pool().query(`
    SELECT biz_type, dish_name, SUM(qty) as total_qty, SUM(sales_amount) as total_sales
    FROM sales_raw
    WHERE store=$1 AND date BETWEEN $2 AND $3
      AND biz_type IN ('dinein','takeaway')
      AND dish_name IS NOT NULL
    GROUP BY biz_type, dish_name
    HAVING SUM(qty) > 0 AND SUM(sales_amount) > 0
  `, p);
  const rankingByBiz = { dinein: [], takeaway: [] };
  for (const row of rankingRaw.rows || []) {
    const biz = String(row.biz_type || '').trim();
    if (!rankingByBiz[biz]) continue;
    if (shouldExcludeDish(row.dish_name)) continue;
    rankingByBiz[biz].push({
      dish_name: row.dish_name,
      total_qty: toNum(row.total_qty),
      total_sales: toNum(row.total_sales)
    });
  }
  for (const biz of BIZ_TYPES) {
    const list = (rankingByBiz[biz] || []).sort((a, b) => Number(b.total_sales || 0) - Number(a.total_sales || 0));
    report.sections[`ranking_${biz}`] = {
      top10: list.slice(0, 10),
      bottom10: [...list].sort((a, b) => Number(a.total_sales || 0) - Number(b.total_sales || 0)).slice(0, 10)
    };
  }

  // c) 周一到周日 堂食/外卖 占比
  const wk = await pool().query(`
    SELECT weekday, biz_type,
      COUNT(DISTINCT order_time) as order_cnt,
      SUM(sales_amount) as total_sales
    FROM sales_raw
    WHERE store=$1 AND date BETWEEN $2 AND $3
    GROUP BY weekday, biz_type ORDER BY weekday`, p);
  report.sections.weekdayRatios = wk.rows;

  // d) 每小时订单量 per weekday
  const hr = await pool().query(`
    SELECT weekday, EXTRACT(HOUR FROM order_time)::int as hour, biz_type, COUNT(*) as cnt
    FROM sales_raw
    WHERE store=$1 AND date BETWEEN $2 AND $3 AND order_time IS NOT NULL
    GROUP BY weekday, hour, biz_type ORDER BY weekday, hour`, p);
  report.sections.hourlyOrders = hr.rows;

  // e) 理论毛利率 + 折扣诊断
  const currentMargin = await queryMarginByBiz(storeKey, startDate, endDate);
  report.sections.theoreticalMargins = {
    ...currentMargin.margins,
    totals: {
      total: currentMargin.total,
      dinein: currentMargin.byBiz.dinein,
      takeaway: currentMargin.byBiz.takeaway
    }
  };
  report.sections.slotMargins = await queryMarginBySlot(storeKey, startDate, endDate);
  report.sections.costCoverage = await queryCostCoverageDiagnostics(storeKey, startDate, endDate, 15);

  const takeCoverage = toNum(report.sections.costCoverage?.byBiz?.takeaway?.salesCoveragePct);
  const dineinCoverage = toNum(report.sections.costCoverage?.byBiz?.dinein?.salesCoveragePct);
  if (hasTakeaway && takeCoverage > 0 && takeCoverage < COST_COVERAGE_WARN_THRESHOLD_PCT) {
    report.dataQualityWarnings.push(`外卖成本覆盖率仅 ${takeCoverage.toFixed(1)}%，低于${COST_COVERAGE_WARN_THRESHOLD_PCT}%门槛，本期外卖毛利可信度较低。请先补齐成本库/别名映射后再解读毛利。`);
  }
  if (dineinCoverage > 0 && dineinCoverage < COST_COVERAGE_WARN_THRESHOLD_PCT) {
    report.dataQualityWarnings.push(`堂食成本覆盖率仅 ${dineinCoverage.toFixed(1)}%，低于${COST_COVERAGE_WARN_THRESHOLD_PCT}%门槛，本期堂食毛利可信度较低。`);
  }

  // f) 环比（上一周期）
  const periodDays = daysBetweenInclusive(startDate, endDate);
  const prev = shiftRangeBackward(startDate, endDate, periodDays);
  const previousMargin = await queryMarginByBiz(storeKey, prev.start, prev.end);
  report.sections.wow = {
    currentRange: { start: startDate, end: endDate },
    previousRange: prev,
    salesWowPct: wow(currentMargin.total.sales, previousMargin.total.sales),
    revenueWowPct: wow(currentMargin.total.revenue, previousMargin.total.revenue),
    discountWowPct: wow(currentMargin.total.discount, previousMargin.total.discount),
    netMarginWowPct: wow(
      currentMargin.margins.totalNetMarginPct ?? NaN,
      previousMargin.margins.totalNetMarginPct ?? NaN
    )
  };

  // g) 数据分析总结（自动）
  report.sections.analysisSummary = buildAnalysisSummary(report);

  return report;
}

export async function generateWeeklyReport(store, weekStart, weekEnd) {
  return generatePeriodReport(store, weekStart, weekEnd, 'weekly');
}

export async function generateMonthlyReport(store, monthStart, monthEnd) {
  return generatePeriodReport(store, monthStart, monthEnd, 'monthly');
}

export function formatReportMarkdown(r) {
  const isMonthly = r.reportType === 'monthly';
  const hasTakeaway = r.hasTakeaway !== false;
  const periodLabel = isMonthly ? '月度' : '周度';
  const adr = r.actualDateRange || {};
  const actualStart = adr.start || r.weekStart;
  const actualEnd = adr.end || r.weekEnd;
  const dataDays = adr.dataDays || 0;

  const fmtPct = (v) => (v === null || v === undefined || !Number.isFinite(v) ? '—（无有效基数）' : `${v.toFixed(1)}%`);
  const fmtSignedPct = (v) => {
    if (v === null || v === undefined || !Number.isFinite(v)) return '—（无上期可对比）';
    const sign = v > 0 ? '↑' : v < 0 ? '↓' : '→';
    return `${sign}${Math.abs(v).toFixed(1)}%`;
  };
  const fmtMoney = (v) => {
    const n = toNum(v);
    if (n >= 10000) return `¥${(n / 10000).toFixed(2)}万`;
    return `¥${n.toFixed(0)}`;
  };
  const fmtMoneyPlain = (v) => `¥${toNum(v).toFixed(0)}`;
  const sep = '─'.repeat(18);

  const m = r.sections.theoreticalMargins || {};
  const totals = m.totals || {};
  const costCoverage = r.sections.costCoverage || {};
  const wowSec = r.sections.wow || {};

  const coverageLabel = (v) => {
    if (v === null || v === undefined || !Number.isFinite(v)) return '—（无数据）';
    if (v >= COST_COVERAGE_GOOD_THRESHOLD_PCT) return `✅${v.toFixed(1)}%`;
    if (v >= COST_COVERAGE_WARN_THRESHOLD_PCT) return `⚠️${v.toFixed(1)}%`;
    return `🚨${v.toFixed(1)}%`;
  };

  let md = '';

  // ── 标题 ──
  md += `**${r.store}**\n`;
  if (r.storeDbKey && String(r.storeDbKey) !== String(r.store)) {
    md += `> 数据查询门店：**${r.storeDbKey}**（与展示名不一致时已自动/提示对齐）\n`;
  }
  md += `**${periodLabel}经营分析报告**\n`;
  md += `${actualStart} ~ ${actualEnd}（共${dataDays}天 sales_raw 有数据）\n`;
  if (actualStart !== r.weekStart || actualEnd !== r.weekEnd) {
    md += `> 注：统计周期 ${r.weekStart}~${r.weekEnd}，sales_raw 实际有数据 ${dataDays} 天\n`;
  }

  // ── 数据质量警告 ──
  const warns = r.dataQualityWarnings || [];
  if (warns.length) {
    md += `\n**⚠ 数据质量提醒**\n`;
    warns.forEach(w => { md += `- ${w}\n`; });
  }

  // ── 一、执行摘要 ──
  md += `\n${sep}\n`;
  md += `**一、执行摘要**\n\n`;
  const fb = r.sections.fallbackDaily;
  const fbDailyDays = fb && fb.current ? Number(fb.current.days || 0) : 0;
  const fbHasNumbers = fb && fb.current && (toNum(fb.current.revenue) > 0 || toNum(fb.current.orders) > 0);
  if (fb && fb.current && fbHasNumbers) {
    md += `**营业日报兜底（daily_reports）** — sales_raw 缺数时仍可对账\n\n`;
    md += `| 指标 | 本期 | 环比 |\n|:--|--:|--:|\n`;
    const asp = fb.current.orders > 0 ? fb.current.revenue / fb.current.orders : null;
    const aspPrev = fb.previous && toNum(fb.previous.orders) > 0 ? toNum(fb.previous.revenue) / toNum(fb.previous.orders) : null;
    const aspWow = Number.isFinite(asp) && Number.isFinite(aspPrev) && aspPrev !== 0 ? wow(asp, aspPrev) : null;
    md += `| 营业额(日报) | **${fmtMoney(fb.current.revenue)}**（${fb.current.days}天有日报） | ${fmtSignedPct(fb.revenueWowPct)} |\n`;
    md += `| 订单数 | **${toNum(fb.current.orders).toFixed(0)}** | ${fmtSignedPct(fb.ordersWowPct)} |\n`;
    md += `| 客单价(估) | **${asp != null ? fmtMoney(asp) : '—'}** | ${fmtSignedPct(aspWow)} |\n\n`;
  } else if (dataDays === 0) {
    if (fbDailyDays > 0) {
      md += `**【需确认】** **sales_raw** 本周期无行；**daily_reports** 有 **${fbDailyDays}** 天记录但营业额/订单合计为 0，请核对日报是否未填报或字段映射（actual_revenue / dine_orders）。\n\n`;
    } else {
      md += `**【需确认】** 本周期在 **sales_raw** 与 **daily_reports** 均未拉到有效数据，请检查店名是否与数据库一致、是否未上传销售/日报。\n\n`;
    }
  }

  md += `**销售明细口径（sales_raw + 成本匹配）**\n\n`;
  md += `| 指标 | 本期 | 环比 |\n|:--|--:|--:|\n`;
  md += `| 折前营业额 | **${fmtMoney(totals.total?.sales)}** | ${fmtSignedPct(wowSec.salesWowPct)} |\n`;
  md += `| 实收营业额 | **${fmtMoney(totals.total?.revenue)}** | ${fmtSignedPct(wowSec.revenueWowPct)} |\n`;
  md += `| 折扣总额 | ${fmtMoney(totals.total?.discount)} | ${fmtSignedPct(wowSec.discountWowPct)} |\n`;
  md += `| 实收毛利率 | **${fmtPct(m.totalNetMarginPct)}** | ${fmtSignedPct(wowSec.netMarginWowPct)} |\n`;

  // ── 二、毛利分析 ──
  md += `\n${sep}\n`;
  md += `**二、理论毛利分析**（折前/实收双口径）\n\n`;
  md += `> 口径说明：以下毛利率按“已匹配到成本”的销售明细计算；未命中成本的记录不计入收入与成本。\n`;
  md += `> 基于菜品库成本计算\n\n`;

  const marginRows = [
    { label: '📊 总计', data: totals.total, pre: m.totalPreDiscountMarginPct, net: m.totalNetMarginPct }
  ];
  marginRows.push({ label: '🍽 堂食', data: totals.dinein, pre: m.dineinPreDiscountMarginPct, net: m.dineinNetMarginPct });
  if (hasTakeaway) {
    marginRows.push({ label: '🛵 外卖', data: totals.takeaway, pre: m.takeawayPreDiscountMarginPct, net: m.takeawayNetMarginPct });
  }

  md += `| 类型 | 折前营收 | 实收营收 | 成本 | 折前毛利 | 实收毛利 |\n`;
  md += `|:--|--:|--:|--:|--:|--:|\n`;
  for (const row of marginRows) {
    md += `| ${row.label} | ${fmtMoneyPlain(row.data?.sales)} | ${fmtMoneyPlain(row.data?.revenue)} | ${fmtMoneyPlain(row.data?.cost)} | ${fmtPct(row.pre)} | **${fmtPct(row.net)}** |\n`;
  }

  md += `\n**成本覆盖率（覆盖率越高，毛利越可信）**\n`;
  md += `| 类型 | 销售额覆盖率 | 实收覆盖率 |\n`;
  md += `|:--|--:|--:|\n`;
  md += `| 📊 总计 | ${coverageLabel(costCoverage.total?.salesCoveragePct)} | ${coverageLabel(costCoverage.total?.revenueCoveragePct)} |\n`;
  md += `| 🍽 堂食 | ${coverageLabel(costCoverage.byBiz?.dinein?.salesCoveragePct)} | ${coverageLabel(costCoverage.byBiz?.dinein?.revenueCoveragePct)} |\n`;
  if (hasTakeaway) {
    md += `| 🛵 外卖 | ${coverageLabel(costCoverage.byBiz?.takeaway?.salesCoveragePct)} | ${coverageLabel(costCoverage.byBiz?.takeaway?.revenueCoveragePct)} |\n`;
  }

  // ── 三、时段经营维度 ──
  md += `\n${sep}\n`;
  md += `**三、时段经营**（午市/下午茶/晚市）\n\n`;
  const slotMargins = r.sections.slotMargins || {};
  let slotAny = false;
  for (const slot of SLOT_TYPES) {
    const sec = slotMargins[slot];
    if (!sec || toNum(sec.total?.sales) === 0) continue;
    slotAny = true;
    md += `**${SLOT_CN[slot]}**\n`;
    md += `折前 ${fmtMoneyPlain(sec.total?.sales)} ｜ 实收 ${fmtMoneyPlain(sec.total?.revenue)} ｜ 成本 ${fmtMoneyPlain(sec.total?.cost)}\n`;
    md += `折前毛利 **${fmtPct(sec.margins?.preDiscountMarginPct)}** ｜ 实收毛利 **${fmtPct(sec.margins?.netMarginPct)}**\n`;
    const bizList = hasTakeaway ? BIZ_TYPES : ['dinein'];
    for (const biz of bizList) {
      const b = sec.byBiz?.[biz] || {};
      if (toNum(b.sales) === 0) continue;
      const pre = pct(toNum(b.sales) - toNum(b.cost), toNum(b.sales));
      const net = pct(toNum(b.revenue) - toNum(b.cost), toNum(b.revenue));
      md += `- ${BIZ_CN[biz]}: 折前${fmtMoneyPlain(b.sales)} / 实收${fmtMoneyPlain(b.revenue)} / 毛利${fmtPct(net)}\n`;
    }
    md += `\n`;
  }
  if (!slotAny) {
    md += `**【需说明】** 本周期无可用时段拆分销售（多为 sales_raw 无行或各时段销售额为 0）。\n\n`;
  }

  // ── 四、用餐时长 ──
  md += `${sep}\n`;
  md += `**四、用餐时长**（堂食）\n\n`;
  const durationRows = r.sections.diningDuration || [];
  if (!durationRows.length) {
    md += `暂无可用堂食结账时长数据\n`;
  } else {
    for (const d of durationRows) {
      md += `- **${SLOT_CN[d.slot]||d.slot}** ${d.avg_min}分钟（${d.cnt}单）\n`;
    }
  }

  // ── 五、菜品销售表现 ──
  md += `\n${sep}\n`;
  md += `**五、菜品销售TOP/末位**\n`;
  md += `> 已剔除赠品/饮品/指定非排名菜品\n\n`;
  const bizForRanking = hasTakeaway ? BIZ_TYPES : ['dinein'];
  for (const biz of bizForRanking) {
    const bizCN = BIZ_CN[biz];
    const sec = r.sections[`ranking_${biz}`] || {};
    md += `**${bizCN}**\n`;
    if (!sec.top10?.length) {
      md += `暂无有效菜品数据\n\n`;
      continue;
    }
    md += `🔥 TOP10\n`;
    sec.top10.forEach((d,i) => {
      md += `${String(i+1).padStart(2,' ')}. ${d.dish_name}  ${fmtMoneyPlain(d.total_sales)}（${toNum(d.total_qty).toFixed(0)}份）\n`;
    });
    if (sec.bottom10?.length) {
      md += `📉 末位10\n`;
      sec.bottom10.forEach((d,i) => {
        md += `${String(i+1).padStart(2,' ')}. ${d.dish_name}  ${fmtMoneyPlain(d.total_sales)}（${toNum(d.total_qty).toFixed(0)}份）\n`;
      });
    }
    md += `\n`;
  }

  // ── 六、营业占比（仅有外卖的门店显示）──
  if (hasTakeaway) {
    md += `${sep}\n`;
    md += `**六、每日营业占比**（堂食/外卖）\n\n`;
    const byDay = {};
    for (const w of (r.sections.weekdayRatios||[])) {
      if (!byDay[w.weekday]) byDay[w.weekday] = {};
      byDay[w.weekday][w.biz_type] = { orders: Number(w.order_cnt), sales: Number(w.total_sales) };
    }
    for (let d=1; d<=7; d++) {
      const day = byDay[d]; if (!day) continue;
      const di = day.dinein||{orders:0,sales:0}, tk = day.takeaway||{orders:0,sales:0};
      const to = di.orders+tk.orders, ts = di.sales+tk.sales;
      if (!to) continue;
      md += `**${WEEKDAY_CN[d]}** 堂食${di.orders}单(${(di.orders/to*100).toFixed(0)}%) ${fmtMoneyPlain(di.sales)}`;
      if (tk.orders) md += ` ｜ 外卖${tk.orders}单(${(tk.orders/to*100).toFixed(0)}%) ${fmtMoneyPlain(tk.sales)}`;
      md += `\n`;
    }
  }

  // ── 七、高峰/低峰 ──
  md += `\n${sep}\n`;
  md += `**${hasTakeaway ? '七' : '六'}、高峰/低峰时段**\n\n`;
  const byDayHour = {};
  for (const h of (r.sections.hourlyOrders||[])) {
    const k = `${h.weekday}`;
    if (!byDayHour[k]) byDayHour[k] = {};
    const hh = h.hour;
    byDayHour[k][hh] = (byDayHour[k][hh]||0) + Number(h.cnt);
  }
  for (let d=1; d<=7; d++) {
    const hrs = byDayHour[d]; if (!hrs) continue;
    const sorted = Object.entries(hrs).sort((a,b)=>b[1]-a[1]);
    const peak = sorted.slice(0,3).map(([h,c])=>`${h}:00(${c})`).join(' ');
    const low = sorted.slice(-3).reverse().map(([h,c])=>`${h}:00(${c})`).join(' ');
    md += `**${WEEKDAY_CN[d]}** 高峰 ${peak} ｜ 低峰 ${low}\n`;
  }

  // ── 八、数据分析总结 ──
  const sectionNum = hasTakeaway ? '八' : '七';
  md += `\n${sep}\n`;
  md += `**${sectionNum}、数据分析总结**\n\n`;
  const summary = Array.isArray(r.sections.analysisSummary) ? r.sections.analysisSummary : [];
  if (!summary.length) {
    md += `暂无足够数据生成自动总结\n`;
  } else {
    summary.forEach((line, idx) => {
      md += `${idx + 1}. ${line}\n`;
    });
  }

  const unmatchedTop = Array.isArray(costCoverage.unmatchedTop) ? costCoverage.unmatchedTop : [];
  if (unmatchedTop.length) {
    md += `\n${sep}\n`;
    md += `**附录：未匹配成本菜品TOP（按折前营收）**\n\n`;
    unmatchedTop.slice(0, 15).forEach((x, idx) => {
      const bizCn = BIZ_CN[String(x.bizType || '').trim()] || String(x.bizType || '-').trim() || '-';
      const resolvedHint = x.resolvedDishName && x.resolvedDishName !== x.dishName ? ` → 标准名:${x.resolvedDishName}` : '';
      md += `${String(idx + 1).padStart(2, ' ')}. [${bizCn}] ${x.dishName}${resolvedHint} ｜ 折前${fmtMoneyPlain(x.sales)} ｜ 实收${fmtMoneyPlain(x.revenue)} ｜ 数量${toNum(x.qty).toFixed(0)}\n`;
    });
  }

  md += `\n> 折扣 = 折前营收 - 实收营收（取推导值与源表较大者）\n`;

  return md;
}
