/**
 * Unified Knowledge Retriever — 聚合 three sources: RAG/knowledge_base + llmwiki + mempalace
 *
 * 设计原则：
 *  - 所有异常 fail-soft，不传播
 *  - 每个模块独立 try/catch，一个源失败不影响其他
 *  - 结果统一格式化为标准化片段，供 LLM re-ranking 合并排序
 */
import { logger } from '../utils/logger.js';
import { query } from '../utils/db.js';
import { rankKnowledgeCandidatesWithLlm, useKnowledgeLlmRanking } from './knowledge/deepseek-knowledge.js';
import { getBrandForStore } from './config-service.js';

/* ── 缓存 (P3) ── */
const cache = new Map();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 分钟
let cacheHits = 0;
let cacheMisses = 0;

function cacheKey(text, store, agent) {
  return `${String(text || '').slice(0, 100)}::${store || ''}::${agent || ''}`;
}

function cacheGet(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  return entry.value;
}

function cacheSet(key, value) {
  if (cache.size > 200) {
    // 简单 LRU：清理一半旧条目
    const entries = [...cache.entries()].sort((a, b) => a[1].ts - b[1].ts);
    for (let i = 0; i < Math.min(entries.length, 100); i++) {
      cache.delete(entries[i][0]);
    }
  }
  cache.set(key, { value, ts: Date.now() });
}

/** 日志监控指标 */
export function getUnifiedRetrieverStats() {
  return {
    cacheSize: cache.size,
    cacheHits,
    cacheMisses,
    hitRate: cacheHits + cacheMisses > 0
      ? (cacheHits / (cacheHits + cacheMisses) * 100).toFixed(1) + '%'
      : '0%'
  };
}

/** 重置缓存（测试用） */
export function clearUnifiedRetrieverCache() {
  cache.clear();
  cacheHits = 0;
  cacheMisses = 0;
}

/* ── Source 1: RAG / knowledge_base (同 fetchKnowledgeSnippetsForTrainAdvisor 逻辑) ── */

/** ILIKE 关键词扩展（与 agent-handlers.js 中一致） */
function expandSearchPatterns(userText) {
  const t = String(userText || '').trim();
  const out = new Set();
  if (t.length >= 2 && t.length <= 120) out.add(`%${t}%`);
  const isMenu = /菜单|菜谱|餐牌|菜品|价格|菜名|出品|价目|点菜|酒水|主食|小吃/.test(t);
  const isStall = /开档|开市|备餐|炒锅|烧腊|档口|水吧|砧板|岗位|工作|清单|检查|闭市|收档/.test(t);
  if (isMenu) {
    ['%菜单%', '%菜谱%', '%菜品%', '%价格%', '%餐牌%', '%价目%', '%价目表%', '%点菜%', '%酒水单%'].forEach((x) => out.add(x));
  }
  if (isStall) {
    ['%炒锅%', '%开档%', '%档口%', '%备餐%', '%开市%', '%岗位%', '%开档工作%', '%备餐检查%', '%开市前%'].forEach((x) => out.add(x));
  }
  if (out.size === 0) out.add(`%${t.slice(0, 60) || '培训'}%`);
  return [...out].slice(0, 14);
}

function buildTrgmNeedle(userText) {
  const t = String(userText || '').trim().slice(0, 200);
  const parts = [t];
  if (/菜单|菜谱|餐牌|菜品|价格|菜名|出品|价目|点菜|酒水|主食|小吃/.test(t)) {
    parts.push('菜单 菜谱 价格 菜品');
  }
  if (/开档|开市|备餐|炒锅|烧腊|档口|水吧|砧板|岗位|工作|清单|检查|闭市|收档/.test(t)) {
    parts.push('开档 炒锅 档口 备餐 岗位 开市');
  }
  return parts.join(' ').trim().slice(0, 400);
}

async function isTrgmAvailable() {
  try {
    const r = await query(`SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm' LIMIT 1`);
    return (r.rows || []).length > 0;
  } catch {
    return false;
  }
}

function filterRowsByBrandStore(rows, brand, store) {
  const b = String(brand || '').trim();
  const st = String(store || '').trim().replace(/店$/, '');
  if (!b && !st) return rows;
  const filtered = rows.filter((row) => {
    const tagStr = Array.isArray(row.tags) ? row.tags.join(' ') : String(row.tags || '');
    if (/brand:all/i.test(tagStr)) return true;
    const blob = `${row.title || ''}\n${row.content || ''}\n${tagStr}`;
    if (b && (blob.includes(b) || blob.includes(b.slice(0, 2)))) return true;
    if (st && st.length >= 2 && blob.includes(st)) return true;
    return false;
  });
  return filtered.length ? filtered : rows;
}

/** 范围：给指定 role 允许的 scope */
function getAllowedKbScopes(agentName, userRole) {
  // train_advisor 无 sensitive（与 V1 getAllowedScopes 对齐）
  const agentScopes = ['public', 'business'];
  const ROLE_SCOPE = {
    admin: ['public', 'business', 'sensitive'],
    hq_manager: ['public', 'business', 'sensitive'],
    hr_manager: ['public', 'business', 'sensitive'],
    store_manager: ['public', 'business'],
    store_production_manager: ['public', 'business'],
    front_manager: ['public', 'business'],
    employee: ['public'],
    store_staff: ['public']
  };
  const r = ROLE_SCOPE[String(userRole || '').trim().toLowerCase()] || ['public'];
  const x = agentScopes.filter((s) => r.includes(s));
  return x.length ? x : ['public'];
}

/**
 * 从 knowledge_base 检索（同原 fetchKnowledgeSnippetsForTrainAdvisor 逻辑）
 * @param {string} text - 用户问题
 * @param {{ store?: string, brand?: string, role?: string, agent?: string }} ctx
 * @returns {Promise<Array<{source:string, title:string, body:string, id:string}>>}
 */
async function retrieveFromRag(text, ctx) {
  if (!text) return [];
  try {
    const scopes = getAllowedKbScopes(ctx.agent, ctx.role);
    const patterns = expandSearchPatterns(text);
    const needle = buildTrgmNeedle(text);
    const orClauses = patterns.map((_, i) => `(title ILIKE $${i + 2} OR content ILIKE $${i + 2})`).join(' OR ');
    const useTrgm = (await isTrgmAvailable()) && needle.length >= 2;
    const needleIdx = 2 + patterns.length;
    let rows = [];

    if (useTrgm) {
      const r = await query(
        `SELECT id::text AS id, title, content, tags,
          GREATEST(
            COALESCE(word_similarity($${needleIdx}::text, title), 0::real),
            COALESCE(word_similarity($${needleIdx}::text, COALESCE(content, '')), 0::real)
          ) AS kb_trgm
         FROM knowledge_base
         WHERE (scope = ANY($1::text[]) OR scope IS NULL)
         AND (enabled IS NULL OR enabled = true)
         AND (
           (${orClauses})
           OR (
             char_length(trim($${needleIdx}::text)) >= 2
             AND (
               word_similarity($${needleIdx}::text, title) > 0.17
               OR word_similarity($${needleIdx}::text, COALESCE(content, '')) > 0.17
             )
           )
         )
         ORDER BY kb_trgm DESC NULLS LAST, updated_at DESC NULLS LAST, created_at DESC NULLS LAST
         LIMIT 40`,
        [scopes, ...patterns, needle]
      );
      rows = (r.rows || []).slice(0, 30);
    } else {
      // ILIKE 模式：按标题匹配优先排序
      const r = await query(
        `SELECT id::text AS id, title, content, tags
         FROM knowledge_base
         WHERE (scope = ANY($1::text[]) OR scope IS NULL)
         AND (enabled IS NULL OR enabled = true)
         AND (${orClauses})
         ORDER BY
           CASE
             WHEN title ILIKE $${patterns.length + 2} THEN 1
             WHEN content ILIKE $${patterns.length + 2} THEN 2
             ELSE 3
           END,
           updated_at DESC NULLS LAST
         LIMIT 40`,
        [scopes, ...patterns, patterns[0] || `%%`]
      );
      rows = (r.rows || []).slice(0, 30);
    }

    if (!rows.length) {
      // fallback：去掉 scope 限制
      const r2 = await query(
        `SELECT id::text AS id, title, content, tags
         FROM knowledge_base
         WHERE (enabled IS NULL OR enabled = true)
         AND (${orClauses})
         ORDER BY created_at DESC NULLS LAST
         LIMIT 20`,
        patterns
      );
      rows = (r2.rows || []).slice(0, 20);
    }

    const brand = ctx.brand || (ctx.store ? await getBrandForStore(ctx.store).catch(() => null) : null);
    if (brand || ctx.store) {
      rows = filterRowsByBrandStore(rows, brand, ctx.store);
    }

    const parts = [];
    let used = 0;
    const maxTotal = 72000;
    const maxPerDoc = 22000;
    for (const row of rows.slice(0, 12)) {
      if (used >= maxTotal) break;
      const raw = String(row.content || '');
      const take = raw.slice(0, Math.min(maxPerDoc, maxTotal - used));
      used += take.length;
      parts.push({ source: 'knowledge_base', title: String(row.title || '未命名文档'), body: take, id: row.id });
    }
    return parts;
  } catch (e) {
    logger.warn({ err: e?.message }, 'unified-retriever RAG failed');
    return [];
  }
}

/* ── Source 2: 向量语义搜索 (P1) ── */
let vectorExtensionAvailable = null;

async function isVectorAvailable() {
  if (vectorExtensionAvailable !== null) return vectorExtensionAvailable;
  try {
    const r = await query(`SELECT 1 FROM pg_extension WHERE extname = 'vector' LIMIT 1`);
    vectorExtensionAvailable = (r.rows || []).length > 0;
  } catch {
    vectorExtensionAvailable = false;
  }
  return vectorExtensionAvailable;
}

/**
 * 从 knowledge_base 做向量语义检索
 * 需要 pgvector extension + embedding 列有数据
 */
async function retrieveFromVector(text, ctx) {
  if (!text || !(await isVectorAvailable())) return [];
  try {
    const { generateEmbedding } = await import('./embedding-service.js');
    const vec = await generateEmbedding(text);
    if (!vec || !vec.length) return [];

    const scopes = getAllowedKbScopes(ctx.agent, ctx.role);
    const r = await query(
      `SELECT id::text AS id, title, content, 1 - (embedding <=> $1::vector) AS similarity
       FROM knowledge_base
       WHERE embedding IS NOT NULL
       AND (scope = ANY($2::text[]) OR scope IS NULL)
       AND (enabled IS NULL OR enabled = true)
       ORDER BY similarity DESC
       LIMIT 15`,
      [`[${vec.join(',')}]`, scopes]
    );

    const brand = ctx.brand || (ctx.store ? await getBrandForStore(ctx.store).catch(() => null) : null);
    let rows = r.rows || [];
    if (brand || ctx.store) {
      rows = filterRowsByBrandStore(rows, brand, ctx.store);
    }

    return rows.slice(0, 8).map(row => ({
      source: 'vector',
      title: String(row.title || '未命名文档'),
      body: String(row.content || '').slice(0, 22000),
      id: row.id,
      similarity: row.similarity
    }));
  } catch (e) {
    logger.warn({ err: e?.message }, 'unified-retriever vector failed');
    return [];
  }
}

/* ── Source 3: llmwiki ── */
async function retrieveFromWiki(text, store) {
  if (!text || !store) return [];
  try {
    const { retrieveWikiKnowledge } = await import('./knowledge/wiki-retriever.js');
    const wiki = await retrieveWikiKnowledge({ store, query: text, limit: 5 });
    return (wiki || []).map(w => ({
      source: 'wiki',
      title: w.summary || '',
      body: w.strategy || '',
      id: ''
    }));
  } catch (e) {
    logger.warn({ err: e?.message }, 'unified-retriever wiki failed');
    return [];
  }
}

/* ── Source 4: mempalace ── */
async function retrieveFromMempalace(text, store, agent) {
  if (!text || !store) return [];
  try {
    const { recallMemory } = await import('./memory-adapter.js');
    const mem = await recallMemory({ agent, store, query: text, limit: 8 });
    return (mem || []).map(m => ({
      source: 'mempalace',
      title: '',
      body: m.content || '',
      id: '',
      score: m.score
    }));
  } catch (e) {
    logger.warn({ err: e?.message }, 'unified-retriever mempalace failed');
    return [];
  }
}

/* ── 统一入口 ── */

/**
 * 从所有知识源检索并合并排序
 *
 * @param {string} text - 用户提问
 * @param {object} options
 * @param {string} options.store - 门店
 * @param {string} options.agent - agent 名称 (如 'data_auditor')
 * @param {string} [options.role] - 用户角色
 * @param {string} [options.brand] - 品牌
 * @param {number} [options.limit=6] - 最大返回条数
 * @param {boolean} [options.useCache=true] - 是否使用缓存
 * @param {boolean} [options.includeRag=true] - 是否查 RAG
 * @param {boolean} [options.includeVector=true] - 是否查向量
 * @param {boolean} [options.includeWiki=true] - 是否查 wiki
 * @param {boolean} [options.includeMempalace=true] - 是否查 mempalace
 * @returns {Promise<{parts: Array<{source:string, title:string, body:string, id:string}>, stats: {rag: number, wiki: number, mempalace: number, vector: number, total: number}}>}
 */
export async function unifiedRetrieve(text, options = {}) {
  const {
    store = '',
    agent = '',
    role = '',
    brand = '',
    limit = 6,
    useCache = true
  } = options;

  if (!text) return { parts: [], stats: { rag: 0, wiki: 0, mempalace: 0, vector: 0, total: 0 } };

  const ck = useCache ? cacheKey(text, store, agent) : '';
  if (ck) {
    const cached = cacheGet(ck);
    if (cached) {
      cacheHits++;
      return cached;
    }
  }
  cacheMisses++;

  const ctx = { store, agent, role, brand };
  const ragPromise = retrieveFromRag(text, ctx);
  const vectorPromise = retrieveFromVector(text, ctx);
  const wikiPromise = retrieveFromWiki(text, store);
  const memPromise = retrieveFromMempalace(text, store, agent);

  const [ragParts, vecParts, wikiParts, memParts] = await Promise.all([
    ragPromise, vectorPromise, wikiPromise, memPromise
  ]);

  // 合并所有候选人
  const allParts = [...ragParts, ...vecParts, ...wikiParts, ...memParts];

  // LLM re-ranking（候选 > 3 条时）
  let finalParts = allParts;
  if (allParts.length > 3 && useKnowledgeLlmRanking()) {
    try {
      const candidates = allParts.map((p, i) => ({
        i,
        preview: `[${p.source}] ${p.title ? p.title + ': ' : ''}${p.body.slice(0, 500)}`
      }));
      const { indices } = await rankKnowledgeCandidatesWithLlm({
        store,
        query: text,
        candidates,
        limit: Math.min(limit + 3, allParts.length)
      });
      if (indices.length) {
        finalParts = indices.map(i => allParts[i]).filter(Boolean);
      }
    } catch (e) {
      // fallback: 保持原序
    }
  }

  // 去重 (按 body 前 100 字)
  const seen = new Set();
  const deduped = [];
  for (const p of finalParts) {
    const key = p.body.slice(0, 100);
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(p);
    if (deduped.length >= limit) break;
  }

  // 格式化输出文本
  const result = {
    parts: deduped.map(p => ({
      source: p.source,
      title: String(p.title || p.source).slice(0, 200),
      body: String(p.body || '').slice(0, 22000),
      id: p.id || ''
    })),
    stats: {
      rag: ragParts.length,
      wiki: wikiParts.length,
      mempalace: memParts.length,
      vector: vecParts.length,
      total: deduped.length
    }
  };

  if (ck) cacheSet(ck, result);
  return result;
}

/**
 * 格式化为 sysPrompt 可用的文本块
 */
export function formatUnifiedRetrievalForPrompt(result) {
  if (!result || !result.parts || !result.parts.length) {
    return `\n【知识库检索结果】\n（未命中相关内容）\n`;
  }

  const lines = result.parts.map((p, i) => {
    const sourceLabel =
      p.source === 'knowledge_base' ? '📄 知识库文档' :
      p.source === 'vector' ? '🔍 语义匹配' :
      p.source === 'wiki' ? '📝 历史经验' :
      p.source === 'mempalace' ? '🧠 记忆策略' : '📋 其他';
    return `<<< ${sourceLabel}：${p.title}（id:${p.id || p.source}）>>>\n${p.body}`;
  });

  const stats = result.stats || {};
  return `\n【系统检索到的知识库与历史经验（来源统计：知识库 ${stats.rag} | 语义 ${stats.vector} | 历史经验 ${stats.wiki} | 记忆策略 ${stats.mempalace}，共 ${stats.total} 条）】\n
${lines.join('\n\n---\n\n')}
`;
}
