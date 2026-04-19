import { logger } from '../utils/logger.js';
import { query } from '../utils/db.js';
import { sendCard } from './feishu-client.js';

function fmtYmd(d) {
  return d.toISOString().slice(0, 10);
}

function shanghaiNow() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Shanghai' }));
}

function addDays(d, n) {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}

async function sendFarewellNotifications() {
  logger.info('👋 Checking farewell notifications for departing employees...');

  const now = shanghaiNow();
  const twoDaysLater = addDays(now, 2);
  const targetDate = fmtYmd(twoDaysLater);

  const departingEmployees = [];

  // Source 1: approval_requests with type='offboarding' and effective_date = targetDate
  try {
    const offboardResult = await query(`
      SELECT ar.applicant_username, ar.effective_date, ar.status,
             COALESCE(e.name, ar.applicant_username) AS name,
             COALESCE(e.store, '') AS store,
             COALESCE(e.position, '') AS position
      FROM approval_requests ar
      LEFT JOIN employees e ON LOWER(TRIM(e.username)) = LOWER(TRIM(ar.applicant_username))
      WHERE ar.type = 'offboarding'
        AND ar.status = 'approved'
        AND ar.effective_date = $1::date
    `, [targetDate]);

    for (const row of offboardResult.rows) {
      departingEmployees.push({
        username: String(row.applicant_username || '').trim().toLowerCase(),
        name: String(row.name || row.applicant_username || '').trim(),
        store: String(row.store || ''),
        position: String(row.position || ''),
        source: 'offboarding_approval'
      });
    }
  } catch (e) {
    logger.warn({ err: e?.message }, '👋 Failed to query approval_requests for farewell');
  }

  // Source 2: employees with status='离职' and offboardingDate = targetDate in hrms_state
  try {
    const stateResult = await query(`
      SELECT username, name, store, position, extra_json
      FROM employees
      WHERE status = '离职'
        AND (extra_json->>'offboardingDate') = $1
    `, [targetDate]);

    for (const row of stateResult.rows) {
      const username = String(row.username || '').trim().toLowerCase();
      if (!departingEmployees.find(d => d.username === username)) {
        departingEmployees.push({
          username,
          name: String(row.name || row.username || '').trim(),
          store: String(row.store || ''),
          position: String(row.position || ''),
          source: 'hrms_state'
        });
      }
    }
  } catch (e) {
    logger.warn({ err: e?.message }, '👋 Failed to query employees for farewell (status=离职)');
  }

  // Remove duplicates
  const unique = [];
  const seen = new Set();
  for (const emp of departingEmployees) {
    if (!seen.has(emp.username)) {
      seen.add(emp.username);
      unique.push(emp);
    }
  }

  if (!unique.length) {
    logger.info('👋 No departing employees found for ' + targetDate);
    return;
  }

  logger.info({ count: unique.length, targetDate }, '👋 Found departing employees');

  for (const emp of unique) {
    const empName = emp.name || emp.username;
    const dedupKey = `farewell_${emp.username}_${targetDate}`;

    try {
      const alreadySent = await query(
        `SELECT id FROM hrms_user_notifications WHERE type = $1 AND meta->>'dedup_key' = $2 LIMIT 1`,
        ['farewell_notification', dedupKey]
      );
      if (alreadySent.rows.length > 0) {
        logger.info({ empName }, '👋 Farewell already sent, skipping');
        continue;
      }
    } catch (e) {
      // Table might not have meta column yet, proceed with send
    }

    const card = {
      config: { wide_screen_mode: true },
      header: {
        title: { tag: 'plain_text', content: '💌 感谢有你' },
        template: 'blue'
      },
      elements: [
        {
          tag: 'div',
          text: {
            tag: 'lark_md',
            content: `亲爱的${empName}：\n\n离别不是结束，而是新的开始。感谢你为公司发展做出的贡献，祝愿你前程锦绣，未来一路坦途。\n\n公司总部`
          }
        },
        { tag: 'hr' },
        {
          tag: 'note',
          elements: [
            { tag: 'plain_text', content: 'HRMS · 离职关怀通知' }
          ]
        }
      ]
    };

    let feishuSent = false;
    try {
      const openIds = await query(
        `SELECT open_id FROM feishu_users WHERE LOWER(TRIM(username)) = LOWER($1) AND open_id IS NOT NULL AND open_id != ''`,
        [emp.username]
      );
      for (const row of (openIds.rows || [])) {
        try {
          const r = await sendCard(row.open_id, card);
          if (r?.ok) feishuSent = true;
        } catch (e2) {
          logger.warn({ open_id: row.open_id, err: e2?.message }, '👋 Farewell card send failed');
        }
      }
    } catch (e) {
      logger.warn({ err: e?.message }, '👋 Failed to lookup feishu open_id');
    }

    try {
      await query(
        `INSERT INTO hrms_user_notifications (target_username, title, message, type, meta)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          emp.username,
          '💌 感谢有你',
          `亲爱的${empName}：离别不是结束，而是新的开始。感谢你为公司发展做出的贡献，祝愿你前程锦绣，未来一路坦途。\n\n公司总部`,
          'farewell_notification',
          JSON.stringify({ dedup_key: dedupKey, store: emp.store || '', role: emp.position || '', feishu_sent: feishuSent })
        ]
      );
    } catch (e) {
      logger.warn({ err: e?.message }, '👋 Failed to insert farewell notification to DB');
    }

    logger.info({ empName, empUsername: emp.username, feishuSent }, '👋 Farewell notification sent');
  }
}

export { sendFarewellNotifications };