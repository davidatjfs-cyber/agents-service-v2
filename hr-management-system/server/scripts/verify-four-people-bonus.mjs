#!/usr/bin/env node
import 'dotenv/config';
import pg from 'pg';

const period = process.argv[2] || '2026-03';
const names = ['徐曼金', '王世波', '喻峰', '喻烽', '黎永荣'];
const db = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 4 });

const users = await db.query(
  `SELECT username, name, store, role
   FROM feishu_users
   WHERE registered = true AND name = ANY($1)
   ORDER BY store, name`,
  [names]
);

const out = [];
for (const u of users.rows || []) {
  const r = await db.query(
    `SELECT base_score, exception_bonus, exception_deduction, total_score,
            execution_rating, attitude_rating, ability_rating
     FROM employee_scores
     WHERE lower(username) = lower($1) AND period = $2
     ORDER BY updated_at DESC
     LIMIT 1`,
    [u.username, period]
  );
  out.push({
    name: u.name,
    username: u.username,
    store: u.store,
    role: u.role,
    employee_score: r.rows?.[0] || null
  });
}

console.log(JSON.stringify({ period, count: out.length, items: out }, null, 2));
await db.end();

