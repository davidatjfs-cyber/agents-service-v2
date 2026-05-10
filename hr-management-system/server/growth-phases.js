const PHASE_EVENT_TYPES = new Set([
  'campaign_scan', 'phone_authorized', 'coupon_claimed',
  'coupon_purchased', 'coupon_redeemed', 'payment_success',
  'customer_arrived', 'marketing_triggered'
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

function authPhaseApi(req) {
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

export async function ensurePhaseTables(pool) {
  // Phase 1: growth_coupons + sync_failures
  await pool.query(`
    CREATE TABLE IF NOT EXISTS growth_coupons (
      id BIGSERIAL PRIMARY KEY, coupon_id TEXT UNIQUE NOT NULL,
      name TEXT, type TEXT DEFAULT 'cash', value_fen INTEGER DEFAULT 0,
      price_fen INTEGER DEFAULT 0, valid_days INTEGER DEFAULT 30,
      stock INTEGER DEFAULT -1, usage_rule TEXT, dish_name TEXT,
      is_active BOOLEAN DEFAULT TRUE, store_id TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS growth_sync_failures (
      id BIGSERIAL PRIMARY KEY, source TEXT DEFAULT 'miniprogram',
      event_type TEXT, payload JSONB DEFAULT '{}'::jsonb, error_message TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_sync_failures_created ON growth_sync_failures (created_at DESC)`);

  // Phase 2: wechat_work_customers
  await pool.query(`
    CREATE TABLE IF NOT EXISTS wechat_work_customers (
      id BIGSERIAL PRIMARY KEY, external_userid TEXT, name TEXT, phone TEXT,
      store_id TEXT, note TEXT, bind_customer_id BIGINT,
      import_batch TEXT, created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_ww_store ON wechat_work_customers (store_id, created_at DESC)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_ww_phone ON wechat_work_customers (phone) WHERE phone IS NOT NULL AND phone <> ''`);

  // Phase 3: campaign_plans
  await pool.query(`
    CREATE TABLE IF NOT EXISTS growth_campaign_plans (
      id BIGSERIAL PRIMARY KEY, plan_id TEXT UNIQUE, store_id TEXT,
      campaign_id TEXT, title TEXT NOT NULL, channel TEXT,
      voucher_template_id TEXT, target_audience TEXT DEFAULT 'all',
      budget_fen INTEGER DEFAULT 0, status TEXT DEFAULT 'draft',
      planned_start TIMESTAMPTZ, planned_end TIMESTAMPTZ,
      created_by TEXT DEFAULT 'admin', created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_plans_store ON growth_campaign_plans (store_id, status, created_at DESC)`);

  // Phase 7: strategy_evaluations
  await pool.query(`
    CREATE TABLE IF NOT EXISTS growth_strategy_evaluations (
      id BIGSERIAL PRIMARY KEY, strategy_key TEXT UNIQUE, store_id TEXT,
      campaign_id TEXT, title TEXT NOT NULL,
      feasibility_score INTEGER DEFAULT 0, fit_score INTEGER DEFAULT 0,
      cost_risk_score INTEGER DEFAULT 0, case_similarity_score INTEGER DEFAULT 0,
      clarity_score INTEGER DEFAULT 0, channel_score INTEGER DEFAULT 0,
      reviewable_score INTEGER DEFAULT 0, total_score NUMERIC DEFAULT 0,
      detail JSONB DEFAULT '{}'::jsonb, feedback TEXT,
      feedback_rating INTEGER, status TEXT DEFAULT 'proposed',
      created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_evals_store ON growth_strategy_evaluations (store_id, total_score DESC)`);

  // Phase 8: content_calendar
  await pool.query(`
    CREATE TABLE IF NOT EXISTS growth_content_calendar (
      id BIGSERIAL PRIMARY KEY, item_id TEXT UNIQUE, store_id TEXT,
      channel TEXT NOT NULL, publish_date DATE NOT NULL, title TEXT NOT NULL,
      content_brief TEXT, copy_text TEXT, image_url TEXT, campaign_id TEXT,
      qr_scene TEXT, status TEXT DEFAULT 'draft', assignee_username TEXT,
      result_scan_count INTEGER DEFAULT 0, result_revenue_fen INTEGER DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_calendar_date ON growth_content_calendar (publish_date, store_id, channel)`);

  // Phase 9: POS orders (from KeruYun via Feishu bitable)
  // Column order matches KeruYun export exactly: 编号,订单号,订单来源,营业日,下单时间,结账时间,订单状态,订单金额,总优惠金额,支付方式,支付笔数,订单收入,会员姓名,会员手机号,订单类型,桌台,就餐人数,就餐时长
  await pool.query(`
    CREATE TABLE IF NOT EXISTS pos_orders (
      id BIGSERIAL PRIMARY KEY,
      seq_no TEXT,
      order_no TEXT NOT NULL,
      order_source TEXT,
      biz_date DATE,
      order_time TIMESTAMPTZ,
      checkout_time TIMESTAMPTZ,
      order_status TEXT,
      total_amount NUMERIC DEFAULT 0,
      total_discount NUMERIC DEFAULT 0,
      payment_method TEXT,
      payment_count INTEGER DEFAULT 0,
      revenue NUMERIC DEFAULT 0,
      member_name TEXT,
      phone TEXT,
      order_type TEXT,
      table_no TEXT,
      diners INTEGER,
      duration TEXT,
      customer_id BIGINT,
      store_id TEXT,
      synced_at TIMESTAMPTZ DEFAULT NOW(),
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_pos_orders_no ON pos_orders (order_no)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_pos_orders_phone ON pos_orders (phone) WHERE phone IS NOT NULL AND phone <> ''`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_pos_orders_date ON pos_orders (biz_date DESC, store_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_pos_orders_customer ON pos_orders (customer_id) WHERE customer_id IS NOT NULL`);

  // Column order matches KeruYun export: 营业日,门店编号,门店名称,订单号,商品编码,商品名称,规格,菜品标签,单价,数量,单位,菜品合计金额,服务费分摊,菜品优惠,菜品收入,商品中类,商品大类
  await pool.query(`
    CREATE TABLE IF NOT EXISTS pos_order_items (
      id BIGSERIAL PRIMARY KEY,
      biz_date DATE,
      store_code TEXT,
      store_name TEXT,
      order_no TEXT NOT NULL,
      sku TEXT,
      dish_name TEXT,
      spec TEXT,
      tags TEXT,
      unit_price NUMERIC DEFAULT 0,
      qty NUMERIC DEFAULT 0,
      unit TEXT,
      subtotal NUMERIC DEFAULT 0,
      service_fee NUMERIC DEFAULT 0,
      discount NUMERIC DEFAULT 0,
      item_revenue NUMERIC DEFAULT 0,
      category_mid TEXT,
      category TEXT,
      synced_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_pos_items_order ON pos_order_items (order_no)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_pos_items_dish ON pos_order_items (dish_name)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_pos_items_cat ON pos_order_items (category) WHERE category IS NOT NULL`);
}

// ── Phase 9 helpers: parse KeruYun order data ──

function parseKeruyunDateTime(val) {
  if (!val) return null;
  const s = String(val).trim().replace(/：/g, ':');
  const m = s.match(/(\d{4})[\/\-年](\d{1,2})[\/\-月](\d{1,2})[日]?\s*(\d{1,2})?[：:]?(\d{1,2})?/);
  if (!m) return null;
  const d = `${m[1]}-${m[2].padStart(2,'0')}-${m[3].padStart(2,'0')}T${(m[4]||'0').padStart(2,'0')}:${(m[5]||'0').padStart(2,'0')}:00`;
  const parsed = new Date(d);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function parseKeruyunPhone(val) {
  if (!val || val === '-') return '';
  return String(val).replace(/[^0-9+]/g, '').slice(0, 32);
}

function parseNum(val) {
  const n = Number(String(val || '').replace(/[,，\s¥￥]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

async function linkPosOrdersToCustomers(pool) {
  const r = await pool.query(`
    UPDATE pos_orders o
    SET customer_id = gc.id
    FROM growth_customers gc
    WHERE o.phone <> '' AND o.phone = gc.phone AND o.customer_id IS NULL
  `);
  return r.rowCount;
}

const SCORE_WEIGHTS = { feasibility: 20, fit: 20, cost_risk: 15, case_similarity: 15, clarity: 10, channel: 10, reviewable: 10 };

function computeTotalScore(s) {
  let t = 0;
  if (s.feasibility != null) t += s.feasibility * SCORE_WEIGHTS.feasibility / 100;
  if (s.fit != null) t += s.fit * SCORE_WEIGHTS.fit / 100;
  if (s.cost_risk != null) t += s.cost_risk * SCORE_WEIGHTS.cost_risk / 100;
  if (s.case_similarity != null) t += s.case_similarity * SCORE_WEIGHTS.case_similarity / 100;
  if (s.clarity != null) t += s.clarity * SCORE_WEIGHTS.clarity / 100;
  if (s.channel != null) t += s.channel * SCORE_WEIGHTS.channel / 100;
  if (s.reviewable != null) t += s.reviewable * SCORE_WEIGHTS.reviewable / 100;
  return Math.round(t);
}

export function registerPhaseRoutes(app, pool) {
  function rqa(req, res) {
    const auth = authPhaseApi(req);
    if (!auth.ok) { res.status(auth.status).json({ ok: false, error: auth.error }); return false; }
    return true;
  }

  // ── Phase 1: Coupons ──
  app.post('/api/growth/coupons', async (req, res) => {
    if (!rqa(req, res)) return;
    const b = req.body || {};
    const r = await pool.query(
      `INSERT INTO growth_coupons (coupon_id,name,type,value_fen,price_fen,valid_days,stock,usage_rule,dish_name,is_active,store_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (coupon_id) DO UPDATE SET name=EXCLUDED.name,is_active=EXCLUDED.is_active,updated_at=NOW() RETURNING *`,
      [cleanText(b.coupon_id,128),cleanText(b.name,300),cleanText(b.type||'cash',40),
       Math.max(0,Math.floor(Number(b.value_fen)||0)),Math.max(0,Math.floor(Number(b.price_fen)||0)),
       Math.max(1,Math.floor(Number(b.valid_days)||30)),Math.floor(Number(b.stock)!=null?Number(b.stock):-1),
       cleanText(b.usage_rule,500),cleanText(b.dish_name,500),b.is_active!==false,cleanText(b.store_id,128)]
    );
    res.json({ok:true,coupon:r.rows[0]});
  });
  app.get('/api/growth/coupons', async (req, res) => {
    if (!rqa(req, res)) return;
    const r = await pool.query('SELECT * FROM growth_coupons ORDER BY created_at DESC LIMIT 300');
    res.json({ok:true,coupons:r.rows});
  });

  // ── Phase 1: Sync Failures ──
  app.post('/api/growth/sync-failures', async (req, res) => {
    if (!rqa(req, res)) return;
    const b = req.body || {};
    await pool.query('INSERT INTO growth_sync_failures (source,event_type,payload,error_message) VALUES ($1,$2,$3::jsonb,$4)',
      [cleanText(b.source,80),cleanText(b.event_type,80),JSON.stringify(b.payload||{}),cleanText(b.error_message,2000)]);
    res.json({ok:true});
  });
  app.get('/api/growth/sync-failures', async (req, res) => {
    if (!rqa(req, res)) return;
    const r = await pool.query('SELECT * FROM growth_sync_failures ORDER BY created_at DESC LIMIT 100');
    res.json({ok:true,failures:r.rows});
  });

  // ── Phase 2: WeChat Work ──
  app.post('/api/growth/wechat-work/import-feishu', async (req, res) => {
    if (!rqa(req, res)) return;
    const b = req.body || {};
    const appToken = cleanText(b.app_token, 200);
    const tableId = cleanText(b.table_id, 200);
    const batch = `batch_${Date.now()}`;
    if (!appToken || !tableId) return res.status(400).json({ok:false,error:'missing app_token or table_id'});
    try {
      const mod = await import('../server/index.js');
      const getFeishuBitableData = mod.getFeishuBitableData || (await import('../index.js')).getFeishuBitableData;
      let records = [];
      try { const data = await getFeishuBitableData(appToken, tableId, b.access_token || ''); records = data?.data?.items || data?.data?.records || data?.items || []; } catch (e) { records = []; }
      let imported = 0;
      for (const rec of records) {
        const f = rec.fields || rec;
        const phone = cleanPhone(f.phone||f.手机号||f.mobile||'');
        const name = cleanText(f.name||f.姓名||f.昵称||'',200);
        const eid = cleanText(f.external_userid||f.userid||f.user_id||'',128);
        const sid = cleanText(f.store_id||f.门店||'',128);
        const note = cleanText(f.note||f.备注||'',500);
        if (phone||eid) {
          const ins = await pool.query('INSERT INTO wechat_work_customers(external_userid,name,phone,store_id,note,import_batch) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING RETURNING id',
            [eid,name,phone,sid,note,batch]);
          if (ins.rows.length) imported++;
        }
      }
      const matched = await pool.query(
        `UPDATE wechat_work_customers w SET bind_customer_id=g.id,updated_at=NOW()
         FROM growth_customers g WHERE w.phone=g.phone AND w.bind_customer_id IS NULL AND w.import_batch=$1`,[batch]);
      res.json({ok:true,imported,matched:matched.rowCount||0,batch});
    } catch (e) { res.status(500).json({ok:false,error:e?.message||'import_failed'}); }
  });

  app.post('/api/growth/wechat-work/customers', async (req, res) => {
    if (!rqa(req, res)) return;
    const b = req.body || {};
    const batch = `manual_${Date.now()}`;
    const customers = Array.isArray(b.customers) ? b.customers : [b];
    let imported = 0;
    for (const c of customers) {
      const phone = cleanPhone(c.phone||'');
      if (phone) {
        await pool.query('INSERT INTO wechat_work_customers(external_userid,name,phone,store_id,note,import_batch) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING',
          [cleanText(c.external_userid,128),cleanText(c.name,200),phone,cleanText(c.store_id,128),cleanText(c.note,500),batch]);
        imported++;
      }
    }
    const matched = await pool.query(
      `UPDATE wechat_work_customers w SET bind_customer_id=g.id,updated_at=NOW()
       FROM growth_customers g WHERE w.phone=g.phone AND w.bind_customer_id IS NULL AND w.import_batch=$1`,[batch]);
    res.json({ok:true,imported,matched:matched.rowCount||0,batch});
  });

  app.get('/api/growth/wechat-work/customers', async (req, res) => {
    if (!rqa(req, res)) return;
    const sid = cleanText(req.query.store_id||'',128);
    const r = await pool.query(
      `SELECT w.*,g.openid bound_openid,g.phone bound_phone FROM wechat_work_customers w LEFT JOIN growth_customers g ON w.bind_customer_id=g.id
       WHERE ($1='' OR w.store_id=$1) ORDER BY w.created_at DESC LIMIT 500`,[sid]);
    const total = r.rows.length;
    const bound = r.rows.filter(x=>x.bind_customer_id).length;
    res.json({ok:true,total,bound,unbound:total-bound,customers:r.rows});
  });

  app.get('/api/growth/wechat-work/stats', async (req, res) => {
    if (!rqa(req, res)) return;
    const r = await pool.query(`SELECT store_id,COUNT(*)::int total,
      COUNT(*) FILTER(WHERE bind_customer_id IS NOT NULL)::int bound,
      COUNT(*) FILTER(WHERE bind_customer_id IS NULL)::int unbound
      FROM wechat_work_customers GROUP BY store_id ORDER BY store_id`);
    res.json({ok:true,stats:r.rows});
  });

  // ── Phase 3: Campaign Plans + Rankings ──
  app.post('/api/growth/campaign-plans', async (req, res) => {
    if (!rqa(req, res)) return;
    const b = req.body || {};
    const r = await pool.query(
      `INSERT INTO growth_campaign_plans(plan_id,store_id,campaign_id,title,channel,voucher_template_id,target_audience,budget_fen,status,planned_start,planned_end,created_by)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT(plan_id) DO UPDATE SET title=EXCLUDED.title,status=EXCLUDED.status,updated_at=NOW() RETURNING *`,
      [cleanText(b.plan_id,128),cleanText(b.store_id,128),cleanText(b.campaign_id,128),cleanText(b.title,500),
       cleanText(b.channel,80),cleanText(b.voucher_template_id,128),cleanText(b.target_audience||'all',200),
       Math.max(0,Math.floor(Number(b.budget_fen)||0)),cleanText(b.status||'draft',40),
       b.planned_start?parseOccurredAt(b.planned_start):null,b.planned_end?parseOccurredAt(b.planned_end):null,
       cleanText(b.created_by||'admin',80)]
    );
    res.json({ok:true,plan:r.rows[0]});
  });

  app.get('/api/growth/campaign-plans', async (req, res) => {
    if (!rqa(req, res)) return;
    const sid = cleanText(req.query.store_id||'',128);
    const st = cleanText(req.query.status||'',40);
    const r = await pool.query(`SELECT * FROM growth_campaign_plans WHERE ($1='' OR store_id=$1) AND ($2='' OR status=$2) ORDER BY created_at DESC LIMIT 200`,[sid,st]);
    res.json({ok:true,plans:r.rows});
  });

  app.get('/api/growth/store-rankings', async (req, res) => {
    if (!rqa(req, res)) return;
    const days = Math.min(Math.max(Number(req.query.days)||7,1),90);
    const r = await pool.query(
      `SELECT dm.store_id,SUM(dm.scan_count)::int scan_count,SUM(dm.authorized_count)::int auth_count,
              SUM(dm.coupon_issued_count)::int issued_count,SUM(dm.coupon_redeemed_count)::int redeemed_count,
              SUM(dm.payment_count)::int payment_count,SUM(dm.revenue_fen)::int revenue_fen,
              COUNT(DISTINCT dm.campaign_id)::int active_campaigns
       FROM growth_daily_metrics dm WHERE dm.metric_date>=CURRENT_DATE-($1::int||' days')::interval
       GROUP BY dm.store_id ORDER BY revenue_fen DESC,scan_count DESC LIMIT 200`,[days]);
    res.json({ok:true,rankings:r.rows.map((row,i)=>({rank:i+1,...row}))});
  });

  // ── Phase 7: Strategy Evaluations + Feedback ──
  app.post('/api/growth/strategy-evaluations', async (req, res) => {
    if (!rqa(req, res)) return;
    const b = req.body || {};
    const s = { feasibility:Math.max(0,Math.min(100,Math.floor(Number(b.feasibility_score)||0))),
      fit:Math.max(0,Math.min(100,Math.floor(Number(b.fit_score)||0))),
      cost_risk:Math.max(0,Math.min(100,Math.floor(Number(b.cost_risk_score)||0))),
      case_similarity:Math.max(0,Math.min(100,Math.floor(Number(b.case_similarity_score)||0))),
      clarity:Math.max(0,Math.min(100,Math.floor(Number(b.clarity_score)||0))),
      channel:Math.max(0,Math.min(100,Math.floor(Number(b.channel_score)||0))),
      reviewable:Math.max(0,Math.min(100,Math.floor(Number(b.reviewable_score)||0))) };
    const total = computeTotalScore(s);
    const r = await pool.query(
      `INSERT INTO growth_strategy_evaluations(strategy_key,store_id,campaign_id,title,feasibility_score,fit_score,cost_risk_score,case_similarity_score,clarity_score,channel_score,reviewable_score,total_score,detail,status)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14)
       ON CONFLICT(strategy_key) DO UPDATE SET total_score=EXCLUDED.total_score,detail=EXCLUDED.detail,status=EXCLUDED.status,updated_at=NOW() RETURNING *`,
      [cleanText(b.strategy_key,128),cleanText(b.store_id,128),cleanText(b.campaign_id,128),cleanText(b.title,500),
       s.feasibility,s.fit,s.cost_risk,s.case_similarity,s.clarity,s.channel,s.reviewable,total,
       JSON.stringify(b.detail||{}),cleanText(b.status||'proposed',40)]
    );
    res.json({ok:true,evaluation:r.rows[0]});
  });

  app.get('/api/growth/strategy-evaluations', async (req, res) => {
    if (!rqa(req, res)) return;
    const sid = cleanText(req.query.store_id||'',128);
    const r = await pool.query(`SELECT * FROM growth_strategy_evaluations WHERE ($1='' OR store_id=$1) ORDER BY total_score DESC,created_at DESC LIMIT 200`,[sid]);
    res.json({ok:true,evaluations:r.rows});
  });

  app.post('/api/growth/strategy-feedback', async (req, res) => {
    if (!rqa(req, res)) return;
    const b = req.body || {};
    const sk = cleanText(b.strategy_key,128);
    if (!sk) return res.status(400).json({ok:false,error:'missing strategy_key'});
    const rating = Math.max(0,Math.min(5,Math.floor(Number(b.rating)||0)));
    await pool.query('UPDATE growth_strategy_evaluations SET feedback=$2,feedback_rating=$3,status=COALESCE($4,status),updated_at=NOW() WHERE strategy_key=$1',
      [sk,cleanText(b.feedback,4000),rating,cleanText(b.status,40)]);
    res.json({ok:true});
  });

  // ── Phase 8: Content Calendar + Channel Effects ──
  app.post('/api/growth/content-calendar', async (req, res) => {
    if (!rqa(req, res)) return;
    const b = req.body || {};
    const r = await pool.query(
      `INSERT INTO growth_content_calendar(item_id,store_id,channel,publish_date,title,content_brief,copy_text,image_url,campaign_id,qr_scene,status,assignee_username)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT(item_id) DO UPDATE SET title=EXCLUDED.title,copy_text=EXCLUDED.copy_text,status=EXCLUDED.status,updated_at=NOW() RETURNING *`,
      [cleanText(b.item_id,128),cleanText(b.store_id,128),cleanText(b.channel,80),
       b.publish_date?b.publish_date.slice(0,10):new Date().toISOString().slice(0,10),cleanText(b.title,500),
       cleanText(b.content_brief,2000),cleanText(b.copy_text,4000),cleanText(b.image_url,1000),
       cleanText(b.campaign_id,128),cleanText(b.qr_scene,255),cleanText(b.status||'draft',40),cleanText(b.assignee_username,128)]
    );
    res.json({ok:true,item:r.rows[0]});
  });

  app.get('/api/growth/content-calendar', async (req, res) => {
    if (!rqa(req, res)) return;
    const sid = cleanText(req.query.store_id||'',128);
    const ch = cleanText(req.query.channel||'',80);
    const r = await pool.query(`SELECT * FROM growth_content_calendar WHERE ($1='' OR store_id=$1) AND ($2='' OR channel=$2) ORDER BY publish_date DESC LIMIT 300`,[sid,ch]);
    res.json({ok:true,items:r.rows});
  });

  app.get('/api/growth/content-calendar/upcoming', async (req, res) => {
    if (!rqa(req, res)) return;
    const sid = cleanText(req.query.store_id||'',128);
    const r = await pool.query(`SELECT * FROM growth_content_calendar WHERE publish_date>=CURRENT_DATE AND ($1='' OR store_id=$1) ORDER BY publish_date ASC LIMIT 30`,[sid]);
    res.json({ok:true,items:r.rows});
  });

  app.get('/api/growth/channel-effects', async (req, res) => {
    if (!rqa(req, res)) return;
    const days = Math.min(Math.max(Number(req.query.days)||30,1),365);
    const r = await pool.query(
      `SELECT gc.channel,COUNT(*)::int total_items,
              COUNT(*) FILTER(WHERE gc.status='published')::int published,
              SUM(gc.result_scan_count)::int total_scans,
              SUM(gc.result_revenue_fen)::int total_revenue_fen
       FROM growth_content_calendar gc WHERE gc.publish_date>=CURRENT_DATE-($1::int||' days')::interval
       GROUP BY gc.channel ORDER BY total_revenue_fen DESC`,[days]);
    res.json({ok:true,effects:r.rows});
  });

  // ── Phase 9: POS Orders (KeruYun via Feishu bitable or direct upload) ──

  app.post('/api/growth/pos-orders', async (req, res) => {
    if (!rqa(req, res)) return;
    const b = req.body || {};
    const { orders = [], items = [] } = b;
    if (!orders.length && !items.length) return res.status(400).json({ok:false,error:'missing orders or items'});

    const storeId = cleanText(b.store_id || '', 128);
    let ordersUpserted = 0, itemsUpserted = 0;

    if (orders.length) {
      for (const o of orders) {
        const phone = parseKeruyunPhone(o.phone || o.member_phone || '');
        const bizDate = (o.biz_date || '').toString().trim().replace(/[\/年]/g, '-').replace(/月/g, '-').replace(/日/g, '');
        await pool.query(`
          INSERT INTO pos_orders(seq_no,order_no,order_source,biz_date,order_time,checkout_time,order_status,total_amount,total_discount,payment_method,payment_count,revenue,member_name,phone,order_type,table_no,diners,duration,store_id)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
          ON CONFLICT(order_no) DO UPDATE SET
            order_source=EXCLUDED.order_source,
            checkout_time=COALESCE(EXCLUDED.checkout_time,pos_orders.checkout_time),
            order_status=COALESCE(EXCLUDED.order_status,pos_orders.order_status),
            total_amount=EXCLUDED.total_amount,total_discount=EXCLUDED.total_discount,
            revenue=EXCLUDED.revenue,
            payment_method=COALESCE(EXCLUDED.payment_method,pos_orders.payment_method),
            payment_count=EXCLUDED.payment_count,
            phone=COALESCE(NULLIF(EXCLUDED.phone,''),pos_orders.phone),
            member_name=COALESCE(NULLIF(EXCLUDED.member_name,'-'),NULLIF(EXCLUDED.member_name,''),pos_orders.member_name),
            table_no=COALESCE(NULLIF(EXCLUDED.table_no,''),pos_orders.table_no),
            diners=COALESCE(EXCLUDED.diners,pos_orders.diners),
            duration=COALESCE(NULLIF(EXCLUDED.duration,''),pos_orders.duration),
            seq_no=COALESCE(NULLIF(EXCLUDED.seq_no,''),pos_orders.seq_no),
            synced_at=NOW()
        `, [
          cleanText(o.seq_no || '', 32), cleanText(o.order_no || '', 64),
          cleanText(o.order_source || '', 80), bizDate || null,
          parseKeruyunDateTime(o.order_time), parseKeruyunDateTime(o.checkout_time),
          cleanText(o.order_status || '', 40), parseNum(o.total_amount), parseNum(o.total_discount),
          cleanText(o.payment_method || '', 80), Number(o.payment_count) || 0,
          parseNum(o.revenue),
          cleanText(o.member_name || '', 100), phone,
          cleanText(o.order_type || '', 40), cleanText(o.table_no || '', 40),
          Number(o.diners) || null, cleanText(o.duration || '', 40),
          storeId || cleanText(o.store_id || '', 128)
        ]);
        ordersUpserted++;
      }
    }

    if (items.length) {
      for (const it of items) {
        const itemBizDate = (it.biz_date || '').toString().trim().replace(/[\/年]/g, '-').replace(/月/g, '-').replace(/日/g, '');
        await pool.query(`
          INSERT INTO pos_order_items(biz_date,store_code,store_name,order_no,sku,dish_name,spec,tags,unit_price,qty,unit,subtotal,service_fee,discount,item_revenue,category_mid,category)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
          ON CONFLICT DO NOTHING
        `, [
          itemBizDate || null, cleanText(it.store_code || '', 64), cleanText(it.store_name || '', 200),
          cleanText(it.order_no || '', 64), cleanText(it.sku || '', 64), cleanText(it.dish_name || '', 300),
          cleanText(it.spec || '', 100), cleanText(it.tags || '', 500),
          parseNum(it.unit_price), parseNum(it.qty), cleanText(it.unit || '', 20),
          parseNum(it.subtotal), parseNum(it.service_fee),
          parseNum(it.discount), parseNum(it.item_revenue),
          cleanText(it.category_mid || '', 100), cleanText(it.category || '', 100)
        ]);
        itemsUpserted++;
      }
    }

    const linked = await linkPosOrdersToCustomers(pool);
    res.json({ok:true, orders_upserted: ordersUpserted, items_upserted: itemsUpserted, customers_linked: linked});
  });

  app.get('/api/growth/pos-orders', async (req, res) => {
    if (!rqa(req, res)) return;
    const sid = cleanText(req.query.store_id || '', 128);
    const phone = cleanText(req.query.phone || '', 32);
    const from = req.query.from || '';
    const to = req.query.to || '';
    const limit = Math.min(Math.max(Number(req.query.limit) || 200, 1), 1000);
    const conds = ['1=1'];
    const params = [];
    let pi = 1;
    if (sid) { conds.push(`store_id=$${pi++}`); params.push(sid); }
    if (phone) { conds.push(`phone=$${pi++}`); params.push(phone); }
    if (from) { conds.push(`biz_date>=$${pi++}`); params.push(from); }
    if (to) { conds.push(`biz_date<=$${pi++}`); params.push(to); }
    params.push(limit);
    const r = await pool.query(`SELECT * FROM pos_orders WHERE ${conds.join(' AND ')} ORDER BY biz_date DESC, order_time DESC LIMIT $${pi}`, params);
    res.json({ok:true, orders: r.rows});
  });

  app.get('/api/growth/pos-order-items', async (req, res) => {
    if (!rqa(req, res)) return;
    const orderNo = cleanText(req.query.order_no || '', 64);
    if (!orderNo) return res.status(400).json({ok:false,error:'missing order_no'});
    const r = await pool.query('SELECT * FROM pos_order_items WHERE order_no=$1 ORDER BY id', [orderNo]);
    res.json({ok:true, items: r.rows});
  });

  app.get('/api/growth/customer-orders', async (req, res) => {
    if (!rqa(req, res)) return;
    const phone = cleanText(req.query.phone || '', 32);
    const cid = req.query.customer_id ? Number(req.query.customer_id) : null;
    if (!phone && !cid) return res.status(400).json({ok:false,error:'missing phone or customer_id'});
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
    let r;
    if (phone) {
      r = await pool.query('SELECT * FROM pos_orders WHERE phone=$1 ORDER BY biz_date DESC LIMIT $2', [phone, limit]);
    } else {
      r = await pool.query('SELECT * FROM pos_orders WHERE customer_id=$1 ORDER BY biz_date DESC LIMIT $2', [cid, limit]);
    }
    res.json({ok:true, orders: r.rows});
  });

  app.get('/api/growth/pos-linked-customers', async (req, res) => {
    if (!rqa(req, res)) return;
    const sid = cleanText(req.query.store_id || '', 128);
    const days = Math.min(Math.max(Number(req.query.days) || 30, 1), 365);
    const r = await pool.query(`
      SELECT po.phone, gc.id AS customer_id, gc.openid, gcp.lifecycle_stage, gcp.price_sensitivity,
             COUNT(*)::int AS order_count, SUM(po.revenue) AS total_revenue,
             MIN(po.biz_date) AS first_order, MAX(po.biz_date) AS last_order
      FROM pos_orders po
      LEFT JOIN growth_customers gc ON po.phone = gc.phone
      LEFT JOIN growth_customer_profiles gcp ON gc.id = gcp.customer_id
      WHERE po.phone <> '' AND po.biz_date >= CURRENT_DATE - ($1::int || ' days')::interval
        AND ($2='' OR po.store_id=$2)
      GROUP BY po.phone, gc.id, gc.openid, gcp.lifecycle_stage, gcp.price_sensitivity
      ORDER BY total_revenue DESC NULLS LAST LIMIT 200
    `, [days, sid]);
    res.json({ok:true, linked: r.rows});
  });

  app.post('/api/growth/pos-link-customers', async (req, res) => {
    if (!rqa(req, res)) return;
    const linked = await linkPosOrdersToCustomers(pool);
    res.json({ok:true, customers_linked: linked});
  });

  // ── Phase 9: Feishu bitable sync config for POS orders ──
  app.get('/api/growth/pos-feishu-config', async (req, res) => {
    if (!rqa(req, res)) return;
    const r = await pool.query(`SELECT data FROM hrms_state WHERE key = 'pos_feishu_config' LIMIT 1`);
    const config = r.rows?.[0]?.data || null;
    res.json({ok:true, config});
  });

  app.post('/api/growth/pos-feishu-config', async (req, res) => {
    if (!rqa(req, res)) return;
    const b = req.body || {};
    const config = {
      orders_app_token: cleanText(b.orders_app_token || '', 200),
      orders_table_id: cleanText(b.orders_table_id || '', 200),
      items_app_token: cleanText(b.items_app_token || '', 200),
      items_table_id: cleanText(b.items_table_id || '', 200),
      store_id: cleanText(b.store_id || '', 128)
    };
    if (!config.orders_app_token || !config.orders_table_id)
      return res.status(400).json({ok:false,error:'missing orders_app_token or orders_table_id'});
    await pool.query(
      `INSERT INTO hrms_state (key, data, updated_at) VALUES ('pos_feishu_config', $1::jsonb, NOW())
       ON CONFLICT (key) DO UPDATE SET data = $1::jsonb, updated_at = NOW()`,
      [JSON.stringify(config)]
    );
    res.json({ok:true, config});
  });

  app.post('/api/growth/pos-feishu-sync', async (req, res) => {
    if (!rqa(req, res)) return;
    const b = req.body || {};
    const override = b.config || null;

    let config = override;
    if (!config) {
      const cr = await pool.query(`SELECT data FROM hrms_state WHERE key = 'pos_feishu_config' LIMIT 1`);
      config = cr.rows?.[0]?.data || null;
    }
    if (!config) return res.status(400).json({ok:false,error:'no pos_feishu_config found, POST /api/growth/pos-feishu-config first'});

    const LARK_APP_ID = process.env.LARK_APP_ID || process.env.FEISHU_APP_ID || '';
    const LARK_APP_SECRET = process.env.LARK_APP_SECRET || process.env.FEISHU_APP_SECRET || '';
    if (!LARK_APP_ID || !LARK_APP_SECRET) return res.status(503).json({ok:false,error:'LARK_APP_ID/LARK_APP_SECRET not configured'});

    let tenantToken = '';
    try {
      const tr = await (await import('node-fetch')).default('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
        method: 'POST', headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({app_id: LARK_APP_ID, app_secret: LARK_APP_SECRET})
      }).then(r => r.json());
      tenantToken = tr.tenant_access_token || '';
    } catch (e) { return res.status(502).json({ok:false,error:'lark_token_failed',detail: e.message}); }
    if (!tenantToken) return res.status(502).json({ok:false,error:'lark_token_empty'});

    const storeId = config.store_id || '';
    let totalOrders = 0, totalItems = 0, totalLinked = 0;

    // ── Sync orders table ──
    if (config.orders_app_token && config.orders_table_id) {
      const ORDERS_FIELD_MAP = {
        '编号': 'seq_no', '订单号': 'order_no', '订单来源': 'order_source',
        '营业日': 'biz_date', '下单时间': 'order_time', '结账时间': 'checkout_time',
        '订单状态': 'order_status', '订单金额': 'total_amount', '总优惠金额': 'total_discount',
        '支付方式': 'payment_method', '支付笔数': 'payment_count', '订单收入': 'revenue',
        '会员姓名': 'member_name', '会员手机号': 'phone', '订单类型': 'order_type',
        '桌台': 'table_no', '就餐人数': 'diners', '就餐时长': 'duration'
      };
      let pageToken = '';
      let ordersBatch = [];
      do {
        const url = `https://open.feishu.cn/open-apis/bitable/v1/apps/${config.orders_app_token}/tables/${config.orders_table_id}/records?page_size=500${pageToken ? '&page_token=' + pageToken : ''}`;
        const resp = await (await import('node-fetch')).default(url, {headers: {'Authorization': 'Bearer ' + tenantToken}}).then(r => r.json());
        if (resp.code !== 0) return res.status(502).json({ok:false,error:'orders_bitable_error', detail: resp.msg});
        const items = resp.data?.items || [];
        for (const rec of items) {
          const f = rec.fields || {};
          const order = {store_id: storeId};
          for (const [cn, en] of Object.entries(ORDERS_FIELD_MAP)) {
            const val = f[cn];
            if (val != null) order[en] = typeof val === 'object' ? (val.text || val.link || val.name || JSON.stringify(val)) : val;
          }
          if (order.order_no) ordersBatch.push(order);
        }
        pageToken = resp.data?.has_more ? (resp.data.page_token || '') : '';
      } while (pageToken);

      if (ordersBatch.length) {
        const sr = await (await import('node-fetch')).default('https://nnyx.cc/api/growth/pos-orders', {
          method: 'POST', headers: {'Authorization': 'Bearer ' + (process.env.MINIPROGRAM_SYNC_SECRET || ''), 'Content-Type': 'application/json'},
          body: JSON.stringify({store_id: storeId, orders: ordersBatch, items: []})
        }).then(r => r.json());
        totalOrders = sr.orders_upserted || 0;
      }
    }

    // ── Sync items table ──
    if (config.items_app_token && config.items_table_id) {
      const ITEMS_FIELD_MAP = {
        '营业日': 'biz_date', '门店编号': 'store_code', '门店名称': 'store_name',
        '订单号': 'order_no', '商品编码': 'sku', '商品名称': 'dish_name',
        '规格': 'spec', '菜品标签': 'tags', '单价': 'unit_price', '数量': 'qty',
        '单位': 'unit', '菜品合计金额': 'subtotal', '服务费分摊': 'service_fee',
        '菜品优惠': 'discount', '菜品收入': 'item_revenue', '商品中类': 'category_mid',
        '商品大类': 'category'
      };
      let pageToken = '';
      let itemsBatch = [];
      do {
        const url = `https://open.feishu.cn/open-apis/bitable/v1/apps/${config.items_app_token}/tables/${config.items_table_id}/records?page_size=500${pageToken ? '&page_token=' + pageToken : ''}`;
        const resp = await (await import('node-fetch')).default(url, {headers: {'Authorization': 'Bearer ' + tenantToken}}).then(r => r.json());
        if (resp.code !== 0) return res.status(502).json({ok:false,error:'items_bitable_error', detail: resp.msg});
        const records = resp.data?.items || [];
        for (const rec of records) {
          const f = rec.fields || {};
          const item = {};
          for (const [cn, en] of Object.entries(ITEMS_FIELD_MAP)) {
            const val = f[cn];
            if (val != null) item[en] = typeof val === 'object' ? (val.text || val.link || val.name || JSON.stringify(val)) : val;
          }
          if (item.order_no) itemsBatch.push(item);
        }
        pageToken = resp.data?.has_more ? (resp.data.page_token || '') : '';
      } while (pageToken);

      if (itemsBatch.length) {
        const sr = await (await import('node-fetch')).default('https://nnyx.cc/api/growth/pos-orders', {
          method: 'POST', headers: {'Authorization': 'Bearer ' + (process.env.MINIPROGRAM_SYNC_SECRET || ''), 'Content-Type': 'application/json'},
          body: JSON.stringify({store_id: storeId, orders: [], items: itemsBatch})
        }).then(r => r.json());
        totalItems = sr.items_upserted || 0;
      }
    }

    totalLinked = await linkPosOrdersToCustomers(pool);
    res.json({ok:true, orders_synced: totalOrders, items_synced: totalItems, customers_linked: totalLinked});
  });
}
