#!/usr/bin/env node
import 'dotenv/config';
import pg from 'pg';

const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 3
});

const APPLY = process.argv.includes('--apply');
const CLEANUP_TAG = 'cleanup_apr13_duplicate_filings_20260414';

async function getTargets(client = pool) {
  const duplicateMasterTasks = await client.query(
    `SELECT task_id, source, category, store, assignee_username, status,
            hr_performance_recorded, resolution_code, created_at, updated_at, title
       FROM master_tasks
      WHERE (
              source = 'data_auditor'
          AND store = '马己仙上海音乐广场店'
          AND assignee_username = 'NNYXYF26'
          AND category = '充值异常'
          AND title ILIKE '%2026-04-13%'
        )
         OR (
              source = 'data_auditor'
          AND store = '马己仙上海音乐广场店'
          AND assignee_username = 'NNYXLYR04'
          AND category = '桌访产品异常'
          AND title ILIKE '%2026-04-05~2026-04-11%'
        )
      ORDER BY created_at ASC`
  );

  const executionOps = await client.query(
    `SELECT id, task_type, store, assignee_username, assignee_role, status,
            biz_date, created_at, updated_at, title, dedupe_key, evidence_urls
       FROM ops_tasks
      WHERE task_type = 'execution_rating_daily'
        AND store = '马己仙上海音乐广场店'
        AND assignee_username = 'NNYXYF26'
        AND biz_date = '2026-04-13'::date
        AND title ILIKE '%未提交例会报告%'
      ORDER BY created_at ASC`
  );

  return {
    duplicateMasterTasks: duplicateMasterTasks.rows || [],
    executionOps: executionOps.rows || []
  };
}

async function getScoreSnapshot(client = pool) {
  const attitude = await client.query(
    `SELECT assignee_username,
            COUNT(DISTINCT task_id)::int AS cnt
       FROM master_tasks
      WHERE assignee_username IN ('NNYXYF26', 'NNYXLYR04')
        AND source = ANY($1::text[])
        AND COALESCE(hr_performance_recorded, false) = true
        AND (dispatched_at AT TIME ZONE 'Asia/Shanghai')::date >= '2026-04-01'::date
        AND (dispatched_at AT TIME ZONE 'Asia/Shanghai')::date <= '2026-04-30'::date
      GROUP BY assignee_username
      ORDER BY assignee_username`,
    [['random_inspection', 'scheduled_inspection', 'bi_anomaly', 'auto_collab', 'data_auditor']]
  );

  const execution = await client.query(
    `SELECT assignee_username, store, COUNT(*)::int AS cnt
       FROM ops_tasks
      WHERE task_type = 'execution_rating_daily'
        AND assignee_username IN ('NNYXYF26', 'NNYXLYR04')
        AND biz_date >= '2026-04-01'::date
        AND biz_date <= '2026-04-30'::date
      GROUP BY assignee_username, store
      ORDER BY assignee_username, store`
  );

  return {
    attitudeCounts: attitude.rows || [],
    executionCounts: execution.rows || []
  };
}

async function applyCleanup() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const targets = await getTargets(client);

    const retractedMaster = [];
    for (const row of targets.duplicateMasterTasks) {
      const updated = await client.query(
        `UPDATE master_tasks
            SET hr_performance_recorded = FALSE,
                status = 'cancelled',
                resolution_code = $2,
                updated_at = NOW(),
                source_data = COALESCE(source_data, '{}'::jsonb) || jsonb_build_object(
                  'cleanup_tag', $3::text,
                  'cleanup_reason', 'legacy_data_auditor_duplicate_of_bi_anomaly',
                  'cleanup_at', NOW()::text
                )
          WHERE task_id = $1
          RETURNING task_id, source, category, store, assignee_username, status,
                    hr_performance_recorded, resolution_code, updated_at, title`,
        [row.task_id, CLEANUP_TAG, CLEANUP_TAG]
      );
      if (updated.rows[0]) retractedMaster.push(updated.rows[0]);
    }

    const retractedOps = [];
    for (const row of targets.executionOps) {
      const updated = await client.query(
        `UPDATE ops_tasks
            SET task_type = 'execution_rating_daily_retracted',
                status = 'cancelled',
                title = CASE
                  WHEN title LIKE '[RETRACTED] %' THEN title
                  ELSE '[RETRACTED] ' || title
                END,
                updated_at = NOW(),
                evidence_urls = COALESCE(evidence_urls, '{}'::jsonb) || jsonb_build_object(
                  'cleanup_tag', $2::text,
                  'cleanup_reason', 'meeting_report_false_missing',
                  'cleanup_at', NOW()::text
                )
          WHERE id = $1
          RETURNING id, task_type, status, title, assignee_username, store, biz_date, updated_at`,
        [row.id, CLEANUP_TAG]
      );
      if (updated.rows[0]) retractedOps.push(updated.rows[0]);
    }

    await client.query('COMMIT');
    return { targets, retractedMaster, retractedOps };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

const beforeTargets = await getTargets();
const beforeSnapshot = await getScoreSnapshot();

let applyResult = null;
if (APPLY) {
  applyResult = await applyCleanup();
}

const afterTargets = await getTargets();
const afterSnapshot = await getScoreSnapshot();

console.log(JSON.stringify({
  mode: APPLY ? 'apply' : 'dry-run',
  cleanupTag: CLEANUP_TAG,
  before: {
    targets: beforeTargets,
    snapshot: beforeSnapshot
  },
  applied: applyResult,
  after: {
    targets: afterTargets,
    snapshot: afterSnapshot
  }
}, null, 2));

await pool.end();
