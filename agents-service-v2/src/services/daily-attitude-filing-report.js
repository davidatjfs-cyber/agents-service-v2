/**
 * 工作态度评级备案日报 — 每日 08:05（上海）统计「昨日」已打标 hr_performance_recorded 的任务。
 * 门店角色仅看本店；admin / hq_manager 看全量汇总。
 */
import { query } from '../utils/db.js';
import { logger } from '../utils/logger.js';
import { sendCard } from './feishu-client.js';
import { getShanghaiYmd, sendReportToRecipient } from './report-delivery.js';
import { resolveSingleScoringUser } from '../utils/scoring-assignee.js';
import { collectStoreLookupVariants } from '../utils/feishu-assignee-resolve.js';

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

function buildStoreMarkdown(rows, bizYmd) {
  if (!rows.length) {
    return `**统计日（上海）**：${bizYmd}\n\n昨日暂无工作态度相关备案记录（\`hr_performance_recorded\`）。`;
  }
  let md = `**统计日（上海）**：${bizYmd}\n**本店昨日备案**：**${rows.length}** 条\n\n`;
  for (const row of rows) {
    const title = String(row.title || '').slice(0, 120);
    md += `— **${sourceLabelZh(row.source)}**｜${title}\n`;
    md += `  责任人：\`${row.assignee_username || '—'}\`｜状态：${row.status || '—'}｜时间：${row.filed_at_sh || '—'}\n`;
  }
  return md;
}

function buildSummaryMarkdown(byStore, bizYmd, total) {
  if (!total) {
    return `**统计日（上海）**：${bizYmd}\n\n全系统昨日暂无工作态度备案记录。`;
  }
  let md = `**统计日（上海）**：${bizYmd}\n**全系统昨日备案合计**：**${total}** 条\n\n`;
  const keys = [...byStore.keys()].sort((a, b) => String(a).localeCompare(String(b), 'zh-Hans-CN'));
  for (const k of keys) {
    const n = byStore.get(k)?.length || 0;
    md += `— **${k}**：${n} 条\n`;
  }
  return md;
}

async function fetchYesterdayFilings(bizYmd) {
  const next = ymdAddDays(bizYmd, 1);
  const r = await query(
    `SELECT task_id, store, assignee_username, assignee_role, title, source, resolution_code, status,
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

function buildCard(title, md) {
  return {
    config: { wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: title }, template: 'blue' },
    elements: [{ tag: 'div', text: { tag: 'lark_md', content: md } }]
  };
}

/**
 * @param {{ bizYmd?: string }} opts bizYmd 不传则为上海「昨日」
 */
export async function runDailyAttitudeFilingReport(opts = {}) {
  const runYmd = getShanghaiYmd();
  const bizYmd = String(opts?.bizYmd || '').trim() || ymdAddDays(runYmd, -1);
  const rows = await fetchYesterdayFilings(bizYmd);
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
    const card = buildCard(
      `工作态度备案日报（汇总·${bizYmd}）`,
      buildSummaryMarkdown(byStore, bizYmd, rows.length)
    );
    await sendReportToRecipient({
      jobKey,
      runYmd,
      username,
      scope: 'hq_summary',
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
      const card = buildCard(
        `工作态度备案日报（本店·${bizYmd}）`,
        buildStoreMarkdown(filtered, bizYmd)
      );
      const username = String(row.username || canon.username).trim();
      await sendReportToRecipient({
        jobKey,
        runYmd,
        username,
        scope: `store:${storeKey(store)}:${role}`,
        sendFn: async () => sendOpenId(row.open_id, card)
      });
    }
  }

  logger.info({ bizYmd, n: rows.length, stores: storeSet.size }, 'daily-attitude-filing-report: done');
  return { ok: true, bizYmd, count: rows.length };
}
