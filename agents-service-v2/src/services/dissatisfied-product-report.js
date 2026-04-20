/**
 * 不满意产品日报 / 周报 / 月报
 *
 * 数据源：feishu_generic_records WHERE config_key='table_visit'
 * 关键字段：不满意产品负责的档口（新数据为责任人姓名）、今天不满意菜品、不满意的主要原因是什么
 *
 * 维度：按「产品责任人」分组（档口→责任人映射或直接读取责任人姓名）
 * 发送：
 *   - 本门店汇总 → 店长 + 出品经理
 *   - 所有门店汇总 → admin + hq_manager
 *
 * 定时：日22:00 / 周一09:00（上周） / 月1日09:00（上月）
 */
import { query } from '../utils/db.js';
import { logger } from '../utils/logger.js';
import { sendCard, sendText } from './feishu-client.js';
import { sendReportToRecipient, getShanghaiYmd } from './report-delivery.js';
import { getShanghaiYmdParts, addDaysYmdShanghai, shanghaiLastCompletedWeekBounds } from '../utils/anomaly-week-bounds.js';
import { feishuStoreSearchPatterns } from '../utils/store-sql-patterns.js';
import { expandAgentStoreLabels } from '../config/store-mapping.js';

// ─── 档口→责任人映射 ───
const STALL_PERSON_MAP = {
  '洪潮大宁久光店': {
    '郑礼烨': '砧板',
    '陈志华': '炒锅',
    '杨航': '煲仔',
    '陈文轩': '打荷',
    '蒋登华': '炒锅',
    '徐文杰': '上什',
    '杨瑞': '卤水',
    '黎华容': '炒锅',
    '侯继龙': '刺身',
    '罗兴东': '打荷',
  },
  '马己仙上海音乐广场店': {
    '余伟': '炒锅',
    '李佳庚': '煲仔',
    '陈林': '煲仔',
    '李星星': '水吧',
    '陈灿文': '烧味',
    '文沛华': '炒锅',
    '王峰': '砧板',
  },
};

const ALL_PERSONS = {};
for (const [store, map] of Object.entries(STALL_PERSON_MAP)) {
  for (const [person, stall] of Object.entries(map)) {
    const key = `${store}||${person}`;
    ALL_PERSONS[key] = { store, person, stall };
  }
}

const ALL_STALLS = new Set();
for (const map of Object.values(STALL_PERSON_MAP)) {
  for (const stall of Object.values(map)) ALL_STALLS.add(stall);
}

function resolvePersonAndStall(storeRaw, fieldVal) {
  const store = resolveStoreKey(storeRaw);
  const val = String(fieldVal || '').trim();
  if (!val) return { person: '未分配', stall: '未知' };

  const storeMap = STALL_PERSON_MAP[store] || {};

  if (storeMap[val]) {
    return { person: val, stall: storeMap[val] };
  }

  for (const [p, s] of Object.entries(storeMap)) {
    if (s === val) {
      return { person: `${val}(待确认)`, stall: val };
    }
  }

  if (ALL_STALLS.has(val)) {
    return { person: `${val}(待确认)`, stall: val };
  }

  return { person: val, stall: storeMap[val] || '未知' };
}

function resolveStoreKey(raw) {
  const s = String(raw || '').trim().toLowerCase().replace(/\s/g, '');
  if (s.includes('洪潮') || s.includes('久光')) return '洪潮大宁久光店';
  if (s.includes('马己仙') || s.includes('马已仙') || s.includes('大宁')) return '马己仙上海音乐广场店';
  return String(raw || '').trim();
}

function extractDishNames(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) {
    const out = [];
    for (const item of raw) {
      if (typeof item === 'string') {
        out.push(...item.split(/[,，、;]/).map(x => x.trim()).filter(Boolean));
      } else if (item && typeof item === 'object') {
        const t = item.text || '';
        if (t) out.push(...t.split(/[,，、;]/).map(x => x.trim()).filter(Boolean));
        if (item.text_arr && Array.isArray(item.text_arr)) {
          for (const ta of item.text_arr) {
            if (ta) out.push(...ta.split(/[,，、;]/).map(x => x.trim()).filter(Boolean));
          }
        }
      }
    }
    return [...new Set(out)];
  }
  return String(raw).split(/[,，、;]/).map(x => x.trim()).filter(Boolean);
}

function ext(v) {
  if (v == null) return '';
  if (Array.isArray(v)) return v.map(x => (typeof x === 'object' && x?.text) || String(x)).join(', ');
  if (typeof v === 'object' && v.text) return String(v.text);
  return String(v || '').trim();
}

function bitableDate(v, fallback) {
  if (!v) return '';
  if (typeof v === 'number') {
    if (v > 1e12) {
      const dt = new Date(v);
      return dt.toLocaleString('en-CA', { timeZone: 'Asia/Shanghai' }).slice(0, 10);
    }
    const dt = new Date((v - 25569) * 86400000);
    return dt.toLocaleString('en-CA', { timeZone: 'Asia/Shanghai' }).slice(0, 10);
  }
  const s = String(v).slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  if (fallback) {
    const fb = new Date(fallback);
    return fb.toLocaleString('en-CA', { timeZone: 'Asia/Shanghai' }).slice(0, 10);
  }
  return '';
}

async function fetchDissatisfiedEntries(startYmd, endYmd) {
  const r = await query(
    `SELECT fields, created_at FROM feishu_generic_records
     WHERE config_key = 'table_visit'
       AND (created_at >= NOW() - INTERVAL '120 days' OR updated_at >= NOW() - INTERVAL '120 days')
     ORDER BY updated_at DESC
     LIMIT 15000`
  );

  const activeStores = await query(
    `SELECT DISTINCT store FROM daily_reports WHERE date >= CURRENT_DATE - 30 AND store IS NOT NULL`
  );
  const storeNames = (activeStores.rows || []).map(x => x.store).filter(Boolean);

  function matchStore(rawStoreField) {
    const fl = String(rawStoreField || '').trim().toLowerCase().replace(/\s/g, '');
    if (!fl) return null;
    for (const s of storeNames) {
      const sl = s.toLowerCase().replace(/\s/g, '');
      if (fl === sl || fl.includes(sl) || sl.includes(fl)) return s;
    }
    if (fl.includes('洪潮') || fl.includes('久光')) {
      return storeNames.find(s => s.includes('洪潮大宁久光')) || null;
    }
    if (fl.includes('马己仙') || fl.includes('马已仙') || fl.includes('大宁')) {
      return storeNames.find(s => s.includes('马己仙上海音乐广场')) || null;
    }
    return null;
  }

  const results = [];
  for (const row of r.rows || []) {
    const f = row.fields && typeof row.fields === 'object' ? row.fields : {};
    const storeField = ext(f['所属门店'] || f['门店'] || f['门店名称'] || '');
    const matchedStore = matchStore(storeField);
    if (!matchedStore) continue;

    const dateStr = bitableDate(f['日期'] || f['创建日期'] || f['提交时间'], row.created_at);
    if (!dateStr || dateStr < startYmd || dateStr > endYmd) continue;

    const rawDish = f['今天不满意菜品'] || f['今天 不满意菜品'] || f['今天不满意的菜品'] || f['今天 不满意的菜品'] || f['不满意菜品'] || f['产品不满意项'] || '';
    const dishes = extractDishNames(rawDish);
    if (!dishes.length) continue;

    const reason = ext(f['不满意的主要原因是什么'] || f['不满意的主要原因'] || f['不满意原因'] || '');
    const blocked = new Set(['无', '没有', '暂无', '不清楚', '未知', '其他', '无菜品', '/', '-', '—']);
    const filteredDishes = dishes.filter(d => d && !blocked.has(d));
    if (!filteredDishes.length) continue;

    const reasonClean = reason.trim();
    const reasonMeaningful = reasonClean.length >= 2 && !/^(无|没有|暂无|不详|未知|-|—|你好|谢谢|ok|OK)$/i.test(reasonClean);
    const satRaw = ext(f['今天用餐是否满意'] || f['满意度'] || '');
    const isNegative = /不满意|很差|糟糕|差劲|^否$/i.test(satRaw);
    if (!reasonMeaningful && !isNegative) continue;

    const stallField = ext(f['不满意产品负责的档口'] || '');
    const { person, stall } = resolvePersonAndStall(matchedStore, stallField);

    results.push({
      store: matchedStore,
      person,
      stall,
      dishes: filteredDishes,
      reason: reasonMeaningful ? reasonClean : '',
      date: dateStr,
    });
  }
  return results;
}

function buildStoreReport(entries, store, label, dateLabel) {
  if (!entries.length) return null;

  const byPerson = new Map();
  for (const e of entries) {
    const k = e.person;
    if (!byPerson.has(k)) byPerson.set(k, []);
    byPerson.get(k).push(e);
  }

  let totalProducts = 0;
  const sections = [];
  for (const [person, items] of byPerson) {
    const stallName = items[0]?.stall || '未知';
    const dishLines = [];
    let personCount = 0;
    for (const item of items) {
      for (const d of item.dishes) {
        totalProducts++;
        personCount++;
        if (item.reason) {
          dishLines.push(`    - ${d}\n      原因：${item.reason}`);
        } else {
          dishLines.push(`    - ${d}`);
        }
      }
    }
    sections.push(`**${person}**（档口：${stallName}）— ${personCount}个\n${dishLines.join('\n')}`);
  }

  const content = `**${label}（${dateLabel}）— ${store}**\n不满意产品总计：**${totalProducts}**个\n\n${sections.join('\n\n')}\n\n⚠️ 请关注以上产品问题及时改进！`;
  return content;
}

function buildAllStoresReport(allData, label, dateLabel) {
  const stores = [...new Set(allData.map(e => e.store))].sort();
  if (!stores.length) return null;

  let totalAll = 0;
  const storeSections = [];
  for (const store of stores) {
    const entries = allData.filter(e => e.store === store);
    const byPerson = new Map();
    for (const e of entries) {
      if (!byPerson.has(e.person)) byPerson.set(e.person, []);
      byPerson.get(e.person).push(e);
    }
    const personLines = [];
    for (const [person, items] of byPerson) {
      const dishCount = items.reduce((s, i) => s + i.dishes.length, 0);
      const stall = items[0]?.stall || '未知';
      personLines.push(`  ${person}（${stall}）：**${dishCount}**个`);
    }
    const storeTotal = entries.reduce((s, e) => s + e.dishes.length, 0);
    totalAll += storeTotal;
    storeSections.push(`**${store}** — 合计 **${storeTotal}**个\n${personLines.join('\n')}`);
  }

  const content = `**${label}（${dateLabel}）— 全部门店汇总**\n不满意产品总计：**${totalAll}**个\n\n${storeSections.join('\n\n')}`;
  return content;
}

async function sendReportToRoles(roles, content, title, runYmd, scopePrefix) {
  if (!content) return;
  const roleList = Array.isArray(roles) ? roles : [roles];
  const placeholders = roleList.map(r => `%${r}%`);
  const recipients = await query(
    `SELECT open_id, username, role, store FROM feishu_users
     WHERE registered = true AND open_id IS NOT NULL AND role = ANY($1::text[])`,
    [roleList]
  );

  const card = {
    config: { wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: title.slice(0, 100) }, template: 'orange' },
    elements: [
      { tag: 'div', text: { tag: 'lark_md', content: content.slice(0, 9800) } },
      { tag: 'note', elements: [{ tag: 'plain_text', content: '数据来源：桌访记录（feishu_generic_records · config_key=table_visit）· 不满意产品负责的档口' }] }
    ]
  };

  for (const u of recipients.rows || []) {
    try {
      await sendReportToRecipient({
        jobKey: 'dissatisfied_product_report',
        runYmd,
        username: u.username || u.open_id,
        scope: scopePrefix,
        sendFn: async () => {
          const res = await sendCard(u.open_id, card, 'open_id');
          if (res?.ok) return { ok: true };
          const textRes = await sendText(u.open_id, content.slice(0, 3500), 'open_id');
          return { ok: !!textRes?.ok, error: textRes?.error || res?.error || '' };
        }
      });
    } catch (e) {
      logger.warn({ err: e?.message, u: u.username }, 'dissatisfied product report send failed');
    }
  }
}

async function sendReportToStoreRoles(store, roles, content, title, runYmd, scopePrefix) {
  if (!content) return;
  const pats = feishuStoreSearchPatterns(store);
  const recipients = await query(
    `SELECT open_id, username, role FROM feishu_users
     WHERE registered = true AND open_id IS NOT NULL
       AND role = ANY($1::text[])
       AND trim(store) ILIKE ANY($2::text[])`,
    [roles, pats]
  );

  const card = {
    config: { wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: title.slice(0, 100) }, template: 'orange' },
    elements: [
      { tag: 'div', text: { tag: 'lark_md', content: content.slice(0, 9800) } },
      { tag: 'note', elements: [{ tag: 'plain_text', content: '数据来源：桌访记录 · 不满意产品负责的档口' }] }
    ]
  };

  for (const u of recipients.rows || []) {
    try {
      await sendReportToRecipient({
        jobKey: 'dissatisfied_product_report',
        runYmd,
        username: u.username || u.open_id,
        scope: `${scopePrefix}_${u.role}`,
        sendFn: async () => {
          const res = await sendCard(u.open_id, card, 'open_id');
          if (res?.ok) return { ok: true };
          const textRes = await sendText(u.open_id, content.slice(0, 3500), 'open_id');
          return { ok: !!textRes?.ok, error: textRes?.error || res?.error || '' };
        }
      });
    } catch (e) {
      logger.warn({ err: e?.message, u: u.username }, 'dissatisfied product report send failed');
    }
  }
}

export async function generateDissatisfiedProductDailyReport(targetYmd) {
  const ymd = targetYmd || getShanghaiYmd();
  const label = '不满意产品日报';
  const dateLabel = ymd;
  const runYmd = ymd;

  logger.info({ ymd }, 'dissatisfied product daily report: starting');

  const entries = await fetchDissatisfiedEntries(ymd, ymd);
  if (!entries.length) {
    logger.info({ ymd }, 'dissatisfied product daily report: no data');
    return { ok: true, ymd, count: 0 };
  }

  const stores = [...new Set(entries.map(e => e.store))].sort();
  for (const store of stores) {
    const storeEntries = entries.filter(e => e.store === store);
    const content = buildStoreReport(storeEntries, store, label, dateLabel);
    const title = `📊 ${label}（${dateLabel}）— ${store}`;
    await sendReportToStoreRoles(store, ['store_manager', 'store_production_manager'], content, title, runYmd, `daily_${store}`);
  }

  const allContent = buildAllStoresReport(entries, label, dateLabel);
  await sendReportToRoles(['admin', 'hq_manager'], allContent, `📊 ${label}（${dateLabel}）— 全门店汇总`, runYmd, 'daily_all');

  logger.info({ ymd, stores: stores.length, total: entries.length }, 'dissatisfied product daily report: done');
  return { ok: true, ymd, count: entries.length };
}

export async function generateDissatisfiedProductWeeklyReport() {
  const { weekStart, weekEnd } = shanghaiLastCompletedWeekBounds();
  const label = '不满意产品周报';
  const dateLabel = `${weekStart}～${weekEnd}`;
  const runYmd = getShanghaiYmd();

  logger.info({ weekStart, weekEnd }, 'dissatisfied product weekly report: starting');

  const entries = await fetchDissatisfiedEntries(weekStart, weekEnd);
  if (!entries.length) {
    logger.info({ weekStart, weekEnd }, 'dissatisfied product weekly report: no data');
    return { ok: true, weekStart, weekEnd, count: 0 };
  }

  const stores = [...new Set(entries.map(e => e.store))].sort();
  for (const store of stores) {
    const storeEntries = entries.filter(e => e.store === store);
    const content = buildStoreReport(storeEntries, store, label, dateLabel);
    const title = `📊 ${label}（${dateLabel}）— ${store}`;
    await sendReportToStoreRoles(store, ['store_manager', 'store_production_manager'], content, title, runYmd, `weekly_${store}`);
  }

  const allContent = buildAllStoresReport(entries, label, dateLabel);
  await sendReportToRoles(['admin', 'hq_manager'], allContent, `📊 ${label}（${dateLabel}）— 全门店汇总`, runYmd, 'weekly_all');

  logger.info({ weekStart, weekEnd, stores: stores.length, total: entries.length }, 'dissatisfied product weekly report: done');
  return { ok: true, weekStart, weekEnd, count: entries.length };
}

export async function generateDissatisfiedProductMonthlyReport(period) {
  const { y, m } = getShanghaiYmdParts();
  let pm = m - 1, py = y;
  if (pm < 1) { pm = 12; py -= 1; }
  const p = period || `${py}-${String(pm).padStart(2, '0')}`;
  const daysInMonth = new Date(py, pm, 0).getDate();
  const start = `${p}-01`;
  const end = `${p}-${String(daysInMonth).padStart(2, '0')}`;
  const label = '不满意产品月报';
  const dateLabel = p;
  const runYmd = getShanghaiYmd();

  logger.info({ period: p, start, end }, 'dissatisfied product monthly report: starting');

  const entries = await fetchDissatisfiedEntries(start, end);
  if (!entries.length) {
    logger.info({ period: p }, 'dissatisfied product monthly report: no data');
    return { ok: true, period: p, count: 0 };
  }

  const stores = [...new Set(entries.map(e => e.store))].sort();
  for (const store of stores) {
    const storeEntries = entries.filter(e => e.store === store);
    const content = buildStoreReport(storeEntries, store, label, dateLabel);
    const title = `📊 ${label}（${dateLabel}）— ${store}`;
    await sendReportToStoreRoles(store, ['store_manager', 'store_production_manager'], content, title, runYmd, `monthly_${store}`);
  }

  const allContent = buildAllStoresReport(entries, label, dateLabel);
  await sendReportToRoles(['admin', 'hq_manager'], allContent, `📊 ${label}（${dateLabel}）— 全门店汇总`, runYmd, 'monthly_all');

  logger.info({ period: p, stores: stores.length, total: entries.length }, 'dissatisfied product monthly report: done');
  return { ok: true, period: p, count: entries.length };
}
