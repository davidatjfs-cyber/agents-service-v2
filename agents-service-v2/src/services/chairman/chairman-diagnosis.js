/**
 * 董事长级综合诊断 — 注入晨报末尾的经营分析段
 *
 * 只在 ≥2个活跃异常时调用LLM做关联分析
 * 0-1个异常时只生成简短数据摘要
 * LLM失败时降级为纯数据摘要（零风险）
 */
import { query } from '../../utils/db.js';
import { logger } from '../../utils/logger.js';
import { callLLM, normalizeAssistantMessageContent } from '../llm-provider.js';
import { buildStoreProfilePromptBlock } from '../../config/store-profile.js';
import { expandAgentStoreLabels } from '../../config/store-mapping.js';
import { anomalyRuleLabelZh } from '../../utils/anomaly-labels.js';
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
       AND trigger_date::date <= $3::date
       AND COALESCE(status, '') NOT IN ('pending_data', 'superseded', 'resolved')
     ORDER BY trigger_date DESC`,
    [storePats(store), threeDaysAgo, today]
  );
  return r.rows || [];
}

function severityZhBrief(s) {
  const x = String(s || '').toLowerCase();
  if (x === 'high') return '高';
  if (x === 'medium') return '中';
  if (x === 'low') return '低';
  return s || '';
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
      // 晨报上文已有「近3天异常」中文列表，此处不再重复英文 anomaly_key
      if (templateText && String(templateText).trim()) {
        return `**🧠 经营诊断 · 处置参考**\n\n${templateText.trim()}\n\n_说明：异常类型与日期已列于晨报上文「近3天异常提醒」，此处仅补充处置模板。_`;
      }
      return null;
    }

    return `**🧠 经营诊断**\n\n**经营状态**：✅ 正常\n\n${dataSection}`;

  } catch (e) {
    logger.warn({ err: e?.message, store }, 'chairman diagnosis failed');
    return null;
  }
}

function buildDataSection(data, dishes) {
  const dineRev = Number(data.dine_revenue || 0);
  const delivRev = Number(data.delivery_actual || 0);
  const dineOrders = Number(data.dine_orders || 0);
  const delivOrders = Number(data.delivery_orders || 0);
  const hasTakeout = delivRev > 0 || delivOrders > 0;

  let section = '';
  if (hasTakeout) {
    const dineAvg = dineOrders > 0 ? Math.round(dineRev / dineOrders) : 0;
    const delivAvg = delivOrders > 0 ? Math.round(delivRev / delivOrders) : 0;
    section = `总营收${fmtMoney(data.actual_revenue)} 达成率${fmtPct(data.budget_rate)}`;
    section += ` | 堂食: ${fmtMoney(dineRev)}/${dineOrders}单/客单${dineAvg}元`;
    section += ` | 外卖: ${fmtMoney(delivRev)}/${delivOrders}单/客单${delivAvg}元`;
    section += ` | 客流${data.dine_traffic || 0}`;
  } else {
    section = `营收${fmtMoney(data.actual_revenue)} 达成率${fmtPct(data.budget_rate)}`;
    section += ` | 客流${data.dine_traffic || 0} 订单${dineOrders}`;
  }
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
  return anomalies
    .map(
      (a) =>
        `${anomalyRuleLabelZh(a.anomaly_key)}（严重度：${severityZhBrief(a.severity)}，${String(a.trigger_date).slice(0, 10)}）`
    )
    .join('；');
}

async function generateLLMDiagnosis(store, profileBlock, dataSection, anomalySection, anomalies, yesterday) {
  const prompt = `${profileBlock}

你是餐饮经营分析专家。基于以下数据做简要诊断。

## ${store} ${yesterday} 数据
${dataSection}

## 活跃异常 (${anomalies.length}个，以下为中文摘要；晨报前文可能已列异常名，请勿再逐条复读）
${anomalySection}

请输出：
1. 一句话总结（含具体数据）
2. 2-3条关联分析（为什么这些异常有关联）
3. 每条分析不超过30字
不要输出JSON，不要空话，必须引用具体数字；不要使用英文 anomaly_key（如 recharge_zero）。`;

  try {
    const _raw = await callLLM(prompt, { purpose: 'chairman_diagnosis', temperature: 0.2, maxTokens: 400 });
    if (!_raw) return null;
    const llmResult = normalizeAssistantMessageContent(
      typeof _raw === 'string' ? _raw : (_raw?.content ?? _raw?.message?.content)
    );
    const safeSummary =
      llmResult.trim() ||
      (typeof _raw === 'object' && _raw.ok === false ? '（模型暂不可用，以下为处置参考模板。）' : '（暂无模型文字摘要，以下为处置参考模板。）');

    const scenarios = [...new Set(anomalies.map(a => anomalyToScenario(a.anomaly_key)).filter(Boolean))];
    let templateText = '';
    for (const scenario of scenarios.slice(0, 2)) {
      const templates = matchTemplates(scenario, store);
      const dbSuccesses = await matchDBTemplates(scenario, store);
      const formatted = formatTemplateOptions(templates, dbSuccesses);
      if (formatted) templateText += '\n' + formatted;
    }

    let result = `**🧠 经营诊断**\n\n${safeSummary.slice(0, 500)}`;
    if (templateText) result += '\n\n' + templateText.trim();
    result += '\n\n_说明：请勿与上文「近3天异常提醒」逐条对抄；以关联分析与可执行动作为主。_';
    return result;
  } catch (e) {
    logger.warn({ err: e?.message, store }, 'LLM diagnosis failed, fallback');
    return `**活跃异常（${anomalies.length} 条）**\n${anomalySection}`;
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
