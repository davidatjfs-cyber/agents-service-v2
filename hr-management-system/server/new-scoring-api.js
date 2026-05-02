/**
 * 新评分模型API接口
 */

import { calculateStoreRating, calculateEmployeeScore } from './new-scoring-model.js';
import { inferBrandFromStoreName } from './agents.js';
import { pool } from './utils/database.js';
import { safeExecute } from './utils/error-handler.js';

// ─────────────────────────────────────────────
// 门店评级API
// ─────────────────────────────────────────────
export function registerNewScoringRoutes(app) {
  
  // 获取门店评级
  app.get('/api/scoring/store-rating', async (req, res) => {
    try {
      const { store, period } = req.query;
      
      if (!store || !period) {
        return res.status(400).json({ 
          error: 'missing_parameters',
          message: '需要提供 store 和 period 参数'
        });
      }
      
      const result = await safeExecute('store_rating_api', async () => {
        const brand = inferBrandFromStoreName(store);
        return await calculateStoreRating(store, brand, period);
      });
      
      if (!result) {
        return res.status(500).json({ 
          error: 'calculation_failed',
          message: '门店评级计算失败'
        });
      }
      
      res.json({
        success: true,
        data: result
      });
      
    } catch (error) {
      console.error('[api] store_rating error:', error);
      res.status(500).json({ 
        error: 'server_error',
        message: error.message
      });
    }
  });
  
  // 获取员工评分
  app.get('/api/scoring/employee-score', async (req, res) => {
    try {
      const { store, username, role, period } = req.query;
      
      if (!store || !username || !role || !period) {
        return res.status(400).json({ 
          error: 'missing_parameters',
          message: '需要提供 store, username, role 和 period 参数'
        });
      }
      
      const result = await safeExecute('employee_score_api', async () => {
        return await calculateEmployeeScore(store, username, role, period);
      });
      
      if (!result) {
        return res.status(500).json({ 
          error: 'calculation_failed',
          message: '员工评分计算失败'
        });
      }
      
      res.json({
        success: true,
        data: result
      });
      
    } catch (error) {
      console.error('[api] employee_score error:', error);
      res.status(500).json({ 
        error: 'server_error',
        message: error.message
      });
    }
  });
  
  // 获取营业日报数据
  app.get('/api/scoring/daily-reports', async (req, res) => {
    try {
      const { store, start, end } = req.query;
      
      let query = 'SELECT * FROM daily_reports WHERE 1=1';
      const params = [];
      
      if (store) {
        query += ' AND store = $1';
        params.push(store);
      }
      
      if (start) {
        query += params.length > 0 ? ' AND date >= $' + (params.length + 1) : ' AND date >= $' + (params.length + 1);
        params.push(start);
      }
      
      if (end) {
        query += params.length > 0 ? ' AND date <= $' + (params.length + 1) : ' AND date <= $' + (params.length + 1);
        params.push(end);
      }
      
      query += ' ORDER BY date DESC, store';
      
      const result = await pool().query(query, params);
      
      res.json({
        success: true,
        data: result.rows,
        count: result.rows.length
      });
      
    } catch (error) {
      console.error('[api] daily_reports error:', error);
      res.status(500).json({ 
        error: 'server_error',
        message: error.message
      });
    }
  });
  
  // 获取营业目标
  app.get('/api/scoring/revenue-targets', async (req, res) => {
    try {
      const { store, period } = req.query;
      
      let query = 'SELECT * FROM revenue_targets WHERE 1=1';
      const params = [];
      
      if (store) {
        query += ' AND store = $1';
        params.push(store);
      }
      
      if (period) {
        query += params.length > 0 ? ' AND period = $' + (params.length + 1) : ' AND period = $' + (params.length + 1);
        params.push(period);
      }
      
      query += ' ORDER BY period DESC, store';
      
      const result = await pool().query(query, params);
      
      res.json({
        success: true,
        data: result.rows,
        count: result.rows.length
      });
      
    } catch (error) {
      console.error('[api] revenue_targets error:', error);
      res.status(500).json({ 
        error: 'server_error',
        message: error.message
      });
    }
  });
  
  // 获取毛利率目标
  app.get('/api/scoring/margin-targets', async (req, res) => {
    try {
      const { store, period } = req.query;
      
      let query = 'SELECT * FROM margin_targets WHERE 1=1';
      const params = [];
      
      if (store) {
        query += ' AND store = $1';
        params.push(store);
      }
      
      if (period) {
        query += params.length > 0 ? ' AND period = $' + (params.length + 1) : ' AND period = $' + (params.length + 1);
        params.push(period);
      }
      
      query += ' ORDER BY period DESC, store';
      
      const result = await pool().query(query, params);
      
      res.json({
        success: true,
        data: result.rows,
        count: result.rows.length
      });
      
    } catch (error) {
      console.error('[api] margin_targets error:', error);
      res.status(500).json({ 
        error: 'server_error',
        message: error.message
      });
    }
  });
  
  // 设置营业目标
  app.post('/api/scoring/revenue-targets', async (req, res) => {
    try {
      const { store, brand, period, target_revenue } = req.body;
      
      if (!store || !brand || !period || !target_revenue) {
        return res.status(400).json({ 
          error: 'missing_parameters',
          message: '需要提供 store, brand, period 和 target_revenue 参数'
        });
      }
      
      await pool().query(`
        INSERT INTO revenue_targets (store, brand, period, target_revenue)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (store, brand, period)
        DO UPDATE SET target_revenue = EXCLUDED.target_revenue
      `, [store, brand, period, target_revenue]);
      
      res.json({
        success: true,
        message: '营业目标设置成功'
      });
      
    } catch (error) {
      console.error('[api] set_revenue_targets error:', error);
      res.status(500).json({ 
        error: 'server_error',
        message: error.message
      });
    }
  });
  
  // 设置毛利率目标
  app.post('/api/scoring/margin-targets', async (req, res) => {
    try {
      const { store, brand, period, target_margin } = req.body;
      
      if (!store || !brand || !period || !target_margin) {
        return res.status(400).json({ 
          error: 'missing_parameters',
          message: '需要提供 store, brand, period 和 target_margin 参数'
        });
      }
      
      await pool().query(`
        INSERT INTO margin_targets (store, brand, period, target_margin)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (store, brand, period)
        DO UPDATE SET target_margin = EXCLUDED.target_margin
      `, [store, brand, period, target_margin]);
      
      res.json({
        success: true,
        message: '毛利率目标设置成功'
      });
      
    } catch (error) {
      console.error('[api] set_margin_targets error:', error);
      res.status(500).json({ 
        error: 'server_error',
        message: error.message
      });
    }
  });
  
  // 更新营业日报
  app.post('/api/scoring/daily-reports', async (req, res) => {
    try {
      const { store, brand, date, actual_revenue, actual_margin, dianping_rating, new_wechat_members, wechat_month_total,
        pre_discount_revenue, total_discount, dine_orders, dine_revenue, dine_traffic, efficiency, labor_total,
        gross_profit, budget, budget_rate, delivery_actual, delivery_orders, delivery_pre_revenue, delivery_bad_reviews,
        private_room_uses, operational_anomaly_note, recharge_count, recharge_amount,
        weather, segments, discount_dine, discount_delivery, categories, delivery_detail,
        bad_reviews_dianping, staff, schedule_next_day, photos, holiday_switch } = req.body;
      
      if (!store || !brand || !date) {
        return res.status(400).json({ 
          error: 'missing_parameters',
          message: '需要提供 store, brand 和 date 参数'
        });
      }
      
      await pool().query(`
        INSERT INTO daily_reports (store, brand, date, actual_revenue, actual_margin, dianping_rating, new_wechat_members, wechat_month_total, submitted, submitted_at,
          pre_discount_revenue, total_discount, dine_orders, dine_revenue, dine_traffic, efficiency, labor_total, gross_profit, budget, budget_rate,
          delivery_actual, delivery_orders, delivery_pre_revenue, delivery_bad_reviews, private_room_uses, operational_anomaly_note,
          recharge_count, recharge_amount,
          weather, segments, discount_dine, discount_delivery, categories, delivery_detail, bad_reviews_dianping, staff, schedule_next_day, photos, holiday_switch)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true, NOW(),
          $9, $10, $11, $12, $13, $14, $15, $16, $17, $18,
          $19, $20, $21, $22, $23, $24, $25, $26,
          $27, $28, $29, $30, $31, $32, $33, $34, $35, $36)
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
      `, [store, brand, date, actual_revenue, actual_margin, dianping_rating, new_wechat_members || 0, wechat_month_total || 0,
        pre_discount_revenue || 0, total_discount || 0, dine_orders || 0, dine_revenue || 0, dine_traffic || 0,
        efficiency || 0, labor_total || 0, gross_profit || 0, budget || 0, budget_rate || 0,
        delivery_actual || 0, delivery_orders || 0, delivery_pre_revenue || 0, delivery_bad_reviews || 0,
        private_room_uses || 0, operational_anomaly_note || null,
        recharge_count || 0, recharge_amount || 0,
        weather || null, segments ? JSON.stringify(segments) : null, discount_dine || 0, discount_delivery || 0,
        categories ? JSON.stringify(categories) : null, delivery_detail ? JSON.stringify(delivery_detail) : null,
        bad_reviews_dianping || 0, staff ? JSON.stringify(staff) : null, schedule_next_day ? JSON.stringify(schedule_next_day) : null,
        photos ? JSON.stringify(photos) : null, !!holiday_switch]);

      // Sync to hrms_state.dailyReports to prevent V1 self-healing from detecting lag
      try {
        const stateDate = String(date).slice(0, 10);
        const dtDetail = delivery_detail || {};
        const eleme = dtDetail.eleme || { revenue: 0, actual: 0, orders: 0, targetRevenue: 0 };
        const meituan = dtDetail.meituan || { revenue: Number(delivery_pre_revenue) || 0, actual: Number(delivery_actual) || 0, orders: Math.floor(Number(delivery_orders) || 0), targetRevenue: 0 };
        const stateItem = {
          id: Date.now().toString(36) + Math.random().toString(36).slice(2, 10),
          store,
          date: stateDate,
          data: {
            brand: brand || '',
            actual: Number(actual_revenue) || 0,
            margin: actual_margin != null ? Number(actual_margin) : null,
            dianping_rating: dianping_rating != null ? Number(dianping_rating) : null,
            new_wechat_members: Math.floor(Number(new_wechat_members) || 0),
            wechat_month_total: Math.floor(Number(wechat_month_total) || 0),
            gross: Number(pre_discount_revenue) || 0,
            weather: String(weather || '').trim() || undefined,
            holiday_switch: !!holiday_switch,
            discount: { total: Number(total_discount) || 0, dine: Number(discount_dine) || 0, delivery: Number(discount_delivery) || 0 },
            dine: { orders: Math.floor(Number(dine_orders) || 0), revenue: Number(dine_revenue) || 0, traffic: Math.floor(Number(dine_traffic) || 0) },
            segments: segments || {},
            categories: categories || {},
            delivery: { eleme, meituan },
            badReviews: { dianping: Math.floor(Number(bad_reviews_dianping) || 0), meituan: Math.floor(Number(delivery_bad_reviews) || 0), eleme: 0 },
            efficiency: Number(efficiency) || 0,
            laborTotal: Number(labor_total) || 0,
            private_room_uses: Math.floor(Number(private_room_uses) || 0),
            operational_anomaly_note: String(operational_anomaly_note || '').trim(),
            budget: Number(budget) || 0,
            budgetRate: Number(budget_rate) || 0,
            recharge: { count: Math.floor(Number(recharge_count) || 0), amount: Number(recharge_amount) || 0 },
            staff: staff || null,
            scheduleNextDay: schedule_next_day || null,
            photos: photos || []
          },
          submitted: true,
          submittedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          grossProfit: Number(gross_profit) || 0
        };
        await pool().query(`
          UPDATE hrms_state SET data = CASE WHEN EXISTS (
            SELECT 1 FROM jsonb_array_elements(COALESCE(data->'dailyReports', '[]'::jsonb)) elem
            WHERE elem->>'store' = $1 AND elem->>'date' = $2
          ) THEN
            jsonb_set(data, '{dailyReports}', (
              SELECT jsonb_agg(CASE WHEN elem->>'store' = $1 AND elem->>'date' = $2 THEN $3::jsonb ELSE elem END)
              FROM jsonb_array_elements(data->'dailyReports') elem
            ))
          ELSE
            jsonb_set(COALESCE(data, '{}'::jsonb), '{dailyReports}', COALESCE(data->'dailyReports', '[]'::jsonb) || $3::jsonb)
          END, updated_at = NOW()
          WHERE key = 'default'
        `, [store, stateDate, JSON.stringify(stateItem)]);
      } catch (e) {
        console.error('[api] daily_reports state sync failed:', e?.message);
      }

      res.json({
        success: true,
        message: '营业日报更新成功'
      });
      
    } catch (error) {
      console.error('[api] update_daily_reports error:', error);
      res.status(500).json({ 
        error: 'server_error',
        message: error.message
      });
    }
  });
  
  console.log('[api] 新评分模型API路由已注册');
}
