#!/usr/bin/env node
/**
 * 不走飞书真实回调：直接调用 handleWebhookEvent，并用 DB 里已有的 bi_anomaly 任务数据构造一条“引用/回复卡片”的事件
 * 验证 master_tasks.response_text / responded_at 是否会写入。
 *
 * 用法：
 *   node scripts/e2e-bi-anomaly-reply-capture.mjs
 */
import 'dotenv/config';
import pg from 'pg';

import { handleWebhookEvent } from '../src/services/feishu-client.js';

const { Pool } = pg;
if (!process.env.DATABASE_URL) throw new Error('Missing DATABASE_URL');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 5 });
const q = async (sql, params = []) => (await pool.query(sql, params)).rows;

async function main() {
  const task = (await q(
    `SELECT task_id, status, store, assignee_username, assignee_role,
            COALESCE(feishu_msg_ids,'[]'::jsonb) AS feishu_msg_ids,
            updated_at
     FROM master_tasks
     WHERE source='bi_anomaly'
       AND status IN ('pending_response','pending_review')
       AND (feishu_msg_ids IS NULL OR jsonb_array_length(feishu_msg_ids) > 0)
     ORDER BY updated_at DESC
     LIMIT 1`
  ))[0];

  if (!task) {
    console.log('no pending bi_anomaly task found');
    await pool.end();
    process.exit(0);
  }

  const msgIds = task.feishu_msg_ids || [];
  const msgId = String(msgIds[0] || '').trim();
  if (!msgId) {
    console.log('task has empty feishu_msg_ids');
    await pool.end();
    process.exit(0);
  }

  const fu = (await q(
    `SELECT open_id, username, store, role
     FROM feishu_users
     WHERE registered=true
       AND open_id IS NOT NULL
       AND lower(username)=lower($1)
       AND store=$2
     LIMIT 1`,
    [task.assignee_username, task.store]
  ))[0];

  if (!fu?.open_id) {
    console.log('no feishu user open_id match for assignee');
    await pool.end();
    process.exit(0);
  }

  const body = {
    header: {
      event_id: `e2e-bi-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
      event_type: 'im.message.receive_v1'
    },
    event: {
      sender: {
        sender_id: {
          open_id: fu.open_id
        }
      },
      message: {
        message_id: msgId,
        root_id: msgId,
        parent_id: msgId,
        chat_type: 'p2p',
        message_type: 'text',
        content: { text: 'E2E：记录' }
      }
    }
  };

  const before = (await q(
    `SELECT task_id, status, response_text, responded_at
     FROM master_tasks WHERE task_id=$1`,
    [task.task_id]
  ))[0];

  const out = await handleWebhookEvent(body).catch((e) => ({ error: e?.message || String(e) }));

  const after = (await q(
    `SELECT task_id, status, response_text, responded_at
     FROM master_tasks WHERE task_id=$1`,
    [task.task_id]
  ))[0];

  console.log(JSON.stringify({ task: { ...task, msgId, assigneeOpenId: fu.open_id }, out, before, after }, null, 2));
  await pool.end();
}

main().catch(async (e) => {
  console.error(e);
  await pool.end().catch(() => {});
  process.exit(1);
});

