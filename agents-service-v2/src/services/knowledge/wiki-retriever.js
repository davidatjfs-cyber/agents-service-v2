import fs from 'fs';
import path from 'path';

/**
 * 从 knowledge/wiki 目录按门店名粗匹配 + 简单字符重合打分检索片段
 */
export async function retrieveWikiKnowledge({ store, query, limit = 3 }) {
  const dir = path.join(process.cwd(), 'knowledge', 'wiki');
  if (!fs.existsSync(dir)) return [];

  const storeKey = String(store || '').trim();
  if (!storeKey) return [];

  const q = String(query || '');
  const files = fs.readdirSync(dir);

  const results = files
    .filter((f) => f.endsWith('.md') && f.includes(storeKey))
    .map((f) => {
      const content = fs.readFileSync(path.join(dir, f), 'utf-8');
      let score = 0;
      q.split('').forEach((k) => {
        if (k.trim() && content.includes(k)) score++;
      });
      return { content, score };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  return results.map((r) => ({
    summary: r.content.slice(0, 100),
    strategy: r.content.slice(100, 200)
  }));
}
