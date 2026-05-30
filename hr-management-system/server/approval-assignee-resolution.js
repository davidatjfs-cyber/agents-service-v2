function normalizeText(input) {
  return String(input || '').trim();
}

function getApprovalFlowStepsFromState(state, type, applicantStore) {
  const st = state && typeof state === 'object' ? state : {};
  const flows = st.approvalFlows && typeof st.approvalFlows === 'object' ? st.approvalFlows : {};
  const cfg = flows[String(type || '').trim().toLowerCase()];
  if (!cfg || typeof cfg !== 'object') return [];
  const cfgStores = Array.isArray(cfg.stores) ? cfg.stores.map((x) => normalizeText(x)).filter(Boolean) : [];
  if (cfgStores.length > 0 && applicantStore) {
    const aStore = normalizeText(applicantStore).toLowerCase();
    const match = cfgStores.some((s) => s.toLowerCase() === aStore);
    if (!match) return [];
  }
  const steps = cfg.steps;
  return Array.isArray(steps) ? steps.map((x) => normalizeText(x)).filter(Boolean) : [];
}

function findUserByRole(state, roleId) {
  const rid = normalizeText(roleId);
  if (!rid) return '';
  const users = Array.isArray(state?.users) ? state.users : [];
  const employees = Array.isArray(state?.employees) ? state.employees : [];
  const all = employees.concat(users);
  const match = all.find((x) => {
    const role = normalizeText(x?.role);
    const status = normalizeText(x?.status);
    return role.toLowerCase() === rid.toLowerCase()
      && normalizeText(x?.username)
      && status !== '离职'
      && status !== 'inactive';
  });
  return match ? normalizeText(match.username) : '';
}

function pickStoreRoleUsernameByStore(state, storeName, roleList) {
  const store = normalizeText(storeName);
  const roles = Array.isArray(roleList) ? roleList.map((r) => normalizeText(r)).filter(Boolean) : [];
  if (!store || !roles.length) return '';
  const users = Array.isArray(state?.users) ? state.users : [];
  const employees = Array.isArray(state?.employees) ? state.employees : [];
  const all = employees.concat(users);
  const found = all.find((x) => {
    const st = normalizeText(x?.store);
    const role = normalizeText(x?.role);
    const status = normalizeText(x?.status);
    return st === store && roles.includes(role) && status !== '离职' && status !== 'inactive';
  });
  return found ? normalizeText(found.username) : '';
}

export async function resolveStoreApprovalRoleUsername(state, storeName, roleList, resolveDutyApproverForStore) {
  const store = normalizeText(storeName);
  const roles = Array.isArray(roleList) ? roleList.map((r) => normalizeText(r)).filter(Boolean) : [];
  if (!store || !roles.length) return '';

  if (roles.includes('store_manager') && typeof resolveDutyApproverForStore === 'function') {
    const dutyApprover = normalizeText(await resolveDutyApproverForStore(store));
    if (dutyApprover) return dutyApprover;
  }

  return pickStoreRoleUsernameByStore(state, store, roles);
}

async function resolveApprovalFlowToken(token, ctx, resolveDutyApproverForStore) {
  const raw = normalizeText(token);
  if (!raw) return '';
  const lower = raw.toLowerCase();
  const applicantStore = normalizeText(ctx?.applicantStore);

  if (lower === 'manager') return normalizeText(ctx?.managerUsername);
  if (lower === 'hq_manager') return normalizeText(ctx?.hqManagerUsername);
  if (lower === 'hr_manager') return normalizeText(ctx?.hrManagerUsername);
  if (lower === 'admin') return normalizeText(ctx?.adminUsername);
  if (lower === 'cashier') return normalizeText(ctx?.cashierUsername);

  if (lower === 'store_manager' && applicantStore) {
    return resolveStoreApprovalRoleUsername(ctx?.state, applicantStore, ['store_manager'], resolveDutyApproverForStore);
  }
  if (lower === 'store_production_manager' && applicantStore) {
    return resolveStoreApprovalRoleUsername(ctx?.state, applicantStore, ['store_production_manager'], resolveDutyApproverForStore);
  }

  if (lower.startsWith('username:')) {
    return normalizeText(raw.slice('username:'.length));
  }

  if (lower.startsWith('role:')) {
    const roleId = normalizeText(raw.slice('role:'.length));
    if (roleId && applicantStore && (roleId === 'store_manager' || roleId === 'store_production_manager')) {
      return resolveStoreApprovalRoleUsername(ctx?.state, applicantStore, [roleId], resolveDutyApproverForStore);
    }
    return roleId && ctx?.state ? findUserByRole(ctx.state, roleId) : '';
  }

  if (ctx?.state) {
    return findUserByRole(ctx.state, raw);
  }

  return '';
}

export async function buildConfiguredApprovalAssignees(state, type, ctx, resolveDutyApproverForStore) {
  const applicantStore = normalizeText(ctx?.applicantStore);
  const steps = getApprovalFlowStepsFromState(state, type, applicantStore);
  if (!steps.length) return [];

  const assignees = [];
  for (const step of steps) {
    const assignee = normalizeText(await resolveApprovalFlowToken(step, ctx, resolveDutyApproverForStore));
    if (assignee) assignees.push(assignee);
  }

  const seen = new Set();
  const uniq = [];
  for (const assignee of assignees) {
    const key = assignee.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    uniq.push(assignee);
  }
  return uniq;
}
