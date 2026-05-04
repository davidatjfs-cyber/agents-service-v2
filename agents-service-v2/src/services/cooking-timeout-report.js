/**
 * 出餐超时周报 / 月报
 *
 * 数据源：飞书多维表格 tblsKekCo8TQd012（菜品制作时长）
 * 门店：马己仙上海音乐广场店
 *
 * 定时：每周一 11:00（上周） / 每月1日 11:00（上月）
 * 发送：店长 + 出品经理 + 抄送管理员 + 总部营运
 */
import { query } from '../utils/db.js';
import { logger } from '../utils/logger.js';
import { sendCard } from './feishu-client.js';
import { sendReportToRecipient, getShanghaiYmd } from './report-delivery.js';
import { shanghaiLastCompletedWeekBounds, getShanghaiYmdParts, addDaysYmdShanghai } from '../utils/anomaly-week-bounds.js';

const STORE_NAME = '马己仙上海音乐广场店';

const APP_TOKEN = 'PTWrbUdcbarCshst0QncMoY7nKe';
const TABLE_ID = 'tblsKekCo8TQd012';

const FEISHU_BASE = 'https://open.feishu.cn/open-apis';

const WEEKDAY_ZH = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

async function getToken() {
  const appId = process.env.BITABLE_TABLEVISIT_APP_ID || 'cli_a9fc0d13c838dcd6';
  const appSecret = process.env.BITABLE_TABLEVISIT_APP_SECRET || 'pRVuBmiWc0hzqP1YzZDqzGUPFlaProDN';
  const { default: axios } = await import('axios');
  const r = await axios.post(FEISHU_BASE + '/auth/v3/tenant_access_token/internal', {
    app_id: appId, app_secret: appSecret
  }, { timeout: 10000 });
  return r.data?.tenant_access_token || '';
}

async function fetchRecordsInDateRange(dateStart, dateEnd) {
  const { default: axios } = await import('axios');
  const token = await getToken();
  if (!token) throw new Error('no feishu token');

  const all = [];
  let pageToken = '';
  for (let page = 0; page < 20; page++) {
    const params = { page_size: 500, user_id_type: 'open_id' };
    if (pageToken) params.page_token = pageToken;

    const resp = await axios.get(
      FEISHU_BASE + '/bitable/v1/apps/' + APP_TOKEN + '/tables/' + TABLE_ID + '/records',
      { headers: { Authorization: 'Bearer ' + token }, params, timeout: 30000 }
    );
    if (resp.data?.code !== 0) {
      logger.warn({ code: resp.data?.code, msg: resp.data?.msg }, 'cooking timeout: bitable fetch error');
      break;
    }
    const items = resp.data?.data?.items || [];
    for (const item of items) {
      const d = String(item.fields?.['营业日期'] || '').trim();
      if (d && d >= dateStart && d <= dateEnd) {
        all.push(item);
      }
    }
    if (!resp.data?.data?.has_more) break;
    pageToken = resp.data?.data?.page_token || '';
  }
  return all;
}

function calcDishStats(records) {
  const byDish = {};
  for (const r of records) {
    const name = String(r.fields?.['菜品名称'] || '').trim();
    if (!name) continue;
    if (!byDish[name]) byDish[name] = { records: [], timeoutDays: new Set(), allDays: new Set() };
    byDish[name].records.push(r);
    const d = String(r.fields?.['营业日期'] || '').trim();
    if (d) byDish[name].allDays.add(d);
    if (Number(r.fields?.['菜品制作超时次数'] || 0) > 0) {
      byDish[name].timeoutDays.add(d);
    }
  }

  const results = [];
  for (const [name, data] of Object.entries(byDish)) {
    const totalProd = data.records.reduce((s, r) => s + Number(r.fields?.['出品次数'] || 0), 0);
    const totalTimeout = data.records.reduce((s, r) => s + Number(r.fields?.['菜品制作超时次数'] || 0), 0);
    if (totalTimeout === 0) continue;

    const timeoutRatio = totalProd > 0 ? (totalTimeout / totalProd * 100).toFixed(0) : '0';
    const freq = data.allDays.size > 0 ? (data.timeoutDays.size / data.allDays.size * 100).toFixed(0) : '0';

    const dowSet = new Set();
    for (const d of data.timeoutDays) {
      dowSet.add(WEEKDAY_ZH[new Date(d + 'T12:00:00+08:00').getDay()]);
    }
    const dows = [...dowSet].join('、') || '—';

    results.push({ name, timeoutRatio, freq, dows, totalProd, totalTimeout });
  }

  results.sort((a, b) => Number(b.timeoutRatio) - Number(a.timeoutRatio));
  return results;
}

/** lark_md 表格单元格：去掉换行并替换 | 避免表格错位 */
function escapeMdCell(s) {
  return String(s || '').trim().replace(/\|/g, '｜').replace(/[\r\n]+/g, ' ');
}

/** 按超时占比做醒目分级（飞书内一眼区分轻重） */
function riskBadge(ratioStr) {
  const n = Number(ratioStr);
  if (!Number.isFinite(n)) return '⚪';
  if (n >= 80) return '🔴';
  if (n >= 40) return '🟠';
  return '🟡';
}

function buildTimeoutCard(title, periodLabel, dateStart, dateEnd, dishStats) {
  const headerContent = title + ' · ' + STORE_NAME;

  if (!dishStats.length) {
    const content =
      '### 📅 ' +
      periodLabel +
      '\n**' +
      dateStart +
      '** ~ **' +
      dateEnd +
      '**\n\n✅ **所有菜品出餐正常**，统计周期内多维表无制作超时记录。';
    return {
      config: { wide_screen_mode: true },
      header: {
        title: { tag: 'plain_text', content: headerContent },
        template: 'green'
      },
      elements: [
        { tag: 'div', text: { tag: 'lark_md', content } },
        { tag: 'hr' },
        {
          tag: 'note',
          elements: [{ tag: 'plain_text', content: '出品质量很重要，出餐效率不能掉！' }]
        }
      ]
    };
  }

  const top = dishStats[0];
  const worstLine =
    '**' +
    escapeMdCell(top.name) +
    '** · 超时占比 **' +
    top.timeoutRatio +
    '%** · **' +
    top.totalTimeout +
    '** 次超时 / **' +
    top.totalProd +
    '** 次出品';

  const summary =
    '### 📅 ' +
    periodLabel +
    '\n**' +
    dateStart +
    '** ~ **' +
    dateEnd +
    '**\n\n' +
    '### 📌 摘要\n' +
    '- 异常菜品：**' +
    dishStats.length +
    '** 道（存在制作超时次数）\n' +
    '- 最重一项：' +
    worstLine +
    '\n\n' +
    '> 💡 **读表：** **超时占比** = 超时次数÷出品次数（合计）；**超时频率** = 有超时发生的营业日÷本菜品出现在表内的营业日。**占比超过100%** 多为同日多条记录口径叠加，请以「超时/出品」次数为准。';

  const tableHeader =
    '| ' +
    ['分级', '菜品名称', '超时占比', '超时/出品', '超时频率', '集中星期'].join(' | ') +
    ' |\n' +
    '| :---: | :--- | :---: | :---: | :---: | :--- |\n';

  const legend =
    '\n\n**图例：** 🔴 超时占比≥80%　🟠 40%～79%　🟡 低于40%';

  const rowLines = (chunk) =>
    chunk.map((d) => {
      const badge = riskBadge(d.timeoutRatio);
      const ratioShow = '**' + escapeMdCell(d.timeoutRatio) + '%**';
      const cnt = '**' + d.totalTimeout + '**/**' + d.totalProd + '**';
      const freqShow = '**' + escapeMdCell(d.freq) + '%**';
      return (
        '| ' +
        [badge, escapeMdCell(d.name), ratioShow, cnt, freqShow, escapeMdCell(d.dows)].join(' | ') +
        ' |'
      );
    });

  const MAX_ROWS = 32;
  const elements = [
    { tag: 'div', text: { tag: 'lark_md', content: summary } },
    { tag: 'hr' }
  ];

  if (dishStats.length <= MAX_ROWS) {
    const detailMd =
      '### 📋 明细（按超时占比降序）\n\n' + tableHeader + rowLines(dishStats).join('\n') + legend;
    elements.push({ tag: 'div', text: { tag: 'lark_md', content: detailMd } });
  } else {
    let offset = 0;
    let part = 1;
    while (offset < dishStats.length) {
      const chunk = dishStats.slice(offset, offset + MAX_ROWS);
      const title =
        '### 📋 明细（第 **' +
        part +
        '** / **' +
        Math.ceil(dishStats.length / MAX_ROWS) +
        '** 部分 · 按超时占比降序）\n\n';
      const md = title + tableHeader + rowLines(chunk).join('\n') + (offset + chunk.length >= dishStats.length ? legend : '');
      elements.push({ tag: 'div', text: { tag: 'lark_md', content: md } });
      if (offset + chunk.length < dishStats.length) elements.push({ tag: 'hr' });
      offset += chunk.length;
      part++;
    }
  }

  elements.push(
    { tag: 'hr' },
    {
      tag: 'note',
      elements: [
        {
          tag: 'plain_text',
          content: '出品质量很重要，出餐效率不能掉！峰值时段建议按表内「集中星期」加强预制与工位巡检。'
        }
      ]
    }
  );

  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: headerContent },
      template: 'red'
    },
    elements
  };
}

async function resolveRecipients() {
  const r = await query(
    `SELECT DISTINCT open_id, username FROM feishu_users
     WHERE registered = true AND open_id IS NOT NULL AND open_id NOT LIKE '%probe%'
       AND (role IN ('admin', 'hq_manager')
            OR (role IN ('store_manager', 'store_production_manager')
                AND (store ILIKE '%马己仙%' OR store ILIKE '%音乐广场%')))`,
    []
  );
  return r.rows || [];
}

async function sendReport(typeLabel, dateStart, dateEnd, dishStats) {
  const title = '📋 出餐超时' + typeLabel;
  const card = buildTimeoutCard(title, typeLabel, dateStart, dateEnd, dishStats);

  const recipients = await resolveRecipients();
  if (!recipients.length) {
    logger.warn({ typeLabel }, 'cooking timeout report: no recipients found');
    return { ok: false, error: 'no_recipients' };
  }

  const runYmd = getShanghaiYmd();
  const jobKey = 'cooking_timeout_' + (typeLabel === '周报' ? 'weekly' : 'monthly');
  let okCount = 0;
  let errCount = 0;

  for (const row of recipients) {
    if (!row.open_id) continue;
    const result = await sendReportToRecipient({
      jobKey,
      runYmd,
      username: row.username || 'unknown',
      scope: STORE_NAME,
      sendFn: async () => {
        const res = await sendCard(row.open_id, card, 'open_id');
        return { ok: true };
      }
    });
    if (result.ok) okCount++;
    else errCount++;
  }

  logger.info({ typeLabel, okCount, errCount, total: recipients.length }, 'cooking timeout report sent');
  return { ok: okCount > 0, okCount, errCount };
}

export async function generateCookingTimeoutWeeklyReport() {
  try {
    const { weekStart, weekEnd } = shanghaiLastCompletedWeekBounds();
    logger.info({ weekStart, weekEnd }, 'cooking timeout: weekly report start');

    const records = await fetchRecordsInDateRange(weekStart, weekEnd);
    logger.info({ dateStart: weekStart, dateEnd: weekEnd, recordCount: records.length }, 'cooking timeout: records fetched');

    const stats = calcDishStats(records);
    return await sendReport('周报', weekStart, weekEnd, stats);
  } catch (e) {
    logger.error({ err: e?.message }, 'cooking timeout weekly report failed');
    return { ok: false, error: e?.message };
  }
}

export async function generateCookingTimeoutMonthlyReport() {
  try {
    const { y, m } = getShanghaiYmdParts();
    // Previous month: if current month is May, previous is April
    const prevM = m === 1 ? 12 : m - 1;
    const prevY = m === 1 ? y - 1 : y;
    const monthStart = prevY + '-' + String(prevM).padStart(2, '0') + '-01';
    // Last day of previous month = first day of current month minus 1 day
    const monthEnd = addDaysYmdShanghai(y + '-' + String(m).padStart(2, '0') + '-01', -1);

    logger.info({ monthStart, monthEnd }, 'cooking timeout: monthly report start');

    const records = await fetchRecordsInDateRange(monthStart, monthEnd);
    logger.info({ dateStart: monthStart, dateEnd: monthEnd, recordCount: records.length }, 'cooking timeout: monthly records fetched');

    const stats = calcDishStats(records);
    return await sendReport('月报', monthStart, monthEnd, stats);
  } catch (e) {
    logger.error({ err: e?.message }, 'cooking timeout monthly report failed');
    return { ok: false, error: e?.message };
  }
}
