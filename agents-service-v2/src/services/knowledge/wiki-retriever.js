import fs from 'fs';
import path from 'path';
import { getWikiDataDir } from './knowledge-paths.js';
import { rankKnowledgeCandidatesWithLlm, useKnowledgeLlmRanking } from './deepseek-knowledge.js';

/**
 * 从 Wiki 目录检索片段（默认 DeepSeek 重排序；无 Key 时回退字符重合打分）
 */
/** 运维/健康检查 */
export function probeWikiKnowledgeHealth() {
  const dir = getWikiDataDir();
  try {
    if (!fs.existsSync(dir)) {
      return { dirExists: false, mdCount: 0, ok: false, dir, persistence: 'disk' };
    }
    const files = fs.readdirSync(dir);
    const md = files.filter((f) => f.endsWith('.md')).sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));
    return {
      dirExists: true,
      mdCount: md.length,
      mdFiles: md.slice(0, 40),
      ok: true,
      dir,
      persistence: 'disk',
      knowledgeLlmRanking: useKnowledgeLlmRanking(),
      /** 兼容旧前端字段名 */
      deepseekRank: useKnowledgeLlmRanking(),
      deepseekConfigured: !!String(process.env.DEEPSEEK_API_KEY || '').trim()
    };
  } catch (e) {
    return { dirExists: false, mdCount: 0, ok: false, dir, error: String(e?.message || e), persistence: 'disk' };
  }
}

function localCharScore(content, q) {
  let score = 0;
  String(q || '')
    .split('')
    .forEach((k) => {
      if (k.trim() && content.includes(k)) score++;
    });
  return score;
}

export async function retrieveWikiKnowledge({ store, query, limit = 3 }) {
  const dir = getWikiDataDir();
  if (!fs.existsSync(dir)) return [];

  const storeKey = String(store || '').trim();
  if (!storeKey) return [];

  const q = String(query || '');
  const files = fs.readdirSync(dir);
  const filesMatching = files.filter((f) => f.endsWith('.md') && f.includes(storeKey));
  if (!filesMatching.length) return [];

  const excerpts = filesMatching.map((f, idx) => {
    const full = fs.readFileSync(path.join(dir, f), 'utf-8').slice(0, 65000);
    return {
      i: idx,
      filename: f,
      full,
      preview: full.slice(0, 1500),
      localScore: localCharScore(full, q)
    };
  });

  let order = [...excerpts]
    .sort((a, b) => b.localScore - a.localScore)
    .map((e) => e.i);
  if (useKnowledgeLlmRanking() && q.trim()) {
    const { indices } = await rankKnowledgeCandidatesWithLlm({
      store: storeKey,
      query: q,
      candidates: excerpts.map((e) => ({ i: e.i, filename: e.filename, preview: e.preview })),
      limit: Math.min(12, excerpts.length)
    });
    if (indices.length) order = indices;
  }

  const uniq = [];
  const seen = new Set();
  for (const idx of order) {
    const ex = excerpts.find((e) => e.i === idx);
    if (!ex || seen.has(ex.filename)) continue;
    seen.add(ex.filename);
    uniq.push(ex);
    if (uniq.length >= limit) break;
  }

  return uniq.map((r) => ({
    summary: r.full.slice(0, 100),
    strategy: r.full.slice(100, 200)
  }));
}
