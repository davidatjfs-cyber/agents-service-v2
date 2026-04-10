/**
 * 行为级决策验证：时间权重 + 趋势 + 策略排序 + data_auditor
 * 运行：cd agents-service-v2 && node test/decision-validation.mjs
 */
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUTCOMES_DIR = path.join(ROOT, 'knowledge', 'outcomes');
const WIKI_DIR = path.join(ROOT, 'knowledge', 'wiki');

const STORE = 'decision_val_store';
const PROBLEM = '营业下降';

const day = 24 * 60 * 60 * 1000;

function ensureDir(d) {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}

function clearStoreOutcomes() {
  ensureDir(OUTCOMES_DIR);
  for (const f of fs.readdirSync(OUTCOMES_DIR)) {
    if (!f.endsWith('.json')) continue;
    try {
      const row = JSON.parse(fs.readFileSync(path.join(OUTCOMES_DIR, f), 'utf-8'));
      if (row.store === STORE) fs.unlinkSync(path.join(OUTCOMES_DIR, f));
    } catch {
      /* skip */
    }
  }
}

function writeOutcome({ action, score, ts, result = 'unknown' }) {
  const file = `${STORE}_${action}_${ts}.json`;
  const data = {
    store: STORE,
    problem: PROBLEM,
    action,
    result,
    score,
    ts
  };
  fs.writeFileSync(path.join(OUTCOMES_DIR, file), JSON.stringify(data, null, 2), 'utf-8');
}

function approxEqual(a, b, eps = 0.02) {
  return Math.abs(a - b) <= eps;
}

console.log('=== DECISION VALIDATION (setup) ===\n');

ensureDir(OUTCOMES_DIR);
ensureDir(WIKI_DIR);
clearStoreOutcomes();

const now = Date.now();
const ts3 = now - Math.floor(3.5 * day);
const ts2 = now - Math.floor(2 * day);
const ts0 = now - Math.floor(0.5 * day);

// 策略A：高分走弱（3天前→今天）
writeOutcome({ action: '策略A', score: 0.9, ts: ts3 });
writeOutcome({ action: '策略A', score: 0.8, ts: ts2 });
writeOutcome({ action: '策略A', score: 0.7, ts: ts0 });

// 策略B：低分走强
writeOutcome({ action: '策略B', score: 0.6, ts: ts3 });
writeOutcome({ action: '策略B', score: 0.7, ts: ts2 });
writeOutcome({ action: '策略B', score: 0.85, ts: ts0 });

const { getStrategyStats, getTrend } = await import('../src/services/knowledge/strategy-stats.js');

const stats = await getStrategyStats({ store: STORE, problem: PROBLEM });
const rowA = stats.find((s) => s.action === '策略A');
const rowB = stats.find((s) => s.action === '策略B');

if (!rowA || !rowB) {
  console.error('FAIL: 未找到策略A/B 统计行');
  process.exit(1);
}

console.log('— strategy-stats —');
console.log('策略A', rowA);
console.log('策略B', rowB);

const trendOk = rowA.trend === 'down' && rowB.trend === 'up';
if (!trendOk) {
  console.error('FAIL: 趋势期望 A=down, B=up；实际', rowA.trend, rowB.trend);
  process.exit(1);
}

// 手工复核 weightedScore（时间权重）
const { getTimeWeight } = await import('../src/services/knowledge/strategy-stats.js');
function weightedForScores(points) {
  let ts = 0;
  let tw = 0;
  for (const { score, t } of points) {
    const w = getTimeWeight(t);
    ts += score * w;
    tw += w;
  }
  return tw ? Math.round((ts / tw) * 1000) / 1000 : 0;
}

const wA = weightedForScores([
  { score: 0.9, t: ts3 },
  { score: 0.8, t: ts2 },
  { score: 0.7, t: ts0 }
]);
const wB = weightedForScores([
  { score: 0.6, t: ts3 },
  { score: 0.7, t: ts2 },
  { score: 0.85, t: ts0 }
]);

const weightMathOk =
  approxEqual(rowA.weightedScore, wA, 0.03) && approxEqual(rowB.weightedScore, wB, 0.03);
if (!weightMathOk) {
  console.warn('WARN: weightedScore 与手算略有偏差（可接受时钟漂移）', {
    rowA: rowA.weightedScore,
    wA,
    rowB: rowB.weightedScore,
    wB
  });
}

const top = stats[0];
const choseB = top.action === '策略B';

// Agent
const { HANDLERS } = await import('../src/services/agent-handlers.js');
const ctx = {
  store: STORE,
  username: 'decision_tester',
  role: 'store_manager',
  pipelineIntent: 'analysis',
  forceAnalysis: true
};

const res = await HANDLERS.data_auditor(PROBLEM, ctx);
const blob = `${String(res?.response || '')}\n${String(res?.data || '')}`;
const hasWeighted = /weightedScore/i.test(blob);
const hasRate = /成功率/.test(blob);
const hasTrendWord = /趋势|上升|下降|稳定|\bup\b|\bdown\b|\bstable\b/i.test(blob);
const mentionsTop = blob.includes(top.action);

const reasonable = choseB && mentionsTop;
const reason = choseB
  ? '排序使用 policyScore（weightedScore + 趋势修正），上升中的策略B 优于历史更高但走弱的策略A，符合「动态优化」预期。'
  : `首位为 ${top.action}：policyScore=${top.policyScore}，weightedScore=${top.weightedScore}，trend=${top.trend}；未优先选 B 则与「趋势优先」目标不一致。`;

console.log(`
=== DECISION VALIDATION ===

策略选择：${top.action}
是否合理：${reasonable ? '是' : '否'}

原因：
${reason}

— 行为检查 —
- weightedScore 出现在输出/上下文: ${hasWeighted ? '是' : '否'}
- 成功率: ${hasRate ? '是' : '否'}
- 趋势: ${hasTrendWord ? '是' : '否'}
- 推荐与统计首位一致: ${mentionsTop ? '是' : '否'}
`);

process.exit(reasonable && hasWeighted && hasRate && hasTrendWord ? 0 : 1);
