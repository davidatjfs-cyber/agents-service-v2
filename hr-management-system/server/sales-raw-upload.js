let _pool = null;
export function setSalesRawPool(p) { _pool = p; }
function gp() { if (!_pool) throw new Error('pool not set'); return _pool; }

const QUALITY_THRESHOLDS = {
  takeawayMinCoveragePct: 90,
  dineinMinCoveragePct: 95,
  skuCompletenessWarnPct: 70
};

function normalizeDishName(raw) {
  let s = String(raw || '').trim();
  if (!s) return '';
  const trad = {
    '魚':'鱼','雞':'鸡','鴨':'鸭','鵝':'鹅','雜':'杂','滷':'卤','燒':'烧','湯':'汤','飯':'饭','麵':'面','餅':'饼','凍':'冻','鮮':'鲜','廣':'广','銷':'销','順':'顺','蔥':'葱','薑':'姜','蝦':'虾','蠔':'蚝','鍋':'锅','鑊':'镬','龍':'龙','頸':'颈','風':'风','號':'号','東':'东'
  };
  const numMap = {'0':'零','1':'一','2':'二','3':'三','4':'四','5':'五','6':'六','7':'七','8':'八','9':'九'};
  s = s.replace(/【[^】]*】|（[^）]*）|\([^)]*\)|\[[^\]]*\]/g, '');
  s = s.split('').map((ch) => trad[ch] || numMap[ch] || ch).join('');
  s = s.replace(/[\s_/+·,，。、“”‘’!！?？:：;；'"~～()（）\[\]【】-]/g, '');
  return s.toLowerCase();
}

function normalizeBiz(v) {
  const s = String(v || '').trim().toLowerCase();
  if (/外卖|takeaway|delivery/.test(s)) return 'takeaway';
  if (/堂食|dinein/.test(s)) return 'dinein';
  return '';
}

function bizThreshold(bizType) {
  return bizType === 'takeaway' ? QUALITY_THRESHOLDS.takeawayMinCoveragePct : QUALITY_THRESHOLDS.dineinMinCoveragePct;
}

async function ensureSalesRawSchema(client) {
  try {
    await client.query(`ALTER TABLE sales_raw ADD COLUMN IF NOT EXISTS dish_code VARCHAR(120)`);
    return true;
  } catch (e) {
    const msg = String(e?.message || e);
    if (/must be owner|permission denied|not owner/i.test(msg)) {
      console.warn('[sales-raw] skip schema alter for sales_raw.dish_code:', msg);
      return false;
    }
    throw e;
  }
}

async function buildAliasMap(store, bizType) {
  const p = gp();
  const rows = await p.query(
    `SELECT alias_name, canonical_name
     FROM dish_name_aliases
     WHERE enabled = TRUE
       AND (
         lower(regexp_replace(COALESCE(store, '*'), '\\s+', '', 'g')) = lower(regexp_replace($1, '\\s+', '', 'g'))
         OR COALESCE(NULLIF(trim(store), ''), '*') = '*'
       )
       AND (
         (lower(regexp_replace(COALESCE(biz_type, ''), '\\s+', '', 'g')) IN ('takeaway','delivery','外卖','外送') AND $2 = 'takeaway')
         OR (lower(regexp_replace(COALESCE(biz_type, ''), '\\s+', '', 'g')) IN ('dinein','堂食','店内','堂食点餐') AND $2 = 'dinein')
         OR COALESCE(NULLIF(trim(biz_type), ''), '*') IN ('*', 'all', 'ALL', '全部', '通用')
       )
     ORDER BY
       CASE
         WHEN lower(regexp_replace(COALESCE(biz_type, ''), '\\s+', '', 'g')) IN ('takeaway','delivery','外卖','外送') AND $2 = 'takeaway' THEN 0
         WHEN lower(regexp_replace(COALESCE(biz_type, ''), '\\s+', '', 'g')) IN ('dinein','堂食','店内','堂食点餐') AND $2 = 'dinein' THEN 0
         WHEN COALESCE(NULLIF(trim(biz_type), ''), '*') IN ('*', 'all', 'ALL', '全部', '通用') THEN 1
         ELSE 2
       END,
       CASE WHEN COALESCE(NULLIF(trim(store), ''), '*') = '*' THEN 2 ELSE 1 END,
       updated_at DESC`,
    [store, bizType]
  );

  const map = new Map();
  for (const row of rows.rows || []) {
    const aliasNorm = normalizeDishName(row.alias_name);
    const canonical = String(row.canonical_name || '').trim();
    if (!aliasNorm || !canonical) continue;
    if (!map.has(aliasNorm)) map.set(aliasNorm, canonical);
  }
  return map;
}

async function buildCostMap(store, bizType) {
  const p = gp();
  const rows = await p.query(
    `SELECT dish_name, unit_cost
     FROM dish_library_costs
     WHERE enabled = TRUE
       AND (
         lower(regexp_replace(COALESCE(store, '*'), '\\s+', '', 'g')) = lower(regexp_replace($1, '\\s+', '', 'g'))
         OR COALESCE(NULLIF(trim(store), ''), '*') = '*'
       )
       AND (
         (lower(regexp_replace(COALESCE(biz_type, ''), '\\s+', '', 'g')) IN ('takeaway','delivery','外卖','外送') AND $2 = 'takeaway')
         OR (lower(regexp_replace(COALESCE(biz_type, ''), '\\s+', '', 'g')) IN ('dinein','堂食','店内','堂食点餐') AND $2 = 'dinein')
         OR COALESCE(NULLIF(trim(biz_type), ''), '*') IN ('*', 'all', 'ALL', '全部', '通用')
       )
     ORDER BY
       CASE
         WHEN lower(regexp_replace(COALESCE(biz_type, ''), '\\s+', '', 'g')) IN ('takeaway','delivery','外卖','外送') AND $2 = 'takeaway' THEN 0
         WHEN lower(regexp_replace(COALESCE(biz_type, ''), '\\s+', '', 'g')) IN ('dinein','堂食','店内','堂食点餐') AND $2 = 'dinein' THEN 0
         WHEN COALESCE(NULLIF(trim(biz_type), ''), '*') IN ('*', 'all', 'ALL', '全部', '通用') THEN 1
         ELSE 2
       END,
       CASE WHEN COALESCE(NULLIF(trim(store), ''), '*') = '*' THEN 2 ELSE 1 END,
       updated_at DESC`,
    [store, bizType]
  );

  const map = new Map();
  for (const row of rows.rows || []) {
    const key = normalizeDishName(row.dish_name);
    if (!key || map.has(key)) continue;
    const cost = Number(row.unit_cost || 0);
    if (!Number.isFinite(cost)) continue;
    map.set(key, cost);
  }
  return map;
}

export async function evaluateSalesRawUploadQuality(rows, store, bizType, opts = {}) {
  const list = Array.isArray(rows) ? rows : [];
  const targetBiz = normalizeBiz(bizType) || 'dinein';
  const thresholdPct = Number(opts.thresholdPct || bizThreshold(targetBiz));
  if (!list.length) {
    return {
      pass: false,
      thresholdPct,
      salesCoveragePct: 0,
      revenueCoveragePct: 0,
      skuCompletenessPct: 0,
      unmatchedTop: []
    };
  }

  const aliasMap = await buildAliasMap(store, targetBiz);
  const costMap = await buildCostMap(store, targetBiz);

  const agg = new Map();
  for (const r of list) {
    const dishName = String(r?.dish_name || '').trim();
    if (!dishName) continue;
    const key = dishName;
    const node = agg.get(key) || {
      dishName,
      qty: 0,
      sales: 0,
      revenue: 0,
      hasDishCodeSales: 0,
      resolvedDishName: ''
    };
    const sales = Number(r?.sales_amount || 0);
    const revenue = Number(r?.revenue || 0);
    const qty = Number(r?.qty || 0);
    node.qty += Number.isFinite(qty) ? qty : 0;
    node.sales += Number.isFinite(sales) ? sales : 0;
    node.revenue += Number.isFinite(revenue) ? revenue : 0;
    if (String(r?.dish_code || '').trim()) node.hasDishCodeSales += Number.isFinite(sales) ? sales : 0;
    agg.set(key, node);
  }

  let totalSales = 0;
  let coveredSales = 0;
  let totalRevenue = 0;
  let coveredRevenue = 0;
  let skuSales = 0;
  const unmatchedTop = [];

  for (const item of agg.values()) {
    const norm = normalizeDishName(item.dishName);
    const aliased = aliasMap.get(norm) || item.dishName;
    const resolvedNorm = normalizeDishName(aliased);
    const cost = costMap.get(resolvedNorm);
    item.resolvedDishName = aliased;

    totalSales += item.sales;
    totalRevenue += item.revenue;
    skuSales += item.hasDishCodeSales;

    if (Number.isFinite(cost)) {
      coveredSales += item.sales;
      coveredRevenue += item.revenue;
    } else {
      unmatchedTop.push({
        dishName: item.dishName,
        resolvedDishName: item.resolvedDishName,
        sales: Number(item.sales.toFixed(2)),
        revenue: Number(item.revenue.toFixed(2)),
        qty: Number(item.qty.toFixed(2))
      });
    }
  }

  const salesCoveragePct = totalSales > 0 ? (coveredSales / totalSales) * 100 : 0;
  const revenueCoveragePct = totalRevenue > 0 ? (coveredRevenue / totalRevenue) * 100 : 0;
  const skuCompletenessPct = totalSales > 0 ? (skuSales / totalSales) * 100 : 0;

  unmatchedTop.sort((a, b) => Number(b.sales || 0) - Number(a.sales || 0));

  return {
    pass: salesCoveragePct >= thresholdPct,
    thresholdPct,
    salesCoveragePct: Number(salesCoveragePct.toFixed(2)),
    revenueCoveragePct: Number(revenueCoveragePct.toFixed(2)),
    skuCompletenessPct: Number(skuCompletenessPct.toFixed(2)),
    skuCompletenessWarnPct: QUALITY_THRESHOLDS.skuCompletenessWarnPct,
    unmatchedTop: unmatchedTop.slice(0, 20)
  };
}

export function parseSalesRawRows(matrix, defBiz, defStore, opts = {}) {
  const R = Array.isArray(matrix) ? matrix : []; if (!R.length) return [];
  const n = x => String(x||'').trim();
  const c = x => n(x).toLowerCase().replace(/[\s\/:：()（）\[\]【】_\-~～]/g,'');
  let hri = -1;
  for (let i=0;i<R.length;i++){
    const h=(Array.isArray(R[i])?R[i]:[]).map(c);
    const t=p=>h.some(x=>p.test(x));
    if(t(/菜品名称|商品名称|品名/)&&(t(/销售数量|数量/)||t(/销售金额|金额/))){hri=i;break;}
  }
  const ds=hri>=0?hri+1:0;
  const hdr=hri>=0&&Array.isArray(R[hri])?R[hri]:[];
  const hdrs=hdr.map(c);
  const idx=ns=>{for(const x of ns){const i=hdrs.indexOf(c(x));if(i>=0)return i;}return -1;};
  const iD=idx(['销售日期','日期','营业日期']);
  const iB=idx(['销售类型','类型']);
  const iS=idx(['餐/时段名称','时段名称','餐时段','时段']);
  const iP=idx(['菜品名称','商品名称','品名','产品']);
  const iQ=idx(['销售数量','数量']);
  const iA=idx(['销售金额','销售额','销售收入','折前营收','折前营业额','折前收入','金额']);
  const iR=idx([
    '实际收入','实收','实际营收',
    '实收金额','实收营业额','实收金额元',
    '净收','净收入','净营业额',
    '菜品收入','家品收入',
    '折后营收','折后营业额','折后收入','折后金额'
  ]);
  const iDi=idx(['优惠金额','优惠','折扣']);
  const iOT=idx(['下单时间','点单时间','订单时间']);
  const iCT=idx(['结账时间','结算时间']);
  const iSt=idx(['门店','店铺','门店名称']);
  const iSku=idx(['sku','sku编码','sku码','商品编码','商品id','菜品编码','菜品id']);
  const pn=v=>{const s=String(v==null?'':v).replace(/[,，\s¥￥]/g,'');if(!s)return NaN;const x=Number(s);return Number.isFinite(x)?x:NaN;};
  const nd=v=>{const s=n(v);const m=s.match(/(\d{4})[\/\-年](\d{1,2})[\/\-月](\d{1,2})/);return m?`${m[1]}-${m[2].padStart(2,'0')}-${m[3].padStart(2,'0')}`:'';}
  const nb=v=>{const s=n(v).toLowerCase();if(/外卖|takeaway|delivery/.test(s))return'takeaway';if(/堂食|dinein/.test(s))return'dinein';return'';};
  const ns=v=>{const s=n(v);if(/午市|lunch/.test(s))return'lunch';if(/下午茶|afternoon/.test(s))return'afternoon';if(/晚市|dinner/.test(s))return'dinner';const m=s.match(/(\d{1,2})\s*[:：]/);if(m){const h=+m[1];if(h>=10&&h<14)return'lunch';if(h>=14&&h<17)return'afternoon';if(h>=17&&h<22)return'dinner';}return'';};
  const res=[];
  for(let r=ds;r<R.length;r++){
    const L=Array.isArray(R[r])?R[r]:[];if(!L.length)continue;
    const prod=n(iP>=0?L[iP]:'');const qty=pn(iQ>=0?L[iQ]:0);
    if(!prod||!Number.isFinite(qty)||qty<=0)continue;
    const date=nd(iD>=0?L[iD]:'')||(opts.fallbackDate||'');if(!date)continue;
    const biz=nb(iB>=0?L[iB]:'')||defBiz||'dinein';
    const store=n(iSt>=0?L[iSt]:'')||defStore||'';
    let slot=iS>=0?ns(L[iS]):'';
    if(!slot&&iOT>=0)slot=ns(L[iOT]);
    if(!slot&&iCT>=0)slot=ns(L[iCT]);
    if(!slot)slot='other';
    const sa=(()=>{const x=pn(iA>=0?L[iA]:0);return Number.isFinite(x)?Math.max(0,x):0;})();
    const rv=(()=>{const x=pn(iR>=0?L[iR]:0);return Number.isFinite(x)&&x>0?x:0;})();
    const di=(()=>{const x=pn(iDi>=0?L[iDi]:0);return Number.isFinite(x)?Math.abs(x):0;})();
    const revenue=rv>0?rv:Math.max(0,sa-di);
    const wd=(()=>{const d=new Date(date+'T00:00:00');const w=d.getDay();return w===0?7:w;})();
    const dishCode = n(iSku>=0?L[iSku]:'');
    let oTime=null,cTime=null;
    if(iOT>=0){try{const t=n(L[iOT]).replace(/：/g,':');const d=new Date(`${date}T${t}`);if(!isNaN(d))oTime=d.toISOString();}catch(e){}}
    if(iCT>=0){try{const t=n(L[iCT]).replace(/：/g,':');const d=new Date(`${date}T${t}`);if(!isNaN(d))cTime=d.toISOString();}catch(e){}}
    res.push({store,date,biz_type:biz,dish_name:prod,dish_code:dishCode,qty:+qty.toFixed(2),sales_amount:+sa.toFixed(2),revenue:+revenue.toFixed(2),discount:+di.toFixed(2),slot,order_time:oTime,checkout_time:cTime,weekday:wd});
  }
  return res;
}

export async function insertSalesRawRows(rows, store, bizType, minDate, maxDate) {
  const p = gp();
  const client = await p.connect();
  try {
    const hasDishCodeColumn = await ensureSalesRawSchema(client);
    await client.query('BEGIN');
    const del = await client.query('DELETE FROM sales_raw WHERE store=$1 AND biz_type=$2 AND date BETWEEN $3 AND $4',[store,bizType,minDate,maxDate]);
    console.log(`[sales-raw] deleted ${del.rowCount} old rows ${store}/${bizType} ${minDate}~${maxDate}`);
    let cnt=0;
    for(const r of rows){
      if (hasDishCodeColumn) {
        await client.query(`INSERT INTO sales_raw(store,date,biz_type,dish_name,dish_code,qty,sales_amount,revenue,discount,slot,order_time,checkout_time,weekday) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
          [r.store,r.date,r.biz_type,r.dish_name,String(r.dish_code||''),r.qty,r.sales_amount,r.revenue,r.discount,r.slot,r.order_time,r.checkout_time,r.weekday]);
      } else {
        await client.query(`INSERT INTO sales_raw(store,date,biz_type,dish_name,qty,sales_amount,revenue,discount,slot,order_time,checkout_time,weekday) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
          [r.store,r.date,r.biz_type,r.dish_name,r.qty,r.sales_amount,r.revenue,r.discount,r.slot,r.order_time,r.checkout_time,r.weekday]);
      }
      cnt++;
    }
    await client.query('COMMIT');
    return {deleted:del.rowCount,inserted:cnt};
  } catch(e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}
