import { Pool } from 'pg';

const DATABASE_URL = process.env.DATABASE_URL || 'postgres://hrms:Abc1234567!@127.0.0.1:5432/hrms';
const TARGET_STORES = ['洪潮大宁久光店', '马己仙上海音乐广场店'];

function clean(v) {
  return String(v || '').trim();
}

function tally(rows, key) {
  const map = new Map();
  for (const r of rows) {
    const k = clean(r?.[key]) || '(空)';
    map.set(k, (map.get(k) || 0) + 1);
  }
  return Object.fromEntries([...map.entries()].sort((a, b) => b[1] - a[1]));
}

async function main() {
  const pool = new Pool({ connectionString: DATABASE_URL });
  try {
    const r = await pool.query("SELECT data FROM hrms_state WHERE key='default' LIMIT 1");
    const data = r.rows?.[0]?.data || {};
    const users = Array.isArray(data.users) ? data.users : [];
    const employees = Array.isArray(data.employees) ? data.employees : [];

    const inTarget = (x) => TARGET_STORES.includes(clean(x?.store));
    const usersT = users.filter(inTarget);
    const employeesT = employees.filter(inTarget);

    const byUser = new Map(users.map(u => [clean(u?.username), u]));
    const mismatches = [];
    for (const e of employeesT) {
      const u = byUser.get(clean(e?.username));
      if (!u) continue;
      const fields = ['store', 'position', 'level', 'managerUsername'];
      const diff = {};
      for (const f of fields) {
        const uv = clean(u?.[f]);
        const ev = clean(e?.[f]);
        if (uv !== ev) diff[f] = { user: uv, employee: ev };
      }
      if (Object.keys(diff).length) {
        mismatches.push({ username: clean(e?.username), name: clean(e?.name || u?.name), diff });
      }
    }

    console.log(JSON.stringify({
      usersTargetCount: usersT.length,
      employeesTargetCount: employeesT.length,
      usersPosition: tally(usersT, 'position'),
      usersLevel: tally(usersT, 'level'),
      employeesPosition: tally(employeesT, 'position'),
      employeesLevel: tally(employeesT, 'level'),
      userEmployeeMismatchCount: mismatches.length,
      mismatchSamples: mismatches.slice(0, 20)
    }, null, 2));
  } finally {
    await pool.end();
  }
}

main().catch((e) => {
  console.error('[audit-store-org-fields] failed:', e?.message || e);
  process.exit(1);
});
