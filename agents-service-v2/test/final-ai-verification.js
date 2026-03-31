/**
 * 汇总 AI 验证测试并给出 0–100 分（每项 33 分，全过 100）。
 */
import 'dotenv/config';
process.env.ENABLE_EXTERNAL = process.env.ENABLE_EXTERNAL || 'true';
import { fileURLToPath } from 'url';
import path from 'path';
import { runRealAnalysisTest } from './test-real-analysis.js';
import { runRootCauseUsageTest } from './test-root-cause-usage.js';
import { runStabilityTest } from './test-decision-stability.js';

const PTS = 33;

function icon(p) {
  return p ? '✅' : '❌';
}

export async function runFinalAiVerification() {
  const [a, b, c] = await Promise.all([runRealAnalysisTest(), runRootCauseUsageTest(), runStabilityTest()]);

  let score = 0;
  if (a.passed) score += PTS;
  if (b.passed) score += PTS;
  if (c.passed) score += PTS;
  if (a.passed && b.passed && c.passed) score = 100;

  const lines = [
    '===== FINAL AI VALIDATION =====',
    '',
    `real_analysis: ${icon(a.passed)}`,
    `root_cause_usage: ${icon(b.passed)}`,
    `stability: ${icon(c.passed)}`,
    '',
    `FINAL SCORE: ${score}/100`,
    '',
    '--- details ---',
    JSON.stringify({ real_analysis: a, root_cause_usage: b, stability: c }, null, 2)
  ];

  return { text: lines.join('\n'), score, results: { real_analysis: a, root_cause_usage: b, stability: c } };
}

const __filename = fileURLToPath(import.meta.url);
const isMain = path.resolve(process.argv[1] || '') === path.resolve(__filename);
if (isMain) {
  runFinalAiVerification()
    .then(({ text, score }) => {
      console.log(text);
      process.exit(score >= 100 ? 0 : 1);
    })
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
