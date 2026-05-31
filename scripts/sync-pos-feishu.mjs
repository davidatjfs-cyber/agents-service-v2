import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

function requireWorkspaceModule(moduleName) {
  const candidates = [
    path.join(__dirname, '..', 'agents-service-v2', 'node_modules', moduleName),
    path.join(__dirname, '..', 'hr-management-system', 'server', 'node_modules', moduleName)
  ];

  for (const candidate of candidates) {
    try {
      return require(candidate);
    } catch (err) {
      if (err && err.code !== 'MODULE_NOT_FOUND') throw err;
    }
  }

  throw new Error(`Cannot resolve workspace module: ${moduleName}`);
}

const pg = requireWorkspaceModule('pg');
const axios = requireWorkspaceModule('axios');

const POOL = new pg.Pool({ connectionString: 'postgres://hrms:Abc1234567!@127.0.0.1:5432/hrms' });

const clean = (v, m = 255) => String(v == null ? '' : v).trim().slice(0, m);
const num = v => { const n = Number(String(v || '').replace(/[,，\s¥￥]/g, '')); return isFinite(n) ? n : 0; };
const phone = v => (!v || v === '-') ? '' : String(v).replace(/[^0-9+]/g, '').slice(0, 32);

function parseDt(val) {
  if (!val) return null;
  const n = Number(val);
  if (isFinite(n) && n > 1e12) return new Date(n).toISOString();
  const s = String(val).trim().replace(/：/g, ':');
  const m = s.match(/(\d{4})[\/\-年](\d{1,2})[\/\-月](\d{1,2})[日]?\s*(\d{1,2})?[：:]?(\d{1,2})?/);
  if (!m) return null;
  return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}T${(m[4] || '0').padStart(2, '0')}:${(m[5] || '0').padStart(2, '0')}:00`;
}

function cnDate(val) {
  if (!val) return null;
  const ts = Number(val);
  if (isFinite(ts) && ts > 1e12) return new Date(ts + 28800000).toISOString().slice(0, 10);
  const d = parseDt(val);
  if (d) return new Date(new Date(d).getTime() + 28800000).toISOString().slice(0, 10);
  return String(val).trim().replace(/[\/年]/g, '-').replace(/月/g, '-').replace(/日/g, '') || null;
}

const storeCode = sn => {
  if (sn.includes('洪潮')) return '64822111';
  if (sn.includes('马己仙')) return '51866138';
  return '';
};

const FILTER = encodeURIComponent(JSON.stringify({
  conjunction: 'and',
  conditions: [
    { field_name: '门店名称', operator: 'contains', value: '洪潮' },
    { field_name: '营业日', operator: 'greaterThanOrEqual', value: '2026-03-01' },
    { field_name: '营业日', operator: 'lessThanOrEqual', value: '2026-04-30' }
  ]
}));

const OF = { '编号': 'seq_no', '订单号': 'order_no', '订单来源': 'order_source', '营业日': 'biz_date', '下单时间': 'order_time', '结账时间': 'checkout_time', '订单状态': 'order_status', '折前金额': 'amount_before_discount', '总优惠金额': 'total_discount', '折后金额': 'amount_after_discount', '支付方式': 'payment_method', '支付笔数': 'payment_count', '会员姓名': 'member_name', '会员手机号': 'phone', '订单类型': 'order_type', '桌台': 'table_no', '就餐人数': 'diners', '就餐时长': 'duration', '就餐时长(分钟）': 'duration', '门店名称': 'store_name' };
const IF = { '营业日期': 'biz_date', '营业日': 'biz_date', '门店名称': 'store_name', '菜品名称': 'dish_name', '出品部门': 'department', '桌台名称': 'table_name', '桌台区域': 'table_area', '销售类型': 'sale_type', '菜品编码': 'sku', '大类名称': 'category', '中类名称': 'category_mid', '规格': 'spec', '单位': 'unit', '订单号': 'order_no', '订单类型': 'order_type', '订单来源': 'order_source', '销售数量': 'qty', '折前金额': 'amount_before_discount', '优惠金额': 'discount', '服务费分摊收入': 'service_fee', '折后金额': 'amount_after_discount', '下单时间': 'order_time', '结账时间': 'checkout_time' };

async function getToken() {
  const { data } = await axios.post('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal',
    { app_id: 'cli_a9fc0d13c838dcd6', app_secret: 'pRVuBmiWc0hzqP1YzZDqzGUPFlaProDN' },
    { headers: { 'Content-Type': 'application/json' }, timeout: 10000 });
  return data.tenant_access_token;
}

async function fetchAll(baseUrl, fieldMap) {
  let pt = '', all = [];
  do {
    const url = baseUrl + (pt ? '&page_token=' + pt : '');
    const r = (await axios.get(url, { headers: { Authorization: 'Bearer ' + token }, timeout: 30000 })).data;
    if (r.code !== 0) throw new Error(r.msg || r.code);
    for (const rec of (r.data?.items || [])) {
      const f = rec.fields || {}, obj = {};
      for (const [cn, en] of Object.entries(fieldMap)) {
        const v = f[cn];
        if (v != null) obj[en] = typeof v === 'object' ? (v.text || v.link || v.name || JSON.stringify(v)) : v;
      }
      if (obj.order_no) all.push(obj);
    }
    process.stdout.write(`  fetched ${all.length} records\r`);
    pt = (r.data?.has_more && r.data?.page_token) ? r.data.page_token : '';
  } while (pt);
  console.log();
  return all;
}

const token = await getToken();
console.log('Token OK');

console.log('Fetching orders...');
const ordersBase = `https://open.feishu.cn/open-apis/bitable/v1/apps/PTWrbUdcbarCshst0QncMoY7nKe/tables/tblNsthCuj5siXLo/records?page_size=500&filter=${FILTER}`;
const orders = await fetchAll(ordersBase, OF);
console.log('Orders:', orders.length);

console.log('Fetching items...');
const itemsBase = `https://open.feishu.cn/open-apis/bitable/v1/apps/PTWrbUdcbarCshst0QncMoY7nKe/tables/tblQkfRUGDaR75ja/records?page_size=500&filter=${FILTER}`;
const items = await fetchAll(itemsBase, IF);
console.log('Items:', items.length);

// Upsert orders
let oc = 0;
for (const o of orders) {
  try {
    const sid = storeCode(clean(o.store_name || '', 200));
    await POOL.query(`INSERT INTO pos_orders(seq_no,order_no,order_source,biz_date,order_time,checkout_time,order_status,amount_before_discount,total_discount,amount_after_discount,payment_method,payment_count,member_name,phone,order_type,table_no,diners,duration,store_name,store_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
      ON CONFLICT(order_no) DO UPDATE SET
        order_source=EXCLUDED.order_source, checkout_time=COALESCE(EXCLUDED.checkout_time,pos_orders.checkout_time),
        order_status=COALESCE(EXCLUDED.order_status,pos_orders.order_status),
        amount_before_discount=EXCLUDED.amount_before_discount,total_discount=EXCLUDED.total_discount,
        amount_after_discount=EXCLUDED.amount_after_discount,
        payment_method=COALESCE(EXCLUDED.payment_method,pos_orders.payment_method),
        payment_count=EXCLUDED.payment_count,
        phone=COALESCE(NULLIF(EXCLUDED.phone,''),pos_orders.phone),
        member_name=COALESCE(NULLIF(EXCLUDED.member_name,'-'),NULLIF(EXCLUDED.member_name,''),pos_orders.member_name),
        table_no=COALESCE(NULLIF(EXCLUDED.table_no,''),pos_orders.table_no),
        diners=COALESCE(EXCLUDED.diners,pos_orders.diners),
        duration=COALESCE(NULLIF(EXCLUDED.duration,''),pos_orders.duration),
        store_name=COALESCE(NULLIF(EXCLUDED.store_name,''),pos_orders.store_name),
        seq_no=COALESCE(NULLIF(EXCLUDED.seq_no,''),pos_orders.seq_no), synced_at=NOW()`,
      [clean(o.seq_no||'',32), clean(o.order_no||'',64), clean(o.order_source||'',80),
        cnDate(o.biz_date)||null, parseDt(o.order_time), parseDt(o.checkout_time),
        clean(o.order_status||'',40), num(o.amount_before_discount), num(o.total_discount),
        num(o.amount_after_discount), clean(o.payment_method||'',80), Number(o.payment_count)||0,
        clean(o.member_name||'',100), phone(o.phone||''), clean(o.order_type||'',40),
        clean(o.table_no||'',40), Number(o.diners)||null, clean(o.duration||'',40),
        clean(o.store_name||'',200), sid]);
    oc++;
  } catch (e) { console.error('order err:', e.message, o.order_no); }
}
console.log('Orders upserted:', oc);

// Upsert items
let ic = 0;
for (const it of items) {
  try {
    const sn = clean(it.store_name || '', 200);
    await POOL.query(`INSERT INTO pos_order_items(biz_date,store_name,store_code,order_no,sku,dish_name,department,table_name,table_area,sale_type,category_mid,category,spec,unit,order_type,order_source,qty,amount_before_discount,discount,service_fee,amount_after_discount,order_time,checkout_time)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)
      ON CONFLICT DO NOTHING`,
      [cnDate(it.biz_date)||null, sn, storeCode(sn),
        clean(it.order_no||'',128), clean(it.sku||'',64), clean(it.dish_name||'',300),
        clean(it.department||'',100), clean(it.table_name||'',100), clean(it.table_area||'',100),
        clean(it.sale_type||'',40), clean(it.category_mid||'',100), clean(it.category||'',100),
        clean(it.spec||'',100), clean(it.unit||'',20), clean(it.order_type||'',40), clean(it.order_source||'',200),
        num(it.qty), num(it.amount_before_discount),
        num(it.discount), num(it.service_fee), num(it.amount_after_discount),
        parseDt(it.order_time), parseDt(it.checkout_time)]);
    ic++;
  } catch (e) { console.error('item err:', e.message, it.order_no); }
}
console.log('Items upserted:', ic);

// Link customers
const lr = await POOL.query(`UPDATE pos_orders o SET customer_id = gc.id FROM growth_customers gc WHERE o.phone <> '' AND o.phone = gc.phone AND o.customer_id IS NULL`);
console.log('Customers linked:', lr.rowCount);

// Refresh snapshot
const sr = await POOL.query(`INSERT INTO sales_growth_snapshot (snapshot_date,store_code,dish_name,category,order_count,qty,revenue,avg_unit_price,lunch_qty,dinner_qty,updated_at)
  SELECT i.biz_date, COALESCE(i.store_code,''), COALESCE(i.dish_name,''), COALESCE(MAX(i.category),''),
    COUNT(DISTINCT i.order_no), SUM(i.qty)::INT, SUM(i.amount_after_discount),
    CASE WHEN SUM(i.qty)>0 THEN ROUND(SUM(i.amount_after_discount)/SUM(i.qty),2) ELSE 0 END,
    SUM(CASE WHEN EXTRACT(HOUR FROM i.order_time AT TIME ZONE 'Asia/Shanghai') BETWEEN 10 AND 13 THEN i.qty ELSE 0 END)::INT,
    SUM(CASE WHEN EXTRACT(HOUR FROM i.order_time AT TIME ZONE 'Asia/Shanghai') BETWEEN 16 AND 20 THEN i.qty ELSE 0 END)::INT, NOW()
  FROM pos_order_items i
  WHERE i.biz_date>='2026-03-01' AND i.biz_date<='2026-04-30'
    AND i.dish_name IS NOT NULL AND i.dish_name<>''
    AND i.store_code IS NOT NULL AND i.store_code<>''
  GROUP BY i.biz_date, i.store_code, i.dish_name
  ON CONFLICT (snapshot_date,store_code,dish_name)
  DO UPDATE SET category=EXCLUDED.category, order_count=EXCLUDED.order_count,
    qty=EXCLUDED.qty, revenue=EXCLUDED.revenue, avg_unit_price=EXCLUDED.avg_unit_price,
    lunch_qty=EXCLUDED.lunch_qty, dinner_qty=EXCLUDED.dinner_qty, updated_at=NOW()`);
console.log('Snapshot rows:', sr.rowCount);

await POOL.end();
console.log('=== DONE ===');
