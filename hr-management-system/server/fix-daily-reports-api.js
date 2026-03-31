/**
 * 修复营业日报API，合并JSON和数据库表数据
 */

// 修改 /api/daily-reports 接口，合并数据
export function patchDailyReportsAPI(app) {
  
  // 替换原有的 GET /api/daily-reports 接口
  app.get('/api/daily-reports', async (req, res) => {
    const username = String(req.user?.username || '').trim();
    const role = String(req.user?.role || '').trim();
    if (!username) return res.status(400).json({ error: 'missing_user' });
    if (!canAccessDailyReports(role)) return res.status(403).json({ error: 'forbidden' });

    const storeQ = String(req.query?.store || '').trim();
    const date = safeDateOnly(req.query?.date);
    const start = safeDateOnly(req.query?.start);
    const end = safeDateOnly(req.query?.end);
    const limit = Math.min(Number(req.query?.limit) || 1000, 1000);

    try {
      const state0 = (await getSharedState()) || {};
      const myStore = pickMyStoreFromState(state0, username);

      const store = (role === 'store_manager' || role === 'store_production_manager') ? myStore : storeQ;
      let items = Array.isArray(state0.dailyReports) ? state0.dailyReports.slice() : [];
      
      // 获取daily_reports表中的数据
      const dailyReportsData = await pool().query(`
        SELECT * FROM daily_reports 
        WHERE 1=1
        ${store ? 'AND store = $1' : ''}
        ORDER BY date DESC
      `, store ? [store] : []);
      
      // 创建映射表
      const dataMap = new Map();
      dailyReportsData.rows.forEach(row => {
        const key = `${row.store}-${row.date}`;
        dataMap.set(key, {
          actual_margin: row.actual_margin,
          target_margin: row.target_margin,
          dianping_rating: row.dianping_rating,
          target_revenue: row.target_revenue,
          wechat_month_total: row.wechat_month_total
        });
      });
      
      // 合并数据到JSON中
      items = items.map(item => {
        const key = `${item.store}-${item.date}`;
        const tableData = dataMap.get(key) || {};
        
        return {
          ...item,
          data: {
            ...item.data,
            actual_margin: tableData.actual_margin,
            target_margin: tableData.target_margin,
            dianping_rating: tableData.dianping_rating,
            target_revenue: tableData.target_revenue,
            wechat_month_total: tableData.wechat_month_total
          }
        };
      });
      
      if (store) items = items.filter(r => String(r?.store || '').trim() === String(store).trim());
      if (date) {
        items = items.filter(r => String(r?.date || '').trim() === String(date).trim());
      } else if (start || end) {
        items = items.filter(r => inDateRange(String(r?.date || '').trim(), start, end));
      }
      items.sort((a, b) => String(b?.date || '').localeCompare(String(a?.date || '')) || String(b?.updatedAt || b?.createdAt || '').localeCompare(String(a?.updatedAt || a?.createdAt || '')));
      items = items.slice(0, limit);
      return res.json({ items });
    } catch (e) {
      return res.status(500).json({ error: 'server_error', message: String(e?.message || e) });
    }
  });
  
  console.log('[api] 营业日报API已修复，支持显示新字段');
}
