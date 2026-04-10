/**
 * 绩效/报告中的「门店 + 岗位」责任人解析（避免 feishu_users 多人绑定时选错账号）。
 * 马己仙上海音乐广场店出品经理以黎永荣（NNYXLYR04）为准；nnyxcs35 为误绑账号时不应出现在报告上。
 */
import { query } from './db.js';

const CANONICAL_MAJIXIAN_PM = { username: 'NNYXLYR04', displayName: '黎永荣' };

export function isMajixianStore(store) {
  return /马己仙/.test(String(store || ''));
}

/**
 * 飞书用户行排序：马己仙出品经理优先黎永荣 / NNYXLYR04，压低 nnyxcs35、测试账号。
 * @param {Array<{ username?: string, disp?: string, name?: string }>} rows
 */
export function sortFeishuScoringRows(store, role, rows) {
  const isMjPm = role === 'store_production_manager' && isMajixianStore(store);
  return [...(rows || [])].sort((a, b) => priorityRow(a, isMjPm) - priorityRow(b, isMjPm));
}

function priorityRow(row, isMjPm) {
  if (!isMjPm) return 0;
  const u = String(row?.username || '').trim().toLowerCase();
  const n = String(row?.disp || row?.name || '').trim();
  if (u === String(CANONICAL_MAJIXIAN_PM.username).toLowerCase() || n.includes('黎永荣')) return 0;
  if (u === 'nnyxcs35') return 200;
  if (n.includes('测试')) return 150;
  return 50;
}

async function fetchFeishuUserByUsername(username) {
  const u = String(username || '').trim();
  if (!u) return null;
  try {
    const r = await query(
      `SELECT username, COALESCE(NULLIF(TRIM(name), ''), username) AS disp
       FROM feishu_users
       WHERE registered = true AND LOWER(username) = LOWER($1)
       LIMIT 1`,
      [u]
    );
    const row = r.rows?.[0];
    if (row?.username) return { username: String(row.username).trim(), disp: row.disp || row.username };
  } catch (_e) {
    /* ignore */
  }
  return null;
}

/**
 * 马己仙门店出品经理：报告与 agent_scores 只认黎永荣（NNYXLYR04）；若库中仍有 nnyxcs35 绑定，不采用。
 */
export async function resolveMajixianProductionManagersForScoring(store) {
  if (!isMajixianStore(store)) return [];
  try {
    const r = await query(
      `SELECT username, COALESCE(NULLIF(TRIM(name), ''), username) AS disp
       FROM feishu_users
       WHERE registered = true AND role = 'store_production_manager'
         AND (store = $1 OR $1 ILIKE '%' || store || '%' OR store ILIKE '%' || $1 || '%')`,
      [store]
    );
    const sorted = sortFeishuScoringRows(store, 'store_production_manager', r.rows || []);
    const first = sorted[0];
    if (first && String(first.username || '').toLowerCase() !== 'nnyxcs35') {
      const u = String(first.username || '').trim();
      const name =
        u.toUpperCase() === CANONICAL_MAJIXIAN_PM.username
          ? CANONICAL_MAJIXIAN_PM.displayName
          : String(first.disp || '').trim() || CANONICAL_MAJIXIAN_PM.displayName;
      return [{ username: u, name }];
    }
    const canon = await fetchFeishuUserByUsername(CANONICAL_MAJIXIAN_PM.username);
    if (canon) {
      return [{ username: canon.username, name: CANONICAL_MAJIXIAN_PM.displayName }];
    }
    if (first) return [{ username: String(first.username).trim(), name: String(first.disp || first.username) }];
  } catch (_e) {
    /* ignore */
  }
  return [{ username: '__periodic_kitchen__', name: '出品经理(周度自动·未绑定)' }];
}

export async function resolveSingleScoringUser(store, role) {
  if (role === 'store_production_manager' && isMajixianStore(store)) {
    const arr = await resolveMajixianProductionManagersForScoring(store);
    return arr[0] || { username: '__periodic_kitchen__', name: '出品经理(周度自动·未绑定)' };
  }
  try {
    const r = await query(
      `SELECT username, COALESCE(NULLIF(TRIM(name), ''), username) AS disp
       FROM feishu_users
       WHERE registered = true AND role = $2
         AND (store = $1 OR $1 ILIKE '%' || store || '%' OR store ILIKE '%' || $1 || '%')
       ORDER BY updated_at DESC NULLS LAST`,
      [store, role]
    );
    const rows = sortFeishuScoringRows(store, role, r.rows || []);
    const row = rows[0];
    if (row?.username) return { username: String(row.username).trim(), name: row.disp || row.username };
  } catch (_e) {
    /* ignore */
  }
  if (role === 'store_manager') return { username: '__periodic_store_manager__', name: '店长(周度自动·未绑定)' };
  return { username: '__periodic_kitchen__', name: '出品经理(周度自动·未绑定)' };
}
