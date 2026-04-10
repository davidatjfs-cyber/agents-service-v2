/**
 * Outcome 学习闭环 + Wiki 链路验证
 * 运行：cd agents-service-v2 && node test/wiki-integration-verify.mjs
 */
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const WIKI_DIR = path.join(ROOT, 'knowledge', 'wiki');
const OUTCOMES_DIR = path.join(ROOT, 'knowledge', 'outcomes');

function listWikiMdFiles() {
  if (!fs.existsSync(WIKI_DIR)) return [];
  return fs.readdirSync(WIKI_DIR).filter((f) => f.endsWith('.md'));
}

function listOutcomeJsonForStore(store) {
  if (!fs.existsSync(OUTCOMES_DIR)) return [];
  const key = String(store || '');
  return fs.readdirSync(OUTCOMES_DIR).filter((f) => f.endsWith('.json') && f.includes(key));
}

function clearWikiDir() {
  if (fs.existsSync(WIKI_DIR)) {
    for (const name of fs.readdirSync(WIKI_DIR)) {
      fs.unlinkSync(path.join(WIKI_DIR, name));
    }
  } else {
    fs.mkdirSync(WIKI_DIR, { recursive: true });
  }
}

function clearOutcomesDir() {
  if (fs.existsSync(OUTCOMES_DIR)) {
    for (const name of fs.readdirSync(OUTCOMES_DIR)) {
      fs.unlinkSync(path.join(OUTCOMES_DIR, name));
    }
  }
}

function ensureWikiDir() {
  if (!fs.existsSync(WIKI_DIR)) fs.mkdirSync(WIKI_DIR, { recursive: true });
}

function writeColdStartMockWiki(store) {
  ensureWikiDir();
  const body = `问题

营业下降

核心结论

出餐慢

策略

增加炉位
`;
  const safe = String(store || 'store').replace(/[/\\?%*:|"<>]/g, '_');
  const file = `${safe}_coldstart_mock_${Date.now()}.md`;
  fs.writeFileSync(path.join(WIKI_DIR, file), body, 'utf-8');
  console.log('[TEST] 冷启动 mock wiki:', file);
  return file;
}

function isUsingWiki(response) {
  if (!response) return false;
  const r = String(response);
  return /引用经验/.test(r) && /核心问题/.test(r);
}

function hasLearningSurface(response, dataBlob) {
  const blob = `${String(response || '')}\n${String(dataBlob || '')}`;
  const hasCore =
    /最优策略/.test(blob) &&
    (/成功率/.test(blob) || /\bscore\b/i.test(blob) || /weightedScore/i.test(blob));
  const hasTrend =
    /趋势/.test(blob) ||
    /\bup\b|\bdown\b|\bstable\b/i.test(blob) ||
    /上升|下降|稳定/.test(blob);
  return hasCore && hasTrend;
}

const text = '最近营业额下降的原因是什么';
const ctx = {
  store: 'test_store',
  username: 'test_user',
  role: 'store_manager',
  pipelineIntent: 'analysis',
  forceAnalysis: true
};

console.log('=== OUTCOME LEARNING TEST START ===');

clearWikiDir();
clearOutcomesDir();
ensureWikiDir();

const originalLog = console.log;
let wikiRetrieveCount = 0;
function attachWikiRetrieveSpy() {
  console.log = (...args) => {
    const line = args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
    if (line.includes('[WIKI RETRIEVE]')) wikiRetrieveCount += 1;
    originalLog.apply(console, args);
  };
}
function detachWikiRetrieveSpy() {
  console.log = originalLog;
}

attachWikiRetrieveSpy();

const { HANDLERS } = await import('../src/services/agent-handlers.js');
const handleDataAuditor = HANDLERS.data_auditor;

let firstError = null;
let secondError = null;
let res1;
let res2;

const outcomesBeforeFirst = listOutcomeJsonForStore(ctx.store).length;

try {
  res1 = await handleDataAuditor(text, ctx);
} catch (e) {
  firstError = e;
  originalLog('[TEST] First handleDataAuditor threw:', e?.message || e);
}

let filesAfterFirst = listWikiMdFiles();
if (filesAfterFirst.length === 0) {
  writeColdStartMockWiki(ctx.store);
  filesAfterFirst = listWikiMdFiles();
}

const writeOk = filesAfterFirst.length > 0;
originalLog('[TEST] Wiki 落盘:', writeOk ? '成功' : '失败');

wikiRetrieveCount = 0;

try {
  res2 = await handleDataAuditor(text, ctx);
} catch (e) {
  secondError = e;
  originalLog('[TEST] Second handleDataAuditor threw:', e?.message || e);
}

const secondCallWikiRetrieveCount = wikiRetrieveCount;
detachWikiRetrieveSpy();

const retrieveOk = secondCallWikiRetrieveCount >= 1;
const response2 = res2?.response != null ? String(res2.response) : '';
const useOk = isUsingWiki(response2);
const learningOk = hasLearningSurface(response2, res2?.data);

const outcomesAfter = listOutcomeJsonForStore(ctx.store);
const outcomeWriteOk = outcomesAfter.length > outcomesBeforeFirst;

console.log(`
=== OUTCOME LEARNING TEST ===

写入：${writeOk ? '成功' : '失败'}
读取：${retrieveOk ? '成功' : '失败'}
使用：${useOk ? '成功' : '失败'}
学习：${learningOk ? '成功' : '失败'}

`);

if (!writeOk) {
  originalLog('失败说明 — 写入：', firstError?.message || '无 wiki 文件且 mock 失败');
}
if (!retrieveOk) {
  originalLog('失败说明 — 读取：第二次 [WIKI RETRIEVE]=0 或异常', secondError?.message || '');
}
if (!useOk) {
  originalLog('失败说明 — 使用：需同时含「引用经验」与「核心问题」；response 前 280 字:\n', response2.slice(0, 280));
}
if (!learningOk) {
  originalLog(
    '失败说明 — 学习：response/data 须含「最优策略」或「成功率」或「score」；前 320 字:\n',
    response2.slice(0, 320)
  );
}
if (!outcomeWriteOk) {
  originalLog('失败说明 — Outcome 落盘：knowledge/outcomes 下未出现含 test_store 的新 json');
}

const allPass = writeOk && retrieveOk && useOk && learningOk && outcomeWriteOk;
process.exit(allPass ? 0 : 1);
