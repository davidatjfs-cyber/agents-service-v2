import 'dotenv/config';
import pg from 'pg';

const { Pool } = pg;

function parseArg(flag) {
  const idx = process.argv.indexOf(flag);
  if (idx < 0) return '';
  return String(process.argv[idx + 1] || '').trim();
}

function hasFlag(flag) {
  return process.argv.includes(flag);
}

function normalizeText(input) {
  return String(input || '').trim();
}

if (!process.env.DATABASE_URL) {
  console.error('Missing DATABASE_URL');
  process.exit(1);
}

const store = parseArg('--store');
const targetUsername = parseArg('--target-user');
const apply = hasFlag('--apply');

if (!store || !targetUsername) {
  console.error('Usage: node scripts/reassign-pending-store-approvals.mjs --store "马己仙上海音乐广场店" --target-user NNYXYF26 [--apply]');
  process.exit(1);
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

try {
  const stateRow = await pool.query(`select data from hrms_state where key = 'default' limit 1`);
  const state = stateRow.rows?.[0]?.data && typeof stateRow.rows[0].data === 'object' ? stateRow.rows[0].data : {};
  const users = []
    .concat(Array.isArray(state?.employees) ? state.employees : [])
    .concat(Array.isArray(state?.users) ? state.users : []);
  const roleByUsername = new Map(
    users
      .map((row) => [normalizeText(row?.username).toLowerCase(), normalizeText(row?.role)])
      .filter(([username]) => username)
  );

  const result = await pool.query(
    `select id, type, applicant_username, current_assignee_username, chain, payload, created_at
       from approval_requests
      where status = 'pending'
        and lower(trim(coalesce(payload->>'store', payload->'employee'->>'store', ''))) = lower(trim($1))
      order by created_at asc`,
    [store]
  );

  const candidates = [];
  for (const row of result.rows || []) {
    const currentAssignee = normalizeText(row.current_assignee_username);
    const currentRole = roleByUsername.get(currentAssignee.toLowerCase()) || '';
    if (currentRole !== 'store_manager') continue;
    if (currentAssignee.toLowerCase() === targetUsername.toLowerCase()) continue;

    const chain = Array.isArray(row.chain) ? row.chain : [];
    const pendingIndex = chain.findIndex((step) => normalizeText(step?.status) === 'pending');
    if (pendingIndex < 0) continue;
    if (normalizeText(chain[pendingIndex]?.assignee).toLowerCase() !== currentAssignee.toLowerCase()) continue;

    const nextChain = chain.slice();
    nextChain[pendingIndex] = { ...nextChain[pendingIndex], assignee: targetUsername };
    candidates.push({
      id: row.id,
      type: normalizeText(row.type),
      createdAt: row.created_at,
      from: currentAssignee,
      to: targetUsername,
      chain: nextChain,
    });
  }

  if (!candidates.length) {
    console.log(JSON.stringify({ ok: true, apply, count: 0, items: [] }, null, 2));
    process.exit(0);
  }

  if (apply) {
    for (const item of candidates) {
      await pool.query(
        `update approval_requests
            set current_assignee_username = $2,
                chain = $3::jsonb,
                updated_at = now()
          where id = $1`,
        [item.id, item.to, JSON.stringify(item.chain)]
      );
    }
  }

  console.log(JSON.stringify({
    ok: true,
    apply,
    count: candidates.length,
    items: candidates.map((item) => ({
      id: item.id,
      type: item.type,
      createdAt: item.createdAt,
      from: item.from,
      to: item.to,
    })),
  }, null, 2));
} finally {
  await pool.end().catch(() => {});
}
