import { query } from '../utils/db.js';
import { logger } from '../utils/logger.js';
import { createUnifiedTask } from './task-orchestrator.js';
import { pushGrowthAlert, pushGrowthTaskCard, pushDailyReport } from './feishu-client.js';

function rate(numerator, denominator) {
  const n = Number(numerator) || 0;
  const d = Number(denominator) || 0;
  return d > 0 ? n / d : 0;
}

function pct(value) {
  return `${Math.round(value * 100)}%`;
}

async function recomputeGrowthMetrics(days = 8) {
  await query(
    `INSERT INTO growth_daily_metrics (
       metric_date, store_id, campaign_id, channel,
       scan_count, authorized_count, coupon_issued_count, coupon_redeemed_count, payment_count, revenue_fen, roi, updated_at
     )
     SELECT
       occurred_at::date AS metric_date,
       COALESCE(store_id, '') AS store_id,
       COALESCE(campaign_id, '') AS campaign_id,
       COALESCE(channel, '') AS channel,
       COUNT(*) FILTER (WHERE event_type = 'campaign_scan')::int AS scan_count,
       COUNT(*) FILTER (WHERE event_type = 'phone_authorized')::int AS authorized_count,
       COUNT(*) FILTER (WHERE event_type IN ('coupon_claimed','coupon_purchased','marketing_triggered'))::int AS coupon_issued_count,
       COUNT(*) FILTER (WHERE event_type = 'coupon_redeemed')::int AS coupon_redeemed_count,
       COUNT(*) FILTER (WHERE event_type = 'payment_success')::int AS payment_count,
        COALESCE(SUM(amount_fen) FILTER (WHERE event_type IN ('payment_success','coupon_redeemed')), 0)::int AS revenue_fen,
        CASE WHEN COUNT(*) FILTER (WHERE event_type = 'campaign_scan') > 0
          THEN ROUND(COALESCE(SUM(amount_fen) FILTER (WHERE event_type IN ('payment_success','coupon_redeemed')), 0)::numeric / COUNT(*) FILTER (WHERE event_type = 'campaign_scan'), 4)
          ELSE NULL END AS roi,
        NOW()
     FROM growth_events
     WHERE occurred_at >= CURRENT_DATE - ($1::int || ' days')::interval
     GROUP BY 1,2,3,4
     ON CONFLICT (metric_date, store_id, campaign_id, channel)
     DO UPDATE SET
       scan_count = EXCLUDED.scan_count,
       authorized_count = EXCLUDED.authorized_count,
       coupon_issued_count = EXCLUDED.coupon_issued_count,
       coupon_redeemed_count = EXCLUDED.coupon_redeemed_count,
       payment_count = EXCLUDED.payment_count,
        revenue_fen = EXCLUDED.revenue_fen,
        roi = EXCLUDED.roi,
        updated_at = NOW()`,
    [days]
  );
}

async function upsertAlert(alert) {
  const r = await query(
    `INSERT INTO growth_alerts (alert_key, alert_type, severity, store_id, campaign_id, title, message, suggested_action, metrics)
     VALUES ($1,$2,$3,NULLIF($4,''),NULLIF($5,''),$6,$7,$8,$9::jsonb)
     ON CONFLICT (alert_key) DO UPDATE SET
       severity = EXCLUDED.severity,
       title = EXCLUDED.title,
       message = EXCLUDED.message,
       suggested_action = EXCLUDED.suggested_action,
       metrics = EXCLUDED.metrics,
       status = CASE WHEN growth_alerts.status = 'resolved' THEN 'open' ELSE growth_alerts.status END,
       updated_at = NOW()
     RETURNING *`,
    [
      alert.key,
      alert.type,
      alert.severity,
      alert.storeId || '',
      alert.campaignId || '',
      alert.title,
      alert.message,
      alert.suggestedAction,
      JSON.stringify(alert.metrics || {})
    ]
  );
  return r.rows[0];
}

async function upsertAction(alert) {
  const actionKey = `action:${alert.key}`;
  const r = await query(
    `INSERT INTO growth_actions (action_key, action_type, status, store_id, campaign_id, title, detail, payload, created_by)
     VALUES ($1,$2,'proposed',NULLIF($3,''),NULLIF($4,''),$5,$6,$7::jsonb,'agent_v2')
     ON CONFLICT (action_key) DO UPDATE SET
       title = EXCLUDED.title,
       detail = EXCLUDED.detail,
       payload = EXCLUDED.payload,
       updated_at = NOW()
     RETURNING *`,
    [
      actionKey,
      alert.type,
      alert.storeId || '',
      alert.campaignId || '',
      alert.suggestedAction,
      alert.message,
      JSON.stringify({ alert_key: alert.key, metrics: alert.metrics || {} })
    ]
  );
  return r.rows[0];
}

async function createGrowthTask(alert) {
  const taskId = `GROWTH-${alert.key}`.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 120);
  return createUnifiedTask({
    taskId,
    source: 'growth_monitor',
    category: 'marketing_growth',
    severity: alert.severity,
    store: alert.storeId || null,
    title: alert.title,
    detail: `${alert.message}\n建议动作：${alert.suggestedAction}`,
    sourceData: { alert_key: alert.key, campaign_id: alert.campaignId || null, metrics: alert.metrics || {} },
    assigneeAgent: 'strategy_agent',
    timeoutHours: alert.severity === 'high' ? 24 : 48,
    createdFrom: 'growth_monitor'
  });
}

function buildAlerts(rows) {
  const alerts = [];
  for (const row of rows) {
    const storeId = row.store_id || '';
    const campaignId = row.campaign_id || '';
    const channel = row.channel || '';
    const scanCount = Number(row.scan_count) || 0;
    const authorizedCount = Number(row.authorized_count) || 0;
    const issuedCount = Number(row.coupon_issued_count) || 0;
    const redeemedCount = Number(row.coupon_redeemed_count) || 0;
    const paymentCount = Number(row.payment_count) || 0;
    const revenueFen = Number(row.revenue_fen) || 0;
    const authRate = rate(authorizedCount, scanCount);
    const redemptionRate = rate(redeemedCount, issuedCount);
    const keyBase = `${storeId || 'all'}:${campaignId || 'unknown'}:${channel || 'all'}`;
    const metrics = { scanCount, authorizedCount, issuedCount, redeemedCount, paymentCount, revenueFen, authRate, redemptionRate };

    if (scanCount >= 10 && scanCount < 20) {
      alerts.push({
        key: `low_scan:${keyBase}`,
        type: 'low_scan',
        severity: 'medium',
        storeId,
        campaignId,
        title: `活动曝光不足：${campaignId || channel || storeId || '未命名活动'}`,
        message: `近7天仅扫码${scanCount}次，活动流量偏低。`,
        suggestedAction: '检查二维码铺设位置、员工引导动作、公众号/朋友圈推广是否到位；必要时增加线上曝光渠道。',
        metrics
      });
    }

    if (scanCount >= 20 && authRate < 0.3) {
      alerts.push({
        key: `low_authorization:${keyBase}`,
        type: 'low_authorization',
        severity: authRate < 0.15 ? 'high' : 'medium',
        storeId,
        campaignId,
        title: `活动授权率偏低：${campaignId || channel || storeId || '未命名活动'}`,
        message: `近7天扫码${scanCount}次，手机号授权${authorizedCount}次，授权率${pct(authRate)}。`,
        suggestedAction: '检查落地页首屏利益点、授权文案和券领取路径；优先做A/B文案或门店引导话术调整。',
        metrics
      });
    }

    if (issuedCount >= 10 && redemptionRate < 0.08) {
      alerts.push({
        key: `low_redemption:${keyBase}`,
        type: 'low_redemption',
        severity: redemptionRate < 0.03 ? 'high' : 'medium',
        storeId,
        campaignId,
        title: `优惠券核销率偏低：${campaignId || channel || storeId || '未命名活动'}`,
        message: `近7天发券${issuedCount}张，核销${redeemedCount}张，核销率${pct(redemptionRate)}。`,
        suggestedAction: '复查券门槛、有效期和员工提醒动作；必要时改为更清晰的到店权益或缩短核销提醒节奏。',
        metrics
      });
    }

    if (issuedCount >= 5 && scanCount >= 5) {
      const claimRate = issuedCount > 0 ? issuedCount / scanCount : 0;
      if (claimRate < 0.5) {
        alerts.push({
          key: `low_claim:${keyBase}`,
          type: 'low_claim',
          severity: claimRate < 0.2 ? 'high' : 'medium',
          storeId,
          campaignId,
          title: `领券率偏低：${campaignId || channel || storeId || '未命名活动'}`,
          message: `近7天扫码${scanCount}次，领券${issuedCount}张，领券率${pct(claimRate)}。授权后到领券环节流失严重。`,
          suggestedAction: '检查券领取路径是否顺畅、权益是否吸引、是否有过多授权后跳转步骤。',
          metrics
        });
      }
    }

    if (scanCount >= 30 && paymentCount === 0 && redeemedCount === 0) {
      alerts.push({
        key: `no_conversion:${keyBase}`,
        type: 'no_conversion',
        severity: 'high',
        storeId,
        campaignId,
        title: `活动无转化：${campaignId || channel || storeId || '未命名活动'}`,
        message: `近7天已有扫码${scanCount}次，但支付和核销均为0。`,
        suggestedAction: '暂停加大投放，先核查二维码场景、券领取链路、收银核销培训和活动利益点是否匹配。',
        metrics
      });
    }

    if (scanCount >= 10 && scanCount < 20 && authRate > 0.3 && redemptionRate > 0.08 && paymentCount > 0) {
      alerts.push({
        key: `high_potential:${keyBase}`,
        type: 'high_potential',
        severity: 'medium',
        storeId,
        campaignId,
        title: `高潜活动：${campaignId || channel || storeId || '未命名活动'}`,
        message: `近7天扫码${scanCount}次，授权率${pct(authRate)}，核销率${pct(redemptionRate)}，支付${paymentCount}笔。各项指标健康但流量不足。`,
        suggestedAction: '考虑加投或复制该活动配置到其他门店，流量有提升空间。',
        metrics
      });
    }

    if (revenueFen > 5000 && scanCount >= 10) {
      alerts.push({
        key: `roi_positive:${keyBase}`,
        type: 'roi_positive',
        severity: 'low',
        storeId,
        campaignId,
        title: `活动ROI为正：${campaignId || channel || storeId || '未命名活动'}`,
        message: `近7天收入${(revenueFen / 100).toFixed(2)}元，扫码${scanCount}次，支付${paymentCount}笔，核销${redeemedCount}次。活动盈利中。`,
        suggestedAction: '继续监测，考虑加大投放或延长活动周期。',
        metrics
      });
    }

    if (revenueFen > 0 && scanCount >= 20 && revenueFen < 2000) {
      alerts.push({
        key: `roi_low:${keyBase}`,
        type: 'roi_low',
        severity: 'medium',
        storeId,
        campaignId,
        title: `活动ROI偏低：${campaignId || channel || storeId || '未命名活动'}`,
        message: `近7天收入仅${(revenueFen / 100).toFixed(2)}元，扫码${scanCount}次，人均贡献不足1元。`,
        suggestedAction: '检查券门槛、定价和活动权益是否匹配客群；考虑暂停低效投放并调整方案。',
        metrics
      });
    }
  }
  return alerts;
}

async function checkStoreNotExecuting() {
  const r = await query(
    `SELECT gc.campaign_id, gc.store_id, gc.channel
     FROM growth_campaigns gc
     WHERE gc.status = 'active'
       AND gc.created_at < NOW() - INTERVAL '24 hours'
       AND NOT EXISTS (
         SELECT 1 FROM growth_events ge
         WHERE ge.campaign_id = gc.campaign_id
           AND ge.occurred_at >= NOW() - INTERVAL '48 hours'
       )`
  );
  const alerts = [];
  for (const row of r.rows || []) {
    const storeId = row.store_id || '';
    const campaignId = row.campaign_id || '';
    const channel = row.channel || '';
    const keyBase = `${storeId || 'all'}:${campaignId || 'unknown'}:${channel || 'all'}`;
    alerts.push({
      key: `store_not_executing:${keyBase}`,
      type: 'store_not_executing',
      severity: 'medium',
      storeId,
      campaignId,
      title: `活动未执行：${campaignId || storeId || '未命名活动'}`,
      message: `活动"${campaignId}"已发布超过24小时，但近48小时无任何扫码或互动数据。门店可能未执行推广。`,
      suggestedAction: '联系门店确认是否已铺设二维码、是否在引导顾客扫码；必要时暂停活动或调整推广方案。',
      metrics: { campaignId, storeId, channel }
    });
  }
  return alerts;
}

export async function runGrowthMonitor({ createTasks = true } = {}) {
  await recomputeGrowthMetrics(8);
  try {
    const hrmsBase = process.env.HRMS_BASE_URL || 'http://127.0.0.1:3000';
    const hrmsSecret = process.env.HRMS_MONITOR_SECRET || process.env.MINIPROGRAM_SYNC_SECRET || '';
    if (hrmsSecret) {
      const resp = await fetch(hrmsBase.replace(/\/$/, '') + '/api/growth/customer-profiles/recompute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Miniprogram-Sync-Secret': hrmsSecret },
        body: JSON.stringify({ days: 90 })
      });
      if (!resp.ok) console.warn('[growth-monitor] profile recompute status:', resp.status);
    }
  } catch (e) {
    console.warn('[growth-monitor] profile recompute failed:', e?.message || e);
  }
  const r = await query(
    `SELECT
       store_id,
       campaign_id,
       channel,
       SUM(scan_count)::int AS scan_count,
       SUM(authorized_count)::int AS authorized_count,
       SUM(coupon_issued_count)::int AS coupon_issued_count,
       SUM(coupon_redeemed_count)::int AS coupon_redeemed_count,
       SUM(payment_count)::int AS payment_count,
       SUM(revenue_fen)::int AS revenue_fen
     FROM growth_daily_metrics
     WHERE metric_date >= CURRENT_DATE - INTERVAL '7 days'
       AND COALESCE(campaign_id, '') <> ''
     GROUP BY store_id, campaign_id, channel
     ORDER BY scan_count DESC
     LIMIT 200`
  );

  const alerts = buildAlerts(r.rows || []);
  const storeAlerts = await checkStoreNotExecuting();
  const allAlerts = [...alerts, ...storeAlerts];
  const results = [];
  for (const alert of allAlerts) {
    try {
      const savedAlert = await upsertAlert(alert);
      const action = await upsertAction(alert);
      let task = null;
      if (createTasks && alert.severity === 'high') {
        task = await createGrowthTask(alert).catch((e) => ({ ok: false, error: e?.message }));
      }
      if (alert.severity === 'high' || alert.severity === 'medium') {
        pushGrowthAlert(Object.assign({}, alert, { action_key: action?.action_key || `action:${alert.key}` }))
          .catch((e) => logger.warn({ err: e?.message, alertKey: alert.key }, 'growth alert push failed'));
      }
      if (task && task.ok !== false && alert.severity === 'high') {
        pushGrowthTaskCard(task, Object.assign({}, alert, { action_key: action?.action_key || `action:${alert.key}` }))
          .catch((e) => logger.warn({ err: e?.message, alertKey: alert.key }, 'growth task card push failed'));
      }
      results.push({ alert: savedAlert, action, task });
    } catch (e) {
      logger.warn({ err: e?.message, alertKey: alert.key }, 'growth alert upsert failed');
    }
  }

  // Phase 6: Repurchase critical period - auto detect at-risk users and create actions
  try {
    const storeIds = [...new Set((r.rows || []).map(r => r.store_id).filter(Boolean))];
    for (const sid of storeIds) {
      const atRisk = await query(
        `SELECT cp.customer_id, cp.phone, cp.lifecycle_stage, cp.response_to_discount
         FROM growth_customer_profiles cp
         WHERE cp.store_id = $1 AND cp.lifecycle_stage IN ('at_risk','churned') AND cp.phone IS NOT NULL
         LIMIT 30`,
        [sid]
      );
      if (atRisk.rows.length > 0) {
        const alertKey = `repurchase:${sid}:${new Date().toISOString().slice(0, 10)}`;
        await query(
          `INSERT INTO growth_alerts (alert_key, alert_type, severity, store_id, title, message, suggested_action, metrics)
           VALUES ($1,'repurchase_risk','medium',$2,$3,$4,$5,$6::jsonb)
           ON CONFLICT (alert_key) DO NOTHING`,
          [alertKey, sid,
           '复购临界客户提醒',
           `${atRisk.rows.length}位客户处于复购临界期（${atRisk.rows.filter(r=>r.lifecycle_stage==='churned').length}位已流失）`,
           '建议执行触达方案，发送优惠券或内容唤醒',
           JSON.stringify({ at_risk_count: atRisk.rows.length, store_id: sid })
        ]);
      }
    }
  } catch (e) {
    logger.warn({ err: e?.message }, 'repurchase trigger failed');
  }

  // Phase 2: Detect unbound WeChat customers and create alert
  try {
    const unboundCustomers = await query(
      `SELECT w.store_id, COUNT(*)::int AS unbound_count
       FROM wechat_work_customers w
       LEFT JOIN growth_customers g ON w.bind_customer_id = g.id
       WHERE w.bind_customer_id IS NULL
       GROUP BY w.store_id
       HAVING COUNT(*) >= 3`
    );
    for (const row of (unboundCustomers.rows || [])) {
      const alertKey = `wecom_unbound:${row.store_id}:${new Date().toISOString().slice(0, 10)}`;
      await query(
        `INSERT INTO growth_alerts (alert_key, alert_type, severity, store_id, title, message, suggested_action, metrics)
         VALUES ($1,'unbound_wecom','medium',$2,$3,$4,$5,$6::jsonb)
         ON CONFLICT (alert_key) DO NOTHING`,
        [alertKey, row.store_id,
         '企微客户未绑定',
         `${row.store_id}门店有${row.unbound_count}位企微客户尚未绑定小程序会员`,
         '建议引导企微客户扫码入会，推动手机号授权绑定',
         JSON.stringify({ unbound_count: row.unbound_count, store_id: row.store_id })
        ]
      );
    }
  } catch (e) {
    logger.warn({ err: e?.message }, 'wecom unbound detection failed');
  }

  // Phase 3: Daily diagnosis
  try {
    const dailyMetrics = await query(
      `SELECT store_id, campaign_id,
         SUM(scan_count)::int AS scans,
         SUM(authorized_count)::int AS auths,
         SUM(coupon_redeemed_count)::int AS redeems,
         SUM(revenue_fen)::int AS revenue
       FROM growth_daily_metrics
       WHERE metric_date >= CURRENT_DATE - 1
       GROUP BY store_id, campaign_id
       HAVING SUM(scan_count) > 0 OR SUM(authorized_count) > 0`
    );
    const diagnoses = [];
    for (const row of (dailyMetrics.rows || [])) {
      const storeId = row.store_id || '未指定';
      const scans = Number(row.scans) || 0;
      const auths = Number(row.auths) || 0;
      const authRate = scans > 0 ? Math.round(auths / scans * 100) : 0;
      if (scans >= 10 && authRate < 30) {
        diagnoses.push(`⚠️ ${storeId}: 授权率偏低(${authRate}%)，扫码${scans}次/授权${auths}次。建议优化授权入口文案或激励措施。`);
      }
      if (auths > 0 && authRate >= 50) {
        diagnoses.push(`✅ ${storeId}: 授权率良好(${authRate}%)。继续保持。`);
      }
    }
    if (diagnoses.length > 0) {
      const alertKey = `daily_diagnosis:${new Date().toISOString().slice(0, 10)}`;
      await query(
        `INSERT INTO growth_alerts (alert_key, alert_type, severity, title, message, suggested_action, metrics)
         VALUES ($1,'daily_diagnosis','low',$2,$3,$4,$5::jsonb)
         ON CONFLICT (alert_key) DO NOTHING`,
        [alertKey,
         '每日私域诊断',
         diagnoses.join('\n'),
         '参考以上诊断调整运营策略',
         JSON.stringify({ diagnoses: diagnoses })
        ]
      );
    }
  } catch (e) {
    logger.warn({ err: e?.message }, 'daily diagnosis failed');
  }

  // Phase 3: Feishu daily report push
  try {
    const reportDate = new Date().toISOString().slice(0, 10);
    const storeMetrics = await query(
      `SELECT store_id,
         SUM(scan_count)::int AS scans,
         SUM(authorized_count)::int AS auths,
         SUM(coupon_issued_count)::int AS issued,
         SUM(coupon_redeemed_count)::int AS redeems,
         SUM(revenue_fen)::int AS revenue
       FROM growth_daily_metrics
       WHERE metric_date >= CURRENT_DATE - 7
         AND COALESCE(store_id, '') != ''
       GROUP BY store_id
       ORDER BY scans DESC LIMIT 20`
    );
    if (storeMetrics.rows?.length) {
      const reportLines = storeMetrics.rows.map(r =>
        `📊 ${r.store_id}: 扫码${r.scans} 授权${r.auths} 核销${r.redeems} 收入¥${(Number(r.revenue)/100).toFixed(0)}`
      ).join('\n');
      const report = `📈 门店私域日报 (${reportDate})\n${reportLines}`;
      pushDailyReport(report).catch(e => logger.warn({ err: e?.message }, 'daily report push failed'));
    }
  } catch (e) {
    logger.warn({ err: e?.message }, 'daily report failed');
  }

  // Phase 2: WeChat customers auto-sync from Feishu Bitable
  try {
    const feishuConfig = await query(
      `SELECT data FROM hrms_state WHERE key = 'growth_feishu_config' LIMIT 1`
    );
    const config = feishuConfig.rows?.[0]?.data;
    if (config && config.app_token && config.table_id) {
      const hrmsBase = process.env.HRMS_BASE_URL || 'http://127.0.0.1:3000';
      const hrmsSecret = process.env.HRMS_MONITOR_SECRET || process.env.MINIPROGRAM_SYNC_SECRET || '';
      if (hrmsSecret) {
        const resp = await fetch(hrmsBase.replace(/\/$/, '') + '/api/growth/wechat-work/import-feishu', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Miniprogram-Sync-Secret': hrmsSecret },
          body: JSON.stringify({ app_token: config.app_token, table_id: config.table_id })
        });
        if (resp.ok) {
          const result = await resp.json();
          if (result.imported > 0) logger.info({ imported: result.imported, matched: result.matched }, 'Feishu WeChat sync completed');
        }
      }
    }
  } catch (e) {
    logger.warn({ err: e?.message }, 'feishu wechat sync failed');
  }

  logger.info({ checked: r.rows?.length || 0, alerts: results.length }, 'growth monitor completed');
  return { ok: true, checked: r.rows?.length || 0, alerts: results.length, results };
}
