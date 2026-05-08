import axios from 'axios';
import { query } from '../utils/db.js';
import { logger } from '../utils/logger.js';
import { normalizeMobileForFeishuBatchGet } from '../utils/feishu-open-id-helpers.js';
import { getTenantToken, BASE } from './feishu-auth.js';
import { isMajixianPmObserverUsername } from '../utils/scoring-assignee.js';

function feishuSkipOpenIdResolve() {
  const v = String(process.env.FEISHU_SKIP_OPEN_ID_RESOLVE || '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

/**
 * 用当前应用 tenant_access_token 调通讯录 batch_get_id，得到本应用可用的 open_id，并尽量回写 feishu_users。
 * 解决「DB 里存了另一套飞书应用写入的 open_id」导致的 IM 报错 open_id cross app（晨报/达成率等定时任务常见）。
 */
export async function resolveOpenIdForCurrentFeishuApp(row) {
  const username = String(row?.username || '').trim();
  let current = String(row?.open_id || '').trim();
  if (!username && !current) return current;

  let mobile = normalizeMobileForFeishuBatchGet(row?.mobile);
  if (!mobile && username) {
    try {
      const r = await query(
        `SELECT NULLIF(trim(mobile), '') AS m FROM feishu_users WHERE lower(trim(username)) = lower(trim($1)) LIMIT 1`,
        [username]
      );
      mobile = normalizeMobileForFeishuBatchGet(r.rows?.[0]?.m);
    } catch (e) {
      logger.warn({ err: e?.message, username }, 'resolveOpenId: feishu_users mobile lookup failed');
    }
  }
  let emails = [];
  if (!mobile && username) {
    try {
      const r = await query(
        `SELECT NULLIF(trim(phone), '') AS p FROM users WHERE lower(trim(username)) = lower(trim($1)) LIMIT 1`,
        [username]
      );
      mobile = normalizeMobileForFeishuBatchGet(r.rows?.[0]?.p);
    } catch (e) {
      logger.warn({ err: e?.message, username }, 'resolveOpenId: users.phone lookup failed');
    }
    if (!mobile) {
      try {
        const r2 = await query(
          `SELECT NULLIF(trim(lower(email)), '') AS e FROM users WHERE lower(trim(username)) = lower(trim($1)) LIMIT 1`,
          [username]
        );
        const e = r2.rows?.[0]?.e;
        if (e) emails.push(String(e).trim());
      } catch (e) {
        logger.warn({ err: e?.message, username }, 'resolveOpenId: users.email lookup failed');
      }
    }
  }

  const body = {};
  if (mobile) body.mobiles = [mobile];
  if (emails.length) body.emails = emails;
  if (!body.mobiles && !body.emails) {
    logger.warn({ username, hasOpenId: !!current }, 'resolveOpenId: no mobile/email to batch_get_id');
    return current;
  }

  const t = await getTenantToken();
  if (!t) return current;

  try {
    const r = await axios.post(
      `${BASE}/contact/v3/users/batch_get_id`,
      body,
      {
        headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json; charset=utf-8' },
        params: { user_id_type: 'open_id' },
        timeout: 15000
      }
    );
    if (r.data?.code !== 0) {
      logger.warn(
        { username, code: r.data?.code, msg: r.data?.msg },
        'resolveOpenId: batch_get_id failed'
      );
      return current;
    }
    const list = r.data?.data?.user_list;
    const item = Array.isArray(list) ? list[0] : null;
    const resolved = String(item?.user_id || '').trim();
    if (!resolved) {
      logger.warn({ username }, 'resolveOpenId: batch_get_id returned empty user_id');
      return current;
    }
    if (resolved === current) return current;

    if (username) {
      try {
        const conflict = await query(
          `SELECT username FROM feishu_users
           WHERE open_id = $1 AND lower(trim(username)) <> lower(trim($2)) LIMIT 1`,
          [resolved, username]
        );
        if (conflict.rows?.length) {
          logger.warn(
            { username, resolved, other: conflict.rows[0].username },
            'resolveOpenId: resolved open_id already bound to another row; skip DB update, still use for send'
          );
          return resolved;
        }
        await query(
          `UPDATE feishu_users SET open_id = $1, updated_at = NOW(), registered = TRUE
           WHERE lower(trim(username)) = lower(trim($2))`,
          [resolved, username]
        );
        logger.info({ username, from: current, to: resolved }, 'resolveOpenId: feishu_users.open_id updated for current app');
      } catch (e) {
        logger.warn({ err: e?.message, username }, 'resolveOpenId: feishu_users UPDATE failed (send may still succeed)');
      }
    }
    return resolved;
  } catch (e) {
    logger.warn({ err: e?.message, username }, 'resolveOpenId: batch_get_id exception');
    return current;
  }
}

/** IM 投递失败且为 cross-app 时，按 feishu_users.open_id 反查行并解析本应用 open_id */
export async function refreshFeishuUserOpenIdForImDelivery(staleOpenId) {
  const stale = String(staleOpenId || '').trim();
  if (!stale) return null;
  let r;
  try {
    r = await query(
      `SELECT username, open_id, mobile FROM feishu_users WHERE open_id = $1 LIMIT 1`,
      [stale]
    );
  } catch (e) {
    logger.warn({ err: e?.message }, 'refreshFeishuOpenId: lookup failed');
    return null;
  }
  const row = r.rows?.[0];
  if (!row?.username) {
    logger.warn({ stale }, 'refreshFeishuOpenId: no feishu_users row for this open_id');
    return null;
  }
  const resolved = await resolveOpenIdForCurrentFeishuApp(row);
  if (resolved && resolved !== stale) return resolved;

  // 降级：手机号/邮箱解析失败时，尝试同一 username 其他行（可能由正确应用写入）
  try {
    const altR = await query(
      `SELECT open_id FROM feishu_users
       WHERE lower(trim(username)) = lower(trim($1))
       AND open_id IS NOT NULL AND trim(open_id) <> ''
       AND open_id <> $2
       ORDER BY updated_at DESC NULLS LAST LIMIT 1`,
      [row.username, stale]
    );
    if (altR.rows?.[0]?.open_id) {
      const alt = String(altR.rows[0].open_id).trim();
      logger.warn(
        { username: row.username, from: stale, to: alt },
        'refreshFeishuOpenId: fallback to alternative row open_id'
      );
      return alt;
    }
  } catch (e) {
    logger.warn({ err: e?.message, username: row.username }, 'refreshFeishuOpenId: fallback lookup failed');
  }

  return null;
}

export async function lookupUser(openId) {
  try { const r = await query('SELECT * FROM feishu_users WHERE open_id = $1 LIMIT 1', [openId]); return r.rows?.[0] || null; } catch (e) { return null; }
}

/** 从 HRMS 员工信息(hrms_state.employees) 按 username 取姓名，优先于 feishu_users.name */
export async function getHrmsEmployeeName(username) {
  if (!username || !String(username).trim()) return null;
  try {
    const r = await query(
      `SELECT data FROM hrms_state WHERE key = $1 LIMIT 1`,
      ['default']
    );
    const data = r.rows?.[0]?.data;
    if (!data || typeof data !== 'object') return null;
    const employees = Array.isArray(data.employees) ? data.employees : [];
    const emp = employees.find(
      e => String(e?.username || '').trim().toLowerCase() === String(username).trim().toLowerCase()
    );
    const name = emp?.name != null ? String(emp.name).trim() : null;
    return name || null;
  } catch (e) {
    logger.warn({ err: e?.message, username }, 'getHrmsEmployeeName failed (hrms_state may not exist)');
    return null;
  }
}

/** 通过飞书通讯录 API 获取用户姓名（open_id → name），DB 无 name 时用此兜底 */
export async function getFeishuUserName(openId) {
  if (!openId) return null;
  const t = await getTenantToken();
  if (!t) return null;
  try {
    const r = await axios.get(
      BASE + '/contact/v3/users/' + encodeURIComponent(openId),
      { headers: { Authorization: 'Bearer ' + t }, params: { user_id_type: 'open_id' }, timeout: 5000 }
    );
    const data = r.data?.data?.user;
    if (data && (data.name || data.en_name)) return (data.name || data.en_name || '').trim() || null;
    return null;
  } catch (e) {
    logger.warn({ err: e?.message, openId }, 'getFeishuUserName failed');
    return null;
  }
}

/** 从 HRMS 员工信息获取完整员工记录（含 status） */
export async function getHrmsEmployeeByUsername(username) {
  if (!username || !String(username).trim()) return null;
  try {
    const r = await query(
      `SELECT data FROM hrms_state WHERE key = $1 LIMIT 1`,
      ['default']
    );
    const data = r.rows?.[0]?.data;
    if (!data || typeof data !== 'object') return null;
    const employees = Array.isArray(data.employees) ? data.employees : [];
    const emp = employees.find(
      e => String(e?.username || '').trim().toLowerCase() === String(username).trim().toLowerCase()
    );
    return emp || null;
  } catch (e) {
    logger.warn({ err: e?.message, username }, 'getHrmsEmployeeByUsername failed (hrms_state may not exist)');
    return null;
  }
}

/** 检查 HRMS 员工是否在职（排除 离职/inactive / 已审批离职） */
export function isHrmsEmployeeActive(emp) {
  if (!emp) return false;
  const status = String(emp.status || '').trim().toLowerCase();
  const inactiveList = ['离职', 'inactive', 'resigned', 'deleted', 'terminated', '已离职', '已删除', '禁用', '停用'];
  if (inactiveList.includes(status)) return false;
  const approved = emp.offboardingApproved === true || emp.offboardingApproved === 'true' || emp.offboardingApproved === 1;
  if (approved && String(emp.offboardingDate || '').trim()) return false;
  return true;
}

/** 通过 Feishu open_id 查找已绑定的 HRMS 员工信息（含状态校验） */
export async function getHrmsEmployeeByFeishuOpenId(openId) {
  if (!openId) return null;
  try {
    // 1. 先查 feishu_users 看是否已绑定 username
    const fu = await query('SELECT username FROM feishu_users WHERE open_id = $1 AND registered = TRUE LIMIT 1', [openId]);
    if (fu.rows?.[0]?.username) {
      // 已绑定，直接查 HRMS
      return await getHrmsEmployeeByUsername(fu.rows[0].username);
    }
    // 2. 未绑定：尝试通过飞书用户名匹配 HRMS（模糊匹配）
    const feishuName = await getFeishuUserName(openId);
    if (feishuName) {
      const empByName = await findHrmsEmployeeByName(feishuName);
      if (empByName) return empByName;
    }
    // 3. 仍找不到，返回 null（需要绑定）
    return null;
  } catch (e) {
    logger.warn({ err: e?.message, openId }, 'getHrmsEmployeeByFeishuOpenId failed');
    return null;
  }
}

/** 在 HRMS 中通过姓名模糊匹配员工（用于未绑定时的兜底） */
async function findHrmsEmployeeByName(name) {
  if (!name) return null;
  try {
    const r = await query(`SELECT data FROM hrms_state WHERE key = $1 LIMIT 1`, ['default']);
    const data = r.rows?.[0]?.data;
    if (!data || typeof data !== 'object') return null;
    const employees = Array.isArray(data.employees) ? data.employees : [];
    // 模糊匹配：姓名包含或被包含
    const nameTrim = name.trim().toLowerCase();
    const emp = employees.find(e => {
      const empName = String(e?.name || '').trim().toLowerCase();
      return empName && (empName.includes(nameTrim) || nameTrim.includes(empName));
    });
    return emp || null;
  } catch (e) {
    logger.warn({ err: e?.message, name }, 'findHrmsEmployeeByName failed');
    return null;
  }
}

export async function lookupUserByUsername(username) {
  try { const r = await query('SELECT * FROM feishu_users WHERE lower(username) = lower($1) AND registered = TRUE ORDER BY updated_at DESC LIMIT 1', [username]); return r.rows?.[0] || null; } catch (e) { return null; }
}

/** 自助绑定飞书用户到HRMS员工账号 */
export async function bindFeishuUserToEmployee(openId, username) {
  if (!openId || !username) return { ok: false, error: 'missing_params' };
  try {
    const r = await query(
      `SELECT data FROM hrms_state WHERE key = $1 LIMIT 1`,
      ['default']
    );
    const data = r.rows?.[0]?.data;
    if (!data || typeof data !== 'object') return { ok: false, error: 'hrms_state_not_found' };
    const employees = Array.isArray(data.employees) ? data.employees : [];
    const emp = employees.find(
      e => String(e?.username || '').trim().toLowerCase() === String(username).trim().toLowerCase()
    );
    if (!emp) return { ok: false, error: 'employee_not_found' };
    if (!isHrmsEmployeeActive(emp)) return { ok: false, error: 'employee_inactive' };

    const name = String(emp.name || '').trim();
    const store = String(emp.store || '').trim();
    const role = String(emp.role || '').trim();

    await query(
      `INSERT INTO feishu_users (open_id, username, name, store, role, registered, updated_at)
       VALUES ($1, $2, $3, $4, $5, TRUE, NOW())
       ON CONFLICT (open_id) DO UPDATE SET
         username = EXCLUDED.username,
         name = EXCLUDED.name,
         store = EXCLUDED.store,
         role = EXCLUDED.role,
         registered = TRUE,
         updated_at = NOW()`,
      [openId, username, name, store, role]
    );
    return { ok: true, user: emp };
  } catch (e) {
    logger.warn({ err: e?.message, openId, username }, 'bindFeishuUserToEmployee failed');
    return { ok: false, error: e?.message };
  }
}

/** 马己仙出品观察账号：不参与任务类卡片操作与对话内任务整改关联 */
export async function feishuOpenIdIsMajixianPmObserver(openId) {
  const oid = String(openId || '').trim();
  if (!oid) return false;
  try {
    const r = await query(
      `SELECT LOWER(TRIM(username)) AS u FROM feishu_users WHERE open_id = $1 LIMIT 1`,
      [oid]
    );
    return isMajixianPmObserverUsername(r.rows?.[0]?.u);
  } catch (_e) {
    return false;
  }
}
