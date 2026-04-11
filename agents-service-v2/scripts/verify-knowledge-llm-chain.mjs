#!/usr/bin/env node
/**
 * 验证：Wiki 落盘、MemPalace 可达、DeepSeek / Ollama 知识排序链路。
 * 在 agents-service-v2 根目录执行：node scripts/verify-knowledge-llm-chain.mjs
 * 生产：cd /opt/agents-service-v2 && node scripts/verify-knowledge-llm-chain.mjs
 */
import 'dotenv/config';
import axios from 'axios';
import { probeWikiKnowledgeHealth } from '../src/services/knowledge/wiki-retriever.js';
import { probeMemPalaceHealth } from '../src/services/memory-adapter.js';
import { rankKnowledgeCandidatesWithLlm, useKnowledgeLlmRanking } from '../src/services/knowledge/deepseek-knowledge.js';
import { callDeepSeek } from '../src/services/llm-provider.js';
import { callOllamaLLM } from '../src/services/llm-provider.js';

async function pingDeepSeek() {
  const key = String(process.env.DEEPSEEK_API_KEY || '').trim();
  if (!key) return { ok: false, skip: true, reason: 'DEEPSEEK_API_KEY 未设置' };
  try {
    await callDeepSeek('仅回复 JSON：{"ok":true}', {
      systemPrompt: '只输出 JSON，不要其它文字。',
      max_tokens: 32,
      timeoutMs: 20000
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
}

async function pingOllama() {
  try {
    const r = await callOllamaLLM(
      [
        { role: 'system', content: '只输出一个词：pong' },
        { role: 'user', content: 'ping' }
      ],
      { purpose: 'verify_knowledge_chain', max_tokens: 8, temperature: 0 }
    );
    return { ok: !!r?.ok, content: String(r?.content || '').slice(0, 40), error: r?.error || '' };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
}

async function main() {
  const report = {
    time: new Date().toISOString(),
    wiki: probeWikiKnowledgeHealth(),
    mempalace: await probeMemPalaceHealth(),
    useKnowledgeLlmRanking: useKnowledgeLlmRanking(),
    deepseekPing: await pingDeepSeek(),
    ollamaPing: await pingOllama()
  };

  const candidates = [
    { i: 0, preview: '门店充值异常与日报对账流程说明' },
    { i: 1, preview: '员工排班与休假制度' },
    { i: 2, preview: '原料收货与报损登记要点' }
  ];
  report.rankTest = await rankKnowledgeCandidatesWithLlm({
    store: '验证门店',
    query: '充值 对账',
    candidates,
    limit: 2
  });

  const mpUrl = String(process.env.MEMPALACE_URL || 'http://127.0.0.1:3001').replace(/\/$/, '');
  try {
    const h = await axios.get(`${mpUrl}/health`, { timeout: 5000, validateStatus: () => true });
    report.mempalaceHttp = {
      status: h.status,
      persistence: h.data?.persistence,
      dataDir: h.data?.dataDir,
      ok: h.data?.ok
    };
  } catch (e) {
    report.mempalaceHttp = { ok: false, error: String(e?.message || e) };
  }

  console.log(JSON.stringify(report, null, 2));

  const okWiki = report.wiki?.ok && report.wiki?.persistence === 'disk';
  const okMp = report.mempalace?.reachable === true && report.mempalaceHttp?.status === 200;
  if (report.mempalaceHttp?.persistence !== 'disk') {
    console.error('WARN: MemPalace /health 未声明 persistence=disk（请部署最新 mempalace；当前仍可能为旧进程）');
  }
  const okRank = report.rankTest?.indices?.length > 0 && report.rankTest?.provider !== 'none';
  const okDs = report.deepseekPing?.skip || report.deepseekPing?.ok;
  const okOll = report.ollamaPing?.ok;

  if (!okWiki) console.error('FAIL: wiki 健康或落盘状态异常');
  if (!okMp) console.error('FAIL: MemPalace 不可达或未声明磁盘持久化');
  if (!okRank) console.error('WARN: LLM 排序未返回有效 indices（将回退本地启发式；检查 DEEPSEEK_API_KEY 与 Ollama）');
  if (!okDs && !report.deepseekPing?.skip) console.error('WARN: DeepSeek ping 失败（排序会尝试 Ollama）');
  if (!okOll) console.error('WARN: Ollama ping 失败（DeepSeek 失败时无法回退 Ollama）');

  const exitCode = okWiki && okMp ? 0 : 2;
  process.exit(exitCode);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
