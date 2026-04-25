/**
 * HRMS 飞书 IM：DB 中 open_id 可能来自其他应用，IM 会报 open_id cross app。
 * 与 agents-service-v2 策略一致：用当前 tenant token 调 contact/v3/users/batch_get_id 换本应用 open_id 并回写 feishu_users。
 */
import axios from 'axios';

const FEISHU_OPEN_API = 'https://open.feishu.cn/open-apis';

export function isOpenIdCrossAppFeishuError(code, msg) {
  const c = Number(code);
  const m = String(msg || '').toLowerCase();
  return (
    c === 99992361 ||
    m.includes('open_id cross app') ||
    m.includes('cross app') ||
    m.includes('cross_app')
  );
}

/** batch_get_id 文档示例：大陆手机为 11 位 */
export function normalizeMobileForFeishuBatchGet(raw) {
  const s = String(raw || '').replace(/\s/g, '');
  if (!s) return null;
  if (/^1[3-9]\d{9}$/.test(s)) return s;
  if (/^\+861[3-9]\d{9}$/.test(s)) return s.slice(3);
  if (/^86-?1[3-9]\d{9}$/.test(s)) return s.replace(/^86-?/, '');
  if (/^\+[1-9]\d{6,14}$/.test(s)) return s;
  return null;
}

export function feishuSkipOpenIdResolveHrms() {
  const v = String(process.env.FEISHU_SKIP_OPEN_ID_RESOLVE || '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

/**
 * @param {{ query: (sql: string, params?: any[]) => Promise<{ rows?: any[] }>, warn?: Function, info?: Function }} deps
 * @param {string} tenantToken
 * @param {{ username?: string, open_id?: string, mobile?: string }} row
 */
export async function resolveOpenIdForCurrentFeishuAppHrms(deps, tenantToken, row) {
  const warn = deps.warn || ((...a) => console.warn('[feishu/resolve]', ...a));
  const info = deps.info || ((...a) => console.log('[feishu/resolve]', ...a));
  const query = deps.query;

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
      warn('feishu_users mobile lookup failed', e?.message, username);
    }
  }
  const emails = [];
  if (!mobile && username) {
    try {
      const r = await query(
        `SELECT NULLIF(trim(phone), '') AS p FROM users WHERE lower(trim(username)) = lower(trim($1)) LIMIT 1`,
        [username]
      );
      mobile = normalizeMobileForFeishuBatchGet(r.rows?.[0]?.p);
    } catch (e) {
      warn('users.phone lookup failed', e?.message, username);
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
        warn('users.email lookup failed', e?.message, username);
      }
    }
  }

  const body = {};
  if (mobile) body.mobiles = [mobile];
  if (emails.length) body.emails = emails;
  if (!body.mobiles && !body.emails) {
    warn('no mobile/email for batch_get_id', { username, hasOpenId: !!current });
    return current;
  }

  const t = String(tenantToken || '').trim();
  if (!t) return current;

  try {
    const r = await axios.post(
      `${FEISHU_OPEN_API}/contact/v3/users/batch_get_id`,
      body,
      {
        headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json; charset=utf-8' },
        params: { user_id_type: 'open_id' },
        timeout: 15000
      }
    );
    if (r.data?.code !== 0) {
      warn('batch_get_id failed', r.data?.code, r.data?.msg, username);
      return current;
    }
    const list = r.data?.data?.user_list;
    const item = Array.isArray(list) ? list[0] : null;
    const resolved = String(item?.user_id || '').trim();
    if (!resolved) {
      warn('batch_get_id empty user_id', username);
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
          warn('resolved open_id bound to another user; skip DB update', {
            username,
            resolved,
            other: conflict.rows[0].username
          });
          return resolved;
        }
        await query(
          `UPDATE feishu_users SET open_id = $1, updated_at = NOW()
           WHERE lower(trim(username)) = lower(trim($2))`,
          [resolved, username]
        );
        info('feishu_users.open_id updated', { username, from: current, to: resolved });
      } catch (e) {
        warn('feishu_users UPDATE failed', e?.message, username);
      }
    }
    return resolved;
  } catch (e) {
    warn('batch_get_id exception', e?.message, username);
    return current;
  }
}

/**
 * @param {{ query: Function, warn?: Function, info?: Function }} deps
 * @param {string} tenantToken
 * @param {string} staleOpenId
 * @returns {Promise<string|null>} 新的 open_id，无法解析时 null
 */
export async function refreshFeishuUserOpenIdForImDeliveryHrms(deps, tenantToken, staleOpenId) {
  const warn = deps.warn || ((...a) => console.warn('[feishu/refresh]', ...a));
  const stale = String(staleOpenId || '').trim();
  if (!stale) return null;
  let r;
  try {
    r = await deps.query(
      `SELECT username, open_id, mobile FROM feishu_users WHERE open_id = $1 LIMIT 1`,
      [stale]
    );
  } catch (e) {
    warn('lookup feishu_users by open_id failed', e?.message);
    return null;
  }
  const row = r.rows?.[0];
  if (!row?.username) {
    warn('no feishu_users row for open_id', stale.slice(0, 12) + '…');
    return null;
  }
  const resolved = await resolveOpenIdForCurrentFeishuAppHrms(deps, tenantToken, row);
  return resolved && resolved !== stale ? resolved : null;
}
