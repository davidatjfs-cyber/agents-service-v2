/**
 * Embedding 服务 — 为知识库提供向量语义检索能力
 *
 * 设计原则：
 *  - 所有异常 fail-soft：embedding 不可用时自动回退到 keyword 检索
 *  - lazy init：pgvector 不存在时不做任何操作
 *  - 双重缓存：内存缓存最近 embedding + 数据库持久化
 *
 * 用法：
 *   import { generateEmbedding, getEmbeddingOrFallback } from './embedding-service.js';
 *   const vec = await generateEmbedding('用户提问');
 *   // 若 vec 为 null，调用方应回退到 ILIKE
 */
import { logger } from '../utils/logger.js';
import { query } from '../utils/db.js';
import axios from 'axios';

/* ── 配置 ── */
const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL || 'deepseek-chat';
const EMBEDDING_DIM = 1536; // OpenAI-compatible dimension

/* ── embedding 缓存 ── */
const embedCache = new Map();
const EMBED_CACHE_MAX = 500;

function cacheKey(text) {
  return String(text || '').trim().slice(0, 200);
}

/**
 * 是否可用（pgvector extension 已安装且在 knowledge_base 上生效）
 */
let _pgvectorReady = null;

export async function isEmbeddingAvailable() {
  if (_pgvectorReady !== null) return _pgvectorReady;
  try {
    const ext = await query(`SELECT 1 FROM pg_extension WHERE extname = 'vector' LIMIT 1`);
    if (!(ext.rows || []).length) {
      _pgvectorReady = false;
      return false;
    }
    const col = await query(`
      SELECT 1 FROM information_schema.columns
      WHERE table_name = 'knowledge_base' AND column_name = 'embedding'
      LIMIT 1
    `);
    _pgvectorReady = (col.rows || []).length > 0;
  } catch {
    _pgvectorReady = false;
  }
  return _pgvectorReady;
}

/**
 * 创建 pgvector extension + embedding 列（幂等，可重复执行）
 */
export async function ensureEmbeddingSchema() {
  try {
    await query(`CREATE EXTENSION IF NOT EXISTS vector`);
    const col = await query(`
      SELECT 1 FROM information_schema.columns
      WHERE table_name = 'knowledge_base' AND column_name = 'embedding'
      LIMIT 1
    `);
    if (!(col.rows || []).length) {
      await query(`ALTER TABLE knowledge_base ADD COLUMN embedding vector(${EMBEDDING_DIM})`);
      logger.info('embedding-service: added embedding column to knowledge_base');
    }
    _pgvectorReady = true;
    return true;
  } catch (e) {
    logger.warn({ err: e?.message }, 'embedding-service: ensureEmbeddingSchema failed (pgvector may not be installed)');
    _pgvectorReady = false;
    return false;
  }
}

/**
 * 单个文本生成 embedding
 * @param {string} text
 * @returns {Promise<number[]|null>} embedding 向量，失败返回 null
 */
export async function generateEmbedding(text) {
  const t = String(text || '').trim();
  if (!t) return null;

  // 检查缓存
  const ck = cacheKey(t);
  const cached = embedCache.get(ck);
  if (cached) return cached;

  try {
    const apiKey = String(process.env.DEEPSEEK_API_KEY || '').trim();
    if (!apiKey) return null;

    const body = {
      model: EMBEDDING_MODEL,
      input: t,
      encoding_format: 'float'
    };
    const url = String(process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com').replace(/\/+$/, '') + '/v1/embeddings';

    const res = await axios.post(url, body, {
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      timeout: 30000
    });

    if (res.status === 200 && res.data?.data?.[0]?.embedding) {
      const vec = res.data.data[0].embedding;
      // 缓存
      if (embedCache.size >= EMBED_CACHE_MAX) {
        const firstKey = embedCache.keys().next().value;
        if (firstKey) embedCache.delete(firstKey);
      }
      embedCache.set(ck, vec);
      return vec;
    }
    return null;
  } catch (e) {
    // 静默 fallback
    if (String(e?.response?.status) !== '429') { // 非限流才记日志
      logger.debug({ err: e?.message }, 'embedding-service: generateEmbedding failed');
    }
    return null;
  }
}

/**
 * 知识库条目批量生成 embedding（用于初始化/补充已有条目）
 * 扫描 content 不为空且 embedding IS NULL 的条目，逐一生成
 *
 * @param {number} [batchSize=5] - 每批处理数
 * @returns {Promise<{processed: number, failed: number}>}
 */
export async function backfillEmbeddings(batchSize = 5) {
  if (!(await isEmbeddingAvailable())) {
    await ensureEmbeddingSchema();
    if (!(await isEmbeddingAvailable())) {
      return { processed: 0, failed: 0, reason: 'pgvector not available' };
    }
  }
  const apiKey = String(process.env.DEEPSEEK_API_KEY || '').trim();
  if (!apiKey) return { processed: 0, failed: 0, reason: 'no DEEPSEEK_API_KEY' };

  let processed = 0;
  let failed = 0;

  try {
    // 每次取一批待处理条目
    const r = await query(
      `SELECT id, content FROM knowledge_base
       WHERE content IS NOT NULL AND content != '' AND embedding IS NULL
       LIMIT $1`,
      [batchSize]
    );

    const rows = r.rows || [];
    for (const row of rows) {
      try {
        const text = String(row.content || '').slice(0, 8000);
        if (!text) continue;
        const vec = await generateEmbedding(text);
        if (vec && vec.length) {
          await query(
            `UPDATE knowledge_base SET embedding = $1::vector WHERE id = $2`,
            [`[${vec.join(',')}]`, row.id]
          );
          processed++;
        } else {
          failed++;
        }
      } catch {
        failed++;
      }
    }
  } catch (e) {
    logger.warn({ err: e?.message }, 'embedding-service: backfillEmbeddings failed');
  }

  return { processed, failed };
}

/**
 * 根据 embedding 相似度检索知识库（语义搜索）
 * @param {string} text - 用户提问
 * @param {string[]} scopes - 允许的 scope
 * @param {number} [limit=10]
 * @returns {Promise<{rows: Array, vectorAvailable: boolean}>}
 */
export async function searchByEmbedding(text, scopes = ['public', 'business'], limit = 10) {
  if (!(await isEmbeddingAvailable())) {
    return { rows: [], vectorAvailable: false };
  }

  const vec = await generateEmbedding(text);
  if (!vec || !vec.length) {
    return { rows: [], vectorAvailable: true };
  }

  try {
    const r = await query(
      `SELECT id::text AS id, title, content,
              1 - (embedding <=> $1::vector) AS similarity
       FROM knowledge_base
       WHERE embedding IS NOT NULL
       AND (enabled IS NULL OR enabled = true)
       AND (scope = ANY($2::text[]) OR scope IS NULL)
       ORDER BY similarity DESC
       LIMIT $3`,
      [`[${vec.join(',')}]`, scopes, limit]
    );
    return { rows: r.rows || [], vectorAvailable: true };
  } catch (e) {
    logger.warn({ err: e?.message }, 'embedding-service: searchByEmbedding failed');
    return { rows: [], vectorAvailable: true };
  }
}

/**
 * 重置缓存（测试用）
 */
export function clearEmbeddingCache() {
  embedCache.clear();
}
