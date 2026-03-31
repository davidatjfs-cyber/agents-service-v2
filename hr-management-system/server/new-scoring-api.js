/**
 * 新评分模型API接口
 */

import { calculateStoreRating, calculateEmployeeScore } from './new-scoring-model.js';
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
        return await calculateStoreRating(store, period);
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
      const { store, brand, date, actual_revenue, actual_margin, dianping_rating, new_wechat_members, wechat_month_total } = req.body;
      
      if (!store || !brand || !date) {
        return res.status(400).json({ 
          error: 'missing_parameters',
          message: '需要提供 store, brand 和 date 参数'
        });
      }
      
      await pool().query(`
        INSERT INTO daily_reports (store, brand, date, actual_revenue, actual_margin, dianping_rating, new_wechat_members, wechat_month_total, submitted, submitted_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true, NOW())
        ON CONFLICT (store, date)
        DO UPDATE SET 
          actual_revenue = EXCLUDED.actual_revenue,
          actual_margin = EXCLUDED.actual_margin,
          dianping_rating = EXCLUDED.dianping_rating,
          new_wechat_members = EXCLUDED.new_wechat_members,
          wechat_month_total = EXCLUDED.wechat_month_total,
          updated_at = NOW()
      `, [store, brand, date, actual_revenue, actual_margin, dianping_rating, new_wechat_members || 0, wechat_month_total || 0]);
      
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
