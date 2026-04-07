/**
 * daily-execution-rating.js
 * 每日执行力评级检查（08:00 Asia/Shanghai）
 * 检查昨日各门店店长/出品经理的执行力达标情况
 * 未达标项：记录HR备案 + 发送公司通知 + 飞书卡片通知
 * 
 * 数据源：
 * - 出品经理：agent_messages (opening_report, closing_report, material_report)
 * - 洪潮店长：daily_reports (new_wechat_members)
 * - 马己仙店长：feishu_generic_records (meeting_reports)
 */
import { query } from '../utils/db.js';
import { logger } from '../utils/logger.js';
import { sendCard, sendText } from './feishu-client.js';

// ─────────────────────────────────────────────
// 1. 数据查询函数
// ─────────────────────────────────────────────

/**
 * 获取出品经理昨日报告提交情况
 * @param {string} store - 门店名（如"洪潮大宁久光店"）
 * @param {string} brand - 品牌（如"洪潮"）
 * @param {string} date - 日期 YYYY-MM-DD
 * @returns {Promise<{opening: boolean, closing: boolean, material: boolean}>}
 */
async function getPMReportStatus(store, brand, date) {
  // 门店名映射
  const storeMapping = {
    '洪潮大宁久光店': '洪潮久光店',
    '马己仙上海音乐广场店': '马己仙大宁店'
  };
  const storeInData = storeMapping[store] || store;

  const [opening, closing, material] = await Promise.all([
    // 开档报告
    query(
      `SELECT COUNT(*)::int as cnt FROM agent_messages 
       WHERE content_type = 'opening_report' 
         AND (agent_data->'fields'->>'store') = $1 
         AND created_at::date = $2::date`,
      [storeInData, date]
    ).then(r => r.rows[0].cnt > 0),
    // 收档报告
    query(
      `SELECT COUNT(*)::int as cnt FROM agent_messages 
       WHERE content_type = 'closing_report' 
         AND (agent_data->'fields'->>'store') = $1 
         AND created_at::date = $2::date`,
      [storeInData, date]
    ).then(r => r.rows[0].cnt > 0),
    // 原料收货日报（按品牌）
    query(
      `SELECT COUNT(*)::int as cnt FROM agent_messages 
       WHERE content_type = 'material_report' 
         AND (agent_data->>'brand') = $1 
         AND created_at::date = $2::date`,
      [brand.toLowerCase(), date]
    ).then(r => r.rows[0].cnt > 0)
  ]);

  return { opening, closing, material };
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
    await query(
      `INSERT INTO ops_tasks 
       (store, task_type, title, status, assignee_username, assignee_role, source, created_at, biz_date, detail)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), $8::date, $9::jsonb)`,
      [
        store,
        'execution_rating_daily',
        `${store} · 执行力日评不达标 · ${missing.join('/')}`,
        'pending_review',
        username,
        role,
        'execution_rating',
        date,
        { rating, missing, detail, filed_at: new Date().toISOString() }
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
 * 构建执行力日评飞书卡片
 */
function buildExecutionRatingCard({ store, username, name, role, date, rating, missing, detail }) {
  const roleLabel = role === 'store_manager' ? '店长' : '出品经理';
  const ratingColor = rating === 'A' ? 'green' : rating === 'B' ? 'blue' : rating === 'C' ? 'orange' : 'red';
  
  let missingMd = '';
  if (missing && missing.length > 0) {
    missingMd = `\n**未达标项目**\n${missing.map(m => `❌ ${m}`).join('\n')}`;
  }

  let detailMd = '';
  if (detail) {
    const lines = [];
    if (detail.opening !== undefined) lines.push(`开档报告：${detail.opening ? '✅ 已提交' : '❌ 未提交'}`);
    if (detail.closing !== undefined) lines.push(`收档报告：${detail.closing ? '✅ 已提交' : '❌ 未提交'}`);
    if (detail.material !== undefined) lines.push(`原料收货：${detail.material ? '✅ 已提交' : '❌ 未提交'}`);
    if (detail.wechatMembers !== undefined) lines.push(`企微会员新增：${detail.wechatMembers}人`);
    if (detail.meetingScore !== undefined) lines.push(`例会得分：${detail.meetingScore}分 ${detail.qualified ? '✅ 合格' : '❌ 不合格'}`);
    if (lines.length) detailMd = `\n**详细数据**\n${lines.join('\n')}`;
  }

  const content = `**门店**：${store}
**岗位**：${roleLabel} · ${name || username}
**日期**：${date}
**执行力评级**：${rating}级${missingMd}${detailMd}`;

  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: `📋 执行力日评 · ${date}` },
      template: ratingColor
    },
    elements: [
      { tag: 'div', text: { tag: 'lark_md', content } },
      { tag: 'note', elements: [{ tag: 'plain_text', content: '数据来源：开档/收档/原料收货报告 · 每日08:00自动检查' }] }
    ]
  };
}

/**
 * 构建汇总卡片（管理员/总部营运）
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
 * 发送执行力日评通知
 */
async function sendExecutionRatingNotifications(results, date) {
  const failedResults = results.filter(r => r.rating !== 'A');
  let sentCount = 0;

  // 1. 未达标个人通知
  for (const r of failedResults) {
    const card = buildExecutionRatingCard(r);
    
    // 发给本人
    if (r.open_id) {
      try {
        await sendCard(r.open_id, card, 'open_id');
        sentCount++;
        logger.info({ recipient: r.username, store: r.store }, 'execution rating card sent to individual');
      } catch (e) {
        logger.warn({ err: e?.message, recipient: r.username }, 'execution rating card send failed');
      }
    }
  }

  // 2. 汇总通知给管理员和总部营运
  const adminRecipients = await query(
    `SELECT open_id, username, role FROM feishu_users 
     WHERE registered = true AND open_id IS NOT NULL AND open_id != ''
     AND role IN ('admin', 'hq_manager')`
  );

  if (adminRecipients.rows.length > 0) {
    const summaryCard = buildSummaryCard(results, date);
    for (const recipient of adminRecipients.rows) {
      try {
        await sendCard(recipient.open_id, summaryCard, 'open_id');
        sentCount++;
        logger.info({ recipient: recipient.username, role: recipient.role }, 'execution summary card sent to admin');
      } catch (e) {
        logger.warn({ err: e?.message, recipient: recipient.username }, 'execution summary card send failed');
      }
    }
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
