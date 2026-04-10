/**
 * 出品经理开档/收档/原料收货、马己仙例会 — 按业务日统计，数据仅来自 `agent_messages`（与 agents `pm-execution-report-coverage.js` 同源）。
 * 洪潮店长企微仍用营业日报，不在此文件。
 */
import { pool } from '../utils/database.js';
import { expandAgentStoreLabels, normalizeAgentMaterialBrand } from '../v2-store-alignment.js';

const CREATED_AT_PAD_BEFORE_MONTH = 45;
const CREATED_AT_PAD_AFTER_MONTH = 45;

function fmt(d) {
  const dt = d instanceof Date ? d : new Date(d);
  if (isNaN(dt.getTime())) return '';
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(dt);
}

function toD(v) {
  if (v instanceof Date) {
    if (isNaN(v.getTime())) return '';
    return fmt(v);
  }
  const s = String(v || '').trim();
  if (!s) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  try {
    const d0 = new Date(s);
    if (!Number.isFinite(d0.getTime())) return '';
    return toD(d0);
  } catch {
    return '';
  }
}

function bitableDate(v, fb) {
  if (v == null || v === '') return toD(fb);
  if (typeof v === 'number' && Number.isFinite(v)) return toD(new Date(v > 1e12 ? v : v * 1000));
  const s = String(v).trim();
  if (!s) return toD(fb);
  if (/^\d{10,13}$/.test(s)) {
    const n = Number(s);
    return toD(new Date(s.length === 13 ? n : n * 1000));
  }
  return toD(s) || toD(fb);
}

export function resolveBitableBusinessYmd(fieldVal, createdAt) {
  return bitableDate(fieldVal, createdAt);
}

export function ext(val) {
  if (!val) return '';
  if (typeof val === 'string') return val.trim();
  if (typeof val === 'number') return String(val);
  if (Array.isArray(val)) {
    const p = [];
    for (const it of val) {
      if (typeof it === 'string') {
        p.push(it);
        continue;
      }
      if (it && typeof it === 'object') {
        if (Array.isArray(it.text_arr) && it.text_arr.length) {
          p.push(...it.text_arr.map((t) => String(t || '').trim()).filter(Boolean));
        } else if (it.text) p.push(String(it.text).trim());
        else if (it.name) p.push(String(it.name).trim());
      }
    }
    return p.join('，').trim();
  }
  if (typeof val === 'object' && val && Array.isArray(val.value)) {
    const p = [];
    for (const it of val.value) {
      if (typeof it === 'string') p.push(it.trim());
      else if (it && typeof it === 'object') {
        if (it.text) p.push(String(it.text).trim());
        else if (it.name) p.push(String(it.name).trim());
      }
    }
    const j = p.filter(Boolean).join('，').trim();
    if (j) return j;
  }
  if (typeof val === 'object' && val && val.text != null) return String(val.text).trim();
  if (typeof val === 'object' && val && val.name != null) return String(val.name).trim();
  if (typeof val === 'object' && val && val.value != null && typeof val.value !== 'object') {
    return String(val.value).trim();
  }
  return String(val).trim();
}

function storeKey(v) {
  return String(v || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '');
}
function storeAlias(v) {
  return storeKey(v).replace(/(上海|北京|深圳|广州|大宁|门店|店铺|店|商场|广场|购物中心)/g, '');
}

export function sameStore(a, b) {
  const x = storeKey(a);
  const y = storeKey(b);
  if (!x || !y) return false;
  if (x === y || x.includes(y) || y.includes(x)) return true;
  const ax = storeAlias(a);
  const by = storeAlias(b);
  return !!(ax && by && (ax === by || ax.includes(by) || by.includes(ax)));
}

function storeMatchesRow(displayStore, rowStoreRaw) {
  const rowStore = ext(rowStoreRaw);
  if (!rowStore) return false;
  const labels = expandAgentStoreLabels(displayStore);
  return labels.some((lab) => sameStore(rowStore, lab));
}

function materialBrandMatches(agentData, brandZh) {
  const nb = normalizeAgentMaterialBrand(agentData?.brand);
  if (!nb) return true;
  return nb === brandZh;
}

const KITCHEN_STATIONS_MAJIXIAN = Object.freeze(['煲仔', '水吧', '炒锅', '烧味', '砧板']);
const KITCHEN_STATIONS_HONGCHAO = Object.freeze(['煲仔', '水吧', '炒锅', '卤水', '砧板', '刺身']);

function expectedKitchenStationsForBrand(brandZh) {
  const b = String(brandZh || '').trim();
  if (b === '洪潮') return [...KITCHEN_STATIONS_HONGCHAO];
  return [...KITCHEN_STATIONS_MAJIXIAN];
}

function matchKitchenStation(rawStation, brandZh) {
  const s = String(rawStation || '').trim();
  if (!s) return null;
  for (const key of expectedKitchenStationsForBrand(brandZh)) {
    if (s.includes(key)) return key;
  }
  return null;
}

function ymdAddDays(ymd, deltaDays) {
  const [y, m, d] = ymd.split('-').map((x) => parseInt(x, 10));
  const u = Date.UTC(y, m - 1, d + deltaDays);
  return new Date(u).toISOString().slice(0, 10);
}

function* eachYmdInclusive(startYmd, endYmd) {
  let cur = startYmd;
  while (cur <= endYmd) {
    yield cur;
    cur = ymdAddDays(cur, 1);
  }
}

async function buildPmKitchenMapsForRange(displayStore, brandZh, startYmd, endYmd) {
  const padB = CREATED_AT_PAD_BEFORE_MONTH;
  const padA = CREATED_AT_PAD_AFTER_MONTH;
  const caLo = ymdAddDays(startYmd, -padB);
  const caHi = ymdAddDays(endYmd, padA);

  const [openR, closeR, matR] = await Promise.all([
    pool().query(
      `SELECT agent_data, created_at FROM agent_messages
       WHERE content_type = 'opening_report'
         AND (created_at AT TIME ZONE 'Asia/Shanghai')::date >= $1::date
         AND (created_at AT TIME ZONE 'Asia/Shanghai')::date <= $2::date`,
      [caLo, caHi]
    ),
    pool().query(
      `SELECT agent_data, created_at FROM agent_messages
       WHERE content_type = 'closing_report'
         AND (created_at AT TIME ZONE 'Asia/Shanghai')::date >= $1::date
         AND (created_at AT TIME ZONE 'Asia/Shanghai')::date <= $2::date`,
      [caLo, caHi]
    ),
    pool().query(
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

/** 与 agents `countFullyCompliantPMDaysInRange` 一致：月度出品执行力用「完全达标自然日」计数 */
export async function countFullyCompliantPMDaysInRange(displayStore, brandZh, startYmd, endYmd) {
  const maps = await buildPmKitchenMapsForRange(displayStore, brandZh, startYmd, endYmd);
  const expected = expectedKitchenStationsForBrand(brandZh);
  let compliant = 0;
  for (const day of eachYmdInclusive(startYmd, endYmd)) {
    const oSet = maps.openingByDate.get(day) || new Set();
    const cSet = maps.closingByDate.get(day) || new Set();
    const matC = maps.materialByDate.get(day) || 0;
    const openOk = expected.every((st) => oSet.has(st));
    const closeOk = expected.every((st) => cSet.has(st));
    if (openOk && closeOk && matC >= 1) compliant++;
  }
  return compliant;
}

function parseMeetingScore(fields) {
  const raw = fields?.meeting_score ?? fields?.score ?? fields?.得分;
  const n = Number(String(raw ?? '').trim());
  return Number.isFinite(n) ? n : null;
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

export async function countDistinctOpeningBizDays(displayStore, startYmd, endYmd) {
  const r = await pool().query(
    `SELECT agent_data, created_at FROM agent_messages
     WHERE content_type = 'opening_report'
       AND (created_at AT TIME ZONE 'Asia/Shanghai')::date >= ($1::date - $3::int)
       AND (created_at AT TIME ZONE 'Asia/Shanghai')::date <= ($2::date + $4::int)`,
    [startYmd, endYmd, CREATED_AT_PAD_BEFORE_MONTH, CREATED_AT_PAD_AFTER_MONTH]
  );
  return collectDistinctBizDays(r.rows, displayStore, ['date'], startYmd, endYmd);
}

export async function countDistinctClosingBizDays(displayStore, startYmd, endYmd) {
  const r = await pool().query(
    `SELECT agent_data, created_at FROM agent_messages
     WHERE content_type = 'closing_report'
       AND (created_at AT TIME ZONE 'Asia/Shanghai')::date >= ($1::date - $3::int)
       AND (created_at AT TIME ZONE 'Asia/Shanghai')::date <= ($2::date + $4::int)`,
    [startYmd, endYmd, CREATED_AT_PAD_BEFORE_MONTH, CREATED_AT_PAD_AFTER_MONTH]
  );
  return collectDistinctBizDays(r.rows, displayStore, ['date'], startYmd, endYmd);
}

export async function countDistinctMaterialBizDays(displayStore, brandZh, startYmd, endYmd) {
  const r = await pool().query(
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

/** 马己仙店长月度执行力：例会条数（agent_messages.meeting_report，与 agents 侧一致） */
export async function getMajixianMeetingExecutionStatsFromAgentMessages(displayStore, startYmd, endYmd) {
  const r = await pool().query(
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
