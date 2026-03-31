/**
 * 将 mock root_causes 拼入 prompt 后调用 LLM，验证回复是否引用客流/traffic。
 */
import 'dotenv/config';
process.env.ENABLE_EXTERNAL = process.env.ENABLE_EXTERNAL || 'true';
import { fileURLToPath } from 'url';
import path from 'path';
import { callLLM } from '../src/services/llm-provider.js';

const ROOT_CAUSES = [{ metric: 'traffic', reason: '下降20%' }];

export async function runRootCauseUsageTest() {
  const sys = `你是门店经营顾问。

【关键问题 root_causes】（系统已判定，必须优先采纳）
${ROOT_CAUSES.map((x) => `* ${x.metric}: ${x.reason}`).join('\n')}

【分析结果使用规则（强制）】
必须基于 root_causes 展开，禁止忽略。`;

  const user = '请根据以上根因给出简短可执行建议（不超过 200 字）。';

  try {
    const r = await callLLM(
      [{ role: 'system', content: sys }, { role: 'user', content: user }],
      { temperature: 0.2, max_tokens: 400, purpose: 'test_root_cause', context: { intent: 'analysis', complexity: 'medium', mode: 'single' } }
    );
    const out = String(r?.content || '');
    const passed = /客流|traffic/i.test(out);
    return {
      test: 'root_cause_usage',
      passed,
      ...(passed ? {} : { snippet: out.slice(0, 200) })
    };
  } catch (e) {
    return { test: 'root_cause_usage', passed: false, reason: String(e?.message || e) };
  }
}

const __filename = fileURLToPath(import.meta.url);
const isMain = path.resolve(process.argv[1] || '') === path.resolve(__filename);
if (isMain) {
  runRootCauseUsageTest().then((r) => {
    console.log(JSON.stringify(r, null, 2));
    process.exit(r.passed ? 0 : 1);
  });
}
