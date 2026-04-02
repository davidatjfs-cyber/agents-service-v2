/**
 * Auto-Procurement Suggestion Agent (Phase 7)
 * 
 * 基于销量趋势、库存周转、毛利率等数据，自动生成采购建议
 * 集成到agent-handlers作为procurement_advisor角色
 */
import { query } from '../utils/db.js';
import { logger } from '../utils/logger.js';
import { callLLM } from './llm-provider.js';

/**
 * 分析门店近期消耗趋势，生成采购建议
 */
export async function generateProcurementAdvice(store) {
  // 拉取近7天营收和毛利数据
  let storeData = {};
  try {
    const rev = await query(
      `SELECT date, actual_revenue, gross_profit, dine_orders, delivery_orders
       FROM daily_reports WHERE store ILIKE $1 AND date >= CURRENT_DATE - 7
       ORDER BY date DESC`, [`%${store}%`]
    );
    if (rev.rows?.length) {
      const avgRev = rev.rows.reduce((s, r) => s + (parseFloat(r.actual_revenue) || 0), 0) / rev.rows.length;
      const avgOrders = rev.rows.reduce((s, r) => s + (parseInt(r.dine_orders) || 0) + (parseInt(r.delivery_orders) || 0), 0) / rev.rows.length;
      storeData = { avgRevenue: Math.round(avgRev), avgOrders: Math.round(avgOrders), days: rev.rows.length };
    }
  } catch (e) { /* ignore */ }

  // 拉取菜品成本数据(如果有dish_library表)
  let dishCosts = [];
  try {
    const dc = await query(
      `SELECT dish_name, cost, category FROM dish_library 
       WHERE store ILIKE $1 ORDER BY cost DESC LIMIT 20`, [`%${store}%`]
    );
    dishCosts = dc.rows || [];
  } catch (e) { /* table may not exist */ }

  // 拉取近期异常(如毛利率异常)
  let anomalies = [];
  try {
    const an = await query(
      `SELECT anomaly_key, severity, detail FROM anomaly_triggers
       WHERE store ILIKE $1 AND created_at >= CURRENT_DATE - 7
       AND anomaly_key IN ('gross_margin', 'cost_spike')
       ORDER BY created_at DESC LIMIT 5`, [`%${store}%`]
    );
    anomalies = an.rows || [];
  } catch (e) { /* ignore */ }

  const prompt = `你是餐饮采购顾问AI。根据以下门店数据生成采购建议：

门店: ${store}
近7天数据: 日均营收${storeData.avgRevenue||'未知'}元, 日均订单${storeData.avgOrders||'未知'}单
${dishCosts.length ? '高成本菜品: ' + dishCosts.slice(0, 5).map(d => d.dish_name + '(¥' + d.cost + ')').join(', ') : ''}
${anomalies.length ? '近期异常: ' + anomalies.map(a => a.anomaly_key + '[' + a.severity + ']').join(', ') : ''}

请输出JSON格式的采购建议:
{
  "summary": "总体建议(30字内)",
  "suggestions": [
    {"category": "食材类别", "action": "increase/decrease/maintain", "reason": "原因", "estimated_saving": 预估节省金额}
  ],
  "warnings": ["需要注意的事项"],
  "next_review_days": 下次建议复查天数
}`;

  try {
    const r = await callLLM([
      { role: 'system', content: '你是餐饮采购优化专家，只输出JSON' },
      { role: 'user', content: prompt }
    ], { temperature: 0.3, max_tokens: 600, purpose: 'procurement_advice' });

    const raw = String(r.content || '').trim().replace(/^```json?\s*/i, '').replace(/```$/i, '').trim();
    const advice = JSON.parse(raw);
    logger.info({ store, suggestions: advice.suggestions?.length }, 'Procurement advice generated');
    return advice;
  } catch (e) {
    logger.error({ err: e?.message, store }, 'Procurement advice generation failed');
    return { summary: '采购建议生成失败', suggestions: [], warnings: [e?.message] };
  }
}

/**
 * 批量生成所有门店的采购建议（用于周度调度）
 */
export async function batchProcurementAdvice() {
  try {
    const stores = await query(
      `SELECT DISTINCT store FROM daily_reports WHERE date >= CURRENT_DATE - 7`
    );
    const results = {};
    for (const row of (stores.rows || [])) {
      results[row.store] = await generateProcurementAdvice(row.store);
    }
    return results;
  } catch (e) {
    logger.error({ err: e?.message }, 'Batch procurement advice failed');
    return {};
  }
}
