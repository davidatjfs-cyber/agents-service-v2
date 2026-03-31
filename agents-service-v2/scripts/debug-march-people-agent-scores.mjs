#!/usr/bin/env node
import 'dotenv/config';
import pg from 'pg';

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  console.error('缺少 DATABASE_URL');
  process.exit(1);
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
const q = async (sql, params = []) => (await pool.query(sql, params)).rows;

const targets = await q(
  `SELECT username, name, store, role, registered, updated_at
   FROM feishu_users
   WHERE registered=true
     AND (
       name LIKE '%徐曼金%'
       OR name LIKE '%王世波%'
       OR name LIKE '%黎永荣%'
       OR name ~ '喻[峰烽]'
     )
   ORDER BY updated_at DESC NULLS LAST`
);

console.log('targets:', targets);

const usernames = [...new Set(targets.map((t) => String(t.username).toLowerCase()))];
if (!usernames.length) {
  console.log('no targets');
  await pool.end();
  process.exit(0);
}

// 覆盖 2026-03 全部自然周起点（与 report 脚本一致：通过 week 起点算）
const weeks = ['2026-02-23', '2026-03-02', '2026-03-09', '2026-03-16', '2026-03-23', '2026-03-30'];

const scores = await q(
  `SELECT username, name, store, role, period, score_model, total_score,
          substring(period from 6 for 10) AS week_monday, created_at
   FROM agent_scores
   WHERE score_model='anomaly_rollups_v2'
     AND lower(username)=ANY($1::text[])
     AND substring(period from 6 for 10)::date=ANY($2::date[])
   ORDER BY substring(period from 6 for 10), store, role, username`,
  [usernames, weeks.map((w) => w)]
);

console.log('agent_scores anomaly_rollups_v2 rows count:', scores.length);
console.log(scores);

await pool.end();

