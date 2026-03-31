#!/usr/bin/env node
import 'dotenv/config';
import pg from 'pg';

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
const q = async (sql, params = []) => (await pool.query(sql, params)).rows;

const users = await q(
  `SELECT username,name,store,role,registered
   FROM feishu_users
   WHERE name ILIKE '%测试%' AND registered=true
   ORDER BY updated_at DESC
   LIMIT 10`
);

console.log('feishu_users:', users);

for (const u of users) {
  const rows = await q(
    `SELECT score_model, period, total_score, summary,
            deductions, breakdown
     FROM agent_scores
     WHERE lower(username)=lower($1)
     ORDER BY created_at DESC
     LIMIT 5`,
    [u.username]
  );
  console.log('---', { user: { name: u.name, username: u.username }, latest: rows[0] && { score_model: rows[0].score_model, period: rows[0].period, total_score: rows[0].total_score, summary: String(rows[0].summary || '').slice(0, 300) } });
}

await pool.end();

