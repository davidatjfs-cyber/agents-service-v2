/**
 * Embedding 服务 — 为知识库提供向量语义检索能力
 *
 * 设计原则：
 *  - 所有异常 fail-soft：embedding 不可用时自动回退到 keyword 检索
 *  - lazy init：pgvector 不存在时不做任何操作
 *  - 双重缓存：内存缓存最近 embedding + 数据库持久化
 *
 * 用法：
 *   import { generateEmbedding, searchByEmbedding, ensureEmbeddingSchema } from './embedding-service.js';
 *   const vec = await generateEmbedding('用户提问');
 *   // 若 vec 为 null，调用方应回退到 ILIKE
 */
import { logger } from '../utils/logger.js';
import { query } from '../utils/db.js';
import axios from 'axios';

/* ── 配置 ── */
const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL || 'shaw/dmeta-embedding-zh';
const EMBEDDING_DIM = Number(process.env.EMBEDDING_DIM) || 768; // dmeta-embedding-zh -> 768

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
    const ext = await query(`SELECT 1 FROM pg_extension WHERE extname = 'vector' LIMIT 1`);
    if (!(ext.rows || []).length) {
      try {
        await query(`CREATE EXTENSION IF NOT EXISTS vector`);
      } catch (_e) {
        // 非 superuser 无法 CREATE EXTENSION；扩展可能已由管理员创建
        // 跳过，后续检查列是否存在
      }
    }
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

  // dmeta-embedding-zh 是 BERT 模型，max 512 tokens → 约 1000 汉字
  // 超长文本 API 返回 500「input length exceeds context length」
  // dmeta-embedding-zh max 512 tokens → 约 900 汉字；\f 等控制符先剥离再截断
  const MAX_CHARS = 900;
  const clean = t.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
  const truncated = clean.length > MAX_CHARS ? clean.slice(0, MAX_CHARS) : clean;

  // 检查缓存
  const ck = cacheKey(truncated);
  const cached = embedCache.get(ck);
  if (cached) return cached;

  try {
    const ollamaUrl = String(process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434').replace(/\/+$/, '');
    const body = { model: EMBEDDING_MODEL, prompt: truncated };
    const url = `${ollamaUrl}/api/embeddings`;

    let res = null;
    let lastErr = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        res = await axios.post(url, body, {
          headers: { 'Content-Type': 'application/json' },
          timeout: 60000
        });
        if (res.status === 200 && Array.isArray(res.data?.embedding)) break;
        res = null;
      } catch (e) {
        lastErr = e;
        if (attempt === 0) {
          logger.debug({ err: e?.message }, 'embedding-service: attempt 1 failed, retrying');
          await new Promise(r => setTimeout(r, 2000));
        }
      }
    }

    if (res?.status === 200 && Array.isArray(res.data?.embedding)) {
      const vec = res.data.embedding;
      if (!Array.isArray(vec) || vec.length !== EMBEDDING_DIM) {
        logger.warn(
          { dim: Array.isArray(vec) ? vec.length : 0, expected: EMBEDDING_DIM, model: EMBEDDING_MODEL },
          'embedding-service: unexpected embedding dimension; set EMBEDDING_DIM to match API or adjust EMBEDDING_MODEL'
        );
        return null;
      }
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
  if (!apiKey) {
    logger.info('embedding-service: no DEEPSEEK_API_KEY, using Ollama for embeddings');
  }

  let processed = 0;
  let failed = 0;

  try {
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
 * 循环回填所有缺失 embedding，直到全部补完、超时或连续失败过多
 *
 * 与 backfillEmbeddings 的「一批」不同，此函数持续查询 pending 行并逐批处理，
 * 适合启动时/定时任务自动调用。
 *
 * @param {number} [batchSize=20] - 每批取多少行
 * @param {number} [maxRuntimeMs=300000] - 总运行时间上限（默认 5 分钟）
 * @returns {Promise<{processed: number, failed: number, remaining: number, stopped: string}>}
 */
export async function backfillAllMissingEmbeddings(batchSize = 20, maxRuntimeMs = 300000) {
  if (!(await isEmbeddingAvailable())) {
    await ensureEmbeddingSchema();
    if (!(await isEmbeddingAvailable())) {
      return { processed: 0, failed: 0, remaining: -1, stopped: 'pgvector not available' };
    }
  }

  const deadline = Date.now() + maxRuntimeMs;
  let processed = 0;
  let failed = 0;
  let consecutiveFailures = 0;
  const CONSECUTIVE_FAIL_LIMIT = 3;

  try {
    while (Date.now() < deadline) {
      const r = await query(
        `SELECT id, content FROM knowledge_base
         WHERE content IS NOT NULL AND content != '' AND embedding IS NULL
         LIMIT $1`,
        [batchSize]
      );
      const rows = r.rows || [];
      if (!rows.length) {
        logger.info(`embedding-service: backfill complete (${processed} processed, ${failed} failed, 0 remaining)`);
        return { processed, failed, remaining: 0, stopped: 'all_done' };
      }

      let batchOk = 0;
      let batchFail = 0;
      for (const row of rows) {
        if (Date.now() >= deadline) break;
        try {
          const text = String(row.content || '').slice(0, 8000);
          if (!text) { batchFail++; consecutiveFailures++; continue; }
          const vec = await generateEmbedding(text);
          if (vec && vec.length) {
            await query(
              `UPDATE knowledge_base SET embedding = $1::vector WHERE id = $2`,
              [`[${vec.join(',')}]`, row.id]
            );
            batchOk++;
            consecutiveFailures = 0;
          } else {
            batchFail++;
            consecutiveFailures++;
          }
        } catch {
          batchFail++;
          consecutiveFailures++;
        }
        if (consecutiveFailures >= CONSECUTIVE_FAIL_LIMIT) {
          logger.warn(
            { consecutiveFailures, processed: processed + batchOk, failed: failed + batchFail },
            'embedding-service: too many consecutive failures, aborting backfill'
          );
          processed += batchOk;
          failed += batchFail;
          return { processed, failed, remaining: rows.length - batchOk - batchFail, stopped: 'consecutive_failures' };
        }
      }

      processed += batchOk;
      failed += batchFail;

      // 批间短暂延迟，避免持续轮询数据库
      if (Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 200));
      }
    }
  } catch (e) {
    logger.warn({ err: e?.message }, 'embedding-service: backfillAllMissingEmbeddings failed');
  }

  logger.info(
    `embedding-service: backfill paused (${processed} processed, ${failed} failed, time limit reached)`
  );
  return { processed, failed, remaining: -1, stopped: 'time_limit' };
}

/**
 * 为单条知识库条目生成并存储 embedding（管理端 INSERT/UPDATE 钩子）
 * @param {string|number} id - knowledge_base.id
 * @param {string} content - 知识内容
 * @returns {Promise<boolean>} embedding 是否成功写入
 */
export async function ensureKnowledgeEmbedding(id, content) {
  if (!id || !content) return false;
  try {
    const vec = await generateEmbedding(String(content).slice(0, 8000));
    if (vec && vec.length) {
      await query(
        `UPDATE knowledge_base SET embedding = $1::vector WHERE id = $2`,
        [`[${vec.join(',')}]`, id]
      );
      return true;
    }
  } catch (e) {
    logger.warn({ err: e?.message, id }, 'embedding-service: ensureKnowledgeEmbedding failed');
  }
  return false;
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
