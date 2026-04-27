/**
 * 菜品优化周报/月报
 *
 * - 分组：**门店 × 堂食/外卖 × sales_raw 大类（category + 可选 category_code）**
 * - 在每个大类内对**单品**（有成本匹配）用销量中位数 × 利润额中位数划四象限：明细 / 引流 / 潜力 / 淘汰
 * - 每象限最多 5 道菜（按销量降序）
 */
import { query } from '../utils/db.js';
import { logger } from '../utils/logger.js';
import { sendCard, sendText } from './feishu-client.js';
import { sendReportToRecipient, getShanghaiYmd } from './report-delivery.js';
import { normalizeStoreCompact } from '../utils/store-sql-patterns.js';
import { shanghaiLastCompletedWeekBounds, getShanghaiYmdParts } from '../utils/anomaly-week-bounds.js';
import { getBadReviewRowsForStoreDateRange } from './deterministic-replies.js';

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
  s = s.split('').map((ch) => trad[ch] || numMap[ch] || ch).join('');
  s = s.replace(/[\s_/+·,，。、“”‘’!！?？:：;；'"~～()（）\[\]【】-]/g, '');
  return s.toLowerCase();
}

function normalizeBiz(v) {
  const s = String(v || '').trim().toLowerCase();
  if (/外卖|takeaway|delivery|外送/.test(s)) return 'takeaway';
  if (/堂食|dinein|店内/.test(s)) return 'dinein';
  return '';
}

function bizChannelZh(biz) {
  const x = String(biz || '').toLowerCase();
  if (x.includes('take') || x.includes('外卖') || x === 'waimai') return '外卖';
  return '堂食';
}

export function medianThreshold(getVal, arr) {
  if (!arr.length) return 0;
  const vals = arr.map(getVal).filter((v) => Number.isFinite(v));
  if (!vals.length) return 0;
  const s = [...vals].sort((a, b) => a - b);
  const n = s.length;
  if (n % 2 === 1) return s[Math.floor(n / 2)];
  return (s[n / 2 - 1] + s[n / 2]) / 2;
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
    logger.warn({ err: e?.message }, 'dish-optimization: dish_library_costs failed');
  }
  return { mapTakeaway, mapDinein, mapAny };
}

export function classifyByQtyProfit(arr) {
  if (arr.length < 2) return { star: [], traffic: [], potential: [], eliminate: [], sparse: arr };
  const midQty = medianThreshold((x) => x.qty, arr);
  const midProf = medianThreshold((x) => x.profit, arr);
  const star = [], traffic = [], potential = [], eliminate = [];
  for (const x of arr) {
    const hiQ = x.qty >= midQty;
    const hiP = x.profit >= midProf;
    if (hiQ && hiP) star.push(x);
    else if (hiQ && !hiP) traffic.push(x);
    else if (!hiQ && hiP) potential.push(x);
    else eliminate.push(x);
  }
  return { star, traffic, potential, eliminate, sparse: [] };
}

function quadrantGuidance(q) {
  if (q === 'star') {
    return '**营运**：锁定 SOP 与备餐基准量，高峰前预制备，减少断货；周复盘口味稳定性。\n**营销**：作为套餐主菜/点评头图与「必点」话术；会员加购、第二份小折扣提升客单。';
  }
  if (q === 'traffic') {
    return '**营运**：拆解原料与包材成本，谈判供货或微调规格/配方；设外卖出餐动线专位降人工秒数。\n**营销**：明确「引流款」定位，控制折扣深度；捆绑高利润配菜/饮料，避免长期负毛利冲量。';
  }
  if (q === 'potential') {
    return '**营运**：备量保守、先以试销清单管理；培训服务员 2 句推荐话术与搭配理由。\n**营销**：店内海报/桌贴/电子屏曝光；企微社群限时试吃券；套餐中「加购价」试推一周看转化。';
  }
  return '**营运**：评估下架或替换；清仓阶梯价清库存，减少占菜单位与备料资金。\n**营销**：不做主推与流量投放；若保留仅作凑单小份装，避免占用套餐与广告位。';
}

const QUADRANT_TITLE = {
  star: '⭐ 明细产品（高销量 · 高利润额）',
  traffic: '🔻 引流产品（高销量 · 低利润额）',
  potential: '📈 潜力产品（低销量 · 高利润额）',
  eliminate: '🗑 淘汰产品（低销量 · 低利润额）'
};

function fmtDishLine(d) {
  const gp = d.revenue > 0 ? (d.profit / d.revenue) * 100 : 0;
  return `· **${d.dish}** 销量 **${Math.round(d.qty)}** 份｜销额 ¥${d.revenue.toFixed(0)}｜利润额 ¥${d.profit.toFixed(
    0
  )}｜毛利率 **${gp.toFixed(1)}%**`;
}

function formatDishQuadrantBlock(qKey, dishes) {
  const titleZh = QUADRANT_TITLE[qKey];
  const g = quadrantGuidance(qKey);
  const sorted = [...dishes].sort((a, b) => b.qty - a.qty).slice(0, 5);
  const lines = sorted.map(fmtDishLine).join('\n');
  if (!lines) return `**${titleZh}**\n_（无）_\n\n${g}\n`;
  return `**${titleZh}**\n${lines}\n\n${g}\n`;
}

function prevMonthPeriod() {
  const { y, m } = getShanghaiYmdParts();
  let pm = m - 1, py = y;
  if (pm < 1) { pm = 12; py -= 1; }
  return `${py}-${String(pm).padStart(2, '0')}`;
}

function monthDateRange(period) {
  const [yy, mm] = period.split('-').map(Number);
  const start = `${yy}-${String(mm).padStart(2, '0')}-01`;
  const last = new Date(yy, mm, 0);
  const end = `${yy}-${String(mm).padStart(2, '0')}-${String(last.getDate()).padStart(2, '0')}`;
  return { start, end };
}

export async function buildDishOptimizationMarkdown({ start, end, reportTitle }) {
  let agg;
  try {
    agg = await query(
      `SELECT store, biz_type,
              COALESCE(NULLIF(TRIM(COALESCE(category::text, '')), ''), '未分类') AS category,
              NULLIF(TRIM(COALESCE(category_code::text, '')), '') AS category_code,
              dish_name,
              SUM(COALESCE(qty, 0))::numeric AS qty,
              SUM(COALESCE(revenue, 0))::numeric AS revenue
       FROM sales_raw
       WHERE date >= $1::date AND date <= $2::date AND COALESCE(dish_name, '') <> ''
       GROUP BY store, biz_type, category, category_code, dish_name`,
      [start, end]
    );
  } catch (e) {
    if (e?.code === '42703') {
      agg = await query(
        `SELECT store, biz_type,
                COALESCE(NULLIF(TRIM(COALESCE(category::text, '')), ''), '未分类') AS category,
                NULL::text AS category_code,
                dish_name,
                SUM(COALESCE(qty, 0))::numeric AS qty,
                SUM(COALESCE(revenue, 0))::numeric AS revenue
         FROM sales_raw
         WHERE date >= $1::date AND date <= $2::date AND COALESCE(dish_name, '') <> ''
         GROUP BY store, biz_type, category, dish_name`,
        [start, end]
      );
    } else {
      throw e;
    }
  }

  const stores = [...new Set((agg.rows || []).map((r) => r.store).filter(Boolean))];
  const costMaps = new Map();
  for (const store of stores) {
    const storeNorm = normalizeStoreCompact(store);
    if (!storeNorm) continue;
    const cm = await loadCostMap(storeNorm);
    costMaps.set(storeNorm, cm);
  }

  const dishItems = [];
  for (const r of agg.rows || []) {
    const qty = Number(r.qty || 0);
    const revenue = Number(r.revenue || 0);
    if (qty <= 0 || revenue <= 0) continue;
    const storeNorm = normalizeStoreCompact(r.store);
    const cm = costMaps.get(storeNorm);
    if (!cm) continue;
    const biz = normalizeBiz(r.biz_type);
    const dk = normalizeDishName(r.dish_name);
    const costMap = biz === 'takeaway' ? cm.mapTakeaway : biz === 'dinein' ? cm.mapDinein : null;
    let unit = costMap?.get(dk);
    if (unit == null) unit = cm.mapTakeaway.get(dk) ?? cm.mapDinein.get(dk) ?? cm.mapAny.get(dk);
    if (unit == null || !Number.isFinite(unit)) continue;
    const profit = revenue - qty * unit;
    if (!Number.isFinite(profit)) continue;
    const catName = String(r.category || '未分类').trim() || '未分类';
    const code = r.category_code ? String(r.category_code).trim() : '';
    const catDisplay = code ? `${catName}（大类编码 ${code}）` : catName;
    dishItems.push({
      store: r.store,
      channel: bizChannelZh(r.biz_type),
      catDisplay,
      dish: r.dish_name,
      qty,
      revenue,
      profit
    });
  }

  /** store||channel -> Map(catDisplay -> dishes[]) */
  const byGroup = new Map();
  for (const it of dishItems) {
    const gk = `${it.store}||${it.channel}`;
    if (!byGroup.has(gk)) byGroup.set(gk, new Map());
    const cm = byGroup.get(gk);
    if (!cm.has(it.catDisplay)) cm.set(it.catDisplay, []);
    cm.get(it.catDisplay).push(it);
  }

  let md = `## ${reportTitle}\n\n`;
  md += `**统计周期**：${start} ～ ${end}（Asia/Shanghai）\n\n`;
  md +=
    '> **划分规则**：`sales_raw` 按 **大类名称**（及 **大类编码** `category_code`，有则展示）分组 → 在每个大类内对**有成本匹配的单品**用「销量中位数 × 利润额中位数」划四象限：**明细 / 引流 / 潜力 / 淘汰**；每象限最多 **5** 道菜（按销量降序）。\n';
  md += '> 成本来源：**飞书 `dish_library_costs`**；毛利率 = 利润额 ÷ 销额。\n\n';

  const keys = [...byGroup.keys()].sort();
  for (const gk of keys) {
    const [store, ch] = gk.split('||');
    const catMap = byGroup.get(gk);
    const catKeys = [...catMap.keys()].sort((a, b) => {
      const sum = (k) => catMap.get(k).reduce((s, d) => s + d.qty, 0);
      return sum(b) - sum(a);
    });
    md += `### ${store} · ${ch}\n\n`;
    for (const catDisplay of catKeys) {
      const dishes = catMap.get(catDisplay);
      md += `#### 🏷 ${catDisplay}\n\n`;
      if (dishes.length < 2) {
        md += dishes
          .slice()
          .sort((a, b) => b.qty - a.qty)
          .map(fmtDishLine)
          .join('\n');
        md += '\n\n_本大类仅有 1 道可匹配成本的菜品，不做四象限划分。_\n\n';
        continue;
      }
      const { star, traffic, potential, eliminate } = classifyByQtyProfit(dishes);
      md += formatDishQuadrantBlock('star', star);
      md += formatDishQuadrantBlock('traffic', traffic);
      md += formatDishQuadrantBlock('potential', potential);
      md += formatDishQuadrantBlock('eliminate', eliminate);
    }
    md += '---\n\n';
  }

  if (!keys.length) {
    md +=
      '⚠️ **本周期无「销售明细 × 菜品库成本」可对齐的数据。**\n请确认已导入 `sales_raw`（含 `category` / `category_code`），且 `dish_library_costs` 已同步。\n';
  }

  return md.trimEnd();
}

function splitMarkdownChunks(md, maxLen = 3400) {
  if (md.length <= maxLen) return [md];
  const lines = md.split('\n');
  const out = [];
  let cur = '';
  for (const line of lines) {
    const add = cur ? `${cur}\n${line}` : line;
    if (add.length > maxLen && cur) {
      out.push(cur);
      cur = line;
    } else {
      cur = add;
    }
  }
  if (cur) out.push(cur);
  return out;
}

async function sendDishOptimizationCardsToHq(fullMd, cardHeaderTitle) {
  const hq = await query(
    `SELECT open_id, username FROM feishu_users WHERE registered = true AND open_id IS NOT NULL AND role IN ('admin','hq_manager') AND open_id NOT LIKE '%probe%'`
  );
  const chunks = splitMarkdownChunks(fullMd, 3400);
  const n = chunks.length;
  let sent = 0;
  const runYmd = getShanghaiYmd();

  for (const h of hq.rows || []) {
    if (!h.open_id) continue;
    for (let i = 0; i < n; i++) {
      const title = n > 1 ? `${cardHeaderTitle}（${i + 1}/${n}）` : cardHeaderTitle;
      const card = {
        config: { wide_screen_mode: true },
        header: {
          title: { tag: 'plain_text', content: title.slice(0, 100) },
          template: 'blue'
        },
        elements: [
          { tag: 'div', text: { tag: 'lark_md', content: chunks[i].slice(0, 9800) } },
          { tag: 'div', text: { tag: 'lark_md', content: '_数据来源：`sales_raw`（大类/编码）+ `dish_library_costs` · 大类内单品四象限_' } }
        ]
      };
      try {
        const deliver = await sendReportToRecipient({
          jobKey: 'dish_optimization_report',
          runYmd,
          username: h.username || h.open_id,
          scope: `chunk_${i}`,
          sendFn: async () => {
            const res = await sendCard(h.open_id, card, 'open_id');
            return { ok: !!res?.ok, error: res?.error || '' };
          }
        });
        if (deliver?.ok) sent++;
      } catch (e) {
        logger.warn({ err: e?.message, u: h.username }, 'dish optimization card send failed');
      }
    }
  }
  return sent;
}

export async function sendWeeklyDishOptimizationReport() {
  const { weekStart, weekEnd } = shanghaiLastCompletedWeekBounds();
  const md = await buildDishOptimizationMarkdown({
    start: weekStart,
    end: weekEnd,
    reportTitle: `🍽 菜品优化周报（${weekStart}～${weekEnd}）`
  });
  const sent = await sendDishOptimizationCardsToHq(md, `🍽 菜品优化周报 ${weekStart}～${weekEnd}`);
  logger.info({ weekStart, weekEnd, sent }, 'dish optimization weekly report sent');
  return { ok: true, weekStart, weekEnd, sent };
}

export async function sendMonthlyDishOptimizationReport(period) {
  period = period || prevMonthPeriod();
  const { start, end } = monthDateRange(period);
  const md = await buildDishOptimizationMarkdown({
    start,
    end,
    reportTitle: `🍽 ${period} 菜品优化月报`
  });
  const sent = await sendDishOptimizationCardsToHq(md, `🍽 ${period} 菜品优化月报`);
  logger.info({ period, sent }, 'dish optimization monthly report sent');
  return { ok: true, period, sent };
}