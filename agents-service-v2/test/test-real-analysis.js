/**
 * 验证：真实编排 + data_auditor 路径下，最终输出是否体现指标拆解。
 * 环境：DATABASE_URL、LLM Key；TEST_STORE
 */
import 'dotenv/config';
process.env.ENABLE_EXTERNAL = process.env.ENABLE_EXTERNAL || 'true';
import { fileURLToPath } from 'url';
import path from 'path';
import { runAgentAnalysisPipeline } from './helpers/pipeline-test-utils.js';
import { analyzeMetricTree } from '../src/services/analysis-engine.js';
import { extractTimeRangeFromText } from '../src/services/data-executor.js';

const INPUT = '门店最近营收下降，请分析原因并给出建议';

function hasMetricLayerInText(output) {
  const o = String(output || '');
  const hasOrders = /orders|\b订单\b|堂食.*单|订单数|单量/i.test(o);
  const hasTraffic = /traffic|客流|人流量/i.test(o);
  const hasAvg = /avg_order_value|客单价|客单/i.test(o);
  return { hasOrders, hasTraffic, hasAvg };
}

function hasReasoningPath(output) {
  const o = String(output || '');
  if (/(→|➜|=>)/.test(o)) return true;
  if (/营收.*订单|订单.*客流|客流.*营收|下降.*链|拆解|指标.*关联|从.*到/.test(o)) return true;
  if (/orders/i.test(o) && /traffic/i.test(o) && /(下降|减少|偏低|变少)/.test(o)) return true;
  if (/订单/.test(o) && /客流/.test(o) && /(下降|减少|偏低|变少)/.test(o)) return true;
  return false;
}

function notOnlyImmediateAdvice(output) {
  const o = String(output || '').trim();
  if (o.length < 30) return false;
  const m = o.match(/(建议|行动方案|可执行)/);
  if (!m || m.index === undefined) return true;
  const before = o.slice(0, m.index);
  return /(分析|因为|由于|指标|营收|订单|客流|拆解|数据|原因)/.test(before);
}

export async function runRealAnalysisTest() {
  const store = process.env.TEST_STORE || '洪潮大宁久光店';
  const ctx = {
    store,
    username: process.env.TEST_USERNAME || 'ai_verify_user',
    role: 'store_manager',
    name: 'AI验证'
  };

  const tr = extractTimeRangeFromText(INPUT);
  let treeRes0 = { tree: [] };
  let backendTreeOk = false;
  try {
    treeRes0 = await analyzeMetricTree('revenue', store, tr);
    const ids = new Set((treeRes0.tree || []).map((n) => n.metric));
    backendTreeOk = ids.has('orders') && ids.has('traffic');
  } catch (e) {
    return {
      test: 'real_analysis',
      passed: false,
      reason: `analyzeMetricTree/DB failed: ${e?.message || e}`
    };
  }

  if (!backendTreeOk) {
    return {
      test: 'real_analysis',
      passed: false,
      reason: 'metric_dictionary 拆解树未包含 orders+traffic（后端未就绪）'
    };
  }

  let output = '';
  let source = '';
  try {
    let r = await runAgentAnalysisPipeline(INPUT, ctx, {});
    output = r.text;
    source = r.source;

    const layer = hasMetricLayerInText(output);
    if (!(layer.hasOrders && layer.hasTraffic)) {
      const r2 = await runAgentAnalysisPipeline(INPUT, ctx, { skipPlanner: true, forceDataAuditor: true });
      output = r2.text;
      source = `${source} -> ${r2.source}`;
    }
  } catch (e) {
    return {
      test: 'real_analysis',
      passed: false,
      reason: `pipeline error: ${e?.message || e}`
    };
  }

  const layer = hasMetricLayerInText(output);
  const userKeywordFail = !/orders/i.test(output) && !/traffic/i.test(output) && !/订单/.test(output) && !/客流/.test(output);
  if (userKeywordFail) {
    return {
      test: 'real_analysis',
      passed: false,
      reason: `最终输出缺少 orders/traffic 或中文等价词；source=${source}；head=${output.slice(0, 240)}`
    };
  }

  if (!(layer.hasOrders && layer.hasTraffic)) {
    return {
      test: 'real_analysis',
      passed: false,
      reason: `需同时体现订单维度与客流维度；source=${source}`
    };
  }

  const hasAvgInTree = (treeRes0.tree || []).some((n) => n.metric === 'avg_order_value');
  if (!layer.hasAvg && !hasAvgInTree) {
    return {
      test: 'real_analysis',
      passed: false,
      reason: '缺少客单价/avg_order_value（输出与树均未体现）'
    };
  }

  if (!hasReasoningPath(output)) {
    return {
      test: 'real_analysis',
      passed: false,
      reason: `未见中间推理路径（因果/拆解链）；source=${source}`
    };
  }

  if (!notOnlyImmediateAdvice(output)) {
    return {
      test: 'real_analysis',
      passed: false,
      reason: '输出过早进入「建议」而缺少前置分析语境'
    };
  }

  return {
    test: 'real_analysis',
    passed: true,
    reason: `ok backendTree=orders+traffic source=${source}`
  };
}

const __filename = fileURLToPath(import.meta.url);
const isMain = path.resolve(process.argv[1] || '') === path.resolve(__filename);
if (isMain) {
  runRealAnalysisTest().then((r) => {
    console.log(JSON.stringify(r, null, 2));
    process.exit(r.passed ? 0 : 1);
  });
}
