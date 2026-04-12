#!/usr/bin/env node
/**
 * 仅用 DATABASE_URL：从 hrms_state.dailyReports 将指定日「已提交」条目 UPSERT 到 daily_reports（与 index.js 双写逻辑一致）。
 * 不经过 HTTP、无需登录。用于 ECS 上 admin 密码未知时的应急补数。
 *
 * 用法：
 *   cd /opt/hrms/server && node scripts/sync-daily-pg-from-state-standalone.mjs 2026-04-11
 *   node scripts/sync-daily-pg-from-state-standalone.mjs 2026-04-11 "洪潮某店"   # 可选：只同步一家店
 *
 * 环境：DATABASE_URL。默认加载当前目录下的 `.env`（与线上 PM2 cwd 一致）；也可用 DOTENV_CONFIG_PATH 指定。
 */
import dotenv from 'dotenv';
import pg from 'pg';
import path from 'path';

const envPath = process.env.DOTENV_CONFIG_PATH || path.join(process.cwd(), '.env');
dotenv.config({ path: envPath });

function safeDateOnly(x) {
  const s = String(x || '').slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : '';
}

async function recalcWechatMonthTotalsForStoreMonth(pool, store, anchorDate) {
  const st = String(store || '').trim();
  const ymd = String(anchorDate || '').slice(0, 10);
  if (!st || ymd.length < 10) return;
  const monthStart = `${ymd.slice(0, 7)}-01`;
  try {
    await pool.query(
      `WITH sums AS (
         SELECT date::date AS d,
           SUM(COALESCE(new_wechat_members, 0)) OVER (ORDER BY date)::bigint AS cum
         FROM daily_reports
         WHERE TRIM(store) = TRIM($1::text)
           AND date >= $2::date
           AND date < ($2::date + INTERVAL '1 month')
       )
       UPDATE daily_reports dr
       SET wechat_month_total = LEAST(2147483647, GREATEST(0, sums.cum))::int
       FROM sums
       WHERE TRIM(dr.store) = TRIM($1::text) AND dr.date::date = sums.d`,
      [st, monthStart]
    );
  } catch (e) {
    console.error('[wechat_month_total recalc]', e?.message);
  }
}

async function upsertDailyReportPgFromStateReport(pool, dr) {
  const payload = dr?.data && typeof dr.data === 'object' ? dr.data : {};
  const store = String(dr?.store || '').trim();
  const date = safeDateOnly(dr?.date);
  if (!store || !date) throw new Error('missing_store_or_date');
  const operationalAnomalyNote = String(
    payload?.operational_anomaly_note ?? payload?.operationalAnomalyNote ?? ''
  )
    .trim()
    .slice(0, 4000);
  const brand = String(payload?.brand || '').trim();
  const todayWechat = Math.max(0, Math.floor(Number(payload?.new_wechat_members) || 0));
  const dineOrders = Math.floor(Number(payload?.dine?.orders) || 0);
  const dineRevenue = Number(payload?.dine?.revenue) || 0;
  const dineTraffic = Math.floor(Number(payload?.dine?.traffic) || 0);
  const preDiscountRevenue = Number(payload?.gross) || 0;
  const totalDiscount = Number(payload?.discount?.total) || 0;
  const efficiencyVal = Number(payload?.efficiency) || 0;
  const laborTotalVal = Number(payload?.laborTotal) || 0;
  const grossProfit = Number(payload?.margin) || 0;
  const budgetVal = Number(payload?.budget) || 0;
  const budgetRateVal = Number(payload?.budgetRate) || 0;
  const deliveryElemeRev = Number(payload?.delivery?.eleme?.revenue) || 0;
  const deliveryMeituanRev = Number(payload?.delivery?.meituan?.revenue) || 0;
  const deliveryActual =
    Number(payload?.delivery?.eleme?.actual || 0) + Number(payload?.delivery?.meituan?.actual || 0);
  const deliveryOrders =
    Math.floor(Number(payload?.delivery?.eleme?.orders || 0)) +
    Math.floor(Number(payload?.delivery?.meituan?.orders || 0));
  const deliveryPreRevenue = deliveryElemeRev + deliveryMeituanRev;
  const deliveryBadReviews =
    Math.floor(Number(payload?.badReviews?.meituan || 0)) + Math.floor(Number(payload?.badReviews?.eleme || 0));
  const privateRoomUses = Math.max(0, Math.floor(Number(payload?.private_room_uses) || 0));
  const rechargeCount = Math.max(0, Math.floor(Number(payload?.recharge?.count) || 0));
  const rechargeAmount = Number(payload?.recharge?.amount) || 0;
  const weather = String(payload?.weather || '').trim() || null;
  const holidaySwitch = !!(payload?.holiday_switch ?? payload?.holidaySwitch);
  const segments = payload?.segments ? JSON.stringify(payload.segments) : null;
  const discountDine = Number(payload?.discount?.dine) || 0;
  const discountDelivery = Number(payload?.discount?.delivery) || 0;
  const categories = payload?.categories ? JSON.stringify(payload.categories) : null;
  const deliveryDetail = payload?.delivery ? JSON.stringify(payload.delivery) : null;
  const badReviewsDianping = Math.floor(Number(payload?.badReviews?.dianping) || 0);
  const staff = payload?.staff ? JSON.stringify(payload.staff) : null;
  const scheduleNextDay = payload?.scheduleNextDay ? JSON.stringify(payload.scheduleNextDay) : null;
  const photos = payload?.photos ? JSON.stringify(payload.photos) : null;

  await pool.query(
    `
          INSERT INTO daily_reports (store, brand, date, actual_revenue, actual_margin, dianping_rating, new_wechat_members, wechat_month_total, submitted, submitted_at,
            pre_discount_revenue, total_discount, dine_orders, dine_revenue, dine_traffic, efficiency, labor_total, gross_profit, budget, budget_rate,
            delivery_actual, delivery_orders, delivery_pre_revenue, delivery_bad_reviews, private_room_uses, operational_anomaly_note,
            recharge_count, recharge_amount,
            weather, segments, discount_dine, discount_delivery, categories, delivery_detail, bad_reviews_dianping, staff, schedule_next_day, photos, holiday_switch)
          VALUES ($1::text, $2::text, $3::date, $4, $5, $6, $7,
            COALESCE((
              SELECT SUM(dr.new_wechat_members)::bigint
              FROM daily_reports dr
              WHERE TRIM(dr.store) = TRIM($1::text)
                AND dr.date >= date_trunc('month', $3::date)::date
                AND dr.date < $3::date
            ), 0) + $8::bigint,
            true, NOW(),
            $9, $10, $11, $12, $13, $14, $15, $16, $17, $18,
            $19, $20, $21, $22, $23, $24, $25, $26,
            $27, $28, $29, $30, $31, $32, $33, $34, $35, $36, $37)
          ON CONFLICT (store, date)
          DO UPDATE SET 
            actual_revenue = EXCLUDED.actual_revenue,
            actual_margin = EXCLUDED.actual_margin,
            dianping_rating = EXCLUDED.dianping_rating,
            new_wechat_members = EXCLUDED.new_wechat_members,
            wechat_month_total = EXCLUDED.wechat_month_total,
            pre_discount_revenue = EXCLUDED.pre_discount_revenue,
            total_discount = EXCLUDED.total_discount,
            dine_orders = EXCLUDED.dine_orders,
            dine_revenue = EXCLUDED.dine_revenue,
            dine_traffic = EXCLUDED.dine_traffic,
            efficiency = EXCLUDED.efficiency,
            labor_total = EXCLUDED.labor_total,
            gross_profit = EXCLUDED.gross_profit,
            budget = EXCLUDED.budget,
            budget_rate = EXCLUDED.budget_rate,
            delivery_actual = EXCLUDED.delivery_actual,
            delivery_orders = EXCLUDED.delivery_orders,
            delivery_pre_revenue = EXCLUDED.delivery_pre_revenue,
            delivery_bad_reviews = EXCLUDED.delivery_bad_reviews,
            private_room_uses = EXCLUDED.private_room_uses,
            operational_anomaly_note = EXCLUDED.operational_anomaly_note,
            recharge_count = EXCLUDED.recharge_count,
            recharge_amount = EXCLUDED.recharge_amount,
            weather = EXCLUDED.weather,
            segments = EXCLUDED.segments,
            discount_dine = EXCLUDED.discount_dine,
            discount_delivery = EXCLUDED.discount_delivery,
            categories = EXCLUDED.categories,
            delivery_detail = EXCLUDED.delivery_detail,
            bad_reviews_dianping = EXCLUDED.bad_reviews_dianping,
            staff = EXCLUDED.staff,
            schedule_next_day = EXCLUDED.schedule_next_day,
            photos = EXCLUDED.photos,
            holiday_switch = EXCLUDED.holiday_switch,
            updated_at = NOW()
        `,
    [
      store,
      brand,
      date,
      payload?.actual || 0,
      payload?.margin || null,
      payload?.dianping_rating || null,
      todayWechat,
      todayWechat,
      preDiscountRevenue,
      totalDiscount,
      dineOrders,
      dineRevenue,
      dineTraffic,
      efficiencyVal,
      laborTotalVal,
      grossProfit,
      budgetVal,
      budgetRateVal,
      deliveryActual,
      deliveryOrders,
      deliveryPreRevenue,
      deliveryBadReviews,
      privateRoomUses,
      operationalAnomalyNote || null,
      rechargeCount,
      rechargeAmount,
      weather,
      segments,
      discountDine,
      discountDelivery,
      categories,
      deliveryDetail,
      badReviewsDianping,
      staff,
      scheduleNextDay,
      photos,
      holidaySwitch
    ]
  );
  await recalcWechatMonthTotalsForStoreMonth(pool, store, date);
}

async function main() {
  const date = safeDateOnly(process.argv[2]);
  const storeFilter = String(process.argv[3] || '').trim();
  if (!date) {
    console.error('用法: node scripts/sync-daily-pg-from-state-standalone.mjs YYYY-MM-DD [store精确名]');
    process.exit(1);
  }
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('缺少 DATABASE_URL（可设 DOTENV_CONFIG_PATH=.env.production）');
    process.exit(1);
  }
  const pool = new pg.Pool({ connectionString: url });
  try {
    const r = await pool.query(`select data from hrms_state where key = 'default' limit 1`);
    const state0 = r.rows?.[0]?.data || {};
    const list = Array.isArray(state0.dailyReports) ? state0.dailyReports : [];
    const results = [];
    for (const dr of list) {
      const d = safeDateOnly(dr?.date);
      const st = String(dr?.store || '').trim();
      if (d !== date) continue;
      if (storeFilter && st !== storeFilter) continue;
      const submitted = !!(dr?.submittedAt || dr?.submitted_at || dr?.submitted);
      if (!submitted) continue;
      try {
        await upsertDailyReportPgFromStateReport(pool, dr);
        results.push({ store: st, date: d, ok: true });
      } catch (e) {
        results.push({ store: st, date: d, ok: false, error: String(e?.message || e) });
      }
    }
    console.log(JSON.stringify({ ok: true, date, storeFilter: storeFilter || null, matched: results.length, results }, null, 2));
    if (results.some((x) => !x.ok)) process.exit(1);
  } finally {
    await pool.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
