/**
 * daily-task-completion.js
 * 每日 08:00（上海时区）推送昨日任务达成率到飞书。
 * 按门店统计店长/出品经理的任务完成情况，含明细。
 * 洪潮店显示任务明细，马己仙店仅显示汇总。
 */
import { query } from '../utils/db.js';
import { logger } from '../utils/logger.js';
import { sendCard, sendText } from './feishu-client.js';

/** 任务类型 → 中文标签 */
function taskTypeLabel(type) {
  if (!type) return '其它';
  switch (type) {
    case 'opening_lunch': return '午市开档';
    case 'opening_dinner': return '晚市开档';
    case 'prep_lunch': return '午市备货';
    case 'prep_dinner': return '晚市备货';
    case 'table_visit_tracking': return '桌访记录';
    case 'bad_review_followup': return '差评跟踪';
    case 'patrol_am': return '上午巡检';
    case 'patrol_pm': return '下午巡检';
    case 'tasting': return '试味';
    default:
      if (type.startsWith('custom_')) return '试味';
      return type;
  }
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
    default: return status || '未知';
  }
}

/** 角色 → 中文 */
function roleLabelZh(role) {
  switch (role) {
    case 'store_manager': return '店长';
    case 'store_production_manager': return '出品经理';
    default: return role || '';
  }
}

/** 判断是否已完成 */
function isCompleted(status) {
  return ['closed'].includes(status);
}

/** 判断是否洪潮店 */
function isHongchaoStore(store) {
  return String(store || '').includes('洪潮');
}

/** 获取昨日任务数据 */
async function fetchYesterdayTasks(yesterday) {
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
    WHERE mt.created_at >= $1::date AND mt.created_at < ($1::date + interval '1 day')
      AND mt.assignee_username IS NOT NULL
      AND mt.assignee_username != ''
    ORDER BY mt.store, mt.assignee_role, mt.assignee_username, mt.created_at
  `;
  const result = await query(sql, [yesterday]);
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

/** 获取接收人列表 */
async function getRecipients() {
  const result = await query(
    `SELECT open_id, username, name, store, role 
     FROM feishu_users
     WHERE registered = true AND open_id IS NOT NULL AND open_id != ''
     AND role IN ('store_manager', 'store_production_manager', 'hq_manager', 'admin')
     ORDER BY role, store`
  );
  return result.rows || [];
}

/** 构建任务明细区块（仅洪潮店） */
function buildTaskDetailSection(tasks, username, nameMap) {
  const displayName = nameMap.get(username.toLowerCase()) || username;
  const userTasks = tasks.filter(t => t.assignee_username.toLowerCase() === username.toLowerCase());
  
  if (!userTasks.length) return '';
  
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

/** 构建汇总区块（马己仙店） */
function buildSummarySection(tasks, username, nameMap) {
  const displayName = nameMap.get(username.toLowerCase()) || username;
  const userTasks = tasks.filter(t => t.assignee_username.toLowerCase() === username.toLowerCase());
  
  if (!userTasks.length) return '';
  
  let completedCount = userTasks.filter(t => isCompleted(t.status)).length;
  let totalCount = userTasks.length;
  const rate = totalCount > 0 ? Math.round((completedCount / totalCount) * 100) : 0;
  
  let md = `**${displayName}**\n`;
  md += `任务总数：${totalCount} ｜ 已完成：${completedCount}\n`;
  md += `**达成率：${rate}%**`;
  
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
    const section = buildTaskDetailSection(tasks, username, nameMap);
    if (section) md += `\n${section}\n`;
  }
  
  for (const username of pmUsernames) {
    const section = buildTaskDetailSection(tasks, username, nameMap);
    if (section) md += `\n${section}\n`;
  }
  
  return md;
}

/** 构建完整卡片（HQ 管理员版本 - 所有门店） */
function buildHQCard(storeSections, yesterday) {
  const elements = [];
  
  elements.push({
    tag: 'div',
    text: { tag: 'lark_md', content: `**📊 每日任务达成率报告 · ${yesterday}**` }
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
    elements: [{ tag: 'plain_text', content: '数据来源：master_tasks（飞书卡片任务）· 每日08:50自动推送' }]
  });
  
  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: `📊 每日任务达成率 · ${yesterday}` },
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
    text: { tag: 'lark_md', content: `**📊 每日任务达成率报告 · ${yesterday}**` }
  });
  elements.push({ tag: 'hr' });
  
  elements.push({
    tag: 'div',
    text: { tag: 'lark_md', content: storeMd }
  });
  
  elements.push({ tag: 'hr' });
  elements.push({
    tag: 'note',
    elements: [{ tag: 'plain_text', content: '数据来源：master_tasks（飞书卡片任务）· 每日08:50自动推送' }]
  });
  
  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: `📊 每日任务达成率 · ${yesterday}` },
      template: 'green'
    },
    elements
  };
}

/** 主函数：发送每日任务达成率报告 */
export async function sendDailyTaskCompletionReport() {
  try {
    const nowSh = new Date().toLocaleString('en-CA', { timeZone: 'Asia/Shanghai' });
    const today = nowSh.slice(0, 10);
    const yesterday = new Date(new Date(today + 'T00:00:00+08:00') - 86400000)
      .toLocaleString('en-CA', { timeZone: 'Asia/Shanghai' }).slice(0, 10);
    
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
    
    let sentCount = 0;
    
    // 发送 HQ 版本（admin + hq_manager 收到所有门店）
    const hqCard = buildHQCard(storeSections, yesterday);
    const hqRecipients = recipients.filter(r => ['admin', 'hq_manager'].includes(r.role));
    for (const recipient of hqRecipients) {
      try {
        const cardRes = await sendCard(recipient.open_id, hqCard, 'open_id');
        if (cardRes?.ok) {
          sentCount++;
          logger.info({ recipient: recipient.username, role: recipient.role }, 'HQ task completion card sent');
        }
      } catch (e) {
        logger.warn({ err: e?.message, recipient: recipient.username }, 'HQ task completion card send failed');
      }
    }
    
    // 发送门店版本（店长/出品经理只收到自己门店）
    for (const [store, storeTasks] of storeMap) {
      const storeMd = buildStoreSection(store, storeTasks, nameMap);
      const storeCard = buildStoreCard(store, storeMd, yesterday);
      
      const storeRecipients = recipients.filter(
        r => r.role === 'store_manager' || r.role === 'store_production_manager'
      ).filter(r => {
        // 模糊匹配门店名
        const rStore = String(r.store || '').trim();
        return rStore === store || rStore.includes(store) || store.includes(rStore);
      });
      
      for (const recipient of storeRecipients) {
        try {
          const cardRes = await sendCard(recipient.open_id, storeCard, 'open_id');
          if (cardRes?.ok) {
            sentCount++;
            logger.info({ recipient: recipient.username, store }, 'store task completion card sent');
          }
        } catch (e) {
          logger.warn({ err: e?.message, recipient: recipient.username, store }, 'store task completion card send failed');
        }
      }
    }
    
    logger.info({ yesterday, sent: sentCount }, 'daily task completion report: completed');
    return { sent: sentCount };
    
  } catch (e) {
    logger.error({ err: e?.message }, 'daily task completion report: failed');
    throw e;
  }
}
