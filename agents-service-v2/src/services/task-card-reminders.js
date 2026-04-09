/**
 * 任务卡催办：随机抽检、定时巡检、BI 异常任务卡、数据审计、营销协作等
 *
 * 业务口径（与产品约定一致）：
 * 1）BI 异常触发的「绩效扣分」仅按 BI 异常配置执行：anomaly_triggers → periodic-scoring.js
 *    → agent_scores.score_model=anomaly_rollups_v2（类型/严重度/频次见 scoring-model.js）。
 * 2）下列任务来源在「满 3 次催办 + 再等 1 小时」仍无有效闭环时：只打标 master_tasks、
 *    计入当月工作态度统计（getIncompleteTaskCount 等），不向 agent_scores 写入任何催办扣分：
 *    bi_anomaly、scheduled_inspection、random_inspection、data_auditor、auto_collab。
 * 3）本文件不再写入 task_reminder_v1；除上述第 1 条 BI 引擎外，催办路径不产生其它扣分。
 * 4）收信人：优先 source_data.assignee_open_ids（与发卡时实际 ping 的 open_id 一致）；否则走
 *    utils/feishu-assignee-resolve（门店规范名/飞书简称/马已仙 等别名与 feishu_users 双向对齐）。
 */
import cron from 'node-cron';
import { query } from '../utils/db.js';
import { logger } from '../utils/logger.js';
import { runWithCronLog } from '../utils/cron-run-monitor.js';
import { resolveAssigneeOpenIdsForTask } from '../utils/feishu-assignee-resolve.js';
import { sendText, sendCard, sendGroup, sendGroupCard, sendCompanyNoticeToAssignees } from './feishu-client.js';

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

function parseTaskSourceData(sd) {
  if (sd == null) return {};
  if (typeof sd === 'object' && !Array.isArray(sd)) return sd;
  try {
    return JSON.parse(String(sd));
  } catch {
    return {};
  }
}

/** 飞书催办卡片文案：BI 任务卡多一行说明「扣分仅来自周度异常汇总」 */
function chaseKind(source) {
  return String(source || '') === 'bi_anomaly' ? 'bi' : 'attitude';
}

function resolutionCodeForChaseAttitude(source) {
  const s = String(source || '');
  if (s === 'scheduled_inspection' || s === 'random_inspection') return 'hr_attitude_inspection_chase';
  if (s === 'data_auditor') return 'hr_attitude_data_auditor_chase';
  if (s === 'auto_collab') return 'hr_attitude_auto_collab_chase';
  return 'hr_attitude_task_chase';
}

/**
 * 构建工作态度评级备案卡片
 */
function buildAttitudeFilingCard(task, sourceType) {
  const isBi = sourceType === 'bi';
  const sourceLabel = isBi ? 'BI异常任务卡' : '标准任务卡';

  let content = `**备案类型**：工作态度评级
**门店**：${task.store}
**任务ID**：${task.task_id}
**来源**：${sourceLabel}`;

  if (isBi) {
    content += `\n**说明**：您的 BI 异常任务在多次催办后仍未有效闭环，已记入工作态度未完成备案。BI 异常对应的绩效扣分仅按异常规则在周度汇总中计算；任务卡催办不另扣分。`;
  } else {
    content += `\n**说明**：您的任务在多次系统催办后仍未有效闭环，已记入工作态度未完成备案（影响月度工作态度评级；不因催办扣绩效分）。`;
  }

  content += `\n**标题**：${String(task.title || '').slice(0, 300)}`;

  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: '📋 工作态度评级备案' },
      template: 'orange'
    },
    elements: [
      { tag: 'div', text: { tag: 'lark_md', content } },
      { tag: 'note', elements: [{ tag: 'plain_text', content: '请妥善留存；如有异议请联系营运或 HR。' }] }
    ]
  };
}

/** 总部群通报：第三人称摘要，与私聊责任人卡片区分标题与口径 */
function buildHqGroupAttitudeFilingCard(task, sourceType) {
  const isBi = sourceType === 'bi';
  const sourceLabel = isBi ? 'BI异常任务卡' : '标准任务卡';
  const sourceCode = String(task.source || '—').trim() || '—';

  let content = `**通报类型**：工作态度评级备案
**门店**：${task.store}
**任务ID**：${task.task_id}
**任务来源**：${sourceLabel}（${sourceCode}）`;

  if (isBi) {
    content += `\n**情况说明**：该门店 BI 异常任务在多次催办后仍未有效闭环，系统已记入工作态度未完成备案。BI 绩效扣分仅按周度异常汇总规则执行；任务卡催办路径不另扣分。`;
  } else {
    content += `\n**情况说明**：该任务在多次系统催办后仍未有效闭环，已打标「工作态度未完成」备案（计入月度态度统计；不写入 agent_scores 扣分）。`;
  }

  content += `\n**标题**：${String(task.title || '').slice(0, 300)}`;

  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: '📢 【总部群】工作态度评级备案' },
      template: 'orange'
    },
    elements: [
      { tag: 'div', text: { tag: 'lark_md', content } },
      { tag: 'note', elements: [{ tag: 'plain_text', content: '营运与 HR 可据此跟进；门店与责任人已同步收到私聊卡片与公司通知。' }] }
    ]
  };
}

/**
 * 标准任务卡：催办未闭环 → 仅工作态度备案
 */
async function recordStandardChaseAttitudeOnly(task) {
  const rc = parseInt(task.remind_count || 0, 10);
  if (rc < 3) {
    logger.warn({ taskId: task.task_id, remind_count: rc }, 'task-reminder: remind_count < 3, skip filing');
    return false;
  }

  try {
    await query(
      `UPDATE master_tasks SET
         hr_performance_recorded = TRUE,
         status = 'hr_filed',
         resolution_code = $2,
         updated_at = NOW()
       WHERE task_id = $1`,
      [task.task_id, 'hr_attitude_standard_chase']
    );
    logger.info({ taskId: task.task_id, source: task.source }, 'task-reminder: standard chase → attitude filed (DB updated)');
  } catch (e) {
    logger.error({ taskId: task.task_id, source: task.source, err: e?.message }, 'task-reminder: DB update FAILED, status not set to hr_filed');
    return false;
  }

  // HRMS 公司通知（与飞书卡片合一：避免同一事件连发多条重复卡片/文本）
  const card = buildAttitudeFilingCard(task, 'standard');
  const noticeText = `您的任务在多次系统催办后仍未有效闭环，已记入工作态度未完成备案（影响月度工作态度评级；不因催办扣绩效分）。\n门店：${task.store}\n任务ID：${task.task_id}\n来源：${task.source}\n标题：${String(task.title || '').slice(0, 300)}`;
  await sendCompanyNoticeToAssignees(task, noticeText, { title: '工作态度评级备案', type: 'attitude_filing', card }).catch((e) =>
    logger.warn({ err: e?.message, taskId: task.task_id }, 'task-reminder: company notice (attitude) failed')
  );

  // 发送到总部群
  const hq = await query(`SELECT config_value FROM agent_v2_configs WHERE config_key = 'push_config' LIMIT 1`).catch(() => ({
    rows: []
  }));
  const chatId = hq.rows?.[0]?.config_value?.hq_group_chat_id;
  if (chatId) {
    const hqCard = buildHqGroupAttitudeFilingCard(task, 'standard');
    const gRes = await sendGroupCard(chatId, hqCard).catch(() => ({ ok: false }));
    if (!gRes?.ok) {
      await sendGroup(
        chatId,
        `【工作态度评级备案】门店 ${task.store} 任务 ${task.task_id}（${task.source}）三次催办后仍未有效闭环，已打标「工作态度未完成」备案（计入月度态度统计；不写入 agent_scores 扣分）。`
      ).catch(() => {});
    }
  }

  logger.info({ taskId: task.task_id, source: task.source }, 'task-reminder: chase → attitude only');
  return true;
}

/**
 * BI 异常任务卡：催办未闭环 → 仅工作态度备案；绩效扣分仅来自 BI 异常触发链路（anomaly_rollups_v2）
 */
async function recordBiChaseAttitudeOnly(task) {
  const rc = parseInt(task.remind_count || 0, 10);
  if (rc < 3) {
    logger.warn({ taskId: task.task_id, remind_count: rc }, 'task-reminder: BI remind_count < 3, skip filing');
    return false;
  }

  try {
    await query(
      `UPDATE master_tasks SET
         hr_performance_recorded = TRUE,
         status = 'hr_filed',
         resolution_code = $2,
         updated_at = NOW()
       WHERE task_id = $1`,
      [task.task_id, 'hr_attitude_bi_chase']
    );
    logger.info({ taskId: task.task_id, source: task.source }, 'task-reminder: BI chase → attitude filed (DB updated)');
  } catch (e) {
    logger.error({ taskId: task.task_id, source: task.source, err: e?.message }, 'task-reminder: BI DB update FAILED, status not set to hr_filed');
    return false;
  }

  const card = buildAttitudeFilingCard(task, 'bi');
  const noticeText = `您的 BI 异常任务在多次催办后仍未有效闭环，已记入工作态度未完成备案（影响月度工作态度评级）。\n若产生 BI 绩效扣分，仅按系统对各类 BI 异常的设定在周度「异常汇总」中体现；不因本条任务催办再扣固定分。\n门店：${task.store}\n任务ID：${task.task_id}\n标题：${String(task.title || '').slice(0, 300)}`;
  await sendCompanyNoticeToAssignees(task, noticeText, { title: '工作态度评级备案', type: 'attitude_filing', card }).catch((e) =>
    logger.warn({ err: e?.message, taskId: task.task_id }, 'task-reminder: company notice (BI attitude) failed')
  );

  // 发送到总部群
  const hq = await query(`SELECT config_value FROM agent_v2_configs WHERE config_key = 'push_config' LIMIT 1`).catch(() => ({
    rows: []
  }));
  const chatId = hq.rows?.[0]?.config_value?.hq_group_chat_id;
  if (chatId) {
    const hqCard = buildHqGroupAttitudeFilingCard(task, 'bi');
    const gRes = await sendGroupCard(chatId, hqCard).catch(() => ({ ok: false }));
    if (!gRes?.ok) {
      await sendGroup(
        chatId,
        `【工作态度评级备案】门店 ${task.store} 任务 ${task.task_id}（bi_anomaly）三次催办后仍未有效闭环：已打标「工作态度未完成」备案。` +
          `BI 异常对应的绩效扣分仅按异常规则在周度汇总（anomaly_rollups_v2）计算；任务卡催办不另扣分。`
      ).catch(() => {});
    }
  }

  logger.info({ taskId: task.task_id, source: task.source }, 'task-reminder: bi chase → attitude only');
  return true;
}

async function recordHrPerformancePenalty(task) {
  const src = String(task.source || '');
  if (src === 'bi_anomaly') {
    return recordBiChaseAttitudeOnly(task);
  }
  return recordStandardChaseAttitudeOnly(task);
}

export async function processTaskCardReminders() {
  await ensureReminderColumns();

  const r2 = await query(
    `SELECT task_id, store, source, status, title, detail, assignee_username, assignee_role,
            source_data,
            dispatched_at, created_at, remind_count, last_reminder_at, response_text,
            COALESCE(hr_performance_recorded, false) AS hr_done
     FROM master_tasks
       WHERE status = 'pending_response'
       AND source IN ('random_inspection','scheduled_inspection','bi_anomaly','auto_collab','data_auditor')
       AND (COALESCE(hr_performance_recorded, false) = false)
       AND dispatched_at >= CURRENT_DATE - INTERVAL '30 days'`
  );
  const tasks = r2.rows || [];
  const now = Date.now();

  for (const t of tasks) {
    const dispatchTime = new Date(t.dispatched_at || t.created_at).getTime();
    if (!dispatchTime) continue;

    const rc = parseInt(t.remind_count || 0, 10);
    const lastReminderTime = t.last_reminder_at ? new Date(t.last_reminder_at).getTime() : null;

    // 如果已经催办了3次,检查是否需要记录绩效
    if (rc >= 3) {
      // 必须有最后一次催办时间才检查绩效
      if (!lastReminderTime) {
        logger.warn({ taskId: t.task_id, remind_count: rc }, 'remind_count >= 3 但 last_reminder_at 为空,跳过绩效记录');
        continue;
      }
      
      // 检查距离最后一次催办是否已过1小时
      if (now >= lastReminderTime + HOUR_MS) {
        logger.info({ taskId: t.task_id, lastReminderTime, now }, '满3次催办且已过1小时,记录绩效');
        await recordHrPerformancePenalty(t);
      } else {
        logger.debug({ taskId: t.task_id, lastReminderTime, now }, '满3次催办但未过1小时,跳过');
      }
      continue;
    }

    // 计算下次催办时间
    // 第1次催办: dispatchTime + 1小时
    // 第2次催办: lastReminderTime + 1小时 (如果已有催办)
    // 第3次催办: lastReminderTime + 1小时
    let nextChaseAt;
    if (rc === 0) {
      // 第1次催办: 任务创建后1小时
      nextChaseAt = dispatchTime + HOUR_MS;
    } else if (lastReminderTime) {
      // 第2-3次催办: 上次催办后1小时
      nextChaseAt = lastReminderTime + HOUR_MS;
    } else {
      // 异常情况: 有remind_count但没有last_reminder_at,跳过
      logger.warn({ taskId: t.task_id, remind_count: rc }, '有remind_count但无last_reminder_at,跳过');
      continue;
    }
    
    if (now < nextChaseAt) continue;

    const seq = rc + 1;
    const sd = parseTaskSourceData(t.source_data);
    const frozen = Array.isArray(sd.assignee_open_ids)
      ? sd.assignee_open_ids.map((x) => String(x || '').trim()).filter(Boolean)
      : [];
    const oids = frozen.length ? frozen : await resolveAssigneeOpenIdsForTask(t);
    if (!oids.length) {
      logger.warn(
        { taskId: t.task_id, store: t.store, assignee: t.assignee_username, role: t.assignee_role, hadFrozen: frozen.length > 0 },
        'task-card-reminder: no feishu open_id, skip send (仍不递增 remind_count 以免假催办)'
      );
      continue;
    }

    const nowStr = new Date().toLocaleString('zh-CN', {
      timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
    });
    const deadlineStr = new Date(Date.now() + HOUR_MS).toLocaleString('zh-CN', {
      timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
    });

    const urgencyColor = seq === 3 ? 'red' : seq === 2 ? 'orange' : 'yellow';
    const k = chaseKind(t.source);
    const chaseBody =
      k === 'bi'
        ? seq === 3
          ? '🚨 **这是最后一次催办**，截止后仍无有效闭环将备案「工作态度未完成」（不计分）。BI 若有绩效扣分仅按异常规则在周度汇总体现，不因催办另扣。请立即回复本对话！'
          : '📸 请在截止时间前**回复本对话**并附上处理方案/照片；超时备案工作态度。BI 扣分仅见周度异常汇总。'
        : seq === 3
          ? '🚨 **这是最后一次催办**，截止后仍无有效闭环将备案「工作态度未完成」，仅影响月度工作态度评级，不因催办扣绩效分。请立即回复本对话！'
          : '📸 请在截止时间前**回复本对话**并附上处理方案/照片，超时将备案工作态度（不计绩效分）。';

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
                    : t.source === 'auto_collab'
                      ? '营销协作'
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
            content: chaseBody
          }
        },
        {
          tag: 'note',
          elements: [{ tag: 'plain_text', content: `小年 · 催办通知 · ${nowStr}` }]
        }
      ]
    };
    const tail =
      k === 'bi' ? '超时备案工作态度；BI 扣分仅周度异常汇总。' : '超时备案工作态度（不因催办扣绩效分）。';
    const fallbackText = `【任务催办 ${seq}/3】${t.title || '待办任务'}\n任务ID：${t.task_id}\n门店：${t.store}\n请在 ${deadlineStr} 前处理并回复，${tail}`;

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
        await runWithCronLog('task_card_reminders', () => processTaskCardReminders(), { recordSuccess: false });
      } catch (e) {
        logger.error({ err: e?.message }, 'task-card reminder cron failed');
      }
    },
    { timezone: 'Asia/Shanghai' }
  );
  logger.info('Task card reminder scheduler started (每10分钟, Asia/Shanghai)');
}
