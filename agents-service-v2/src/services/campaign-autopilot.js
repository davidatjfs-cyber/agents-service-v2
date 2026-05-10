import { query } from '../utils/db.js';
import { logger } from '../utils/logger.js';

function cleanText(value, max = 255) {
  return String(value == null ? '' : value).trim().slice(0, max);
}

//
// 5.2: 自动生成活动草稿
// 扫描门店特征，为有需求的门店建议活动方案
//
async function suggestCampaignDrafts() {
  const suggestions = [];

  // 1. 找出有大量新客户但未创建活动的门店
  const newCustomerStores = await query(
    `SELECT c.last_store_id AS store_id, COUNT(*)::int AS new_count
     FROM growth_customers c
     WHERE c.first_seen_at >= CURRENT_DATE - INTERVAL '14 days'
       AND c.last_store_id IS NOT NULL AND c.last_store_id <> ''
     GROUP BY c.last_store_id
     HAVING COUNT(*) >= 10
     ORDER BY new_count DESC
     LIMIT 20`
  );

  for (const row of (newCustomerStores.rows || [])) {
    const storeId = cleanText(row.store_id, 80);
    const newCount = Number(row.new_count) || 0;
    // 检查该门店近期是否有活跃活动
    const activeCampaigns = await query(
      `SELECT COUNT(*)::int AS cnt FROM growth_campaigns
       WHERE store_id = $1 AND status = 'active' AND created_at >= CURRENT_DATE - INTERVAL '30 days'`,
      [storeId]
    );
    if (Number(activeCampaigns.rows?.[0]?.cnt || 0) === 0) {
      suggestions.push({
        storeId,
        type: 'new_customer_campaign',
        priority: newCount >= 30 ? 'high' : 'medium',
        title: `新客增长活动 — ${storeId}`,
        detail: `近14天新增${newCount}位客户，门店暂无活跃活动，建议创建新客专享活动。`,
        payload: { new_customer_count: newCount, days: 14, target_audience: 'new' }
      });
    }
  }

  // 2. 找出有大量沉睡客户的门店
  const atRiskStores = await query(
    `SELECT store_id, COUNT(*)::int AS risk_count
     FROM growth_customer_profiles
     WHERE lifecycle_stage IN ('at_risk','churned')
       AND store_id IS NOT NULL AND store_id <> ''
     GROUP BY store_id
     HAVING COUNT(*) >= 20
     ORDER BY risk_count DESC
     LIMIT 20`
  );

  for (const row of (atRiskStores.rows || [])) {
    const storeId = cleanText(row.store_id, 80);
    const riskCount = Number(row.risk_count) || 0;
    // 检查该门店近期是否有召回活动
    const recentRecallActions = await query(
      `SELECT COUNT(*)::int AS cnt FROM growth_actions
       WHERE store_id = $1 AND action_type = 'send_voucher'
         AND title ILIKE '%召回%' AND created_at >= CURRENT_DATE - INTERVAL '30 days'`,
      [storeId]
    );
    if (Number(recentRecallActions.rows?.[0]?.cnt || 0) === 0) {
      suggestions.push({
        storeId,
        type: 'recall_campaign',
        priority: riskCount >= 50 ? 'high' : 'medium',
        title: `沉睡客户召回 — ${storeId}`,
        detail: `${riskCount}位客户处于${riskCount >= 50 ? '流失或' : ''}复购临界期，建议发送召回优惠券。`,
        payload: { at_risk_count: riskCount, target_audience: 'at_risk' }
      });
    }
  }

  // 3. 发现高潜活动模式（某活动ROI高但流量低 → 建议复制到其他门店）
  const highPotentialCampaigns = await query(
    `SELECT campaign_id, store_id, channel,
            SUM(scan_count)::int AS total_scans,
            SUM(revenue_fen)::int AS total_revenue
     FROM growth_daily_metrics
     WHERE metric_date >= CURRENT_DATE - INTERVAL '14 days'
       AND campaign_id IS NOT NULL AND campaign_id <> ''
       AND roi IS NOT NULL AND roi > 2.0
       AND revenue_fen > 5000
     GROUP BY campaign_id, store_id, channel
     HAVING SUM(scan_count) < 200
     ORDER BY MAX(roi) DESC
     LIMIT 10`
  );

  for (const row of (highPotentialCampaigns.rows || [])) {
    const campaignId = cleanText(row.campaign_id, 80);
    const storeId = cleanText(row.store_id, 80);
    const channel = cleanText(row.channel, 40);
    const roi = Number(row.roi) || 0;
    const revenue = Number(row.total_revenue) || 0;
    if (storeId) {
      suggestions.push({
        storeId,
        type: 'scale_campaign',
        priority: 'medium',
        title: `高潜活动复制 — ${storeId}`,
        detail: `活动"${campaignId}"在${storeId}门店ROI为${roi.toFixed(2)}、收入¥${(revenue/100).toFixed(0)}，但流量不足200次。建议复制到其他门店。`,
        payload: { source_campaign_id: campaignId, source_channel: channel, roi, revenue_fen: revenue }
      });
    }
  }

  return suggestions;
}

//
// 5.6: 低 ROI 活动建议关闭
// 持续多日 ROI 低于阈值的活动，建议暂停/关闭
//
async function suggestLowRoiClosure() {
  const suggestions = [];

  const lowRoiCampaigns = await query(
    `SELECT campaign_id, store_id, channel,
            COUNT(*)::int AS days_active,
            SUM(scan_count)::int AS total_scans,
            SUM(revenue_fen)::int AS total_revenue,
            ROUND(AVG(roi)::numeric, 4) AS avg_roi
     FROM growth_daily_metrics
     WHERE metric_date >= CURRENT_DATE - INTERVAL '7 days'
       AND campaign_id IS NOT NULL AND campaign_id <> ''
       AND roi IS NOT NULL AND roi < 0.5
       AND scan_count > 0
     GROUP BY campaign_id, store_id, channel
     HAVING COUNT(*) >= 3 AND SUM(revenue_fen) < 2000
     ORDER BY avg_roi ASC
     LIMIT 20`
  );

  for (const row of (lowRoiCampaigns.rows || [])) {
    const campaignId = cleanText(row.campaign_id, 80);
    const storeId = cleanText(row.store_id, 80);
    const daysActive = Number(row.days_active) || 0;
    const revenue = Number(row.total_revenue) || 0;
    const avgRoi = Number(row.avg_roi) || 0;

    suggestions.push({
      storeId,
      campaignId,
      type: 'close_low_roi',
      priority: avgRoi < 0.1 ? 'high' : 'medium',
      title: `低ROI活动建议关闭 — ${campaignId.slice(0, 30)}`,
      detail: `活动"${campaignId}"连续${daysActive}天ROI仅${avgRoi.toFixed(2)}，总收入¥${(revenue/100).toFixed(0)}。建议暂停并分析原因。`,
      payload: { campaign_id: campaignId, avg_roi: avgRoi, days_active: daysActive, total_revenue_fen: revenue }
    });
  }

  return suggestions;
}

async function writeActions(suggestions) {
  let written = 0;
  for (const s of suggestions) {
    const actionKey = `autopilot:${s.type}:${s.storeId || 'all'}:${Date.now()}`;
    try {
      const existing = await query(
        `SELECT id FROM growth_actions WHERE action_key = $1 LIMIT 1`, [actionKey]
      );
      if (existing.rows.length) continue;

      await query(
        `INSERT INTO growth_actions (action_key, action_type, status, store_id, campaign_id, title, detail, payload, created_by)
         VALUES ($1, $2, 'proposed', NULLIF($3,''), NULLIF($4,''), $5, $6, $7::jsonb, 'agent_v2')`,
        [actionKey, s.type, s.storeId || null, s.campaignId || null, s.title, s.detail,
         JSON.stringify(Object.assign({ priority: s.priority, autopilot: true }, s.payload || {}))]
      );
      written++;
    } catch (e) {
      logger.warn({ err: e?.message, actionKey }, 'campaign autopilot write failed');
    }
  }
  return written;
}

export async function runCampaignAutopilot() {
  logger.info('campaign autopilot started');
  const drafts = await suggestCampaignDrafts();
  const closures = await suggestLowRoiClosure();
  const all = [...drafts, ...closures];
  if (all.length === 0) {
    logger.info('campaign autopilot: no suggestions');
    return { ok: true, drafts: 0, closures: 0, total: 0 };
  }
  const written = await writeActions(all);
  logger.info({ drafts: drafts.length, closures: closures.length, written }, 'campaign autopilot completed');
  return { ok: true, drafts: drafts.length, closures: closures.length, total: all.length, written };
}
