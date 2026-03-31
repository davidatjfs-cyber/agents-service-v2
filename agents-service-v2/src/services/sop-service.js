/**
 * 分析路径 SOP：从 analysis_sop 表读取步骤，供 data_auditor / ops_supervisor 拼入 prompt。
 */
import { query } from '../utils/db.js';
import { logger } from '../utils/logger.js';

/**
 * @param {string} scenario
 * @returns {Promise<string[]|null>}
 */
export async function getSOPByScenario(scenario) {
  try {
    const s = String(scenario || '').trim();
    if (!s) return null;
    const r = await query('SELECT steps FROM analysis_sop WHERE scenario = $1 LIMIT 1', [s]);
    const raw = r.rows?.[0]?.steps;
    if (raw == null) return null;
    let arr = raw;
    if (typeof raw === 'string') {
      try {
        arr = JSON.parse(raw);
      } catch {
        return null;
      }
    }
    if (!Array.isArray(arr) || arr.length === 0) return null;
    return arr.map((x) => String(x ?? '').trim()).filter(Boolean);
  } catch (e) {
    logger.warn({ err: e?.message, scenario }, 'getSOPByScenario failed');
    return null;
  }
}

/**
 * 基于 root_causes.metric 优先；无则用语义关键词 fallback。
 * @param {string} input
 * @param {{ root_causes?: Array<{ metric?: string, reason?: string }> }|null|undefined} metricAnalysis
 * @returns {string|null}
 */
export function detectScenario(input, metricAnalysis) {
  try {
    const text = String(input || '');
    const causes = Array.isArray(metricAnalysis?.root_causes) ? metricAnalysis.root_causes : [];

    const rank = (m) => {
      const x = String(m || '').toLowerCase();
      if (/^bad_review/.test(x) || x === 'bad_reviews') return 0;
      if (['traffic', 'exposure', 'walk_in_rate'].includes(x)) return 1;
      if (x === 'conversion_rate') return 2;
      if (['avg_order_value', 'items_per_order', 'item_price'].includes(x)) return 3;
      if (x === 'orders') return 4;
      if (x === 'revenue') return 5;
      return 50;
    };

    if (causes.length) {
      const sorted = [...causes].sort((a, b) => rank(a?.metric) - rank(b?.metric));
      const m = String(sorted[0]?.metric || '').toLowerCase();
      if (/^bad_review/.test(m) || m === 'bad_reviews') return 'bad_reviews_increase';
      if (['traffic', 'exposure', 'walk_in_rate'].includes(m)) return 'traffic_drop';
      if (m === 'conversion_rate') return 'traffic_drop';
      if (['avg_order_value', 'items_per_order', 'item_price'].includes(m)) return 'aov_drop';
      if (m === 'orders') return 'revenue_drop';
      if (m === 'revenue') return 'revenue_drop';
    }

    if (/(差评|投诉).*(增|多|上升|暴涨)|差评.*增加|bad_review/i.test(text)) return 'bad_reviews_increase';
    if (/外卖.*(下降|下滑|变少|差)|配送.*下降|delivery/i.test(text)) return 'delivery_drop';
    if (/人效|人均.*(产值|单量|订单)|orders_per_staff|efficiency/i.test(text)) return 'efficiency_drop';
    if (/利润.*(下降|下滑|变薄)|净利|食品成本|人力成本|食材成本|labor_cost|food_cost/i.test(text)) return 'profit_drop';
    if (/翻台|table_turnover|周转率/i.test(text)) return 'turnover_low';
    if (/会员.*(转化|拉新|增长|少)|会员数|企微.*新增/i.test(text)) return 'membership_low';
    if (/活动.*(无效|效果|不行)|campaign|营销.*效果/i.test(text)) return 'campaign_ineffective';
    if (/客流|人流量|到店.*(下降|少|低)|traffic/i.test(text)) return 'traffic_drop';
    if (/客单价|单均|人均.*消费|aov/i.test(text)) return 'aov_drop';
    if (/(营收|营业额|生意|销售|收入).*(下降|下滑|变差|低迷)|revenue_drop/i.test(text)) return 'revenue_drop';

    return null;
  } catch (e) {
    logger.warn({ err: e?.message }, 'detectScenario failed');
    return null;
  }
}

/**
 * @param {string[]|null|undefined} steps
 * @returns {string}
 */
export function formatSopPromptAppendix(steps) {
  try {
    if (!steps || !Array.isArray(steps) || steps.length === 0) return '';
    const lines = steps.map((step, i) => `${i + 1}. ${String(step)}`).join('\n');
    return `\n【分析路径（SOP）】\n${lines}\n`;
  } catch (e) {
    logger.warn({ err: e?.message }, 'formatSopPromptAppendix failed');
    return '';
  }
}
