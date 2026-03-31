/**
 * 用 HRMS 销售明细 sales_raw + 飞书同步表 dish_library_costs 估算菜品级成本与综合毛利率。
 */
import { query } from '../utils/db.js';
import { logger } from '../utils/logger.js';
import { normalizeStoreCompact } from '../utils/store-sql-patterns.js';

function normalizeDishName(raw) {
  let s = String(raw || '').trim();
  if (!s) return '';
  const trad = {
    魚: '鱼', 雞: '鸡', 鴨: '鸭', 鵝: '鹅', 雜: '杂', 滷: '卤', 燒: '烧', 湯: '汤', 飯: '饭', 麵: '面',
    餅: '饼', 凍: '冻', 鮮: '鲜', 廣: '广', 銷: '销', 順: '顺', 蔥: '葱', 薑: '姜', 蝦: '虾',
    蠔: '蚝', 鍋: '锅', 鑊: '镬', 龍: '龙', 頸: '颈', 風: '风', 號: '号', 東: '东'
  };
  const numMap = { 0: '零', 1: '一', 2: '二', 3: '三', 4: '四', 5: '五', 6: '六', 7: '七', 8: '八', 9: '九' };
  s = s.replace(/【[^】]*】|（[^）]*）|\([^)]*\)|\[[^\]]*\]/g, '');
  s = s
    .split('')
    .map((ch) => trad[ch] || numMap[ch] || ch)
    .join('');
  s = s.replace(/[\s_/+·,，。、“”‘’!！?？:：;；'"~～()（）\[\]【】-]/g, '');
  return s.toLowerCase();
}

function normalizeBiz(v) {
  const s = String(v || '').trim().toLowerCase();
  if (/外卖|takeaway|delivery|外送/.test(s)) return 'takeaway';
  if (/堂食|dinein|店内/.test(s)) return 'dinein';
  return '';
}

async function loadCostMap(storeNorm) {
  const mapTakeaway = new Map();
  const mapDinein = new Map();
  const mapAny = new Map();
  try {
    const r = await query(
      `SELECT dish_name, unit_cost, biz_type
       FROM dish_library_costs
       WHERE enabled = TRUE
         AND (
           lower(regexp_replace(coalesce(store, ''), '\\s+', '', 'g')) = $1
           OR coalesce(nullif(trim(store), ''), '*') = '*'
         )
       ORDER BY
         CASE
           WHEN lower(regexp_replace(coalesce(biz_type, ''), '\\s+', '', 'g')) IN ('takeaway','delivery','外卖','外送') THEN 0
           WHEN lower(regexp_replace(coalesce(biz_type, ''), '\\s+', '', 'g')) IN ('dinein','堂食','店内','堂食点餐') THEN 0
           WHEN coalesce(nullif(trim(biz_type), ''), '*') IN ('*', 'all', 'ALL', '全部', '通用') THEN 1
           ELSE 2
         END,
         CASE WHEN coalesce(nullif(trim(store), ''), '*') = '*' THEN 2 ELSE 1 END,
         updated_at DESC`,
      [storeNorm]
    );
    for (const row of r.rows || []) {
      const key = normalizeDishName(row.dish_name);
      if (!key) continue;
      const cost = Number(row.unit_cost);
      if (!Number.isFinite(cost) || cost < 0) continue;
      const biz = normalizeBiz(row.biz_type);
      if (biz === 'takeaway' && !mapTakeaway.has(key)) mapTakeaway.set(key, cost);
      else if (biz === 'dinein' && !mapDinein.has(key)) mapDinein.set(key, cost);
      else if (!biz && !mapAny.has(key)) mapAny.set(key, cost);
    }
  } catch (e) {
    logger.warn({ err: e?.message }, 'margin-from-sales: dish_library_costs');
  }
  return { mapTakeaway, mapDinein, mapAny };
}

async function computeCostProfitEstimate(storeNorm, start, end) {
  let salesRows = [];
  const r = await query(
    `SELECT biz_type, dish_name,
            SUM(COALESCE(qty, 0))::numeric AS qty,
            SUM(COALESCE(revenue, sales_amount, 0))::numeric AS rev
     FROM sales_raw
     WHERE date BETWEEN $1::date AND $2::date
       AND lower(regexp_replace(coalesce(store, ''), '\\s+', '', 'g')) LIKE $3
       AND coalesce(trim(dish_name), '') <> ''
     GROUP BY biz_type, dish_name`,
    [start, end, `%${storeNorm}%`]
  );
  salesRows = r.rows || [];

  if (!salesRows.length) {
    return {
      revenueTotal: 0,
      costTotal: 0,
      profitTotal: 0,
      profitRate: null,
      matchedRev: 0,
      unmatchedRev: 0,
      samples: []
    };
  }

  const { mapTakeaway, mapDinein, mapAny } = await loadCostMap(storeNorm);

  let revTotal = 0;
  let costTotal = 0;
  let matchedRev = 0;
  let unmatchedRev = 0;
  const samples = [];

  for (const row of salesRows) {
    const biz = normalizeBiz(row.biz_type);
    const dk = normalizeDishName(row.dish_name);
    const qty = Number(row.qty) || 0;
    const rev = Number(row.rev) || 0;
    if (qty <= 0 && rev <= 0) continue;

    revTotal += rev;

    const costMap = biz === 'takeaway' ? mapTakeaway : biz === 'dinein' ? mapDinein : null;
    let unit = costMap?.get(dk);
    if (unit == null) unit = mapTakeaway.get(dk) ?? mapDinein.get(dk) ?? mapAny.get(dk);

    if (unit != null && qty > 0) {
      const c = qty * unit;
      costTotal += c;
      matchedRev += rev;
      if (samples.length < 8) {
        samples.push({ dish: row.dish_name, qty, rev: rev.toFixed(0), cost: c.toFixed(0), biz: biz || '未标注' });
      }
    } else {
      unmatchedRev += rev;
    }
  }

  const profitTotal = revTotal - costTotal;
  const profitRate = revTotal > 0 ? (profitTotal / revTotal) : null;

  return {
    revenueTotal: revTotal,
    costTotal,
    profitTotal,
    profitRate,
    matchedRev,
    unmatchedRev,
    samples
  };
}

/**
 * @param {string} store HRMS 门店名
 * @param {string} start YYYY-MM-DD
 * @param {string} end YYYY-MM-DD
 */
export async function estimateCostAndProfitForStore(store, start, end) {
  const storeNorm = normalizeStoreCompact(store);
  if (!storeNorm) return { revenueTotal: 0, costTotal: 0, profitTotal: 0, profitRate: null, matchedRev: 0, unmatchedRev: 0, samples: [] };
  const est = await computeCostProfitEstimate(storeNorm, start, end);
  return est;
}

export async function estimateMarginForStore(store, start, end) {
  const storeNorm = normalizeStoreCompact(store);
  if (!storeNorm) return '';
  let est;
  try {
    est = await computeCostProfitEstimate(storeNorm, start, end);
  } catch (e) {
    logger.warn({ err: e?.message }, 'margin-from-sales: compute');
    return '';
  }

  if (!est || est.revenueTotal <= 0) {
    return `📊 ${start}～${end} 销售毛利估算（${store}）：sales_raw 中无菜品明细，请先通过智能助手上传销售明细。`;
  }
  const { revenueTotal: revTotal, costTotal, profitTotal, profitRate, matchedRev, samples } = est;
  const rate = profitRate != null ? profitRate * 100 : null;
  const cov = revTotal > 0 ? (matchedRev / revTotal) * 100 : 0;
  const lines = [
    `📊 销售毛利估算（${store}·${start}～${end}）`,
    `- **销售明细收入(估)**: ¥${revTotal.toFixed(2)}（来自 sales_raw）`,
    `- **匹配成本(估)**: ¥${costTotal.toFixed(2)}（unit_cost × qty，来源 dish_library_costs / 飞书菜品库）`,
    rate != null ? `- **估算毛利率**: ${rate.toFixed(1)}%（未匹配收入的菜品不计成本，可能偏高）` : '- **估算毛利率**: 无法计算',
    `- **成本覆盖收入占比**: ${cov.toFixed(1)}%（剩余多为菜品名与成本库未对齐）`
  ];
  if (samples?.length) {
    lines.push('', '**样本（已匹配成本）**:');
    samples.forEach((x, i) => lines.push(`${i + 1}. ${x.dish}（${x.biz}） qty=${x.qty} 收¥${x.rev} 成¥${x.cost}`));
  }
  lines.push('', '> 口径：堂食/外卖分别优先匹配 biz_type；成本表门店或 `*` 通用；飞书同步任务在 HRMS `feishu-sync.syncDishLibraryCosts`。');
  return lines.join('\n');
}
