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
import { getShanghaiYmd } from './report-delivery.js';
import {
  getMonthlyAttitudeFilingCount,
  getMonthlyAttitudeFilingCountForStore
} from '../utils/performance-filing-counts.js';

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

/** 备案/催办卡片「来源」展示：勿把 data_auditor 误标为「标准任务卡」 */
function taskSourceLabelForAttitudeCard(source) {
  const s = String(source || '').trim();
  if (s === 'bi_anomaly') return 'BI异常任务卡';
  if (s === 'data_auditor') return '数据审计（自动派单）';
  if (s === 'scheduled_inspection') return '定时巡检';
  if (s === 'random_inspection') return '随机抽检';
  if (s === 'auto_collab') return '营销协作';
  if (s === 'scheduled_checklist') return '定时检查表';
  return s || '其它任务';
}

function resolutionCodeForChaseAttitude(source) {
  const s = String(source || '');
  if (s === 'scheduled_inspection' || s === 'random_inspection') return 'hr_attitude_inspection_chase';
  if (s === 'data_auditor') return 'hr_attitude_data_auditor_chase';
  if (s === 'auto_collab') return 'hr_attitude_auto_collab_chase';
  return 'hr_attitude_task_chase';
}

async function resolveAssigneeDisplayName(username) {
  const u = String(username || '').trim();
  if (!u) return { name: '', username: '' };
  try {
    const r = await query(
      `SELECT COALESCE(NULLIF(TRIM(name),''), username) AS disp
       FROM feishu_users
       WHERE lower(trim(username)) = lower(trim($1)) AND coalesce(registered, false) = true
       LIMIT 1`,
      [u]
    );
    const disp = String(r.rows?.[0]?.disp || '').trim();
    return { name: disp || u, username: u };
  } catch {
    return { name: u, username: u };
  }
}

/**
 * 构建工作态度备案卡片（含本月累计不合格次数）
 * @param {{ name: string, username: string }} [assigneeDisp] 展示用姓名（管理层抄送与责任人卡片共用）
 * @param {number} [monthlyStoreCount] 本店当月累计；与全门店 n 不一致时双行展示以免误解
 */
function buildAttitudeFilingCard(task, sourceType, monthlyCount, assigneeDisp, monthlyStoreCount) {
  const isBi = sourceType === 'bi';
  const sourceLabel = isBi ? 'BI异常任务卡' : taskSourceLabelForAttitudeCard(task.source);
  const ym = String(getShanghaiYmd()).slice(0, 7);
  const n = Number(monthlyCount) || 0;
  const ms = monthlyStoreCount != null ? Number(monthlyStoreCount) : null;
  const nm = assigneeDisp?.name || '';
  const un = assigneeDisp?.username || '';
  const whoLine =
    nm && un
      ? `**统计主体（唯一）**：${nm}（账号 **${un}**）`
      : un
        ? `**统计主体（唯一）**：账号 **${un}**`
        : '**统计主体**：任务未写入 assignee_username，累计次数按 0 计；请核对 master_tasks';

  let scopeLines = `**本人本月工作态度备案累计**：**${n}** 次（${ym}，自然月）\n`;
  if (ms != null && ms !== n) {
    scopeLines += `**本人本任务门店本月累计**：**${ms}** 次（${String(task.store || '').slice(0, 40)}）。\n`;
  }

  let content = `${whoLine}
${scopeLines}
**本次备案任务**
**门店**：${task.store}
**任务ID**：${task.task_id}
**来源**：${sourceLabel}`;

  if (isBi) {
    content += `\n**说明**：您的 BI 异常任务在多次催办后仍未有效闭环，已记入工作态度未完成备案。BI 异常对应的绩效扣分仅按异常规则在周度汇总中计算；任务卡催办不另扣分。`;
  } else {
    content += `\n**说明**：您的任务在多次系统催办后仍未有效闭环，已记入工作态度未完成备案（影响月度工作态度评级；不因催办扣绩效分）。`;
  }

  content += `\n**标题**：${String(task.title || '').slice(0, 300)}`;

  const headWho = nm || un || '责任人未填';
  return {
    config: { wide_screen_mode: true },
    header: {
      title: {
        tag: 'plain_text',
        content: `📋 工作态度备案｜${headWho} · ${ym} · 本人${n}次`
      },
      template: 'orange'
    },
    elements: [
      { tag: 'div', text: { tag: 'lark_md', content } },
      { tag: 'note', elements: [{ tag: 'plain_text', content: '请妥善留存；如有异议请联系营运或 HR。' }] }
    ]
  };
}

/** 总部群通报：第三人称摘要，与私聊责任人卡片区分标题与口径 */
function buildHqGroupAttitudeFilingCard(task, sourceType, monthlyCount, assigneeDisp, monthlyStoreCount) {
  const isBi = sourceType === 'bi';
  const sourceLabel = isBi ? 'BI异常任务卡' : taskSourceLabelForAttitudeCard(task.source);
  const sourceCode = String(task.source || '—').trim() || '—';
  const ym = String(getShanghaiYmd()).slice(0, 7);
  const n = Number(monthlyCount) || 0;
  const ms = monthlyStoreCount != null ? Number(monthlyStoreCount) : null;
  const nm = assigneeDisp?.name || '';
  const un = assigneeDisp?.username || '';
  const whoLine =
    nm && un
      ? `**统计主体（唯一）**：${nm}（账号 **${un}**）`
      : un
        ? `**统计主体（唯一）**：账号 **${un}**`
        : '**统计主体**：assignee_username 未填';

  let countLines = `**其本人本月工作态度备案累计**：**${n}** 次（${ym}，自然月；全门店去重）`;
  if (ms != null && ms !== n) {
    countLines += `\n**其本人在本任务门店本月累计**：**${ms}** 次（${String(task.store || '').slice(0, 40)}）`;
  }

  let content = `**通报类型**：工作态度备案（总部群抄送）
${whoLine}
${countLines}
**门店**：${task.store}
**任务ID**：${task.task_id}
**任务来源**：${sourceLabel}（${sourceCode}）`;

  if (isBi) {
    content += `\n**情况说明**：该门店 BI 异常任务在多次催办后仍未有效闭环，系统已记入工作态度未完成备案。BI 绩效扣分仅按周度异常汇总规则执行；任务卡催办路径不另扣分。`;
  } else {
    content += `\n**情况说明**：该任务在多次系统催办后仍未有效闭环，已打标「工作态度未完成」备案（计入月度态度统计；不写入 agent_scores 扣分）。`;
  }

  content += `\n**标题**：${String(task.title || '').slice(0, 300)}`;

  const headWho = nm || un || '—';
  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: `📢 【总部群】工作态度备案｜${headWho} · 本人${n}次` },
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

  const assignee = String(task.assignee_username || '').trim();
  const store = String(task.store || '').trim();
  const title = String(task.title || '').trim();
  if (assignee && store && /充值异常|桌访产品异常/.test(title)) {
    const dup = await query(
      `SELECT task_id
       FROM master_tasks
       WHERE assignee_username = $1
         AND COALESCE(hr_performance_recorded, false) = true
         AND task_id <> $2
         AND (
           (store = $3) OR (store ILIKE $4)
         )
         AND (
           title ILIKE $5 OR title ILIKE $6
         )
         AND created_at >= NOW() - INTERVAL '14 days'
       ORDER BY created_at DESC
       LIMIT 1`,
      [assignee, task.task_id, store, `%${store}%`, '%充值异常%', '%桌访产品异常%']
    ).catch(() => ({ rows: [] }));
    if (dup.rows?.length) {
      await query(
        `UPDATE master_tasks SET
           hr_performance_recorded = TRUE,
           status = 'hr_filed',
           resolution_code = $2,
           updated_at = NOW()
         WHERE task_id = $1`,
        [task.task_id, 'hr_attitude_standard_chase_deduped']
      ).catch(() => {});
      logger.info({ taskId: task.task_id, source: task.source, duplicateOf: dup.rows[0]?.task_id }, 'task-reminder: skip duplicate attitude filing for deprecated anomaly path');
      return true;
    }
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

  const dateYmd = getShanghaiYmd();
  const monthlyCount = assignee ? await getMonthlyAttitudeFilingCount(assignee, dateYmd) : 0;
  const monthlyStoreCount = assignee
    ? await getMonthlyAttitudeFilingCountForStore(assignee, String(task.store || '').trim(), dateYmd)
    : 0;
  const assigneeDisp = assignee ? await resolveAssigneeDisplayName(assignee) : { name: '', username: '' };
  const ym = dateYmd.slice(0, 7);

  // HRMS 公司通知（与飞书卡片合一：避免同一事件连发多条重复卡片/文本）
  const card = buildAttitudeFilingCard(task, 'standard', monthlyCount, assigneeDisp, monthlyStoreCount);
  const whoShort = assignee ? `${assigneeDisp.name || assignee}（${assignee}）` : '责任人未填';
  const noticeTitle = `工作态度备案｜${whoShort} · ${ym} · 本人累计${monthlyCount}次`;
  const noticeText = [
    `【工作态度备案】统计主体：${whoShort}；**仅统计该账号本人**本月（${ym}）工作态度备案累计 **${monthlyCount}** 次（全门店不同任务去重，与月度评级同一口径；不含他人、不含执行力）。`,
    monthlyStoreCount !== monthlyCount
      ? `其中本任务门店（${task.store}）本人累计：${monthlyStoreCount} 次。`
      : `（本任务门店与全门店累计一致：${monthlyCount} 次。）`,
    '您的任务在多次系统催办后仍未有效闭环，已记入工作态度未完成备案（影响月度工作态度评级；不因催办扣绩效分）。',
    `门店：${task.store}`,
    `任务ID：${task.task_id}`,
    `来源：${task.source}`,
    `标题：${String(task.title || '').slice(0, 300)}`
  ].join('\n');
  await sendCompanyNoticeToAssignees(task, noticeText, { title: noticeTitle, type: 'attitude_filing', card }).catch((e) =>
    logger.warn({ err: e?.message, taskId: task.task_id }, 'task-reminder: company notice (attitude) failed')
  );

  // 发送到总部群
  const hq = await query(`SELECT config_value FROM agent_v2_configs WHERE config_key = 'push_config' LIMIT 1`).catch(() => ({
    rows: []
  }));
  const chatId = hq.rows?.[0]?.config_value?.hq_group_chat_id;
  if (chatId) {
    const hqCard = buildHqGroupAttitudeFilingCard(task, 'standard', monthlyCount, assigneeDisp, monthlyStoreCount);
    const gRes = await sendGroupCard(chatId, hqCard).catch(() => ({ ok: false }));
    if (!gRes?.ok) {
      await sendGroup(
        chatId,
        `【工作态度备案】${assigneeDisp.name || assignee || '—'}（${assignee || '—'}）本人 ${ym} 累计 ${monthlyCount} 次（全门店去重${
          monthlyStoreCount !== monthlyCount ? `｜本店${monthlyStoreCount}次` : ''
        }）｜门店 ${task.store} 任务 ${task.task_id}（${task.source}）三次催办后仍未有效闭环，已打标「工作态度未完成」备案（计入月度态度统计；不写入 agent_scores 扣分）。`
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

  const assignee = String(task.assignee_username || '').trim();
  const store = String(task.store || '').trim();
  const title = String(task.title || '').trim();
  if (assignee && store && /充值异常|桌访产品异常/.test(title)) {
    const dup = await query(
      `SELECT task_id
       FROM master_tasks
       WHERE assignee_username = $1
         AND COALESCE(hr_performance_recorded, false) = true
         AND task_id <> $2
         AND (
           (store = $3) OR (store ILIKE $4)
         )
         AND (
           title ILIKE $5 OR title ILIKE $6
         )
         AND created_at >= NOW() - INTERVAL '14 days'
       ORDER BY created_at DESC
       LIMIT 1`,
      [assignee, task.task_id, store, `%${store}%`, '%充值异常%', '%桌访产品异常%']
    ).catch(() => ({ rows: [] }));
    if (dup.rows?.length) {
      await query(
        `UPDATE master_tasks SET
           hr_performance_recorded = TRUE,
           status = 'hr_filed',
           resolution_code = $2,
           updated_at = NOW()
         WHERE task_id = $1`,
        [task.task_id, 'hr_attitude_bi_chase_deduped']
      ).catch(() => {});
      logger.info({ taskId: task.task_id, source: task.source, duplicateOf: dup.rows[0]?.task_id }, 'task-reminder: skip duplicate BI attitude filing for same anomaly');
      return true;
    }
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

  const dateYmd = getShanghaiYmd();
  const assigneeBi = String(task.assignee_username || '').trim();
  const monthlyCount = assigneeBi ? await getMonthlyAttitudeFilingCount(assigneeBi, dateYmd) : 0;
  const monthlyStoreCount = assigneeBi
    ? await getMonthlyAttitudeFilingCountForStore(assigneeBi, String(task.store || '').trim(), dateYmd)
    : 0;
  const assigneeDisp = assigneeBi ? await resolveAssigneeDisplayName(assigneeBi) : { name: '', username: '' };
  const ym = dateYmd.slice(0, 7);

  const card = buildAttitudeFilingCard(task, 'bi', monthlyCount, assigneeDisp, monthlyStoreCount);
  const whoShortBi = assigneeBi ? `${assigneeDisp.name || assigneeBi}（${assigneeBi}）` : '责任人未填';
  const noticeTitle = `工作态度备案｜${whoShortBi} · ${ym} · 本人累计${monthlyCount}次`;
  const noticeText = [
    `【工作态度备案】统计主体：${whoShortBi}；**仅统计该账号本人**本月（${ym}）工作态度备案累计 **${monthlyCount}** 次（全门店不同任务去重；不含他人、不含执行力）。`,
    monthlyStoreCount !== monthlyCount
      ? `其中本任务门店（${task.store}）本人累计：${monthlyStoreCount} 次。`
      : `（本任务门店与全门店累计一致：${monthlyCount} 次。）`,
    '您的 BI 异常任务在多次催办后仍未有效闭环，已记入工作态度未完成备案（影响月度工作态度评级）。',
    '若产生 BI 绩效扣分，仅按系统对各类 BI 异常的设定在周度「异常汇总」中体现；不因本条任务催办再扣固定分。',
    `门店：${task.store}`,
    `任务ID：${task.task_id}`,
    `标题：${String(task.title || '').slice(0, 300)}`
  ].join('\n');
  await sendCompanyNoticeToAssignees(task, noticeText, { title: noticeTitle, type: 'attitude_filing', card }).catch((e) =>
    logger.warn({ err: e?.message, taskId: task.task_id }, 'task-reminder: company notice (BI attitude) failed')
  );

  // 发送到总部群
  const hq = await query(`SELECT config_value FROM agent_v2_configs WHERE config_key = 'push_config' LIMIT 1`).catch(() => ({
    rows: []
  }));
  const chatId = hq.rows?.[0]?.config_value?.hq_group_chat_id;
  if (chatId) {
    const hqCard = buildHqGroupAttitudeFilingCard(task, 'bi', monthlyCount, assigneeDisp, monthlyStoreCount);
    const gRes = await sendGroupCard(chatId, hqCard).catch(() => ({ ok: false }));
    if (!gRes?.ok) {
      await sendGroup(
        chatId,
        `【工作态度备案】${assigneeDisp.name || assigneeBi || '—'}（${assigneeBi || '—'}）本人 ${ym} 累计 ${monthlyCount} 次（全门店去重${
          monthlyStoreCount !== monthlyCount ? `｜本店${monthlyStoreCount}次` : ''
        }）｜门店 ${task.store} 任务 ${task.task_id}（bi_anomaly）三次催办后仍未有效闭环：已打标「工作态度未完成」备案。` +
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
