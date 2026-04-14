/**
 * 董事长级综合诊断 — 注入晨报末尾的经营分析段
 *
 * 只在 ≥2个活跃异常时调用LLM做关联分析
 * 0-1个异常时只生成简短数据摘要
 * LLM失败时降级为纯数据摘要（零风险）
 */
import { query } from '../../utils/db.js';
import { logger } from '../../utils/logger.js';
import { callLLM } from '../llm-provider.js';
import { buildStoreProfilePromptBlock } from '../../config/store-profile.js';
import { expandAgentStoreLabels } from '../../config/store-mapping.js';
import { anomalyToScenario, matchTemplates, matchDBTemplates, formatTemplateOptions } from './action-templates.js';

function storePats(store) {
  return expandAgentStoreLabels(store).map(l => `%${l.replace(/%/g, '')}%`);
}

function shanghaiToday() {
  return new Date().toLocaleString('en-CA', { timeZone: 'Asia/Shanghai' }).slice(0, 10);
}

function addDays(ymd, n) {
  const d = new Date(`${ymd}T12:00:00+08:00`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toLocaleString('en-CA', { timeZone: 'Asia/Shanghai' }).slice(0, 10);
}

/**
 * 获取门店活跃异常
 */
async function getActiveAnomalies(store) {
  const today = shanghaiToday();
  const threeDaysAgo = addDays(today, -3);
  const r = await query(
    `SELECT anomaly_key, severity, trigger_date, trigger_value, store
     FROM anomaly_triggers
     WHERE store ILIKE ANY($1::text[])
       AND trigger_date >= $2::date
       AND COALESCE(status, '') NOT IN ('pending_data', 'superseded', 'resolved')
     ORDER BY trigger_date DESC`,
    [storePats(store), threeDaysAgo]
  );
  return r.rows || [];
}

/**
 * 获取昨日数据摘要
 */
async function getYesterdaySummary(store, yesterday) {
  const r = await query(
    `SELECT actual_revenue, budget_rate, dine_traffic, dine_orders,
            efficiency, actual_margin
     FROM daily_reports
     WHERE store ILIKE ANY($1::text[]) AND date = $2::date
     LIMIT 1`,
    [storePats(store), yesterday]
  );
  return r.rows?.[0] || null;
}

/**
 * 获取菜品毛利排行
 */
async function getDishMarginRanking(store, yesterday) {
  try {
    const r = await query(
      `SELECT s.dish_name, SUM(s.qty) AS qty, SUM(s.sales_amount) AS revenue,
              c.unit_cost, c.dish_price,
              CASE WHEN c.dish_price > 0 THEN (c.dish_price - c.unit_cost) / c.dish_price ELSE 0 END AS margin_rate
       FROM sales_raw s
       LEFT JOIN dish_library_costs c ON c.dish_name = s.dish_name AND c.store ILIKE ANY($1::text[]) AND c.enabled = true
       WHERE s.store ILIKE ANY($1::text[]) AND s.date = $2::date
       GROUP BY s.dish_name, c.unit_cost, c.dish_price
       HAVING SUM(s.qty) >= 3
       ORDER BY (CASE WHEN c.dish_price > 0 THEN (c.dish_price - c.unit_cost) * SUM(s.qty) ELSE 0 END) DESC
       LIMIT 5`,
      [storePats(store), yesterday]
    );
    return (r.rows || []).map(row => ({
      name: row.dish_name,
      qty: Number(row.qty),
      revenue: Number(row.revenue),
      marginRate: row.margin_rate ? +(row.margin_rate * 100).toFixed(0) : null,
    }));
  } catch {
    return [];
  }
}

/**
 * 生成综合诊断文本
 */
export async function generateDiagnosis(store, yesterday) {
  try {
    const anomalies = await getActiveAnomalies(store);
    const yesterdayData = await getYesterdaySummary(store, yesterday);
    const dishRanking = await getDishMarginRanking(store, yesterday);
    const profileBlock = buildStoreProfilePromptBlock(store);

    if (!yesterdayData) return null;

    const dataSection = buildDataSection(yesterdayData, dishRanking);
    const anomalySection = buildAnomalySection(anomalies);

    if (anomalies.length >= 2) {
      return await generateLLMDiagnosis(store, profileBlock, dataSection, anomalySection, anomalies, yesterday);
    }

    if (anomalies.length === 1) {
      const a = anomalies[0];
      const scenario = anomalyToScenario(a.anomaly_key);
      let templateText = '';
      if (scenario) {
        const templates = matchTemplates(scenario, store);
        const dbSuccesses = await matchDBTemplates(scenario, store);
        templateText = formatTemplateOptions(templates, dbSuccesses) || '';
      }
      return `**⚠️ 活跃异常**: ${a.anomaly_key}(${a.severity})\n${templateText}`;
    }

    return `**经营状态**: ✅ 正常\n${dataSection}`;

  } catch (e) {
    logger.warn({ err: e?.message, store }, 'chairman diagnosis failed');
    return null;
  }
}

function buildDataSection(data, dishes) {
  let section = `营收${fmtMoney(data.actual_revenue)} 达成率${fmtPct(data.budget_rate)}`;
  section += ` | 客流${data.dine_traffic || 0} 订单${data.dine_orders || 0}`;
  if (data.efficiency) section += ` | 人效${fmtMoney(data.efficiency)}`;
  if (data.actual_margin) section += ` | 毛利率${fmtPct(data.actual_margin)}`;

  if (dishes.length) {
    section += '\n毛利贡献TOP: ' + dishes.map(d =>
      `${d.name}(${d.qty}份${d.marginRate ? '/毛利' + d.marginRate + '%' : ''})`
    ).join('、');
  }
  return section;
}

function buildAnomalySection(anomalies) {
  if (!anomalies.length) return '';
  return '异常: ' + anomalies.map(a => `${a.anomaly_key}(${a.severity}, ${String(a.trigger_date).slice(0, 10)})`).join('、');
}

async function generateLLMDiagnosis(store, profileBlock, dataSection, anomalySection, anomalies, yesterday) {
  const prompt = `${profileBlock}

你是餐饮经营分析专家。基于以下数据做简要诊断。

## ${store} ${yesterday} 数据
${dataSection}

## 活跃异常 (${anomalies.length}个)
${anomalySection}

请输出：
1. 一句话总结（含具体数据）
2. 2-3条关联分析（为什么这些异常有关联）
3. 每条分析不超过30字
不要输出JSON，不要空话，必须引用具体数字。`;

  try {
    const llmResult = await callLLM(prompt, { purpose: 'chairman_diagnosis', temperature: 0.2, maxTokens: 400 });
    if (!llmResult) return null;

    const scenarios = [...new Set(anomalies.map(a => anomalyToScenario(a.anomaly_key)).filter(Boolean))];
    let templateText = '';
    for (const scenario of scenarios.slice(0, 2)) {
      const templates = matchTemplates(scenario, store);
      const dbSuccesses = await matchDBTemplates(scenario, store);
      const formatted = formatTemplateOptions(templates, dbSuccesses);
      if (formatted) templateText += '\n' + formatted;
    }

    let result = `**🧠 经营诊断**\n${llmResult.slice(0, 500)}`;
    if (templateText) result += '\n' + templateText;
    return result;
  } catch (e) {
    logger.warn({ err: e?.message, store }, 'LLM diagnosis failed, fallback');
    return `**活跃异常(${anomalies.length}个)**: ${anomalySection}`;
  }
}

function fmtMoney(v) {
  const n = Number(v || 0);
  return n >= 10000 ? `${(n / 10000).toFixed(1)}万` : `${Math.round(n)}元`;
}

function fmtPct(v) {
  const n = Number(v || 0);
  if (n <= 1) return `${(n * 100).toFixed(0)}%`;
  return `${n.toFixed(0)}%`;
}
