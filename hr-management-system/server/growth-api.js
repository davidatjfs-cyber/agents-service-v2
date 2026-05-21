const EVENT_TYPES = new Set([
  'campaign_scan',
  'phone_authorized',
  'coupon_claimed',
  'coupon_purchased',
  'coupon_redeemed',
  'payment_success',
  'customer_arrived',
  'marketing_triggered',
  'wechat_match_check'
]);

function cleanText(value, max = 255) {
  return String(value == null ? '' : value).trim().slice(0, max);
}

function cleanPhone(value) {
  return cleanText(value, 32).replace(/[^0-9+]/g, '');
}

function parseOccurredAt(value) {
  if (!value) return new Date();
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? new Date() : d;
}

import jwt from 'jsonwebtoken';

function authMiniProgramSync(req) {
  const secret = cleanText(process.env.MINIPROGRAM_SYNC_SECRET || '', 500);
  if (!secret) return { ok: false, status: 503, error: 'miniprogram_sync_disabled' };
  const headerSecret = cleanText(req.headers['x-miniprogram-sync-secret'] || '', 500);
  const auth = cleanText(req.headers.authorization || '', 500);
  const bearer = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : '';
  if (headerSecret === secret || bearer === secret) return { ok: true };
  if (bearer && process.env.JWT_SECRET) {
    try {
      const decoded = jwt.verify(bearer, process.env.JWT_SECRET);
      if (decoded && decoded.username) return { ok: true };
    } catch (e) {}
  }
  return { ok: false, status: 401, error: 'unauthorized' };
}

export async function ensureGrowthTables(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS growth_customers (
      id BIGSERIAL PRIMARY KEY,
      phone TEXT,
      openid TEXT,
      external_userid TEXT,
      first_store_id TEXT,
      last_store_id TEXT,
      first_seen_at TIMESTAMPTZ DEFAULT NOW(),
      last_seen_at TIMESTAMPTZ DEFAULT NOW(),
      meta JSONB DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_growth_customers_phone ON growth_customers (phone) WHERE phone IS NOT NULL AND phone <> ''`);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_growth_customers_openid ON growth_customers (openid) WHERE openid IS NOT NULL AND openid <> ''`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_growth_customers_last_store ON growth_customers (last_store_id, last_seen_at DESC)`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS customer_identities (
      id BIGSERIAL PRIMARY KEY,
      customer_id BIGINT REFERENCES growth_customers(id) ON DELETE CASCADE,
      identity_type TEXT NOT NULL,
      identity_value TEXT NOT NULL,
      source TEXT DEFAULT 'miniprogram',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(identity_type, identity_value)
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_customer_identities_customer ON customer_identities (customer_id)`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS growth_campaigns (
      id BIGSERIAL PRIMARY KEY,
      campaign_id TEXT UNIQUE NOT NULL,
      name TEXT,
      channel TEXT,
      store_id TEXT,
      status TEXT DEFAULT 'active',
      meta JSONB DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_growth_campaigns_store ON growth_campaigns (store_id, created_at DESC)`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS growth_events (
      id BIGSERIAL PRIMARY KEY,
      event_type TEXT NOT NULL,
      customer_id BIGINT REFERENCES growth_customers(id) ON DELETE SET NULL,
      phone TEXT,
      openid TEXT,
      external_userid TEXT,
      store_id TEXT,
      campaign_id TEXT,
      channel TEXT,
      coupon_id TEXT,
      order_id TEXT,
      amount_fen INTEGER DEFAULT 0,
      idempotency_key TEXT UNIQUE,
      metadata JSONB DEFAULT '{}'::jsonb,
      occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_growth_events_type_time ON growth_events (event_type, occurred_at DESC)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_growth_events_campaign ON growth_events (campaign_id, occurred_at DESC)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_growth_events_store ON growth_events (store_id, occurred_at DESC)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_growth_events_customer ON growth_events (customer_id, occurred_at DESC)`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS growth_redemptions (
      id BIGSERIAL PRIMARY KEY,
      customer_id BIGINT REFERENCES growth_customers(id) ON DELETE SET NULL,
      coupon_id TEXT,
      campaign_id TEXT,
      store_id TEXT,
      amount_fen INTEGER DEFAULT 0,
      metadata JSONB DEFAULT '{}'::jsonb,
      redeemed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(coupon_id, redeemed_at)
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_growth_redemptions_campaign ON growth_redemptions (campaign_id, redeemed_at DESC)`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS growth_daily_metrics (
      id BIGSERIAL PRIMARY KEY,
      metric_date DATE NOT NULL,
      store_id TEXT NOT NULL DEFAULT '',
      campaign_id TEXT NOT NULL DEFAULT '',
      channel TEXT NOT NULL DEFAULT '',
      scan_count INTEGER DEFAULT 0,
      authorized_count INTEGER DEFAULT 0,
      coupon_issued_count INTEGER DEFAULT 0,
      coupon_redeemed_count INTEGER DEFAULT 0,
      payment_count INTEGER DEFAULT 0,
      revenue_fen INTEGER DEFAULT 0,
      roi NUMERIC,
      meta JSONB DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(metric_date, store_id, campaign_id, channel)
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_growth_daily_metrics_date ON growth_daily_metrics (metric_date DESC, store_id, campaign_id)`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS growth_alerts (
      id BIGSERIAL PRIMARY KEY,
      alert_key TEXT UNIQUE NOT NULL,
      alert_type TEXT NOT NULL,
      severity TEXT NOT NULL DEFAULT 'medium',
      store_id TEXT,
      campaign_id TEXT,
      title TEXT NOT NULL,
      message TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      suggested_action TEXT,
      metrics JSONB DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      resolved_at TIMESTAMPTZ
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_growth_alerts_status ON growth_alerts (status, created_at DESC)`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS growth_actions (
      id BIGSERIAL PRIMARY KEY,
      action_key TEXT UNIQUE,
      action_type TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'proposed',
      store_id TEXT,
      campaign_id TEXT,
      title TEXT NOT NULL,
      detail TEXT,
      payload JSONB DEFAULT '{}'::jsonb,
      created_by TEXT DEFAULT 'agent_v2',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      executed_at TIMESTAMPTZ
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_growth_actions_status ON growth_actions (status, created_at DESC)`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS store_marketing_profiles (
      id BIGSERIAL PRIMARY KEY,
      store_id TEXT UNIQUE NOT NULL,
      brand TEXT,
      avg_ticket_fen INTEGER DEFAULT 0,
      primary_audience TEXT,
      peak_hours JSONB DEFAULT '[]'::jsonb,
      suitable_offers JSONB DEFAULT '[]'::jsonb,
      unsuitable_offers JSONB DEFAULT '[]'::jsonb,
      best_campaigns JSONB DEFAULT '[]'::jsonb,
      worst_campaigns JSONB DEFAULT '[]'::jsonb,
      execution_level TEXT DEFAULT 'unknown',
      notes TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS growth_customer_profiles (
      id BIGSERIAL PRIMARY KEY,
      customer_id BIGINT NOT NULL REFERENCES growth_customers(id) ON DELETE CASCADE,
      phone TEXT,
      openid TEXT,
      store_id TEXT,
      brand TEXT,
      lifecycle_stage TEXT DEFAULT 'new',
      next_visit_probability NUMERIC,
      best_contact_window TEXT,
      preferred_visit_time TEXT,
      avg_party_size NUMERIC,
      visit_interval_days NUMERIC,
      response_to_discount NUMERIC,
      price_sensitivity NUMERIC,
      adventurous_score NUMERIC,
      health_conscious_score NUMERIC,
      spicy_level NUMERIC,
      occasion_date_score NUMERIC,
      occasion_family_score NUMERIC,
      occasion_business_score NUMERIC,
      occasion_solo_score NUMERIC,
      occasion_friends_score NUMERIC,
      favorite_dishes JSONB DEFAULT '[]'::jsonb,
      disliked_signals JSONB DEFAULT '[]'::jsonb,
      semantic_tags JSONB DEFAULT '[]'::jsonb,
      source_signals JSONB DEFAULT '{}'::jsonb,
      profile_version INTEGER DEFAULT 1,
      last_profiled_at TIMESTAMPTZ DEFAULT NOW(),
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(customer_id)
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_growth_customer_profiles_store ON growth_customer_profiles (store_id, lifecycle_stage)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_growth_customer_profiles_updated ON growth_customer_profiles (updated_at DESC)`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS growth_profile_signals (
      id BIGSERIAL PRIMARY KEY,
      customer_id BIGINT REFERENCES growth_customers(id) ON DELETE SET NULL,
      signal_type TEXT NOT NULL,
      signal_key TEXT NOT NULL,
      signal_value TEXT,
      signal_score NUMERIC,
      source TEXT,
      store_id TEXT,
      campaign_id TEXT,
      occurred_at TIMESTAMPTZ DEFAULT NOW(),
      meta JSONB DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_growth_profile_signals_customer ON growth_profile_signals (customer_id, occurred_at DESC)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_growth_profile_signals_type ON growth_profile_signals (signal_type, signal_key, occurred_at DESC)`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS store_marketing_constraints (
      id BIGSERIAL PRIMARY KEY,
      store_id TEXT NOT NULL,
      brand TEXT,
      min_discount_rate NUMERIC,
      max_coupon_value_fen INTEGER,
      monthly_budget_fen INTEGER,
      max_touch_per_72h INTEGER DEFAULT 1,
      cooldown_hours_after_payment INTEGER DEFAULT 24,
      allowed_channels JSONB DEFAULT '[]'::jsonb,
      disallowed_campaign_types JSONB DEFAULT '[]'::jsonb,
      disallowed_dishes JSONB DEFAULT '[]'::jsonb,
      preferred_channels JSONB DEFAULT '[]'::jsonb,
      brand_voice_style TEXT,
      execution_notes TEXT,
      active BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(store_id)
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_store_marketing_constraints_active ON store_marketing_constraints (active, updated_at DESC)`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS growth_execution_logs (
      id BIGSERIAL PRIMARY KEY,
      action_key TEXT,
      strategy_key TEXT,
      store_id TEXT,
      action_type TEXT NOT NULL,
      decision TEXT NOT NULL,
      operator_username TEXT,
      operator_role TEXT,
      before_payload JSONB DEFAULT '{}'::jsonb,
      after_payload JSONB DEFAULT '{}'::jsonb,
      decision_reason TEXT,
      result_summary TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_growth_execution_logs_action ON growth_execution_logs (action_key, created_at DESC)`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS growth_touch_rules (
      id BIGSERIAL PRIMARY KEY,
      rule_key TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      enabled BOOLEAN DEFAULT TRUE,
      priority INTEGER DEFAULT 100,
      auto_execute BOOLEAN DEFAULT TRUE,
      criteria JSONB DEFAULT '{}'::jsonb,
      action_type TEXT NOT NULL DEFAULT 'send_message',
      action_payload JSONB DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_growth_touch_rules_enabled ON growth_touch_rules (enabled, priority ASC, updated_at DESC)`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS growth_delivery_logs (
      id BIGSERIAL PRIMARY KEY,
      delivery_key TEXT UNIQUE,
      action_key TEXT,
      rule_key TEXT,
      customer_id BIGINT,
      store_id TEXT,
      channel TEXT NOT NULL,
      external_userid TEXT,
      provider_msg_id TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      payload JSONB DEFAULT '{}'::jsonb,
      result JSONB DEFAULT '{}'::jsonb,
      error_message TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_growth_delivery_logs_action ON growth_delivery_logs (action_key, created_at DESC)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_growth_delivery_logs_msg ON growth_delivery_logs (provider_msg_id, created_at DESC)`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS store_wecom_configs (
      id BIGSERIAL PRIMARY KEY,
      store_id TEXT UNIQUE NOT NULL,
      corp_id TEXT NOT NULL,
      corp_secret TEXT NOT NULL,
      agent_id TEXT DEFAULT '',
      sender_userid TEXT DEFAULT '',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS public_channels (
      id BIGSERIAL PRIMARY KEY,
      channel_key TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      platform TEXT NOT NULL,
      store_id TEXT,
      owner_username TEXT,
      meta JSONB DEFAULT '{}'::jsonb,
      enabled BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS public_promo_tasks (
      id BIGSERIAL PRIMARY KEY,
      task_key TEXT UNIQUE,
      store_id TEXT,
      channel_key TEXT,
      campaign_id TEXT,
      title TEXT NOT NULL,
      content_brief TEXT,
      copy_text TEXT,
      poster_url TEXT,
      qr_scene TEXT,
      status TEXT NOT NULL DEFAULT 'planned',
      assignee_username TEXT,
      due_at TIMESTAMPTZ,
      published_url TEXT,
      result_metrics JSONB DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_public_promo_tasks_status ON public_promo_tasks (status, due_at, created_at DESC)`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS creative_assets (
      id BIGSERIAL PRIMARY KEY,
      asset_key TEXT UNIQUE,
      store_id TEXT,
      asset_type TEXT NOT NULL,
      name TEXT NOT NULL,
      url TEXT,
      tags JSONB DEFAULT '[]'::jsonb,
      meta JSONB DEFAULT '{}'::jsonb,
      enabled BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await pool.query(`
     CREATE TABLE IF NOT EXISTS poster_templates (
      id BIGSERIAL PRIMARY KEY,
      template_key TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      category TEXT,
      channel TEXT,
      aspect_ratio TEXT,
      layout JSONB DEFAULT '{}'::jsonb,
      style_guide JSONB DEFAULT '{}'::jsonb,
      image_url TEXT,
      enabled BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pool.query(`ALTER TABLE poster_templates ADD COLUMN IF NOT EXISTS image_url TEXT`);
  await pool.query(`ALTER TABLE poster_templates ADD COLUMN IF NOT EXISTS purposes TEXT[] DEFAULT '{}'::text[]`);
  await pool.query(`ALTER TABLE poster_templates ADD COLUMN IF NOT EXISTS channels TEXT[] DEFAULT '{}'::text[]`);
  await pool.query(`ALTER TABLE generated_posters ADD COLUMN IF NOT EXISTS purposes TEXT[] DEFAULT '{}'::text[]`);
  await pool.query(`ALTER TABLE generated_posters ADD COLUMN IF NOT EXISTS channels TEXT[] DEFAULT '{}'::text[]`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS generated_posters (
      id BIGSERIAL PRIMARY KEY,
      poster_key TEXT UNIQUE,
      campaign_id TEXT,
      store_id TEXT,
      template_key TEXT,
      title TEXT,
      subtitle TEXT,
      cta TEXT,
      image_url TEXT,
      output_url TEXT,
      purposes TEXT[] DEFAULT '{}'::text[],
      channels TEXT[] DEFAULT '{}'::text[],
      status TEXT NOT NULL DEFAULT 'draft',
      meta JSONB DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  const defaultTouchRules = [
    {
      rule_key: 'high_risk_churn_voucher',
      name: '高危流失自动回流券',
      priority: 10,
      auto_execute: true,
      criteria: { min_days_since_last_visit: 21, max_days_since_last_visit: 45, min_visit_count: 5 },
      action_type: 'send_voucher',
      action_payload: {
        channel: 'wecom',
        coupon_value_fen: 3000,
        valid_days: 7,
        coupon_name: '高危回流券',
        title_template: '高危流失回流券',
        content_template: '{customer_name}，你已有{days_since_last_visit}天未到店，系统已为你发放一张{coupon_value_text}高危回流券，7天内可用。'
      }
    },
    {
      rule_key: 'lost_customer_miss_you',
      name: '已流失客户想念你触达',
      priority: 20,
      auto_execute: true,
      criteria: { min_days_since_last_visit: 45, min_visit_count: 3 },
      action_type: 'send_voucher',
      action_payload: {
        channel: 'wecom',
        coupon_value_fen: 1200,
        valid_days: 7,
        coupon_name: '想念你小券',
        title_template: '我们想念你',
        content_template: '{customer_name}，我们想念你。已有{days_since_last_visit}天没见啦，这张{coupon_value_text}小券为你保留7天，欢迎回来。'
      }
    },
    {
      rule_key: 'loyal_birthday_month',
      name: '忠诚客户生日月礼遇',
      priority: 30,
      auto_execute: true,
      criteria: { min_visit_count: 3, max_visit_interval_days: 10 },
      action_type: 'send_voucher',
      action_payload: {
        channel: 'wecom',
        coupon_value_fen: 1800,
        valid_days: 7,
        coupon_name: '生日月礼券',
        title_template: '忠诚客户生日月礼遇',
        content_template: '{customer_name}，感谢一直以来的喜爱，生日月为你准备了一张{coupon_value_text}专享礼券，7天内到店可用。'
      }
    },
    {
      rule_key: 'silent_new_customer_activate',
      name: '新客未激活推荐菜触达',
      priority: 40,
      auto_execute: true,
      criteria: { min_days_since_last_visit: 14, exact_visit_count: 1 },
      action_type: 'send_message',
      action_payload: {
        channel: 'wecom',
        title_template: '新客推荐菜触达',
        content_template: '{customer_name}，上次来店后已经{days_since_last_visit}天了，推荐你下次试试 {favorite_dishes_text}。'
      }
    }
  ];
  for (const rule of defaultTouchRules) {
    await pool.query(
      `INSERT INTO growth_touch_rules (rule_key, name, enabled, priority, auto_execute, criteria, action_type, action_payload)
       VALUES ($1,$2,TRUE,$3,$4,$5::jsonb,$6,$7::jsonb)
       ON CONFLICT (rule_key) DO UPDATE SET
         name = EXCLUDED.name,
         priority = EXCLUDED.priority,
         auto_execute = EXCLUDED.auto_execute,
         criteria = EXCLUDED.criteria,
         action_type = EXCLUDED.action_type,
         action_payload = EXCLUDED.action_payload,
         updated_at = NOW()`,
      [
        rule.rule_key,
        rule.name,
        rule.priority,
        rule.auto_execute !== false,
        JSON.stringify(rule.criteria || {}),
        rule.action_type,
        JSON.stringify(rule.action_payload || {})
      ]
    );
  }
  await pool.query(
    `DELETE FROM growth_touch_rules WHERE rule_key = ANY($1::text[])`,
    [['churn_21_return_coupon', 'churn_45_return_coupon', 'birthday_month_touch', 'high_frequency_upgrade']]
  );
}

async function upsertCustomer(pool, payload) {
  const phone = cleanPhone(payload.phone);
  const openid = cleanText(payload.openid, 128);
  const externalUserId = cleanText(payload.external_userid, 128);
  const storeId = cleanText(payload.store_id, 128);
  const meta = payload.customer_meta && typeof payload.customer_meta === 'object' ? payload.customer_meta : {};

  if (!phone && !openid && !externalUserId) return null;

  let existing = null;
  if (phone) {
    const r = await pool.query('SELECT * FROM growth_customers WHERE phone = $1 LIMIT 1', [phone]);
    existing = r.rows[0] || null;
  }
  if (!existing && openid) {
    const r = await pool.query('SELECT * FROM growth_customers WHERE openid = $1 LIMIT 1', [openid]);
    existing = r.rows[0] || null;
  }

  if (existing) {
    const r = await pool.query(
      `UPDATE growth_customers SET
         phone = COALESCE(NULLIF($2,''), phone),
         openid = COALESCE(NULLIF($3,''), openid),
         external_userid = COALESCE(NULLIF($4,''), external_userid),
         first_store_id = COALESCE(first_store_id, NULLIF($5,'')),
         last_store_id = COALESCE(NULLIF($5,''), last_store_id),
         last_seen_at = NOW(),
         meta = COALESCE(meta, '{}'::jsonb) || $6::jsonb,
         updated_at = NOW()
       WHERE id = $1 RETURNING *`,
      [existing.id, phone, openid, externalUserId, storeId, JSON.stringify(meta)]
    );
    existing = r.rows[0];
  } else {
    const r = await pool.query(
      `INSERT INTO growth_customers (phone, openid, external_userid, first_store_id, last_store_id, meta)
       VALUES (NULLIF($1,''), NULLIF($2,''), NULLIF($3,''), NULLIF($4,''), NULLIF($4,''), $5::jsonb)
       RETURNING *`,
      [phone, openid, externalUserId, storeId, JSON.stringify(meta)]
    );
    existing = r.rows[0];
  }

  const identities = [
    ['phone', phone],
    ['openid', openid],
    ['external_userid', externalUserId]
  ].filter(([, value]) => value);
  for (const [type, value] of identities) {
    await pool.query(
      `INSERT INTO customer_identities (customer_id, identity_type, identity_value, source)
       VALUES ($1,$2,$3,'miniprogram')
       ON CONFLICT (identity_type, identity_value)
       DO UPDATE SET customer_id = EXCLUDED.customer_id, updated_at = NOW()`,
      [existing.id, type, value]
    );
  }

  return existing;
}

async function recomputeCustomerProfiles(pool, days = 90) {
  const safeDays = Math.min(Math.max(Number(days) || 90, 7), 365);
  await pool.query(
    `WITH event_base AS (
       SELECT
         c.id AS customer_id,
         c.phone,
         c.openid,
         COALESCE(c.last_store_id, c.first_store_id, '') AS store_id,
         MAX(e.occurred_at) AS last_event_at,
         COUNT(*) FILTER (WHERE e.event_type = 'payment_success')::int AS payment_count,
         COUNT(*) FILTER (WHERE e.event_type IN ('coupon_claimed','coupon_purchased','marketing_triggered'))::int AS discount_touch_count,
         COUNT(*) FILTER (WHERE e.event_type = 'coupon_redeemed')::int AS discount_convert_count,
         AVG(NULLIF((e.metadata ->> 'party_size')::numeric, 0)) FILTER (WHERE e.metadata ? 'party_size') AS avg_party_size,
         AVG(NULLIF((e.metadata ->> 'spicy_level')::numeric, 0)) FILTER (WHERE e.metadata ? 'spicy_level') AS spicy_level,
         MODE() WITHIN GROUP (ORDER BY CASE
           WHEN EXTRACT(HOUR FROM e.occurred_at) BETWEEN 10 AND 14 THEN '午市'
           WHEN EXTRACT(HOUR FROM e.occurred_at) BETWEEN 17 AND 21 THEN '晚市'
           ELSE '夜间'
         END) AS preferred_visit_time
       FROM growth_customers c
       LEFT JOIN growth_events e ON e.customer_id = c.id
         AND e.occurred_at >= CURRENT_DATE - ($1::int || ' days')::interval
       GROUP BY c.id, c.phone, c.openid, COALESCE(c.last_store_id, c.first_store_id, '')
     ), signal_base AS (
       SELECT
         s.customer_id,
         AVG(s.signal_score) FILTER (WHERE s.signal_key = 'price_sensitivity') AS signal_price_sensitivity,
         AVG(s.signal_score) FILTER (WHERE s.signal_key = 'adventurous_score') AS adventurous_score,
         AVG(s.signal_score) FILTER (WHERE s.signal_key = 'health_conscious_score') AS health_conscious_score,
         AVG(s.signal_score) FILTER (WHERE s.signal_key = 'response_to_discount') AS response_to_discount,
         COUNT(*) FILTER (WHERE s.signal_key = 'occasion' AND s.signal_value = 'date')::numeric AS occasion_date_score,
         COUNT(*) FILTER (WHERE s.signal_key = 'occasion' AND s.signal_value = 'family')::numeric AS occasion_family_score,
         COUNT(*) FILTER (WHERE s.signal_key = 'occasion' AND s.signal_value = 'business')::numeric AS occasion_business_score,
         COUNT(*) FILTER (WHERE s.signal_key = 'occasion' AND s.signal_value = 'solo')::numeric AS occasion_solo_score,
         COUNT(*) FILTER (WHERE s.signal_key = 'occasion' AND s.signal_value = 'friends')::numeric AS occasion_friends_score,
         ARRAY_REMOVE(ARRAY_AGG(DISTINCT s.signal_value) FILTER (WHERE s.signal_key = 'favorite_dish' AND COALESCE(s.signal_value,'') <> ''), NULL) AS favorite_dishes,
         ARRAY_REMOVE(ARRAY_AGG(DISTINCT s.signal_value) FILTER (WHERE s.signal_type = 'semantic_tag' AND COALESCE(s.signal_value,'') <> ''), NULL) AS semantic_tags
        FROM growth_profile_signals s
        WHERE s.occurred_at >= CURRENT_DATE - ($1::int || ' days')::interval
        GROUP BY s.customer_id
      ), pos_base AS (
        SELECT
          gc.id AS customer_id,
          COUNT(po.order_no)::int AS pos_order_count,
          COALESCE(SUM(po.amount_after_discount), 0) AS pos_total_spend,
          ROUND(AVG(po.amount_after_discount), 2) AS avg_check,
          COUNT(*) FILTER (WHERE po.order_type = '堂食')::numeric / NULLIF(COUNT(*)::numeric, 0) AS pos_dine_in_ratio,
          MAX(po.biz_date) AS pos_last_order_at,
          ARRAY_REMOVE(ARRAY_AGG(DISTINCT poi.dish_name) FILTER (WHERE poi.dish_name IS NOT NULL AND poi.dish_name <> '-' AND poi.category <> '-'), NULL) AS pos_favorite_dishes
        FROM growth_customers gc
        INNER JOIN pos_orders po ON gc.phone = po.phone AND po.phone <> ''
        LEFT JOIN pos_order_items poi ON poi.order_no = po.order_no AND poi.category IS NOT NULL AND poi.category <> '-'
        GROUP BY gc.id
      )
      INSERT INTO growth_customer_profiles (
        customer_id, phone, openid, store_id, lifecycle_stage,
        next_visit_probability, best_contact_window, preferred_visit_time,
        avg_party_size, response_to_discount, price_sensitivity,
        adventurous_score, health_conscious_score, spicy_level,
        occasion_date_score, occasion_family_score, occasion_business_score,
        occasion_solo_score, occasion_friends_score,
        favorite_dishes, semantic_tags, source_signals, last_profiled_at, updated_at,
        pos_order_count, pos_total_spend, avg_check, pos_dine_in_ratio, pos_last_order_at
      )
     SELECT
       e.customer_id,
       e.phone,
       e.openid,
       NULLIF(e.store_id, ''),
        CASE
          WHEN GREATEST(e.payment_count, COALESCE(p.pos_order_count, 0)) <= 1 THEN 'new'
          WHEN GREATEST(e.last_event_at, p.pos_last_order_at) IS NULL THEN 'new'
          WHEN GREATEST(e.last_event_at, p.pos_last_order_at) >= NOW() - INTERVAL '14 days' THEN 'active'
          WHEN GREATEST(e.last_event_at, p.pos_last_order_at) >= NOW() - INTERVAL '30 days' THEN 'at_risk'
          ELSE 'churned'
        END,
        CASE
          WHEN GREATEST(e.last_event_at, p.pos_last_order_at) >= NOW() - INTERVAL '7 days' THEN 0.85
          WHEN GREATEST(e.last_event_at, p.pos_last_order_at) >= NOW() - INTERVAL '14 days' THEN 0.65
          WHEN GREATEST(e.last_event_at, p.pos_last_order_at) >= NOW() - INTERVAL '30 days' THEN 0.35
          ELSE 0.1
        END,
       CASE COALESCE(e.preferred_visit_time, '晚市')
         WHEN '午市' THEN '周四 11:00-13:00'
         WHEN '夜间' THEN '周五 20:00-22:00'
         ELSE '周五 17:00-19:00'
       END,
       COALESCE(e.preferred_visit_time, '晚市'),
       COALESCE(e.avg_party_size, 1),
       COALESCE(s.response_to_discount,
         CASE WHEN e.discount_touch_count > 0 THEN ROUND(e.discount_convert_count::numeric / e.discount_touch_count, 4) ELSE 0 END),
       COALESCE(s.signal_price_sensitivity,
         CASE WHEN e.discount_touch_count > 0 THEN ROUND(LEAST(1, e.discount_convert_count::numeric / e.discount_touch_count), 4) ELSE 0.2 END),
       COALESCE(s.adventurous_score, 0.5),
       COALESCE(s.health_conscious_score, 0.5),
       COALESCE(e.spicy_level, 0.5),
       COALESCE(s.occasion_date_score, 0),
       COALESCE(s.occasion_family_score, 0),
       COALESCE(s.occasion_business_score, 0),
       COALESCE(s.occasion_solo_score, 0),
       COALESCE(s.occasion_friends_score, 0),
        COALESCE(to_jsonb(ARRAY(SELECT DISTINCT unnest(COALESCE(s.favorite_dishes, '{}') || COALESCE(p.pos_favorite_dishes, '{}')))), '[]'::jsonb),
        COALESCE(to_jsonb(s.semantic_tags), '[]'::jsonb),
        jsonb_build_object(
          'payment_count', e.payment_count,
          'discount_touch_count', e.discount_touch_count,
          'discount_convert_count', e.discount_convert_count,
          'pos_order_count', COALESCE(p.pos_order_count, 0),
          'pos_total_spend', COALESCE(p.pos_total_spend, 0),
          'source_days', $1
        ),
        NOW(), NOW(),
        COALESCE(p.pos_order_count, 0),
        COALESCE(p.pos_total_spend, 0),
        COALESCE(p.avg_check, ROUND(e.avg_party_size, 2)),
        p.pos_dine_in_ratio,
        p.pos_last_order_at
      FROM event_base e
      LEFT JOIN signal_base s ON s.customer_id = e.customer_id
      LEFT JOIN pos_base p ON p.customer_id = e.customer_id
      ON CONFLICT (customer_id) DO UPDATE SET
        phone = EXCLUDED.phone,
        openid = EXCLUDED.openid,
        store_id = EXCLUDED.store_id,
        lifecycle_stage = EXCLUDED.lifecycle_stage,
        next_visit_probability = EXCLUDED.next_visit_probability,
        best_contact_window = EXCLUDED.best_contact_window,
        preferred_visit_time = EXCLUDED.preferred_visit_time,
        avg_party_size = EXCLUDED.avg_party_size,
        response_to_discount = EXCLUDED.response_to_discount,
        price_sensitivity = EXCLUDED.price_sensitivity,
        adventurous_score = EXCLUDED.adventurous_score,
        health_conscious_score = EXCLUDED.health_conscious_score,
        spicy_level = EXCLUDED.spicy_level,
        occasion_date_score = EXCLUDED.occasion_date_score,
        occasion_family_score = EXCLUDED.occasion_family_score,
        occasion_business_score = EXCLUDED.occasion_business_score,
        occasion_solo_score = EXCLUDED.occasion_solo_score,
        occasion_friends_score = EXCLUDED.occasion_friends_score,
        favorite_dishes = EXCLUDED.favorite_dishes,
        semantic_tags = EXCLUDED.semantic_tags,
        source_signals = EXCLUDED.source_signals,
        pos_order_count = EXCLUDED.pos_order_count,
        pos_total_spend = EXCLUDED.pos_total_spend,
        avg_check = EXCLUDED.avg_check,
        pos_dine_in_ratio = EXCLUDED.pos_dine_in_ratio,
        pos_last_order_at = EXCLUDED.pos_last_order_at,
        last_profiled_at = NOW(),
        updated_at = NOW()`,
    [safeDays]
  );
  return safeDays;
}

async function appendExecutionLog(pool, payload) {
  await pool.query(
    `INSERT INTO growth_execution_logs (
      action_key, strategy_key, store_id, action_type, decision,
      operator_username, operator_role, before_payload, after_payload,
      decision_reason, result_summary
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10,$11)`,
    [
      cleanText(payload.action_key, 255),
      cleanText(payload.strategy_key, 255),
      cleanText(payload.store_id, 128),
      cleanText(payload.action_type, 80),
      cleanText(payload.decision, 80),
      cleanText(payload.operator_username, 128),
      cleanText(payload.operator_role, 80),
      JSON.stringify(payload.before_payload || {}),
      JSON.stringify(payload.after_payload || {}),
      cleanText(payload.decision_reason, 2000),
      cleanText(payload.result_summary, 2000)
    ]
  );
}

async function getStateValue(pool, key) {
  const r = await pool.query(`SELECT data FROM hrms_state WHERE key = $1 LIMIT 1`, [key]);
  return r.rows?.[0]?.data || null;
}

function fmtYmd(value) {
  const d = value ? new Date(value) : new Date();
  if (Number.isNaN(d.getTime())) return 'unknown';
  return d.toISOString().slice(0, 10);
}

function fmtYm(value) {
  const d = value ? new Date(value) : new Date();
  if (Number.isNaN(d.getTime())) return 'unknown';
  return d.toISOString().slice(0, 7);
}

function deriveBirthdayMonth(meta = {}) {
  const monthRaw = cleanText(meta?.birthday_month, 2);
  if (/^(0?[1-9]|1[0-2])$/.test(monthRaw)) return monthRaw.padStart(2, '0');
  const birthday = cleanText(meta?.birthday, 32);
  const m = birthday.match(/^(?:\d{4}[-/])?(\d{1,2})[-/](\d{1,2})$/);
  if (!m) return '';
  return String(m[1]).padStart(2, '0');
}

function interpolateTemplate(template, context) {
  return String(template || '').replace(/\{([a-zA-Z0-9_]+)\}/g, (_, key) => {
    const value = context[key];
    return value == null ? '' : String(value);
  });
}

async function insertGrowthEvent(pool, payload) {
  const metadata = payload.metadata && typeof payload.metadata === 'object' ? payload.metadata : {};
  await pool.query(
    `INSERT INTO growth_events (
       event_type, customer_id, phone, openid, external_userid, store_id, campaign_id, channel,
       coupon_id, order_id, amount_fen, idempotency_key, metadata, occurred_at
     ) VALUES ($1,$2,NULLIF($3,''),NULLIF($4,''),NULLIF($5,''),NULLIF($6,''),NULLIF($7,''),NULLIF($8,''),NULLIF($9,''),NULLIF($10,''),$11,NULLIF($12,''),$13::jsonb,$14)
     ON CONFLICT (idempotency_key) DO NOTHING`,
    [
      cleanText(payload.event_type, 80),
      payload.customer_id ? Number(payload.customer_id) : null,
      cleanPhone(payload.phone),
      cleanText(payload.openid, 128),
      cleanText(payload.external_userid, 128),
      cleanText(payload.store_id, 128),
      cleanText(payload.campaign_id, 128),
      cleanText(payload.channel, 80),
      cleanText(payload.coupon_id, 128),
      cleanText(payload.order_id, 128),
      Math.max(0, Math.floor(Number(payload.amount_fen) || 0)),
      cleanText(payload.idempotency_key, 255),
      JSON.stringify(metadata),
      parseOccurredAt(payload.occurred_at)
    ]
  );
}

async function upsertDeliveryLog(pool, payload) {
  const r = await pool.query(
    `INSERT INTO growth_delivery_logs (
       delivery_key, action_key, rule_key, customer_id, store_id, channel,
       external_userid, provider_msg_id, status, payload, result, error_message, updated_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12,NOW())
     ON CONFLICT (delivery_key) DO UPDATE SET
       provider_msg_id = COALESCE(NULLIF(EXCLUDED.provider_msg_id,''), growth_delivery_logs.provider_msg_id),
       status = EXCLUDED.status,
       result = EXCLUDED.result,
       error_message = EXCLUDED.error_message,
       updated_at = NOW()
     RETURNING *`,
    [
      cleanText(payload.delivery_key, 255),
      cleanText(payload.action_key, 255),
      cleanText(payload.rule_key, 128),
      payload.customer_id ? Number(payload.customer_id) : null,
      cleanText(payload.store_id, 128),
      cleanText(payload.channel || 'wecom', 40),
      cleanText(payload.external_userid, 128),
      cleanText(payload.provider_msg_id, 255),
      cleanText(payload.status || 'pending', 40),
      JSON.stringify(payload.payload || {}),
      JSON.stringify(payload.result || {}),
      cleanText(payload.error_message, 2000)
    ]
  );
  return r.rows[0] || null;
}

let __growthWecomTokenCache = { token: '', expiresAt: 0, store_id: '' };
let __storeWecomTokenCaches = {};

async function getWecomConfig(pool) {
  const config = await getStateValue(pool, 'growth_wecom_config');
  return config && typeof config === 'object' ? config : null;
}

async function getStoreWecomConfig(pool, storeId) {
  if (!storeId) return null;
  const r = await pool.query('SELECT * FROM store_wecom_configs WHERE store_id = $1 LIMIT 1', [storeId]);
  return r.rows[0] || null;
}

async function getAllStoreWecomConfigs(pool) {
  const r = await pool.query('SELECT * FROM store_wecom_configs ORDER BY store_id');
  return r.rows;
}

async function getWecomAccessToken(pool, storeId) {
  const now = Date.now();
  let corpId, corpSecret;

  if (storeId) {
    const cached = __storeWecomTokenCaches[storeId];
    if (cached && cached.token && cached.expiresAt > now + 10000) return cached.token;
    const storeConfig = await getStoreWecomConfig(pool, storeId);
    if (storeConfig) {
      corpId = cleanText(storeConfig.corp_id, 200);
      corpSecret = cleanText(storeConfig.corp_secret, 500);
    } else {
      const globalConfig = await getWecomConfig(pool);
      corpId = cleanText(globalConfig?.corp_id, 200);
      corpSecret = cleanText(globalConfig?.corp_secret, 500);
    }
  } else {
    if (__growthWecomTokenCache.token && __growthWecomTokenCache.expiresAt > now + 10000) return __growthWecomTokenCache.token;
    const config = await getWecomConfig(pool);
    corpId = cleanText(config?.corp_id, 200);
    corpSecret = cleanText(config?.corp_secret, 500);
  }

  if (!corpId || !corpSecret) throw new Error('missing_wecom_config');
  const url = `https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=${encodeURIComponent(corpId)}&corpsecret=${encodeURIComponent(corpSecret)}`;
  const resp = await fetch(url, { method: 'GET' });
  const data = await resp.json();
  if (!resp.ok || Number(data?.errcode) !== 0 || !data?.access_token) throw new Error(data?.errmsg || 'wecom_token_failed');

  const token = cleanText(data.access_token, 500);
  const expiresAt = now + Math.max(300, Number(data.expires_in) || 7200) * 1000;

  if (storeId) {
    __storeWecomTokenCaches[storeId] = { token, expiresAt };
  } else {
    __growthWecomTokenCache = { token, expiresAt, store_id: '' };
  }
  return token;
}

async function sendWecomExternalMessage(pool, payload) {
  const storeId = cleanText(payload.store_id, 128);
  let config;
  if (storeId) {
    config = await getStoreWecomConfig(pool, storeId);
  }
  if (!config) {
    config = await getWecomConfig(pool);
  }
  const senderUserId = cleanText(payload.sender_userid || config?.sender_userid, 128);
  const externalUserId = cleanText(payload.external_userid, 128);
  const content = cleanText(payload.content, 1800);
  if (!senderUserId) throw new Error('missing_wecom_sender_userid');
  if (!externalUserId) throw new Error('missing_external_userid');
  if (!content) throw new Error('missing_message_content');
  const accessToken = await getWecomAccessToken(pool, storeId);
  const resp = await fetch(`https://qyapi.weixin.qq.com/cgi-bin/externalcontact/add_msg_template?access_token=${encodeURIComponent(accessToken)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_type: 'single',
      external_userid: [externalUserId],
      sender: senderUserId,
      allow_select: false,
      text: { content }
    })
  });
  const data = await resp.json();
  if (!resp.ok || Number(data?.errcode) !== 0) throw new Error(data?.errmsg || 'wecom_send_failed');
  return { provider_msg_id: cleanText(data?.msgid || data?.msgid_list?.[0], 255), raw: data };
}

function buildActionMessage(actionRow, payload) {
  const couponValueFen = Math.max(0, Math.floor(Number(payload.coupon_value_fen || payload.value_fen) || 0));
  const favoriteDishesText = cleanText(payload.favorite_dishes_text || '', 200) || '店内推荐菜';
  const context = {
    customer_name: cleanText(payload.customer_name || '您好', 80) || '您好',
    days_since_last_visit: Math.max(0, Math.floor(Number(payload.days_since_last_visit) || 0)),
    visit_count: Math.max(0, Math.floor(Number(payload.visit_count) || 0)),
    coupon_value_text: couponValueFen > 0 ? `¥${(couponValueFen / 100).toFixed(0)}` : '',
    valid_days: Math.max(0, Math.floor(Number(payload.valid_days) || 0)),
    favorite_dishes_text: favoriteDishesText
  };
  const template = cleanText(payload.content_template || payload.message_template, 1800);
  if (template) return interpolateTemplate(template, context);
  return cleanText(actionRow.detail || actionRow.title || '', 1800);
}

export async function executeGrowthActionRecord(pool, before, operator, extraPayload = {}, reason = '') {
  const basePayload = before.payload && typeof before.payload === 'object' ? before.payload : {};
  const payload = Object.assign({}, basePayload, extraPayload || {});
  const storeId = cleanText(before.store_id || payload.store_id, 128);
  const campaignId = cleanText(before.campaign_id || payload.campaign_id, 128);
  const actionType = cleanText(before.action_type, 80);
  const actionKey = cleanText(before.action_key, 255);
  let executionResults = { action_type: actionType, real_executions: [] };

  try {
    if (actionType === 'send_voucher' || actionType === 'campaign_activate') {
      const title = cleanText(before.title, 500);
      const planId = cleanText(payload.plan_id, 128) || `exec_plan_${Date.now()}`;
      const channel = cleanText(payload.channel || 'miniprogram', 80);
      const sourceTemplateId = payload.source_template_id ? Number(payload.source_template_id) : null;
      const recommendedPosterId = payload.recommended_poster_id ? Number(payload.recommended_poster_id) : null;
      const planResult = await pool.query(
        `INSERT INTO growth_campaign_plans (plan_id, store_id, campaign_id, title, channel, status, planned_start, planned_end, created_by, source_template_id, recommended_poster_id)
         VALUES ($1,$2,$3,$4,$5,'active',NOW(),NOW() + ($6::int || ' days')::interval,$7,$8,$9)
         ON CONFLICT (plan_id) DO UPDATE SET status='active', updated_at=NOW()
         RETURNING plan_id, status`,
        [planId, storeId, campaignId || `camp_${Date.now()}`, title, channel, Math.max(1, Math.floor(Number(payload.valid_days) || 7)), operator.username, sourceTemplateId, recommendedPosterId]
      );
      executionResults.real_executions.push({ type: 'campaign_plan', plan_id: planResult.rows[0]?.plan_id, status: 'active' });
      if (sourceTemplateId) {
        pool.query('UPDATE marketing_templates SET use_count = use_count + 1 WHERE id = $1', [sourceTemplateId]).catch(() => {});
      }
      if (campaignId) {
        await pool.query(
          `INSERT INTO growth_campaigns (campaign_id, name, channel, store_id, status)
           VALUES ($1,$2,$3,$4,'active')
           ON CONFLICT (campaign_id) DO UPDATE SET status='active', updated_at=NOW()`,
          [campaignId, title, channel, storeId]
        );
        executionResults.real_executions.push({ type: 'campaign', campaign_id: campaignId, status: 'active' });
      }
      const couponId = payload.coupon_id ? cleanText(payload.coupon_id, 128) : `exec_coupon_${Date.now()}`;
      await pool.query(
        `INSERT INTO growth_coupons (coupon_id, name, type, value_fen, valid_days, usage_rule, store_id, is_active)
         VALUES ($1,$2,$3,$4,$5,$6,$7,TRUE)
         ON CONFLICT (coupon_id) DO UPDATE SET name=EXCLUDED.name, value_fen=EXCLUDED.value_fen, valid_days=EXCLUDED.valid_days, usage_rule=EXCLUDED.usage_rule, is_active=TRUE, updated_at=NOW()`,
        [
          couponId,
          cleanText(payload.coupon_name || before.title, 300),
          cleanText(payload.coupon_type || 'cash', 40),
          Math.max(0, Math.floor(Number(payload.coupon_value_fen || payload.value_fen) || 1000)),
          Math.max(1, Math.floor(Number(payload.valid_days) || 7)),
          cleanText(payload.usage_rule || '规则引擎自动触达', 1000),
          storeId
        ]
      );
      payload.coupon_id = couponId;
      executionResults.real_executions.push({ type: 'coupon', coupon_id: couponId });
    } else if (actionType === 'create_content' || actionType === 'promo_task') {
      const itemId = `exec_content_${Date.now()}`;
      const channel = cleanText(payload.channel || 'miniprogram', 80);
      const contentResult = await pool.query(
        `INSERT INTO growth_content_calendar (item_id, store_id, channel, publish_date, title, content_brief, copy_text, status)
         VALUES ($1,$2,$3,CURRENT_DATE,$4,$5,$6,'planned')
         RETURNING item_id`,
        [itemId, storeId, channel, cleanText(before.title, 500), cleanText(payload.content_brief || payload.detail, 2000), cleanText(before.detail, 4000)]
      );
      executionResults.real_executions.push({ type: 'content_calendar', item_id: contentResult.rows[0]?.item_id });
    } else if (actionType === 'generate_poster') {
      const posterKey = `exec_poster_${Date.now()}`;
      const posterResult = await pool.query(
        `INSERT INTO generated_posters (poster_key, campaign_id, store_id, title, status)
         VALUES ($1,$2,$3,$4,'generated')
         RETURNING poster_key`,
        [posterKey, campaignId, storeId, cleanText(before.title, 500)]
      );
      executionResults.real_executions.push({ type: 'poster', poster_key: posterResult.rows[0]?.poster_key });
    } else {
      executionResults.real_executions.push({ type: 'marked_executed', note: '直接执行触达动作' });
    }

    if (cleanText(payload.channel || '', 80) === 'wecom' && cleanText(payload.external_userid, 128)) {
      const deliveryKey = `${actionKey}:${cleanText(payload.external_userid, 128)}:${Date.now()}`;
      const messageContent = buildActionMessage(before, payload);
      try {
        const sent = await sendWecomExternalMessage(pool, {
          store_id: storeId,
          external_userid: cleanText(payload.external_userid, 128),
          sender_userid: cleanText(payload.sender_userid, 128),
          content: messageContent
        });
        payload.delivery_key = deliveryKey;
        payload.provider_msg_id = sent.provider_msg_id;
        await upsertDeliveryLog(pool, {
          delivery_key: deliveryKey,
          action_key: actionKey,
          rule_key: cleanText(payload.rule_key, 128),
          customer_id: payload.customer_id,
          store_id: storeId,
          channel: 'wecom',
          external_userid: cleanText(payload.external_userid, 128),
          provider_msg_id: sent.provider_msg_id,
          status: 'sent',
          payload: { content: messageContent },
          result: sent.raw || {}
        });
        await insertGrowthEvent(pool, {
          event_type: 'marketing_triggered',
          customer_id: payload.customer_id,
          phone: payload.phone,
          external_userid: payload.external_userid,
          store_id: storeId,
          campaign_id: campaignId,
          channel: 'wecom',
          coupon_id: payload.coupon_id,
          idempotency_key: `marketing_triggered:${actionKey}:${sent.provider_msg_id || deliveryKey}`,
          metadata: {
            action_key: actionKey,
            rule_key: cleanText(payload.rule_key, 128),
            delivery_key: deliveryKey,
            provider_msg_id: sent.provider_msg_id,
            content: messageContent
          }
        });
        executionResults.real_executions.push({ type: 'wecom_message', provider_msg_id: sent.provider_msg_id || deliveryKey, status: 'sent' });
      } catch (deliveryErr) {
        executionResults.delivery_error = deliveryErr?.message || 'wecom_send_failed';
        await upsertDeliveryLog(pool, {
          delivery_key: deliveryKey,
          action_key: actionKey,
          rule_key: cleanText(payload.rule_key, 128),
          customer_id: payload.customer_id,
          store_id: storeId,
          channel: 'wecom',
          external_userid: cleanText(payload.external_userid, 128),
          status: 'failed',
          payload: { content: messageContent },
          result: {},
          error_message: deliveryErr?.message || 'wecom_send_failed'
        });
      }
    }
  } catch (execErr) {
    executionResults.error = execErr?.message;
  }

  const result = await pool.query(
    `UPDATE growth_actions
     SET status = 'executed',
         payload = CASE WHEN $2::jsonb = '{}'::jsonb THEN payload ELSE COALESCE(payload,'{}'::jsonb) || $2::jsonb END,
         updated_at = NOW(),
         executed_at = NOW()
     WHERE action_key = $1
     RETURNING *`,
    [actionKey, JSON.stringify(Object.assign({}, payload, executionResults))]
  );
  await appendExecutionLog(pool, {
    action_key: actionKey,
    strategy_key: cleanText(basePayload.strategy_key || payload.strategy_key || '', 255),
    store_id: storeId,
    action_type: actionType,
    decision: 'executed',
    operator_username: operator.username,
    operator_role: operator.role,
    before_payload: basePayload,
    after_payload: result.rows[0]?.payload || {},
    decision_reason: cleanText(reason, 2000),
    result_summary: `真实执行: ${executionResults.real_executions.map((e) => `${e.type}=${Object.values(e).slice(1).join(',')}`).join('; ') || 'none'}`
  });
  return { action: result.rows[0], execution: executionResults };
}

function buildRuleActionKey(ruleKey, customerId, periodKey) {
  return `rule:${cleanText(ruleKey, 128)}:${Number(customerId) || 0}:${cleanText(periodKey, 40)}`;
}

async function createChurnAlert(pool, rule, row) {
  const days = Math.max(0, Math.floor(Number(row.days_since_last_visit) || 0));
  const alertKey = `churn:${cleanText(rule.rule_key, 128)}:${Number(row.customer_id) || 0}:${fmtYmd(row.last_visit_at)}`;
  await pool.query(
    `INSERT INTO growth_alerts (alert_key, alert_type, severity, store_id, title, message, suggested_action, metrics)
     VALUES ($1,'churn','medium',$2,$3,$4,$5,$6::jsonb)
     ON CONFLICT (alert_key) DO UPDATE SET message = EXCLUDED.message, metrics = EXCLUDED.metrics, status = 'open', updated_at = NOW()`,
    [
      alertKey,
      cleanText(row.store_id, 128),
      `${days}天未到店流失预警`,
      `${cleanText(row.customer_name || row.phone || `客户#${row.customer_id}`, 120)} 已${days}天未到店，系统已自动触发回流触达。`,
      '已由规则引擎自动发送回流触达',
      JSON.stringify({ customer_id: row.customer_id, days_since_last_visit: days, rule_key: rule.rule_key })
    ]
  );
}

async function loadRuleCandidates(pool, rule) {
  if (rule.rule_key === 'loyal_birthday_month') {
    const r = await pool.query(
      `SELECT cp.customer_id, cp.store_id, cp.phone, cp.pos_order_count, cp.pos_last_order_at, cp.visit_interval_days,
              gc.meta AS customer_meta, gc.last_seen_at, gc.external_userid AS customer_external_userid,
              COALESCE(ww.external_userid, gc.external_userid) AS external_userid,
              COALESCE(NULLIF(ww.name,''), NULLIF(gc.meta->>'name',''), cp.phone, '') AS customer_name
       FROM growth_customer_profiles cp
       JOIN growth_customers gc ON gc.id = cp.customer_id
       LEFT JOIN wechat_work_customers ww ON ww.bind_customer_id = cp.customer_id
       WHERE COALESCE(ww.external_userid, gc.external_userid) IS NOT NULL
       LIMIT 500`
    );
    const currentMonth = fmtYm(new Date()).slice(5, 7);
    return r.rows.filter((row) => {
      const visits = Math.max(0, Math.floor(Number(row.pos_order_count) || 0));
      const interval = Number(row.visit_interval_days);
      return deriveBirthdayMonth(row.customer_meta || {}) === currentMonth && visits >= 3 && Number.isFinite(interval) && interval <= 10;
    });
  }
  const r = await pool.query(
    `SELECT cp.customer_id, cp.store_id, cp.phone, cp.price_sensitivity, cp.response_to_discount,
            cp.pos_order_count, cp.pos_total_spend, cp.pos_last_order_at, cp.visit_interval_days, cp.favorite_dishes, gc.last_seen_at,
            COALESCE(cp.pos_last_order_at::date, gc.last_seen_at::date) AS last_visit_at,
            (CURRENT_DATE - COALESCE(cp.pos_last_order_at::date, gc.last_seen_at::date))::int AS days_since_last_visit,
            gc.meta AS customer_meta,
            COALESCE(ww.external_userid, gc.external_userid) AS external_userid,
            COALESCE(NULLIF(ww.name,''), NULLIF(gc.meta->>'name',''), cp.phone, '') AS customer_name
     FROM growth_customer_profiles cp
     JOIN growth_customers gc ON gc.id = cp.customer_id
     LEFT JOIN wechat_work_customers ww ON ww.bind_customer_id = cp.customer_id
     WHERE COALESCE(ww.external_userid, gc.external_userid) IS NOT NULL
     LIMIT 1000`
  );
  return r.rows.filter((row) => {
    const days = Math.max(0, Math.floor(Number(row.days_since_last_visit) || 0));
    const visits = Math.max(0, Math.floor(Number(row.pos_order_count) || 0));
    const interval = Number(row.visit_interval_days);
    if (rule.rule_key === 'high_risk_churn_voucher') return visits >= 5 && days >= 21 && days <= 45;
    if (rule.rule_key === 'lost_customer_miss_you') return visits >= 3 && days > 45;
    if (rule.rule_key === 'silent_new_customer_activate') return visits === 1 && days >= 14;
    return false;
  });
}

function buildRulePeriodKey(ruleKey, row) {
  if (ruleKey === 'loyal_birthday_month') return fmtYm(new Date());
  return fmtYmd(row.last_visit_at || row.pos_last_order_at || row.last_seen_at);
}

async function runTouchRuleEngine(pool, options = {}) {
  const limitPerRule = Math.min(Math.max(Number(options.limit_per_rule) || 100, 1), 500);
  const rulesResult = await pool.query(`SELECT * FROM growth_touch_rules WHERE enabled = TRUE ORDER BY priority ASC, rule_key ASC LIMIT 20`);
  const createdActions = [];
  for (const rule of (rulesResult.rows || [])) {
    const candidates = (await loadRuleCandidates(pool, rule)).slice(0, limitPerRule);
    for (const row of candidates) {
      const actionPayload = Object.assign({}, rule.action_payload || {}, {
        rule_key: rule.rule_key,
        customer_id: row.customer_id,
        store_id: row.store_id,
        phone: row.phone,
        external_userid: row.external_userid,
        customer_name: row.customer_name || row.phone || `客户#${row.customer_id}`,
        days_since_last_visit: row.days_since_last_visit,
        visit_count: row.pos_order_count,
        visit_interval_days: row.visit_interval_days,
        price_sensitivity: row.price_sensitivity,
        response_to_discount: row.response_to_discount,
        pos_total_spend: row.pos_total_spend,
        favorite_dishes_text: Array.isArray(row.favorite_dishes) && row.favorite_dishes.length ? row.favorite_dishes.slice(0, 3).join('、') : '店内推荐菜',
        strategy_key: `rule_engine:${rule.rule_key}`
      });
      const actionKey = buildRuleActionKey(rule.rule_key, row.customer_id, buildRulePeriodKey(rule.rule_key, row));
      const insert = await pool.query(
        `INSERT INTO growth_actions (action_key, action_type, status, store_id, title, detail, payload, created_by)
         VALUES ($1,$2,'proposed',NULLIF($3,''),$4,$5,$6::jsonb,'rule_engine')
         ON CONFLICT (action_key) DO NOTHING
         RETURNING *`,
        [
          actionKey,
          cleanText(rule.action_type || 'send_message', 80),
          cleanText(row.store_id, 128),
          interpolateTemplate(cleanText(actionPayload.title_template || rule.name, 500), actionPayload),
          interpolateTemplate(cleanText(actionPayload.content_template || rule.name, 2000), actionPayload),
          JSON.stringify(actionPayload)
        ]
      );
      if (!insert.rows.length) continue;
      if (rule.rule_key === 'high_risk_churn_voucher') await createChurnAlert(pool, rule, row);
      const actionRow = insert.rows[0];
      if (rule.auto_execute !== false) {
        await executeGrowthActionRecord(pool, actionRow, { username: 'rule_engine', role: 'system' }, {}, `规则引擎自动执行:${rule.rule_key}`);
      }
      createdActions.push(actionKey);
    }
  }
  return { created: createdActions.length, action_keys: createdActions };
}

export function registerGrowthRoutes(app, pool) {
  function requireGrowthAuth(req, res) {
    const auth = authMiniProgramSync(req);
    if (!auth.ok) {
      res.status(auth.status).json({ ok: false, error: auth.error });
      return false;
    }
    return true;
  }

  function getGrowthOperator(req) {
    const auth = cleanText(req.headers.authorization || '', 500);
    const bearer = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : '';
    if (!bearer || !process.env.JWT_SECRET) return { username: 'system', role: 'system' };
    try {
      const decoded = jwt.verify(bearer, process.env.JWT_SECRET);
      return {
        username: cleanText(decoded.username || 'system', 128),
        role: cleanText(decoded.role || 'system', 80)
      };
    } catch (_) {
      return { username: 'system', role: 'system' };
    }
  }

  async function recomputeDailyMetrics(days = 7) {
    const safeDays = Math.min(Math.max(Number(days) || 7, 1), 90);
    await pool.query(
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
      [safeDays]
    );
    return safeDays;
  }

  app.post('/api/miniprogram/events', async (req, res) => {
    if (!requireGrowthAuth(req, res)) return;

    try {
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const eventType = cleanText(body.event_type, 80);
      if (!EVENT_TYPES.has(eventType)) {
        return res.status(400).json({ ok: false, error: 'invalid_event_type' });
      }

      const customer = await upsertCustomer(pool, body);
      const campaignId = cleanText(body.campaign_id || body.scene, 128);
      const storeId = cleanText(body.store_id, 128);
      const channel = cleanText(body.channel, 80);
      const metadata = body.metadata && typeof body.metadata === 'object' ? body.metadata : {};
      const amountFen = Math.max(0, Math.floor(Number(body.amount_fen) || 0));
      const occurredAt = parseOccurredAt(body.occurred_at);
      const idempotencyKey = cleanText(body.idempotency_key, 255) || null;

      if (campaignId) {
        await pool.query(
          `INSERT INTO growth_campaigns (campaign_id, channel, store_id, meta)
           VALUES ($1, NULLIF($2,''), NULLIF($3,''), $4::jsonb)
           ON CONFLICT (campaign_id) DO UPDATE SET
             channel = COALESCE(growth_campaigns.channel, EXCLUDED.channel),
             store_id = COALESCE(growth_campaigns.store_id, EXCLUDED.store_id),
             updated_at = NOW()`,
          [campaignId, channel, storeId, JSON.stringify({ first_event_type: eventType })]
        );
      }

      const inserted = await pool.query(
        `INSERT INTO growth_events (
           event_type, customer_id, phone, openid, external_userid, store_id, campaign_id, channel,
           coupon_id, order_id, amount_fen, idempotency_key, metadata, occurred_at
         ) VALUES ($1,$2,NULLIF($3,''),NULLIF($4,''),NULLIF($5,''),NULLIF($6,''),NULLIF($7,''),NULLIF($8,''),NULLIF($9,''),NULLIF($10,''),$11,$12,$13::jsonb,$14)
         ON CONFLICT (idempotency_key) DO NOTHING
         RETURNING id`,
        [
          eventType,
          customer?.id || null,
          cleanPhone(body.phone),
          cleanText(body.openid, 128),
          cleanText(body.external_userid, 128),
          storeId,
          campaignId,
          channel,
          cleanText(body.coupon_id, 128),
          cleanText(body.order_id, 128),
          amountFen,
          idempotencyKey,
          JSON.stringify(metadata),
          occurredAt
        ]
      );

      if (eventType === 'coupon_redeemed' && inserted.rows.length) {
        await pool.query(
          `INSERT INTO growth_redemptions (customer_id, coupon_id, campaign_id, store_id, amount_fen, metadata, redeemed_at)
           VALUES ($1,NULLIF($2,''),NULLIF($3,''),NULLIF($4,''),$5,$6::jsonb,$7)
           ON CONFLICT DO NOTHING`,
          [customer?.id || null, cleanText(body.coupon_id, 128), campaignId, storeId, amountFen, JSON.stringify(metadata), occurredAt]
        );
      }

      // Phase 2: 授权手机号/匹配检查时，反查 wechat_work_customers 并绑定
      const matchPhone = cleanPhone(body.phone);
      if ((eventType === 'phone_authorized' || eventType === 'wechat_match_check') && matchPhone) {
        try {
          const wwMatch = await pool.query(
            `UPDATE wechat_work_customers SET bind_customer_id = $1, updated_at = NOW()
             WHERE phone = $2 AND bind_customer_id IS NULL
             RETURNING id, store_id`,
            [customer?.id, matchPhone]
          );
          if (wwMatch.rows.length) {
            console.log(`[growth] wechat_work customer matched: phone=${matchPhone}, customer_id=${customer?.id}`);
          }
        } catch (e) {
          console.warn('[growth] wechat_work match failed:', e?.message);
        }
      }

      return res.json({ ok: true, inserted: inserted.rows.length > 0, customer_id: customer?.id || null });
    } catch (e) {
      console.error('[growth] miniprogram event failed:', e?.message || e);
      return res.status(500).json({ ok: false, error: 'server_error' });
    }
  });

  app.get('/api/growth/campaigns/:campaignId/funnel', async (req, res) => {
    if (!requireGrowthAuth(req, res)) return;
    const campaignId = cleanText(req.params.campaignId, 128);
    const r = await pool.query(
      `SELECT event_type, COUNT(*)::int AS count
       FROM growth_events
       WHERE campaign_id = $1
       GROUP BY event_type
       ORDER BY event_type`,
      [campaignId]
    );
    return res.json({ ok: true, campaign_id: campaignId, counts: r.rows });
  });

  app.post('/api/growth/metrics/recompute', async (req, res) => {
    if (!requireGrowthAuth(req, res)) return;
    const days = await recomputeDailyMetrics(req.body?.days || 7);
    return res.json({ ok: true, days });
  });

  app.get('/api/growth/metrics', async (req, res) => {
    if (!requireGrowthAuth(req, res)) return;
    const days = Math.min(Math.max(Number(req.query.days) || 7, 1), 90);
    if (req.query.recompute === '1' || req.query.recompute === 'true') {
      await recomputeDailyMetrics(days);
    }
    const r = await pool.query(
      `SELECT * FROM growth_daily_metrics
       WHERE metric_date >= CURRENT_DATE - ($1::int || ' days')::interval
         AND ($2::text = '' OR store_id = $2)
         AND ($3::text = '' OR campaign_id = $3)
       ORDER BY metric_date DESC, store_id, campaign_id, channel
       LIMIT 1000`,
      [days, cleanText(req.query.store_id || '', 128), cleanText(req.query.campaign_id || '', 128)]
    );
    return res.json({ ok: true, rows: r.rows });
  });

  app.get('/api/growth/alerts', async (req, res) => {
    if (!requireGrowthAuth(req, res)) return;
    const status = cleanText(req.query.status || 'open', 40);
    const r = await pool.query(
      `SELECT * FROM growth_alerts WHERE ($1::text = '' OR status = $1) ORDER BY created_at DESC LIMIT 200`,
      [status]
    );
    return res.json({ ok: true, alerts: r.rows });
  });

  app.post('/api/growth/alerts', async (req, res) => {
    if (!requireGrowthAuth(req, res)) return;
    const b = req.body || {};
    const alertKey = cleanText(b.alert_key || `${b.alert_type || 'growth'}:${b.store_id || ''}:${b.campaign_id || ''}:${new Date().toISOString().slice(0, 10)}`, 255);
    const r = await pool.query(
      `INSERT INTO growth_alerts (alert_key, alert_type, severity, store_id, campaign_id, title, message, suggested_action, metrics)
       VALUES ($1,$2,$3,NULLIF($4,''),NULLIF($5,''),$6,$7,$8,$9::jsonb)
       ON CONFLICT (alert_key) DO UPDATE SET
         severity = EXCLUDED.severity,
         title = EXCLUDED.title,
         message = EXCLUDED.message,
         suggested_action = EXCLUDED.suggested_action,
         metrics = EXCLUDED.metrics,
         status = 'open',
         updated_at = NOW()
       RETURNING *`,
      [alertKey, cleanText(b.alert_type, 80), cleanText(b.severity || 'medium', 40), cleanText(b.store_id, 128), cleanText(b.campaign_id, 128), cleanText(b.title, 500), cleanText(b.message, 2000), cleanText(b.suggested_action, 2000), JSON.stringify(b.metrics || {})]
    );
    return res.json({ ok: true, alert: r.rows[0] });
  });

  app.get('/api/growth/touch-rules', async (req, res) => {
    if (!requireGrowthAuth(req, res)) return;
    const r = await pool.query(`SELECT * FROM growth_touch_rules ORDER BY priority ASC, rule_key ASC LIMIT 100`);
    return res.json({ ok: true, rules: r.rows });
  });

  app.post('/api/growth/touch-rules', async (req, res) => {
    if (!requireGrowthAuth(req, res)) return;
    const b = req.body || {};
    const ruleKey = cleanText(b.rule_key, 128);
    if (!ruleKey) return res.status(400).json({ ok: false, error: 'missing_rule_key' });
    const r = await pool.query(
      `INSERT INTO growth_touch_rules (rule_key, name, enabled, priority, auto_execute, criteria, action_type, action_payload)
       VALUES ($1,$2,COALESCE($3,TRUE),$4,COALESCE($5,TRUE),$6::jsonb,$7,$8::jsonb)
       ON CONFLICT (rule_key) DO UPDATE SET
         name = EXCLUDED.name,
         enabled = EXCLUDED.enabled,
         priority = EXCLUDED.priority,
         auto_execute = EXCLUDED.auto_execute,
         criteria = EXCLUDED.criteria,
         action_type = EXCLUDED.action_type,
         action_payload = EXCLUDED.action_payload,
         updated_at = NOW()
       RETURNING *`,
      [
        ruleKey,
        cleanText(b.name || ruleKey, 255),
        b.enabled !== false,
        Math.max(1, Math.floor(Number(b.priority) || 100)),
        b.auto_execute !== false,
        JSON.stringify(b.criteria || {}),
        cleanText(b.action_type || 'send_message', 80),
        JSON.stringify(b.action_payload || {})
      ]
    );
    return res.json({ ok: true, rule: r.rows[0] });
  });

  app.post('/api/growth/rule-engine/run', async (req, res) => {
    if (!requireGrowthAuth(req, res)) return;
    const result = await runTouchRuleEngine(pool, req.body || {});
    return res.json({ ok: true, result });
  });

  app.get('/api/growth/actions', async (req, res) => {
    if (!requireGrowthAuth(req, res)) return;
    const status = cleanText(req.query.status || '', 40);
    const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    let sql = `SELECT * FROM growth_actions`;
    const params = [];
    if (status) {
      sql += ` WHERE status = $1`;
      params.push(status);
    }
    sql += ` ORDER BY created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(limit, offset);
    const r = await pool.query(sql, params);
    let countSql = `SELECT COUNT(*) as total FROM growth_actions`;
    const countParams = [];
    if (status) { countSql += ` WHERE status = $1`; countParams.push(status); }
    const c = await pool.query(countSql, countParams);
    return res.json({ ok: true, actions: r.rows, total: Number(c.rows[0]?.total || 0), limit, offset });
  });

  app.get('/api/growth/execution-logs', async (req, res) => {
    if (!requireGrowthAuth(req, res)) return;
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    const storeId = cleanText(req.query.store_id || '', 128);
    const decision = cleanText(req.query.decision || '', 40);
    let sql = `SELECT * FROM growth_execution_logs`;
    const params = [];
    const conds = [];
    if (storeId) { conds.push(`store_id = $${params.length + 1}`); params.push(storeId); }
    if (decision) { conds.push(`decision = $${params.length + 1}`); params.push(decision); }
    if (conds.length) sql += ` WHERE ` + conds.join(' AND ');
    sql += ` ORDER BY created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(limit, offset);
    const r = await pool.query(sql, params);
    return res.json({ ok: true, logs: r.rows, limit, offset });
  });

  app.post('/api/growth/actions', async (req, res) => {
    if (!requireGrowthAuth(req, res)) return;
    const b = req.body || {};
    const r = await pool.query(
      `INSERT INTO growth_actions (action_key, action_type, status, store_id, campaign_id, title, detail, payload, created_by)
       VALUES (NULLIF($1,''),$2,COALESCE(NULLIF($3,''),'proposed'),NULLIF($4,''),NULLIF($5,''),$6,$7,$8::jsonb,COALESCE(NULLIF($9,''),'agent_v2'))
       ON CONFLICT (action_key) DO UPDATE SET status = EXCLUDED.status, detail = EXCLUDED.detail, payload = EXCLUDED.payload, updated_at = NOW()
       RETURNING *`,
      [cleanText(b.action_key, 255), cleanText(b.action_type, 80), cleanText(b.status, 40), cleanText(b.store_id, 128), cleanText(b.campaign_id, 128), cleanText(b.title, 500), cleanText(b.detail, 4000), JSON.stringify(b.payload || {}), cleanText(b.created_by, 80)]
    );
    return res.json({ ok: true, action: r.rows[0] });
  });

  app.post('/api/growth/actions/:actionKey/execute', async (req, res) => {
    if (!requireGrowthAuth(req, res)) return;
    const actionKey = cleanText(req.params.actionKey, 255);
    const operator = getGrowthOperator(req);
    const current = await pool.query(`SELECT * FROM growth_actions WHERE action_key = $1 LIMIT 1`, [actionKey]);
    if (!current.rows.length) return res.status(404).json({ ok: false, error: 'action_not_found' });
    const before = current.rows[0];
    const executed = await executeGrowthActionRecord(pool, before, operator, req.body?.payload || {}, req.body?.reason || '');
    return res.json({ ok: true, action: executed.action, execution: executed.execution });
  });

  app.post('/api/growth/actions/:actionKey/ignore', async (req, res) => {
    if (!requireGrowthAuth(req, res)) return;
    const actionKey = cleanText(req.params.actionKey, 255);
    const operator = getGrowthOperator(req);
    const current = await pool.query(`SELECT * FROM growth_actions WHERE action_key = $1 LIMIT 1`, [actionKey]);
    if (!current.rows.length) return res.status(404).json({ ok: false, error: 'action_not_found' });
    const before = current.rows[0];
    const result = await pool.query(
      `UPDATE growth_actions SET status = 'ignored', updated_at = NOW() WHERE action_key = $1 RETURNING *`,
      [actionKey]
    );
    await appendExecutionLog(pool, {
      action_key: actionKey,
      strategy_key: cleanText(before.payload?.strategy_key || '', 255),
      store_id: before.store_id,
      action_type: before.action_type,
      decision: 'ignored',
      operator_username: operator.username,
      operator_role: operator.role,
      before_payload: before.payload || {},
      after_payload: result.rows[0].payload || {},
      decision_reason: cleanText(req.body?.reason || '', 2000),
      result_summary: '动作被忽略'
    });
    return res.json({ ok: true, action: result.rows[0] });
  });

  app.post('/api/growth/actions/:actionKey/edit-and-execute', async (req, res) => {
    if (!requireGrowthAuth(req, res)) return;
    const actionKey = cleanText(req.params.actionKey, 255);
    const operator = getGrowthOperator(req);
    const current = await pool.query(`SELECT * FROM growth_actions WHERE action_key = $1 LIMIT 1`, [actionKey]);
    if (!current.rows.length) return res.status(404).json({ ok: false, error: 'action_not_found' });
    const before = current.rows[0];
    const patch = req.body?.payload && typeof req.body.payload === 'object' ? req.body.payload : {};
    const result = await pool.query(
      `UPDATE growth_actions
       SET status = 'executed', payload = COALESCE(payload,'{}'::jsonb) || $2::jsonb, updated_at = NOW(), executed_at = NOW()
       WHERE action_key = $1 RETURNING *`,
      [actionKey, JSON.stringify(patch)]
    );
    await appendExecutionLog(pool, {
      action_key: actionKey,
      strategy_key: cleanText(before.payload?.strategy_key || '', 255),
      store_id: before.store_id,
      action_type: before.action_type,
      decision: 'edited_then_executed',
      operator_username: operator.username,
      operator_role: operator.role,
      before_payload: before.payload || {},
      after_payload: result.rows[0].payload || {},
      decision_reason: cleanText(req.body?.reason || '', 2000),
      result_summary: '动作修改后执行'
    });
    return res.json({ ok: true, action: result.rows[0] });
  });

  app.get('/api/growth/store-profiles', async (req, res) => {
    if (!requireGrowthAuth(req, res)) return;
    const r = await pool.query(`SELECT * FROM store_marketing_profiles ORDER BY updated_at DESC LIMIT 300`);
    return res.json({ ok: true, profiles: r.rows });
  });

  app.post('/api/growth/store-profiles', async (req, res) => {
    if (!requireGrowthAuth(req, res)) return;
    const b = req.body || {};
    const storeId = cleanText(b.store_id, 128);
    if (!storeId) return res.status(400).json({ ok: false, error: 'missing_store_id' });
    const r = await pool.query(
      `INSERT INTO store_marketing_profiles (store_id, brand, avg_ticket_fen, primary_audience, peak_hours, suitable_offers, unsuitable_offers, notes)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7::jsonb,$8)
       ON CONFLICT (store_id) DO UPDATE SET
         brand = EXCLUDED.brand,
         avg_ticket_fen = EXCLUDED.avg_ticket_fen,
         primary_audience = EXCLUDED.primary_audience,
         peak_hours = EXCLUDED.peak_hours,
         suitable_offers = EXCLUDED.suitable_offers,
         unsuitable_offers = EXCLUDED.unsuitable_offers,
         notes = EXCLUDED.notes,
         updated_at = NOW()
       RETURNING *`,
      [storeId, cleanText(b.brand, 128), Math.max(0, Math.floor(Number(b.avg_ticket_fen) || 0)), cleanText(b.primary_audience, 500), JSON.stringify(b.peak_hours || []), JSON.stringify(b.suitable_offers || []), JSON.stringify(b.unsuitable_offers || []), cleanText(b.notes, 4000)]
    );
    return res.json({ ok: true, profile: r.rows[0] });
  });

  app.get('/api/growth/customer-profiles', async (req, res) => {
    if (!requireGrowthAuth(req, res)) return;
    const storeId = cleanText(req.query.store_id || '', 128);
    const lifecycle = cleanText(req.query.lifecycle_stage || '', 40);
    const r = await pool.query(
      `SELECT * FROM growth_customer_profiles
       WHERE ($1::text = '' OR store_id = $1)
         AND ($2::text = '' OR lifecycle_stage = $2)
       ORDER BY updated_at DESC
       LIMIT 300`,
      [storeId, lifecycle]
    );
    return res.json({ ok: true, profiles: r.rows });
  });

  app.post('/api/growth/customer-profiles/recompute', async (req, res) => {
    if (!requireGrowthAuth(req, res)) return;
    const days = await recomputeCustomerProfiles(pool, req.body?.days || 90);
    return res.json({ ok: true, days });
  });

  app.get('/api/growth/profile-signals', async (req, res) => {
    if (!requireGrowthAuth(req, res)) return;
    const customerId = Number(req.query.customer_id) || 0;
    const signalType = cleanText(req.query.signal_type || '', 80);
    const r = await pool.query(
      `SELECT * FROM growth_profile_signals
       WHERE ($1::bigint = 0 OR customer_id = $1)
         AND ($2::text = '' OR signal_type = $2)
       ORDER BY occurred_at DESC
       LIMIT 300`,
      [customerId, signalType]
    );
    return res.json({ ok: true, signals: r.rows });
  });

  app.post('/api/growth/profile-signals', async (req, res) => {
    if (!requireGrowthAuth(req, res)) return;
    const b = req.body || {};
    const payload = {
      phone: b.phone,
      openid: b.openid,
      external_userid: b.external_userid,
      store_id: b.store_id,
      customer_meta: {}
    };
    const customer = b.customer_id ? { id: Number(b.customer_id) } : await upsertCustomer(pool, payload);
    const signal = await pool.query(
      `INSERT INTO growth_profile_signals (
        customer_id, signal_type, signal_key, signal_value, signal_score,
        source, store_id, campaign_id, occurred_at, meta
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)
      RETURNING *`,
      [
        customer?.id || null,
        cleanText(b.signal_type, 80),
        cleanText(b.signal_key, 80),
        cleanText(b.signal_value, 500),
        b.signal_score == null ? null : Number(b.signal_score),
        cleanText(b.source, 80),
        cleanText(b.store_id, 128),
        cleanText(b.campaign_id, 128),
        parseOccurredAt(b.occurred_at),
        JSON.stringify(b.meta || {})
      ]
    );
    return res.json({ ok: true, signal: signal.rows[0] });
  });

  app.get('/api/growth/store-constraints', async (req, res) => {
    if (!requireGrowthAuth(req, res)) return;
    const storeId = cleanText(req.query.store_id || '', 128);
    const r = await pool.query(
      `SELECT * FROM store_marketing_constraints
       WHERE ($1::text = '' OR store_id = $1)
       ORDER BY updated_at DESC
       LIMIT 200`,
      [storeId]
    );
    return res.json({ ok: true, constraints: r.rows });
  });

  app.post('/api/growth/store-constraints', async (req, res) => {
    if (!requireGrowthAuth(req, res)) return;
    const b = req.body || {};
    const storeId = cleanText(b.store_id, 128);
    if (!storeId) return res.status(400).json({ ok: false, error: 'missing_store_id' });
    const r = await pool.query(
      `INSERT INTO store_marketing_constraints (
        store_id, brand, min_discount_rate, max_coupon_value_fen, monthly_budget_fen,
        max_touch_per_72h, cooldown_hours_after_payment, allowed_channels,
        disallowed_campaign_types, disallowed_dishes, preferred_channels,
        brand_voice_style, execution_notes, active
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10::jsonb,$11::jsonb,$12,$13,$14)
      ON CONFLICT (store_id) DO UPDATE SET
        brand = EXCLUDED.brand,
        min_discount_rate = EXCLUDED.min_discount_rate,
        max_coupon_value_fen = EXCLUDED.max_coupon_value_fen,
        monthly_budget_fen = EXCLUDED.monthly_budget_fen,
        max_touch_per_72h = EXCLUDED.max_touch_per_72h,
        cooldown_hours_after_payment = EXCLUDED.cooldown_hours_after_payment,
        allowed_channels = EXCLUDED.allowed_channels,
        disallowed_campaign_types = EXCLUDED.disallowed_campaign_types,
        disallowed_dishes = EXCLUDED.disallowed_dishes,
        preferred_channels = EXCLUDED.preferred_channels,
        brand_voice_style = EXCLUDED.brand_voice_style,
        execution_notes = EXCLUDED.execution_notes,
        active = EXCLUDED.active,
        updated_at = NOW()
      RETURNING *`,
      [
        storeId,
        cleanText(b.brand, 128),
        b.min_discount_rate == null ? null : Number(b.min_discount_rate),
        b.max_coupon_value_fen == null ? null : Math.max(0, Math.floor(Number(b.max_coupon_value_fen) || 0)),
        b.monthly_budget_fen == null ? null : Math.max(0, Math.floor(Number(b.monthly_budget_fen) || 0)),
        Math.max(0, Math.floor(Number(b.max_touch_per_72h) || 1)),
        Math.max(0, Math.floor(Number(b.cooldown_hours_after_payment) || 24)),
        JSON.stringify(b.allowed_channels || []),
        JSON.stringify(b.disallowed_campaign_types || []),
        JSON.stringify(b.disallowed_dishes || []),
        JSON.stringify(b.preferred_channels || []),
        cleanText(b.brand_voice_style, 200),
        cleanText(b.execution_notes, 4000),
        b.active !== false
      ]
    );
    return res.json({ ok: true, constraint: r.rows[0] });
  });

  // ── Strategy context — 为 Agent 提供门店画像+约束上下文 ──
  app.get('/api/growth/strategy-context', async (req, res) => {
    if (!requireGrowthAuth(req, res)) return;
    await handleStrategyContext(cleanText(req.query.store_id, 128), cleanText(req.query.channel, 80), cleanText(req.query.audience, 200), res);
  });

  // Shared handler for strategy-context (used by both GET and POST)
  async function handleStrategyContext(storeId, channel, audience, res) {
    const result = { storeId, channel, audience, profile: null, constraints: null };
    try {
      if (storeId) {
        const [p, c] = await Promise.all([
          pool.query('SELECT * FROM store_marketing_profiles WHERE store_id = $1 LIMIT 1', [storeId]),
          pool.query('SELECT * FROM store_marketing_constraints WHERE store_id = $1 LIMIT 1', [storeId])
        ]);
        if (p.rows?.length) result.profile = p.rows[0];
        if (c.rows?.length) result.constraints = c.rows[0];
      }
      res.json({ ok: true, context: result, summary: { has_profile: !!result.profile, has_constraints: !!result.constraints } });
    } catch (e) { res.status(500).json({ ok: false, error: e?.message }); }
  }

  app.post('/api/growth/strategy-context', async (req, res) => {
    if (!requireGrowthAuth(req, res)) return;
    await handleStrategyContext(cleanText(req.body.store_id, 128), cleanText(req.body.channel, 80), cleanText(req.body.audience, 200), res);
  });

  app.get('/api/growth/public-channels', async (req, res) => {
    if (!requireGrowthAuth(req, res)) return;
    const r = await pool.query(`SELECT * FROM public_channels WHERE enabled = TRUE ORDER BY store_id, platform, name LIMIT 300`);
    return res.json({ ok: true, channels: r.rows });
  });

  app.post('/api/growth/public-channels', async (req, res) => {
    if (!requireGrowthAuth(req, res)) return;
    const b = req.body || {};
    const r = await pool.query(
      `INSERT INTO public_channels (channel_key, name, platform, store_id, owner_username, meta, enabled)
       VALUES ($1,$2,$3,NULLIF($4,''),NULLIF($5,''),$6::jsonb,COALESCE($7, TRUE))
       ON CONFLICT (channel_key) DO UPDATE SET
         name = EXCLUDED.name,
         platform = EXCLUDED.platform,
         store_id = EXCLUDED.store_id,
         owner_username = EXCLUDED.owner_username,
         meta = EXCLUDED.meta,
         enabled = EXCLUDED.enabled,
         updated_at = NOW()
       RETURNING *`,
      [cleanText(b.channel_key, 128), cleanText(b.name, 200), cleanText(b.platform, 80), cleanText(b.store_id, 128), cleanText(b.owner_username, 128), JSON.stringify(b.meta || {}), b.enabled !== false]
    );
    return res.json({ ok: true, channel: r.rows[0] });
  });

  app.get('/api/growth/public-promo-tasks', async (req, res) => {
    if (!requireGrowthAuth(req, res)) return;
    const status = cleanText(req.query.status || '', 40);
    const r = await pool.query(
      `SELECT * FROM public_promo_tasks
       WHERE ($1::text = '' OR status = $1)
       ORDER BY COALESCE(due_at, created_at) DESC
       LIMIT 300`,
      [status]
    );
    return res.json({ ok: true, tasks: r.rows });
  });

  app.post('/api/growth/public-promo-tasks', async (req, res) => {
    if (!requireGrowthAuth(req, res)) return;
    const b = req.body || {};
    const r = await pool.query(
      `INSERT INTO public_promo_tasks (task_key, store_id, channel_key, campaign_id, title, content_brief, copy_text, poster_url, qr_scene, status, assignee_username, due_at)
       VALUES (NULLIF($1,''),NULLIF($2,''),NULLIF($3,''),NULLIF($4,''),$5,$6,$7,$8,$9,COALESCE(NULLIF($10,''),'planned'),NULLIF($11,''),$12)
       ON CONFLICT (task_key) DO UPDATE SET status = EXCLUDED.status, copy_text = EXCLUDED.copy_text, poster_url = EXCLUDED.poster_url, updated_at = NOW()
       RETURNING *`,
      [cleanText(b.task_key, 255), cleanText(b.store_id, 128), cleanText(b.channel_key, 80), cleanText(b.campaign_id, 128), cleanText(b.title, 500), cleanText(b.content_brief, 2000), cleanText(b.copy_text, 4000), cleanText(b.poster_url, 1000), cleanText(b.qr_scene, 255), cleanText(b.status, 40), cleanText(b.assignee_username, 128), b.due_at ? parseOccurredAt(b.due_at) : null]
    );
    return res.json({ ok: true, task: r.rows[0] });
  });

  app.get('/api/growth/creative-assets', async (req, res) => {
    if (!requireGrowthAuth(req, res)) return;
    const storeId = cleanText(req.query.store_id || '', 128);
    const r = await pool.query(
      `SELECT * FROM creative_assets
       WHERE enabled = TRUE AND ($1::text = '' OR store_id = $1)
       ORDER BY created_at DESC
       LIMIT 300`,
      [storeId]
    );
    return res.json({ ok: true, assets: r.rows });
  });

  app.post('/api/growth/creative-assets', async (req, res) => {
    if (!requireGrowthAuth(req, res)) return;
    const b = req.body || {};
    const r = await pool.query(
      `INSERT INTO creative_assets (asset_key, store_id, asset_type, name, url, tags, meta, enabled)
       VALUES (NULLIF($1,''),NULLIF($2,''),$3,$4,$5,$6::jsonb,$7::jsonb,COALESCE($8, TRUE))
       ON CONFLICT (asset_key) DO UPDATE SET
         store_id = EXCLUDED.store_id,
         asset_type = EXCLUDED.asset_type,
         name = EXCLUDED.name,
         url = EXCLUDED.url,
         tags = EXCLUDED.tags,
         meta = EXCLUDED.meta,
         enabled = EXCLUDED.enabled,
         updated_at = NOW()
       RETURNING *`,
      [cleanText(b.asset_key, 255), cleanText(b.store_id, 128), cleanText(b.asset_type, 80), cleanText(b.name, 300), cleanText(b.url, 1000), JSON.stringify(b.tags || []), JSON.stringify(b.meta || {}), b.enabled !== false]
    );
    return res.json({ ok: true, asset: r.rows[0] });
  });

  app.get('/api/growth/poster-templates', async (req, res) => {
    if (!requireGrowthAuth(req, res)) return;
    const r = await pool.query(`SELECT * FROM poster_templates WHERE enabled = TRUE ORDER BY category, name LIMIT 300`);
    return res.json({ ok: true, templates: r.rows });
  });

  app.post('/api/growth/poster-templates', async (req, res) => {
    if (!requireGrowthAuth(req, res)) return;
    const b = req.body || {};
    const purposes = Array.isArray(b.purposes) ? b.purposes.filter(Boolean) : [];
    const channels = Array.isArray(b.channels) ? b.channels.filter(Boolean) : [];
    const r = await pool.query(
      `INSERT INTO poster_templates (template_key, name, category, channel, aspect_ratio, layout, style_guide, image_url, enabled, purposes, channels)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,COALESCE($9, TRUE),$10,$11)
       ON CONFLICT (template_key) DO UPDATE SET
         name = EXCLUDED.name,
         category = EXCLUDED.category,
         channel = EXCLUDED.channel,
         aspect_ratio = EXCLUDED.aspect_ratio,
         layout = EXCLUDED.layout,
         style_guide = EXCLUDED.style_guide,
         image_url = EXCLUDED.image_url,
         enabled = EXCLUDED.enabled,
         purposes = EXCLUDED.purposes,
         channels = EXCLUDED.channels,
         updated_at = NOW()
       RETURNING *`,
      [cleanText(b.template_key, 128), cleanText(b.name, 300), cleanText(b.category, 80), cleanText(b.channel, 80), cleanText(b.aspect_ratio, 40), JSON.stringify(b.layout || {}), JSON.stringify(b.style_guide || {}), cleanText(b.image_url, 1000), b.enabled !== false, purposes, channels]
    );
    return res.json({ ok: true, template: r.rows[0] });
  });

  app.delete('/api/growth/poster-templates/:id', async (req, res) => {
    if (!requireGrowthAuth(req, res)) return;
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ ok: false, error: 'invalid_id' });
    await pool.query('DELETE FROM poster_templates WHERE id = $1', [id]);
    return res.json({ ok: true });
  });

  app.delete('/api/growth/creative-assets/:id', async (req, res) => {
    if (!requireGrowthAuth(req, res)) return;
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ ok: false, error: 'invalid_id' });
    await pool.query('DELETE FROM creative_assets WHERE id = $1', [id]);
    return res.json({ ok: true });
  });

  app.get('/api/growth/generated-posters', async (req, res) => {
    if (!requireGrowthAuth(req, res)) return;
    const status = cleanText(req.query.status || '', 40);
    const r = await pool.query(
      `SELECT * FROM generated_posters
       WHERE ($1::text = '' OR status = $1)
       ORDER BY created_at DESC
       LIMIT 300`,
      [status]
    );
    return res.json({ ok: true, posters: r.rows });
  });

  app.post('/api/growth/generated-posters', async (req, res) => {
    if (!requireGrowthAuth(req, res)) return;
    const b = req.body || {};
    const r = await pool.query(
      `INSERT INTO generated_posters (poster_key, campaign_id, store_id, template_key, title, subtitle, cta, image_url, output_url, purposes, channels, status, meta)
       VALUES (NULLIF($1,''),NULLIF($2,''),NULLIF($3,''),NULLIF($4,''),$5,$6,$7,$8,$9,$10,$11,COALESCE(NULLIF($12,''),'draft'),$13::jsonb)
       ON CONFLICT (poster_key) DO UPDATE SET title = EXCLUDED.title, subtitle = EXCLUDED.subtitle, cta = EXCLUDED.cta, output_url = EXCLUDED.output_url, purposes = EXCLUDED.purposes, channels = EXCLUDED.channels, status = EXCLUDED.status, meta = EXCLUDED.meta, updated_at = NOW()
       RETURNING *`,
      [cleanText(b.poster_key, 255), cleanText(b.campaign_id, 128), cleanText(b.store_id, 128), cleanText(b.template_key, 128), cleanText(b.title, 500), cleanText(b.subtitle, 1000), cleanText(b.cta, 500), cleanText(b.image_url, 1000), cleanText(b.output_url, 1000), Array.isArray(b.purposes) ? b.purposes.filter(Boolean) : [], Array.isArray(b.channels) ? b.channels.filter(Boolean) : [], cleanText(b.status, 40), JSON.stringify(b.meta || {})]
    );
    return res.json({ ok: true, poster: r.rows[0] });
  });

  app.get('/api/growth/content-library', async (req, res) => {
    if (!requireGrowthAuth(req, res)) return;
    const purpose = cleanText(req.query.purpose || '', 40);
    const channel = cleanText(req.query.channel || '', 40);
    const storeId = cleanText(req.query.store_id || '', 128);
    const conditions = ["gp.status IN ('generated','published')"];
    const params = [];
    let idx = 1;
    if (purpose) { conditions.push(`$${idx} = ANY(gp.purposes)`); params.push(purpose); idx++; }
    if (channel) { conditions.push(`$${idx} = ANY(gp.channels)`); params.push(channel); idx++; }
    if (storeId) { conditions.push(`(gp.store_id IS NULL OR gp.store_id = '' OR gp.store_id = $${idx})`); params.push(storeId); idx++; }
    const query = `SELECT gp.id, gp.poster_key AS template_key, COALESCE(pt.name, gp.title, '海报') AS name, gp.title, gp.subtitle, gp.purposes, gp.channels, gp.output_url AS image_url, gp.created_at
      FROM generated_posters gp
      LEFT JOIN poster_templates pt ON pt.template_key = gp.template_key
      WHERE ${conditions.join(' AND ')}
      ORDER BY gp.created_at DESC LIMIT 100`;
    const r = await pool.query(query, params);
    return res.json({ ok: true, items: r.rows });
  });

  app.delete('/api/growth/generated-posters/:id', async (req, res) => {
    if (!requireGrowthAuth(req, res)) return;
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ ok: false, error: 'invalid_id' });
    await pool.query('DELETE FROM generated_posters WHERE id = $1', [id]);
    return res.json({ ok: true });
  });

  app.get('/api/growth/customers', async (req, res) => {
    if (!requireGrowthAuth(req, res)) return;
    const phone = cleanText(req.query.phone || '', 32);
    const openid = cleanText(req.query.openid || '', 128);
    const store_id = cleanText(req.query.store_id || '', 128);
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 500);
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    const conditions = [];
    const params = [];
    let idx = 1;
    if (phone) { conditions.push(`phone = $${idx++}`); params.push(phone); }
    if (openid) { conditions.push(`openid = $${idx++}`); params.push(openid); }
    if (store_id) { conditions.push(`(first_store_id = $${idx} OR last_store_id = $${idx})`); params.push(store_id); idx++; }
    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
    const r = await pool.query(`SELECT id, phone, openid, external_userid, first_store_id, last_store_id, first_seen_at, last_seen_at, meta, created_at FROM growth_customers ${where} ORDER BY last_seen_at DESC NULLS LAST LIMIT $${idx++} OFFSET $${idx}`, [...params, limit, offset]);
    return res.json({ ok: true, customers: r.rows });
  });

  app.get('/api/growth/events', async (req, res) => {
    if (!requireGrowthAuth(req, res)) return;
    const event_type = cleanText(req.query.event_type || '', 80);
    const store_id = cleanText(req.query.store_id || '', 128);
    const campaign_id = cleanText(req.query.campaign_id || '', 128);
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 500);
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    const conditions = [];
    const params = [];
    let idx = 1;
    if (event_type) { conditions.push(`event_type = $${idx++}`); params.push(event_type); }
    if (store_id) { conditions.push(`store_id = $${idx++}`); params.push(store_id); }
    if (campaign_id) { conditions.push(`campaign_id = $${idx++}`); params.push(campaign_id); }
    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
    const r = await pool.query(`SELECT id, event_type, customer_id, phone, openid, store_id, campaign_id, channel, coupon_id, order_id, amount_fen, occurred_at FROM growth_events ${where} ORDER BY occurred_at DESC LIMIT $${idx++} OFFSET $${idx}`, [...params, limit, offset]);
    return res.json({ ok: true, events: r.rows });
  });

  app.get('/api/growth/campaigns', async (req, res) => {
    if (!requireGrowthAuth(req, res)) return;
    const store_id = cleanText(req.query.store_id || '', 128);
    const status = cleanText(req.query.status || '', 40);
    const conditions = [];
    const params = [];
    let idx = 1;
    if (store_id) { conditions.push(`store_id = $${idx++}`); params.push(store_id); }
    if (status) { conditions.push(`status = $${idx++}`); params.push(status); }
    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
    const r = await pool.query(`SELECT * FROM growth_campaigns ${where} ORDER BY created_at DESC`, params);
    return res.json({ ok: true, campaigns: r.rows });
  });

  app.get('/api/growth/redemptions', async (req, res) => {
    if (!requireGrowthAuth(req, res)) return;
    const campaign_id = cleanText(req.query.campaign_id || '', 128);
    const store_id = cleanText(req.query.store_id || '', 128);
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 500);
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    const conditions = [];
    const params = [];
    let idx = 1;
    if (campaign_id) { conditions.push(`campaign_id = $${idx++}`); params.push(campaign_id); }
    if (store_id) { conditions.push(`store_id = $${idx++}`); params.push(store_id); }
    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
    const r = await pool.query(`SELECT id, customer_id, coupon_id, campaign_id, store_id, amount_fen, redeemed_at FROM growth_redemptions ${where} ORDER BY redeemed_at DESC LIMIT $${idx++} OFFSET $${idx}`, [...params, limit, offset]);
    return res.json({ ok: true, redemptions: r.rows });
  });

  // ── Phase 3: Feishu callback for alert cards ──
  const FEISHU_CALLBACK_SECRET = cleanText(process.env.FEISHU_CALLBACK_SECRET || process.env.MINIPROGRAM_SYNC_SECRET || '', 500);
  app.post('/api/growth/feishu-callback', async (req, res) => {
    const b = req.body || {};
    const reqSecret = cleanText(b.secret || b.token || req.headers['x-callback-secret'] || '', 500);
    if (FEISHU_CALLBACK_SECRET && reqSecret !== FEISHU_CALLBACK_SECRET) return res.status(403).json({ ok: false, error: 'unauthorized' });
    const actionKey = cleanText(b.action_key || '', 255);
    const decision = cleanText(b.decision || '', 80);
    if (!actionKey || !decision) return res.status(400).json({ ok: false, error: 'missing_action_key_or_decision' });
    try {
      const current = await pool.query(`SELECT * FROM growth_actions WHERE action_key = $1 LIMIT 1`, [actionKey]);
      if (!current.rows.length) return res.status(404).json({ ok: false, error: 'action_not_found' });
      const before = current.rows[0];
      if (decision === 'execute') {
        await pool.query(`UPDATE growth_actions SET status='executed', executed_at=NOW(), updated_at=NOW() WHERE action_key=$1`, [actionKey]);
        await appendExecutionLog(pool, { action_key: actionKey, store_id: before.store_id, action_type: before.action_type, decision: 'executed', operator_username: 'feishu_callback', operator_role: 'admin', decision_reason: b.reason || '飞书卡片执行', result_summary: '从飞书卡片执行' });
        return res.json({ ok: true, action: 'executed' });
      } else if (decision === 'ignore') {
        await pool.query(`UPDATE growth_actions SET status='ignored', updated_at=NOW() WHERE action_key=$1`, [actionKey]);
        await appendExecutionLog(pool, { action_key: actionKey, store_id: before.store_id, action_type: before.action_type, decision: 'ignored', operator_username: 'feishu_callback', operator_role: 'admin', decision_reason: b.reason || '飞书卡片忽略', result_summary: '从飞书卡片忽略' });
        return res.json({ ok: true, action: 'ignored' });
      } else if (decision === 'feedback') {
        // 允许从飞书卡片提交简短执行反馈
        const note = cleanText(b.reason || b.note || '', 2000);
        await pool.query(
          `UPDATE growth_actions
           SET status = 'executed', payload = COALESCE(payload,'{}'::jsonb) || $2::jsonb, updated_at = NOW(), executed_at = COALESCE(executed_at, NOW())
           WHERE action_key = $1`,
          [actionKey, JSON.stringify({ feishu_feedback_note: note, feedback_source: 'feishu_card' })]
        );
        await appendExecutionLog(pool, { action_key: actionKey, store_id: before.store_id, action_type: before.action_type, decision: 'feedback', operator_username: 'feishu_callback', operator_role: 'admin', decision_reason: note || '飞书卡片执行回填', result_summary: note || '从飞书卡片回填' });
        return res.json({ ok: true, action: 'feedback_submitted' });
      }
      return res.status(400).json({ ok: false, error: 'invalid_decision' });
    } catch (e) { return res.status(500).json({ ok: false, error: e?.message || 'callback_error' }); }
  });

  // ── Phase 3: Action feedback / 执行回填 ──
  app.post('/api/growth/actions/:actionKey/feedback', async (req, res) => {
    if (!requireGrowthAuth(req, res)) return;
    const actionKey = cleanText(req.params.actionKey, 255);
    const b = req.body || {};
    const operator = getGrowthOperator(req);
    const r = await pool.query(
      `UPDATE growth_actions
       SET status = COALESCE(NULLIF($2,''), status),
           payload = COALESCE(payload,'{}'::jsonb) || $3::jsonb,
           updated_at = NOW()
       WHERE action_key = $1
       RETURNING *`,
      [actionKey, cleanText(b.status, 40), JSON.stringify({ feedback_note: cleanText(b.note, 4000), feedback_screenshot_url: cleanText(b.screenshot_url, 1000), feedback_result_url: cleanText(b.result_url, 1000), executed_by: operator.username, executed_at: new Date().toISOString() })]
    );
    if (!r.rows.length) return res.status(404).json({ ok: false, error: 'action_not_found' });
    await appendExecutionLog(pool, { action_key: actionKey, store_id: r.rows[0].store_id, action_type: r.rows[0].action_type, decision: 'feedback', operator_username: operator.username, operator_role: operator.role, after_payload: r.rows[0].payload, decision_reason: cleanText(b.note, 2000), result_summary: b.note || '执行回填完成' });
    return res.json({ ok: true, action: r.rows[0] });
  });

  // ── Phase 5: Semantic write-back to profiles ──
  app.post('/api/growth/semantic-parse', async (req, res) => {
    if (!requireGrowthAuth(req, res)) return;
    const text = cleanText(req.body.text, 4000);
    if (!text) return res.status(400).json({ ok: false, error: 'missing_text' });
    try {
      if (!process.env.JWT_SECRET) {
        // 关键安全位:绝不允许跨服务 token 用已知字符串作密钥
        throw new Error('JWT_SECRET not configured');
      }
      const { default: jwt } = await import('jsonwebtoken');
      const admToken = jwt.sign({ username: 'growth_semantic', role: 'admin' }, process.env.JWT_SECRET, { expiresIn: '30s' });
      const agentResp = await fetch((process.env.AGENTS_SERVICE_URL || 'http://127.0.0.1:3101') + '/api/growth/semantic-parse', {
        method: 'POST', headers: { 'Authorization': 'Bearer ' + admToken, 'Content-Type': 'application/json' },
        body: JSON.stringify({ text })
      });
      const result = agentResp.ok ? await agentResp.json() : { ok: false };
      if (result.ok && result.taste_tags) {
        return res.json(result);
      }
    } catch (e) { /* fallback below */ }
    // Fallback keyword parsing
    const tags = [];
    if (/辣|麻辣/.test(text)) tags.push('麻辣');
    if (/清淡|少油/.test(text)) tags.push('清淡');
    if (/甜|甜品/.test(text)) tags.push('甜品');
    if (/肉|牛|羊|猪/.test(text)) tags.push('肉食');
    if (/汤|煲/.test(text)) tags.push('汤品');
    return res.json({
      ok: true, taste_tags: tags, price_sensitivity: null,
      emotion: /差|不好|失望/.test(text) ? '负面' : /好|好吃|满意/.test(text) ? '正面' : '中性',
      return_intent: /再来|下次|还会/.test(text),
      key_insight: '关键词解析（LLM不可用）', source: 'keyword_fallback'
    });
  });

  // ── Phase 5: Semantic write-back to profiles ──
  app.post('/api/growth/semantic-writeback', async (req, res) => {
    if (!requireGrowthAuth(req, res)) return;
    const b = req.body || {};
    const customerId = Number(b.customer_id) || 0;
    if (!customerId) return res.status(400).json({ ok: false, error: 'missing_customer_id' });
    const tags = Array.isArray(b.tags) ? b.tags.map(t => cleanText(String(t), 80)).filter(Boolean) : [];
    const tasteTags = Array.isArray(b.taste_tags) ? b.taste_tags.map(t => cleanText(String(t), 80)).filter(Boolean) : [];
    const priceHint = b.price_sensitivity_hint == null ? null : Number(b.price_sensitivity_hint);
    const returnIntent = !!b.return_intent;
    await pool.query(
      `UPDATE growth_customer_profiles
       SET semantic_tags = COALESCE(semantic_tags,'[]'::jsonb) || $2::jsonb,
           favorite_dishes = CASE WHEN $3::jsonb <> '[]'::jsonb THEN COALESCE(favorite_dishes,'[]'::jsonb) || $3::jsonb ELSE favorite_dishes END,
           price_sensitivity = COALESCE($4, price_sensitivity),
           updated_at = NOW()
       WHERE customer_id = $1`,
      [customerId, JSON.stringify(tags), JSON.stringify(tasteTags), priceHint]
    );
    await pool.query(
      `INSERT INTO growth_profile_signals (customer_id, signal_type, signal_key, signal_value, signal_score, source)
       VALUES ($1,'semantic_tag','semantic_parse',NULLIF($2,''),NULL,$3)`,
      [customerId, tags.slice(0, 5).join(','), 'agent_parse']
    );
    return res.json({ ok: true, customer_id: customerId, tags_written: tags.concat(tasteTags), return_intent: returnIntent });
  });

  // ── Phase 6: Weather context + China holidays ──
  const CHINA_HOLIDAYS = {
    '2026-01-01':'元旦','2026-01-28':'小年','2026-02-12':'除夕','2026-02-13':'春节','2026-02-14':'初二','2026-02-15':'初三','2026-02-16':'初四','2026-02-17':'初五',
    '2026-02-18':'初六','2026-03-01':'元宵节','2026-04-04':'清明节','2026-04-05':'清明','2026-04-06':'清明假期','2026-05-01':'劳动节','2026-05-02':'劳动节','2026-05-03':'劳动节',
    '2026-06-20':'端午节','2026-06-21':'端午','2026-06-22':'端午假期','2026-08-28':'七夕','2026-09-17':'中秋节','2026-09-18':'中秋','2026-09-19':'中秋假期',
    '2026-10-01':'国庆节','2026-10-02':'国庆','2026-10-03':'国庆','2026-10-04':'国庆','2026-10-05':'国庆','2026-10-06':'国庆','2026-10-07':'国庆',
    '2026-12-25':'圣诞节'
  };
  let weatherCache = { data: null, at: 0 };
  app.get('/api/growth/weather-context', async (req, res) => {
    const city = cleanText(req.query.city || '上海', 80);
    const today = new Date().toISOString().slice(0, 10);
    const holiday = CHINA_HOLIDAYS[today] || null;
    const month = new Date().getMonth() + 1;
    const day = new Date().getDate();
    const season = month >= 3 && month <= 5 ? '春季' : month >= 6 && month <= 8 ? '夏季' : month >= 9 && month <= 11 ? '秋季' : '冬季';
    const isWeekend = [0, 6].includes(new Date().getDay());
    const dateKey = today;
    let temperature = null, condition = null;
    // Try cache first (5 min TTL)
    if (weatherCache.data && Date.now() - weatherCache.at < 300000 && weatherCache.data.dateKey === dateKey) {
      temperature = weatherCache.data.temperature;
      condition = weatherCache.data.condition;
    } else {
      // Try open-meteo (more reliable than wttr.in)
      try {
        const ctrl = new AbortController();
        setTimeout(() => ctrl.abort(), 4000);
        // Use lat/lon for Shanghai area
        const coords = { '上海': '31.23,121.47', '北京': '39.90,116.40', '广州': '23.13,113.26', '深圳': '22.54,114.06' };
        const latlon = coords[city] || '31.23,121.47';
        const [lat, lon] = latlon.split(',');
        const resp = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,weather_code&timezone=auto`, { signal: ctrl.signal });
        if (resp.ok) {
          const d = await resp.json();
          const current = d?.current;
          if (current) {
            temperature = current.temperature_2m != null ? current.temperature_2m + '°C' : null;
            const codes = {0:'晴',1:'多云',2:'多云',3:'多云',45:'雾',48:'雾',51:'毛毛雨',53:'毛毛雨',55:'毛毛雨',61:'小雨',63:'中雨',65:'大雨',71:'小雪',73:'中雪',75:'大雪',80:'阵雨',81:'阵雨',82:'阵雨',95:'雷阵雨'};
            condition = codes[current.weather_code || 0] || '未知';
          }
        }
      } catch (e) { /* fallback to seasonal */ }
      weatherCache = { data: { dateKey, temperature, condition }, at: Date.now() };
    }
    // Build context with guaranteed fallback values
    const context = { date: today, season, is_weekend: isWeekend, holiday, temperature: temperature || '未知', condition: condition || '未知', city };
    const tips = [];
    if (holiday) tips.push(`今天是${holiday}`);
    if (isWeekend) tips.push('周末');
    if (condition === '雨' || condition?.includes('雨')) tips.push('雨天，适合推送温暖主题');
    if (condition === '雪' || condition?.includes('雪')) tips.push('雪天，适合推送火锅/热饮');
    if (temperature && parseInt(temperature) > 30) tips.push('高温，适合推送冰饮/凉菜');
    if (temperature && parseInt(temperature) < 5) tips.push('寒冷，适合推送热汤/暖锅');
    tips.push(`${season}主题${isWeekend ? '·周末' : '·工作日'}${holiday ? '·' + holiday : ''}`);
    context.tips = tips;
    context.ok = true;
    return res.json(context);
  });

  // ── Phase 6: Active time window prediction ──
  app.get('/api/growth/active-window', async (req, res) => {
    if (!requireGrowthAuth(req, res)) return;
    const storeId = cleanText(req.query.store_id || '', 128);
    const timePatterns = await pool.query(
      `SELECT
         COUNT(*)::int as event_count,
         CASE
           WHEN EXTRACT(HOUR FROM occurred_at) BETWEEN 6 AND 10 THEN '早餐(6-10点)'
           WHEN EXTRACT(HOUR FROM occurred_at) BETWEEN 10 AND 14 THEN '午市(10-14点)'
           WHEN EXTRACT(HOUR FROM occurred_at) BETWEEN 14 AND 17 THEN '下午茶(14-17点)'
           WHEN EXTRACT(HOUR FROM occurred_at) BETWEEN 17 AND 21 THEN '晚市(17-21点)'
           ELSE '夜间(21-6点)'
         END AS time_segment,
         EXTRACT(DOW FROM occurred_at)::int AS weekday,
         CASE WHEN EXTRACT(DOW FROM occurred_at) IN (0,6) THEN '周末' ELSE '工作日' END AS day_type,
         COUNT(*) FILTER (WHERE event_type IN ('payment_success','coupon_redeemed'))::int AS conversion_count
       FROM growth_events
       WHERE ($1='' OR store_id=$1) AND occurred_at >= CURRENT_DATE - 90
       GROUP BY 2, 3, 4
       ORDER BY event_count DESC
       LIMIT 10`,
      [storeId]
    );
    const profileSegments = await pool.query(
      `SELECT lifecycle_stage, COUNT(*)::int as cnt,
              MODE() WITHIN GROUP (ORDER BY best_contact_window) AS top_window,
              ROUND(AVG(price_sensitivity)::numeric, 2) AS avg_price_sens,
              ROUND(AVG(response_to_discount)::numeric, 2) AS avg_discount_resp
       FROM growth_customer_profiles
       WHERE ($1='' OR store_id=$1) GROUP BY lifecycle_stage ORDER BY cnt DESC`,
       [storeId]
     );
    const repurchaseRisk = await pool.query(
      `SELECT COUNT(*)::int as at_risk_count, store_id
       FROM growth_customer_profiles
       WHERE lifecycle_stage IN ('at_risk','churned')
         AND ($1='' OR store_id=$1)
       GROUP BY store_id`,
      [storeId]
    );
    const topPattern = timePatterns.rows[0];
    const prediction = topPattern ? `${topPattern.day_type} ${topPattern.time_segment}（基于${topPattern.event_count}次历史事件，其中成交${topPattern.conversion_count}次）` : '数据不足';
    return res.json({
      ok: true,
      predicted_window: prediction,
      time_patterns: timePatterns.rows.slice(0, 5),
      segments: profileSegments.rows,
      profile_segments: profileSegments.rows,
      repurchase_risk: repurchaseRisk.rows,
      recommendations: [
        prediction !== '数据不足' ? `📅 预测最佳触达: ${prediction}` : '',
        repurchaseRisk.rows.length ? `⏰ ${repurchaseRisk.rows[0].at_risk_count || 0}位客户处于复购临界期，建议尽快触达` : '',
        ...profileSegments.rows.filter(r => r.cnt > 0).map(r =>
          `📊 ${r.lifecycle_stage}客群(${r.cnt}人) 最佳触达:${r.top_window || '未设定'} 价格敏感度:${r.avg_price_sens||'N/A'} 折扣响应:${r.avg_discount_resp||'N/A'}`
        )
      ].filter(Boolean)
    });
  });

  // ── Phase 6: Repurchase critical period auto-trigger ──
  app.post('/api/growth/repurchase-trigger', async (req, res) => {
    if (!requireGrowthAuth(req, res)) return;
    const storeId = cleanText(req.body.store_id || '', 128);
    const r = await pool.query(
      `SELECT cp.customer_id, cp.phone, cp.store_id, cp.lifecycle_stage, cp.next_visit_probability,
              cp.best_contact_window, cp.response_to_discount, cp.price_sensitivity
       FROM growth_customer_profiles cp
       WHERE ($1='' OR cp.store_id=$1) AND cp.lifecycle_stage IN ('at_risk','churned')
         AND cp.phone IS NOT NULL
       LIMIT 50`,
      [storeId]
    );
    let created = 0;
    for (const row of r.rows) {
      const actionKey = `repurchase:${row.customer_id}:${Date.now()}`;
      const useCoupon = Number(row.response_to_discount) > 0.4;
      await pool.query(
        `INSERT INTO growth_actions (action_key, action_type, status, store_id, title, detail, payload, created_by)
         VALUES ($1,'send_voucher','proposed',NULLIF($2,''),$3,$4,$5::jsonb,'agent_v2')
         ON CONFLICT (action_key) DO NOTHING`,
        [actionKey, row.store_id,
         `复购唤醒-客户#${row.customer_id}`,
         `客户${row.phone}已${row.lifecycle_stage === 'churned' ? '流失' : '临近复购临界期'}，${useCoupon ? '建议发送优惠券' : '建议内容触达'}。最佳触达时间:${row.best_contact_window || '未设定'}`,
         JSON.stringify({ customer_id: row.customer_id, phone: row.phone, use_coupon: useCoupon, channel: 'wecom', strategy_key: 'repurchase_auto' })
        ]
      );
      created++;
    }
    return res.json({ ok: true, triggered: created, total_at_risk: r.rows.length });
  });

  app.get('/api/growth/wecom-config', async (req, res) => {
    if (!requireGrowthAuth(req, res)) return;
    const config = await getWecomConfig(pool);
    return res.json({ ok: true, config });
  });

  app.post('/api/growth/wecom-config', async (req, res) => {
    if (!requireGrowthAuth(req, res)) return;
    const b = req.body || {};
    const corpId = cleanText(b.corp_id, 200);
    const corpSecret = cleanText(b.corp_secret, 500);
    const senderUserId = cleanText(b.sender_userid, 128);
    if (!corpId || !corpSecret || !senderUserId) return res.status(400).json({ ok: false, error: 'missing corp_id/corp_secret/sender_userid' });
    const config = {
      corp_id: corpId,
      corp_secret: corpSecret,
      sender_userid: senderUserId,
      agent_id: cleanText(b.agent_id, 64),
      callback_secret: cleanText(b.callback_secret, 500)
    };
    await pool.query(
      `INSERT INTO hrms_state (key, data, updated_at) VALUES ('growth_wecom_config', $1::jsonb, NOW())
       ON CONFLICT (key) DO UPDATE SET data = $1::jsonb, updated_at = NOW()`,
      [JSON.stringify(config)]
    );
    __growthWecomTokenCache = { token: '', expiresAt: 0 };
    return res.json({ ok: true, config });
  });

  app.post('/api/growth/wecom/callback', async (req, res) => {
    const config = await getWecomConfig(pool);
    const configuredSecret = cleanText(config?.callback_secret || process.env.GROWTH_WECOM_CALLBACK_SECRET || '', 500);
    const headerSecret = cleanText(req.headers['x-wecom-callback-secret'] || '', 500);
    if (configuredSecret && headerSecret !== configuredSecret) return res.status(401).json({ ok: false, error: 'unauthorized' });
    const b = req.body || {};
    const providerMsgId = cleanText(b.provider_msg_id || b.msgid, 255);
    const eventType = cleanText(b.event_type || b.event || '', 80).toLowerCase();
    if (!providerMsgId || !eventType) return res.status(400).json({ ok: false, error: 'missing provider_msg_id or event_type' });
    const delivery = await pool.query(`SELECT * FROM growth_delivery_logs WHERE provider_msg_id = $1 ORDER BY created_at DESC LIMIT 1`, [providerMsgId]);
    const row = delivery.rows[0] || null;
    if (!row) return res.status(404).json({ ok: false, error: 'delivery_not_found' });
    const statusMap = { sent: 'sent', delivered: 'delivered', read: 'read', clicked: 'clicked', redeemed: 'redeemed' };
    const eventMap = {
      delivered: 'wecom_message_delivered',
      read: 'wecom_message_read',
      clicked: 'wecom_message_clicked',
      redeemed: 'wecom_coupon_redeemed'
    };
    const newStatus = statusMap[eventType] || 'received';
    await upsertDeliveryLog(pool, {
      delivery_key: row.delivery_key,
      action_key: row.action_key,
      rule_key: row.rule_key,
      customer_id: row.customer_id,
      store_id: row.store_id,
      channel: row.channel,
      external_userid: row.external_userid,
      provider_msg_id: providerMsgId,
      status: newStatus,
      payload: row.payload || {},
      result: Object.assign({}, row.result || {}, b)
    });
    if (eventMap[eventType]) {
      await insertGrowthEvent(pool, {
        event_type: eventMap[eventType],
        customer_id: row.customer_id,
        external_userid: row.external_userid,
        store_id: row.store_id,
        channel: row.channel,
        campaign_id: cleanText((row.payload || {}).campaign_id, 128),
        coupon_id: cleanText((row.payload || {}).coupon_id, 128),
        idempotency_key: `${eventMap[eventType]}:${providerMsgId}`,
        metadata: { provider_msg_id: providerMsgId, action_key: row.action_key, callback: b }
      });
    }
    return res.json({ ok: true, status: newStatus });
  });

  // ── Store WeCom config CRUD ──
  app.get('/api/growth/store-wecom-configs', async (req, res) => {
    if (!requireGrowthAuth(req, res)) return;
    const configs = await getAllStoreWecomConfigs(pool);
    return res.json({ ok: true, configs });
  });

  app.post('/api/growth/store-wecom-configs', async (req, res) => {
    if (!requireGrowthAuth(req, res)) return;
    const b = req.body || {};
    const storeId = cleanText(b.store_id, 128);
    const corpId = cleanText(b.corp_id, 200);
    const corpSecret = cleanText(b.corp_secret, 500);
    const agentId = cleanText(b.agent_id, 64);
    const senderUserId = cleanText(b.sender_userid, 128);
    if (!storeId || !corpId || !corpSecret) return res.status(400).json({ ok: false, error: 'missing store_id/corp_id/corp_secret' });
    await pool.query(
      `INSERT INTO store_wecom_configs (store_id, corp_id, corp_secret, agent_id, sender_userid)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (store_id) DO UPDATE SET
         corp_id = EXCLUDED.corp_id, corp_secret = EXCLUDED.corp_secret,
         agent_id = EXCLUDED.agent_id, sender_userid = EXCLUDED.sender_userid,
         updated_at = NOW()`,
      [storeId, corpId, corpSecret, agentId, senderUserId]
    );
    delete __storeWecomTokenCaches[storeId];
    return res.json({ ok: true });
  });

  app.delete('/api/growth/store-wecom-configs/:storeId', async (req, res) => {
    if (!requireGrowthAuth(req, res)) return;
    const storeId = cleanText(req.params.storeId, 128);
    await pool.query('DELETE FROM store_wecom_configs WHERE store_id = $1', [storeId]);
    delete __storeWecomTokenCaches[storeId];
    return res.json({ ok: true });
  });

  // ── WeCom contact auto-sync from store configs ──
  async function syncWecomContactsForStore(pool, storeConfig) {
    try {
      const storeId = storeConfig.store_id;
      const token = await getWecomAccessToken(pool, storeId);
      const listResp = await fetch(`https://qyapi.weixin.qq.com/cgi-bin/externalcontact/list?access_token=${encodeURIComponent(token)}&userid=${encodeURIComponent(storeConfig.sender_userid || '')}`, { method: 'GET' });
      const listData = await listResp.json();
      if (Number(listData?.errcode) !== 0 || !Array.isArray(listData?.external_userid)) {
        console.warn(`[wecom] list contacts failed for store=${storeId}:`, listData?.errmsg);
        return 0;
      }
      const eids = listData.external_userid.filter(Boolean);
      let synced = 0;
      for (const eid of eids) {
        const detailResp = await fetch(`https://qyapi.weixin.qq.com/cgi-bin/externalcontact/get?access_token=${encodeURIComponent(token)}&external_userid=${encodeURIComponent(eid)}`, { method: 'GET' });
        const detailData = await detailResp.json();
        if (Number(detailData?.errcode) !== 0 || !detailData?.external_contact) continue;
        const c = detailData.external_contact;
        const phone = (c.corpid || c.corp_name || ''); // fallback, try from other fields
        const externalUserid = cleanText(c.external_userid || eid, 128);
        const name = cleanText(c.name || '', 128);
        let contactPhone = '';
        if (Array.isArray(detailData.follow_info) && detailData.follow_info.length) {
          const fi = detailData.follow_info[0];
          if (fi.description) {
            const m = fi.description.match(/1[3-9]\d{9}/);
            if (m) contactPhone = m[0];
          }
          if (!contactPhone && fi.tag_id && Array.isArray(fi.tag_id)) {
          }
        }
        if (Array.isArray(detailData.wechat_channels)) {
          const wc = detailData.wechat_channels.find(ch => ch.phone);
          if (wc) contactPhone = wc.phone;
        }
        await pool.query(
          `INSERT INTO wechat_work_customers (external_userid, name, phone, store_id, bind_customer_id)
           VALUES ($1,$2,NULLIF($3,''),$4,NULL)
           ON CONFLICT (external_userid) WHERE external_userid IS NOT NULL AND external_userid <> '' DO UPDATE SET
             name = COALESCE(NULLIF(EXCLUDED.name,''), wechat_work_customers.name),
             phone = COALESCE(NULLIF(EXCLUDED.phone,''), wechat_work_customers.phone),
             store_id = COALESCE(NULLIF(EXCLUDED.store_id,''), wechat_work_customers.store_id),
             updated_at = NOW()`,
          [externalUserid, name, contactPhone, storeId]
        );
        if (contactPhone) {
          await pool.query(
            `UPDATE wechat_work_customers SET bind_customer_id = (
              SELECT id FROM growth_customers WHERE phone = $1 LIMIT 1
            ), updated_at = NOW()
            WHERE external_userid = $2 AND bind_customer_id IS NULL`,
            [contactPhone, externalUserid]
          );
        }
        synced++;
      }
      return synced;
    } catch (e) {
      console.warn(`[wecom] sync contacts failed for store=${storeConfig.store_id}:`, e?.message);
      return 0;
    }
  }

  app.post('/api/growth/sync-wecom-contacts', async (req, res) => {
    if (!requireGrowthAuth(req, res)) return;
    const storeId = cleanText(req.body?.store_id, 128);
    let configs;
    if (storeId) {
      const cfg = await getStoreWecomConfig(pool, storeId);
      configs = cfg ? [cfg] : [];
    } else {
      configs = await getAllStoreWecomConfigs(pool);
    }
    const results = [];
    for (const cfg of configs) {
      const synced = await syncWecomContactsForStore(pool, cfg);
      results.push({ store_id: cfg.store_id, synced });
    }
    return res.json({ ok: true, results, total: results.reduce((s, r) => s + r.synced, 0) });
  });

  // ── Phase 2: Feishu config persistence for WeChat customer auto-sync ──
  app.get('/api/growth/feishu-config', async (req, res) => {
    if (!requireGrowthAuth(req, res)) return;
    const r = await pool.query(`SELECT data FROM hrms_state WHERE key = 'growth_feishu_config' LIMIT 1`);
    const config = r.rows?.[0]?.data || null;
    res.json({ ok: true, config });
  });

  app.post('/api/growth/feishu-config', async (req, res) => {
    if (!requireGrowthAuth(req, res)) return;
    const b = req.body || {};
    const appToken = cleanText(b.app_token, 200);
    const tableId = cleanText(b.table_id, 200);
    if (!appToken || !tableId) return res.status(400).json({ ok: false, error: 'missing app_token or table_id' });
    await pool.query(
      `INSERT INTO hrms_state (key, data, updated_at) VALUES ('growth_feishu_config', $1::jsonb, NOW())
       ON CONFLICT (key) DO UPDATE SET data = $1::jsonb, updated_at = NOW()`,
      [JSON.stringify({ app_token: appToken, table_id: tableId })]
    );
    res.json({ ok: true, config: { app_token: appToken, table_id: tableId } });
  });

  // ── Phase 6: User clustering (simplified, indexed) ──
  app.get('/api/growth/user-clusters', async (req, res) => {
    if (!requireGrowthAuth(req, res)) return;
    const storeId = cleanText(req.query.store_id || '', 128);
    const r = await pool.query(
      `SELECT lifecycle_stage,
         ROUND(AVG(price_sensitivity)::numeric, 2) AS avg_price_sens,
         ROUND(AVG(response_to_discount)::numeric, 2) AS avg_discount_resp,
         ROUND(AVG(adventurous_score)::numeric, 2) AS avg_adventurous,
         COUNT(*)::int AS user_count,
         COALESCE(MODE() WITHIN GROUP (ORDER BY preferred_visit_time), '') AS common_visit_time
       FROM growth_customer_profiles
       WHERE ($1='' OR store_id=$1)
       GROUP BY lifecycle_stage
       ORDER BY user_count DESC
       LIMIT 20`,
      [storeId]
    );
    return res.json({ ok: true, clusters: r.rows, total: r.rows.reduce((s, r) => s + Number(r.user_count), 0) });
  });

  if (!globalThis.__growthTouchRuleTimer) {
    globalThis.__growthTouchRuleTimer = setInterval(() => {
      runTouchRuleEngine(pool, { limit_per_rule: 100 }).catch((e) => console.warn('[growth] rule engine run failed:', e?.message));
    }, 15 * 60 * 1000);
    setTimeout(() => {
      runTouchRuleEngine(pool, { limit_per_rule: 100 }).catch((e) => console.warn('[growth] initial rule engine run failed:', e?.message));
    }, 10000);
  }

  if (!globalThis.__wecomContactSyncTimer) {
    globalThis.__wecomContactSyncTimer = setInterval(async () => {
      try {
        const configs = await getAllStoreWecomConfigs(pool);
        for (const cfg of configs) {
          await syncWecomContactsForStore(pool, cfg);
        }
      } catch (e) {
        console.warn('[growth] wecom contact sync failed:', e?.message);
      }
    }, 6 * 60 * 60 * 1000);
    setTimeout(async () => {
      try {
        const configs = await getAllStoreWecomConfigs(pool);
        for (const cfg of configs) {
          await syncWecomContactsForStore(pool, cfg);
        }
      } catch (e) {
        console.warn('[growth] initial wecom contact sync failed:', e?.message);
      }
    }, 30000);
  }

  app.post('/api/growth/generate-selling-point', async (req, res) => {
    if (!requireGrowthAuth(req, res)) return;
    try {
      const agentResp = await fetch((process.env.AGENTS_SERVICE_URL || 'http://127.0.0.1:3101') + '/api/growth/generate-selling-point', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: req.body?.title || '', offer: req.body?.offer || '', store: req.body?.store || '' })
      });
      const data = await agentResp.json();
      return res.json({ ok: true, selling_point: data?.selling_point || '限时优惠，到店即享' });
    } catch (e) {
      return res.json({ ok: true, selling_point: '限时优惠，到店即享' });
    }
  });
}
