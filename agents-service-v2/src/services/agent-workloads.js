import { query } from '../utils/db.js';
import { logger } from '../utils/logger.js';
import { getConfig } from './config-service.js';

const ACTIVE_STATUSES = ['pending_audit', 'auditing', 'pending_dispatch', 'dispatched', 'viewed', 'in_progress', 'waiting_evidence', 'pending_response', 'pending_review', 'escalated'];

const DEFAULT_CAPABILITIES = [
  { agent: 'ops_supervisor', categories: ['hygiene', 'service', 'daily_ops', 'general', 'action_plan', 'scheduled_inspection', 'random_inspection'], maxConcurrent: 30 },
  { agent: 'food_quality', categories: ['food_quality'], maxConcurrent: 15 },
  { agent: 'train_advisor', categories: ['training'], maxConcurrent: 10 },
  { agent: 'marketing_planner', categories: ['marketing'], maxConcurrent: 10 },
  { agent: 'marketing_executor', categories: ['marketing_action'], maxConcurrent: 10 },
  { agent: 'data_auditor', categories: ['data_audit'], maxConcurrent: 20 }
];

let cachedCapabilities = null;
let capabilitiesCacheTime = 0;
const CACHE_TTL = 5 * 60 * 1000;

export async function getCapabilities() {
  const now = Date.now();
  if (cachedCapabilities && now - capabilitiesCacheTime < CACHE_TTL) return cachedCapabilities;
  try {
    const cfg = await getConfig('agent_capabilities');
    if (cfg?.agents && Array.isArray(cfg.agents)) {
      cachedCapabilities = cfg.agents;
      capabilitiesCacheTime = now;
      return cachedCapabilities;
    }
  } catch { /* fall through to defaults */ }
  cachedCapabilities = DEFAULT_CAPABILITIES;
  capabilitiesCacheTime = now;
  return cachedCapabilities;
}

export async function getAgentWorkloads() {
  const r = await query(
    `SELECT assignee_agent, status, COUNT(*)::int AS count
     FROM master_tasks
     WHERE assignee_agent IS NOT NULL
       AND status = ANY($1::text[])
     GROUP BY assignee_agent, status
     ORDER BY assignee_agent, status`,
    [ACTIVE_STATUSES]
  );
  const byAgent = {};
  for (const row of (r.rows || [])) {
    if (!byAgent[row.assignee_agent]) byAgent[row.assignee_agent] = { total: 0, byStatus: {} };
    byAgent[row.assignee_agent].total += row.count;
    byAgent[row.assignee_agent].byStatus[row.status] = row.count;
  }
  return byAgent;
}

export async function getAgentLoad(agentName) {
  const workloads = await getAgentWorkloads();
  return workloads[agentName]?.total || 0;
}

export async function isAgentAtCapacity(agentName) {
  const capabilities = await getCapabilities();
  const workload = await getAgentWorkloads();
  const cap = capabilities.find((c) => c.agent === agentName);
  if (!cap) return false;
  const current = workload[agentName]?.total || 0;
  return current >= (cap.maxConcurrent || 999);
}

export async function pickLeastLoadedAgent(candidates) {
  if (!candidates?.length) return null;
  if (candidates.length === 1) return candidates[0];
  const workloads = await getAgentWorkloads();
  const capabilities = await getCapabilities();
  const eligible = candidates.filter((c) => {
    const cap = capabilities.find((x) => x.agent === c);
    if (!cap) return true;
    return (workloads[c]?.total || 0) < (cap.maxConcurrent || 999);
  });
  const pool = eligible.length > 0 ? eligible : candidates;
  let best = pool[0];
  let bestLoad = Infinity;
  for (const c of pool) {
    const load = workloads[c]?.total || 0;
    if (load < bestLoad) { bestLoad = load; best = c; }
  }
  return best;
}

export { DEFAULT_CAPABILITIES };