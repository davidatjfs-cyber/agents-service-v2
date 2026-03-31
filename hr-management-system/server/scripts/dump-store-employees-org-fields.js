import { Pool } from 'pg';

const DATABASE_URL = process.env.DATABASE_URL || 'postgres://hrms:Abc1234567!@127.0.0.1:5432/hrms';
const STORES = ['洪潮大宁久光店', '马己仙上海音乐广场店'];

function clean(v) {
  return String(v || '').trim();
}

async function main() {
  const pool = new Pool({ connectionString: DATABASE_URL });
  try {
    const r = await pool.query("SELECT data FROM hrms_state WHERE key='default' LIMIT 1");
    const data = r.rows?.[0]?.data || {};
    const employees = Array.isArray(data.employees) ? data.employees : [];

    const rows = employees
      .filter(e => STORES.includes(clean(e?.store)))
      .map(e => ({
        username: clean(e?.username),
        name: clean(e?.name),
        store: clean(e?.store),
        role: clean(e?.role),
        position: clean(e?.position),
        level: clean(e?.level),
        managerUsername: clean(e?.managerUsername),
        department: clean(e?.department),
        rank: clean(e?.rank),
        jobLevel: clean(e?.jobLevel),
        title: clean(e?.title),
        post: clean(e?.post),
        jobTitle: clean(e?.jobTitle),
        status: clean(e?.status)
      }))
      .sort((a, b) => (a.store + a.username).localeCompare(b.store + b.username, 'zh-Hans-CN'));

    console.log(JSON.stringify({ count: rows.length, rows }, null, 2));
  } finally {
    await pool.end();
  }
}

main().catch((e) => {
  console.error('[dump-store-employees-org-fields] failed:', e?.message || e);
  process.exit(1);
});
