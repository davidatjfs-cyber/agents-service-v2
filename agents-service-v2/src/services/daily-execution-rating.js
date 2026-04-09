/**
 * daily-execution-rating.js
 * 每日执行力评级检查（08:00 Asia/Shanghai）
 * 检查昨日各门店店长/出品经理的执行力达标情况
 * 未达标项：记录HR备案 + 发送公司通知 + 飞书卡片通知
 * 
 * 数据源：
 * - 出品经理：开档/收档 agent_messages（按表内业务日期）；原料收货 feishu_generic_records（与聊天口径一致）
 * - 洪潮店长：daily_reports (new_wechat_members)
 * - 马己仙店长：feishu_generic_records (meeting_reports)
 */
import { query } from '../utils/db.js';
import { logger } from '../utils/logger.js';
import { sendCard } from './feishu-client.js';
import { getShanghaiYmd, sendReportToRecipient } from './report-delivery.js';
import { getPMReportStatusByBizDate } from './pm-execution-report-coverage.js';

// ─────────────────────────────────────────────
// 1. 数据查询函数
// ─────────────────────────────────────────────

/**
 * 获取出品经理某日报告是否已提交（按飞书表「日期」业务日，而非入库 created_at，避免跨日同步误判）
 */
async function getPMReportStatus(store, brand, date) {
  return getPMReportStatusByBizDate(store, brand, date);
}

/**
 * 获取洪潮店长昨日企微会员新增
 * @param {string} store - 门店名
 * @param {string} date - 日期 YYYY-MM-DD
 * @returns {Promise<number>}
 */
async function getHongchaoWechatMembers(store, date) {
  const result = await query(
    `SELECT COALESCE(SUM(new_wechat_members), 0) as total 
     FROM daily_reports 
     WHERE store ILIKE '%洪潮%' AND date = $1::date`,
    [date]
  );
  return Number(result.rows[0]?.total || 0);
}

/**
 * 获取马己仙店长昨日例会报告
 * @param {string} store - 门店名
 * @param {string} date - 日期 YYYY-MM-DD
 * @returns {Promise<{submitted: boolean, score: number|null, qualified: boolean}>}
 */
async function getMajixianMeetingReport(store, date) {
  // 马己仙门店名映射
  const storeMapping = {
    '马己仙上海音乐广场店': '马己仙大宁店'
  };
  const storeInData = storeMapping[store] || store;

  const result = await query(
    `SELECT fields->>'得分' as score,
            fields->>'所属门店' as meeting_store
     FROM feishu_generic_records 
     WHERE config_key = 'meeting_reports'
       AND created_at::date = $1::date
     ORDER BY created_at DESC
     LIMIT 1`,
    [date]
  );

  if (!result.rows.length) {
    return { submitted: false, score: null, qualified: false };
  }

  const score = Number(result.rows[0]?.score || 0);
  return {
    submitted: true,
    score,
    qualified: score >= 7
  };
}

// ─────────────────────────────────────────────
// 2. 执行力评级判定
// ─────────────────────────────────────────────

/**
 * 出品经理执行力评级
 * @param {Object} reports - {opening, closing, material}
 * @returns {{rating: string, missing: string[]}}
 */
function evaluatePMExecution(reports) {
  const missing = [];
  if (!reports.opening) missing.push('开档报告');
  if (!reports.closing) missing.push('收档报告');
  if (!reports.material) missing.push('原料收货日报');

  // 日评：只要有一项未提交就算未达成
  if (missing.length === 0) {
    return { rating: 'A', missing: [] };
  }
  return { rating: 'D', missing };
}

/**
 * 洪潮店长执行力评级
 * @param {number} wechatMembers - 今日新增企微会员数
 * @returns {{rating: string, value: number}}
 */
function evaluateHongchaoManager(wechatMembers) {
  if (wechatMembers >= 300) return { rating: 'A', value: wechatMembers };
  if (wechatMembers >= 249) return { rating: 'B', value: wechatMembers };
  if (wechatMembers >= 200) return { rating: 'C', value: wechatMembers };
  return { rating: 'D', value: wechatMembers };
}

/**
 * 马己仙店长执行力评级
 * @param {Object} meeting - {submitted, score, qualified}
 * @returns {{rating: string, score: number|null, qualified: boolean}}
 */
function evaluateMajixianManager(meeting) {
  if (!meeting.submitted) {
    return { rating: 'D', score: null, qualified: false, missing: '未提交例会报告' };
  }
  if (meeting.qualified) {
    return { rating: 'A', score: meeting.score, qualified: true };
  }
  return { rating: 'D', score: meeting.score, qualified: false, missing: `得分${meeting.score}分<7分` };
}

// ─────────────────────────────────────────────
// 3. HR备案记录
// ─────────────────────────────────────────────

/**
 * 记录执行力未达标的HR备案
 */
async function recordExecutionFiling({ store, username, role, date, rating, missing, detail }) {
  try {
    const dedupeKey = `execution_rating_${store}_${date}_${username}`;
    const scheduleKey = `daily_execution_rating_${store}`;

    await query(
      `INSERT INTO ops_tasks
       (store, task_type, title, status, assignee_username, assignee_role, source, created_at, biz_date, evidence_urls, dedupe_key, schedule_key, due_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), $8::date, $9::jsonb, $10, $11, NOW())`,
      [
        store,
        'execution_rating_daily',
        `${store} · 执行力日评不达标 · ${missing.join('/')}`,
        'pending_review',
        username,
        role,
        'execution_rating',
        date,
        { rating, missing, detail, filed_at: new Date().toISOString() },
        dedupeKey,
        scheduleKey
      ]
    );
    logger.info({ store, username, role, date, rating, missing }, 'execution rating filed');
  } catch (e) {
    logger.error({ err: e?.message, store, username }, 'execution rating filing failed');
  }
}

// ─────────────────────────────────────────────
// 4. 飞书通知
// ─────────────────────────────────────────────

/**
 * 构建执行力备案飞书卡片
 */
function buildFilingCard({ store, username, name, role, rating, missing }, date) {
  const roleLabel = role === 'store_manager' ? '店长' : '出品经理';
  const ratingColor = rating === 'B' ? 'blue' : rating === 'C' ? 'orange' : 'red';

  let missingMd = '';
  if (missing && missing.length > 0) {
    missingMd = `\n**未达标项目**\n${missing.map(m => `❌ ${m}`).join('\n')}`;
  }

  const content = `**备案类型**：工作执行力评级
**门店**：${store}
**岗位**：${roleLabel} · ${name || username}
**日期**：${date}
**评级**：${rating}级${missingMd}`;

  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: `📋 工作执行力评级备案 · ${date}` },
      template: ratingColor
    },
    elements: [
      { tag: 'div', text: { tag: 'lark_md', content } },
      { tag: 'note', elements: [{ tag: 'plain_text', content: '数据来源：开档/收档/原料收货报告 · 每日08:00自动检查' }] }
    ]
  };
}

/**
 * 发送执行力备案通知
 */
function buildSummaryCard(results, date) {
  const failedResults = results.filter(r => r.rating !== 'A');
  const allResults = results;

  let md = `**日期**：${date}\n**检查门店数**：${new Set(allResults.map(r => r.store)).size}\n**总检查项**：${allResults.length}\n**达标**：${allResults.length - failedResults.length}\n**未达标**：${failedResults.length}\n`;

  if (failedResults.length > 0) {
    md += `\n**未达标明细**\n`;
    for (const r of failedResults) {
      const roleLabel = r.role === 'store_manager' ? '店长' : '出品经理';
      md += `\n• **${r.store}** · ${roleLabel} ${r.name || r.username}：${r.rating}级`;
      if (r.missing && r.missing.length > 0) {
        md += `（${r.missing.join('/')}）`;
      }
    }
  } else {
    md += `\n✅ 全部达标！`;
  }

  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: `📊 执行力日评汇总 · ${date}` },
      template: 'blue'
    },
    elements: [
      { tag: 'div', text: { tag: 'lark_md', content: md } },
      { tag: 'note', elements: [{ tag: 'plain_text', content: '数据来源：agent_messages + daily_reports + feishu_generic_records · 每日08:00自动检查' }] }
    ]
  };
}

/**
 * 构建执行力备案汇总卡片（管理员/总部营运）
 */
function buildAdminFilingCard(results, date) {
  const failedResults = results.filter(r => r.rating !== 'A');

  let md = `**日期**：${date}\n**备案人数**：${failedResults.length}\n`;

  if (failedResults.length > 0) {
    md += `\n**备案明细**\n`;
    for (const r of failedResults) {
      const roleLabel = r.role === 'store_manager' ? '店长' : '出品经理';
      const missing = r.missing && r.missing.length > 0 ? `（${r.missing.join('/')}）` : '';
      md += `\n• ${r.store} · ${roleLabel} ${r.name || r.username}：${r.rating}级 ${missing}`;
    }
  } else {
    md += `\n✅ 全部达标，无需备案`;
  }

  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: `📋 工作执行力评级备案汇总 · ${date}` },
      template: 'blue'
    },
    elements: [
      { tag: 'div', text: { tag: 'lark_md', content: md } },
      { tag: 'note', elements: [{ tag: 'plain_text', content: '数据来源：开档/收档/原料收货报告 · 每日08:00自动检查' }] }
    ]
  };
}

/**
 * 发送执行力备案通知（飞书卡片 + HRMS公司通知）
 */
async function sendExecutionRatingNotifications(results, date) {
  const failedResults = results.filter(r => r.rating !== 'A');
  let sentCount = 0;
  let failedCount = 0;
  const runYmd = getShanghaiYmd();

  // 1. 发备案通知给未达标人员（飞书卡片 + HRMS通知）
  for (const r of failedResults) {
    const card = buildFilingCard(r, date);
    const roleLabel = r.role === 'store_manager' ? '店长' : '出品经理';
    const missingText = r.missing && r.missing.length > 0 ? r.missing.join('/') : '';

    // 飞书卡片
    if (r.open_id) {
      try {
        const deliver = await sendReportToRecipient({
          jobKey: 'daily_execution_rating_report',
          runYmd,
          username: r.username || r.open_id,
          scope: 'individual_filing',
          sendFn: async () => {
            const cardRes = await sendCard(r.open_id, card, 'open_id');
            return { ok: !!cardRes?.ok, error: cardRes?.error || '' };
          }
        });
        if (deliver?.ok && !deliver?.skipped) {
          sentCount++;
          logger.info({ recipient: r.username, store: r.store }, 'execution filing card sent to individual');
        } else if (!deliver?.ok) {
          failedCount++;
          logger.warn({ recipient: r.username, store: r.store, err: deliver?.error }, 'execution filing card send failed after retries');
        }
      } catch (e) {
        failedCount++;
        logger.warn({ err: e?.message, recipient: r.username }, 'execution filing card send failed');
      }
    }

    // HRMS公司通知
    try {
      await query(
        `INSERT INTO hrms_user_notifications (target_username, title, message, type, meta)
         VALUES ($1, $2, $3, $4, $5::jsonb)
         ON CONFLICT (target_username, type, meta) DO NOTHING`,
        [
          r.username,
          '工作执行力评级备案',
          `您的工作执行力评级为${r.rating}级，未达标项目：${missingText || '无'}。\n门店：${r.store}\n岗位：${roleLabel} · ${r.name || r.username}\n日期：${date}`,
          'execution_rating_daily',
          JSON.stringify({ date, rating: r.rating, missing: r.missing, store: r.store, role: r.role })
        ]
      );
      logger.info({ recipient: r.username, store: r.store }, 'execution filing hrms notification sent');
    } catch (e) {
      logger.warn({ err: e?.message, recipient: r.username }, 'execution filing hrms notification failed');
    }
  }

  // 2. 发备案汇总通知给管理员和总部营运（一条汇总，包含所有未达标人员）
  if (failedResults.length > 0) {
    const adminRecipients = await query(
      `SELECT open_id, username, role FROM feishu_users
       WHERE registered = true AND open_id IS NOT NULL AND open_id != ''
        AND role IN ('admin', 'hq_manager')`
    );

    const summaryCard = buildAdminFilingCard(results, date);
    for (const recipient of adminRecipients.rows) {
      try {
        const deliver = await sendReportToRecipient({
          jobKey: 'daily_execution_rating_report',
          runYmd,
          username: recipient.username || recipient.open_id,
          scope: 'admin_summary',
          sendFn: async () => {
            const cardRes = await sendCard(recipient.open_id, summaryCard, 'open_id');
            return { ok: !!cardRes?.ok, error: cardRes?.error || '' };
          }
        });
        if (deliver?.ok && !deliver?.skipped) {
          sentCount++;
          logger.info({ recipient: recipient.username, role: recipient.role }, 'execution filing summary card sent to admin');
        } else if (!deliver?.ok) {
          failedCount++;
          logger.warn({ recipient: recipient.username, role: recipient.role, err: deliver?.error }, 'execution filing summary card send failed after retries');
        }
      } catch (e) {
        failedCount++;
        logger.warn({ err: e?.message, recipient: recipient.username }, 'execution filing summary card send failed to admin');
      }
    }
  }

  if (failedCount > 0) {
    throw new Error(`daily execution rating report has ${failedCount} failed recipients`);
  }
  return sentCount;
}

// ─────────────────────────────────────────────
// 5. 主函数
// ─────────────────────────────────────────────

/**
 * 执行每日执行力评级检查
 * @param {string} date - 检查日期 YYYY-MM-DD（默认昨天）
 */
export async function runDailyExecutionRating(date) {
  try {
    // 默认检查昨天
    if (!date) {
      const nowSh = new Date().toLocaleString('en-CA', { timeZone: 'Asia/Shanghai' });
      const today = nowSh.slice(0, 10);
      date = new Date(new Date(today + 'T00:00:00+08:00') - 86400000)
        .toLocaleString('en-CA', { timeZone: 'Asia/Shanghai' }).slice(0, 10);
    }

    logger.info({ date }, 'daily execution rating: starting');

    // 获取所有需要检查的门店和人员
    const staffResult = await query(
      `SELECT DISTINCT ON (store, role) 
              fu.username, fu.name, fu.open_id, fu.role, fu.store,
              CASE 
                WHEN fu.store ILIKE '%洪潮%' THEN '洪潮'
                WHEN fu.store ILIKE '%马己仙%' THEN '马己仙'
                ELSE '未知'
              END as brand
       FROM feishu_users fu
       WHERE fu.registered = true 
         AND fu.role IN ('store_manager', 'store_production_manager')
         AND fu.store IS NOT NULL AND fu.store != ''
       ORDER BY store, role, fu.username`
    );

    const staff = staffResult.rows || [];
    if (!staff.length) {
      logger.warn('daily execution rating: no staff found');
      return { date, checked: 0, results: [] };
    }

    const results = [];

    for (const s of staff) {
      const { username, name, open_id, role, store, brand } = s;
      let rating, missing, detail;

      try {
        if (role === 'store_production_manager') {
          // 出品经理：检查3种报告
          const reports = await getPMReportStatus(store, brand, date);
          const eval_ = evaluatePMExecution(reports);
          rating = eval_.rating;
          missing = eval_.missing;
          detail = { opening: reports.opening, closing: reports.closing, material: reports.material };

          // 未达标：记录HR备案 + 发送通知
          if (rating !== 'A') {
            await recordExecutionFiling({ store, username, role, date, rating, missing, detail });
          }
        } else if (role === 'store_manager') {
          if (brand === '洪潮') {
            // 洪潮店长：企微会员
            const members = await getHongchaoWechatMembers(store, date);
            const eval_ = evaluateHongchaoManager(members);
            rating = eval_.rating;
            missing = eval_.rating === 'D' ? ['企微会员新增不足'] : [];
            detail = { wechatMembers: members };

            if (rating !== 'A') {
              await recordExecutionFiling({ store, username, role, date, rating, missing, detail });
            }
          } else if (brand === '马己仙') {
            // 马己仙店长：例会报告
            const meeting = await getMajixianMeetingReport(store, date);
            const eval_ = evaluateMajixianManager(meeting);
            rating = eval_.rating;
            missing = eval_.missing ? [eval_.missing] : [];
            detail = { meetingScore: eval_.score, qualified: eval_.qualified };

            if (rating !== 'A') {
              await recordExecutionFiling({ store, username, role, date, rating, missing, detail });
            }
          }
        }
      } catch (e) {
        logger.error({ err: e?.message, username, store }, 'execution rating check failed');
        continue;
      }

      results.push({ username, name, open_id, role, store, brand, date, rating, missing, detail });
    }

    // 发送通知
    const sentCount = await sendExecutionRatingNotifications(results, date);

    logger.info({ date, checked: results.length, failed: results.filter(r => r.rating !== 'A').length, sent: sentCount }, 'daily execution rating: completed');
    return { date, checked: results.length, results, sent: sentCount };

  } catch (e) {
    logger.error({ err: e?.message }, 'daily execution rating: failed');
    throw e;
  }
}
