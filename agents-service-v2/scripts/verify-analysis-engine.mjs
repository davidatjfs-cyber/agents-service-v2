/**
 * 一次性验证 analysis-engine 与 unified prompt 片段（需 DATABASE_URL，可选 VERIFY_STORE / VERIFY_RANGE）
 */
import 'dotenv/config';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import {
  analyzeMetricTree,
  isAbnormal,
  previousPeriodRange,
  formatMetricAnalysisForPrompt
} from '../src/services/analysis-engine.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const range = process.env.VERIFY_RANGE || '2026-03-20~2026-03-26';
const store = process.env.VERIFY_STORE || '洪潮';

console.log('[1] previousPeriodRange(%s) => %s', range, previousPeriodRange(range));
console.log('[2] isAbnormal drop>10%%: 80 vs 100 =>', isAbnormal('t', 80, 100), '| 95 vs 100 =>', isAbnormal('t', 95, 100));

const r = await analyzeMetricTree('revenue', store, range);
console.log('[3] result keys:', Object.keys(r));
console.log('[3b] tree:', r.tree?.length, 'root_causes:', JSON.stringify(r.root_causes), 'confidence:', r.confidence);
if (r.tree?.length) {
  const maxLv = Math.max(...r.tree.map((n) => n.level));
  console.log('[3c] max level in tree:', maxLv, '(expect <=3)');
}
console.log('[4] format prompt chars:', formatMetricAnalysisForPrompt(r).length);

const uPath = join(__dirname, '../src/services/unified-agent-system-prompt.js');
const u = readFileSync(uPath, 'utf8');
console.log('[5] unified-agent-system-prompt 含「分析结果使用规则」:', u.includes('【分析结果使用规则（强制）】'));
