import { query } from '../utils/db.js';
import { logger } from '../utils/logger.js';
import { pushDailyReport } from './feishu-client.js';

function cleanText(value, max = 255) {
  return String(value == null ? '' : value).trim().slice(0, max);
}

//
// 5.9: 活动结束自动复盘
// 检测已结束的活动（超过 planned_end 且尚未复盘），汇总指标写入案例库
//
async function detectEndedCampaigns() {
  return query(
    `SELECT cp.plan_id, cp.campaign_id, cp.store_id, cp.title, cp.channel,
            cp.planned_end, cp.created_at,
            COALESCE(c.name, cp.title, cp.campaign_id) AS campaign_name
     FROM growth_campaign_plans cp
     LEFT JOIN growth_campaigns c ON c.campaign_id = cp.campaign_id
     WHERE cp.planned_end IS NOT NULL
       AND cp.planned_end < NOW()
       AND cp.status NOT IN ('reviewed', 'closed')
     ORDER BY cp.planned_end DESC
     LIMIT 30`
  );
}

function summarizeMetrics(events) {
  const summary = { scan: 0, auth: 0, claimed: 0, purchased: 0, redeemed: 0, payment: 0, revenue_fen: 0 };
  for (const row of (events.rows || [])) {
    switch (row.event_type) {
      case 'campaign_scan': summary.scan += Number(row.count) || 0; break;
      case 'phone_authorized': summary.auth += Number(row.count) || 0; break;
      case 'coupon_claimed': summary.claimed += Number(row.count) || 0; break;
      case 'coupon_purchased':
      case 'marketing_triggered': summary.purchased += Number(row.count) || 0; break;
      case 'coupon_redeemed': summary.redeemed += Number(row.count) || 0; break;
      case 'payment_success': summary.payment += Number(row.count) || 0; break;
    }
  }
  // 从 daily_metrics 补充收入（更准确）
  return summary;
}

async function getRevenueFromMetrics(campaignId) {
  const r = await query(
    `SELECT COALESCE(SUM(revenue_fen), 0)::int AS total_revenue
     FROM growth_daily_metrics
     WHERE campaign_id = $1`,
    [campaignId]
  );
  return Number(r.rows?.[0]?.total_revenue || 0);
}

function buildReview(summary, totalRevenue) {
  summary.revenue_fen = totalRevenue;
  const authRate = summary.scan > 0 ? summary.auth / summary.scan : 0;
  const redeemRate = summary.claimed > 0 ? summary.redeemed / summary.claimed : 0;
  const roi = summary.revenue_fen > 0 && summary.scan > 0
    ? (summary.revenue_fen / 100) / Math.max(1, summary.scan)
    : 0;
  const costFen = summary.claimed * 1000; // rough estimate: each coupon costs ~10元

  return {
    scan_count: summary.scan,
    authorized_count: summary.auth,
    claimed_count: summary.claimed,
    redeemed_count: summary.redeemed,
    payment_count: summary.payment,
    revenue_fen: summary.revenue_fen,
    auth_rate: authRate,
    redeem_rate: redeemRate,
    roi_yuan_per_scan: roi,
    estimated_cost_fen: costFen,
    roi_ratio: costFen > 0 ? summary.revenue_fen / costFen : 0
  };
}

function generateConclusion(metrics, title) {
  const parts = [];
  if (metrics.redeemed_count > 0 && metrics.roi_ratio > 1.5) {
    parts.push('活动盈利表现良好');
    if (metrics.roi_yuan_per_scan > 2) parts.push('单次扫码贡献高');
  } else if (metrics.redeemed_count > 0 && metrics.roi_ratio > 0.5) {
    parts.push('活动收支基本平衡');
  } else if (metrics.scan_count > 20 && metrics.auth_rate < 0.15) {
    parts.push('扫码量大但授权转化率低，需优化落地页');
  } else if (metrics.scan_count > 10 && metrics.redeem_rate < 0.05) {
    parts.push('领券后核销率极低，建议检查券门槛');
  } else if (metrics.scan_count < 5) {
    parts.push('活动曝光不足，需加强推广');
  } else {
    parts.push('活动已结束');
  }
  return parts.join('，');
}

async function writeReview(campaign, summary, metrics) {
  const campaignId = campaign.campaign_id || campaign.plan_id || '';
  const storeId = cleanText(campaign.store_id, 128);
  const title = cleanText(campaign.title || campaign.campaign_name || campaignId, 300);

  // 更新 campaign plan 状态
  await query(
    `UPDATE growth_campaign_plans SET status = 'reviewed', updated_at = NOW()
     WHERE plan_id = $1`,
    [campaign.plan_id]
  );

  // 写入案例库
  const caseKey = `review:${campaignId}:${Date.now()}`;
  const conclusion = generateConclusion(metrics, title);
  const score = metrics.roi_ratio > 1.5 ? 80 : metrics.roi_ratio > 0.5 ? 60 : metrics.roi_ratio > 0 ? 40 : 20;
  const reusable = metrics.scan_count >= 20 && metrics.roi_ratio > 1.0;

  await query(
    `INSERT INTO marketing_case_library (case_key, store_id, campaign_id, title, objective, channel, audience, metrics, conclusion, reusable, score)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11)
     ON CONFLICT (case_key) DO UPDATE SET score = EXCLUDED.score, conclusion = EXCLUDED.conclusion, reusable = EXCLUDED.reusable, updated_at = NOW()`,
    [caseKey, storeId, campaignId, title, '活动自动复盘', cleanText(campaign.channel, 80), 'all',
     JSON.stringify(metrics), conclusion, reusable, Math.min(100, Math.max(0, score))]
  );

  return { caseKey, conclusion, score, reusable };
}

export async function runCampaignReview() {
  logger.info('campaign review started');
  const ended = await detectEndedCampaigns();
  if (!ended.rows?.length) {
    logger.info('campaign review: no ended campaigns');
    return { ok: true, reviewed: 0 };
  }

  let reviewed = 0;
  const reports = [];

  for (const campaign of ended.rows) {
    const campaignId = campaign.campaign_id || campaign.plan_id || '';
    try {
      // 获取活动事件汇总
      const events = await query(
        `SELECT event_type, COUNT(*)::int AS count
         FROM growth_events
         WHERE campaign_id = $1
         GROUP BY event_type`,
        [campaignId]
      );
      const summary = summarizeMetrics(events);
      const totalRevenue = await getRevenueFromMetrics(campaignId);
      const metrics = buildReview(summary, totalRevenue);

      const result = await writeReview(campaign, summary, metrics);
      reviewed++;
      reports.push({
        campaign_id: campaignId,
        title: campaign.title || campaignId,
        metrics,
        conclusion: result.conclusion,
        score: result.score,
        reusable: result.reusable
      });

      logger.info({ campaign_id: campaignId, score: result.score }, 'campaign reviewed');
    } catch (e) {
      logger.warn({ err: e?.message, campaign_id: campaignId }, 'campaign review failed');
    }
  }

  // 推送到飞书
  if (reports.length > 0) {
    const lines = reports.map(r =>
      `📋 ${r.title.slice(0, 30)}: 扫码${r.metrics.scan_count} 核销${r.metrics.redeemed_count} 收入¥${(r.metrics.revenue_fen/100).toFixed(0)} ROI${r.metrics.roi_ratio.toFixed(2)} → ${r.conclusion}`
    );
    const report = `📊 活动复盘报告 (${new Date().toISOString().slice(0, 10)})\n${lines.join('\n')}`;
    pushDailyReport(report).catch(e => logger.warn({ err: e?.message }, 'campaign review report push failed'));
  }

  logger.info({ reviewed, total: ended.rows.length }, 'campaign review completed');
  return { ok: true, reviewed, total: ended.rows.length, reports };
}
