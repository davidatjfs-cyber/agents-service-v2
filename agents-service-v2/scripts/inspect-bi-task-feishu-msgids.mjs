#!/usr/bin/env node
/**
 * 排查：为什么 bi_anomaly 的回复没有落库？
 * 核查 master_tasks.feishu_msg_ids 是否为空，以及最近的 bi_anomaly 任务是否有可匹配的消息ID。
 */
import 'dotenv/config';
import pg from 'pg';

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 5 });
const q = async (sql, params = []) => (await pool.query(sql, params)).rows;

const days = Number(process.argv[2] || '30');

const rows = await q(
  `SELECT
     task_id,
     category,
     store,
     assignee_role,
     status,
     updated_at,
     response_text IS NOT NULL AS has_response_text,
     COALESCE(jsonb_array_length(COALESCE(feishu_msg_ids,'[]'::jsonb)), 0) AS msg_ids_len,
     (COALESCE(feishu_msg_ids,'[]'::jsonb)) AS feishu_msg_ids
   FROM master_tasks
   WHERE source='bi_anomaly'
     AND updated_at >= NOW() - INTERVAL '${days} days'
   ORDER BY updated_at DESC
   LIMIT 20`
);

let empty = 0;
let nonEmpty = 0;
for (const r of rows) {
  if (r.msg_ids_len === 0) empty++;
  else nonEmpty++;
}

console.log(JSON.stringify({ days, sampleCount: rows.length, empty, nonEmpty, rows }, null, 2));

await pool.end();

