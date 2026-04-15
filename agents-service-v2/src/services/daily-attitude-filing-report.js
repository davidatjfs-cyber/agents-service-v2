/**
 * 工作态度评级备案日报 — 每日 08:05（上海）统计「昨日」已打标 hr_performance_recorded 的任务。
 * 门店角色仅看本店；admin / hq_manager 看全量汇总。
 */
import { query } from '../utils/db.js';
import { logger } from '../utils/logger.js';
import { sendCard } from './feishu-client.js';
import { getShanghaiYmd, sendReportToRecipient } from './report-delivery.js';
import { resolveSingleScoringUser, resolvePerformanceReportDisplayName } from '../utils/scoring-assignee.js';
import { collectStoreLookupVariants } from '../utils/feishu-assignee-resolve.js';
import {
  getMonthlyAttitudeFilingCount,
  getMonthlyAttitudeFilingCountForStore
} from '../utils/performance-filing-counts.js';

const ATTITUDE_SOURCES = ['random_inspection', 'scheduled_inspection', 'bi_anomaly', 'auto_collab', 'data_auditor'];

function ymdAddDays(ymd, delta) {
  const s = String(ymd || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return getShanghaiYmd();
  const [y, m, d] = s.split('-').map(Number);
  const t = Date.UTC(y, m - 1, d) + delta * 86400000;
  return new Date(t).toLocaleString('en-CA', { timeZone: 'Asia/Shanghai' }).slice(0, 10);
}

function storeKey(v) {
  return String(v || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '');
}
function sameStore(a, b) {
  const x = storeKey(a);
  const y = storeKey(b);
  if (!x || !y) return false;
  return x === y || x.includes(y) || y.includes(x);
}

function rowMatchesUserStore(rowStore, userStore) {
  const rst = String(rowStore || '').trim();
  const ust = String(userStore || '').trim();
  if (!rst || !ust) return false;
  const vars = collectStoreLookupVariants(ust);
  const list = vars.length ? vars : [ust];
  return list.some((v) => sameStore(rst, v));
}

function sourceLabelZh(s) {
  const m = {
    random_inspection: '随机抽检',
    scheduled_inspection: '定时巡检',
    bi_anomaly: 'BI 异常任务',
    auto_collab: '自动协作',
    data_auditor: '数据审计'
  };
  return m[String(s || '')] || String(s || '—');
}

/** 从任务标题等文本中提取首个 yyyy-mm-dd（用于展示「任务关联营业日」） */
function extractFirstYmdFromText(s) {
  const m = String(s || '').match(/(20\d{2})-(\d{1,2})-(\d{1,2})/);
  if (!m) return '';
  return `${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}`;
}

function extractTaskBizYmdFromRow(row) {
  const sd = row?.source_data && typeof row.source_data === 'object' ? row.source_data : {};
  const fromJson =
    sd.evaluationYmd ||
    sd.evaluation_ymd ||
    sd.trigger_date ||
    sd.biz_date ||
    sd.business_date ||
    sd.report_date ||
    sd.date;
  const j = String(fromJson || '').trim().slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(j)) return j;
  return extractFirstYmdFromText(row?.title || '') || extractFirstYmdFromText(row?.detail || '');
}

async function loadFeishuDisplayNameMap(usernames) {
  const unique = [...new Set((usernames || []).map((u) => String(u || '').trim().toLowerCase()).filter(Boolean))];
  if (!unique.length) return new Map();
  const r = await query(
    `SELECT lower(username) AS lu,
            COALESCE(NULLIF(TRIM(name), ''), username) AS disp
     FROM feishu_users
     WHERE lower(username) = ANY($1::text[])`,
    [unique]
  );
  const m = new Map();
  for (const row of r.rows || []) {
    if (row.lu) m.set(row.lu, String(row.disp || row.lu).trim());
  }
  return m;
}

/** 与「工作执行力备案」卡片同一信息层级：备案类型 / 门店 / 业务日 / 条数 / 明细 / 页脚说明 */
function buildAttitudeFilingCard(title, bodyMd, template = 'blue') {
  return {
    config: { wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: title }, template },
    elements: [
      { tag: 'div', text: { tag: 'lark_md', content: bodyMd } },
      {
        tag: 'note',
        elements: [
          {
            tag: 'plain_text',
            content:
              '数据来源：master_tasks（昨日条数按 updated_at 落在统计日内；「本月累计」按 dispatched_at 落在当月1日—统计日，与月度评级同一 SQL）。标题中的日期多为任务关联营业日，与 HR 备案更新时间可能不同，不代表漏备。 · 每日08:05'
          }
        ]
      }
    ]
  };
}

/** 昨日涉及账号 → 截至统计日「本月」态度备案累计（distinct task_id；与月度评级口径一致） */
async function buildMonthlyAttitudeCountMap(rows, bizYmd, restrictStoreTrim) {
  const users = [...new Set((rows || []).map((r) => String(r.assignee_username || '').trim()).filter(Boolean))];
  const m = new Map();
  for (const u of users) {
    const cnt = restrictStoreTrim
      ? await getMonthlyAttitudeFilingCountForStore(u, restrictStoreTrim, bizYmd)
      : await getMonthlyAttitudeFilingCount(u, bizYmd);
    m.set(u.toLowerCase(), cnt);
  }
  return m;
}

async function buildHqBodyMarkdown(byStore, rows, bizYmd, nameMap, monthlyMap) {
  const total = rows.length;
  if (!total) {
    return `**备案类型**：工作态度备案（全系统昨日汇总）

**统计日（上海）**：${bizYmd}

**昨日备案条数**：**0** 条

✅ 昨日暂无工作态度相关备案记录。`;
  }
  let md = `**备案类型**：工作态度备案（全系统昨日汇总）

**统计日（上海）**：${bizYmd}

**昨日备案条数**：**${total}** 条

**按门店汇总**

`;
  const keys = [...byStore.keys()].sort((a, b) => String(a).localeCompare(String(b), 'zh-Hans-CN'));
  for (const k of keys) {
    const n = byStore.get(k)?.length || 0;
    md += `· **${k}**：${n} 条\n`;
  }
  md += `\n**明细**（按 HR 备案状态更新时间；与执行力备案一致展示「本月累计」）\n\n`;
  for (const row of rows) {
    const st = String(row.store || '').trim() || '（未填门店）';
    const role = String(row.assignee_role || '').trim();
    const un = String(row.assignee_username || '').trim();
    const raw = nameMap.get(un.toLowerCase()) || un;
    const disp = resolvePerformanceReportDisplayName(st, role, un, raw);
    const title = String(row.title || '').slice(0, 160);
    const monthCnt = monthlyMap.get(un.toLowerCase()) ?? 0;
    const taskBiz = extractTaskBizYmdFromRow(row);
    md += `· **${st}**｜${sourceLabelZh(row.source)}\n`;
    md += `  · 摘要：${title}\n`;
    md += `  · 责任人：**${disp}**（\`${un || '—'}\`）｜状态：${row.status || '—'}\n`;
    md += `  · **HR 备案更新时间**：${row.filed_at_sh || '—'}（统计日 **${bizYmd}** 内 \`updated_at\`）\n`;
    if (taskBiz) {
      md += `  · **任务关联营业日**：**${taskBiz}**（来自标题/后台字段；**可与上一行日期不同**，表示任务针对该营业日，**不是**漏做 ${bizYmd} 的备案）\n`;
    }
    md += `  · **本月累计（工作态度备案）**：**${monthCnt}** 次（截至 **${bizYmd}**；全门店 distinct task_id）\n\n`;
  }
  return md;
}

async function buildStoreBodyMarkdown(filtered, bizYmd, store, nameMap, monthlyMap) {
  const n = filtered.length;
  if (!n) {
    return `**备案类型**：工作态度备案（本店昨日）

**门店**：${store}

**统计日（上海）**：${bizYmd}

**昨日备案条数**：**0** 条

✅ 本店昨日暂无工作态度备案记录。`;
  }
  let md = `**备案类型**：工作态度备案（本店昨日）

**门店**：${store}

**统计日（上海）**：${bizYmd}

**昨日备案条数**：**${n}** 条

**明细**（与执行力备案一致含「本月累计」）

`;
  for (const row of filtered) {
    const st = String(row.store || '').trim() || store;
    const role = String(row.assignee_role || '').trim();
    const un = String(row.assignee_username || '').trim();
    const raw = nameMap.get(un.toLowerCase()) || un;
    const disp = resolvePerformanceReportDisplayName(st, role, un, raw);
    const title = String(row.title || '').slice(0, 160);
    const monthCnt = monthlyMap.get(un.toLowerCase()) ?? 0;
    const taskBiz = extractTaskBizYmdFromRow(row);
    md += `· **${sourceLabelZh(row.source)}**\n`;
    md += `  · 摘要：${title}\n`;
    md += `  · 责任人：**${disp}**（\`${un || '—'}\`）｜状态：${row.status || '—'}\n`;
    md += `  · **HR 备案更新时间**：${row.filed_at_sh || '—'}（统计日 **${bizYmd}** 内）\n`;
    if (taskBiz) {
      md += `  · **任务关联营业日**：**${taskBiz}**（与上一行不同**不代表漏备**）\n`;
    }
    md += `  · **本月累计（工作态度备案）**：**${monthCnt}** 次（截至 **${bizYmd}**；本店 distinct task_id）\n\n`;
  }
  return md;
}

async function fetchYesterdayFilings(bizYmd) {
  const next = ymdAddDays(bizYmd, 1);
  const r = await query(
    `SELECT task_id, store, assignee_username, assignee_role, title, detail, source, resolution_code, status,
            source_data,
            to_char((updated_at AT TIME ZONE 'Asia/Shanghai'), 'YYYY-MM-DD HH24:MI') AS filed_at_sh
     FROM master_tasks
     WHERE COALESCE(hr_performance_recorded, false) = true
       AND source = ANY($1::text[])
       AND (updated_at AT TIME ZONE 'Asia/Shanghai')::date >= $2::date
       AND (updated_at AT TIME ZONE 'Asia/Shanghai')::date < $3::date
     ORDER BY store NULLS LAST, updated_at`,
    [ATTITUDE_SOURCES, bizYmd, next]
  );
  return r.rows || [];
}

/**
 * @param {{ bizYmd?: string, force?: boolean }} opts bizYmd 不传则为上海「昨日」；force 时跳过当日投递去重便于验收重发
 */
export async function runDailyAttitudeFilingReport(opts = {}) {
  const runYmd = getShanghaiYmd();
  const bizYmd = String(opts?.bizYmd || '').trim() || ymdAddDays(runYmd, -1);
  const forceResend = !!opts?.force;
  const rows = await fetchYesterdayFilings(bizYmd);
  const nameMap = await loadFeishuDisplayNameMap(rows.map((r) => r.assignee_username));
  const monthlyMapHq = await buildMonthlyAttitudeCountMap(rows, bizYmd, null);
  const byStore = new Map();
  for (const row of rows) {
    const st = String(row.store || '').trim() || '（未填门店）';
    if (!byStore.has(st)) byStore.set(st, []);
    byStore.get(st).push(row);
  }
  const jobKey = 'daily_attitude_filing_report';

  async function sendOpenId(openId, card) {
    const res = await sendCard(openId, card).catch((e) => ({ ok: false, error: String(e?.message || e) }));
    const ok = !!(res?.data?.message_id || res?.data?.data?.message_id || res?.ok);
    return { ok, error: ok ? '' : String(res?.error || 'send_failed') };
  }

  const hq = await query(
    `SELECT username, open_id FROM feishu_users
     WHERE registered = true AND open_id IS NOT NULL AND role IN ('admin', 'hq_manager')`
  ).catch(() => ({ rows: [] }));

  for (const u of hq.rows || []) {
    const username = String(u.username || '').trim();
    if (!username) continue;
    const hqTemplate = rows.length ? 'orange' : 'green';
    const card = buildAttitudeFilingCard(
      `📋 工作态度备案日报 · 全系统汇总 · ${bizYmd}`,
      await buildHqBodyMarkdown(byStore, rows, bizYmd, nameMap, monthlyMapHq),
      hqTemplate
    );
    await sendReportToRecipient({
      jobKey,
      runYmd,
      username,
      scope: 'hq_summary',
      force: forceResend,
      sendFn: async () => sendOpenId(u.open_id, card)
    });
  }

  const storeSet = new Set(byStore.keys());
  const staffStores = await query(
    `SELECT DISTINCT trim(store) AS store FROM feishu_users
     WHERE registered = true AND open_id IS NOT NULL
       AND trim(coalesce(store,'')) <> ''
       AND role IN ('store_manager', 'store_production_manager')`
  ).catch(() => ({ rows: [] }));
  for (const x of staffStores.rows || []) {
    const s = String(x.store || '').trim();
    if (s) storeSet.add(s);
  }

  for (const store of storeSet) {
    if (!store || store === '（未填门店）') continue;
    for (const role of ['store_manager', 'store_production_manager']) {
      const canon = await resolveSingleScoringUser(store, role);
      if (!canon?.username || String(canon.username).startsWith('__periodic')) continue;
      const ur = await query(
        `SELECT username, open_id FROM feishu_users
         WHERE registered = true AND open_id IS NOT NULL AND LOWER(username) = LOWER($1) LIMIT 1`,
        [canon.username]
      ).catch(() => ({ rows: [] }));
      const row = ur.rows?.[0];
      if (!row?.open_id) continue;
      const filtered = rows.filter((r) => rowMatchesUserStore(r.store, store));
      const monthlyMapStore = await buildMonthlyAttitudeCountMap(filtered, bizYmd, store);
      const stTemplate = filtered.length ? 'orange' : 'green';
      const card = buildAttitudeFilingCard(
        `📋 工作态度备案日报 · 本店 · ${store} · ${bizYmd}`,
        await buildStoreBodyMarkdown(filtered, bizYmd, store, nameMap, monthlyMapStore),
        stTemplate
      );
      const username = String(row.username || canon.username).trim();
      await sendReportToRecipient({
        jobKey,
        runYmd,
        username,
        scope: `store:${storeKey(store)}:${role}`,
        force: forceResend,
        sendFn: async () => sendOpenId(row.open_id, card)
      });
    }
  }

  logger.info({ bizYmd, n: rows.length, stores: storeSet.size }, 'daily-attitude-filing-report: done');
  return { ok: true, bizYmd, count: rows.length };
}
