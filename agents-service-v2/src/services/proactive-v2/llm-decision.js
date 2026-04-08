/**
 * LLM Decision Engine
 *
 * 使用本地 LLM (Ollama) 判断是否需要触发主动分析
 */

import config from './config.js';

/**
 * 使用 LLM 判断是否需要触发
 * @param {Object} anomaly - 异常对象
 * @returns {Promise<Object>} { triggered, reason, priority }
 */
async function decideWithLLM(anomaly) {
  const startTime = Date.now();

  try {
    const { type, store, severity, value } = anomaly;

    // 构建 prompt
    const prompt = buildPrompt(anomaly);

    // 调用 LLM
    const llmResponse = await callLLM(prompt);

    // 解析响应
    const result = parseLLMResponse(llmResponse);

    const elapsed = Date.now() - startTime;
    if (config.log) {
      console.log(`[Proactive][LLM] Decision: ${store}/${type} -> triggered=${result.triggered} (${elapsed}ms)`);
    }

    return result;

  } catch (err) {
    console.error('[Proactive][LLM] Error:', err.message);

    // Fallback 规则
    return fallbackDecision(anomaly);
  }
}

/**
 * 构建 prompt
 */
function buildPrompt(anomaly) {
  const { type, store, severity, value } = anomaly;

  let valueDesc = '';
  if (value) {
    if (typeof value === 'object') {
      valueDesc = JSON.stringify(value);
    } else {
      valueDesc = String(value);
    }
  }

  return `你是餐饮经营分析专家。

请判断以下异常是否需要触发主动分析。

输入信息：
- 异常类型: ${type}
- 门店: ${store}
- 严重程度: ${severity}
- 指标数据: ${valueDesc}

判断规则：
1. 营收下降超过20% → 必须触发
2. 差评激增 → 必须触发
3. 毛利率异常波动 → 需要触发
4. 人工成本异常 → 需要触发
5. 客流大幅下降 → 需要触发

请输出 JSON 格式：
{
  "triggered": true/false,
  "reason": "判断理由（简短）",
  "priority": "low|medium|high"
}`;
}

/**
 * 调用本地 LLM (Ollama)
 */
async function callLLM(prompt) {
  const { llmProvider, llm } = config;

  if (llmProvider.type === 'ollama') {
    const response = await fetch(llmProvider.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: llmProvider.model,
        prompt: prompt,
        stream: false,
        format: 'json',
      }),
    });

    if (!response.ok) {
      throw new Error(`LLM API error: ${response.status}`);
    }

    const data = await response.json();
    return data.response;
  } else if (llmProvider.type === 'http') {
    // 可扩展其他 HTTP 接口
    throw new Error('HTTP provider not implemented');
  } else {
    throw new Error(`Unknown LLM provider: ${llmProvider.type}`);
  }
}

/**
 * 解析 LLM 响应
 */
function parseLLMResponse(response) {
  try {
    // 尝试直接解析 JSON
    const parsed = JSON.parse(response);
    return {
      triggered: Boolean(parsed.triggered),
      reason: parsed.reason || '',
      priority: parsed.priority || 'medium',
    };
  } catch (err) {
    // 尝试提取 JSON 部分
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[0]);
        return {
          triggered: Boolean(parsed.triggered),
          reason: parsed.reason || '',
          priority: parsed.priority || 'medium',
        };
      } catch (e) {
        // 继续尝试 fallback
      }
    }

    // 解析失败，返回保守结果
    console.warn('[Proactive][LLM] Parse failed, using fallback');
    return {
      triggered: false,
      reason: 'LLM响应解析失败',
      priority: 'low',
    };
  }
}

/**
 * Fallback 决策规则
 */
function fallbackDecision(anomaly) {
  const { type, value } = anomaly;
  const { revenueDropThreshold, badReviewSpikeThreshold } = config.llm;

  // 规则1: 营收下降 >20%
  if (type === 'revenue_drop') {
    const dropPercent = extractPercentage(value);
    if (dropPercent !== null && dropPercent > revenueDropThreshold) {
      return {
        triggered: true,
        reason: `营收下降${dropPercent}%超过阈值`,
        priority: 'high',
      };
    }
  }

  // 规则2: 差评激增
  if (type === 'bad_review_spike') {
    const count = extractCount(value);
    if (count !== null && count >= badReviewSpikeThreshold) {
      return {
        triggered: true,
        reason: `差评${count}条超过阈值`,
        priority: 'high',
      };
    }
  }

  // 默认：不触发
  return {
    triggered: false,
    reason: '未达到触发条件',
    priority: 'low',
  };
}

/**
 * 从值中提取百分比
 */
function extractPercentage(value) {
  if (typeof value === 'number') return value;
  if (typeof value === 'object') {
    if (value.drop_percent) return value.drop_percent;
    if (value.percent) return value.percent;
  }
  const match = String(value).match(/(\d+(?:\.\d+)?)\s*%/);
  return match ? parseFloat(match[1]) : null;
}

/**
 * 从值中提取数量
 */
function extractCount(value) {
  if (typeof value === 'number') return value;
  if (typeof value === 'object') {
    if (value.count) return value.count;
    if (value.review_count) return value.review_count;
  }
  const match = String(value).match(/(\d+)/);
  return match ? parseInt(match[1], 10) : null;
}

export default {
  decideWithLLM,
};
