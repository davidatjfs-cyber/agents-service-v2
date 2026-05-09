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
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_growth_customers_phone
  ON growth_customers (phone) WHERE phone IS NOT NULL AND phone <> '';
CREATE UNIQUE INDEX IF NOT EXISTS uq_growth_customers_openid
  ON growth_customers (openid) WHERE openid IS NOT NULL AND openid <> '';
CREATE INDEX IF NOT EXISTS idx_growth_customers_last_store
  ON growth_customers (last_store_id, last_seen_at DESC);

CREATE TABLE IF NOT EXISTS customer_identities (
  id BIGSERIAL PRIMARY KEY,
  customer_id BIGINT REFERENCES growth_customers(id) ON DELETE CASCADE,
  identity_type TEXT NOT NULL,
  identity_value TEXT NOT NULL,
  source TEXT DEFAULT 'miniprogram',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(identity_type, identity_value)
);

CREATE INDEX IF NOT EXISTS idx_customer_identities_customer
  ON customer_identities (customer_id);

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
);

CREATE INDEX IF NOT EXISTS idx_growth_campaigns_store
  ON growth_campaigns (store_id, created_at DESC);

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
);

CREATE INDEX IF NOT EXISTS idx_growth_events_type_time
  ON growth_events (event_type, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_growth_events_campaign
  ON growth_events (campaign_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_growth_events_store
  ON growth_events (store_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_growth_events_customer
  ON growth_events (customer_id, occurred_at DESC);

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
);

CREATE INDEX IF NOT EXISTS idx_growth_redemptions_campaign
  ON growth_redemptions (campaign_id, redeemed_at DESC);

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
);

CREATE INDEX IF NOT EXISTS idx_growth_daily_metrics_date
  ON growth_daily_metrics (metric_date DESC, store_id, campaign_id);

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
);

CREATE INDEX IF NOT EXISTS idx_growth_alerts_status
  ON growth_alerts (status, created_at DESC);

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
);

CREATE INDEX IF NOT EXISTS idx_growth_actions_status
  ON growth_actions (status, created_at DESC);

CREATE TABLE IF NOT EXISTS marketing_case_library (
  id BIGSERIAL PRIMARY KEY,
  case_key TEXT UNIQUE,
  store_id TEXT,
  campaign_id TEXT,
  title TEXT NOT NULL,
  objective TEXT,
  channel TEXT,
  audience TEXT,
  offer TEXT,
  copy_text TEXT,
  poster_url TEXT,
  metrics JSONB DEFAULT '{}'::jsonb,
  conclusion TEXT,
  reusable BOOLEAN DEFAULT FALSE,
  score INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_marketing_case_store_score
  ON marketing_case_library (store_id, score DESC, created_at DESC);

CREATE TABLE IF NOT EXISTS store_marketing_profiles (
  id BIGSERIAL PRIMARY KEY,
  store_id TEXT UNIQUE NOT NULL,
  brand TEXT,
  avg_ticket_fen INTEGER DEFAULT 0,
  primary_audience TEXT,
  signature_dishes JSONB DEFAULT '[]'::jsonb,
  peak_hours JSONB DEFAULT '[]'::jsonb,
  gross_margin_floor NUMERIC,
  suitable_offers JSONB DEFAULT '[]'::jsonb,
  unsuitable_offers JSONB DEFAULT '[]'::jsonb,
  best_campaigns JSONB DEFAULT '[]'::jsonb,
  worst_campaigns JSONB DEFAULT '[]'::jsonb,
  execution_level TEXT DEFAULT 'unknown',
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

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
);

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
);

CREATE INDEX IF NOT EXISTS idx_public_promo_tasks_status
  ON public_promo_tasks (status, due_at, created_at DESC);

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
);

CREATE TABLE IF NOT EXISTS poster_templates (
  id BIGSERIAL PRIMARY KEY,
  template_key TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  category TEXT,
  channel TEXT,
  aspect_ratio TEXT,
  layout JSONB DEFAULT '{}'::jsonb,
  style_guide JSONB DEFAULT '{}'::jsonb,
  enabled BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

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
  status TEXT NOT NULL DEFAULT 'draft',
  meta JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
