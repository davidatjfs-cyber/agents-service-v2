/**
 * Wiki / MemPalace 检索：用 DeepSeek 重排序与截断（无 API Key 时由调用方回退本地逻辑）
 */
import { callDeepSeek } from '../llm-provider.js';
import { logger } from '../../utils/logger.js';

export function useDeepseekForKnowledgeRanking() {
  const key = String(process.env.DEEPSEEK_API_KEY || '').trim();
  const off = String(process.env.KNOWLEDGE_USE_DEEPSEEK || '').trim().toLowerCase() === 'false';
  return !!key && !off;
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

/**
 * @param {{ store: string, query: string, candidates: Array<{ i: number, filename?: string, preview: string }>, limit: number }} p
 * @returns {Promise<number[]>} 按相关度排序后的下标（最多 limit 个）
 */
export async function rankKnowledgeCandidatesWithDeepseek(p) {
  const { store, query, candidates, limit } = p;
  if (!candidates?.length) return [];
  const sys =
    '你是餐饮经营知识库检索排序器。只输出一个 JSON 对象，不要 Markdown。' +
    '格式：{"indices":[整数下标按相关度从高到低],"scores":[[下标,0到1的分数]]}；indices 最多 ' +
    limit +
    ' 个，只保留与当前用户问题相关的条目；都不相关则 {"indices":[]}。';
  const user = [
    `门店：${store}`,
    `用户问题：${String(query || '').slice(0, 800)}`,
    '候选（每项有下标 i 与正文摘要 preview）：',
    JSON.stringify(candidates.map((c) => ({ i: c.i, fn: c.filename || '', preview: String(c.preview || '').slice(0, 600) })))
  ].join('\n');
  try {
    const raw = await callDeepSeek(user, {
      systemPrompt: sys,
      temperature: 0.1,
      max_tokens: 512,
      timeoutMs: 45000
    });
    const j = extractJsonObject(raw);
    const idx = Array.isArray(j?.indices) ? j.indices.map((x) => parseInt(String(x), 10)).filter((n) => Number.isFinite(n)) : [];
    const uniq = [];
    const seen = new Set();
    for (const i of idx) {
      if (i < 0 || i >= candidates.length || seen.has(i)) continue;
      seen.add(i);
      uniq.push(i);
      if (uniq.length >= limit) break;
    }
    return uniq;
  } catch (e) {
    logger.warn({ err: e?.message }, 'deepseek-knowledge: rank failed');
    return [];
  }
}
