#!/usr/bin/env node
import 'dotenv/config';
import pg from 'pg';

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 5 });

const names = ['徐曼金', '王世波', '喻峰', '黎永荣', '喻烽'];
const period = process.argv[2] || '2026-03';

const users = await pool.query(
  `SELECT username, name, store, role
   FROM feishu_users
   WHERE registered = true AND name = ANY($1)
   ORDER BY store, name`,
  [names]
);

for (const u of users.rows || []) {
  const m = await pool.query(
    `SELECT score_model, period, total_score, summary, breakdown
     FROM agent_scores
     WHERE lower(username) = lower($1) AND period = $2
     ORDER BY updated_at DESC
     LIMIT 1`,
    [u.username, period]
  );
  console.log(JSON.stringify({
    name: u.name,
    username: u.username,
    store: u.store,
    role: u.role,
    monthly: m.rows?.[0] || null
  }));
}

await pool.end();

