#!/usr/bin/env node
/**
 * 验证：异常任务卡/定时任务卡/随机抽查任务卡的用户回复是否落库
 * - master_tasks.response_text / responded_at 是否被写入
 * - 同步是否写入 agent_messages（content_type=task_response，agent_data.taskId 匹配）
 */
import 'dotenv/config';
import pg from 'pg';

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 5 });
const q = async (sql, params = []) => (await pool.query(sql, params)).rows;

const days = Number(process.argv[2] || '14');

async function main() {
  const sources = ['random_inspection', 'scheduled_inspection', 'bi_anomaly'];

  const cols = await q(
    `SELECT column_name
     FROM information_schema.columns
     WHERE table_name='master_tasks'
       AND column_name IN ('response_text','responded_at','status','source','source_data','assignee_username','assignee_role','updated_at')`,
    []
  );
  const colSet = new Set(cols.map((c) => c.column_name));

  const hasResponseText = colSet.has('response_text');
  const hasRespondedAt = colSet.has('responded_at');

  const dateExpr = `(NOW() - INTERVAL '${days} days')`;

  const taskStats = await q(
    `SELECT
       source,
       COUNT(*)::int AS total,
       SUM(CASE WHEN response_text IS NOT NULL AND LENGTH(TRIM(response_text))>0 THEN 1 ELSE 0 END)::int AS has_response_text,
       SUM(CASE WHEN responded_at IS NOT NULL THEN 1 ELSE 0 END)::int AS has_responded_at
     FROM master_tasks
     WHERE source = ANY($1::text[])
       AND updated_at >= ${dateExpr}
     GROUP BY source
     ORDER BY source`,
    [sources]
  ).catch((e) => ({ error: e?.message }));

  // 同步到 agent_messages 的校验
  const syncedStats = await q(
    `SELECT
       mt.source,
       SUM(CASE WHEN am.id IS NOT NULL THEN 1 ELSE 0 END)::int AS replied_tasks_synced
     FROM master_tasks mt
     LEFT JOIN agent_messages am
       ON am.content_type='task_response'
      AND am.direction='in'
      AND am.agent_data->>'taskId' = mt.task_id::text
     WHERE mt.source = ANY($1::text[])
       AND mt.updated_at >= ${dateExpr}
       AND mt.response_text IS NOT NULL
       AND LENGTH(TRIM(mt.response_text))>0
     GROUP BY mt.source
     ORDER BY mt.source`,
    [sources]
  ).catch((e) => ({ error: e?.message }));

  console.log(JSON.stringify({ days, hasResponseText, hasRespondedAt, taskStats, syncedStats }, null, 2));

  await pool.end();
}

main().catch(async (e) => {
  console.error(e);
  try { await pool.end(); } catch {}
  process.exit(1);
});

