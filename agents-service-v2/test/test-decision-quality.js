/**
 * 决策质量：root_cause = traffic 时，建议须贴合曝光/投放/引流，且不得泛泛「成本优化」「人效优化」。
 * 使用 test/mock-data.js 中的复杂场景拼入 prompt，调用真实 LLM。
 */
import 'dotenv/config';
process.env.ENABLE_EXTERNAL = process.env.ENABLE_EXTERNAL || 'true';
import { fileURLToPath } from 'url';
import path from 'path';
import { callLLM } from '../src/services/llm-provider.js';
import {
  SCENARIO_PARTIAL_TREE_NULL,
  SCENARIO_MULTI_SIGNAL_ANOMALY,
  SCENARIO_CONFLICTING_DIRECTIONS,
  formatScenarioMetricsForPrompt
} from './mock-data.js';

const TRAFFIC_KEYWORDS = /曝光|投放|引流|获客|拉新|推广|线上|线下引流|地推|美团|大众点评|抖音/i;
const FORBIDDEN_WHEN_TRAFFIC_ROOT = /成本优化|人效优化/;

function evaluateDecisionQuality(output) {
  const out = String(output || '').trim();
  if (!out) {
    return { passed: false, reason: 'LLM 返回为空' };
  }
  const hasTrafficLens = TRAFFIC_KEYWORDS.test(out);
  const hasForbidden = FORBIDDEN_WHEN_TRAFFIC_ROOT.test(out);
  if (hasForbidden) {
    return {
      passed: false,
      reason: '根因为客流时不应主推「成本优化/人效优化」类表述',
      snippet: out.slice(0, 280)
    };
  }
  if (!hasTrafficLens) {
    return {
      passed: false,
      reason: '根因为客流时建议应体现曝光/投放/引流等获客侧动作之一',
      snippet: out.slice(0, 280)
    };
  }
  return { passed: true };
}

export async function runDecisionQualityTest() {
  const blockPartial = formatScenarioMetricsForPrompt(SCENARIO_PARTIAL_TREE_NULL);
  const blockMulti = formatScenarioMetricsForPrompt(SCENARIO_MULTI_SIGNAL_ANOMALY);
  const blockConflict = formatScenarioMetricsForPrompt(SCENARIO_CONFLICTING_DIRECTIONS);

  const sys = `你是餐饮企业门店经营顾问，只根据下方数据与 root_causes 给建议。

【指标快照 A — 子指标缺失】
${blockPartial}

【指标快照 B — 多指标异动】
${blockMulti}

【指标快照 C — 方向冲突（理解即可）】
${blockConflict}

【关键问题 root_causes】（系统已判定，必须优先采纳；主因唯一）
* traffic: 堂食客流较上周期明显下降，为当前首要根因。

【强制规则】
1. 所有可执行建议必须与「客流/获客」一致：侧重曝光、投放、引流、拉新或渠道，可提及缺数情况下如何用运营动作验证。
2. 禁止把主因归结为压缩人力成本或泛泛「成本优化」「人效优化」作为主要手段。
3. 不要编造 exposure、walk_in_rate 的具体数值（上表为 null 即视为未知）。`;

  const user =
    '请给出 4～6 条简短可执行建议（分条列出），并一两句说明与客流根因的对应关系。总字数不超过 350 字。';

  try {
    const r = await callLLM(
      [{ role: 'system', content: sys }, { role: 'user', content: user }],
      {
        temperature: 0.15,
        max_tokens: 500,
        purpose: 'test_decision_quality',
        context: { intent: 'analysis', complexity: 'high', mode: 'single' }
      }
    );
    if (r && r.ok === false) {
      const msg =
        r.error === 'external_disabled'
          ? '外部 LLM 未启用（请设置 ENABLE_EXTERNAL=true）'
          : `LLM 调用失败: ${r.error || 'unknown'}`;
      return { test: 'decision_quality', passed: false, reason: msg };
    }
    const ev = evaluateDecisionQuality(r?.content);
    return {
      test: 'decision_quality',
      passed: ev.passed,
      ...(ev.reason ? { reason: ev.reason, snippet: ev.snippet } : {})
    };
  } catch (e) {
    return { test: 'decision_quality', passed: false, reason: String(e?.message || e) };
  }
}

const __filename = fileURLToPath(import.meta.url);
const isMain = path.resolve(process.argv[1] || '') === path.resolve(__filename);
if (isMain) {
  runDecisionQualityTest().then((r) => {
    console.log(JSON.stringify(r, null, 2));
    process.exit(r.passed ? 0 : 1);
  });
}
