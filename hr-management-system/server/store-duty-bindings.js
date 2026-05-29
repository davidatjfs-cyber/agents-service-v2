function normalizeStore(input) {
  return String(input || '').trim();
}

export async function ensureStoreDutyBindingsTable(pool) {
  await pool.query(`
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
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_store_duty_bindings_lookup
      ON store_duty_bindings (lower(username), lower(store), enabled)
  `);
}

export async function loadActiveDutyRowsForUser(pool, username) {
  const normalizedUsername = String(username || '').trim();
  if (!normalizedUsername) return [];
  const result = await pool.query(
    `SELECT username, store, access_level, is_primary_store, can_approve_hrms, can_view_employees
       FROM store_duty_bindings
      WHERE enabled = true
        AND lower(trim(username)) = lower(trim($1))
        AND (effective_from IS NULL OR effective_from <= now())
        AND (effective_to IS NULL OR effective_to >= now())
      ORDER BY is_primary_store DESC, updated_at DESC, id DESC`,
    [normalizedUsername]
  );
  return result.rows || [];
}

export function buildStoreAccessContext({ role, stateStore, dutyRows = [], requestedStore } = {}) {
  const normalizedRole = String(role || '').trim();
  const rows = Array.isArray(dutyRows) ? dutyRows : [];
  const cleanedRows = rows
    .map((row) => ({
      ...row,
      store: normalizeStore(row?.store),
      is_primary_store: Boolean(row?.is_primary_store),
      can_approve_hrms: Boolean(row?.can_approve_hrms),
      can_view_employees: Boolean(row?.can_view_employees),
    }))
    .filter((row) => row.store);

  const primaryRow = cleanedRows.find((row) => row.is_primary_store) || cleanedRows[0] || null;
  const primaryStore = normalizeStore(primaryRow?.store || stateStore);
  const allowedStores = Array.from(
    new Set([primaryStore, ...cleanedRows.map((row) => normalizeStore(row.store))].filter(Boolean))
  );
  const requested = normalizeStore(requestedStore);
  const currentStore = requested && allowedStores.includes(requested) ? requested : primaryStore;

  return {
    role: normalizedRole,
    primaryStore,
    currentStore,
    allowedStores,
    dutyRows: cleanedRows,
  };
}

export function canAccessApprovalCenter(role, context) {
  const normalizedRole = String(role || '').trim();
  if (['admin', 'hq_manager', 'cashier', 'hr_manager'].includes(normalizedRole)) return true;
  if (normalizedRole === 'store_manager') return true;
  if (normalizedRole === 'front_manager') return false;
  const row = Array.isArray(context?.dutyRows)
    ? context.dutyRows.find((item) => item.store === context.currentStore || item.store === context.primaryStore)
    : null;
  return Boolean(row?.can_approve_hrms);
}


export function canViewEmployeesForRole(role, context) {
  const normalizedRole = String(role || '').trim();
  if (['admin', 'hq_manager'].includes(normalizedRole)) return true;
  if (normalizedRole === 'store_manager') return true;
  if (normalizedRole === 'front_manager') return false;
  const row = Array.isArray(context?.dutyRows)
    ? context.dutyRows.find((item) => item.store === context.currentStore || item.store === context.primaryStore)
    : null;
  return Boolean(row?.can_view_employees);
}

export function pickEffectiveStore(context, requestedStore) {
  const requested = normalizeStore(requestedStore);
  if (requested && Array.isArray(context?.allowedStores) && context.allowedStores.includes(requested)) {
    return requested;
  }
  return normalizeStore(context?.primaryStore || context?.currentStore);
}
