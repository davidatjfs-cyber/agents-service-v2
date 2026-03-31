export function registerUploadStatusRoute(app, opts) {
  const { pool, getSharedState, authRequired } = opts;
  app.get('/api/uploads/status', authRequired, async (req, res) => {
    const role = String(req.user?.role || '').trim();
    if (!['admin','hq_manager','store_manager'].includes(role))
      return res.status(403).json({ error: 'forbidden' });
    try {
      const s = (await getSharedState()) || {};
      const out = [];
      const q = async (sql) => {
        try { const r = await pool.query(sql); return r.rows[0]; }
        catch(e) { return null; }
      };
      const kb = await q(`SELECT COUNT(*) c, MAX(created_at) l FROM knowledge_base`);
      out.push({ key:'kb', label:'知识库文件', count:+(kb?.c||0), latest:kb?.l||null });
      const fh = Array.isArray(s.inventoryForecastHistory) ? s.inventoryForecastHistory : [];
      out.push({ key:'fh', label:'备货预测历史', count:fh.length });
      const sr = await q(`SELECT COUNT(*) c FROM sales_raw`);
      out.push({ key:'sr', label:'销售明细', count:+(sr?.c||0) });
      const dl = await q(`SELECT COUNT(*) c, MAX(updated_at) l FROM dish_library_costs WHERE enabled=TRUE`);
      out.push({ key:'dl', label:'菜品成本库', count:+(dl?.c||0), latest:dl?.l||null });
      const dr = await q(`SELECT COUNT(*) c FROM daily_reports`);
      out.push({ key:'dr', label:'营业日报', count:+(dr?.c||0) });
      const gp = Array.isArray(s.forecastGrossProfitProfiles) ? s.forecastGrossProfitProfiles : [];
      out.push({ key:'gp', label:'毛利配置', count:gp.length });
      return res.json({ sources: out });
    } catch (e) {
      return res.status(500).json({ error: 'server_error', message: String(e?.message||e) });
    }
  });
}
