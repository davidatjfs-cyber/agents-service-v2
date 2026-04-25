#!/usr/bin/env node
import 'dotenv/config';
import pg from 'pg';

const { Pool } = pg;

function parseArgs(argv) {
  const args = new Set(argv.slice(2));
  return {
    apply: args.has('--apply'),
    dryRun: args.has('--dry-run') || !args.has('--apply')
  };
}

async function main() {
  const { apply, dryRun } = parseArgs(process.argv);
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 3
  });

  try {
    const adminR = await pool.query(
      `SELECT DISTINCT ON (lower(trim(username)))
         username
       FROM feishu_users
       WHERE registered = true
         AND role = 'admin'
         AND username IS NOT NULL
         AND trim(username) <> ''
       ORDER BY lower(trim(username)), updated_at DESC NULLS LAST`
    );
    const targetAdmin = String(adminR.rows?.[0]?.username || '').trim();
    if (!targetAdmin) {
      throw new Error('no_registered_admin_in_feishu_users');
    }

    const candidateR = await pool.query(
      `SELECT task_id, assignee_username, assignee_role, status, source, store, created_at
       FROM master_tasks
       WHERE source = 'proactive_llm'
         AND task_id LIKE 'PLLM-%'
         AND status IN ('pending_response','pending_review','pending_dispatch','dispatched','escalated')
         AND COALESCE(trim(assignee_username), '') <> trim($1)
       ORDER BY created_at DESC`,
      [targetAdmin]
    );
    const candidates = candidateR.rows || [];

    const preview = {
      mode: dryRun ? 'dry-run' : 'apply',
      targetAdmin,
      candidateCount: candidates.length,
      sample: candidates.slice(0, 10).map((x) => ({
        task_id: x.task_id,
        from: x.assignee_username,
        role: x.assignee_role,
        status: x.status,
        store: x.store,
        created_at: x.created_at
      }))
    };
    console.log(JSON.stringify(preview, null, 2));

    if (!apply || candidates.length === 0) {
      return;
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const upd = await client.query(
        `UPDATE master_tasks
         SET assignee_username = $1,
             assignee_role = 'admin',
             updated_at = NOW(),
             source_data = COALESCE(source_data, '{}'::jsonb) || $2::jsonb
         WHERE source = 'proactive_llm'
           AND task_id LIKE 'PLLM-%'
           AND status IN ('pending_response','pending_review','pending_dispatch','dispatched','escalated')
           AND COALESCE(trim(assignee_username), '') <> trim($1)
         RETURNING task_id, assignee_username`,
        [
          targetAdmin,
          JSON.stringify({
            cleanup_script: 'cleanup-pllm-reassign-admin.mjs',
            cleanup_reason: 'manual_admin_fallback',
            cleanup_at: new Date().toISOString()
          })
        ]
      );

      const updatedRows = upd.rows || [];
      for (const row of updatedRows) {
        await client.query(
          `INSERT INTO master_events
             (task_id, event_type, from_agent, to_agent, status_before, status_after, payload)
           VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
          [
            row.task_id,
            'manual_reassign_admin_pllm',
            'ops_script',
            'admin',
            'unchanged',
            'unchanged',
            JSON.stringify({
              script: 'cleanup-pllm-reassign-admin.mjs',
              target_admin: targetAdmin,
              note: 'one_time_cleanup_pllm_open_tasks'
            })
          ]
        );
      }

      await client.query('COMMIT');

      console.log(
        JSON.stringify(
          {
            mode: 'apply',
            targetAdmin,
            updatedCount: updatedRows.length,
            eventLoggedCount: updatedRows.length
          },
          null,
          2
        )
      );
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
}

main().catch((e) => {
  console.error('[cleanup-pllm-reassign-admin] failed:', e?.message || e);
  process.exit(1);
});

