import { query } from '../utils/db.js';

let ensurePromise = null;

export function normalizeDutyStore(input) {
  return String(input || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '');
}

export function dutyCategoryToReceiveFlag(category) {
  const normalized = String(category || '').trim().toLowerCase();
  if (normalized === 'performance') return 'can_receive_performance';
  if (normalized === 'food_safety') return 'can_receive_food_safety';
  if (normalized === 'approval') return 'can_receive_approval';
  return 'can_receive_ops';
}

export async function ensureStoreDutyBindingsTable() {
  if (!ensurePromise) {
    ensurePromise = (async () => {
      await query(`
        CREATE TABLE IF NOT EXISTS store_duty_bindings (
          id BIGSERIAL PRIMARY KEY,
          username VARCHAR(120) NOT NULL,
          store VARCHAR(160) NOT NULL,
          access_level VARCHAR(40) NOT NULL DEFAULT 'support',
          is_primary_store BOOLEAN NOT NULL DEFAULT false,
          can_receive_ops BOOLEAN NOT NULL DEFAULT false,
          can_receive_performance BOOLEAN NOT NULL DEFAULT false,
          can_receive_food_safety BOOLEAN NOT NULL DEFAULT false,
          can_receive_approval BOOLEAN NOT NULL DEFAULT false,
          can_handle_ops BOOLEAN NOT NULL DEFAULT false,
          can_handle_food_safety BOOLEAN NOT NULL DEFAULT false,
          can_approve_hrms BOOLEAN NOT NULL DEFAULT false,
          can_view_employees BOOLEAN NOT NULL DEFAULT false,
          enabled BOOLEAN NOT NULL DEFAULT true,
          effective_from TIMESTAMPTZ NULL,
          effective_to TIMESTAMPTZ NULL,
          metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE (username, store)
        )
      `);
      await query(`
        CREATE INDEX IF NOT EXISTS idx_store_duty_bindings_lookup
          ON store_duty_bindings (lower(username), lower(store), enabled)
      `);
    })().catch((err) => {
      ensurePromise = null;
      throw err;
    });
  }
  return ensurePromise;
}

function dedupeRecipients(rows) {
  const seen = new Set();
  const out = [];
  for (const row of rows || []) {
    const key = String(row.open_id || '').trim() || `${String(row.username || '').trim().toLowerCase()}::${String(row.store || '').trim()}`;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

async function queryDutyRecipients(store, receiveFlag) {
  await ensureStoreDutyBindingsTable();
  const normalizedStore = normalizeDutyStore(store);
  if (!normalizedStore) return [];
  const sql = `
    SELECT
      b.username,
      b.store,
      b.access_level,
      b.is_primary_store,
      b.can_receive_ops,
      b.can_receive_performance,
      b.can_receive_food_safety,
      b.can_receive_approval,
      COALESCE(NULLIF(TRIM(fu.open_id), ''), '') AS open_id,
      COALESCE(NULLIF(TRIM(fu.role), ''), '') AS role,
      COALESCE(NULLIF(TRIM(fu.name), ''), fu.username, b.username) AS display_name
    FROM store_duty_bindings b
    LEFT JOIN feishu_users fu
      ON lower(trim(fu.username)) = lower(trim(b.username))
     AND coalesce(fu.registered, false) = true
    WHERE b.enabled = true
      AND lower(regexp_replace(trim(b.store), '\\s+', '', 'g')) = $1
      AND COALESCE(b.${receiveFlag}, false) = true
      AND (b.effective_from IS NULL OR b.effective_from <= now())
      AND (b.effective_to IS NULL OR b.effective_to >= now())
    ORDER BY b.is_primary_store DESC, b.access_level ASC, b.updated_at DESC, b.id DESC
  `;
  const result = await query(sql, [normalizedStore]);
  return dedupeRecipients(result.rows || []);
}

async function queryFallbackRecipients(store, fallbackRoles) {
  const roles = Array.isArray(fallbackRoles) ? fallbackRoles.filter(Boolean) : [];
  if (!store || !roles.length) return [];
  const sql = `
    SELECT DISTINCT ON (lower(trim(username)))
      COALESCE(NULLIF(TRIM(open_id), ''), '') AS open_id,
      username,
      COALESCE(NULLIF(TRIM(name), ''), username) AS display_name,
      role,
      store
    FROM feishu_users
    WHERE registered = true
      AND open_id IS NOT NULL
      AND trim(open_id) <> ''
      AND open_id NOT LIKE '%probe%'
      AND role = ANY($2::text[])
      AND lower(regexp_replace(trim(store), '\\s+', '', 'g')) = $1
    ORDER BY lower(trim(username)), updated_at DESC NULLS LAST
  `;
  const result = await query(sql, [normalizeDutyStore(store), roles]);
  return dedupeRecipients(result.rows || []);
}

export async function resolveDutyBoundRecipients({ store, category = 'ops', fallbackRoles = [] }) {
  const receiveFlag = dutyCategoryToReceiveFlag(category);
  const dutyRecipients = await queryDutyRecipients(store, receiveFlag);
  if (dutyRecipients.length) return dutyRecipients;
  return queryFallbackRecipients(store, fallbackRoles);
}
