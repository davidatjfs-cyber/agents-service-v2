import { query } from '../utils/db.js';
import { logger } from '../utils/logger.js';

export async function ensureKnowledgeTable() {
  try {
    await query(`CREATE TABLE IF NOT EXISTS knowledge_base (
      id SERIAL PRIMARY KEY, title TEXT NOT NULL, content TEXT NOT NULL,
      category VARCHAR(100) DEFAULT 'general', tags TEXT[],
      created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW()
    )`);
    await query(`CREATE INDEX IF NOT EXISTS idx_kb_fts ON knowledge_base USING gin(to_tsvector('simple', title || ' ' || content))`);
    // 与 HRMS 共用库时：上传 PDF 写入 scope / enabled；agents 侧检索需这些列存在
    await query(`ALTER TABLE knowledge_base ADD COLUMN IF NOT EXISTS enabled BOOLEAN DEFAULT true`);
    await query(`ALTER TABLE knowledge_base ADD COLUMN IF NOT EXISTS scope VARCHAR(20) DEFAULT 'public'`);
    await query(`UPDATE knowledge_base SET enabled = true WHERE enabled IS NULL`);
    await query(`UPDATE knowledge_base SET scope = 'public' WHERE scope IS NULL OR scope = ''`);
  } catch(e) { logger.warn({err:e?.message},'kb table skip'); }
}

export async function searchKnowledge(q, limit=5) {
  try {
    const r = await query(
      `SELECT id,title,content,category FROM knowledge_base
       WHERE to_tsvector('simple',title||' '||content) @@ plainto_tsquery('simple',$1)
       ORDER BY ts_rank(to_tsvector('simple',title||' '||content),plainto_tsquery('simple',$1)) DESC LIMIT $2`,
      [q, limit]);
    return r.rows || [];
  } catch(e) { return []; }
}

export async function addKnowledge(title, content, category, tags) {
  const r = await query(
    'INSERT INTO knowledge_base(title,content,category,tags) VALUES($1,$2,$3,$4) RETURNING id',
    [title, content, category||'general', tags||[]]);
  return r.rows[0];
}

export async function listKnowledge(category, limit=50) {
  let sql = 'SELECT id,title,category,created_at FROM knowledge_base';
  const p = [];
  if (category) { p.push(category); sql += ' WHERE category=$1'; }
  sql += ' ORDER BY created_at DESC LIMIT ' + parseInt(limit);
  const r = await query(sql, p);
  return r.rows || [];
}
