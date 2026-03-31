import 'dotenv/config';
import { Pool } from 'pg';
import {
  setPool as setAgentPool,
  writeTaskToBitable,
  updateBitableRecord,
  pollTaskResponseBitable,
  setTaskResponseHook
} from '../agents.js';
import { setMasterPool, handleTaskResponse } from '../master-agent.js';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildPool() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required');
  const ssl = process.env.PGSSL === 'disable' ? false : { rejectUnauthorized: false };
  return new Pool({ connectionString: databaseUrl, ssl });
}

function nowTag() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

async function main() {
  const pool = buildPool();
  setAgentPool(pool);
  setMasterPool(pool);
  setTaskResponseHook(handleTaskResponse);

  const taskId = `E2E-${nowTag()}`;
  const assigneeUsername = 'e2e_script_user';
  const responseText = `E2E联调脚本自动回复 ${new Date().toISOString()}`;

  const result = {
    taskId,
    assigneeUsername,
    insertedTask: false,
    bitableRecordId: '',
    writeToBitableOk: false,
    responseWriteOk: false,
    pollTriggered: false,
    finalStatus: '',
    responsePersisted: false,
    pendingReviewEventCount: 0,
    ok: false
  };

  try {
    await pool.query(
      `INSERT INTO master_tasks (
         task_id, status, source, source_ref, current_agent, category, severity,
         store, brand, assignee_username, assignee_role, title, detail, source_data
       ) VALUES (
         $1, 'dispatched', 'e2e_script', 'manual_e2e', 'ops_supervisor', '原料异常', 'medium',
         '洪潮大宁久光店', '洪潮传统潮汕菜', $2, 'store_manager',
         'E2E异常任务联调', '用于验证: 派发→写入多维表→回写任务状态', '{}'::jsonb
       )`,
      [taskId, assigneeUsername]
    );
    result.insertedTask = true;

    const taskRow = (await pool.query(`SELECT * FROM master_tasks WHERE task_id = $1 LIMIT 1`, [taskId])).rows?.[0];
    if (!taskRow) throw new Error('task_insert_failed');

    const bitableRecord = await writeTaskToBitable(taskRow);
    const recordId = String(bitableRecord?.record_id || '').trim();
    result.bitableRecordId = recordId;
    result.writeToBitableOk = !!recordId;
    if (!recordId) throw new Error('write_task_to_bitable_failed');

    await pool.query(
      `UPDATE master_tasks
       SET status = 'pending_response', dispatched_at = COALESCE(dispatched_at, NOW()), updated_at = NOW()
       WHERE task_id = $1`,
      [taskId]
    );

    const upd = await updateBitableRecord('task_responses', recordId, {
      '回复说明': responseText,
      '处理状态': '待回复'
    });
    result.responseWriteOk = !!upd;
    if (!upd) throw new Error('bitable_response_write_failed');

    await sleep(1200);
    await pollTaskResponseBitable();
    result.pollTriggered = true;

    await sleep(800);
    const after = (await pool.query(
      `SELECT task_id, status, response_text, responded_at
       FROM master_tasks WHERE task_id = $1 LIMIT 1`,
      [taskId]
    )).rows?.[0];

    result.finalStatus = String(after?.status || '');
    result.responsePersisted = String(after?.response_text || '').includes('E2E联调脚本自动回复');

    const ev = await pool.query(
      `SELECT COUNT(*)::int AS cnt
       FROM master_events
       WHERE task_id = $1 AND status_after = 'pending_review'`,
      [taskId]
    );
    result.pendingReviewEventCount = Number(ev.rows?.[0]?.cnt || 0);

    result.ok = result.writeToBitableOk && result.responseWriteOk && result.pollTriggered && result.finalStatus === 'pending_review' && result.responsePersisted;

    if (process.env.E2E_CLEANUP === '1') {
      await pool.query(`DELETE FROM master_events WHERE task_id = $1`, [taskId]);
      await pool.query(`DELETE FROM master_tasks WHERE task_id = $1`, [taskId]);
    }

    console.log(JSON.stringify(result, null, 2));

    if (!result.ok) {
      process.exitCode = 2;
    }
  } catch (err) {
    result.error = String(err?.message || err);
    console.error(JSON.stringify(result, null, 2));
    process.exitCode = 1;
  } finally {
    await pool.end().catch(() => {});
  }
}

main();
