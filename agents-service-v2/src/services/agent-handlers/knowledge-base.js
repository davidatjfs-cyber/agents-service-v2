import { logger } from '../../utils/logger.js';
import { query } from '../../utils/db.js';
import { getBrandForStore } from '../config-service.js';

/** 与 hr-management-system/server/rag-tool.js getAllowedScopes 对齐（train_advisor 无 sensitive） */
function getKbScopesForTrainAdvisor(userRole) {
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

/** 生成 ILIKE 关键词：用户只说「菜单内容」时 PDF 往往不含该四字，需拆成「菜单/菜谱/价格」等 */
function expandKbSearchPatterns(userText) {
  const t = String(userText || '').trim();
  const out = new Set();
  if (t.length >= 2 && t.length <= 120) out.add(`%${t}%`);
  const isMenu = /菜单|菜谱|餐牌|菜品|价格|菜名|出品|价目|点菜|酒水|主食|小吃/.test(t);
  const isStall = /开档|开市|备餐|炒锅|烧腊|档口|水吧|砧板|岗位|工作|清单|检查|闭市|收档/.test(t);
  const isMember = /会员|会员卡|积分|储值|充值|等级|权益|忠诚|复购|留存|拉新/.test(t);
  if (isMenu) {
    ['%菜单%', '%菜谱%', '%菜品%', '%价格%', '%餐牌%', '%价目%', '%价目表%', '%点菜%', '%酒水单%'].forEach((x) => out.add(x));
  }
  if (isStall) {
    ['%炒锅%', '%开档%', '%档口%', '%备餐%', '%开市%', '%岗位%', '%开档工作%', '%备餐检查%', '%开市前%'].forEach((x) => out.add(x));
  }
  if (isMember) {
    ['%会员%', '%会员卡%', '%积分%', '%储值%', '%充值%', '%会员等级%', '%会员权益%', '%忠诚度%', '%复购%', '%留存%'].forEach((x) => out.add(x));
  }
  if (out.size === 0) out.add(`%${t.slice(0, 60) || '培训'}%`);
  return [...out].slice(0, 14);
}

/** B1: 供 pg_trgm word_similarity 使用的复合检索串（中文词 + 用户原句） */
function buildKbTrgmNeedle(userText) {
  const t = String(userText || '').trim().slice(0, 200);
  const parts = [t];
  if (/菜单|菜谱|餐牌|菜品|价格|菜名|出品|价目|点菜|酒水|主食|小吃/.test(t)) {
    parts.push('菜单 菜谱 价格 菜品');
  }
  if (/开档|开市|备餐|炒锅|烧腊|档口|水吧|砧板|岗位|工作|清单|检查|闭市|收档/.test(t)) {
    parts.push('开档 炒锅 档口 备餐 岗位 开市');
  }
  if (/会员|会员卡|积分|储值|充值|等级|权益|忠诚|复购|留存|拉新/.test(t)) {
    parts.push('会员 会员卡 积分 储值 充值 复购 留存 拉新');
  }
  return parts.join(' ').trim().slice(0, 400);
}

let kbTrgmProbeCache = null;
/** 数据库是否已启用 pg_trgm（与 migrations/011 一致） */
async function isKbTrgmAvailable() {
  if (kbTrgmProbeCache !== null) return kbTrgmProbeCache;
  try {
    const r = await query(`SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm' LIMIT 1`);
    kbTrgmProbeCache = (r.rows || []).length > 0;
  } catch {
    kbTrgmProbeCache = false;
  }
  return kbTrgmProbeCache;
}

/** 门店所属品牌优先：标题/正文含品牌名，或 tags 含 brand:all */
function filterKbRowsByBrandStore(rows, brand, store) {
  const b = String(brand || '').trim();
  const st = String(store || '').trim().replace(/店$/, '');
  if (!b && !st) return rows;
  const filtered = rows.filter((row) => {
    const tags = row.tags;
    const tagStr = Array.isArray(tags) ? tags.join(' ') : String(tags || '');
    if (/brand:all/i.test(tagStr)) return true;
    const blob = `${row.title || ''}\n${row.content || ''}\n${tagStr}`;
    if (b && (blob.includes(b) || blob.includes(b.slice(0, 2)))) return true;
    if (st && st.length >= 2 && blob.includes(st)) return true;
    return false;
  });
  return filtered.length ? filtered : rows;
}

/**
 * 从 knowledge_base 拉取 HRMS 上传 PDF 提取文本。
 * B1: ILIKE 多关键词 OR + pg_trgm word_similarity 混合（需 DB 已执行 011 迁移）
 */
async function fetchKnowledgeSnippetsForTrainAdvisor(text, ctx) {
  const scopes = getKbScopesForTrainAdvisor(ctx.role);
  const patterns = expandKbSearchPatterns(text);
  const needle = buildKbTrgmNeedle(text);
  const orClauses = patterns.map((_, i) => `(title ILIKE $${i + 2} OR content ILIKE $${i + 2})`).join(' OR ');
  const useTrgm = (await isKbTrgmAvailable()) && needle.length >= 2;
  const needleIdx = 2 + patterns.length;
  let rows = [];
  try {
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
      rows = r.rows || [];
    } else {
      const r = await query(
        `SELECT id::text AS id, title, content, tags
         FROM knowledge_base
         WHERE (scope = ANY($1::text[]) OR scope IS NULL)
         AND (enabled IS NULL OR enabled = true)
         AND (${orClauses})
         ORDER BY updated_at DESC NULLS LAST, created_at DESC NULLS LAST
         LIMIT 40`,
        [scopes, ...patterns]
      );
      rows = r.rows || [];
    }
  } catch (e) {
    logger.warn({ err: e?.message, useTrgm }, 'fetchKnowledgeSnippetsForTrainAdvisor primary failed');
  }
  if (!rows.length) {
    try {
      const orClauses2 = patterns.map((_, i) => `(title ILIKE $${i + 1} OR content ILIKE $${i + 1})`).join(' OR ');
      const r2 = await query(
        `SELECT id::text AS id, title, content, tags
         FROM knowledge_base
         WHERE (enabled IS NULL OR enabled = true)
         AND (${orClauses2})
         ORDER BY created_at DESC NULLS LAST
         LIMIT 40`,
        patterns
      );
      rows = r2.rows || [];
    } catch (e2) {
      logger.warn({ err: e2?.message }, 'fetchKnowledgeSnippetsForTrainAdvisor fallback failed');
    }
  }
  const brand = await getBrandForStore(String(ctx.store || '').trim()).catch(() => null);
  rows = filterKbRowsByBrandStore(rows, brand, ctx.store);
  const maxTotalChars = 72000;
  let used = 0;
  const parts = [];
  const maxPerDoc = 22000;
  for (const row of rows.slice(0, 12)) {
    if (used >= maxTotalChars) break;
    const raw = String(row.content || '');
    const take = raw.slice(0, Math.min(maxPerDoc, maxTotalChars - used));
    used += take.length;
    parts.push({ title: String(row.title || '未命名文档'), body: take, id: row.id });
  }
  return { parts, brand, hadRows: rows.length > 0 };
}

export {
  getKbScopesForTrainAdvisor,
  expandKbSearchPatterns,
  buildKbTrgmNeedle,
  isKbTrgmAvailable,
  filterKbRowsByBrandStore,
  fetchKnowledgeSnippetsForTrainAdvisor,
};
