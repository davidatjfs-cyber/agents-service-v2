/**
 * 出品经理开档/收档/原料收货 — 按业务日统计（与 agents-service `pm-execution-report-coverage.js` 同源）。
 * HRMS 月度「执行力」与月度综合、执行力日评共用同一数据层（agent_messages + feishu_generic_records）。
 */
import { pool } from '../utils/database.js';
import { expandAgentStoreLabels } from '../v2-store-alignment.js';

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

function materialConfigKeyForBrand(brandZh) {
  if (brandZh === '洪潮') return 'material_hongchao';
  if (brandZh === '马己仙') return 'material_majixian';
  return '';
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
       AND (created_at AT TIME ZONE 'Asia/Shanghai')::date >= $1::date - 2
       AND (created_at AT TIME ZONE 'Asia/Shanghai')::date <= $2::date + 2`,
    [startYmd, endYmd]
  );
  return collectDistinctBizDays(r.rows, displayStore, ['date'], startYmd, endYmd);
}

export async function countDistinctClosingBizDays(displayStore, startYmd, endYmd) {
  const r = await pool().query(
    `SELECT agent_data, created_at FROM agent_messages
     WHERE content_type = 'closing_report'
       AND (created_at AT TIME ZONE 'Asia/Shanghai')::date >= $1::date - 2
       AND (created_at AT TIME ZONE 'Asia/Shanghai')::date <= $2::date + 2`,
    [startYmd, endYmd]
  );
  return collectDistinctBizDays(r.rows, displayStore, ['date'], startYmd, endYmd);
}

export async function countDistinctMaterialBizDays(displayStore, brandZh, startYmd, endYmd) {
  const key = materialConfigKeyForBrand(brandZh);
  if (!key) return 0;
  const r = await pool().query(
    `SELECT fields, created_at FROM feishu_generic_records
     WHERE config_key = $1
     ORDER BY updated_at DESC
     LIMIT 15000`,
    [key]
  );
  const days = new Set();
  for (const row of r.rows || []) {
    const f = row.fields && typeof row.fields === 'object' ? row.fields : {};
    if (!storeMatchesRow(displayStore, f['门店'] || f['所属门店'])) continue;
    const biz = resolveBitableBusinessYmd(f['收货日期'] || f['日期'], row.created_at);
    if (biz && biz >= startYmd && biz <= endYmd) days.add(biz);
  }
  return days.size;
}
