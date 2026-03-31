/**
 * 同一输入重复 5 次，统计「订单+客流」路径在最终输出中的一致出现率。
 */
import 'dotenv/config';
process.env.ENABLE_EXTERNAL = process.env.ENABLE_EXTERNAL || 'true';
import { fileURLToPath } from 'url';
import path from 'path';
import { runAgentAnalysisPipeline } from './helpers/pipeline-test-utils.js';

const INPUT = '门店营收下降，请分析';
const RUNS = 5;

function pathHit(output) {
  const o = String(output || '');
  const hasOrd = /orders|订单|堂食.*单/i.test(o);
  const hasTr = /traffic|客流/i.test(o);
  return hasOrd && hasTr;
}

export async function runStabilityTest() {
  const store = process.env.TEST_STORE || '洪潮大宁久光店';
  const ctx = {
    store,
    username: process.env.TEST_USERNAME || 'ai_verify_user',
    role: 'store_manager',
    name: 'AI验证'
  };

  let hits = 0;
  const errors = [];
  for (let i = 0; i < RUNS; i++) {
    try {
      const r = await runAgentAnalysisPipeline(INPUT, ctx, {
        skipPlanner: true,
        forceDataAuditor: true
      });
      if (pathHit(r.text)) hits++;
      else errors.push({ i, head: r.text.slice(0, 120), source: r.source });
    } catch (e) {
      errors.push({ i, err: e?.message || String(e) });
    }
  }

  const consistency = hits / RUNS;
  const passed = consistency >= 0.8;
  return {
    test: 'stability',
    consistency: Math.round(consistency * 1000) / 1000,
    passed,
    hits,
    runs: RUNS,
    ...(passed ? {} : { errors })
  };
}

const __filename = fileURLToPath(import.meta.url);
const isMain = path.resolve(process.argv[1] || '') === path.resolve(__filename);
if (isMain) {
  runStabilityTest().then((r) => {
    console.log(JSON.stringify(r, null, 2));
    process.exit(r.passed ? 0 : 1);
  });
}
