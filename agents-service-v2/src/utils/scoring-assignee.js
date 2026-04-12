/**
 * 绩效/报告中的「门店 + 岗位」责任人解析（避免 feishu_users 多人绑定时选错账号）。
 * 马己仙上海音乐广场店出品经理以黎永荣（NNYXLYR04）为准；nnyxcs35 为误绑账号时不应出现在报告上。
 */
import { query } from './db.js';

const CANONICAL_MAJIXIAN_PM = { username: 'NNYXLYR04', displayName: '黎永荣' };

/**
 * 报告/卡片上的展示名：马己仙出品经理观察号与误填「测试」等占位名，统一为主责「黎永荣」，
 * 与执行力日评、月度评级选人逻辑一致（数据来源仍为 master_tasks.assignee_username）。
 */
export function resolvePerformanceReportDisplayName(store, role, username, rawNameFromFeishu) {
  const raw = String(rawNameFromFeishu ?? '').trim();
  const u = String(username || '').trim().toLowerCase();
  const canonU = String(CANONICAL_MAJIXIAN_PM.username).toLowerCase();
  if (isMajixianStore(store) && role === 'store_production_manager') {
    if (isMajixianPmObserverUsername(username)) return CANONICAL_MAJIXIAN_PM.displayName;
    if (u === canonU) {
      if (raw && /黎/.test(raw)) return raw;
      return CANONICAL_MAJIXIAN_PM.displayName;
    }
    if (/^测试$/i.test(raw) || /^test$/i.test(raw)) return CANONICAL_MAJIXIAN_PM.displayName;
  }
  if (raw) return raw;
  return String(username || '').trim() || '—';
}

/** 马己仙出品观察账号：接收与黎永荣相同的绩效推送，但不参与任务类飞书交互（见 message-pipeline / feishu-client） */
export const MAJIXIAN_PM_OBSERVER_USERNAME = 'nnyxcs35';

export function isMajixianPmObserverUsername(username) {
  return String(username || '').trim().toLowerCase() === MAJIXIAN_PM_OBSERVER_USERNAME;
}

/** 周报卡片上从 new_model 取维度时：观察号行用黎永荣库里的 new_model */
export function majixianPmNewModelLookupUsername(rowUsername, store) {
  if (!isMajixianStore(store)) return rowUsername;
  return isMajixianPmObserverUsername(rowUsername) ? CANONICAL_MAJIXIAN_PM.username : rowUsername;
}

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
 * 马己仙门店出品经理：主责为黎永荣（NNYXLYR04）；若存在 nnyxcs35 观察绑定，排在第二位，
 * 周度/月度写入与飞书同步两份（观察行 name 为「黎永荣（观察同步）」便于报告与管理端识别）。
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

    const pickNonObserverPrimary = () => {
      const first = sorted[0];
      if (first && !isMajixianPmObserverUsername(first.username)) {
        const u = String(first.username || '').trim();
        const name =
          u.toUpperCase() === CANONICAL_MAJIXIAN_PM.username
            ? CANONICAL_MAJIXIAN_PM.displayName
            : String(first.disp || '').trim() || CANONICAL_MAJIXIAN_PM.displayName;
        return { username: u, name };
      }
      return null;
    };

    let canon = pickNonObserverPrimary();
    if (!canon) {
      const fetched = await fetchFeishuUserByUsername(CANONICAL_MAJIXIAN_PM.username);
      if (fetched) {
        canon = { username: String(fetched.username).trim(), name: CANONICAL_MAJIXIAN_PM.displayName };
      }
    }
    if (!canon && sorted[0]) {
      canon = {
        username: String(sorted[0].username || '').trim(),
        name: String(sorted[0].disp || sorted[0].username || '')
      };
    }
    if (!canon) {
      return [{ username: '__periodic_kitchen__', name: '出品经理(周度自动·未绑定)' }];
    }

    const out = [canon];
    const obs = sorted.find((row) => isMajixianPmObserverUsername(row.username));
    if (obs && !isMajixianPmObserverUsername(canon.username)) {
      out.push({
        username: String(obs.username || '').trim(),
        name: `${CANONICAL_MAJIXIAN_PM.displayName}（观察同步）`
      });
    }
    return out;
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
