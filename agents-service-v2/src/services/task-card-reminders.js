/**
 * 任务卡催办：随机抽检、BI 异常、自动营销协作等待办任务
 * 规则：下发后第 1/2/3 次催办分别间隔 1 小时；满 3 次催办后再过 1 小时仍无有效回复 → 记入 HR 绩效（agent_scores）
 */
import cron from 'node-cron';
import { query } from '../utils/db.js';
import { logger } from '../utils/logger.js';
import { sendText, sendCard, sendGroup } from './feishu-client.js';
import { getBrandForStore } from './config-service.js';

const HOUR_MS = 60 * 60 * 1000;

async function ensureReminderColumns() {
  const alters = [
    `ALTER TABLE master_tasks ADD COLUMN IF NOT EXISTS last_reminder_at TIMESTAMPTZ`,
    `ALTER TABLE master_tasks ADD COLUMN IF NOT EXISTS hr_performance_recorded BOOLEAN DEFAULT FALSE`
  ];
  for (const sql of alters) {
    try {
      await query(sql);
    } catch (e) {
      logger.warn({ err: e?.message, sql }, 'task-reminder: alter skip');
    }
  }
}

function storeKeyForMatch(v) {
  return String(v || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '');
}

async function lookupOpenIdsForTask(task) {
  const un = String(task.assignee_username || '').trim();
  if (un) {
    const r = await query(
      `SELECT open_id FROM feishu_users WHERE lower(username) = lower($1) AND registered = true AND open_id IS NOT NULL LIMIT 3`,
      [un]
    );
    if (r.rows?.length) return r.rows.map((x) => x.open_id);
  }
  const role = String(task.assignee_role || 'store_manager').trim();
  const st = String(task.store || '').trim();
  const r2 = await query(
    `SELECT open_id FROM feishu_users WHERE store = $1 AND role = $2 AND registered = true AND open_id IS NOT NULL LIMIT 5`,
    [st, role]
  );
  if (r2.rows?.length) return r2.rows.map((x) => x.open_id);
  const sk = storeKeyForMatch(st);
  if (!sk) return [];
  const r3 = await query(
    `SELECT open_id FROM feishu_users
     WHERE registered = true AND open_id IS NOT NULL AND role = $2
       AND lower(regexp_replace(coalesce(store,''), '\\s+', '', 'g')) LIKE $1
     LIMIT 5`,
    [`%${sk}%`, role]
  );
  return (r3.rows || []).map((x) => x.open_id);
}

/**
 * pending_response + 满 3 次催办 + 再 1 小时仍无有效闭环 → 记绩效（与审核链路独立）
 */
function mondayYmdShanghai() {
  const ymd = new Date().toLocaleString('en-CA', { timeZone: 'Asia/Shanghai' }).slice(0, 10);
  const [y, m, d] = ymd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const wd = dt.getUTCDay();
  const diff = wd === 0 ? -6 : 1 - wd;
  dt.setUTCDate(dt.getUTCDate() + diff);
  return dt.toISOString().slice(0, 10);
}

async function recordHrPerformancePenalty(task) {
  const brand = (await getBrandForStore(task.store).catch(() => null)) || '未知';
  const mon = mondayYmdShanghai();
  const period = `week_${mon}`;

  const username = String(task.assignee_username || '').trim() || '__unknown_assignee__';
  const role = String(task.assignee_role || 'store_manager');
  const name = role === 'store_production_manager' ? '出品经理' : '店长';
  const pts = 15;
  const sumLine = `【HR备案】任务催办未达标：${task.title || task.task_id}（扣${pts}分）`;

  let scoreWriteOk = false;
  try {
    await query(
      `INSERT INTO agent_scores (
         brand, store, username, name, role, period, score_model,
         base_score, total_score, additions, deductions, breakdown, summary
       ) VALUES ($1,$2,$3,$4,$5,$6,'task_reminder_v1',100,GREATEST(0,100-$7),'[]','[]'::jsonb,'{}'::jsonb,$8)
       ON CONFLICT (brand, store, username, period)
       DO UPDATE SET
         total_score = GREATEST(0, agent_scores.total_score - $7),
         summary = LEFT(COALESCE(agent_scores.summary,'') || E'\\n' || EXCLUDED.summary, 2000),
         updated_at = NOW()`,
      [brand, task.store, username, name, role, period, pts, sumLine]
    );
    scoreWriteOk = true;
  } catch (e) {
    logger.error({ err: e?.message, taskId: task.task_id }, 'task-reminder: HR score insert failed — 仍将打标任务已记绩效，请核对 agent_scores 表与唯一约束');
  }

  try {
    await query(
      `UPDATE master_tasks SET
         hr_performance_recorded = TRUE,
         resolution_code = $2,
         updated_at = NOW()
       WHERE task_id = $1`,
      [task.task_id, scoreWriteOk ? 'hr_task_penalty' : 'hr_task_penalty_score_write_failed']
    );
  } catch (_e) {
    /* ignore */
  }

  const hq = await query(`SELECT config_value FROM agent_v2_configs WHERE config_key = 'push_config' LIMIT 1`).catch(() => ({
    rows: []
  }));
  const chatId = hq.rows?.[0]?.config_value?.hq_group_chat_id;
  if (chatId) {
    const msg = scoreWriteOk
      ? `【HR/总部备案】门店 ${task.store} 任务 ${task.task_id}（${task.source}）三次催办后仍未有效闭环，已写入周度绩效扣分（${pts}分）供 HR 复核。`
      : `【HR/总部备案·异常】门店 ${task.store} 任务 ${task.task_id} 已打标「记绩效」，但 agent_scores 写入失败，请技术核对库表/唯一约束；任务 resolution_code=hr_task_penalty_score_write_failed。`;
    await sendGroup(chatId, msg).catch(() => {});
  }

  return true;
}

export async function processTaskCardReminders() {
  await ensureReminderColumns();

  const r2 = await query(
    `SELECT task_id, store, source, status, title, detail, assignee_username, assignee_role,
            dispatched_at, created_at, remind_count, last_reminder_at, response_text,
            COALESCE(hr_performance_recorded, false) AS hr_done
     FROM master_tasks
       WHERE status = 'pending_response'
       AND source IN ('random_inspection','scheduled_inspection','bi_anomaly','auto_collab','data_auditor')
       AND (COALESCE(hr_performance_recorded, false) = false)`
  );
  const tasks = r2.rows || [];
  const now = Date.now();

  for (const t of tasks) {
    const base = new Date(t.dispatched_at || t.created_at).getTime();
    if (!base) continue;

    const rc = parseInt(t.remind_count || 0, 10);
    const last = t.last_reminder_at ? new Date(t.last_reminder_at).getTime() : null;

    // 注意：禁止因「已有 response_text」就跳过。
    // 审核驳回会把状态改回 pending_response 但保留上次回复正文；若此处 continue，
    // 将永远不再催办、也永远走不到「满 3 次 + 1 小时 → 记绩效」，与用户预期严重不符。

    // 满 3 次催办后，再等 1 小时进入 HR
    if (rc >= 3) {
      const lastChase = last || base + 3 * HOUR_MS;
      if (now >= lastChase + HOUR_MS) {
        await recordHrPerformancePenalty(t);
      }
      continue;
    }

    // 下一次催办时间点：第 n 次在 base + n * HOUR_MS
    const nextChaseAt = base + (rc + 1) * HOUR_MS;
    if (now < nextChaseAt) continue;

    const seq = rc + 1;
    const oids = await lookupOpenIdsForTask(t);

    // 催办时间信息
    const nowStr = new Date().toLocaleString('zh-CN', {
      timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
    });
    const deadlineStr = new Date(Date.now() + HOUR_MS).toLocaleString('zh-CN', {
      timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
    });

    // 催办飞书卡片（与任务卡格式一致）
    const urgencyColor = seq === 3 ? 'red' : seq === 2 ? 'orange' : 'yellow';
    const reminderCard = {
      config: { wide_screen_mode: true },
      header: {
        title: { tag: 'plain_text', content: `⚠️ 任务催办 ${seq}/3 · ${t.title || '待办任务'}` },
        template: urgencyColor
      },
      elements: [
        {
          tag: 'div',
          text: {
            tag: 'lark_md',
            content: `**门店**：${t.store}\n**任务ID**：${t.task_id}\n**来源**：${
              t.source === 'bi_anomaly'
                ? 'BI异常'
                : t.source === 'random_inspection'
                  ? '随机抽检'
                  : t.source === 'data_auditor'
                    ? '数据审计'
                    : '定时任务'
            }`
          }
        },
        { tag: 'hr' },
        {
          tag: 'div',
          text: {
            tag: 'lark_md',
            content: `**催办时间**：${nowStr}\n**最终截止**：${deadlineStr}\n**剩余次数**：${3 - seq} 次`
          }
        },
        { tag: 'hr' },
        {
          tag: 'div',
          text: {
            tag: 'lark_md',
            content: seq === 3
              ? '🚨 **这是最后一次催办**，如在截止时间前仍无有效回复，将自动提交 HR 记录至绩效。请立即回复本对话！'
              : '📸 请在截止时间前**回复本对话**并附上处理方案/照片，超时将记录至绩效。'
          }
        },
        {
          tag: 'note',
          elements: [{ tag: 'plain_text', content: `小年 · 催办通知 · ${nowStr}` }]
        }
      ]
    };
    const fallbackText = `【任务催办 ${seq}/3】${t.title || '待办任务'}\n任务ID：${t.task_id}\n门店：${t.store}\n请在 ${deadlineStr} 前处理并回复，超时将记录至绩效。`;

    // 收集催办卡片发出后的 message_id，追加到 feishu_msg_ids，使用户回复可被追踪
    const newMsgIds = [];
    for (const oid of oids) {
      const res = await sendCard(oid, reminderCard).catch(() => ({ ok: false }));
      if (res.ok) {
        const msgId = res.data?.data?.message_id;
        if (msgId) newMsgIds.push(msgId);
      } else {
        await sendText(oid, fallbackText, 'open_id').catch(() => {});
      }
    }

    // 原子更新：remind_count + last_reminder_at + 追加催办卡片消息ID到 feishu_msg_ids
    if (newMsgIds.length > 0) {
      await query(
        `UPDATE master_tasks SET
           remind_count = COALESCE(remind_count,0) + 1,
           last_reminder_at = NOW(),
           feishu_msg_ids = COALESCE(feishu_msg_ids, '[]'::jsonb) || $1::jsonb,
           updated_at = NOW()
         WHERE task_id = $2`,
        [JSON.stringify(newMsgIds), t.task_id]
      );
    } else {
      await query(
        `UPDATE master_tasks SET remind_count = COALESCE(remind_count,0) + 1, last_reminder_at = NOW(), updated_at = NOW() WHERE task_id = $1`,
        [t.task_id]
      );
    }
    logger.info({ taskId: t.task_id, seq, source: t.source, newMsgIds }, 'task-card reminder sent');
  }

  return { scanned: tasks.length };
}

export function startTaskCardReminderScheduler() {
  cron.schedule(
    '*/10 * * * *',
    async () => {
      try {
        await processTaskCardReminders();
      } catch (e) {
        logger.error({ err: e?.message }, 'task-card reminder cron failed');
      }
    },
    { timezone: 'Asia/Shanghai' }
  );
  logger.info('Task card reminder scheduler started (每10分钟, Asia/Shanghai)');
}
