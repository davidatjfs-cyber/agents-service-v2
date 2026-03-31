#!/usr/bin/env node
import 'dotenv/config';
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 3 });

const r = await pool.query(
  `SELECT id, sender_id, content, created_at
   FROM agent_messages
   WHERE content ILIKE '%模型：new_model_monthly%'
      OR content ILIKE '%store_rating:%'
      OR content ILIKE '%ability_rating:%'
      OR content ILIKE '%attitude_rating:%'
      OR content ILIKE '%execution_rating:%'
   ORDER BY created_at DESC
   LIMIT 30`
);

console.log('matched:', r.rows.length);
for (const x of r.rows) {
  console.log('---', x.id, x.created_at, x.sender_id);
  console.log(String(x.content || '').slice(0, 600));
}

await pool.end();

