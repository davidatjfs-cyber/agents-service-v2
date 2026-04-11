/**
 * daily-execution-rating.js
 * 每日执行力评级检查（08:00 Asia/Shanghai）
 * 检查昨日各门店店长/出品经理的执行力达标情况
 * 未达标项：记录HR备案 + 发送公司通知 + 飞书卡片通知
 * 
 * 数据源：
 * - 出品经理：开档/收档/原料收货均为 agent_messages（飞书 bitable 轮询写入，按业务日 + 档口齐套）
 * - 洪潮店长：企微为月累计指标，**不参与日频**备案（避免与日卡片混淆；月评仍读 daily_reports）
 * - 马己仙店长：agent_messages (meeting_report，飞书例会同步写入)
 */
import { query } from '../utils/db.js';
import { logger } from '../utils/logger.js';
import { notifyAdminsDataIssue } from './admin-data-alert.js';
import { sendCard } from './feishu-client.js';
import { getShanghaiYmd, sendReportToRecipient } from './report-delivery.js';
import { getPMReportStatusByBizDate, getMajixianMeetingDayEval } from './pm-execution-report-coverage.js';
import { sortFeishuScoringRows } from '../utils/scoring-assignee.js';
import { getMonthlyExecutionFilingCount } from '../utils/performance-filing-counts.js';

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
 * 洪潮店长执行力：企微会员为「当月累计至检查日（含）」口径，与月评企微档位一致；禁止用单日新增误判。
 */
async function getHongchaoWechatMonthToDate(store, date) {
  const monthStart = String(date || '').slice(0, 7) + '-01';
  const result = await query(
    `SELECT COALESCE(SUM(new_wechat_members), 0) AS total
     FROM daily_reports
     WHERE TRIM(store) = TRIM($1::text)
       AND date >= $2::date
       AND date <= $3::date`,
    [store, monthStart, date]
  );
  return Number(result.rows[0]?.total || 0);
}

/**
 * 获取马己仙店长某日例会（agent_messages.meeting_report）
 */
async function getMajixianMeetingReport(store, date) {
  const ev = await getMajixianMeetingDayEval(store, date);
  return {
    submitted: ev.submitted,
    score: ev.score,
    qualified: ev.qualified
  };
}

/** 同一门店同岗位多人绑定时选 canonical（马己仙出品经理优先黎永荣/NNYXLYR04，压低 nnyxcs35） */
function collapseExecutionRatingStaff(rows) {
  const m = new Map();
  for (const row of rows) {
    const key = `${String(row.store || '').trim()}||${row.role}`;
    const prev = m.get(key);
    if (!prev) {
      m.set(key, row);
      continue;
    }
    if (row.role === 'store_production_manager' && /马己仙/.test(String(row.store || ''))) {
      const [best] = sortFeishuScoringRows(row.store, 'store_production_manager', [
        { username: prev.username, disp: prev.name, name: prev.name },
        { username: row.username, disp: row.name, name: row.name }
      ]);
      m.set(key, best.username === row.username ? row : prev);
    } else {
      m.set(key, prev);
    }
  }
  return [...m.values()];
}

// ─────────────────────────────────────────────
// 2. 执行力评级判定
// ─────────────────────────────────────────────

/**
 * 出品经理执行力：开档/收档须各品牌档口齐 + 原料≥1；单日只备一条案，明细写入 executionDetailLines。
 * missing 字段直接记录缺失项目名（开档/收档/原料收货），而非固定文字，便于备案标题区分。
 */
function evaluatePMExecution(reports) {
  const lines = [];
  const missingItems = [];
  if (!reports.opening) {
    missingItems.push('开档');
    lines.push(
      reports.missingOpeningStations?.length
        ? `开档缺档口：${reports.missingOpeningStations.join('、')}`
        : '开档：档口未齐（无法识别档口或记录不足）'
    );
  }
  if (!reports.closing) {
    missingItems.push('收档');
    lines.push(
      reports.missingClosingStations?.length
        ? `收档缺档口：${reports.missingClosingStations.join('、')}`
        : '收档：档口未齐（无法识别档口或记录不足）'
    );
  }
  if (!reports.material) {
    missingItems.push('原料收货');
    lines.push(`原料收货：缺记录（统计 ${reports.materialCount ?? 0} 条，需≥1）`);
  }
  if (lines.length === 0) {
    return { rating: 'A', missing: [], executionDetailLines: [] };
  }
  return { rating: 'D', missing: missingItems, executionDetailLines: lines };
}

/**
 * 洪潮店长执行力评级
 * @param {number} wechatMembers - 今日新增企微会员数
 * @returns {{rating: string, value: number}}
 */
function evaluateHongchaoManager(wechatMembers) {
  // 洪潮店长：A≥400，B 349–399，C 300–348，其余 D（按当月累计至检查日）
  if (wechatMembers >= 400) return { rating: 'A', value: wechatMembers };
  if (wechatMembers >= 349) return { rating: 'B', value: wechatMembers };
  if (wechatMembers >= 300) return { rating: 'C', value: wechatMembers };
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
  const miss =
    meeting.score == null || !Number.isFinite(Number(meeting.score))
      ? '例会已提交但无有效得分'
      : `例会不合格（得分${meeting.score}分，低于7分合格线）`;
  return {
    rating: 'D',
    score: meeting.score,
    qualified: false,
    missing: miss
  };
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
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), $8::date, $9::jsonb, $10, $11, NOW())
       ON CONFLICT (dedupe_key) DO UPDATE SET
         title = EXCLUDED.title,
         status = EXCLUDED.status,
         evidence_urls = EXCLUDED.evidence_urls,
         biz_date = EXCLUDED.biz_date,
         updated_at = NOW()`,
      [
        store,
        'execution_rating_daily',
        `${store} · 执行力日评未达标（${missing.join('/')}）· ${date}`,
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
    logger.info({ store, username, role, date, rating, missing }, 'execution rating filed (upsert)');
  } catch (e) {
    logger.error({ err: e?.message, store, username }, 'execution rating filing failed');
  }
}

// ─────────────────────────────────────────────
// 4. 飞书通知
// ─────────────────────────────────────────────

/**
 * 构建执行力备案飞书卡片（含本月累计不合格次数）
 */
function buildFilingCard({ store, username, name, role, rating, missing, executionDetailLines }, date, monthlyCount) {
  const roleLabel = role === 'store_manager' ? '店长' : '出品经理';
  const ratingColor = rating === 'B' ? 'blue' : rating === 'C' ? 'orange' : 'red';
  const monthYm = String(date).slice(0, 7);

  let missingMd = '';
  if (executionDetailLines && executionDetailLines.length > 0) {
    missingMd = `\n**未达标项目**：${missing.join('/')}
**明细**\n${executionDetailLines.map((l) => `· ${l}`).join('\n')}`;
  } else if (missing && missing.length > 0) {
    missingMd = `\n**未达标项目**\n${missing.map((m) => `❌ ${m}`).join('\n')}`;
  }

  const content = `**备案类型**：工作执行力备案（本次第 **${monthlyCount}** 次）
**门店**：${store}
**岗位**：${roleLabel} · ${name || username}
**业务日期**：${date}
**本月累计不合格次数**：**${monthlyCount}** 次（${monthYm}）${missingMd}`;

  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: `📋 工作执行力备案 · 本月第${monthlyCount}次 · ${date}` },
      template: ratingColor
    },
    elements: [
      { tag: 'div', text: { tag: 'lark_md', content } },
      { tag: 'note', elements: [{ tag: 'plain_text', content: `检查业务日：${date}（上海昨日）· agent_messages 飞书同步 · 每日08:00` }] }
    ]
  };
}

/**
 * 构建执行力备案汇总卡片（管理员/总部营运，含本月累计次数）
 */
function buildAdminFilingCard(results, date) {
  const failedResults = results.filter(r => r.rating !== 'A');
  const monthYm = String(date).slice(0, 7);

  let md = `**业务日期**：${date}\n**本次备案人数**：${failedResults.length}\n`;

  if (failedResults.length > 0) {
    md += `\n**备案明细**（含本月累计次数）\n`;
    for (const r of failedResults) {
      const roleLabel = r.role === 'store_manager' ? '店长' : '出品经理';
      const missItems = r.missing && r.missing.length > 0 ? r.missing.join('/') : '';
      const detailExtra =
        r.executionDetailLines && r.executionDetailLines.length > 0
          ? `\n  └ ${r.executionDetailLines.join('；')}`
          : '';
      const monthCount = r.monthlyFilingCount != null ? r.monthlyFilingCount : '—';
      md += `\n• **${r.store}** · ${roleLabel} ${r.name || r.username}：${missItems ? `未达标（${missItems}）` : '未达标'} | 本月累计 **${monthCount}** 次${detailExtra}`;
    }
  } else {
    md += `\n✅ 全部达标，无需备案`;
  }

  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: `📋 工作执行力备案汇总 · ${monthYm} 月累计` },
      template: 'blue'
    },
    elements: [
      { tag: 'div', text: { tag: 'lark_md', content: md } },
      { tag: 'note', elements: [{ tag: 'plain_text', content: `检查业务日：${date}（上海昨日）；洪潮店长企微项仅月评，不列入日频备案` }] }
    ]
  };
}

/**
 * 发送执行力备案通知（飞书卡片 + HRMS公司通知）
 * 通知内容含：本次为本月第N次备案 + 本月累计不合格次数
 */
async function sendExecutionRatingNotifications(results, date) {
  const failedResults = results.filter(r => r.rating !== 'A');
  let sentCount = 0;
  let failedCount = 0;
  const runYmd = getShanghaiYmd();
  const monthYm = String(date).slice(0, 7);

  // 1. 查询每位未达标人员的本月累计次数，挂到结果上
  for (const r of failedResults) {
    r.monthlyFilingCount = await getMonthlyExecutionFilingCount(r.username, r.store, date);
  }

  // 2. 发备案通知给未达标人员（飞书卡片 + HRMS通知）
  for (const r of failedResults) {
    const monthlyCount = r.monthlyFilingCount ?? 1;
    const card = buildFilingCard(r, date, monthlyCount);
    const roleLabel = r.role === 'store_manager' ? '店长' : '出品经理';
    const missingText = r.missing && r.missing.length > 0 ? r.missing.join('/') : '';
    const detailText =
      r.executionDetailLines && r.executionDetailLines.length > 0
        ? r.executionDetailLines.join('；')
        : '';

    // 飞书卡片（无 open_id 则无法发飞书，但 HRMS 公司通知仍应写入）
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
          logger.info({ recipient: r.username, store: r.store, monthlyCount }, 'execution filing card sent to individual');
        } else if (!deliver?.ok) {
          failedCount++;
          logger.warn({ recipient: r.username, store: r.store, err: deliver?.error }, 'execution filing card send failed after retries');
        }
      } catch (e) {
        failedCount++;
        logger.warn({ err: e?.message, recipient: r.username }, 'execution filing card send failed');
      }
    } else {
      logger.warn({ recipient: r.username, store: r.store }, 'execution filing: feishu_users.open_id empty, skip individual Feishu card');
    }

    // HRMS 公司通知（无唯一约束，手动去重）
    try {
      const metaPayload = JSON.stringify({
        date,
        rating: r.rating,
        missing: r.missing,
        store: r.store,
        role: r.role,
        monthly_filing_count: monthlyCount
      });
      const dup = await query(
        `SELECT 1 FROM hrms_user_notifications
         WHERE lower(trim(target_username)) = lower(trim($1))
           AND type = 'execution_rating_daily'
           AND (meta->>'date') = $2
           AND (meta->>'store') = $3
         LIMIT 1`,
        [r.username, date, String(r.store || '')]
      );
      if (!dup.rows?.length) {
        const hrmsMsg = [
          `【工作执行力备案】本月第 ${monthlyCount} 次`,
          `门店：${r.store}`,
          `岗位：${roleLabel} · ${r.name || r.username}`,
          `业务日期：${date}`,
          `未达标项目：${missingText || '—'}`,
          detailText ? `明细：${detailText}` : '',
          `本月（${monthYm}）累计不合格次数：${monthlyCount} 次`
        ].filter(Boolean).join('\n');
        await query(
          `INSERT INTO hrms_user_notifications (target_username, title, message, type, meta)
           VALUES ($1, $2, $3, $4, $5::jsonb)`,
          [
            r.username,
            `工作执行力备案（本月第${monthlyCount}次）`,
            hrmsMsg,
            'execution_rating_daily',
            metaPayload
          ]
        );
        logger.info({ recipient: r.username, store: r.store, monthlyCount }, 'execution filing hrms notification inserted');
      } else {
        logger.info({ recipient: r.username, store: r.store, date }, 'execution filing hrms notification deduped');
      }
    } catch (e) {
      logger.warn({ err: e?.message, recipient: r.username }, 'execution filing hrms notification failed');
    }
  }

  // 3. 发备案汇总通知给管理员和总部营运（含所有未达标人员及本月累计次数）
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
    logger.error(
      { failedCount, sentCount, date },
      'daily execution rating: partial Feishu delivery failure (备案与 ops_tasks 仍可能已成功，不因个别收件人失败而整任务报错)'
    );
    void notifyAdminsDataIssue({
      alertType: 'execution_rating_feishu_partial_fail',
      priority: 'B',
      title: '执行力日评：飞书卡片部分发送失败（备案与公司通知可能已写入）',
      lines: [
        `业务日期：${date}`,
        `失败次数：${failedCount}（含个人备案卡片或管理员汇总卡片）`,
        '请检查：表「feishu_users」中是否已配置飞书 open_id；飞书接口是否限流；网络是否异常。若仅缺少 open_id，责任人可能收不到飞书卡片，但 HRMS 公司通知一般仍会写入。'
      ],
      dedupeKey: `exec_rate_feishu_fail_${date}`,
      dedupeHours: 6
    }).catch(() => {});
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

    const staffResult = await query(
      `SELECT fu.username, fu.name, fu.open_id, fu.role, fu.store,
              CASE
                WHEN fu.store ILIKE '%洪潮%' THEN '洪潮'
                WHEN fu.store ILIKE '%马己仙%' THEN '马己仙'
                ELSE '未知'
              END AS brand
       FROM feishu_users fu
       WHERE fu.registered = true
         AND fu.role IN ('store_manager', 'store_production_manager')
         AND fu.store IS NOT NULL AND fu.store != ''
       ORDER BY fu.store, fu.role, fu.updated_at DESC NULLS LAST, fu.username`
    );

    const staff = collapseExecutionRatingStaff(staffResult.rows || []);
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
          const reports = await getPMReportStatus(store, brand, date);
          const eval_ = evaluatePMExecution(reports);
          rating = eval_.rating;
          missing = eval_.missing;
          const executionDetailLines = eval_.executionDetailLines || [];
          detail = {
            opening: reports.opening,
            closing: reports.closing,
            material: reports.material,
            materialCount: reports.materialCount,
            missingOpeningStations: reports.missingOpeningStations,
            missingClosingStations: reports.missingClosingStations,
            executionDetailLines
          };

          if (rating !== 'A') {
            await recordExecutionFiling({ store, username, role, date, rating, missing, detail });
          }
          results.push({
            username,
            name,
            open_id,
            role,
            store,
            brand,
            date,
            rating,
            missing,
            executionDetailLines,
            detail
          });
          continue;
        } else if (role === 'store_manager') {
          if (brand === '洪潮') {
            // 企微为月累计 / 周频考核口径，不参与日频执行力备案（避免与日卡片「企微不足」混淆）
            rating = 'A';
            missing = [];
            detail = { hongchaoWechatDailySkipped: true };
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

      results.push({
        username,
        name,
        open_id,
        role,
        store,
        brand,
        date,
        rating,
        missing,
        executionDetailLines: undefined,
        detail
      });
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
