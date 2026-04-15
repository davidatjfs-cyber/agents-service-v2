/**
 * 出品经理开档/收档/原料收货、马己仙例会 —— 统一从 `agent_messages` 按业务日统计（飞书多维经 bitable 轮询写入）。
 * 洪潮店长企微执行力不在此模块（见 daily_reports）。
 */
import { query } from '../utils/db.js';
import { expandAgentStoreLabels, normalizeAgentMaterialBrand, resolveAgentCanonicalStore } from '../config/store-mapping.js';
import { sameStore, ext, resolveBitableBusinessYmd } from './deterministic-replies.js';

/** 按业务日判定时，created_at 扫描窗口：避免飞书晚同步（入库晚于业务日数日）被 SQL 提前过滤掉 */
const CREATED_AT_PAD_BEFORE_SINGLE_DAY = 45;
const CREATED_AT_PAD_AFTER_SINGLE_DAY = 14;
const CREATED_AT_PAD_BEFORE_MONTH = 45;
const CREATED_AT_PAD_AFTER_MONTH = 45;

function storeMatchesRow(displayStore, rowStoreRaw) {
  const rowStore = ext(rowStoreRaw);
  if (!rowStore) return false;
  const dispLabs = expandAgentStoreLabels(displayStore);
  const rowCanon = resolveAgentCanonicalStore(rowStore) || rowStore;
  const rowLabs = expandAgentStoreLabels(rowCanon);
  for (const dl of dispLabs) {
    if (sameStore(dl, rowStore)) return true;
    for (const rl of rowLabs) {
      if (sameStore(dl, rl)) return true;
    }
  }
  for (const rl of rowLabs) {
    if (sameStore(rowStore, rl)) return true;
  }
  return false;
}

function materialBrandMatches(agentData, brandZh) {
  const nb = normalizeAgentMaterialBrand(agentData?.brand);
  if (!nb) return true;
  return nb === brandZh;
}

function parseMeetingScore(fields) {
  const raw =
    fields?.meeting_score ??
    fields?.score ??
    fields?.得分 ??
    fields?.['例会得分'] ??
    fields?.['评分'] ??
    fields?.['会议得分'];
  const s = ext(raw)
    .replace(/分\s*$/g, '')
    .trim();
  if (!s) return null;
  const m = s.match(/(\d+(?:\.\d+)?)/);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

/** 飞书日期列常见非标写法 → 再交给 resolveBitableBusinessYmd */
function normalizeMeetingDateCell(raw) {
  const s = ext(raw).trim();
  if (!s) return '';
  // 纯数字时间戳（10位秒级 / 13位毫秒级）→ 按上海时区解析为 YYYY-MM-DD
  if (/^\d{10,13}$/.test(s)) {
    const n = Number(s);
    const ms = s.length === 13 ? n : n * 1000;
    return new Date(ms).toLocaleString('en-CA', { timeZone: 'Asia/Shanghai' }).slice(0, 10);
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const cn = s.match(/(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日?/);
  if (cn) {
    return `${cn[1]}-${String(cn[2]).padStart(2, '0')}-${String(cn[3]).padStart(2, '0')}`;
  }
  const sl = s.match(/(\d{4})\s*[\/\.\-年]\s*(\d{1,2})\s*[\/\.\-月]\s*(\d{1,2})/);
  if (sl) {
    return `${sl[1]}-${String(sl[2]).padStart(2, '0')}-${String(sl[3]).padStart(2, '0')}`;
  }
  // M/D 或 MM/DD 短格式（飞书部分文本列）→ 补全为当年 YYYY-MM-DD
  const md = s.match(/^(\d{1,2})\/(\d{1,2})$/);
  if (md) {
    const year = new Date().toLocaleString('en-CA', { timeZone: 'Asia/Shanghai' }).slice(0, 4);
    return `${year}-${String(md[1]).padStart(2, '0')}-${String(md[2]).padStart(2, '0')}`;
  }
  return s;
}

/** 马己仙厨房档口（开档/收档各需 1 条/档口/日） */
export const KITCHEN_STATIONS_MAJIXIAN = Object.freeze(['煲仔', '水吧', '炒锅', '烧味', '砧板']);
/** 洪潮厨房档口 */
export const KITCHEN_STATIONS_HONGCHAO = Object.freeze(['煲仔', '水吧', '炒锅', '卤水', '砧板', '刺身']);

export function expectedKitchenStationsForBrand(brandZh) {
  const b = String(brandZh || '').trim();
  if (b === '洪潮') return [...KITCHEN_STATIONS_HONGCHAO];
  return [...KITCHEN_STATIONS_MAJIXIAN];
}

/** 将飞书「档口」文本归一到标准档口名（仅匹配当前品牌清单；长词优先，避免「水」误配） */
export function matchKitchenStation(rawStation, brandZh) {
  let s = String(rawStation || '').trim().replace(/[\s　\u200b]+/g, '');
  if (!s) return null;
  // 去掉括号备注如「炒锅（早班）」
  s = s.replace(/[（(][^)）]*[)）]/g, '').trim();
  const keys = [...expectedKitchenStationsForBrand(brandZh)].sort((a, b) => b.length - a.length);
  for (const key of keys) {
    if (s.includes(key)) return key;
  }
  const stripped = s.replace(/(档口|档|台|口|区|部门|组)$/g, '');
  if (stripped && stripped !== s) {
    for (const key of keys) {
      if (stripped.includes(key)) return key;
    }
  }
  // 常见异名（仍须在品牌清单内二次命中）
  const alias = {
    刺身台: '刺身',
    刺身档: '刺身',
    刺生: '刺身',
    水吧台: '水吧',
    炒灶: '炒锅',
    卤味: '卤水',
    卤菜: '卤水',
    烧味档: '烧味',
    烧腊: '烧味'
  };
  for (const [raw, canon] of Object.entries(alias)) {
    if (!s.includes(raw)) continue;
    if (keys.includes(canon)) return canon;
  }
  return null;
}

function ymdAddDays(ymd, deltaDays) {
  const [y, m, d] = ymd.split('-').map((x) => parseInt(x, 10));
  const u = Date.UTC(y, m - 1, d + deltaDays);
  return new Date(u).toISOString().slice(0, 10);
}

function shanghaiYmdFromCreatedAt(createdAt) {
  if (!createdAt) return '';
  const d = createdAt instanceof Date ? createdAt : new Date(createdAt);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('en-CA', { timeZone: 'Asia/Shanghai' }).slice(0, 10);
}

/**
 * 例会业务日：优先飞书「日期/会议日期」列；列为空且飞书在次日凌晨入库时，按「前一自然日」归因（与营业日关账一致）。
 */
function meetingReportBizYmd(fields, createdAt, anchorYmd) {
  const rawDate =
    normalizeMeetingDateCell(fields?.date) ||
    normalizeMeetingDateCell(fields?.record_date) ||
    normalizeMeetingDateCell(fields?.submit_time) ||
    normalizeMeetingDateCell(fields?.['会议日期']) ||
    normalizeMeetingDateCell(fields?.['例会日期']) ||
    normalizeMeetingDateCell(fields?.['会议时间']) ||
    '';
  let biz = resolveBitableBusinessYmd(rawDate || null, createdAt);
  if (!rawDate && biz !== anchorYmd) {
    const sh = shanghaiYmdFromCreatedAt(createdAt);
    const sc = parseMeetingScore(fields);
    if (sc != null && sc >= 7) {
      if (sh === ymdAddDays(anchorYmd, 1)) biz = anchorYmd;
      if (sh === ymdAddDays(anchorYmd, 2)) biz = anchorYmd;
    }
  }
  return biz;
}

function* eachYmdInclusive(startYmd, endYmd) {
  let cur = startYmd;
  while (cur <= endYmd) {
    yield cur;
    cur = ymdAddDays(cur, 1);
  }
}

/**
 * 按业务日聚合：开档/收档已提交的档口集合 + 原料条数（与执行力日评/月度一致）
 */
export async function buildPmKitchenMapsForRange(displayStore, brandZh, startYmd, endYmd) {
  const padB = CREATED_AT_PAD_BEFORE_MONTH;
  const padA = CREATED_AT_PAD_AFTER_MONTH;
  const caLo = ymdAddDays(startYmd, -padB);
  const caHi = ymdAddDays(endYmd, padA);

  const [openR, closeR, matR] = await Promise.all([
    query(
      `SELECT agent_data, created_at FROM agent_messages
       WHERE content_type = 'opening_report'
         AND (created_at AT TIME ZONE 'Asia/Shanghai')::date >= $1::date
         AND (created_at AT TIME ZONE 'Asia/Shanghai')::date <= $2::date`,
      [caLo, caHi]
    ),
    query(
      `SELECT agent_data, created_at FROM agent_messages
       WHERE content_type = 'closing_report'
         AND (created_at AT TIME ZONE 'Asia/Shanghai')::date >= $1::date
         AND (created_at AT TIME ZONE 'Asia/Shanghai')::date <= $2::date`,
      [caLo, caHi]
    ),
    query(
      `SELECT agent_data, created_at FROM agent_messages
       WHERE content_type = 'material_report'
         AND (created_at AT TIME ZONE 'Asia/Shanghai')::date >= $1::date
         AND (created_at AT TIME ZONE 'Asia/Shanghai')::date <= $2::date`,
      [caLo, caHi]
    )
  ]);

  const openingByDate = new Map();
  const closingByDate = new Map();
  const materialByDate = new Map();

  const addStation = (map, biz, stKey) => {
    if (!biz || biz < startYmd || biz > endYmd || !stKey) return;
    if (!map.has(biz)) map.set(biz, new Set());
    map.get(biz).add(stKey);
  };

  for (const row of openR.rows || []) {
    const fields = row.agent_data?.fields || {};
    if (!storeMatchesRow(displayStore, fields.store)) continue;
    const biz = resolveBitableBusinessYmd(fields.date, row.created_at);
    const st = matchKitchenStation(fields.station, brandZh);
    if (st) addStation(openingByDate, biz, st);
  }
  for (const row of closeR.rows || []) {
    const fields = row.agent_data?.fields || {};
    if (!storeMatchesRow(displayStore, fields.store)) continue;
    const biz = resolveBitableBusinessYmd(fields.date, row.created_at);
    const st = matchKitchenStation(fields.station, brandZh);
    if (st) addStation(closingByDate, biz, st);
  }
  for (const row of matR.rows || []) {
    const ad = row.agent_data && typeof row.agent_data === 'object' ? row.agent_data : {};
    if (!materialBrandMatches(ad, brandZh)) continue;
    const fields = ad.fields || {};
    if (!storeMatchesRow(displayStore, fields.store)) continue;
    const biz = resolveBitableBusinessYmd(fields.date, row.created_at);
    if (!biz || biz < startYmd || biz > endYmd) continue;
    materialByDate.set(biz, (materialByDate.get(biz) || 0) + 1);
  }

  return { openingByDate, closingByDate, materialByDate };
}

/** 出品执行力：某日是否档口齐 + 原料≥1（单日） */
export async function getPMExecutionComplianceForBizDate(displayStore, brandZh, dateYmd) {
  const maps = await buildPmKitchenMapsForRange(displayStore, brandZh, dateYmd, dateYmd);
  const expected = expectedKitchenStationsForBrand(brandZh);
  const oSet = maps.openingByDate.get(dateYmd) || new Set();
  const cSet = maps.closingByDate.get(dateYmd) || new Set();
  const matC = maps.materialByDate.get(dateYmd) || 0;
  const missingOpeningStations = expected.filter((s) => !oSet.has(s));
  const missingClosingStations = expected.filter((s) => !cSet.has(s));
  const materialComplete = matC >= 1;
  return {
    opening: missingOpeningStations.length === 0,
    closing: missingClosingStations.length === 0,
    material: materialComplete,
    materialCount: matC,
    missingOpeningStations,
    missingClosingStations,
    expectedStations: expected
  };
}

/** 月度：有多少个自然日完全达标（开档 N 档 + 收档 N 档 + 原料≥1） */
export async function countFullyCompliantPMDaysInRange(displayStore, brandZh, startYmd, endYmd) {
  const maps = await buildPmKitchenMapsForRange(displayStore, brandZh, startYmd, endYmd);
  const expected = expectedKitchenStationsForBrand(brandZh);
  let compliant = 0;
  for (const day of eachYmdInclusive(startYmd, endYmd)) {
    const oSet = maps.openingByDate.get(day) || new Set();
    const cSet = maps.closingByDate.get(day) || new Set();
    const matC = maps.materialByDate.get(day) || 0;
    const openOk = expected.every((s) => oSet.has(s));
    const closeOk = expected.every((s) => cSet.has(s));
    if (openOk && closeOk && matC >= 1) compliant++;
  }
  return compliant;
}

export async function getPMReportStatusByBizDate(store, brandZh, dateYmd) {
  return getPMExecutionComplianceForBizDate(store, brandZh, dateYmd);
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
    const rawDate =
      normalizeMeetingDateCell(fields.date) ||
      normalizeMeetingDateCell(fields['会议日期']) ||
      normalizeMeetingDateCell(fields['例会日期']) ||
      normalizeMeetingDateCell(fields['会议时间']) ||
      '';
    let biz = resolveBitableBusinessYmd(rawDate || null, row.created_at);
    if (!rawDate) {
      const sh = shanghaiYmdFromCreatedAt(row.created_at);
      const sc = parseMeetingScore(fields);
      const prevDay = ymdAddDays(sh, -1);
      if (
        sc != null &&
        sc >= 7 &&
        prevDay >= startYmd &&
        prevDay <= endYmd &&
        biz === sh
      ) {
        biz = prevDay;
      }
    }
    if (!biz || biz < startYmd || biz > endYmd) continue;
    totalMeetings++;
    const sc = parseMeetingScore(fields);
    if (sc != null && sc >= 7) qualifiedMeetings++;
    else unqualifiedMeetings++;
  }
  return { totalMeetings, qualifiedMeetings, unqualifiedMeetings };
}

/**
 * 马己仙店长执行力日评：某日是否已提交例会及得分（agent_messages.meeting_report）
 *
 * 认定顺序：① 业务日 = dateYmd 的飞书记录；②（可关）前一日业务日已合格（≥7）且当日无记录时，
 * 承认「例会写在昨日 / 关账跨日」仍算本日执行力达标。门店列与 feishu_users.store 双向做别名展开，避免「大宁店↔音乐广场店」漏配。
 * 环境变量：MEETING_REPORT_EXECUTION_COUNT_PREVIOUS_DAY=0 关闭②。
 */
export async function getMajixianMeetingDayEval(displayStore, dateYmd) {
  const r = await query(
    `SELECT agent_data, created_at FROM agent_messages
     WHERE content_type = 'meeting_report'
       AND (created_at AT TIME ZONE 'Asia/Shanghai')::date >= ($1::date - $2::int)
       AND (created_at AT TIME ZONE 'Asia/Shanghai')::date <= ($1::date + $3::int)`,
    [dateYmd, CREATED_AT_PAD_BEFORE_SINGLE_DAY, CREATED_AT_PAD_AFTER_SINGLE_DAY]
  );
  const acceptPrevDay =
    String(process.env.MEETING_REPORT_EXECUTION_COUNT_PREVIOUS_DAY || '1').trim() !== '0';
  const prevYmd = ymdAddDays(dateYmd, -1);

  let latestExact = null;
  let latestExactTs = 0;
  let latestPrev = null;
  let latestPrevTs = 0;

  for (const row of r.rows || []) {
    const fields = row.agent_data?.fields || {};
    if (!storeMatchesRow(displayStore, fields.store)) continue;
    const biz = meetingReportBizYmd(fields, row.created_at, dateYmd);
    const ts = new Date(row.created_at).getTime();
    if (biz === dateYmd) {
      if (ts >= latestExactTs) {
        latestExactTs = ts;
        latestExact = fields;
      }
      continue;
    }
    if (acceptPrevDay && biz === prevYmd) {
      const sc0 = parseMeetingScore(fields);
      if (sc0 != null && sc0 >= 7 && ts >= latestPrevTs) {
        latestPrevTs = ts;
        latestPrev = fields;
      }
    }
  }

  const pick = latestExact || (acceptPrevDay ? latestPrev : null);
  if (!pick) return { submitted: false, score: null, qualified: false };
  const sc = parseMeetingScore(pick);
  return {
    submitted: true,
    score: sc,
    qualified: sc != null && sc >= 7,
    _matchedViaPreviousBizDay: !latestExact && !!latestPrev
  };
}
