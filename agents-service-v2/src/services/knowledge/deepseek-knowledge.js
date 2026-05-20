/**
 * Wiki / MemPalace 检索排序：优先 Qwen（callLLM 含自动降级链），失败后用 DeepSeek，再失败用 Ollama。
 */
import { callDeepSeek, callOllamaLLM, callLLM } from '../llm-provider.js';
import { logger } from '../../utils/logger.js';

/** 关闭显式 KNOWLEDGE_USE_DEEPSEEK=false 时不走任何 LLM 排序 */
export function useKnowledgeLlmRanking() {
  const off = String(process.env.KNOWLEDGE_USE_DEEPSEEK || '').trim().toLowerCase() === 'false';
  return !off;
}

/** @deprecated 语义同 useKnowledgeLlmRanking（保留兼容） */
export function useDeepseekForKnowledgeRanking() {
  return useKnowledgeLlmRanking();
}

function extractJsonObject(text) {
  const s = String(text || '').trim();
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(s.slice(start, end + 1));
  } catch {
    return null;
  }
}

function normalizeIndices(raw, candidatesLength, limit) {
  const j = extractJsonObject(raw);
  const idx = Array.isArray(j?.indices) ? j.indices.map((x) => parseInt(String(x), 10)).filter((n) => Number.isFinite(n)) : [];
  const uniq = [];
  const seen = new Set();
  for (const i of idx) {
    if (i < 0 || i >= candidatesLength || seen.has(i)) continue;
    seen.add(i);
    uniq.push(i);
    if (uniq.length >= limit) break;
  }
  return uniq;
}

function buildRankMessages(sys, userBody) {
  return [
    { role: 'system', content: sys },
    { role: 'user', content: userBody }
  ];
}

/**
 * @param {{ store: string, query: string, candidates: Array<{ i: number, filename?: string, preview: string }>, limit: number }} p
 * @returns {Promise<{ indices: number[], provider: 'deepseek'|'ollama'|'none' }>}
 */
export async function rankKnowledgeCandidatesWithLlm(p) {
  const { store, query, candidates, limit } = p;
  if (!candidates?.length) return { indices: [], provider: 'none' };
  if (!useKnowledgeLlmRanking()) return { indices: [], provider: 'none' };

  const sys =
    '你是餐饮经营知识库检索排序器。只输出一个 JSON 对象，不要 Markdown。' +
    '格式：{"indices":[整数下标 i 按相关度从高到低]}；indices 最多 ' +
    limit +
    ' 个；都不相关则 {"indices":[]}。';
  const userBody = [
    `门店：${store}`,
    `用户问题：${String(query || '').slice(0, 800)}`,
    '候选（每项有下标 i 与正文摘要 preview）：',
    JSON.stringify(candidates.map((c) => ({ i: c.i, fn: c.filename || '', preview: String(c.preview || '').slice(0, 600) })))
  ].join('\n');

  // 优先 Qwen（callLLM 含 Qwen → DeepSeek 自动降级链）
  try {
    const apiRes = await callLLM(buildRankMessages(sys, userBody), {
      temperature: 0.1,
      max_tokens: 512,
      skipCache: true
    });
    if (apiRes?.ok && apiRes.content) {
      const indices = normalizeIndices(apiRes.content, candidates.length, limit);
      return { indices, provider: 'api' };
    }
  } catch (e) {
    logger.warn({ err: e?.message }, 'knowledge-rank: Qwen/API 失败');
  }

  // 降级：DeepSeek 直连
  const hasDsKey = !!String(process.env.DEEPSEEK_API_KEY || '').trim();
  if (hasDsKey) {
    try {
      const raw = await callDeepSeek(userBody, {
        systemPrompt: sys,
        temperature: 0.1,
        max_tokens: 512,
        timeoutMs: 45000
      });
      const indices = normalizeIndices(raw, candidates.length, limit);
      return { indices, provider: 'deepseek' };
    } catch (e) {
      logger.warn({ err: e?.message }, 'knowledge-rank: DeepSeek 失败，尝试 Ollama');
    }
  }

  try {
    const ores = await callOllamaLLM(buildRankMessages(sys, userBody), {
      purpose: 'knowledge_rank',
      max_tokens: 512,
      temperature: 0.1
    });
    if (ores?.ok && ores.content) {
      const indices = normalizeIndices(ores.content, candidates.length, limit);
      return { indices, provider: 'ollama' };
    }
    logger.warn({ err: ores?.error }, 'knowledge-rank: Ollama 未返回有效内容');
  } catch (e) {
    logger.warn({ err: e?.message }, 'knowledge-rank: Ollama 调用异常');
  }

  return { indices: [], provider: 'none' };
}

/** @deprecated 请用 rankKnowledgeCandidatesWithLlm；返回值仅为 indices 数组以保持旧调用点兼容 */
export async function rankKnowledgeCandidatesWithDeepseek(p) {
  const r = await rankKnowledgeCandidatesWithLlm(p);
  return r.indices;
}
