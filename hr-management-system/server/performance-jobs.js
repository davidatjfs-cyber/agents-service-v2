/**
 * 月度绩效闭环 + 菜品优化报告（飞书卡片）
 * - 每月 10 日 01:00（上海）：上月 employee_scores + store_ratings + agent_scores(YYYY-MM)（与毛利率等关账口径对齐）
 * - 每月 10 日 08:00（上海）：绩效摘要文本（个人）→ 各岗位；管理员全员汇总文本已停用（与 agents 月度评级汇总卡重复）
 * - 每月 1 日 08:00（上海）：**上月整月**菜品优化月报（卡片）→ admin/hq_manager（失败则飞书通知管理员）
 * - 每周一 08:00–11:59（上海）：**上周 Mon–Sun** 菜品优化周报（卡片）→ admin/hq_manager（失败则通知管理员）
 *
 * 菜品四象限（按门店 × 堂食/外卖 分别计算）：
 * - 横轴：销量 = SUM(qty)；纵轴：利润额 = SUM(revenue) − SUM(qty×单位成本)（非利润率）
 * - 明星 = 高销量 + 高利润额；引流 = 高销量 + 低利润额；潜力 = 低销量 + 高利润额；淘汰 = 低销量 + 低利润额
 * - 成本来源：dish_library_costs（含门店/通配、biz_type 对齐堂食与外卖）
 */
import {
  pool,
  lookupFeishuUserByUsername,
  sendLarkMessage,
  sendLarkCard,
  inferBrandFromStoreName
} from './agents.js';
import { calculateStoreRating, calculateEmployeeScore } from './new-scoring-model.js';
import {
  dailyReportIlikePatterns,
  feishuStoreSearchPatterns,
  resolveAgentCanonicalStore
} from './v2-store-alignment.js';

function roleLabelZh(r) {
  const x = String(r || '').trim();
  if (x === 'store_manager') return '店长';
  if (x === 'store_production_manager') return '出品经理';
  return x || '未知';
}

/** 飞书展示：避免「店—」与「店一」混淆，缺数据用「暂无」 */
function fmtStoreLevelLabel(v) {
  const s = String(v ?? '').trim();
  if (!s || s === '—' || s === '-') return '暂无';
  if (/^[ABCD]$/i.test(s)) return `店${s.toUpperCase()}`;
  return s;
}

/** 上海日历与钟点（避免 new Date(toLocaleString) 解析问题） */
function shanghaiCalendar(now = new Date()) {
  const ymd = now.toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Shanghai',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).formatToParts(now);
  const hour = parseInt(parts.find((p) => p.type === 'hour')?.value || '0', 10);
  const minute = parseInt(parts.find((p) => p.type === 'minute')?.value || '0', 10);
  const [y, m, d] = ymd.split('-').map((x) => parseInt(x, 10));
  return { ymd, y, m, d, hour, minute };
}

function isShanghaiMonday(now = new Date()) {
  const wd = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Shanghai', weekday: 'short' }).format(now);
  return wd === 'Mon';
}

function addDaysYmd(ymd, deltaDays) {
  const t = new Date(`${ymd}T12:00:00+08:00`);
  t.setUTCDate(t.getUTCDate() + deltaDays);
  return t.toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
}

/** 上周一～上周日（在「当前上海日期为周一」的定时任务内调用：上周 = 昨天往前推 6 天～昨天） */
function lastWeekMonSunYmd(shanghaiYmdToday) {
  const yesterday = addDaysYmd(shanghaiYmdToday, -1);
  const weekEnd = yesterday;
  const weekStart = addDaysYmd(weekEnd, -6);
  return { start: weekStart, end: weekEnd };
}

/** 供 HTTP 手动补发：按当前上海日历取「刚结束的一周」周一～周日 */
export function getLastCompletedWeekRangeShanghai() {
  const cal = shanghaiCalendar();
  return lastWeekMonSunYmd(cal.ymd);
}

function prevMonthPeriod(cal) {
  const pm = cal.m === 1 ? 12 : cal.m - 1;
  const py = cal.m === 1 ? cal.y - 1 : cal.y;
  return `${py}-${String(pm).padStart(2, '0')}`;
}

export function getExpectedMonthlyPerformancePeriodShanghai(now = new Date()) {
  return prevMonthPeriod(shanghaiCalendar(now));
}

function monthDateRange(period) {
  const [yy, mm] = period.split('-').map((x) => parseInt(x, 10));
  const start = `${yy}-${String(mm).padStart(2, '0')}-01`;
  const last = new Date(yy, mm, 0);
  const end = `${yy}-${String(mm).padStart(2, '0')}-${String(last.getDate()).padStart(2, '0')}`;
  return { start, end };
}

function normalizeStoreKey(s) {
  return String(s || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '');
}

/**
 * 月度关账写入 agent_scores：排除测试/误绑账号；马己仙每店仅保留一名出品经理（黎永荣 NNYXLYR04 优先），
 * 与 agents-service 月度绩效成绩单、周度 scoring-assignee 口径一致。
 */
function filterUsersForMonthlyPerformanceClose(rows) {
  const filtered = (rows || []).filter((u) => {
    const un = String(u.username || '').trim();
    const nm = String(u.name || '').trim();
    if (!un) return false;
    if (un.toLowerCase() === 'nnyxcs35') return false;
    if (nm.includes('测试') || un.includes('测试')) return false;
    return true;
  });

  const majixianPmByStore = new Map();
  const rest = [];
  for (const u of filtered) {
    const st = String(u.store || '');
    if (u.role === 'store_production_manager' && /马己仙/.test(st)) {
      const k = normalizeStoreKey(u.store);
      const un = String(u.username || '').trim().toLowerCase();
      const nm = String(u.name || '').trim();
      const rank = un === 'nnyxlyr04' ? 0 : nm.includes('黎永荣') ? 1 : 50;
      const prev = majixianPmByStore.get(k);
      if (!prev || rank < prev.rank) majixianPmByStore.set(k, { rank, u });
    } else {
      rest.push(u);
    }
  }
  return [...rest, ...[...majixianPmByStore.values()].map((x) => x.u)];
}

export async function countEligibleMonthlyPerformanceUsers() {
  const users = await pool().query(
    `SELECT username,
            COALESCE(NULLIF(TRIM(name), ''), username) AS name,
            TRIM(store) AS store,
            role
     FROM feishu_users
     WHERE registered = true
       AND role IN ('store_manager', 'store_production_manager')
       AND TRIM(COALESCE(store, '')) <> ''`
  );
  return filterUsersForMonthlyPerformanceClose(users.rows || []).length;
}

function bizChannel(biz) {
  const x = String(biz || '').toLowerCase();
  if (x.includes('take') || x.includes('外卖') || x === 'waimai') return '外卖';
  return '堂食';
}

function normDish(n) {
  return String(n || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '');
}

let _slotMonthlyCalc = '';
let _slotMonthlyPush = '';
let _slotDishMonthlyDay1 = '';
let _slotDishWeekly = '';

/** 失败时通知 admin/hq_manager（与 agents-service runWithCronLog 告警风格一致） */
async function notifyHrmsPerfAdmins(taskName, err) {
  const msg = String(err?.message || err || '未知错误').slice(0, 500);
  const cal = shanghaiCalendar();
  const timeStr = `${cal.ymd} ${String(cal.hour).padStart(2, '0')}:${String(cal.minute).padStart(2, '0')}`;
  const text =
    `⚠️ 【HRMS 定时任务失败】\n任务：${taskName}\n时间：${timeStr}（上海）\n错误：${msg}\n\n请检查服务日志并在必要时联系运维补跑或补发。`;
  try {
    const hq = await pool().query(
      `SELECT username FROM feishu_users WHERE registered = true AND role IN ('admin','hq_manager') AND open_id NOT LIKE '%probe%'`
    );
    for (const h of hq.rows || []) {
      const fu = await lookupFeishuUserByUsername(h.username);
      if (!fu?.open_id) continue;
      await sendLarkMessage(fu.open_id, text).catch(() => {});
    }
  } catch (e) {
    console.error('[perf-jobs] notifyHrmsPerfAdmins failed', e?.message || e);
  }
}

export async function runMonthlyPerformanceClose() {
  const cal = shanghaiCalendar();
  const period = prevMonthPeriod(cal);
  const users = await pool().query(
    `SELECT username,
            COALESCE(NULLIF(TRIM(name), ''), username) AS name,
            TRIM(store) AS store,
            role
     FROM feishu_users
     WHERE registered = true
       AND role IN ('store_manager', 'store_production_manager')
       AND TRIM(COALESCE(store, '')) <> ''`
  );
  const eligible = filterUsersForMonthlyPerformanceClose(users.rows || []);
  const seen = new Set();
  for (const u of eligible) {
    const store = u.store;
    const k = normalizeStoreKey(store);
    if (seen.has(k)) continue;
    seen.add(k);
    const brand = inferBrandFromStoreName(store);
    await calculateStoreRating(store, brand, period);
  }

  for (const u of eligible) {
    const store = u.store;
    const brand = inferBrandFromStoreName(store);
    const es = await calculateEmployeeScore(store, u.username, u.role, period);
    const canon = String(resolveAgentCanonicalStore(store) || store).trim();
    const pats = [...new Set([
      ...dailyReportIlikePatterns(store),
      ...feishuStoreSearchPatterns(store),
      ...dailyReportIlikePatterns(canon),
      ...feishuStoreSearchPatterns(canon)
    ])];
    let sr = { rows: [] };
    for (const key of [canon, store].filter((k, i, a) => k && a.indexOf(k) === i)) {
      sr = await pool().query(
        `SELECT rating FROM store_ratings WHERE store = $1 AND period = $2 LIMIT 1`,
        [key, period]
      );
      if (sr.rows?.length) break;
    }
    if (!sr.rows?.length) {
      sr = await pool().query(
        `SELECT rating FROM store_ratings
         WHERE period = $1 AND store ILIKE ANY($2::text[])
         ORDER BY (actual_revenue > 0) DESC,
           actual_revenue DESC NULLS LAST,
           LENGTH(store) DESC NULLS LAST
         LIMIT 1`,
        [period, pats]
      );
    }
    const storeRating = sr.rows?.[0]?.rating ?? null;
    const breakdown = {
      execution_rating: es.execution_rating,
      attitude_rating: es.attitude_rating,
      ability_rating: es.ability_rating,
      store_rating: storeRating
    };
    const deductions = [];
    const summary = `月度自动评分（${period}）：执行力 ${es.execution_rating || '—'}，态度 ${es.attitude_rating || '—'}，能力 ${es.ability_rating || '—'}，门店 ${fmtStoreLevelLabel(storeRating)}。`;
    try {
      await pool().query(
        `INSERT INTO agent_scores (brand, store, username, name, role, period, score_model, total_score, breakdown, deductions, summary)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11)
         ON CONFLICT (brand, store, username, period)
         DO UPDATE SET
           name = EXCLUDED.name,
           total_score = EXCLUDED.total_score,
           breakdown = EXCLUDED.breakdown,
           deductions = EXCLUDED.deductions,
           summary = EXCLUDED.summary,
           feishu_notified = FALSE,
           updated_at = NOW()`,
        [
          brand,
          store,
          u.username,
          u.name,
          u.role,
          period,
          'new_model_monthly',
          es.total_score,
          JSON.stringify(breakdown),
          JSON.stringify(deductions),
          summary
        ]
      );
    } catch (e) {
      console.error('[perf-jobs] upsert agent_scores monthly failed:', u.username, e?.message);
    }
  }
  console.log('[perf-jobs] monthly close done', period, 'eligible_users', eligible.length);
  return { period, users: (users.rows || []).length };
}

async function sendFeishuPerformanceDigest(period) {
  const rows = await pool().query(
    `SELECT username, name, store, role, total_score, breakdown, summary
     FROM agent_scores
     WHERE period = $1 AND score_model = 'new_model_monthly'
     ORDER BY store, role`,
    [period]
  );
  const title = `📊 ${period} 月度绩效评估`;
  for (const row of rows.rows || []) {
    const fu = await lookupFeishuUserByUsername(row.username);
    if (!fu?.open_id) continue;
    const b = row.breakdown && typeof row.breakdown === 'object' ? row.breakdown : {};
    const text =
      `${title}\n\n${fu.name || row.username}，${row.store}\n\n` +
      `绩效得分：${row.total_score}\n` +
      `执行力：${b.execution_rating || '—'}\n` +
      `工作态度：${b.attitude_rating || '—'}\n` +
      `工作能力：${b.ability_rating || '—'}\n` +
      `门店级别：${fmtStoreLevelLabel(b.store_rating)}\n\n` +
      `${row.summary || ''}\n\n如有异议请回复「申诉」说明原因。`;
    await sendLarkMessage(fu.open_id, text).catch(() => {});
  }

  // 管理员侧「全员汇总」文本已移除：与 agents-service 每月 10 日「月度评级汇总」飞书卡片重复，避免噪音。
  await pool().query(
    `UPDATE agent_scores SET feishu_notified = TRUE
     WHERE period = $1 AND score_model = 'new_model_monthly'`,
    [period]
  ).catch(() => {});
}

async function loadDishCostsForStores(storeNames) {
  const keys = [...new Set(storeNames.map(normalizeStoreKey).filter(Boolean))];
  if (!keys.length) return new Map();
  const r = await pool().query(
    `SELECT store, biz_type, dish_name, unit_cost
     FROM dish_library_costs
     WHERE enabled = true AND (lower(regexp_replace(coalesce(store,''), '\\s+', '', 'g')) = ANY($1) OR store = '*')`,
    [keys]
  );
  const m = new Map();
  for (const row of r.rows || []) {
    const sk = normalizeStoreKey(row.store === '*' ? '' : row.store);
    const biz = String(row.biz_type || '').trim().toLowerCase();
    const dk = normDish(row.dish_name);
    const c = Number(row.unit_cost);
    if (!dk || !Number.isFinite(c) || c < 0) continue;
    m.set(`${sk}||${biz}||${dk}`, c);
    m.set(`${sk}||||${dk}`, c);
    m.set(`||${biz}||${dk}`, c);
    m.set(`||||${dk}`, c);
  }
  return m;
}

function costFor(m, store, bizRaw, dish) {
  const sk = normalizeStoreKey(store);
  const biz = String(bizRaw || '').trim().toLowerCase();
  const dk = normDish(dish);
  return (
    m.get(`${sk}||${biz}||${dk}`) ??
    m.get(`${sk}||||${dk}`) ??
    m.get(`||${biz}||${dk}`) ??
    m.get(`||||${dk}`) ??
    null
  );
}

function medianThreshold(getVal, arr) {
  if (!arr.length) return 0;
  const vals = arr.map(getVal).filter((v) => Number.isFinite(v));
  if (!vals.length) return 0;
  const s = [...vals].sort((a, b) => a - b);
  const n = s.length;
  if (n % 2 === 1) return s[Math.floor(n / 2)];
  return (s[n / 2 - 1] + s[n / 2]) / 2;
}

/** 象限内：营运 + 营销 可执行建议（非利润率口径，利润额已在行内展示） */
function quadrantGuidance(q) {
  if (q === 'star') {
    return (
      '**营运**：锁定 SOP 与备餐基准量，高峰前预制备，减少断货；周复盘口味稳定性。\n' +
      '**营销**：作为套餐主菜/点评头图与「必点」话术；会员加购、第二份小折扣提升客单。'
    );
  }
  if (q === 'traffic') {
    return (
      '**营运**：拆解原料与包材成本，谈判供货或微调规格/配方；设外卖出餐动线专位降人工秒数。\n' +
      '**营销**：明确「引流款」定位，控制折扣深度；捆绑高利润配菜/饮料，避免长期负毛利冲量。'
    );
  }
  if (q === 'potential') {
    return (
      '**营运**：备量保守、先以试销清单管理；培训服务员 2 句推荐话术与搭配理由。\n' +
      '**营销**：店内海报/桌贴/电子屏曝光；企微社群限时试吃券；套餐中「加购价」试推一周看转化。'
    );
  }
  return (
    '**营运**：评估下架或替换；清仓阶梯价清库存，减少占菜单位与备料资金。\n' +
    '**营销**：不做主推与流量投放；若保留仅作凑单小份装，避免占用套餐与广告位。'
  );
}

function classifyByQtyProfit(arr) {
  if (arr.length < 2) {
    return { star: [], traffic: [], potential: [], eliminate: [], sparse: arr };
  }
  const midQty = medianThreshold((x) => x.qty, arr);
  const midProf = medianThreshold((x) => x.profit, arr);
  const star = [];
  const traffic = [];
  const potential = [];
  const eliminate = [];
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

function formatDishLines(list) {
  return list
    .slice(0, 8)
    .map(
      (x) =>
        `· **${x.dish}** 销量 **${Math.round(x.qty)}** 份｜销额 ¥${x.revenue.toFixed(0)}｜**利润额 ¥${x.profit.toFixed(0)}**`
    )
    .join('\n');
}

function formatQuadrantBlock(titleZh, list, q) {
  const g = quadrantGuidance(q);
  const lines = formatDishLines(list);
  if (!lines) return `**${titleZh}**\n_（无）_\n\n${g}\n`;
  return `**${titleZh}**\n${lines}\n\n${g}\n`;
}

function buildDishOptimizationMarkdown({ start, end, reportTitle }) {
  return (async () => {
    const agg = await pool().query(
      `SELECT store, biz_type, dish_name,
              SUM(qty)::numeric AS qty,
              SUM(revenue)::numeric AS revenue
       FROM sales_raw
       WHERE date >= $1::date AND date <= $2::date AND COALESCE(dish_name,'') <> ''
       GROUP BY store, biz_type, dish_name`,
      [start, end]
    );
    const stores = [...new Set((agg.rows || []).map((r) => r.store).filter(Boolean))];
    const costMap = await loadDishCostsForStores(stores);
    const items = [];
    for (const r of agg.rows || []) {
      const qty = Number(r.qty || 0);
      const revenue = Number(r.revenue || 0);
      if (qty <= 0 || revenue <= 0) continue;
      const uc = costFor(costMap, r.store, r.biz_type, r.dish_name);
      if (uc == null || !Number.isFinite(uc)) continue;
      const profit = revenue - qty * uc;
      if (!Number.isFinite(profit)) continue;
      items.push({
        store: r.store,
        channel: bizChannel(r.biz_type),
        dish: r.dish_name,
        qty,
        revenue,
        profit
      });
    }

    const byKey = new Map();
    for (const it of items) {
      const k = `${it.store}||${it.channel}`;
      if (!byKey.has(k)) byKey.set(k, []);
      byKey.get(k).push(it);
    }

    let md = `## ${reportTitle}\n\n`;
    md += `**统计周期**：${start} ～ ${end}（Asia/Shanghai）\n\n`;
    md +=
      '> **划分规则**：按「门店 × 堂食/外卖」分别取菜；**高/低销量**相对该组内销量中位数；**高/低利润**相对该组内**利润额（销额−销量×菜品库单位成本）**中位数（非利润率）。\n';
    md += '> 成本来源：**飞书同步表 `dish_library_costs`**（门店匹配 + 通配 `*`，`biz_type` 对齐堂食/外卖）。\n\n';

    const keys = [...byKey.keys()].sort();
    for (const k of keys) {
      const [store, ch] = k.split('||');
      const arr = byKey.get(k);
      md += `### ${store} · ${ch}\n\n`;
      const { star, traffic, potential, eliminate, sparse } = classifyByQtyProfit(arr);
      if (sparse.length === 1) {
        const x = sparse[0];
        md += `_本组仅有 1 道菜品匹配到成本，无法做四象限中位数划分，仅列事实：_\n`;
        md += `· **${x.dish}** 销量 **${Math.round(x.qty)}**｜销额 ¥${x.revenue.toFixed(0)}｜利润额 ¥${x.profit.toFixed(0)}\n\n`;
      } else if (sparse.length === 0) {
        md += formatQuadrantBlock('⭐ 明星产品（高销量 · 高利润额）', star, 'star');
        md += formatQuadrantBlock('🔻 引流产品（高销量 · 低利润额）', traffic, 'traffic');
        md += formatQuadrantBlock('📈 潜力产品（低销量 · 高利润额）', potential, 'potential');
        md += formatQuadrantBlock('🗑 淘汰产品（低销量 · 低利润额）', eliminate, 'eliminate');
      }
      md += '---\n\n';
    }

    if (keys.length === 0) {
      md +=
        '⚠️ **本周期无「销售明细 × 菜品库成本」可对齐的数据。**\n请确认已导入 `sales_raw`，且 `dish_library_costs` 已同步飞书菜品库/外卖菜品库成本。\n';
    }

    return md.trimEnd();
  })();
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

async function sendDishReportCardsToHq(fullMd, cardHeaderTitle) {
  const hq = await pool().query(
    `SELECT username FROM feishu_users WHERE registered = true AND role IN ('admin','hq_manager') AND open_id NOT LIKE '%probe%'`
  );
  const chunks = splitMarkdownChunks(fullMd, 3400);
  const n = chunks.length;
  for (const h of hq.rows || []) {
    const fu = await lookupFeishuUserByUsername(h.username);
    if (!fu?.open_id) continue;
    for (let i = 0; i < n; i++) {
      const title = n > 1 ? `${cardHeaderTitle}（${i + 1}/${n}）` : cardHeaderTitle;
      const card = {
        config: { wide_screen_mode: true },
        header: {
          title: { tag: 'plain_text', content: title.slice(0, 100) },
          template: 'blue'
        },
        elements: [
          {
            tag: 'div',
            text: { tag: 'lark_md', content: chunks[i].slice(0, 9800) }
          },
          {
            tag: 'div',
            text: {
              tag: 'lark_md',
              content: '_数据来源：`sales_raw` + `dish_library_costs`（飞书菜品库/外卖库成本）_'
            }
          }
        ]
      };
      await sendLarkCard(fu.open_id, card).catch((e) =>
        console.error('[perf-jobs] sendLarkCard failed', h.username, e?.message || e)
      );
    }
  }
}

export async function sendMonthlyDishOptimizationReport(period) {
  const { start, end } = monthDateRange(period);
  const title = `🍽 ${period} 菜品优化月报`;
  try {
    const modUrl = new URL('../../agents-service-v2/src/services/dish-optimization-report.js', import.meta.url);
    const mod = await import(modUrl.href);
    if (typeof mod.buildDishOptimizationMarkdown === 'function') {
      const md = await mod.buildDishOptimizationMarkdown({ start, end, reportTitle: title });
      await sendDishReportCardsToHq(md, title);
      console.log('[perf-jobs] dish MONTHLY (agents builder)', period);
      return;
    }
  } catch (e) {
    console.warn('[perf-jobs] agents dish-optimization import failed, fallback:', e?.message || e);
  }
  const md = await buildDishOptimizationMarkdown({ start, end, reportTitle: title });
  await sendDishReportCardsToHq(md, title);
  console.log('[perf-jobs] dish MONTHLY cards sent for', period);
}

export async function sendWeeklyDishOptimizationReport(weekStart, weekEnd) {
  const title = `🍽 菜品优化周报（${weekStart}～${weekEnd}）`;
  try {
    const modUrl = new URL('../../agents-service-v2/src/services/dish-optimization-report.js', import.meta.url);
    const mod = await import(modUrl.href);
    if (typeof mod.buildDishOptimizationMarkdown === 'function') {
      const md = await mod.buildDishOptimizationMarkdown({
        start: weekStart,
        end: weekEnd,
        reportTitle: title
      });
      await sendDishReportCardsToHq(md, `🍽 菜品优化周报 ${weekStart}～${weekEnd}`);
      console.log('[perf-jobs] dish WEEKLY (agents builder)', weekStart, weekEnd);
      return;
    }
  } catch (e) {
    console.warn('[perf-jobs] agents dish-optimization import failed, fallback:', e?.message || e);
  }
  const md = await buildDishOptimizationMarkdown({
    start: weekStart,
    end: weekEnd,
    reportTitle: title
  });
  await sendDishReportCardsToHq(md, `🍽 菜品优化周报 ${weekStart}～${weekEnd}`);
  console.log('[perf-jobs] dish WEEKLY cards sent (local fallback)', weekStart, weekEnd);
}

export function startHrmsPerformanceJobs(options = {}) {
  const onHeartbeat = typeof options?.onHeartbeat === 'function' ? options.onHeartbeat : null;
  if (String(process.env.DISABLE_HRMS_PERFORMANCE_JOBS || '').toLowerCase() === 'true') {
    console.log('[perf-jobs] DISABLE_HRMS_PERFORMANCE_JOBS=true — skipped');
    return;
  }
  setInterval(async () => {
    try {
      if (onHeartbeat) {
        await onHeartbeat('hrms_performance_jobs_tick');
      }
      const cal = shanghaiCalendar();
      const { y, m, d, hour, minute } = cal;
      const slotBase = `${y}-${m}-${d}_${hour}`;

      // 2026-04 起：月度绩效统一由 agents-service-v2 monthly-comprehensive-rating 生成并发送。
      // HRMS runMonthlyPerformanceClose/sendFeishuPerformanceDigest 若继续运行，会与 agents 月报并行写库/发卡，造成错分与重复。

      if (hour === 8 && minute < 12) {
        // 菜品优化周/月报默认由 agents-service-v2 rhythm-engine 发送；仅当 HRMS_ENABLE_DISH_OPTIMIZATION_CRON=true 时本进程才发，避免双发与旧版式
        const hrmsDishCron = String(process.env.HRMS_ENABLE_DISH_OPTIMIZATION_CRON || '').toLowerCase() === 'true';
        // 每月 1 日：上月菜品优化月报（原误配在 10 日与关账同日，现按业务约定改到月初）
        if (hrmsDishCron && d === 1) {
          const moKey = `dish-mo1-${slotBase}`;
          if (_slotDishMonthlyDay1 !== moKey) {
            _slotDishMonthlyDay1 = moKey;
            const period = prevMonthPeriod(cal);
            try {
              await sendMonthlyDishOptimizationReport(period);
            } catch (e) {
              console.error('[perf-jobs] monthly dish report failed', e?.message || e);
              await notifyHrmsPerfAdmins(`菜品优化月报（每月1日·${period}）`, e);
            }
          }
        }

        // legacy monthly digest disabled — agents-service-v2 owns monthly score delivery

        // 周一 8:00–11:59 任意 5 分钟 tick 触发一次（原仅 minute<12 易在 8:15 重启等服务错过整周）
        if (hrmsDishCron && isShanghaiMonday() && hour >= 8 && hour < 12) {
          const daySlot = `wk-${cal.ymd}`;
          if (_slotDishWeekly !== daySlot) {
            _slotDishWeekly = daySlot;
            const { start: wkStart, end: wkEnd } = lastWeekMonSunYmd(cal.ymd);
            try {
              await sendWeeklyDishOptimizationReport(wkStart, wkEnd);
            } catch (e) {
              console.error('[perf-jobs] weekly dish report failed', e?.message || e);
              await notifyHrmsPerfAdmins(`菜品优化周报（${wkStart}～${wkEnd}）`, e);
            }
          }
        }
      }
    } catch (e) {
      console.error('[perf-jobs] tick error:', e?.message || e);
      await notifyHrmsPerfAdmins('HRMS 绩效/菜品调度 tick', e);
    }
  }, 5 * 60 * 1000);
  console.log(
    '[perf-jobs] scheduler on (5m tick): monthly close 10th 01:00; digest 10th 08:00; dish reports: only if HRMS_ENABLE_DISH_OPTIMIZATION_CRON=true (else agents-service-v2)'
  );
}

/** 文档/运维：本模块内向管理员发飞书失败告警的任务名（与代码 try/catch 一致） */
export const HRMS_PERF_FAILURE_ALERT_TASKS = [
  '月度绩效关账（每月10日01:00）',
  '月度绩效摘要推送（每月10日·上月周期）',
  '菜品优化月报（每月1日·上月周期）',
  '菜品优化周报（上周一～日）',
  'HRMS 绩效/菜品调度 tick'
];
