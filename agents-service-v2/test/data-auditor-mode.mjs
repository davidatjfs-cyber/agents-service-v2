/**
 * data_auditor 模式：Data vs Decision
 * 运行：cd agents-service-v2 && node test/data-auditor-mode.mjs
 */
import 'dotenv/config';

import { detectDecisionMode, HANDLERS } from '../src/services/agent-handlers.js';

const ctx = {
  store: 'test_store',
  username: 'mode_tester',
  role: 'store_manager',
  pipelineIntent: 'query',
  forceAnalysis: false
};

const q1 = '昨天营业额多少？';
const q2 = '最近营业下降怎么办？';

const m1 = detectDecisionMode(q1);
const m2 = detectDecisionMode(q2);
if (m1 !== 'data' || m2 !== 'decision') {
  console.error('FAIL: 模式判定', m1, m2, '期望 data / decision');
  process.exit(1);
}

const r1 = await HANDLERS.data_auditor(q1, ctx);
const blob1 = `${String(r1?.response || '')}\n${String(r1?.data || '')}`;
const dataOk =
  !blob1.includes('【引用经验】') &&
  !blob1.includes('【核心问题】') &&
  !blob1.includes('策略效果统计') &&
  !blob1.includes('历史经验（必须引用）') &&
  !blob1.includes('最优策略');

const r2 = await HANDLERS.data_auditor(q2, ctx);
const blob2 = `${String(r2?.response || '')}\n${String(r2?.data || '')}`;
// 决策类问题：可能走「月报对比+LLM」分支（【问题分析】/【行动建议】）或主链路（Wiki/最优策略）
const decisionOk =
  /最优策略|【引用经验】|策略效果统计|历史经验（必须引用）/.test(blob2) ||
  /【问题分析】|【行动建议】/.test(blob2);

console.log('=== DATA AUDITOR MODE TEST ===');
console.log('测试1 模式:', m1, '| 无 Wiki 四段/最优策略:', dataOk ? '通过' : '失败');
console.log('测试2 模式:', m2, '| 决策类输出特征:', decisionOk ? '通过' : '失败');

if (!dataOk || !decisionOk) {
  console.log('--- q1 blob 片段 ---\n', blob1.slice(0, 500));
  console.log('--- q2 blob 片段 ---\n', blob2.slice(0, 800));
  process.exit(1);
}

process.exit(0);
