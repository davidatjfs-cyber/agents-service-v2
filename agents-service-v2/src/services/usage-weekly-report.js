import { logger } from '../utils/logger.js';
import { query } from '../utils/db.js';
import { sendCard, getFeishuUserName } from './feishu-client.js';

function shanghaiDate(d = new Date()) {
  const s = new Date(d.toLocaleString('en-US', { timeZone: 'Asia/Shanghai' }));
  return s;
}

function fmtYmd(d) {
  return d.toISOString().slice(0, 10);
}

function fmtMinutes(totalMin) {
  if (!totalMin || totalMin <= 0) return '0分钟';
  const h = Math.floor(totalMin / 60);
  const m = Math.round(totalMin % 60);
  if (h > 0) return `${h}小时${m > 0 ? m + '分钟' : ''}`;
  return `${m}分钟`;
}

async function getAdminOpenIds() {
  const result = await query(
    `SELECT DISTINCT open_id FROM feishu_users WHERE role = 'admin' AND open_id IS NOT NULL AND open_id != ''`
  );
  if (result.rows.length > 0) return result.rows.map(r => r.open_id);

  const fallback = await query(
    `SELECT DISTINCT open_id FROM feishu_users WHERE LOWER(TRIM(username)) = 'admin' AND open_id IS NOT NULL AND open_id != ''`
  );
  return fallback.rows.map(r => r.open_id);
}

async function getWeeklyUsageData(periodStart, periodEnd) {
  const result = await query(`
    SELECT
      l.username,
      COALESCE(e.name, u.real_name, l.username) AS name,
      COALESCE(e.store, fu.store, '') AS store,
      COALESCE(e.position, fu.role, u.role, '') AS position,
      COUNT(*) AS login_count,
      ROUND(
        EXTRACT(EPOCH FROM (
          COALESCE(SUM(LEAST(COALESCE(l.logout_at, l.login_at + INTERVAL '5 minutes'), l.login_at + INTERVAL '12 hours') - l.login_at), INTERVAL '0'))
        ) / 60.0
      , 1) AS online_minutes
    FROM user_login_log l
    LEFT JOIN employees e ON LOWER(TRIM(e.username)) = LOWER(TRIM(l.username))
    LEFT JOIN users u ON LOWER(TRIM(u.username)) = LOWER(TRIM(l.username))
    LEFT JOIN feishu_users fu ON LOWER(TRIM(fu.username)) = LOWER(TRIM(l.username))
    WHERE (l.login_at AT TIME ZONE 'Asia/Shanghai')::date >= $1::date
      AND (l.login_at AT TIME ZONE 'Asia/Shanghai')::date <= $2::date
      AND l.username NOT LIKE '__periodic%%'
      AND COALESCE(e.name, u.real_name, '') NOT IN ('系统管理员', 'test')
    GROUP BY l.username, e.name, u.real_name, e.store, fu.store, e.position, fu.role, u.role
    ORDER BY login_count DESC, online_minutes DESC
  `, [periodStart, periodEnd]);
  return result.rows;
}

function buildUsageWeeklyCard(data, periodStart, periodEnd) {
  const totalLogins = data.reduce((s, d) => s + Number(d.login_count || 0), 0);
  const totalMinutes = data.reduce((s, d) => s + Number(d.online_minutes || 0), 0);
  const activeUsers = data.length;

  const header = {
    tag: 'plain_text',
    content: `📊 员工系统使用周报（${periodStart} ~ ${periodEnd}）`
  };

  const elements = [];

  elements.push({
    tag: 'div',
    text: {
      tag: 'lark_md',
      content: `**统计周期**：${periodStart} 至 ${periodEnd}\n**活跃人数**：${activeUsers} 人\n**总登录次数**：${totalLogins} 次\n**总在线时长**：${fmtMinutes(totalMinutes)}`
    }
  });

  elements.push({ tag: 'hr' });

  if (data.length > 0) {
    const headerLine = '| 姓名 | 门店 | 岗位 | 登录次数 | 在线时长 |\n| --- | --- | --- | --- | --- |';
    const dataLines = data.slice(0, 50).map(d => {
      const name = String(d.name || d.username || '-');
      const store = String(d.store || '-');
      const position = String(d.position || '-');
      const logins = Number(d.login_count || 0);
      const duration = fmtMinutes(Number(d.online_minutes || 0));
      return `| ${name} | ${store} | ${position} | ${logins} | ${duration} |`;
    }).join('\n');

    elements.push({
      tag: 'div',
      text: {
        tag: 'lark_md',
        content: `**员工使用明细：**\n\n${headerLine}\n${dataLines}`
      }
    });

    if (data.length > 50) {
      elements.push({
        tag: 'div',
        text: { tag: 'plain_text', content: `... 共 ${data.length} 人，仅显示前50人` }
      });
    }
  } else {
    elements.push({
      tag: 'div',
      text: { tag: 'plain_text', content: '本周暂无员工登录记录' }
    });
  }

  elements.push({ tag: 'hr' });

  const zeroLoginUsers = [];
  elements.push({
    tag: 'note',
    elements: [
      { tag: 'plain_text', content: 'HRMS 系统 · 员工系统使用周报 · 仅管理员可见' }
    ]
  });

  return {
    config: { wide_screen_mode: true },
    header: { title: header, template: 'blue' },
    elements
  };
}

export async function sendUsageWeeklyReport() {
  logger.info('📊 Sending employee usage weekly report');

  const now = shanghaiDate();
  const dayOfWeek = now.getDay();
  const mondayOffset = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
  const lastMonday = new Date(now);
  lastMonday.setDate(now.getDate() + mondayOffset - 7);
  const lastSunday = new Date(lastMonday);
  lastSunday.setDate(lastMonday.getDate() + 6);
  const periodStart = fmtYmd(lastMonday);
  const periodEnd = fmtYmd(lastSunday);

  let data;
  try {
    data = await getWeeklyUsageData(periodStart, periodEnd);
  } catch (e) {
    if (e?.message?.includes('does not exist') || e?.code === '42P01') {
      logger.warn('user_login_log table not yet created, skipping usage weekly report');
      return;
    }
    throw e;
  }

  const card = buildUsageWeeklyCard(data, periodStart, periodEnd);

  const adminOpenIds = await getAdminOpenIds();
  if (!adminOpenIds.length) {
    logger.warn('No admin open_ids found, skipping usage weekly report');
    return;
  }

  let sentCount = 0;
  for (const openId of adminOpenIds) {
    try {
      const r = await sendCard(openId, card);
      if (r?.ok) sentCount++;
      else logger.warn({ openId, error: r?.error }, 'usage weekly report send failed');
    } catch (e) {
      logger.warn({ openId, err: e?.message }, 'usage weekly report send error');
    }
  }

  logger.info({ sentCount, totalAdmins: adminOpenIds.length, activeUsers: data.length, periodStart, periodEnd }, '📊 Usage weekly report sent');
}