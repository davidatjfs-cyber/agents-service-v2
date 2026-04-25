/**
 * daily-task-completion.js
 * 每日 08:00（上海时区）推送昨日任务达成率到飞书。
 * 按门店统计店长/出品经理的任务完成情况，含明细。
 * 洪潮店显示任务明细，马己仙店仅显示汇总。
 */
import { query } from '../utils/db.js';
import { logger } from '../utils/logger.js';
import { sendCard, refreshFeishuUserOpenIdForImDelivery } from './feishu-client.js';
import { getShanghaiYmd, sendReportToRecipient } from './report-delivery.js';
import {
  isMajixianStore,
  isMajixianPmObserverUsername,
  resolveMajixianProductionManagersForScoring,
  resolvePerformanceReportDisplayName
} from '../utils/scoring-assignee.js';
import { notifyAdminsDataIssue } from './admin-data-alert.js';

/** 任务类型 → 中文标签 */
function taskTypeLabel(type) {
  if (!type) return '其它';
  const map = {
    opening_lunch: '午市开档',
    opening_dinner: '晚市开档',
    prep_lunch: '午市备货',
    prep_dinner: '晚市备货',
    table_visit_tracking: '桌访记录',
    bad_review_followup: '差评跟踪',
    bad_review_product: '差评（产品）',
    bad_review_service: '差评（服务）',
    patrol_am: '上午巡检',
    patrol_pm: '下午巡检',
    tasting: '试味',
    table_visit_product: '桌访产品异常',
    table_visit_ratio: '桌访占比异常',
    table_visit_anomaly: '桌访异常',
    recharge_zero: '充值异常',
    recharge_anomaly: '充值异常',
    food_safety: '食品安全',
    gross_margin: '毛利率异常',
    revenue_anomaly: '营收异常',
    revenue_achievement: '营收达成异常',
    labor_efficiency: '人效异常',
    efficiency_anomaly: '人效异常',
    traffic_decline: '客流下滑',
    action_plan: '行动计划',
    manual_campaign: '营销活动',
    training: '培训',
    hongchao_jiuguang_private_room: '包间管理',
  };
  if (map[type]) return map[type];
  if (type.startsWith('custom_')) return '试味';
  const zhMatch = /[\u4e00-\u9fff]/.test(type);
  if (zhMatch) return type;
  const anomalyMap = {
    '人效值异常': '人效异常',
    '充值异常': '充值异常',
    '原料收货异常': '原料收货异常',
    '总实收毛利率异常': '毛利率异常',
    '桌访产品异常': '桌访产品异常',
    '桌访占比异常': '桌访占比异常',
    '桌访异常': '桌访异常',
    '桌访连续投诉': '桌访连续投诉',
    '食安抽检': '食安抽检',
    '试味测试': '试味',
    '营收提升': '营收提升',
    '营销活动': '营销活动',
  };
  if (anomalyMap[type]) return anomalyMap[type];
  return type;
}

/** 任务状态 → 中文 */
function taskStatusZh(status) {
  switch (status) {
    case 'completed': return '已完成';
    case 'closed': return '已闭环';
    case 'hr_filed': return '已备案';
    case 'overdue': return '已逾期';
    case 'open': return '待处理';
    case 'pending_response': return '待回复';
    case 'pending_review': return '待审核';
    case 'dispatched': return '已派发';
    case 'in_progress': return '进行中';
    case 'cancelled': return '已取消';
    default: {
      const m = {
        '已完成': '已完成',
        '已闭环': '已闭环',
        '已备案': '已备案',
        '已逾期': '已逾期',
        '待处理': '待处理',
        '进行中': '进行中',
        '已取消': '已取消',
      };
      return m[status] || status || '未知';
    }
  }
}

/** 角色 → 中文 */
function roleLabelZh(role) {
  switch (role) {
    case 'store_manager': return '店长';
    case 'store_production_manager': return '出品经理';
    case 'hq_manager': return '营运经理';
    case 'admin': return '管理员';
    default: return role || '';
  }
}

/** 判断是否已完成 */
function isCompleted(status) {
  return ['closed'].includes(status);
}

function canonicalTaskIdentity(task) {
  const type = String(task?.task_type || '').trim();
  const title = String(task?.title || '').trim();
  const source = String(task?.source || '').trim();
  if (type === 'table_visit_product' || /桌访产品异常/.test(title)) {
    return 'table_visit_product';
  }
  if (type === 'recharge_zero' || /充值异常/.test(title)) {
    return 'recharge_zero';
  }
  if (type === 'tasting' || type.startsWith('custom_') || /试味/.test(title)) {
    return `${source}::${type}::${task?.id || title}`;
  }
  return `${source}::${type || title}`;
}

/** 判断是否洪潮店 */
function isHongchaoStore(store) {
  return String(store || '').includes('洪潮');
}

/** 获取「业务日」= 上海日历日 created_at 落在当天的任务（与数据中心、巡检口径一致） */
async function fetchYesterdayTasks(yesterdayYmd) {
  const sql = `
    SELECT 
      mt.id,
      mt.store,
      mt.category as task_type,
      mt.title,
      mt.status,
      mt.assignee_username,
      mt.assignee_role,
      mt.source,
      mt.created_at,
      mt.closed_at as completed_at
    FROM master_tasks mt
    WHERE (mt.created_at AT TIME ZONE 'Asia/Shanghai')::date = $1::date
      AND mt.assignee_username IS NOT NULL
      AND trim(mt.assignee_username) <> ''
    ORDER BY mt.store, mt.assignee_role, mt.assignee_username, mt.created_at
  `;
  const result = await query(sql, [yesterdayYmd]);
  return result.rows || [];
}

/** 获取用户真实姓名 */
async function getUserNames(usernames) {
  const unique = [...new Set(usernames.filter(Boolean).map(u => u.toLowerCase()))];
  if (!unique.length) return new Map();
  
  const result = await query(
    `SELECT lower(username) AS lu,
            COALESCE(NULLIF(TRIM(name), ''), username) AS display_name
     FROM feishu_users
     WHERE lower(username) = ANY($1::text[])`,
    [unique]
  );
  
  const map = new Map();
  for (const row of result.rows || []) {
    if (row.lu) map.set(row.lu, row.display_name || row.lu);
  }
  return map;
}

/** 获取接收人列表（与晨报一致：同一 username 只保留一行，避免重复 admin/probe 行导致「部分失败」误报） */
async function getRecipients() {
  const result = await query(
    `SELECT DISTINCT ON (lower(trim(username)))
       open_id, username, name, store, role
     FROM feishu_users
     WHERE registered = true AND open_id IS NOT NULL AND trim(open_id) <> ''
       AND open_id NOT LIKE '%probe%'
       AND role IN ('store_manager', 'store_production_manager', 'hq_manager', 'admin')
     ORDER BY lower(trim(username)),
       CASE WHEN trim(open_id) ILIKE '%probe%' OR trim(open_id) ILIKE 'ou_probe%' THEN 1 ELSE 0 END,
       updated_at DESC NULLS LAST`
  );
  return result.rows || [];
}

/** 构建任务明细区块 */
function buildTaskDetailSection(store, tasks, username, nameMap) {
  const rawUserTasks = tasks.filter(t => t.assignee_username.toLowerCase() === username.toLowerCase());
  const role = rawUserTasks[0]?.assignee_role || '';
  const rawName = nameMap.get(username.toLowerCase()) || username;
  const displayName = resolvePerformanceReportDisplayName(store, role, username, rawName);
  
  if (!rawUserTasks.length) return '';

  const dedupedMap = new Map();
  for (const task of rawUserTasks) {
    const key = canonicalTaskIdentity(task);
    const prev = dedupedMap.get(key);
    if (!prev) {
      dedupedMap.set(key, task);
      continue;
    }
    const prevDone = isCompleted(prev.status);
    const curDone = isCompleted(task.status);
    if (curDone && !prevDone) {
      dedupedMap.set(key, task);
      continue;
    }
    const prevTs = new Date(prev.created_at || 0).getTime();
    const curTs = new Date(task.created_at || 0).getTime();
    if (curTs > prevTs) dedupedMap.set(key, task);
  }
  const userTasks = [...dedupedMap.values()];
  userTasks.sort((a, b) => new Date(a.created_at || 0).getTime() - new Date(b.created_at || 0).getTime());
  
  let md = `**${displayName}**\n`;
  
  let completedCount = 0;
  let totalCount = userTasks.length;
  
  for (const task of userTasks) {
    const typeLabel = taskTypeLabel(task.task_type);
    const statusZh = taskStatusZh(task.status);
    const isDone = isCompleted(task.status);
    if (isDone) completedCount++;
    
    const icon = isDone ? '✅' : '❌';
    md += `${icon} ${typeLabel} · ${statusZh}\n`;
  }
  
  const rate = totalCount > 0 ? Math.round((completedCount / totalCount) * 100) : 0;
  md += `\n**达成率：${completedCount}/${totalCount} = ${rate}%**`;
  
  return md;
}

/** 构建门店区块 */
function buildStoreSection(store, tasks, nameMap) {
  let md = `**${store}**\n`;
  
  // 按角色分组
  const managers = tasks.filter(t => t.assignee_role === 'store_manager');
  const productionManagers = tasks.filter(t => t.assignee_role === 'store_production_manager');
  
  const managerUsernames = [...new Set(managers.map(t => t.assignee_username.toLowerCase()))];
  const pmUsernames = [...new Set(productionManagers.map(t => t.assignee_username.toLowerCase()))];
  
  const isHongchao = isHongchaoStore(store);
  
  // 所有门店都显示明细
  for (const username of managerUsernames) {
    const section = buildTaskDetailSection(store, tasks, username, nameMap);
    if (section) md += `\n${section}\n`;
  }
  
  for (const username of pmUsernames) {
    const section = buildTaskDetailSection(store, tasks, username, nameMap);
    if (section) md += `\n${section}\n`;
  }
  
  return md;
}

/** 构建完整卡片（HQ 管理员版本 - 所有门店） */
function buildHQCard(storeSections, yesterday) {
  const elements = [];
  
  elements.push({
    tag: 'div',
    text: { tag: 'lark_md', content: `**业务日期：${yesterday}**` }
  });
  elements.push({ tag: 'hr' });
  
  let totalTasks = 0;
  let totalCompleted = 0;
  
  for (const section of storeSections) {
    elements.push({
      tag: 'div',
      text: { tag: 'lark_md', content: section.md }
    });
    elements.push({ tag: 'hr' });
    
    totalTasks += section.totalTasks;
    totalCompleted += section.completedTasks;
  }
  
  const overallRate = totalTasks > 0 ? Math.round((totalCompleted / totalTasks) * 100) : 0;
  elements.push({
    tag: 'div',
    text: { tag: 'lark_md', content: `**🎯 总部汇总**\n总任务数：${totalTasks} ｜ 已完成：${totalCompleted}\n**总达成率：${overallRate}%**` }
  });
  
  elements.push({
    tag: 'note',
    elements: [{ tag: 'plain_text', content: '数据来源：master_tasks（飞书卡片任务）· 每日08:20自动推送' }]
  });
  
  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: `📊 每日任务达成率报告 ${yesterday}` },
      template: 'blue'
    },
    elements
  };
}

/** 构建单门店卡片（店长/出品经理版本） */
function buildStoreCard(store, storeMd, yesterday) {
  const elements = [];
  
  elements.push({
    tag: 'div',
    text: { tag: 'lark_md', content: `**业务日期：${yesterday}**` }
  });
  elements.push({ tag: 'hr' });
  
  elements.push({
    tag: 'div',
    text: { tag: 'lark_md', content: storeMd }
  });
  
  elements.push({ tag: 'hr' });
  elements.push({
    tag: 'note',
    elements: [{ tag: 'plain_text', content: '数据来源：master_tasks（飞书卡片任务）· 每日08:20自动推送' }]
  });
  
  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: `📊 每日任务达成率报告 ${yesterday}` },
      template: 'green'
    },
    elements
  };
}

/** 主函数：发送每日任务达成率报告；可选 yesterdayYmd；force 时跳过「本 run_ymd 已成功」去重便于验收重发 */
export async function sendDailyTaskCompletionReport(opts = {}) {
  try {
    let yesterday = String(opts?.yesterdayYmd || '').trim().slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(yesterday)) {
      const nowSh = new Date().toLocaleString('en-CA', { timeZone: 'Asia/Shanghai' });
      const today = nowSh.slice(0, 10);
      yesterday = new Date(new Date(today + 'T00:00:00+08:00') - 86400000)
        .toLocaleString('en-CA', { timeZone: 'Asia/Shanghai' }).slice(0, 10);
    }
    
    logger.info({ yesterday }, 'daily task completion report: starting');
    
    // 获取昨日任务
    const tasks = await fetchYesterdayTasks(yesterday);
    if (!tasks.length) {
      logger.info({ yesterday }, 'daily task completion report: no tasks found');
      return { sent: 0 };
    }
    
    // 获取所有用户名
    const usernames = [...new Set(tasks.map(t => t.assignee_username.toLowerCase()))];
    const nameMap = await getUserNames(usernames);
    
    // 按门店分组
    const storeMap = new Map();
    for (const task of tasks) {
      const store = task.store;
      if (!storeMap.has(store)) storeMap.set(store, []);
      storeMap.get(store).push(task);
    }
    
    // 构建门店区块
    const storeSections = [];
    for (const [store, storeTasks] of storeMap) {
      const totalTasks = storeTasks.length;
      const completedTasks = storeTasks.filter(t => isCompleted(t.status)).length;
      const md = buildStoreSection(store, storeTasks, nameMap);
      storeSections.push({ store, md, totalTasks, completedTasks });
    }
    
    // 获取接收人
    const recipients = await getRecipients();
    const hqRecipients = recipients.filter(
      (r) =>
        ['admin', 'hq_manager'].includes(r.role) && !isMajixianPmObserverUsername(r.username)
    );

    // 投递前主动验证/修复 admin/hq_manager 的 open_id，避免投递时跨应用失败
    for (const r of hqRecipients) {
      if (!r.open_id) continue;
      try {
        const _old = r.open_id;
        const fixed = await refreshFeishuUserOpenIdForImDelivery(_old);
        if (fixed && fixed !== _old) {
          r.open_id = fixed;
          logger.info({ username: r.username, from: _old, to: fixed }, 'preResolve: HQ recipient open_id proactively fixed');
        }
      } catch (e) {
        logger.warn({ err: e?.message, username: r.username }, 'preResolve: HQ recipient open_id check failed');
      }
    }

    let sentCount = 0;
    let failedCount = 0;
    let skippedCount = 0;
    /** @type {{ username: string, scope: string, store?: string, err: string }[]} */
    const deliveryFailures = [];
    const runYmd = getShanghaiYmd();
    const forceResend = !!opts?.force;
    
    // 发送 HQ 版本（admin + hq_manager 收到所有门店）
    const hqCard = buildHQCard(storeSections, yesterday);
    for (const recipient of hqRecipients) {
      try {
        const deliver = await sendReportToRecipient({
          jobKey: 'daily_task_completion_report',
          runYmd,
          username: recipient.username || recipient.open_id,
          scope: 'hq_summary',
          force: forceResend,
          sendFn: async () => {
            const cardRes = await sendCard(recipient.open_id, hqCard, 'open_id');
            return { ok: !!cardRes?.ok, error: cardRes?.error || '' };
          }
        });
        if (deliver?.ok && deliver?.skipped) skippedCount++;
        if (deliver?.ok && !deliver?.skipped) {
          sentCount++;
          logger.info({ recipient: recipient.username, role: recipient.role }, 'HQ task completion card sent');
        } else if (!deliver?.ok) {
          failedCount++;
          deliveryFailures.push({
            username: String(recipient.username || '').trim(),
            scope: 'hq_summary',
            err: String(deliver?.error || 'send_failed')
          });
          logger.warn({ recipient: recipient.username, role: recipient.role, err: deliver?.error }, 'HQ task completion card send failed after retries');
        }
      } catch (e) {
        failedCount++;
        deliveryFailures.push({
          username: String(recipient.username || '').trim(),
          scope: 'hq_summary',
          err: String(e?.message || e)
        });
        logger.warn({ err: e?.message, recipient: recipient.username }, 'HQ task completion card send failed');
      }
    }
    
    // 门店版：按「昨日在该店有任务」的店长/出品飞书账号投递（不依赖 feishu_users.store 是否填写，避免门店字段为空时全员收不到）
    const storeSentOpen = new Set();
    for (const [store, storeTasks] of storeMap) {
      const storeMd = buildStoreSection(store, storeTasks, nameMap);
      const storeCard = buildStoreCard(store, storeMd, yesterday);

      const assigneeKeys = [
        ...new Set(
          storeTasks
            .map((t) => String(t.assignee_username || '').trim().toLowerCase())
            .filter(Boolean)
        )
      ];
      if (!assigneeKeys.length) continue;

      const fuR = await query(
        `SELECT username, open_id, role
         FROM feishu_users
         WHERE registered = true
           AND open_id IS NOT NULL
           AND trim(open_id) <> ''
           AND role IN ('store_manager', 'store_production_manager')
           AND lower(trim(username)) = ANY($1::text[])`,
        [assigneeKeys]
      );
      const fuRows = fuR.rows || [];

      for (const row of fuRows) {
        const un = String(row.username || '').trim().toLowerCase();
        if (!assigneeKeys.includes(un)) continue;
        if (isMajixianStore(store) && isMajixianPmObserverUsername(un)) continue;
        const oid = String(row.open_id || '').trim();
        if (!oid || storeSentOpen.has(`${oid}::${store}`)) continue;
        storeSentOpen.add(`${oid}::${store}`);
        try {
          const deliver = await sendReportToRecipient({
            jobKey: 'daily_task_completion_report',
            runYmd,
            username: row.username || oid,
            scope: `store_${store}_${un}`,
            force: forceResend,
            sendFn: async () => {
              const cardRes = await sendCard(oid, storeCard, 'open_id');
              return { ok: !!cardRes?.ok, error: cardRes?.error || '' };
            }
          });
          if (deliver?.ok && deliver?.skipped) skippedCount++;
          if (deliver?.ok && !deliver?.skipped) {
            sentCount++;
            logger.info({ recipient: row.username, store }, 'store task completion card sent');
          } else if (!deliver?.ok) {
            failedCount++;
            deliveryFailures.push({
              username: String(row.username || '').trim(),
              scope: `store_${store}_${un}`,
              store,
              err: String(deliver?.error || 'send_failed')
            });
            logger.warn({ recipient: row.username, store, err: deliver?.error }, 'store task completion card send failed after retries');
          }
        } catch (e) {
          failedCount++;
          deliveryFailures.push({
            username: String(row.username || '').trim(),
            scope: `store_${store}_${un}`,
            store,
            err: String(e?.message || e)
          });
          logger.warn({ err: e?.message, recipient: row.username, store }, 'store task completion card send failed');
        }
      }

      if (isMajixianStore(store)) {
        try {
          const pms = await resolveMajixianProductionManagersForScoring(store);
          const primary = pms[0];
          const canonUn = String(primary?.username || '').trim();
          if (canonUn && canonUn !== '__periodic_kitchen__') {
            const canonR = await query(
              `SELECT username, open_id FROM feishu_users
               WHERE registered = true AND open_id IS NOT NULL AND trim(open_id) <> ''
                 AND lower(trim(username)) = lower(trim($1))`,
              [canonUn]
            );
            const oid = String(canonR.rows?.[0]?.open_id || '').trim();
            if (oid && !storeSentOpen.has(`${oid}::${store}`)) {
              storeSentOpen.add(`${oid}::${store}`);
              const deliver = await sendReportToRecipient({
                jobKey: 'daily_task_completion_report',
                runYmd,
                username: canonR.rows[0].username || oid,
                scope: `store_${store}_mj_pm_canon`,
                force: forceResend,
                sendFn: async () => {
                  const cardRes = await sendCard(oid, storeCard, 'open_id');
                  return { ok: !!cardRes?.ok, error: cardRes?.error || '' };
                }
              });
              if (deliver?.ok && deliver?.skipped) skippedCount++;
              if (deliver?.ok && !deliver?.skipped) {
                sentCount++;
                logger.info({ recipient: canonUn, store }, 'store task completion card sent (马己仙出品主责)');
              } else if (!deliver?.ok) {
                failedCount++;
                deliveryFailures.push({
                  username: String(canonUn).trim(),
                  scope: `store_${store}_mj_pm_canon`,
                  store,
                  err: String(deliver?.error || 'send_failed')
                });
                logger.warn({ recipient: canonUn, store, err: deliver?.error }, '马己仙主责出品任务达成率发送失败');
              }
            }
          }
        } catch (e) {
          logger.warn({ err: e?.message, store }, '马己仙主责出品任务达成率投递异常');
        }
      }
    }

    if (failedCount > 0) {
      const lines = [
        `业务日（昨日任务）：${yesterday}`,
        `投递日 run_ymd：${runYmd}`,
        `失败笔数：${failedCount}`,
        ...deliveryFailures.map(
          (f) =>
            `· **${f.username}**｜${f.scope}${f.store ? `｜门店：${f.store}` : ''}｜错误：${String(f.err).slice(0, 280)}`
        ),
        '请核对 `feishu_users` 中上述账号的 `open_id` 是否有效。'
      ];
      void notifyAdminsDataIssue({
        alertType: 'daily_task_completion_partial_fail',
        priority: 'B',
        title: '每日任务达成率：部分收件人飞书投递失败（含账号明细）',
        lines,
        dedupeKey: `daily_task_completion_partial_${runYmd}_${deliveryFailures.map((f) => f.username + f.scope).sort().join('|')}`,
        dedupeHours: 2
      }).catch(() => {});
      const summary = deliveryFailures.map((f) => `${f.username}:${String(f.err).slice(0, 100)}`).join(' || ');
      throw new Error(`daily task completion report has ${failedCount} failed recipient(s). Detail: ${summary}`);
    }
    if (tasks.length > 0 && sentCount === 0 && skippedCount === 0) {
      const err =
        `daily task completion: 有昨日任务但 0 条成功发出（HQ 配置人数=${hqRecipients.length}；请检查 feishu_users：admin/hq_manager/店长/出品须 registered 且 open_id 有效）`;
      logger.error({ yesterday, hq: hqRecipients.length, assigneeIssue: true }, err);
      throw new Error(err);
    }
    logger.info({ yesterday, sent: sentCount, skipped: skippedCount }, 'daily task completion report: completed');
    return { sent: sentCount, skipped: skippedCount, yesterday };
    
  } catch (e) {
    logger.error({ err: e?.message }, 'daily task completion report: failed');
    throw e;
  }
}
