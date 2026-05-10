import { query } from '../utils/db.js';

export async function buildGrowthMetricsContext(storeId) {
  const storeClause = storeId ? 'AND store_id = $2' : '';
  const params = [7];
  if (storeId) params.push(storeId);

  const r = await query(
    `SELECT store_id, campaign_id, channel,
            SUM(scan_count)::int AS scan_count,
            SUM(authorized_count)::int AS authorized_count,
            SUM(coupon_issued_count)::int AS issued_count,
            SUM(coupon_redeemed_count)::int AS redeemed_count,
            SUM(payment_count)::int AS payment_count,
            SUM(revenue_fen)::int AS revenue_fen
     FROM growth_daily_metrics
     WHERE metric_date >= CURRENT_DATE - ($1::int || ' days')::interval
       ${storeClause}
     GROUP BY store_id, campaign_id, channel
     ORDER BY scan_count DESC
     LIMIT 20`,
    params
  );

  if (!r.rows.length) return '暂无增长数据。';

  const lines = r.rows.map((row, i) => {
    const scan = Number(row.scan_count) || 0;
    const auth = Number(row.authorized_count) || 0;
    const issued = Number(row.issued_count) || 0;
    const redeem = Number(row.redeemed_count) || 0;
    const revenue = Number(row.revenue_fen) || 0;
    const authRate = scan > 0 ? `${Math.round(auth / scan * 100)}%` : '-';
    const redeemRate = issued > 0 ? `${Math.round(redeem / issued * 100)}%` : '-';
    return `${i + 1}. 门店${row.store_id || '-'} 活动${row.campaign_id || '-'} | 扫码${scan} | 授权${auth}(${authRate}) | 发券${issued} | 核销${redeem}(${redeemRate}) | 支付${row.payment_count || 0} | 收入¥${(revenue / 100).toFixed(2)}`;
  });

  return `【近7天增长数据概览】\n${lines.join('\n')}`;
}

export async function buildGrowthAlertContext(storeId) {
  const storeClause = storeId ? 'AND store_id = $2' : '';
  const params = [];
  if (storeId) params.push(storeId);

  const r = await query(
    `SELECT alert_type, severity, title, message, suggested_action, created_at
     FROM growth_alerts
     WHERE status = 'open'
       ${storeClause}
     ORDER BY created_at DESC
     LIMIT 10`,
    params
  );

  if (!r.rows.length) return '暂无待处理增长告警。';

  const lines = r.rows.map((a, i) => {
    const emoji = a.severity === 'high' ? '🚨' : a.severity === 'medium' ? '⚠️' : 'ℹ️';
    return `${i + 1}. ${emoji}[${a.severity}] ${a.title}：${(a.message || '').slice(0, 80)}`;
  });

  return `【待处理增长告警】\n${lines.join('\n')}`;
}

export async function buildGrowthCaseContext(storeId, channel) {
  const storeClause = storeId ? 'AND (store_id = $1 OR $1 = \'\')' : '';
  const channelClause = channel ? 'AND (channel ILIKE $2 OR $2 = \'\')' : '';
  const params = [storeId || '', channel || ''];
  const r = await query(
    `SELECT title, objective, channel, offer, score, conclusion, reusable, audience
     FROM marketing_case_library
     WHERE 1=1 ${storeClause} ${channelClause}
     ORDER BY score DESC, created_at DESC
     LIMIT 15`,
    params
  );
  if (!r.rows.length) return '暂无营销案例。';
  const lines = r.rows.map((c, i) => {
    return `${i + 1}. [评分${c.score || 0}] ${c.title} | 渠道:${c.channel || '-'} | offer:${c.offer || '-'} | 客群:${c.audience || '-'} | ${c.reusable ? '可复用' : '参考'}`;
  });
  return `【营销案例库参考】\n${lines.join('\n')}`;
}

export async function buildStoreProfileContext(storeId) {
  if (!storeId) return '';
  const r = await query(
    `SELECT brand, avg_ticket_fen, primary_audience, signature_dishes, peak_hours,
            gross_margin_floor, suitable_offers, unsuitable_offers, best_campaigns, worst_campaigns
     FROM store_marketing_profiles WHERE store_id = $1 LIMIT 1`,
    [storeId]
  );
  if (!r.rows.length) return '';
  const p = r.rows[0];
  const lines = [];
  if (p.brand) lines.push(`品牌：${p.brand}`);
  if (p.avg_ticket_fen) lines.push(`客单价：¥${(p.avg_ticket_fen / 100).toFixed(2)}`);
  if (p.primary_audience) lines.push(`主力客群：${p.primary_audience}`);
  if (p.gross_margin_floor != null) lines.push(`毛利底线：${p.gross_margin_floor}%`);
  if (p.suitable_offers?.length) lines.push(`适合券类型：${p.suitable_offers.join('、')}`);
  if (p.unsuitable_offers?.length) lines.push(`不适合活动：${p.unsuitable_offers.join('、')}`);
  if (p.best_campaigns?.length) lines.push(`历史最佳：${p.best_campaigns.slice(0, 3).join('、')}`);
  if (p.worst_campaigns?.length) lines.push(`历史最差：${p.worst_campaigns.slice(0, 3).join('、')}`);
  return `【门店画像】\n${lines.join('\n')}`;
}

export async function buildStoreConstraintContext(storeId) {
  if (!storeId) return '';
  const r = await query(
    `SELECT min_discount_rate, max_coupon_value_fen, monthly_budget_fen,
            max_touch_per_72h, cooldown_hours_after_payment, allowed_channels,
            disallowed_campaign_types, disallowed_dishes, preferred_channels,
            brand_voice_style, execution_notes
     FROM store_marketing_constraints
     WHERE store_id = $1 AND active = TRUE
     LIMIT 1`,
    [storeId]
  );
  if (!r.rows.length) return '';
  const c = r.rows[0];
  const lines = [];
  if (c.min_discount_rate != null) lines.push(`最低折扣：${Math.round(Number(c.min_discount_rate) * 100)}%`);
  if (c.max_coupon_value_fen != null) lines.push(`最大券面值：¥${(Number(c.max_coupon_value_fen) / 100).toFixed(2)}`);
  if (c.monthly_budget_fen != null) lines.push(`月营销预算：¥${(Number(c.monthly_budget_fen) / 100).toFixed(2)}`);
  if (c.max_touch_per_72h != null) lines.push(`72小时最大触达：${c.max_touch_per_72h}次`);
  if (c.cooldown_hours_after_payment != null) lines.push(`支付后冷静期：${c.cooldown_hours_after_payment}小时`);
  if (c.allowed_channels?.length) lines.push(`允许渠道：${c.allowed_channels.join('、')}`);
  if (c.preferred_channels?.length) lines.push(`优先渠道：${c.preferred_channels.join('、')}`);
  if (c.disallowed_campaign_types?.length) lines.push(`禁用活动类型：${c.disallowed_campaign_types.join('、')}`);
  if (c.disallowed_dishes?.length) lines.push(`禁用菜品：${c.disallowed_dishes.join('、')}`);
  if (c.brand_voice_style) lines.push(`品牌语气：${c.brand_voice_style}`);
  if (c.execution_notes) lines.push(`执行备注：${c.execution_notes}`);
  return lines.length ? `【门店营销约束】\n${lines.join('\n')}` : '';
}

export function evaluateStrategyByProfile(strategy, profile) {
  if (!profile || !strategy) return { score: 70, issues: [] };
  const issues = [];
  let score = 70;
  if (profile.gross_margin_floor != null && strategy.estimated_margin != null) {
    if (strategy.estimated_margin < profile.gross_margin_floor) {
      score -= 20;
      issues.push(`预估毛利(${strategy.estimated_margin}%)低于门店毛利底线(${profile.gross_margin_floor}%)`);
    }
  }
  if (profile.unsuitable_offers?.length && strategy.offer_type) {
    if (profile.unsuitable_offers.includes(strategy.offer_type)) {
      score -= 15;
      issues.push(`券类型"${strategy.offer_type}"在门店不适合活动列表中`);
    }
  }
  if (profile.avg_ticket_fen > 0 && strategy.amount_fen > 0) {
    if (strategy.amount_fen > profile.avg_ticket_fen * 0.5) {
      score -= 10;
      issues.push(`券面值(${Math.round(strategy.amount_fen / 100)}元)超过客单价50%`);
    }
  }
  return { score: Math.max(0, score), issues };
}
