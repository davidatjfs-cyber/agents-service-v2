import { logger } from '../../utils/logger.js';
import { query } from '../../utils/db.js';
import { feishuStoreSearchPatterns } from '../../utils/store-sql-patterns.js';
import { toFeishuStoreName, resolveAgentCanonicalStore } from '../../config/store-mapping.js';

// ── Bitable fields 解析（feishu_generic_records.fields 为 jsonb，值可能为 string/number/array） ──
function extractBitableFieldText(val) {
  if (val == null) return '';
  if (typeof val === 'string') return val.trim();
  if (typeof val === 'number') return String(val);
  if (Array.isArray(val)) {
    const parts = [];
    for (const item of val) {
      if (typeof item === 'string') { parts.push(item.trim()); continue; }
      if (item && typeof item === 'object') {
        if (item.text != null) parts.push(String(item.text).trim());
        else if (Array.isArray(item.text_arr)) parts.push(...item.text_arr.map(t => String(t || '').trim()).filter(Boolean));
        else if (item.date) parts.push(String(item.date).trim());
      }
    }
    return parts.filter(Boolean).join(' ');
  }
  if (typeof val === 'object' && val !== null && (val.text != null || val.date != null)) return String(val.text || val.date || '').trim();
  return '';
}

function extractBitableFieldTextFromFields(fields, key) {
  if (!fields || typeof fields !== 'object') return '';
  const raw = fields[key] ?? fields[key.replace(/[^一-龥a-zA-Z0-9_]/g, '')];
  return extractBitableFieldText(raw);
}

/** 从 Bitable 记录中取门店名（兼容多种字段名） */
function getStoreFromBitableFields(fields) {
  const keys = ['门店', '所属门店', '门店名称', '店名', '店铺'];
  for (const k of keys) {
    const v = extractBitableFieldTextFromFields(fields, k);
    if (v) return v;
  }
  return '';
}

/** 从 Bitable 字段解析出 YYYY-MM-DD，支持时间戳(ms/s)、日期字符串、{date: "YYYY-MM-DD"} */
function normalizeBitableDateFromFields(fields, dateKey = '日期') {
  const raw = fields && (fields[dateKey] ?? fields['提交时间'] ?? fields['记录日期']);
  if (raw == null) return null;
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    const ms = raw > 1e12 ? raw : raw * 1000;
    // 返回"本地时区日期"，避免 UTC 切片导致昨日/今天错位
    const d0 = new Date(ms);
    if (isNaN(d0.getTime())) return null;
    const y = d0.getFullYear();
    const m = String(d0.getMonth() + 1).padStart(2, '0');
    const day = String(d0.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }
  if (typeof raw === 'string' && /^\d{4}-\d{2}-\d{2}/.test(raw)) return raw.slice(0, 10);
  if (Array.isArray(raw) && raw[0]?.date) return String(raw[0].date).slice(0, 10);
  if (typeof raw === 'object' && raw?.date) return String(raw.date).slice(0, 10);
  return null;
}

/** 门店模糊匹配（与 V1 isLikelySameStore 一致） */
function isLikelySameStore(a, b) {
  const n = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, '');
  const x = n(a), y = n(b);
  if (!x || !y) return false;
  if (x === y || x.includes(y) || y.includes(x)) return true;
  return false;
}

function normalizeStoreKey(v) {
  return String(v || '').trim().toLowerCase().replace(/\s+/g, '');
}

function normalizeStoreAliasKey(v) {
  return normalizeStoreKey(v).replace(/(上海|北京|深圳|广州|大宁|门店|店铺|店|商场|广场|购物中心)/g, '');
}

function sameStore(a, b) {
  const x = normalizeStoreKey(a);
  const y = normalizeStoreKey(b);
  if (!x || !y) return false;
  if (x === y || x.includes(y) || y.includes(x)) return true;
  const ax = normalizeStoreAliasKey(a);
  const by = normalizeStoreAliasKey(b);
  return !!(ax && by && (ax === by || ax.includes(by) || by.includes(ax)));
}

const ALLOWED_RESOLVE_TABLES = new Set(['sales_raw', 'daily_reports']);

async function resolveDbStoreName(tableName, storeInput) {
  const s = String(storeInput || '').trim();
  if (!s) return '';
  if (!ALLOWED_RESOLVE_TABLES.has(tableName)) {
    logger.warn({ tableName }, 'resolveDbStoreName: blocked disallowed tableName');
    return s;
  }
  try {
    const r = await query(`SELECT DISTINCT store FROM ${tableName} WHERE store IS NOT NULL LIMIT 200`);
    const stores = (r.rows || []).map(x => x.store).filter(Boolean);
    const exact = stores.find(x => normalizeStoreKey(x) === normalizeStoreKey(s));
    if (exact) return exact;
    const likely = stores.find(x => sameStore(x, s));
    if (likely) return likely;
  } catch(_e) {}
  return s;
}

export {
  extractBitableFieldText,
  extractBitableFieldTextFromFields,
  getStoreFromBitableFields,
  normalizeBitableDateFromFields,
  isLikelySameStore,
  normalizeStoreKey,
  normalizeStoreAliasKey,
  sameStore,
  ALLOWED_RESOLVE_TABLES,
  resolveDbStoreName,
};
