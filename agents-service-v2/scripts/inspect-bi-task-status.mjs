#!/usr/bin/env node
import 'dotenv/config';
import pg from 'pg';

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
const q = async (sql, params = []) => (await pool.query(sql, params)).rows;

const rows = await q(
  `SELECT status, COUNT(*)::int AS cnt,
          SUM(CASE WHEN response_text IS NOT NULL AND LENGTH(TRIM(response_text))>0 THEN 1 ELSE 0 END)::int AS has_resp
   FROM master_tasks
   WHERE source='bi_anomaly'
   GROUP BY status
   ORDER BY cnt DESC`
);
console.log(JSON.stringify({ total: rows.reduce((a,r)=>a+r.cnt,0), rows }, null, 2));
await pool.end();

