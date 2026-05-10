const EVENT_TYPES = new Set([
  'campaign_scan',
  'phone_authorized',
  'coupon_claimed',
  'coupon_purchased',
  'coupon_redeemed',
  'payment_success',
  'customer_arrived',
  'marketing_triggered'
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
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_marketing_case_store_score ON marketing_case_library (store_id, score DESC, created_at DESC)`);

  await pool.query(`
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
      enabled BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

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
      status TEXT NOT NULL DEFAULT 'draft',
      meta JSONB DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
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

export function registerGrowthRoutes(app, pool) {
  function requireGrowthAuth(req, res) {
    const auth = authMiniProgramSync(req);
    if (!auth.ok) {
      res.status(auth.status).json({ ok: false, error: auth.error });
      return false;
    }
    return true;
  }

  async function recomputeDailyMetrics(days = 7) {
    const safeDays = Math.min(Math.max(Number(days) || 7, 1), 90);
    await pool.query(
      `INSERT INTO growth_daily_metrics (
         metric_date, store_id, campaign_id, channel,
         scan_count, authorized_count, coupon_issued_count, coupon_redeemed_count, payment_count, revenue_fen, updated_at
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

  app.get('/api/growth/actions', async (req, res) => {
    if (!requireGrowthAuth(req, res)) return;
    const r = await pool.query(`SELECT * FROM growth_actions ORDER BY created_at DESC LIMIT 200`);
    return res.json({ ok: true, actions: r.rows });
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
      `INSERT INTO store_marketing_profiles (store_id, brand, avg_ticket_fen, primary_audience, signature_dishes, peak_hours, gross_margin_floor, suitable_offers, unsuitable_offers, notes)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,$8::jsonb,$9::jsonb,$10)
       ON CONFLICT (store_id) DO UPDATE SET
         brand = EXCLUDED.brand,
         avg_ticket_fen = EXCLUDED.avg_ticket_fen,
         primary_audience = EXCLUDED.primary_audience,
         signature_dishes = EXCLUDED.signature_dishes,
         peak_hours = EXCLUDED.peak_hours,
         gross_margin_floor = EXCLUDED.gross_margin_floor,
         suitable_offers = EXCLUDED.suitable_offers,
         unsuitable_offers = EXCLUDED.unsuitable_offers,
         notes = EXCLUDED.notes,
         updated_at = NOW()
       RETURNING *`,
      [storeId, cleanText(b.brand, 128), Math.max(0, Math.floor(Number(b.avg_ticket_fen) || 0)), cleanText(b.primary_audience, 500), JSON.stringify(b.signature_dishes || []), JSON.stringify(b.peak_hours || []), b.gross_margin_floor == null ? null : Number(b.gross_margin_floor), JSON.stringify(b.suitable_offers || []), JSON.stringify(b.unsuitable_offers || []), cleanText(b.notes, 4000)]
    );
    return res.json({ ok: true, profile: r.rows[0] });
  });

  app.get('/api/growth/cases', async (req, res) => {
    if (!requireGrowthAuth(req, res)) return;
    const r = await pool.query(`SELECT * FROM marketing_case_library ORDER BY score DESC, created_at DESC LIMIT 200`);
    return res.json({ ok: true, cases: r.rows });
  });

  app.post('/api/growth/cases', async (req, res) => {
    if (!requireGrowthAuth(req, res)) return;
    const b = req.body || {};
    const r = await pool.query(
      `INSERT INTO marketing_case_library (case_key, store_id, campaign_id, title, objective, channel, audience, offer, copy_text, poster_url, metrics, conclusion, reusable, score)
       VALUES (NULLIF($1,''),NULLIF($2,''),NULLIF($3,''),$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13,$14)
       ON CONFLICT (case_key) DO UPDATE SET metrics = EXCLUDED.metrics, conclusion = EXCLUDED.conclusion, reusable = EXCLUDED.reusable, score = EXCLUDED.score, updated_at = NOW()
       RETURNING *`,
      [cleanText(b.case_key, 255), cleanText(b.store_id, 128), cleanText(b.campaign_id, 128), cleanText(b.title, 500), cleanText(b.objective, 1000), cleanText(b.channel, 80), cleanText(b.audience, 500), cleanText(b.offer, 500), cleanText(b.copy_text, 4000), cleanText(b.poster_url, 1000), JSON.stringify(b.metrics || {}), cleanText(b.conclusion, 2000), !!b.reusable, Math.max(0, Math.min(100, Math.floor(Number(b.score) || 0)))]
    );
    return res.json({ ok: true, case: r.rows[0] });
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
    const r = await pool.query(
      `INSERT INTO poster_templates (template_key, name, category, channel, aspect_ratio, layout, style_guide, enabled)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,COALESCE($8, TRUE))
       ON CONFLICT (template_key) DO UPDATE SET
         name = EXCLUDED.name,
         category = EXCLUDED.category,
         channel = EXCLUDED.channel,
         aspect_ratio = EXCLUDED.aspect_ratio,
         layout = EXCLUDED.layout,
         style_guide = EXCLUDED.style_guide,
         enabled = EXCLUDED.enabled,
         updated_at = NOW()
       RETURNING *`,
      [cleanText(b.template_key, 128), cleanText(b.name, 300), cleanText(b.category, 80), cleanText(b.channel, 80), cleanText(b.aspect_ratio, 40), JSON.stringify(b.layout || {}), JSON.stringify(b.style_guide || {}), b.enabled !== false]
    );
    return res.json({ ok: true, template: r.rows[0] });
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
      `INSERT INTO generated_posters (poster_key, campaign_id, store_id, template_key, title, subtitle, cta, image_url, output_url, status, meta)
       VALUES (NULLIF($1,''),NULLIF($2,''),NULLIF($3,''),NULLIF($4,''),$5,$6,$7,$8,$9,COALESCE(NULLIF($10,''),'draft'),$11::jsonb)
       ON CONFLICT (poster_key) DO UPDATE SET title = EXCLUDED.title, subtitle = EXCLUDED.subtitle, cta = EXCLUDED.cta, output_url = EXCLUDED.output_url, status = EXCLUDED.status, meta = EXCLUDED.meta, updated_at = NOW()
       RETURNING *`,
      [cleanText(b.poster_key, 255), cleanText(b.campaign_id, 128), cleanText(b.store_id, 128), cleanText(b.template_key, 128), cleanText(b.title, 500), cleanText(b.subtitle, 1000), cleanText(b.cta, 500), cleanText(b.image_url, 1000), cleanText(b.output_url, 1000), cleanText(b.status, 40), JSON.stringify(b.meta || {})]
    );
    return res.json({ ok: true, poster: r.rows[0] });
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
}
