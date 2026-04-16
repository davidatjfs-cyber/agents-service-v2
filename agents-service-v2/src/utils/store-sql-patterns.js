/**
 * 生成飞书多维表「门店/所属门店」字段的 ILIKE 模式，避免仅按 updated_at 拉全表前 N 条时
 * 高频同步门店（如洪潮）挤掉低频门店（如马己仙）的记录。
 */
import { toFeishuStoreName, expandAgentStoreLabels } from '../config/store-mapping.js';

export function normalizeStoreCompact(s) {
  return String(s || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '');
}

/**
 * @param {string} hrmsStoreName HRMS / 员工绑定门店全称
 * @returns {string[]} 用于 SQL `ILIKE ANY($n::text[])` 的模式（已含 %）
 */
export function feishuStoreSearchPatterns(hrmsStoreName) {
  const s = String(hrmsStoreName || '').trim();
  if (!s) return ['%'];
  const out = new Set();
  const add = (p) => {
    const t = String(p || '').trim();
    if (t.length >= 2) out.add(t);
  };
  for (const lab of expandAgentStoreLabels(s)) {
    add(`%${lab.replace(/%/g, '')}%`);
  }
  add(`%${s}%`);
  const feishu = toFeishuStoreName(s);
  if (feishu && feishu !== s) add(`%${feishu}%`);
  if (/马己仙|马已仙/.test(s)) {
    add('%马己仙%');
    add('%马已仙%');
    add('%马己仙大宁%');
    add('%马己仙上海音乐%');
    add('%音乐广场%');
  }
  if (/洪潮/.test(s)) {
    add('%洪潮%');
    add('%洪潮久光%');
    add('%洪潮大宁%');
    add('%大宁久光%');
  }
  const arr = [...out];
  return arr.length ? arr : [`%${s}%`];
}
