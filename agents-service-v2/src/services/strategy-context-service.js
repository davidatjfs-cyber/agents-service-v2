import { query } from '../utils/db.js';
import { logger } from '../utils/logger.js';

function cleanText(value, max) {
  return String(value == null ? '' : value).trim().slice(0, max || 1000);
}

/**
 * Phase 7.3: 为 Agent 策略生成提供上下文
 * 给定门店、渠道、目标客群，检索案例库+门店画像+约束，组装成 prompt 上下文
 */
export async function getStrategyContext(storeId, channel, audience) {
  const ctx = { storeId, channel, audience, cases: [], profile: null, constraints: null };

  // 1. 检索门店画像
  if (storeId) {
    const p = await query(
      `SELECT * FROM store_marketing_profiles WHERE store_id = $1 LIMIT 1`, [storeId]
    );
    if (p.rows?.length) {
      const row = p.rows[0];
      ctx.profile = {
        brand: row.brand,
        avg_ticket_yuan: row.avg_ticket_fen ? (row.avg_ticket_fen / 100).toFixed(0) : null,
        primary_audience: row.primary_audience,
        signature_dishes: row.signature_dishes,
        peak_hours: row.peak_hours,
        gross_margin_floor: row.gross_margin_floor,
        suitable_offers: row.suitable_offers,
        unsuitable_offers: row.unsuitable_offers,
        best_campaigns: row.best_campaigns,
        worst_campaigns: row.worst_campaigns,
        execution_level: row.execution_level
      };
    }
  }

  // 2. 检索门店营销约束
  if (storeId) {
    const c = await query(
      `SELECT * FROM store_marketing_constraints WHERE store_id = $1 LIMIT 1`, [storeId]
    );
    if (c.rows?.length) {
      const row = c.rows[0];
      ctx.constraints = {
        min_discount_rate: row.min_discount_rate,
        max_coupon_value_yuan: row.max_coupon_value_fen ? (row.max_coupon_value_fen / 100).toFixed(0) : null,
        monthly_budget_yuan: row.monthly_budget_fen ? (row.monthly_budget_fen / 100).toFixed(0) : null,
        max_touch_per_72h: row.max_touch_per_72h,
        cooldown_hours: row.cooldown_hours_after_payment,
        allowed_channels: row.allowed_channels,
        disallowed_campaign_types: row.disallowed_campaign_types,
        preferred_channels: row.preferred_channels,
        brand_voice_style: row.brand_voice_style
      };
    }
  }

  // 3. 检索历史案例（高分的优先）
  const params = [];
  const conditions = [];
  let idx = 1;
  if (storeId) { conditions.push(`(store_id = $${idx} OR store_id IS NULL)`); params.push(storeId); idx++; }
  if (channel) { conditions.push(`(channel = $${idx} OR channel IS NULL OR channel = '')`); params.push(channel); idx++; }
  if (audience) { conditions.push(`(audience ILIKE $${idx} OR audience IS NULL OR audience = '')`); params.push(`%${audience}%`); idx++; }
  conditions.push(`score >= 40`);
  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
  const cases = await query(
    `SELECT title, objective, channel, audience, offer, copy_text, metrics, conclusion, score, reusable
     FROM marketing_case_library ${where}
     ORDER BY score DESC, created_at DESC
     LIMIT 8`,
    params
  );
  ctx.cases = (cases.rows || []).map(r => ({
    title: r.title,
    channel: r.channel,
    audience: r.audience,
    offer: r.offer,
    conclusion: r.conclusion,
    score: r.score,
    reusable: r.reusable,
    copy_snippet: r.copy_text ? r.copy_text.slice(0, 200) : null
  }));

  return ctx;
}

/**
 * 将上下文格式化为 LLM prompt 文本块
 */
export function formatContextForPrompt(ctx) {
  const parts = [];

  if (ctx.profile) {
    const p = ctx.profile;
    parts.push('## 门店画像');
    const lines = [];
    if (p.brand) lines.push(`品牌: ${p.brand}`);
    if (p.avg_ticket_yuan) lines.push(`客单价: ¥${p.avg_ticket_yuan}`);
    if (p.primary_audience) lines.push(`主力客群: ${p.primary_audience}`);
    if (p.signature_dishes?.length) lines.push(`招牌菜: ${p.signature_dishes.join(', ')}`);
    if (p.peak_hours?.length) lines.push(`高峰时段: ${p.peak_hours.join(', ')}`);
    if (p.gross_margin_floor) lines.push(`毛利底线: ${(p.gross_margin_floor * 100).toFixed(0)}%`);
    if (p.execution_level !== 'unknown' && p.execution_level) lines.push(`执行能力: ${p.execution_level}`);
    if (p.suitable_offers?.length) lines.push(`适合的券类型: ${p.suitable_offers.join(', ')}`);
    if (p.unsuitable_offers?.length) lines.push(`不适合的券类型: ${p.unsuitable_offers.join(', ')}`);
    parts.push(lines.join('\n'));
  }

  if (ctx.constraints) {
    const c = ctx.constraints;
    parts.push('## 营销约束');
    const lines = [];
    if (c.min_discount_rate) lines.push(`最低折扣率: ${(c.min_discount_rate * 100).toFixed(0)}%`);
    if (c.max_coupon_value_yuan) lines.push(`最大券面值: ¥${c.max_coupon_value_yuan}`);
    if (c.monthly_budget_yuan) lines.push(`月预算: ¥${c.monthly_budget_yuan}`);
    if (c.brand_voice_style) lines.push(`品牌语气: ${c.brand_voice_style}`);
    if (c.preferred_channels?.length) lines.push(`推荐渠道: ${c.preferred_channels.join(', ')}`);
    if (c.disallowed_campaign_types?.length) lines.push(`禁止的活动类型: ${c.disallowed_campaign_types.join(', ')}`);
    parts.push(lines.join('\n'));
  }

  if (ctx.cases?.length) {
    parts.push('## 历史成功案例（可参考）');
    ctx.cases.slice(0, 5).forEach((c, i) => {
      const lines = [`${i+1}. ${c.title}（评分:${c.score}）`];
      if (c.channel) lines.push(`   渠道: ${c.channel}`);
      if (c.offer) lines.push(`   优惠: ${c.offer}`);
      if (c.conclusion) lines.push(`   结论: ${c.conclusion}`);
      if (c.copy_snippet) lines.push(`   文案: ${c.copy_snippet}`);
      parts.push(lines.join('\n'));
    });
    if (ctx.cases.length > 5) parts.push(`...及其他 ${ctx.cases.length - 5} 个相关案例`);
  }

  return parts.join('\n\n');
}

/**
 * 注册路由 — 供 Agent 或前端调用，获取策略上下文
 */
export function registerStrategyContextRoutes(app, pool) {
  app.post('/api/growth/strategy-context', async (req, res) => {
    try {
      const storeId = cleanText(req.body.store_id, 128);
      const channel = cleanText(req.body.channel, 80);
      const audience = cleanText(req.body.audience, 200);
      const ctx = await getStrategyContext(storeId, channel, audience);
      const promptText = formatContextForPrompt(ctx);
      res.json({ ok: true, context: ctx, promptText,
        summary: {
          has_profile: !!ctx.profile,
          has_constraints: !!ctx.constraints,
          case_count: ctx.cases.length
        }
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: e?.message || 'strategy_context_error' });
    }
  });

  app.get('/api/growth/strategy-context', async (req, res) => {
    try {
      const storeId = cleanText(req.query.store_id, 128);
      const channel = cleanText(req.query.channel, 80);
      const audience = cleanText(req.query.audience, 200);
      const ctx = await getStrategyContext(storeId, channel, audience);
      const promptText = formatContextForPrompt(ctx);
      res.json({ ok: true, context: ctx, promptText,
        summary: {
          has_profile: !!ctx.profile,
          has_constraints: !!ctx.constraints,
          case_count: ctx.cases.length
        }
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: e?.message || 'strategy_context_error' });
    }
  });
}
