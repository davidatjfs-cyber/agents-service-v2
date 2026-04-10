/**
 * 出品经理开档/收档/原料收货、马己仙例会 —— 统一从 `agent_messages` 按业务日统计（飞书多维经 bitable 轮询写入）。
 * 洪潮店长企微执行力不在此模块（见 daily_reports）。
 */
import { query } from '../utils/db.js';
import { expandAgentStoreLabels } from '../config/store-mapping.js';
import { sameStore, ext, resolveBitableBusinessYmd } from './deterministic-replies.js';

/** 按业务日判定时，created_at 扫描窗口：避免飞书晚同步（入库晚于业务日数日）被 SQL 提前过滤掉 */
const CREATED_AT_PAD_BEFORE_SINGLE_DAY = 45;
const CREATED_AT_PAD_AFTER_SINGLE_DAY = 14;
const CREATED_AT_PAD_BEFORE_MONTH = 45;
const CREATED_AT_PAD_AFTER_MONTH = 45;

function storeMatchesRow(displayStore, rowStoreRaw) {
  const rowStore = ext(rowStoreRaw);
  if (!rowStore) return false;
  const labels = expandAgentStoreLabels(displayStore);
  return labels.some((lab) => sameStore(rowStore, lab));
}

function materialBrandMatches(agentData, brandZh) {
  const b = String(agentData?.brand || '').trim();
  if (!b) return true;
  return b === brandZh;
}

function parseMeetingScore(fields) {
  const raw = fields?.meeting_score ?? fields?.score ?? fields?.得分;
  const n = Number(String(raw ?? '').trim());
  return Number.isFinite(n) ? n : null;
}

/**
 * 单日：是否有业务日期 = dateYmd 的开档报告
 */
export async function pmHasOpeningReportBizDate(displayStore, dateYmd) {
  const r = await query(
    `SELECT agent_data, created_at FROM agent_messages
     WHERE content_type = 'opening_report'
       AND (created_at AT TIME ZONE 'Asia/Shanghai')::date >= ($1::date - $2::int)
       AND (created_at AT TIME ZONE 'Asia/Shanghai')::date <= ($1::date + $3::int)`,
    [dateYmd, CREATED_AT_PAD_BEFORE_SINGLE_DAY, CREATED_AT_PAD_AFTER_SINGLE_DAY]
  );
  for (const row of r.rows || []) {
    const fields = row.agent_data?.fields || {};
    if (!storeMatchesRow(displayStore, fields.store)) continue;
    const biz = resolveBitableBusinessYmd(fields.date, row.created_at);
    if (biz === dateYmd) return true;
  }
  return false;
}

/**
 * 单日：是否有业务日期 = dateYmd 的收档报告
 */
export async function pmHasClosingReportBizDate(displayStore, dateYmd) {
  const r = await query(
    `SELECT agent_data, created_at FROM agent_messages
     WHERE content_type = 'closing_report'
       AND (created_at AT TIME ZONE 'Asia/Shanghai')::date >= ($1::date - $2::int)
       AND (created_at AT TIME ZONE 'Asia/Shanghai')::date <= ($1::date + $3::int)`,
    [dateYmd, CREATED_AT_PAD_BEFORE_SINGLE_DAY, CREATED_AT_PAD_AFTER_SINGLE_DAY]
  );
  for (const row of r.rows || []) {
    const fields = row.agent_data?.fields || {};
    if (!storeMatchesRow(displayStore, fields.store)) continue;
    const biz = resolveBitableBusinessYmd(fields.date, row.created_at);
    if (biz === dateYmd) return true;
  }
  return false;
}

/**
 * 单日：是否有业务日期 = dateYmd 的原料收货（agent_messages.material_report，与飞书轮询写入同源）
 */
export async function pmHasMaterialReportBizDate(displayStore, brandZh, dateYmd) {
  const r = await query(
    `SELECT agent_data, created_at FROM agent_messages
     WHERE content_type = 'material_report'
       AND (created_at AT TIME ZONE 'Asia/Shanghai')::date >= ($1::date - $2::int)
       AND (created_at AT TIME ZONE 'Asia/Shanghai')::date <= ($1::date + $3::int)`,
    [dateYmd, CREATED_AT_PAD_BEFORE_SINGLE_DAY, CREATED_AT_PAD_AFTER_SINGLE_DAY]
  );
  for (const row of r.rows || []) {
    const ad = row.agent_data && typeof row.agent_data === 'object' ? row.agent_data : {};
    if (!materialBrandMatches(ad, brandZh)) continue;
    const fields = ad.fields || {};
    if (!storeMatchesRow(displayStore, fields.store)) continue;
    const biz = resolveBitableBusinessYmd(fields.date, row.created_at);
    if (biz === dateYmd) return true;
  }
  return false;
}

export async function getPMReportStatusByBizDate(store, brandZh, dateYmd) {
  const [opening, closing, material] = await Promise.all([
    pmHasOpeningReportBizDate(store, dateYmd),
    pmHasClosingReportBizDate(store, dateYmd),
    pmHasMaterialReportBizDate(store, brandZh, dateYmd)
  ]);
  return { opening, closing, material };
}

function collectDistinctBizDays(rows, displayStore, fieldDateKeys, startYmd, endYmd) {
  const days = new Set();
  for (const row of rows || []) {
    const fields = row.agent_data?.fields || {};
    if (!storeMatchesRow(displayStore, fields.store)) continue;
    let biz = '';
    for (const k of fieldDateKeys) {
      const v = fields[k];
      if (v != null && String(v).trim() !== '') {
        biz = resolveBitableBusinessYmd(v, row.created_at);
        break;
      }
    }
    if (!biz) biz = resolveBitableBusinessYmd(null, row.created_at);
    if (biz && biz >= startYmd && biz <= endYmd) days.add(biz);
  }
  return days.size;
}

/**
 * 月度：开档/收档各自在 [startYmd,endYmd] 内有多少个不同业务日有记录
 */
export async function countDistinctOpeningBizDays(displayStore, startYmd, endYmd) {
  const r = await query(
    `SELECT agent_data, created_at FROM agent_messages
     WHERE content_type = 'opening_report'
       AND (created_at AT TIME ZONE 'Asia/Shanghai')::date >= ($1::date - $3::int)
       AND (created_at AT TIME ZONE 'Asia/Shanghai')::date <= ($2::date + $4::int)`,
    [startYmd, endYmd, CREATED_AT_PAD_BEFORE_MONTH, CREATED_AT_PAD_AFTER_MONTH]
  );
  return collectDistinctBizDays(r.rows, displayStore, ['date'], startYmd, endYmd);
}

export async function countDistinctClosingBizDays(displayStore, startYmd, endYmd) {
  const r = await query(
    `SELECT agent_data, created_at FROM agent_messages
     WHERE content_type = 'closing_report'
       AND (created_at AT TIME ZONE 'Asia/Shanghai')::date >= ($1::date - $3::int)
       AND (created_at AT TIME ZONE 'Asia/Shanghai')::date <= ($2::date + $4::int)`,
    [startYmd, endYmd, CREATED_AT_PAD_BEFORE_MONTH, CREATED_AT_PAD_AFTER_MONTH]
  );
  return collectDistinctBizDays(r.rows, displayStore, ['date'], startYmd, endYmd);
}

export async function countDistinctMaterialBizDays(displayStore, brandZh, startYmd, endYmd) {
  const r = await query(
    `SELECT agent_data, created_at FROM agent_messages
     WHERE content_type = 'material_report'
       AND (created_at AT TIME ZONE 'Asia/Shanghai')::date >= ($1::date - $3::int)
       AND (created_at AT TIME ZONE 'Asia/Shanghai')::date <= ($2::date + $4::int)`,
    [startYmd, endYmd, CREATED_AT_PAD_BEFORE_MONTH, CREATED_AT_PAD_AFTER_MONTH]
  );
  const days = new Set();
  for (const row of r.rows || []) {
    const ad = row.agent_data && typeof row.agent_data === 'object' ? row.agent_data : {};
    if (!materialBrandMatches(ad, brandZh)) continue;
    const fields = ad.fields || {};
    if (!storeMatchesRow(displayStore, fields.store)) continue;
    const biz = resolveBitableBusinessYmd(fields.date, row.created_at);
    if (biz && biz >= startYmd && biz <= endYmd) days.add(biz);
  }
  return days.size;
}

/**
 * 马己仙店长执行力：例会条数与合格判定（agent_messages.meeting_report，与飞书轮询同源）
 */
export async function getMajixianMeetingExecutionStatsForStore(displayStore, startYmd, endYmd) {
  const r = await query(
    `SELECT agent_data, created_at FROM agent_messages
     WHERE content_type = 'meeting_report'
       AND (created_at AT TIME ZONE 'Asia/Shanghai')::date >= ($1::date - $3::int)
       AND (created_at AT TIME ZONE 'Asia/Shanghai')::date <= ($2::date + $4::int)`,
    [startYmd, endYmd, CREATED_AT_PAD_BEFORE_MONTH, CREATED_AT_PAD_AFTER_MONTH]
  );
  let totalMeetings = 0;
  let qualifiedMeetings = 0;
  let unqualifiedMeetings = 0;
  for (const row of r.rows || []) {
    const fields = row.agent_data?.fields || {};
    if (!storeMatchesRow(displayStore, fields.store)) continue;
    const biz = resolveBitableBusinessYmd(fields.date, row.created_at);
    if (!biz || biz < startYmd || biz > endYmd) continue;
    totalMeetings++;
    const sc = parseMeetingScore(fields);
    if (sc != null && sc >= 7) qualifiedMeetings++;
    else unqualifiedMeetings++;
  }
  return { totalMeetings, qualifiedMeetings, unqualifiedMeetings };
}

/** 马己仙店长执行力日评：某日是否已提交例会及得分（agent_messages.meeting_report） */
export async function getMajixianMeetingDayEval(displayStore, dateYmd) {
  const r = await query(
    `SELECT agent_data, created_at FROM agent_messages
     WHERE content_type = 'meeting_report'
       AND (created_at AT TIME ZONE 'Asia/Shanghai')::date >= ($1::date - $2::int)
       AND (created_at AT TIME ZONE 'Asia/Shanghai')::date <= ($1::date + $3::int)`,
    [dateYmd, CREATED_AT_PAD_BEFORE_SINGLE_DAY, CREATED_AT_PAD_AFTER_SINGLE_DAY]
  );
  let latestFields = null;
  let latestTs = 0;
  for (const row of r.rows || []) {
    const fields = row.agent_data?.fields || {};
    if (!storeMatchesRow(displayStore, fields.store)) continue;
    const biz = resolveBitableBusinessYmd(fields.date, row.created_at);
    if (biz !== dateYmd) continue;
    const ts = new Date(row.created_at).getTime();
    if (ts >= latestTs) {
      latestTs = ts;
      latestFields = fields;
    }
  }
  if (!latestFields) return { submitted: false, score: null, qualified: false };
  const sc = parseMeetingScore(latestFields);
  return { submitted: true, score: sc, qualified: sc != null && sc >= 7 };
}
