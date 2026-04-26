/**
 * Agent Handlers - 9 sub-agents + dispatcher
 * V2 aligned with V1 data sources & reply templates (2026-03-08)
 */
import { callLLM } from './llm-provider.js';
import { sanitizeUserFacingLlmText } from '../utils/llm-output-sanitize.js';
import { query } from '../utils/db.js';
import { logger } from '../utils/logger.js';
import { executeMetrics, extractTimeRangeFromText, parseTimeRange, getAllMetricDefs, quickQuery, getTimeLabelChinese } from './data-executor.js';
import { saveMemory, recallMemories, getOutcomeStats } from './agent-memory.js';
import {
  writeWikiKnowledge,
  buildExperienceBlock,
  extractStructuredData,
  recordOutcome,
  getStrategyStats
} from './knowledge/index.js';
import { evaluateOutcome } from './knowledge/outcome-evaluator.js';
import { saveMemory as saveMemPalaceMemory, recallMemory as recallMemPalaceMemory } from './memory-adapter.js';
import { decideStrategy } from './marketing-strategy-engine.js';
import { generateProcurementAdvice } from './procurement-agent.js';
import { getBrandForStore, getConfig } from './config-service.js';
import { toFeishuStoreName, resolveAgentCanonicalStore } from '../config/store-mapping.js';
import { feishuStoreSearchPatterns } from '../utils/store-sql-patterns.js';
import { estimateMarginForStore } from './margin-from-sales.js';
import { unifiedRetrieve, formatUnifiedRetrievalForPrompt } from './unified-retriever.js';
import {
  fetchMergedTableVisitEntries,
  tableVisitEntryIsDissatisfied,
  dissatisfactionDishFromMergedEntry,
  tableVisitSubheadingPeriod,
  dissatisfactionMainReasonFromEntry,
  buildTableVisitKpiMarkdownSection,
  fetchActualGrossMarginForStorePeriod,
  formatActualGrossMarginBitableLines,
  pickStoreFromQuestionText,
  resolveMonthlyRevenueTargetYuan,
  buildMaterialReportReplyForDateRange
} from './deterministic-replies.js';
import { analyzeMetricTree, formatMetricAnalysisForPrompt } from './analysis-engine.js';
import { getBestStrategy, formatExperiencePromptBlock } from './agent-experience.js';
import { getSOPByScenario, detectScenario, formatSopPromptAppendix } from './sop-service.js';
import { getStrategy, formatStrategyPromptAppendix, buildStrategyContextFromQuestion } from './strategy-engine.js';
import { detectMetricFromQuestion } from './analysis-intent.js';

const NOW_CN = () => new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
// pg DATE 列返回 JS Date 对象，需用上海时区格式化避免年份丢失
const FMT_DATE = (d) => {
  if (!d) return '';
  if (d instanceof Date) return d.toLocaleString('en-CA', { timeZone: 'Asia/Shanghai' }).slice(0, 10);
  return String(d).slice(0, 10);
};
const FACTUAL_BLOCKED = '抱歉，我当前无法从数据库中获取相关凭证/数据，请您登录系统手动核查。';

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

/** 管理面板写入的 agent_config_${agentId}.prompt，拼在代码内置 system 提示之前（空则忽略） */
async function adminAgentPromptPrefix(agentId) {
  try {
    const c = await getConfig(`agent_config_${agentId}`);
    const p = c && typeof c === 'object' ? String(c.prompt || '').trim() : '';
    return p ? `【管理端 System Prompt】\n${p}\n\n` : '';
  } catch {
    return '';
  }
}

/** data_auditor：去掉模型偶发的英文思维链/元信息，只保留中文分析正文 */
function zhOnlyDataAuditorNarrative(raw) {
  const s = String(raw || '').trim();
  if (!s) return s;
  const wikiCut = s.search(/【引用经验】/);
  if (wikiCut >= 0) return s.slice(wikiCut).trim();
  const cut = s.search(
    /【问题分析】|^\s*\*?\*?问题分析\*?\*?\s*[:：]?/m
  );
  if (cut >= 0) return s.slice(cut).trim();
  const cutEn = s.search(
    /(?:^|\n)\s*\*?\*?(?:Problem\s+Analysis|Key\s+Issues)\*?\*?\s*[:\s]*/i
  );
  if (cutEn >= 0) return s.slice(cutEn).trim();
  const cut2 = s.search(/【行动建议】|^\s*\*?\*?行动建议\*?\*?\s*[:：]?/m);
  if (cut2 >= 0) return s.slice(cut2).trim();
  const cutEn2 = s.search(
    /(?:^|\n)\s*\*?\*?(?:Actionable\s+Advice|Recommended\s+Actions|Action\s+Plan)\*?\*?\s*[:\s]*/i
  );
  if (cutEn2 >= 0) return s.slice(cutEn2).trim();
  const lines = s.split(/\r?\n/);
  const out = [];
  let keep = false;
  for (const line of lines) {
    const t = line.trim();
    if (!keep) {
      if (!t) continue;
      if (/^(role|input data|constraints|user question|logic|analysis)\s*:/i.test(t)) continue;
      if (/^#{1,6}\s*(role|input|constraint|user question)/i.test(t)) continue;
      if (/[\u4e00-\u9fff]/.test(t) || /^【/.test(t)) keep = true;
      if (keep) out.push(line);
    } else {
      out.push(line);
    }
  }
  const joined = out.join('\n').trim();
  return joined || s;
}

/** 检测输出是否含英文（任一条件满足即认为需要重写） */
function containsSignificantEnglish(s) {
  const body = String(s || '');
  if (/Problem\s+Analysis|Actionable\s+Advice|No empty words like|responsible person|Delivery Ratio|Dine-in.*Revenue|User Role|Next Steps/i.test(body)) return true;
  const totalChars = body.replace(/\s/g, '').length;
  if (totalChars < 10) return false;
  const latinChars = (body.match(/[a-zA-Z]/g) || []).length;
  return latinChars / totalChars > 0.08;
}

async function coerceMonthComparisonAdviceToZh(text, llmContext) {
  const cleaned = zhOnlyDataAuditorNarrative(text);
  if (!containsSignificantEnglish(cleaned)) return cleaned;
  try {
    const tr = await callLLM(
      [
        {
          role: 'system',
          content:
            '你是简体中文编辑。将下面的分析文本**全部改写为简体中文**，保留所有金额数字和百分比。\n' +
            '输出只能包含两段，标题格式固定为：\n【问题分析】\n【行动建议】\n' +
            '每段下面用 1. 2. 3. 编号列出对应内容。\n' +
            '严禁输出任何英文单词、英文标题或元信息说明。'
        },
        { role: 'user', content: cleaned.slice(0, 5000) }
      ],
      {
        temperature: 0.1,
        max_tokens: 800,
        purpose: 'data_auditor',
        ...(llmContext ? { context: llmContext } : {})
      }
    );
    const o = String(tr.content || '').trim();
    return o ? zhOnlyDataAuditorNarrative(o) : cleaned;
  } catch (e) {
    logger.warn({ err: e?.message }, 'coerceMonthComparisonAdviceToZh rewrite failed');
    return cleaned;
  }
}

// ── 决策日志工具（永久存档 + 主动引用）────────────────────────────
async function logDecision({ store, brand = '', decisionType = 'action_plan', title, content, agent = '', sourceTaskId = '', createdBy = '' }) {
  try {
    await query(
      `INSERT INTO decision_log (store, brand, decision_type, title, content, agent, source_task_id, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [store, brand || '', decisionType, title, content, agent, sourceTaskId || '', createdBy || '']
    );
  } catch (e) {
    logger.warn({ err: e?.message }, 'logDecision failed');
  }
}

async function recallDecisions(store, limit = 5) {
  try {
    const r = await query(
      `SELECT decision_type, title, content, agent, created_at
       FROM decision_log WHERE store = $1 AND status = 'active'
       ORDER BY created_at DESC LIMIT $2`,
      [store, limit]
    );
    return r.rows || [];
  } catch (e) { return []; }
}

function formatDecisionHistory(decisions) {
  if (!decisions?.length) return '';
  const TYPE_LABEL = { action_plan: '行动计划', marketing: '营销决策', operation: '运营决策', review: '评估记录' };
  return decisions.map(d => {
    const label = TYPE_LABEL[d.decision_type] || d.decision_type;
    const date = String(d.created_at || '').slice(0, 10);
    return `· [${date}][${label}] ${d.title}：${d.content.slice(0, 120)}${d.content.length > 120 ? '…' : ''}`;
  }).join('\n');
}

// ── Bitable fields 解析（feishu_generic_records.fields 为 jsonb，值可能为 string/number/array） ──
function extractBitableFieldText(val) {
  if (val == null) return '';
  if (typeof val === 'string') return val.trim();
  if (typeof val === 'number') return String(val);
  if (Array.isArray(val)) {
    const parts = [];
    for (const item of val) {
      if (typeof item === 'string') { parts.push(item.trim()); continue; }
      if (item && typeof item === 'object') {
        if (item.text != null) parts.push(String(item.text).trim());
        else if (Array.isArray(item.text_arr)) parts.push(...item.text_arr.map(t => String(t || '').trim()).filter(Boolean));
        else if (item.date) parts.push(String(item.date).trim());
      }
    }
    return parts.filter(Boolean).join(' ');
  }
  if (typeof val === 'object' && val !== null && (val.text != null || val.date != null)) return String(val.text || val.date || '').trim();
  return '';
}

function extractBitableFieldTextFromFields(fields, key) {
  if (!fields || typeof fields !== 'object') return '';
  const raw = fields[key] ?? fields[key.replace(/[^\u4e00-\u9fa5a-zA-Z0-9_]/g, '')];
  return extractBitableFieldText(raw);
}

/** 从 Bitable 记录中取门店名（兼容多种字段名） */
function getStoreFromBitableFields(fields) {
  const keys = ['门店', '所属门店', '门店名称', '店名', '店铺'];
  for (const k of keys) {
    const v = extractBitableFieldTextFromFields(fields, k);
    if (v) return v;
  }
  return '';
}

/** 从 Bitable 字段解析出 YYYY-MM-DD，支持时间戳(ms/s)、日期字符串、{date: "YYYY-MM-DD"} */
function normalizeBitableDateFromFields(fields, dateKey = '日期') {
  const raw = fields && (fields[dateKey] ?? fields['提交时间'] ?? fields['记录日期']);
  if (raw == null) return null;
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    const ms = raw > 1e12 ? raw : raw * 1000;
    // 返回“本地时区日期”，避免 UTC 切片导致昨日/今天错位
    const d0 = new Date(ms);
    if (isNaN(d0.getTime())) return null;
    const y = d0.getFullYear();
    const m = String(d0.getMonth() + 1).padStart(2, '0');
    const day = String(d0.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }
  if (typeof raw === 'string' && /^\d{4}-\d{2}-\d{2}/.test(raw)) return raw.slice(0, 10);
  if (Array.isArray(raw) && raw[0]?.date) return String(raw[0].date).slice(0, 10);
  if (typeof raw === 'object' && raw?.date) return String(raw.date).slice(0, 10);
  return null;
}

/** 门店模糊匹配（与 V1 isLikelySameStore 一致） */
function isLikelySameStore(a, b) {
  const n = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, '');
  const x = n(a), y = n(b);
  if (!x || !y) return false;
  if (x === y || x.includes(y) || y.includes(x)) return true;
  return false;
}

function normalizeStoreKey(v) {
  return String(v || '').trim().toLowerCase().replace(/\s+/g, '');
}

function normalizeStoreAliasKey(v) {
  return normalizeStoreKey(v).replace(/(上海|北京|深圳|广州|大宁|门店|店铺|店|商场|广场|购物中心)/g, '');
}

function sameStore(a, b) {
  const x = normalizeStoreKey(a);
  const y = normalizeStoreKey(b);
  if (!x || !y) return false;
  if (x === y || x.includes(y) || y.includes(x)) return true;
  const ax = normalizeStoreAliasKey(a);
  const by = normalizeStoreAliasKey(b);
  return !!(ax && by && (ax === by || ax.includes(by) || by.includes(ax)));
}

const ALLOWED_RESOLVE_TABLES = new Set(['sales_raw', 'daily_reports']);

async function resolveDbStoreName(tableName, storeInput) {
  const s = String(storeInput || '').trim();
  if (!s) return '';
  if (!ALLOWED_RESOLVE_TABLES.has(tableName)) {
    logger.warn({ tableName }, 'resolveDbStoreName: blocked disallowed tableName');
    return s;
  }
  try {
    const r = await query(`SELECT DISTINCT store FROM ${tableName} WHERE store IS NOT NULL LIMIT 200`);
    const stores = (r.rows || []).map(x => x.store).filter(Boolean);
    const exact = stores.find(x => normalizeStoreKey(x) === normalizeStoreKey(s));
    if (exact) return exact;
    const likely = stores.find(x => sameStore(x, s));
    if (likely) return likely;
  } catch(_e) {}
  return s;
}

// 与 V1/HRMS 一致：用 table_id 兼容 config_key，确保无论谁写入都能查到
const OPENING_TABLE_ID = process.env.BITABLE_OPENING_TABLE_ID || 'tbl32E6d0CyvLvfi';
const CLOSING_TABLE_ID = process.env.BITABLE_CLOSING_TABLE_ID || 'tblXYfSBRrgNGohN';

/** 开档提交情况：按日统计缺失岗位。先按 table_id 拉全量再在内存按门店+日期过滤，确保有数据能查到。 */
async function getOpeningSubmissionReport(store, start, end) {
  if (!store) return null;
  try {
    const storeNorm = String(store).trim().toLowerCase().replace(/\s+/g, '').replace(/店$/, '');
    const storeKeywords = storeNorm.length >= 2 ? [storeNorm, storeNorm.slice(0, 4), '马己仙', '音乐广场', '大宁'].filter(Boolean) : [storeNorm];
    const patterns = feishuStoreSearchPatterns(store);
    const rows = await query(
      `SELECT config_key, fields FROM feishu_generic_records
       WHERE (config_key = 'opening_reports' OR table_id = $1)
         AND created_at >= NOW() - INTERVAL '180 days'
         AND (
           coalesce(fields->>'所属门店', '') ILIKE ANY ($2::text[])
           OR coalesce(fields->>'门店', '') ILIKE ANY ($2::text[])
           OR coalesce(fields->>'门店名称', '') ILIKE ANY ($2::text[])
         )
       ORDER BY updated_at DESC LIMIT 12000`,
      [OPENING_TABLE_ID, patterns]
    );
    if (!rows.rows?.length) return null;
    const list = [];
    const stationToNames = new Map();
    for (const row of rows.rows) {
      const f = row.fields && typeof row.fields === 'object' ? row.fields : {};
      const rowStore = getStoreFromBitableFields(f).trim().toLowerCase().replace(/\s+/g, '');
      const storeMatch = !storeNorm || !rowStore || storeKeywords.some(kw => rowStore.includes(kw) || (storeNorm && rowStore.includes(storeNorm)));
      if (!storeMatch) continue;
      let d = normalizeBitableDateFromFields(f, '日期') ||
               normalizeBitableDateFromFields(f, '记录日期') ||
               normalizeBitableDateFromFields(f, '提交时间');
      if (!d) d = normalizeBitableDateFromFields(f);
      if (!d || d < start || d > end) continue;
      const station = extractBitableFieldTextFromFields(f, '档口') || extractBitableFieldTextFromFields(f, '岗位') || '';
      if (!station) continue;
      const responsible = extractBitableFieldTextFromFields(f, '本档口值班负责人');
      if (!stationToNames.has(station)) stationToNames.set(station, new Set());
      responsible.split(/[,，、\/]/).forEach(n => { const s = n.trim(); if (s) stationToNames.get(station).add(s); });
      list.push({ date: d, station });
    }
    const knownStations = [...new Set(list.map(x => x.station))].sort();
    if (knownStations.length === 0) return null;
    const byDate = new Map();
    for (const { date, station } of list) {
      if (!byDate.has(date)) byDate.set(date, new Set());
      byDate.get(date).add(station);
    }
    const allDates = [...new Set(list.map(x => x.date))].sort();
    const daily = allDates.map(date => {
      const submitted = byDate.get(date) || new Set();
      const missing = knownStations.filter(s => !submitted.has(s));
      const namesStr = (st) => {
        const names = [...(stationToNames.get(st) || [])];
        return names.map(n => typeof n === 'string' ? n : '').filter(Boolean).join('/') || '';
      };
      return {
        date,
        allSubmitted: missing.length === 0,
        missingList: missing.map(st => ({ station: st, names: namesStr(st) }))
      };
    });
    const totalMissing = daily.reduce((sum, d) => sum + d.missingList.length, 0);
    return { knownStations, daily, totalMissing, periodLabel: `${start}～${end}` };
  } catch (e) {
    logger.warn({ err: e?.message, store }, 'getOpeningSubmissionReport failed');
    return null;
  }
}

/** 收档情况：指定日期的各档口收档记录。按 table_id 拉取再按门店+日期过滤。 */
async function getClosingReportForDay(store, dateStr) {
  if (!store || !dateStr) return null;
  try {
    const storeNorm = String(store).trim().toLowerCase().replace(/\s+/g, '').replace(/店$/, '');
    const storeKeywords = storeNorm.length >= 2 ? [storeNorm, storeNorm.slice(0, 4), '马己仙', '音乐广场', '大宁'].filter(Boolean) : [storeNorm];
    const patterns = feishuStoreSearchPatterns(store);
    const rows = await query(
      `SELECT fields FROM feishu_generic_records
       WHERE (config_key = 'closing_reports' OR table_id = $1)
         AND created_at >= NOW() - INTERVAL '180 days'
         AND (
           coalesce(fields->>'所属门店', '') ILIKE ANY ($2::text[])
           OR coalesce(fields->>'门店', '') ILIKE ANY ($2::text[])
           OR coalesce(fields->>'门店名称', '') ILIKE ANY ($2::text[])
         )
       ORDER BY updated_at DESC LIMIT 12000`,
      [CLOSING_TABLE_ID, patterns]
    );
    if (!rows.rows?.length) return { date: dateStr, items: [], emptyReason: '该日无收档记录' };
    const items = [];
    for (const row of rows.rows) {
      const f = row.fields && typeof row.fields === 'object' ? row.fields : {};
      const rowStore = getStoreFromBitableFields(f).trim().toLowerCase().replace(/\s+/g, '');
      const storeMatch = !storeNorm || !rowStore || storeKeywords.some(kw => rowStore.includes(kw) || (storeNorm && rowStore.includes(storeNorm)));
      if (!storeMatch) continue;
      const d = normalizeBitableDateFromFields(f);
      if (!d || d !== dateStr) continue;
      const station = extractBitableFieldTextFromFields(f, '档口') || extractBitableFieldTextFromFields(f, '岗位') || '';
      const score = extractBitableFieldTextFromFields(f, '得分') || extractBitableFieldTextFromFields(f, '档口收档平均得分') || '-';
      const responsible = extractBitableFieldTextFromFields(f, '本档口值班负责人');
      const issues = extractBitableFieldTextFromFields(f, '异常情况说明');
      if (station) items.push({ station, score, responsible, issues });
    }
    return { date: dateStr, items, emptyReason: items.length === 0 ? '该日无收档记录' : null };
  } catch (e) {
    logger.warn({ err: e?.message, store, dateStr }, 'getClosingReportForDay failed');
    return null;
  }
}

/** 收档提交情况（谁没收档）：先按 table_id 拉全量再在内存按门店+日期过滤。 */
async function getClosingSubmissionReport(store, start, end) {
  if (!store) return null;
  try {
    const storeNorm = String(store).trim().toLowerCase().replace(/\s+/g, '').replace(/店$/, '');
    const storeKeywords = storeNorm.length >= 2 ? [storeNorm, storeNorm.slice(0, 4), '马己仙', '音乐广场', '大宁'].filter(Boolean) : [storeNorm];
    const patterns = feishuStoreSearchPatterns(store);
    const rows = await query(
      `SELECT config_key, fields FROM feishu_generic_records
       WHERE (config_key = 'closing_reports' OR table_id = $1)
         AND created_at >= NOW() - INTERVAL '180 days'
         AND (
           coalesce(fields->>'所属门店', '') ILIKE ANY ($2::text[])
           OR coalesce(fields->>'门店', '') ILIKE ANY ($2::text[])
           OR coalesce(fields->>'门店名称', '') ILIKE ANY ($2::text[])
         )
       ORDER BY updated_at DESC LIMIT 12000`,
      [CLOSING_TABLE_ID, patterns]
    );
    if (!rows.rows?.length) return null;
    const list = [];
    const stationToNames = new Map();
    for (const row of rows.rows) {
      const f = row.fields && typeof row.fields === 'object' ? row.fields : {};
      const rowStore = (extractBitableFieldTextFromFields(f, '门店') || extractBitableFieldTextFromFields(f, '所属门店') || '').trim().toLowerCase().replace(/\s+/g, '');
      const storeMatch = !storeNorm || storeKeywords.some(kw => rowStore.includes(kw) || (storeNorm && rowStore.includes(storeNorm)));
      if (!storeMatch) continue;
      let d = normalizeBitableDateFromFields(f, '日期') ||
               normalizeBitableDateFromFields(f, '记录日期') ||
               normalizeBitableDateFromFields(f, '提交时间');
      if (!d) d = normalizeBitableDateFromFields(f);
      if (!d || d < start || d > end) continue;
      const station = extractBitableFieldTextFromFields(f, '档口') || extractBitableFieldTextFromFields(f, '岗位') || '';
      if (!station) continue;
      const responsible = extractBitableFieldTextFromFields(f, '本档口值班负责人');
      if (!stationToNames.has(station)) stationToNames.set(station, new Set());
      responsible.split(/[,，、\/]/).forEach(n => { const s = n.trim(); if (s) stationToNames.get(station).add(s); });
      list.push({ date: d, station });
    }
    const knownStations = [...new Set(list.map(x => x.station))].sort();
    if (knownStations.length === 0) return null;
    const byDate = new Map();
    for (const { date, station } of list) {
      if (!byDate.has(date)) byDate.set(date, new Set());
      byDate.get(date).add(station);
    }
    const allDates = [...new Set(list.map(x => x.date))].sort();
    const daily = allDates.map(date => {
      const submitted = byDate.get(date) || new Set();
      const missing = knownStations.filter(s => !submitted.has(s));
      const namesStr = (st) => {
        const names = [...(stationToNames.get(st) || [])];
        return names.map(n => typeof n === 'string' ? n : '').filter(Boolean).join('/') || '';
      };
      return {
        date,
        allSubmitted: missing.length === 0,
        missingList: missing.map(st => ({ station: st, names: namesStr(st) }))
      };
    });
    const totalMissing = daily.reduce((sum, d) => sum + d.missingList.length, 0);
    return { knownStations, daily, totalMissing, periodLabel: `${start}～${end}` };
  } catch (e) {
    logger.warn({ err: e?.message, store }, 'getClosingSubmissionReport failed');
    return null;
  }
}

function matchMetrics(text, defs) {
  const t = String(text || '').toLowerCase();
  return defs.filter(d => String(d.name || '').toLowerCase().split('').some(c => t.includes(c))).slice(0, 8);
}

function detectFactDemand(text) {
  const hard = /多少|几个|数据|金额|营收|毛利|人数|占比|达成率|对比|排名|总共|合计/.test(text);
  return hard ? 'hard' : 'soft';
}

const TABLE_VISIT_TABLE_ID = process.env.BITABLE_TABLE_VISIT_TABLE_ID || 'tblpx5Efqc6eHo3L';

/** 诊断：返回 feishu_generic_records 表中有哪些 config_key/table_id 及记录数 */
export async function diagnoseFeishuRecords() {
  try {
    const r = await query(`
      SELECT config_key, table_id, COUNT(*) as cnt
      FROM feishu_generic_records
      WHERE created_at >= NOW() - INTERVAL '90 days'
      GROUP BY config_key, table_id
      ORDER BY cnt DESC
      LIMIT 20
    `);
    return r.rows || [];
  } catch (e) {
    return [];
  }
}

/** 桌访反馈：按图版本格式，100% 基于数据库。格式：数据来源+共N条+桌访桌数+简要分析+不满意TOP列表 */
async function buildDeterministicTableVisitReply(store, start, end) {
  if (!store) return '';
  const diag = await diagnoseFeishuRecords();
  logger.info({ tableVisitDiag: diag }, 'table_visit diagnose');
  try {
    const visitEntries = await fetchMergedTableVisitEntries(store, start, end);
    if (!visitEntries.length) return '';
    const periodWord = tableVisitSubheadingPeriod(start, end, null);

    const unsatisfied = visitEntries.filter(tableVisitEntryIsDissatisfied);
    const satisfiedCnt = visitEntries.length - unsatisfied.length;

    // 产品问题：仅从不满意条目的结构化菜品字段提取（与 BI 同源）
    const productCount = new Map();
    for (const e of unsatisfied) {
      String(dissatisfactionDishFromMergedEntry(e) || '').split(/[,，、;；/]/).forEach((p) => {
        const t = p.trim();
        if (t) productCount.set(t, (productCount.get(t) || 0) + 1);
      });
    }
    const topProducts = [...productCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);

    // 不满意原因：仅「不满意的主要原因是什么」字段
    const serviceCount = new Map();
    for (const e of unsatisfied) {
      const svcText = dissatisfactionMainReasonFromEntry(e);
      String(svcText || '').split(/[,，、;；/]/).forEach((p) => {
        const t = p.trim();
        if (t) serviceCount.set(t, (serviceCount.get(t) || 0) + 1);
      });
    }
    const topReasons = [...serviceCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);

    const storeTitle = resolveAgentCanonicalStore(store);
    const lines = [];
    lines.push('### 桌访内容总结');
    lines.push(`**门店** ${storeTitle}${storeTitle !== store ? `（查询：${store}）` : ''}`);
    lines.push(`**周期** ${periodWord}　**样本** ${visitEntries.length} 条`);
    lines.push(`_数据来源：结构化表 + 飞书缓存（按记录去重）_`);
    lines.push('');
    lines.push(`#### 满意度`);
    lines.push(`- 满意：**${satisfiedCnt}** 条`);
    lines.push(`- 有问题：**${unsatisfied.length}** 条`);
    lines.push('');
    if (topProducts.length > 0) {
      lines.push(`#### 产品问题（不满意记录 · 不满意菜品）`);
      topProducts.forEach(([text, count], i) => lines.push(`- ${i + 1}. ${text}（${count} 次）`));
    } else {
      lines.push(`#### 产品问题`);
      lines.push(`- 本时段未记录明确不满意菜品。`);
    }
    if (topReasons.length > 0) {
      lines.push('');
      lines.push(`#### 不满意原因（主要原因为何）`);
      topReasons.forEach(([text, count], i) => lines.push(`- ${i + 1}. ${text}（${count} 次）`));
    }
    const kpi = await buildTableVisitKpiMarkdownSection(store, start, end, { skipIfEmpty: false }).catch(() => '');
    if (kpi) {
      lines.push('');
      lines.push('---');
      lines.push('');
      lines.push(kpi);
    }
    return lines.join('\n');
  } catch (e) {
    logger.warn({ err: e?.message, store }, 'buildDeterministicTableVisitReply failed');
    return '';
  }
}

const BAD_REVIEW_TABLE_ID = process.env.BITABLE_BAD_REVIEW_TABLE_ID || 'tblgReexNjWJOJB6';

/** 差评报告：100% 从 DB 取数，确定性格式；同时支持 config_key 与 table_id 以兼容 HRMS/V2 同步 */
async function buildDeterministicBadReviewReply(store, start, end) {
  try {
    const storePattern = store ? `%${store}%` : '%';
    const storeCond = `AND (fields->>'所属门店' ILIKE $3 OR fields->>'门店' ILIKE $3)`;
    const r = await query(
      `SELECT fields, created_at FROM feishu_generic_records
       WHERE (config_key = 'bad_review' OR config_key LIKE '%差评%' OR table_id = $4)
         AND created_at::date BETWEEN $1::date AND ($2::date + INTERVAL '1 day') ${storeCond}
       ORDER BY created_at DESC LIMIT 30`,
      [start, end, storePattern, BAD_REVIEW_TABLE_ID]
    );
    const rows = r.rows || [];
    if (!rows.length) return store ? `当前门店「${store}」在${start}～${end}内暂无差评报告数据。` : `在${start}～${end}内暂无差评报告数据。`;
    const dateStr = start === end ? start : `${start}～${end}`;
    const lines = [`【数据来源:差评报告】共${rows.length}条。`, '', `根据${dateStr}数据：`];
    rows.slice(0, 15).forEach((row, i) => {
      const f = row.fields && typeof row.fields === 'object' ? row.fields : {};
      const platform = extractBitableFieldTextFromFields(f, '平台') || '';
      const cat = extractBitableFieldTextFromFields(f, '差评分类') || extractBitableFieldTextFromFields(f, '评分') || '';
      const content = extractBitableFieldTextFromFields(f, '评价内容') || extractBitableFieldTextFromFields(f, '差评内容') || '';
      const d = (row.created_at && String(row.created_at).slice(0, 10)) || '';
      lines.push(`${i + 1}. ${d} ${platform} ${cat}: ${(content || '-').slice(0, 80)}`);
    });
    return lines.join('\n');
  } catch (e) {
    logger.warn({ err: e?.message }, 'buildDeterministicBadReviewReply failed');
    return '';
  }
}

/** 例会报告：100% 从 DB 取数，确定性格式 */
async function buildDeterministicMeetingReply(store, start, end) {
  if (!store) return '';
  try {
    const r = await query(
      `SELECT fields, created_at FROM feishu_generic_records
       WHERE config_key = 'meeting_reports'
         AND (fields->>'门店' ILIKE $3 OR fields->>'所属门店' ILIKE $3)
         AND created_at::date BETWEEN $1::date AND ($2::date + INTERVAL '1 day')
       ORDER BY created_at DESC LIMIT 20`,
      [start, end, `%${store}%`]
    );
    const rows = r.rows || [];
    if (!rows.length) return `当前门店「${store}」在${start}～${end}内暂无例会报告数据。`;
    const lines = [`【数据来源:例会报告】共${rows.length}条。`, ''];
    rows.forEach((row, i) => {
      const f = row.fields && typeof row.fields === 'object' ? row.fields : {};
      const d = normalizeBitableDateFromFields(f) || String(row.created_at || '').slice(0, 10);
      const mtype = extractBitableFieldTextFromFields(f, '会议类型') || '例会';
      const attendees = extractBitableFieldTextFromFields(f, '参会人数') || '-';
      const content = extractBitableFieldTextFromFields(f, '会议内容') || '';
      lines.push(`${i + 1}. ${d} ${mtype} 参会:${attendees}人 ${content.slice(0, 60)}`);
    });
    return lines.join('\n');
  } catch (e) {
    logger.warn({ err: e?.message }, 'buildDeterministicMeetingReply failed');
    return '';
  }
}

/** 原料收货报告：优先 agent_messages（与飞书轮询同源），兜底 feishu_generic_records */
async function buildDeterministicMaterialReply(store, start, end) {
  if (!store) return '';
  try {
    return await buildMaterialReportReplyForDateRange(store, start, end);
  } catch (e) {
    logger.warn({ err: e?.message }, 'buildDeterministicMaterialReply failed');
    return '';
  }
}

/** 日期范围 → 中文具体日期（用于回复中展示），如 2026年3月4日～3月10日 */
function formatDateRangeForDisplay(start, end) {
  if (!start || !end) return '';
  const fmt = (s) => {
    const [y, m, d] = s.split('-');
    return `${y}年${m}月${d}日`;
  };
  return `${fmt(start)}～${fmt(end)}`;
}

/** 诊断：返回 daily_reports 表中有哪些门店及最新日期 */
export async function diagnoseDailyReports() {
  try {
    const r = await query(`
      SELECT store, MAX(date) as last_date, COUNT(*) as cnt
      FROM daily_reports
      WHERE date >= NOW() - INTERVAL '30 days'
      GROUP BY store
      ORDER BY cnt DESC
      LIMIT 20
    `);
    return r.rows || [];
  } catch (e) {
    return [];
  }
}

/**
 * sales_raw 菜品销售分析 + 理论毛利率（对接 dish_library_costs）
 * 返回自然语言文本，供 data_auditor 直接回复
 */
async function buildSalesRawAnalysis(store, startDate, endDate, bizFilter = null) {
  if (!store) return '';
  try {
    const resolvedStore = await resolveDbStoreName('sales_raw', store);
    const dbStore = resolvedStore || store;
    const storeNorm = String(dbStore || '').trim().toLowerCase().replace(/\s+/g, '');
    const VALID_BIZ_TYPES = new Set(['dinein', 'takeaway']);
    const safeBizFilter = bizFilter && VALID_BIZ_TYPES.has(bizFilter) ? bizFilter : null;
    const bizParamIdx = safeBizFilter ? 4 : -1;

    const slotR = await query(
      safeBizFilter
        ? `SELECT sr.biz_type, sr.slot,
                SUM(sr.qty)          AS total_qty,
                SUM(sr.sales_amount) AS total_sales,
                SUM(sr.revenue)      AS total_revenue
         FROM sales_raw sr
         WHERE lower(regexp_replace(COALESCE(sr.store,''),'\\s+','','g')) = $1
           AND sr.date::date BETWEEN $2 AND $3
           AND sr.revenue > 0 AND sr.biz_type = $4
         GROUP BY sr.biz_type, sr.slot
         ORDER BY sr.biz_type, sr.slot`
        : `SELECT sr.biz_type, sr.slot,
                SUM(sr.qty)          AS total_qty,
                SUM(sr.sales_amount) AS total_sales,
                SUM(sr.revenue)      AS total_revenue
         FROM sales_raw sr
         WHERE lower(regexp_replace(COALESCE(sr.store,''),'\\s+','','g')) = $1
           AND sr.date::date BETWEEN $2 AND $3
           AND sr.revenue > 0
         GROUP BY sr.biz_type, sr.slot
         ORDER BY sr.biz_type, sr.slot`,
      safeBizFilter ? [storeNorm, startDate, endDate, safeBizFilter] : [storeNorm, startDate, endDate]
    );

    const allDishR = await query(
      safeBizFilter
        ? `SELECT
           sr.biz_type,
           sr.dish_name,
           sr.category,
           SUM(sr.qty)          AS total_qty,
           SUM(sr.sales_amount) AS total_sales,
           SUM(sr.revenue)      AS total_revenue,
           MAX(dlc.unit_cost)   AS unit_cost
         FROM sales_raw sr
         LEFT JOIN dish_library_costs dlc
           ON (dlc.store = sr.store OR dlc.store = '*')
           AND (dlc.biz_type = sr.biz_type OR dlc.biz_type = '*')
           AND lower(trim(dlc.dish_name)) = lower(trim(sr.dish_name))
           AND dlc.enabled = true
         WHERE lower(regexp_replace(COALESCE(sr.store,''),'\\s+','','g')) = $1
           AND sr.date::date BETWEEN $2 AND $3
           AND sr.revenue > 0 AND sr.biz_type = $4
         GROUP BY sr.biz_type, sr.dish_name, sr.category
         ORDER BY SUM(sr.revenue) DESC`
        : `SELECT
           sr.biz_type,
           sr.dish_name,
           sr.category,
           SUM(sr.qty)          AS total_qty,
           SUM(sr.sales_amount) AS total_sales,
           SUM(sr.revenue)      AS total_revenue,
           MAX(dlc.unit_cost)   AS unit_cost
         FROM sales_raw sr
         LEFT JOIN dish_library_costs dlc
           ON (dlc.store = sr.store OR dlc.store = '*')
           AND (dlc.biz_type = sr.biz_type OR dlc.biz_type = '*')
           AND lower(trim(dlc.dish_name)) = lower(trim(sr.dish_name))
           AND dlc.enabled = true
         WHERE lower(regexp_replace(COALESCE(sr.store,''),'\\s+','','g')) = $1
           AND sr.date::date BETWEEN $2 AND $3
           AND sr.revenue > 0
         GROUP BY sr.biz_type, sr.dish_name, sr.category
         ORDER BY SUM(sr.revenue) DESC`,
      safeBizFilter ? [storeNorm, startDate, endDate, safeBizFilter] : [storeNorm, startDate, endDate]
    );

    const catR = await query(
      safeBizFilter
        ? `SELECT sr.biz_type, COALESCE(NULLIF(sr.category,''),'未分类') AS category,
                SUM(sr.qty) AS total_qty, SUM(sr.revenue) AS total_revenue
         FROM sales_raw sr
         WHERE lower(regexp_replace(COALESCE(sr.store,''),'\\s+','','g')) = $1
           AND sr.date::date BETWEEN $2 AND $3
           AND sr.revenue > 0 AND sr.biz_type = $4
         GROUP BY sr.biz_type, category ORDER BY SUM(sr.revenue) DESC LIMIT 12`
        : `SELECT sr.biz_type, COALESCE(NULLIF(sr.category,''),'未分类') AS category,
                SUM(sr.qty) AS total_qty, SUM(sr.revenue) AS total_revenue
         FROM sales_raw sr
         WHERE lower(regexp_replace(COALESCE(sr.store,''),'\\s+','','g')) = $1
           AND sr.date::date BETWEEN $2 AND $3
           AND sr.revenue > 0
         GROUP BY sr.biz_type, category ORDER BY SUM(sr.revenue) DESC LIMIT 12`,
      safeBizFilter ? [storeNorm, startDate, endDate, safeBizFilter] : [storeNorm, startDate, endDate]
    );

    if (!slotR.rows.length && !allDishR.rows.length) return '';

    const fmt = (n) => '¥' + Number(n || 0).toLocaleString('zh-CN', { maximumFractionDigits: 0 });
    const pct = (a, b) => b > 0 ? (a / b * 100).toFixed(1) + '%' : '--';

    // 按 biz_type 汇总
    const bizTotals = {};
    for (const r of slotR.rows) {
      if (!bizTotals[r.biz_type]) bizTotals[r.biz_type] = { qty: 0, sales: 0, revenue: 0 };
      bizTotals[r.biz_type].qty     += Number(r.total_qty || 0);
      bizTotals[r.biz_type].sales   += Number(r.total_sales || 0);
      bizTotals[r.biz_type].revenue += Number(r.total_revenue || 0);
    }
    const totalRev = Object.values(bizTotals).reduce((s, b) => s + b.revenue, 0);

    const lines = [`📊 **菜品销售分析**（${dbStore}） ${startDate} ~ ${endDate}`, ''];

    // 总体概况
    lines.push('**【总体概况】**');
    for (const [biz, t] of Object.entries(bizTotals)) {
      const label = biz === 'dinein' ? '堂食' : biz === 'takeaway' ? '外卖' : biz;
      lines.push(`· ${label}：实收 ${fmt(t.revenue)}（占比 ${pct(t.revenue, totalRev)}），菜品 ${Math.round(t.qty)} 份`);
    }
    lines.push('');

    // 时段分析
    lines.push('**【时段销售分析】**');
    const SLOT_LABEL = { lunch: '午市', afternoon: '下午茶', dinner: '晚市', other: '其他' };
    const slotGroups = {};
    for (const r of slotR.rows) {
      const biz = r.biz_type === 'dinein' ? '堂食' : '外卖';
      const slot = SLOT_LABEL[r.slot] || r.slot;
      if (!slotGroups[biz]) slotGroups[biz] = [];
      slotGroups[biz].push(`${slot} ${fmt(r.total_revenue)}（${Math.round(Number(r.total_qty))}份）`);
    }
    for (const [biz, parts] of Object.entries(slotGroups)) {
      lines.push(`· ${biz}：${parts.join(' | ')}`);
    }
    lines.push('');

    // 品类排行
    if (catR.rows.length) {
      lines.push('**【品类收入排行（TOP8）】**');
      const topCats = catR.rows.slice(0, 8);
      for (const r of topCats) {
        const biz = r.biz_type === 'dinein' ? '堂食' : '外卖';
        lines.push(`· [${biz}] ${r.category}：${fmt(r.total_revenue)}（${Math.round(Number(r.total_qty))}份）`);
      }
      lines.push('');
    }

    lines.push('**【动销菜品（实收 TOP15，便于浏览）】**');
    let rank = 0;
    for (const r of allDishR.rows.slice(0, 15)) {
      rank++;
      const biz = r.biz_type === 'dinein' ? '堂食' : r.biz_type === 'takeaway' ? '外卖' : r.biz_type;
      const rev = Number(r.total_revenue || 0);
      const sales = Number(r.total_sales || 0);
      const qty = Number(r.total_qty || 0);
      const cost = r.unit_cost != null && r.unit_cost !== '' ? Number(r.unit_cost) : null;
      let marginStr = '';
      if (cost != null && Number.isFinite(cost) && qty > 0) {
        const totalCost = cost * qty;
        const parts = [];
        if (sales > 0) parts.push(`折前${((sales - totalCost) / sales * 100).toFixed(1)}%`);
        if (rev > 0) parts.push(`实收${((rev - totalCost) / rev * 100).toFixed(1)}%`);
        marginStr = parts.length ? `  ${parts.join(' / ')}` : '  （无有效金额）';
      } else {
        marginStr = '  （成本库未匹配）';
      }
      lines.push(`${rank}. [${biz}] ${r.dish_name} — 实收${fmt(rev)}${sales > 0 ? `，折前${fmt(sales)}` : ''}，${Math.round(qty)}份${marginStr}`);
    }

    const totalRevAll = allDishR.rows.reduce((s, r) => s + Number(r.total_revenue || 0), 0);
    const totalSalesAll = allDishR.rows.reduce((s, r) => s + Number(r.total_sales || 0), 0);
    let fullMatchedRev = 0;
    let fullMatchedSales = 0;
    let fullMatchedCost = 0;
    const unmatched = [];
    for (const r of allDishR.rows) {
      const rev = Number(r.total_revenue || 0);
      const sales = Number(r.total_sales || 0);
      const qty = Number(r.total_qty || 0);
      const cost = r.unit_cost != null && r.unit_cost !== '' ? Number(r.unit_cost) : null;
      if (cost != null && Number.isFinite(cost) && qty > 0) {
        const totalCost = cost * qty;
        if (sales > 0) fullMatchedSales += sales;
        if (rev > 0) fullMatchedRev += rev;
        fullMatchedCost += totalCost;
      } else if (rev > 0.005 || sales > 0.005) {
        const biz = r.biz_type === 'dinein' ? '堂食' : r.biz_type === 'takeaway' ? '外卖' : r.biz_type;
        unmatched.push({ biz, dish: r.dish_name, rev, sales, qty });
      }
    }
    unmatched.sort((a, b) => b.rev - a.rev);

    lines.push('');
    lines.push('**【全量动销 SKU 理论毛利率（与 dish_library_costs 对齐后汇总）】**');
    lines.push(
      '_口径：理论折前毛利率 =（Σ折前营业额 − Σ(qty×理论成本)）/ Σ折前营业额；理论实收毛利率 =（Σ实收营业额 − Σ(qty×理论成本)）/ Σ实收营业额。以下为 **本店本时段 sales_raw 全部动销分组**（堂食/外卖 × 菜品名 × 品类），非仅 TOP15。_'
    );
    lines.push('');
    const covRevPct = totalRevAll > 0 ? ((fullMatchedRev / totalRevAll) * 100).toFixed(1) : '0';
    const covSalesPct = totalSalesAll > 0 ? ((fullMatchedSales / totalSalesAll) * 100).toFixed(1) : '0';
    lines.push(`- 动销分组数：**${allDishR.rows.length}**（实收额合计 ¥${Math.round(totalRevAll).toLocaleString('zh-CN')}）`);
    lines.push(`- 实收额成本覆盖：**${covRevPct}%**；折前额成本覆盖：**${covSalesPct}%**`);

    if (fullMatchedSales > 0) {
      const preM = ((fullMatchedSales - fullMatchedCost) / fullMatchedSales * 100).toFixed(2);
      if (unmatched.length === 0) {
        lines.push(`📌 **理论折前毛利率（全量已匹配）：${preM}%**`);
      } else {
        lines.push(`📌 **理论折前毛利率（仅已匹配分组）：${preM}%** — 尚有未匹配成本的分组，非全店闭合口径`);
      }
    }
    if (fullMatchedRev > 0) {
      const recM = ((fullMatchedRev - fullMatchedCost) / fullMatchedRev * 100).toFixed(2);
      if (unmatched.length === 0) {
        lines.push(`📌 **理论实收毛利率（全量已匹配）：${recM}%**`);
      } else {
        lines.push(`📌 **理论实收毛利率（仅已匹配部分）：${recM}%**`);
      }
    } else if (fullMatchedSales <= 0) {
      lines.push('⚠️ 当前无任何分组匹配到成本库，无法计算理论毛利率。');
    }

    if (unmatched.length > 0) {
      const show = unmatched.slice(0, 45);
      lines.push('');
      lines.push(`⚠️ **未匹配 dish_library_costs 的动销分组（共 ${unmatched.length} 条，请核对菜名/业态/门店成本行）**：`);
      show.forEach((u, i) => {
        lines.push(
          `${i + 1}. [${u.biz}] ${u.dish} — 实收${fmt(u.rev)}${u.sales > 0 ? `，折前${fmt(u.sales)}` : ''}，${Math.round(u.qty)}份`
        );
      });
      if (unmatched.length > show.length) {
        lines.push(`… 另有 ${unmatched.length - show.length} 条已省略，可缩小日期范围或在库中补全成本后再查。`);
      }
    }

    const ym =
      startDate && String(startDate).length >= 7 && endDate && String(endDate).slice(0, 7) === String(startDate).slice(0, 7)
        ? String(startDate).slice(0, 7)
        : '';
    if (ym) {
      const bit = await fetchActualGrossMarginForStorePeriod(store, ym);
      if (bit) {
        lines.push('');
        lines.push(...formatActualGrossMarginBitableLines(bit, `${ym} 飞书实际毛利率表`));
      }
    }

    return lines.join('\n');
  } catch (e) {
    logger.warn({ err: e?.message }, 'buildSalesRawAnalysis error');
    return '';
  }
}

/** 营收分析：100% 从 daily_reports 取数，不经过 LLM，不含 sales_raw */
/**
 * 月度经营对比摘要：本月（daily_reports）vs 上月（sales_raw 聚合）
 * 返回格式化的自然语言摘要，供 data_auditor 直接回复飞书
 */
async function buildMonthComparisonSummary(store) {
  if (!store) return '';
  try {
    const nowShanghai = new Date().toLocaleString('en-CA', { timeZone: 'Asia/Shanghai' });
    const today = nowShanghai.slice(0, 10);
    const [yr, mo] = today.split('-').map(Number);

    // 本月：daily_reports
    const thisMonthStart = `${yr}-${String(mo).padStart(2, '0')}-01`;
    const thisMonthEnd = today;
    const refMonth = `${yr}-${String(mo).padStart(2, '0')}`;

    const thisMR = await query(
      `SELECT COUNT(*) as days,
              SUM(actual_revenue) as total_rev,
              SUM(dine_traffic) as total_traffic,
              SUM(dine_orders) as total_orders,
              SUM(delivery_actual) as total_delivery,
              AVG(CASE WHEN efficiency > 0 THEN efficiency END) as avg_eff,
              AVG(CASE WHEN actual_margin > 0 THEN actual_margin END) as avg_margin
       FROM daily_reports
       WHERE store ILIKE $1 AND date >= $2 AND date <= $3`,
      [`%${store}%`, thisMonthStart, thisMonthEnd]
    );
    const cur = thisMR.rows[0];
    const curDays = parseInt(cur?.days || 0);
    if (curDays === 0) return '';
    const curRev = parseFloat(cur?.total_rev || 0);
    const curTraffic = parseInt(cur?.total_traffic || 0);
    const curOrders = parseInt(cur?.total_orders || 0);
    const curDelivery = parseFloat(cur?.total_delivery || 0);
    const curEff = parseFloat(cur?.avg_eff || 0);
    const curMargin = parseFloat(cur?.avg_margin || 0);

    // ★ 月目标：必须从 revenue_targets 表取，不能用 daily_reports.budget（该字段不准确）
    let monthlyTarget = 0;
    try {
      const periodVars = [...new Set([refMonth, refMonth.replace(/-/g, ''), refMonth.replace('-', '/')])];
      const rtR = await query(
        `SELECT target_revenue FROM revenue_targets WHERE period = ANY($1::text[]) AND store ILIKE $2 LIMIT 1`,
        [periodVars, `%${store}%`]
      );
      if (rtR.rows.length === 0) {
        const allRt = await query(
          `SELECT store, target_revenue FROM revenue_targets WHERE period = ANY($1::text[])`,
          [periodVars]
        );
        const matched = allRt.rows.find((r) => {
          const tr = parseFloat(r.target_revenue);
          if (!Number.isFinite(tr) || tr <= 0) return false;
          return sameStore(String(r.store || ''), store);
        });
        monthlyTarget = parseFloat(matched?.target_revenue || 0);
      } else {
        monthlyTarget = parseFloat(rtR.rows[0].target_revenue || 0);
      }
    } catch (_) {}

    // ★ 达成率：实际营收 ÷ 月目标（而不是日均 budget_rate）
    const achievementRate = monthlyTarget > 0 ? (curRev / monthlyTarget * 100).toFixed(1) : null;

    // 上月：只用 daily_reports（sales_raw 字段口径与实际营收不一致，禁止用于营收对比）
    const prevMo = mo === 1 ? 12 : mo - 1;
    const prevYr = mo === 1 ? yr - 1 : yr;
    const prevMonthStart = `${prevYr}-${String(prevMo).padStart(2, '0')}-01`;
    const prevMonthEnd = `${prevYr}-${String(prevMo).padStart(2, '0')}-${new Date(prevYr, prevMo, 0).getDate()}`;

    let prevRev = 0, prevDays = 0, prevTraffic = 0, prevOrders = 0, prevDelivery = 0;
    let hasPrevData = false;

    const prevDR = await query(
      `SELECT COUNT(*) as days, SUM(actual_revenue) as total_rev,
              SUM(dine_traffic) as total_traffic, SUM(dine_orders) as total_orders,
              SUM(delivery_actual) as total_delivery
       FROM daily_reports WHERE store ILIKE $1 AND date >= $2 AND date <= $3`,
      [`%${store}%`, prevMonthStart, prevMonthEnd]
    );
    if (parseInt(prevDR.rows[0]?.days || 0) > 0) {
      prevDays = parseInt(prevDR.rows[0].days);
      prevRev = parseFloat(prevDR.rows[0].total_rev || 0);
      prevTraffic = parseInt(prevDR.rows[0].total_traffic || 0);
      prevOrders = parseInt(prevDR.rows[0].total_orders || 0);
      prevDelivery = parseFloat(prevDR.rows[0].total_delivery || 0);
      hasPrevData = true;
    }

    // 格式化输出
    const moName = (m) => `${m}月`;
    const pct = (a, b) => b > 0 ? ((a - b) / b * 100).toFixed(1) : null;
    const arrow = (v) => v === null ? '' : (parseFloat(v) >= 0 ? `▲${v}%` : `▼${Math.abs(v)}%`);

    const lines = [
      `根据${refMonth.replace('-', '年')}月（${curDays}天）营业数据，${store} 经营概览如下：`,
      '',
      `📊 **本月营收（截至${today.slice(5,10)}）**`,
      `- 累计营收：¥${Math.round(curRev).toLocaleString()}` +
        (monthlyTarget > 0 ? `（达成率 ${achievementRate}%，月目标 ¥${Math.round(monthlyTarget).toLocaleString()}）` : ''),
      curEff > 0 ? `- 人均人效：¥${Math.round(curEff)}` : '',
      curMargin > 0 ? `- 毛利率：${(curMargin * 100).toFixed(1)}%` : '',
      curTraffic > 0 ? `- 堂食客流：${curTraffic}人，堂食订单：${curOrders}单` : '',
      curDelivery > 0 ? `- 外卖营收：¥${Math.round(curDelivery).toLocaleString()}` : '',
      '',
    ].filter(l => l !== null);

    if (hasPrevData && prevRev > 0) {
      // 按日均对比，避免本月天数不完整时与上月直接比总额导致失真
      const curDailyRev = curDays > 0 ? curRev / curDays : 0;
      const prevDailyRev = prevDays > 0 ? prevRev / prevDays : 0;
      const revDiff = curDailyRev > 0 && prevDailyRev > 0 ? pct(curDailyRev, prevDailyRev) : null;
      const curDailyTraffic = curDays > 0 ? curTraffic / curDays : 0;
      const prevDailyTraffic = prevDays > 0 ? prevTraffic / prevDays : 0;
      const trafficDiff = prevDailyTraffic > 0 && curDailyTraffic > 0 ? pct(curDailyTraffic, prevDailyTraffic) : prevTraffic > 0 ? pct(curTraffic, prevTraffic) : null;
      const curDailyDelivery = curDays > 0 ? curDelivery / curDays : 0;
      const prevDailyDelivery = prevDays > 0 ? prevDelivery / prevDays : 0;
      const deliveryDiff = prevDailyDelivery > 0 && curDailyDelivery > 0 ? pct(curDailyDelivery, prevDailyDelivery) : prevDelivery > 0 ? pct(curDelivery, prevDelivery) : null;
      lines.push(`📅 **环比上月（${moName(prevMo)}，来源：营业日报；日均对比）**`);
      lines.push(`- 上月累计 ¥${Math.round(prevRev).toLocaleString()}（${prevDays}天，日均 ¥${Math.round(prevDailyRev).toLocaleString()}）`);
      lines.push(`- 本月累计 ¥${Math.round(curRev).toLocaleString()}（${curDays}天，日均 ¥${Math.round(curDailyRev).toLocaleString()}）`);
      if (revDiff !== null) {
        const isDown = parseFloat(revDiff) < 0;
        lines.push(`- 日均营收变化：${arrow(revDiff)} ${isDown ? '📉 本月日均低于上月' : '📈 本月日均高于上月'}`);
      }
      if (trafficDiff !== null) {
        lines.push(`- 日均客流变化：${arrow(trafficDiff)}（本月日均 ${Math.round(curDailyTraffic)}人，上月日均 ${Math.round(prevDailyTraffic)}人）`);
      }
      if (deliveryDiff !== null) {
        lines.push(`- 日均外卖变化：${arrow(deliveryDiff)}（本月日均 ¥${Math.round(curDailyDelivery).toLocaleString()}，上月日均 ¥${Math.round(prevDailyDelivery).toLocaleString()}）`);
      }
    } else {
      lines.push(`📅 **上月（${moName(prevMo)}）**：暂无营业日报数据，无法进行月度对比。`);
      lines.push(`  （月度对比需要上月的实际营业日报记录，请确认 ${prevMo}月 日报已录入系统）`);
    }

    // 追加本月前半段 vs 后半段趋势（月内对比）
    const midDay = 10;
    const midDate = `${yr}-${String(mo).padStart(2, '0')}-${String(midDay).padStart(2, '0')}`;
    if (curDays > midDay) {
      const firstHalf = await query(
        `SELECT SUM(actual_revenue) as rev, COUNT(*) as days FROM daily_reports
         WHERE store ILIKE $1 AND date >= $2 AND date <= $3`,
        [`%${store}%`, thisMonthStart, midDate]
      );
      const secondHalf = await query(
        `SELECT SUM(actual_revenue) as rev, COUNT(*) as days FROM daily_reports
         WHERE store ILIKE $1 AND date > $2 AND date <= $3`,
        [`%${store}%`, midDate, thisMonthEnd]
      );
      const fRev = parseFloat(firstHalf.rows[0]?.rev || 0);
      const sRev = parseFloat(secondHalf.rows[0]?.rev || 0);
      const fDays = parseInt(firstHalf.rows[0]?.days || 0);
      const sDays = parseInt(secondHalf.rows[0]?.days || 0);
      if (fRev > 0 && sRev > 0 && fDays > 0 && sDays > 0) {
        const fAvg = fRev / fDays;
        const sAvg = sRev / sDays;
        const innerDiff = ((sAvg - fAvg) / fAvg * 100).toFixed(1);
        lines.push('');
        lines.push(`📆 **月内趋势（前${fDays}天 vs 后${sDays}天 日均对比）**`);
        lines.push(`- 前半段日均：¥${Math.round(fAvg)}，后半段日均：¥${Math.round(sAvg)} ${parseFloat(innerDiff) < 0 ? '（后半段下滑 ▼'+Math.abs(innerDiff)+'%）' : '（后半段回升 ▲'+innerDiff+'%）'}`);
      }
    }

    lines.push('');
    lines.push('**分析说明**：以上数据来源于营业日报（daily_reports）及销售明细（sales_raw），数据口径均以实际入账为准。');
    return lines.filter(Boolean).join('\n');
  } catch (e) {
    return '';
  }
}

async function buildDeterministicRevenueReply(store, start, end, periodLabel) {
  if (!store) return '';
  // 用 daily_reports 实际 store 名做映射，避免 LIKE/%门店% 命中不足导致月目标/累计口径偏小
  let resolvedStore = store;
  try {
    resolvedStore = await resolveDbStoreName('daily_reports', store);
  } catch(_e) {}
  const storeLike = `%${String(resolvedStore).trim().toLowerCase().replace(/\s+/g, '')}%`;

  // 诊断：先看看 daily_reports 有什么数据
  const diag = await diagnoseDailyReports();
  logger.info({ dailyReportsDiag: diag, storeLike }, 'daily_reports diagnose');

  let rows = [];
  let querySuccess = false;
  try {
    const r = await query(
      `SELECT date, actual_revenue,
              COALESCE(pre_discount_revenue, actual_revenue) as pre_discount_revenue,
              COALESCE(total_discount, 0) as total_discount, COALESCE(budget, 0) as budget,
              COALESCE(budget_rate, 0) as budget_rate,
              actual_margin, dianping_rating, efficiency, labor_total,
              COALESCE(dine_orders, 0) as dine_orders, COALESCE(dine_traffic, 0) as dine_traffic
              , COALESCE(brand,'') as brand
       FROM daily_reports
       WHERE lower(regexp_replace(coalesce(store,''), '\\s+', '', 'g')) LIKE $1 AND date >= $2 AND date <= $3
       ORDER BY date DESC LIMIT 60`,
      [storeLike, start, end]
    );
    rows = r.rows || [];
    querySuccess = true;
    logger.info({ rowCount: rows.length, sampleRow: rows[0] }, 'daily_reports query success');
  } catch (e) {
    logger.warn({ err: e?.message, storeLike }, 'daily_reports first query failed, trying fallback');
    try {
      const r2 = await query(
        `SELECT date, actual_revenue, actual_margin, dianping_rating, target_revenue,
                dine_orders, target_revenue as budget, brand
         FROM daily_reports
         WHERE lower(regexp_replace(coalesce(store,''), '\\s+', '', 'g')) LIKE $1 AND date >= $2 AND date <= $3
         ORDER BY date DESC LIMIT 60`,
        [storeLike, start, end]
      );
      rows = (r2.rows || []).map(row => ({
        ...row,
        pre_discount_revenue: row.actual_revenue,
        total_discount: 0,
        budget: row.target_revenue || 0,
        budget_rate: null,
        efficiency: null,
        labor_total: null,
        dine_orders: row.dine_orders != null ? row.dine_orders : 0,
        dine_traffic: 0
      }));
    } catch (e2) {
      logger.warn({ err: e2?.message }, 'buildDeterministicRevenueReply fallback failed');
      return '';
    }
  }
  try {
    if (!rows.length) return '';
    const totalRevenue = rows.reduce((s, r) => s + (parseFloat(r.actual_revenue) || 0), 0);
    let totalPre = rows.reduce((s, r) => s + (parseFloat(r.pre_discount_revenue) || 0), 0);
    if (totalPre < totalRevenue) totalPre = totalRevenue;
    const now = new Date();
    const refMonth = /^\d{4}-\d{2}-\d{2}$/.test(start) ? start.slice(0, 7) : `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const [refY, refM] = refMonth.split('-').map(Number);
    const monthStart = `${refMonth}-01`;
    const totalDaysInMonth = new Date(refY, refM, 0).getDate();
    const monthEnd = `${refMonth}-${String(totalDaysInMonth).padStart(2, '0')}`;
    // 实收达成率分母：优先 revenue_targets「本月实收目标」（支持 period 为 2026-04 / 202604 等）；再兜底 daily_reports 日目标加总
    let monthBudget = await resolveMonthlyRevenueTargetYuan(store, refMonth);
    if (!monthBudget) {
      try {
        const mb = await query(
          `SELECT COALESCE(SUM(target_revenue),0) AS b
           FROM daily_reports
           WHERE lower(regexp_replace(coalesce(store,''), '\\s+', '', 'g')) LIKE $1
             AND date >= $2 AND date <= $3`,
          [storeLike, monthStart, monthEnd]
        );
        monthBudget = parseFloat(mb.rows?.[0]?.b || 0) || 0;
      } catch (_) {}
    }
    if (!monthBudget) {
      try {
        const mb2 = await query(
          `SELECT COALESCE(SUM(budget),0) AS b
           FROM daily_reports
           WHERE lower(regexp_replace(coalesce(store,''), '\\s+', '', 'g')) LIKE $1
             AND date >= $2 AND date <= $3`,
          [storeLike, monthStart, monthEnd]
        );
        monthBudget = parseFloat(mb2.rows?.[0]?.b || 0) || 0;
      } catch (_e) {}
    }
    let mR;
    try {
      mR = await query(
        `SELECT COALESCE(SUM(actual_revenue),0) as cum_rev, COALESCE(SUM(pre_discount_revenue),0) as cum_pre,
                COALESCE(SUM(budget),0) as b, COUNT(*) as days, COALESCE(SUM(labor_total),0) as cum_labor
         FROM daily_reports WHERE lower(regexp_replace(coalesce(store,''), '\\s+', '', 'g')) LIKE $1 AND date >= $2 AND date <= $3`,
        [storeLike, monthStart, end]
      );
    } catch (_) {
      mR = await query(
        `SELECT COALESCE(SUM(actual_revenue),0) as cum_rev, COUNT(*) as days FROM daily_reports
         WHERE lower(regexp_replace(coalesce(store,''), '\\s+', '', 'g')) LIKE $1 AND date >= $2 AND date <= $3`,
        [storeLike, monthStart, end]
      ).catch(() => ({ rows: [{}] }));
      if (mR.rows?.[0]) { mR.rows[0].cum_pre = mR.rows[0].cum_rev; mR.rows[0].b = 0; mR.rows[0].cum_labor = 0; }
    }
    const m = mR.rows?.[0] || {};
    let cumRev = parseFloat(m.cum_rev) || 0, cumPre = parseFloat(m.cum_pre) || 0, cumLabor = parseFloat(m.cum_labor) || 0;
    if (!monthBudget && m.b) monthBudget = parseFloat(m.b) || 0;
    const monthDays = parseInt(m.days) || 0;

    const lines = [];
    const dateRangeStr = formatDateRangeForDisplay(start, end);
    if (rows.length <= 2) {
      const row = rows[0];
      const dayStr = row.date ? `${String(row.date).slice(0, 4)}年${String(row.date).slice(5, 7)}月${String(row.date).slice(8, 10)}日` : dateRangeStr;
      if (dayStr) lines.push(`根据${rows.length === 1 ? '昨日' : '当日'}(${dayStr})数据，${store}经营情况如下：`, '');
      const actualRev = parseFloat(row.actual_revenue) || 0;
      let preDiscount = parseFloat(row.pre_discount_revenue) || 0;
      let totalDiscount = parseFloat(row.total_discount) || 0;
      if (preDiscount < actualRev) preDiscount = actualRev;
      totalDiscount = preDiscount - actualRev;
      lines.push(`- **实收营业额**: ${actualRev.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} (已扣优惠)`);
      if (preDiscount > 0) lines.push(`- **折前营业额**: ${preDiscount.toLocaleString('zh-CN', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} (含优惠前金额)`);
      if (totalDiscount > 0) lines.push(`- **总折扣金额**: ${totalDiscount.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} (含优惠前金额)`);
      const dineOrders = parseInt(row.dine_orders, 10) || 0;
      const dineTraffic = parseInt(row.dine_traffic, 10) || 0;
      if (dineOrders > 0) lines.push(`- **堂食桌数**: ${dineOrders}桌`);
      if (dineTraffic > 0) lines.push(`- **堂食客流**: ${dineTraffic}人次`);
      const rate = row.budget_rate != null ? (parseFloat(row.budget_rate) * 100).toFixed(1) : null;
      if (rate != null && Number(rate) > 0) lines.push(`- **达成率**: ${rate}%`);
      lines.push('√ **补充指标**');
      if (monthBudget > 0) {
        const achRate = (cumRev / monthBudget * 100).toFixed(1);
        const theoRate = (monthDays / totalDaysInMonth * 100).toFixed(1);
        lines.push(`- **实收营业目标达成率**: ${achRate}%(本月累计实收¥${cumRev.toLocaleString('zh-CN', { minimumFractionDigits: 0 })} / 本月实收目标 ¥${monthBudget.toLocaleString('zh-CN', { minimumFractionDigits: 0 })})`);
        lines.push(`- **理论达成率**: ${theoRate}% (${monthDays}/${totalDaysInMonth}天)`);
      }
      const margin = row.actual_margin != null ? parseFloat(row.actual_margin) : null;
      lines.push(margin != null && !isNaN(margin) ? `- **毛利率**: ${margin.toFixed(1)}%` : `- **毛利率**: 暂无 (当日菜品明细未录入)`);
      const dp = row.dianping_rating != null ? parseFloat(row.dianping_rating) : null;
      if (dp != null && !isNaN(dp)) lines.push(`- **今日大众点评评分**: ${dp.toFixed(2)}`);
      const eff = row.efficiency != null ? parseFloat(row.efficiency) : null;
      const labor = row.labor_total != null ? parseFloat(row.labor_total) : null;
      if (eff != null && !isNaN(eff)) lines.push(`- **今日人效值**: ¥${Math.round(eff).toLocaleString('zh-CN')}${labor != null && !isNaN(labor) ? ` (出勤${labor.toFixed(0)}工时)` : ''}`);
      if (cumLabor > 0 && cumPre > 0) lines.push(`- **本月累计人效值**: ¥${Math.round(cumPre / cumLabor).toLocaleString('zh-CN')} (折前 ¥${Math.round(cumPre).toLocaleString('zh-CN')} / 出勤 ${cumLabor.toFixed(1)}人)`);
    } else {
      const totalDisc = totalPre - totalRevenue;
      const dateRangeStr = formatDateRangeForDisplay(start, end);
      if (dateRangeStr) lines.unshift(`根据最近7天(${dateRangeStr})数据，${store}经营情况如下：`, '');
      lines.push(`- **实收营业额**: ${totalRevenue.toLocaleString('zh-CN', { minimumFractionDigits: 0, maximumFractionDigits: 0 })} (${rows.length}天合计)`);
      if (totalPre > 0) lines.push(`- **折前营业额**: ${totalPre.toLocaleString('zh-CN', { minimumFractionDigits: 0, maximumFractionDigits: 0 })} (含优惠前金额)`);
      if (totalDisc > 0) lines.push(`- **总折扣金额**: ${totalDisc.toLocaleString('zh-CN', { minimumFractionDigits: 0, maximumFractionDigits: 0 })} (含优惠前金额)`);
      const totalDineOrders = rows.reduce((s, r) => s + (parseInt(r.dine_orders, 10) || 0), 0);
      const totalDineTraffic = rows.reduce((s, r) => s + (parseInt(r.dine_traffic, 10) || 0), 0);
      if (totalDineOrders > 0) lines.push(`- **堂食桌数**: ${totalDineOrders}桌 (${rows.length}天合计)`);
      if (totalDineTraffic > 0) lines.push(`- **堂食客流**: ${totalDineTraffic}人次`);
      const avgRate = rows.filter(r => r.budget_rate != null).length ? (rows.reduce((s, r) => s + (parseFloat(r.budget_rate) || 0), 0) / rows.length * 100).toFixed(1) : null;
      if (avgRate != null && Number(avgRate) > 0) lines.push(`- **达成率**: ${avgRate}%`);
      lines.push(`- **日均实收**: ¥${Math.round(totalRevenue / rows.length).toLocaleString('zh-CN')}`);
      if (monthBudget > 0) {
        const achRate = (cumRev / monthBudget * 100).toFixed(1);
        const theoRate = (monthDays / totalDaysInMonth * 100).toFixed(1);
        lines.push(`- **实收达成率**: ${achRate}%（本月累计实收 ¥${cumRev.toLocaleString('zh-CN', { minimumFractionDigits: 0 })} / 本月实收目标 ¥${monthBudget.toLocaleString('zh-CN', { minimumFractionDigits: 0 })}）`);
        lines.push(`- **理论达成率**: ${theoRate}%（${monthDays}/${totalDaysInMonth}天）`);
      }
      const avgMarginArr = rows.filter(r => r.actual_margin != null);
      const avgMarginVal = avgMarginArr.length ? (avgMarginArr.reduce((s, r) => s + parseFloat(r.actual_margin), 0) / avgMarginArr.length).toFixed(1) : null;
      if (avgMarginVal) lines.push(`- **平均毛利率**: ${avgMarginVal}%`);
      const dianpingRows = rows.filter(r => r.dianping_rating != null);
      const avgDianping = dianpingRows.length ? (dianpingRows.reduce((s, r) => s + parseFloat(r.dianping_rating), 0) / dianpingRows.length).toFixed(2) : null;
      if (avgDianping) lines.push(`- **大众点评均分**: ${avgDianping}`);
    }
    return lines.join('\n');
  } catch (e) {
    logger.error({ err: e?.message, stack: e?.stack, store }, 'buildDeterministicRevenueReply failed - DETAILED');
    return '';
  }
}

/** Data：偏查询与事实；Decision：偏归因、策略与闭环 */
export function detectDecisionMode(text = '') {
  const t = String(text || '');
  const decisionKeywords = [
    '为什么',
    '原因',
    '怎么办',
    '如何',
    '策略',
    '优化',
    '提升',
    '问题',
    '下降',
    '增长'
  ];
  const dataKeywords = ['多少', '数据', '营业额', '明细', '报表', '昨天', '今天', '本周'];

  if (decisionKeywords.some((k) => t.includes(k))) {
    return 'decision';
  }
  if (dataKeywords.some((k) => t.includes(k))) {
    return 'data';
  }
  return 'decision';
}

/** 从注入的 ds 中解析「当前最优策略」及首条统计行的 weightedScore / 成功率 / 趋势 */
function parseStrategyHeadFromDs(ds) {
  const s = String(ds || '');
  const opt = s.match(/当前最优策略：\s*([^\n]+)/);
  const action = opt ? opt[1].trim() : '';
  const wsM = s.match(/weightedScore\s+([0-9.]+)/);
  const pctM = s.match(/成功率\s+(\d+)%/);
  const trM = s.match(/趋势\s+([^\s｜）\n]+)/);
  return {
    action: action || '先完成营业数据补录与凭据核对',
    ws: wsM ? wsM[1] : '0.50',
    sr: pctM ? pctM[1] : '0',
    tr: trM ? trM[1] : 'stable'
  };
}

function stripReportStyleEnding(response) {
  let s = String(response || '').trim();
  s = s.replace(/(需要持续观察|建议关注|可以进一步分析)[。．…\s]*$/g, '').trim();
  return s;
}

function trimMultiSuggestions(response) {
  const keywords = ['另外', '此外', '同时', '也可以'];
  let earliest = -1;
  const str = String(response);
  for (const k of keywords) {
    const i = str.indexOf(k);
    if (i !== -1 && (earliest === -1 || i < earliest)) earliest = i;
  }
  if (earliest === -1) return str;
  return str.slice(0, earliest).trim();
}

/** decision 模式：单一可执行动作 + 去多建议连接词 + 去报表式结尾；缺「今日重点动作」时用策略统计兜底 */
async function coerceDecisionExecutionOutput(response, mode, store, text) {
  if (mode !== 'decision') return stripReportStyleEnding(String(response || '').trim());
  let out = stripReportStyleEnding(String(response || '').trim());
  if (!out.includes('今日重点动作')) {
    let stats = [];
    if (store) {
      try {
        stats = await getStrategyStats({ store, problem: String(text || '').slice(0, 120) });
      } catch (_) {}
    }
    const best = stats[0];
    const ws =
      best?.weightedScore != null && !Number.isNaN(Number(best.weightedScore))
        ? Number(best.weightedScore).toFixed(2)
        : '0.50';
    const pct = Math.round((best?.successRate ?? 0) * 100);
    const trend = best?.trend != null ? String(best.trend) : 'stable';
    const act = best?.action != null ? String(best.action).trim() : '先完成营业数据补录与凭据核对';
    const why = best
      ? '引用经验：本条为策略统计中 policyScore／weightedScore 与趋势综合排序首位。'
      : '引用经验：暂无足够策略样本；优先补齐数据与地面动作，再量化比较。';
    out = `【核心问题】\n当前存在关键运营问题\n\n【今日重点动作】\n${act}\n（weightedScore ${ws}｜成功率 ${pct}%｜趋势 ${trend}）\n\n【为什么是这个动作】\n${why}\n\n【执行要求】\n店长今日内必须完成执行并记录结果，便于系统更新 outcome。`;
  }
  out = trimMultiSuggestions(out);
  out = stripReportStyleEnding(out);
  return out;
}

function extractDataAuditorOutcomeFields(response, mode) {
  const r = String(response || '');
  if (mode === 'decision' && /【今日重点动作】/.test(r)) {
    const probM = r.match(/【核心问题】\s*([\s\S]*?)(?=\n【今日重点动作】|$)/);
    const actM = r.match(/【今日重点动作】\s*([\s\S]*?)(?=\n【为什么是这个动作】|$)/);
    const causeM = r.match(/【为什么是这个动作】\s*([\s\S]*?)(?=\n【执行要求】|$)/);
    const problem = probM ? probM[1].trim().slice(0, 500) : '';
    const action = actM ? actM[1].trim().slice(0, 500) : '';
    const cause = causeM ? causeM[1].trim().slice(0, 500) : '';
    return {
      problem: problem || r.slice(0, 200).slice(0, 500),
      cause,
      action: action || cause.slice(0, 500)
    };
  }
  return extractStructuredData(r);
}

/** 已注入 Wiki 但模型未输出执行化结构时，用历史经验 + 策略统计生成合规回答（不编造数字） */
function buildWikiComplianceFallback(ds, text, store) {
  const m = String(ds || '').match(/- 结论：[^\n]+/);
  const quote = m ? m[0].replace(/^- 结论：/, '').trim().slice(0, 200) : '系统提供的历史经验摘要。';
  const core = /下降|下滑|变差/.test(String(text || ''))
    ? '营业额下滑的主因在当前会话中无法仅凭数据库确认（缺凭证）'
    : '核心问题需结合门店数据进一步确认（当前缺凭证）';
  const st = parseStrategyHeadFromDs(ds);
  const hasStats = String(ds).includes('【策略效果统计】');
  const whyStats = hasStats
    ? `引用经验：${quote}。策略统计上「${st.action}」的 weightedScore 为 ${st.ws}、成功率 ${st.sr}%、趋势 ${st.tr}，policyScore 排序为首，故作为唯一执行项。`
    : `引用经验：${quote}。当前策略样本不足，优先完成凭据与日报补录，再据实迭代。`;

  return (
    `【核心问题】\n${core}\n\n` +
    `【今日重点动作】\n${st.action}\n（weightedScore ${st.ws}｜成功率 ${st.sr}%｜趋势 ${st.tr}）\n\n` +
    `【为什么是这个动作】\n${whyStats}\n\n` +
    `【执行要求】\n店长须于今日营业结束前落实上述动作，并在系统记录执行结果；门店「${store || '门店'}」负责人对验收留痕负责。`
  );
}

// ── 1. Data Auditor (对标V1: BI工具+营收汇总+销售排行+差评排行) ──
async function handleDataAuditor(text, ctx) {
  const mode = detectDecisionMode(text);
  console.log('[MODE]', mode, text);

  const store = await pickStoreFromQuestionText(text, ctx.store || '');
  const brand = store ? await getBrandForStore(store).catch(() => null) : null;
  const tr = extractTimeRangeFromText(text);
  const { start, end, label } = parseTimeRange(tr);
  const timeLabel = getTimeLabelChinese(tr);
  const isBusinessOverview = /生意|营业|经营|经营情况|怎么样|如何/.test(text) && !/桌访|桌数|开档|收档|差评|原料|例会|报损/.test(text);
  // ── sales_raw 菜品明细分析（产品结构/时段/堂外/毛利率 等关键词）────────
  const isSalesDetailQuery = /(菜品|产品结构|销售排行|时段|午市|晚市|下午茶|堂食.*外卖|外卖.*堂食|毛利率|毛利|成本库|菜品库|理论.*毛利|折前毛利率|实收毛利率)/.test(text);
  const bizFilter = /^外卖/.test(text) ? 'takeaway' : /^堂食/.test(text) ? 'dinein' : null;
  if (store && isSalesDetailQuery) {
    // 确定日期范围：默认本月；若用户指定了范围则用指定范围
    const nowShanghai = new Date().toLocaleString('en-CA', { timeZone: 'Asia/Shanghai' });
    const today = nowShanghai.slice(0, 10);
    const curYM = today.slice(0, 7);
    const salesStart = start || `${curYM}-01`;
    const salesEnd   = end   || today;

    const salesBody = await buildSalesRawAnalysis(store, salesStart, salesEnd, bizFilter);
    if (salesBody) {
      saveMemory('data_auditor', store, salesBody.slice(0, 500), { query: text.slice(0, 200) }).catch((e) => { logger.debug({ err: e?.message }, 'saveMemory failed'); });
      try {
        await writeWikiKnowledge({
          agent: 'data_auditor',
          store,
          query: text,
          response: salesBody,
          data: salesBody
        });
        const structured = extractStructuredData(salesBody);
        let outcome = { result: 'unknown', score: 0.5 };
        try {
          outcome = evaluateOutcome({
            beforeData: ctx.metricAnalysis?.before,
            afterData: ctx.metricAnalysis?.after,
            metricAnalysis: ctx.metricAnalysis || null
          });
        } catch (e) { logger.warn({ err: e?.message }, 'evaluateOutcome failed'); }
        await recordOutcome({
          store,
          problem: structured.problem,
          action: structured.action,
          result: outcome.result,
          score: outcome.score
        });
      } catch (e) { logger.warn({ err: e?.message }, 'recordOutcome failed'); }
      return {
        agent: 'data_auditor',
        response: salesBody,
        store,
        data: salesBody,
        timeRange: `${salesStart}~${salesEnd}`,
        timeLabel: `${salesStart} ~ ${salesEnd}`,
        reportTitle: '菜品销售分析',
        dataBacked: true
      };
    }
    if (/理论\s*毛|理论折前|理论实收/.test(text)) {
      const hint = [
        `📊 **${store}** ${salesStart}～${salesEnd} **理论毛利率**`,
        '',
        '本时段 **sales_raw** 无可用菜品明细（或门店名与库中 `store` 不一致），无法用成本库汇总计算。',
        '请确认：该月已导入销售明细；店名与 `sales_raw.store` / `feishu_users` 登记一致。',
        `_解析到的时间范围：${salesStart} ~ ${salesEnd}（若不对请在句中写「2026年2月」）_`
      ].join('\n');
      return {
        agent: 'data_auditor',
        response: hint,
        store,
        data: hint,
        timeRange: `${salesStart}~${salesEnd}`,
        timeLabel: `${salesStart} ~ ${salesEnd}`,
        reportTitle: '菜品销售分析',
        dataBacked: true
      };
    }
  }

  // 旧毛利估算入口（保留兼容）
  if (store && /(毛利估算|预估毛利|销售.*成本)/.test(text)) {
    const marginBody = await estimateMarginForStore(store, start, end);
    if (marginBody) {
      saveMemory('data_auditor', store, marginBody.slice(0, 500), { query: text.slice(0, 200) }).catch((e) => { logger.debug({ err: e?.message }, 'saveMemory failed'); });
      return {
        agent: 'data_auditor',
        response: marginBody,
        store,
        data: marginBody,
        timeRange: tr,
        timeLabel,
        reportTitle: '毛利估算',
        dataBacked: true
      };
    }
  }
  // 月度对比查询（上个月/对比/下滑/下降/趋势/变化等关键词）→ 跨表对比 + LLM 分析建议
  const isComparisonQuery = /(上个月|上月|同期|对比|比较|下滑|下降|增长|趋势|变化|环比|同比)/.test(text);
  const needsAnalysis = /(原因|为什么|建议|怎么办|怎么改|如何|下滑|下降|不好|差)/.test(text);
  if (store && (isBusinessOverview || isComparisonQuery)) {
    // 主动引用历史决策日志
    const pastDecisions = await recallDecisions(store, 4);
    const decisionHistory = formatDecisionHistory(pastDecisions);

    const monthSummary = await buildMonthComparisonSummary(store);
    if (monthSummary) {
      let fullResponse = monthSummary;
      // 如果有历史决策，追加到分析后面
      if (decisionHistory) {
        fullResponse += `\n\n---\n**【历史决策记录】**\n${decisionHistory}`;
      }
      let actionItemsText = '';
      // 若用户问原因/建议/下滑，追加 LLM 专业分析
      if (needsAnalysis || isComparisonQuery) {
        try {
          const advPrefix = await adminAgentPromptPrefix('data_auditor');
          const ar = await callLLM([
            {
              role: 'system',
              content:
                advPrefix +
                '你是中国餐饮连锁运营顾问，拥有15年实战经验。\n' +
                '请根据用户提供的营业数据，用**纯简体中文**完成以下分析，不得出现任何英文单词或英文段落。\n\n' +
                '输出必须严格按照下面两段格式，不得增减或改变标题：\n\n' +
                '【问题分析】\n' +
                '1. 第一个问题（附具体数字）\n' +
                '2. 第二个问题（附具体数字）\n' +
                '3. 第三个问题（可选）\n\n' +
                '【行动建议】\n' +
                '1. 负责人在X天内完成某动作，目标：可量化指标\n' +
                '2. …\n' +
                '3. …\n\n' +
                '规则：\n' +
                '- 禁止使用「优化」「提升」「加强」等空洞词汇，换成具体行动\n' +
                '- 每条建议须注明负责人（店长/出品经理/运营）和完成时限\n' +
                '- 若外卖收入占比超过20%，须单独分析外卖趋势\n' +
                '- 禁止输出英文、JSON、代码块或任何非中文段落标题'
            },
            { role: 'user', content: `以下是营业数据摘要：\n\n${monthSummary}\n\n用户问题：${text}` }
          ], { temperature: 0.2, max_tokens: 800, purpose: 'data_auditor', ...(ctx.llmContext ? { context: ctx.llmContext } : {}) });
          if (ar.content && ar.content.trim()) {
            actionItemsText = await coerceMonthComparisonAdviceToZh(ar.content.trim(), ctx.llmContext);
            fullResponse = monthSummary + '\n\n' + actionItemsText;
          }
        } catch (e) { /* LLM 失败，仅返回数据摘要 */ }
      }

      // 若有行动建议，在末尾追加"是否接受任务"提示，并把建议存入 agent_memory 供后续转化
      if (actionItemsText) {
        fullResponse += '\n\n---\n📋 **是否接受以上行动建议？**\n回复 **【接受行动计划】** 后，系统将自动为每条建议创建追踪任务，并定期提醒进度。';
        // 把行动建议存入记忆，键名加 __action_plan__ 前缀，供接受时读取
        saveMemory('data_auditor', store, `__action_plan__\n${actionItemsText}`, {
          query: text.slice(0, 200),
          type: 'action_plan',
          store
        }).catch((e) => { logger.debug({ err: e?.message }, 'saveMemory failed'); });
      }

      saveMemory('data_auditor', store, fullResponse.slice(0, 500), { query: text.slice(0, 200) }).catch((e) => { logger.debug({ err: e?.message }, 'saveMemory failed'); });
      return { agent: 'data_auditor', response: fullResponse, store, data: monthSummary, timeRange: tr, timeLabel: '月度对比', reportTitle: '经营月报', dataBacked: true };
    }
    // 兜底：无对比数据，用确定性营收分析
    const revenueBody = await buildDeterministicRevenueReply(store, start, end, label);
    if (revenueBody) {
      saveMemory('data_auditor', store, revenueBody.slice(0, 500), { query: text.slice(0, 200) }).catch((e) => { logger.debug({ err: e?.message }, 'saveMemory failed'); });
      const revTimeLabel = (tr && /~/.test(tr)) ? `最近7天(${formatDateRangeForDisplay(start, end)})` : timeLabel;
      return { agent: 'data_auditor', response: revenueBody, store, data: revenueBody, timeRange: tr, timeLabel: revTimeLabel, reportTitle: '营收分析', dataBacked: true };
    }
  }

  // 桌访情况：直接返回确定性反馈总结，不再经过 LLM
  if (store && /桌访|桌数|桌访情况/.test(text)) {
    const tableVisitBody = await buildDeterministicTableVisitReply(store, start, end);
    if (tableVisitBody) {
      saveMemory('data_auditor', store, tableVisitBody.slice(0, 500), { query: text.slice(0, 200) }).catch((e) => { logger.debug({ err: e?.message }, 'saveMemory failed'); });
      return { agent: 'data_auditor', response: tableVisitBody, store, data: tableVisitBody, timeRange: tr, timeLabel, reportTitle: '桌访热点', dataBacked: true };
    }
  }

  // 差评报告：确定性回复，不经过 LLM
  if (/差评|投诉|点评/.test(text) && !/桌访|开档|收档|原料|例会/.test(text)) {
    const badReviewBody = await buildDeterministicBadReviewReply(store || '', start, end);
    if (badReviewBody) {
      return { agent: 'data_auditor', response: badReviewBody, store: store || '', data: badReviewBody, timeRange: tr, timeLabel, reportTitle: '差评报告', dataBacked: true };
    }
  }
  // 例会报告：确定性回复
  if (store && /例会|会议/.test(text)) {
    const meetingBody = await buildDeterministicMeetingReply(store, start, end);
    if (meetingBody) {
      return { agent: 'data_auditor', response: meetingBody, store, data: meetingBody, timeRange: tr, timeLabel, reportTitle: '例会报告', dataBacked: true };
    }
  }
  // 原料收货报告：确定性回复
  if (store && /原料|收货|进货|采购/.test(text)) {
    const materialBody = await buildDeterministicMaterialReply(store, start, end);
    if (materialBody) {
      return { agent: 'data_auditor', response: materialBody, store, data: materialBody, timeRange: tr, timeLabel, reportTitle: '原料收货报告', dataBacked: true };
    }
  }

  let ds = '';
  // 问「生意/经营怎么样」时优先拉取并前置营收汇总，避免只回桌访
  if (store) {
    try {
      const rev = await query(
        `SELECT date, actual_revenue, budget, budget_rate, actual_margin, pre_discount_revenue,
                dine_traffic, dine_orders, delivery_actual, efficiency
         FROM daily_reports WHERE store ILIKE $1 AND date BETWEEN $2 AND $3
         ORDER BY date DESC LIMIT 30`, [`%${store}%`, start, end]);
      if (rev.rows?.length) {
        const avg = rev.rows.reduce((s, r) => s + (parseFloat(r.actual_revenue) || 0), 0) / rev.rows.length;
        const avgRate = rev.rows.reduce((s, r) => s + (parseFloat(r.budget_rate) || 0), 0) / rev.rows.length;
        const avgMargin = rev.rows.reduce((s, r) => s + (parseFloat(r.actual_margin) || 0), 0) / rev.rows.length;
        ds += `\n[营收汇总](${label},${store}) ${rev.rows.length}天数据\n`;
        ds += `- 日均营收: ¥${Math.round(avg)} | 达成率: ${(avgRate * 100).toFixed(1)}% | 毛利率: ${(avgMargin * 100).toFixed(1)}%\n`;
        const r7 = rev.rows.slice(0, 7);
        ds += '- 近7天: ' + r7.map(r => `${String(r.date||'').slice(5,10)}:¥${r.actual_revenue||0}`).join(', ') + '\n';
      } else if (isBusinessOverview) ds += `\n[营收汇总](${label},${store}) 暂无该时间段的营业日报数据。\n`;
    } catch (e) { logger.debug({ err: e?.message }, "query fallback skipped"); }
  }
  // 1) Metric execution (指标库匹配)
  const allDefs = await getAllMetricDefs();
  const matched = matchMetrics(text, allDefs);
  if (matched.length > 0) {
    const res = await executeMetrics(matched.map(m => m.metric_id), tr, store);
    const lines = Object.values(res).filter(r => r.value !== null).map(r => `- ${r.name}: ${r.value}${r.unit || ''}`);
    if (lines.length) ds += `\n[指标数据](${label}, ${store || '全部'})\n${lines.join('\n')}\n`;
  }
  // 3) sales_raw 菜品/时段/结构分析（对标V1 execBiToolSalesRanking）
  const hasSalesRawQuery = store && /排行|排名|畅销|滞销|倒数|TOP|菜品|产品|结构|时段|午市|晚市|下午茶|堂食.*外卖|外卖.*堂食|销售明细|销售数据|哪些|卖得/.test(text);
  if (hasSalesRawQuery) {
    // 3a) 菜品销售排行
    try {
      const sortOrder = /最差|倒数|滞销|垫底/.test(text) ? 'ASC' : 'DESC';
      const safeSortOrder = sortOrder === 'ASC' ? 'ASC' : 'DESC';
      const sr = await query(
        `SELECT dish_name, ROUND(SUM(COALESCE(qty,0))::numeric,0) AS total_qty,
                ROUND(SUM(COALESCE(sales_amount,0))::numeric,0) AS total_sales
         FROM sales_raw WHERE store ILIKE $1 AND date BETWEEN $2 AND $3
           AND COALESCE(dish_name,'') <> ''
         GROUP BY dish_name HAVING SUM(COALESCE(qty,0)) > 0
         ORDER BY SUM(COALESCE(sales_amount,0)) ${safeSortOrder} LIMIT 15`,
        [`%${store}%`, start, end]);
      if (sr.rows?.length) {
        const title = sortOrder === 'ASC' ? '销售倒数TOP15' : '销售TOP15';
        ds += `\n[${title}](${store},${label})\n`;
        sr.rows.forEach((x, i) => { ds += `${i+1}. ${x.dish_name} | ¥${x.total_sales} | ${x.total_qty}份\n`; });
      }
    } catch (e) { /* sales_raw may not exist */ }

    // 3b) 时段分析（午市/晚市/下午茶）
    if (/时段|午市|晚市|下午茶|时间分布|高峰/.test(text)) {
      try {
        const slotR = await query(
          `SELECT slot, biz_type,
                  ROUND(SUM(COALESCE(sales_amount,0))::numeric,0) AS slot_sales,
                  ROUND(SUM(COALESCE(qty,0))::numeric,0) AS slot_qty
           FROM sales_raw WHERE store ILIKE $1 AND date BETWEEN $2 AND $3
           GROUP BY slot, biz_type ORDER BY slot_sales DESC`,
          [`%${store}%`, start, end]);
        if (slotR.rows?.length) {
          const slotLabel = { lunch: '午市', dinner: '晚市', afternoon: '下午茶', other: '其他' };
          const typeLabel = { dinein: '堂食', takeaway: '外卖', delivery: '外卖', '堂食': '堂食', '外卖': '外卖' };
          ds += `\n[时段销售分布](${store},${label})\n`;
          slotR.rows.forEach(r => {
            const sl = slotLabel[r.slot] || r.slot;
            const bt = typeLabel[r.biz_type] || r.biz_type;
            ds += `- ${sl}·${bt}：¥${r.slot_sales}（${r.slot_qty}份）\n`;
          });
        }
      } catch (e) { logger.debug({ err: e?.message }, "query fallback skipped"); }
    }

    // 3c) 类目/部门结构
    if (/类目|品类|结构|分类|产品结构|哪类|哪个类/.test(text)) {
      try {
        const catR = await query(
          `SELECT COALESCE(NULLIF(category,''), department, '未分类') AS cat,
                  ROUND(SUM(COALESCE(sales_amount,0))::numeric,0) AS cat_sales,
                  ROUND(SUM(COALESCE(qty,0))::numeric,0) AS cat_qty
           FROM sales_raw WHERE store ILIKE $1 AND date BETWEEN $2 AND $3
           GROUP BY COALESCE(NULLIF(category,''), department, '未分类')
           ORDER BY cat_sales DESC LIMIT 10`,
          [`%${store}%`, start, end]);
        if (catR.rows?.length) {
          ds += `\n[品类销售结构](${store},${label})\n`;
          catR.rows.forEach(r => { ds += `- ${r.cat}：¥${r.cat_sales}（${r.cat_qty}份）\n`; });
        }
      } catch (e) { logger.debug({ err: e?.message }, "query fallback skipped"); }
    }

    // 3d) 堂食 vs 外卖分布
    if (/堂食|外卖|比例|占比/.test(text)) {
      try {
        const bizR = await query(
          `SELECT
            CASE WHEN biz_type IN ('dinein','堂食') THEN '堂食'
                 WHEN biz_type IN ('takeaway','delivery','外卖') THEN '外卖'
                 ELSE biz_type END AS biz_label,
            ROUND(SUM(COALESCE(sales_amount,0))::numeric,0) AS biz_sales
           FROM sales_raw WHERE store ILIKE $1 AND date BETWEEN $2 AND $3
           GROUP BY biz_label ORDER BY biz_sales DESC`,
          [`%${store}%`, start, end]);
        if (bizR.rows?.length) {
          const total = bizR.rows.reduce((s, r) => s + parseFloat(r.biz_sales || 0), 0);
          ds += `\n[堂食/外卖占比](${store},${label})\n`;
          bizR.rows.forEach(r => {
            const pct = total > 0 ? ((r.biz_sales / total) * 100).toFixed(1) : 0;
            ds += `- ${r.biz_label}：¥${r.biz_sales}（占比 ${pct}%）\n`;
          });
        }
      } catch (e) { logger.debug({ err: e?.message }, "query fallback skipped"); }
    }
  } else if (store && /排行|排名|最好|最差|畅销|滞销|TOP|倒数/.test(text)) {
    // 仅排行关键词时的兜底
    try {
      const sortOrder = /最差|倒数|滞销|垫底/.test(text) ? 'ASC' : 'DESC';
      const safeSortOrder = sortOrder === 'ASC' ? 'ASC' : 'DESC';
      const sr = await query(
        `SELECT dish_name, ROUND(SUM(COALESCE(qty,0))::numeric,0) AS total_qty,
                ROUND(SUM(COALESCE(sales_amount,0))::numeric,0) AS total_sales
         FROM sales_raw WHERE store ILIKE $1 AND date BETWEEN $2 AND $3
           AND COALESCE(dish_name,'') <> ''
         GROUP BY dish_name HAVING SUM(COALESCE(qty,0)) > 0
         ORDER BY SUM(COALESCE(sales_amount,0)) ${safeSortOrder} LIMIT 10`,
        [`%${store}%`, start, end]);
      if (sr.rows?.length) {
        const title = sortOrder === 'ASC' ? '销售倒数TOP10' : '销售TOP10';
        ds += `\n[${title}](${store},${label})\n`;
        sr.rows.forEach((x, i) => { ds += `${i+1}. ${x.dish_name} | ¥${x.total_sales} | ${x.total_qty}份\n`; });
      }
    } catch (e) { /* sales_raw may not exist */ }
  }
  // 4) 差评报告 (对标V1: feishu_generic_records + anomaly_triggers)
  if (/差评|投诉|complaint|点评/.test(text)) {
    try {
      const br = await query(
        `SELECT fields->>'平台' as platform, fields->>'评分' as rating, fields->>'差评分类' as cat,
                fields->>'评价内容' as content, created_at
         FROM feishu_generic_records WHERE config_key='bad_review'
         ${store ? `AND (fields->>'所属门店' ILIKE $3 OR fields->>'门店' ILIKE $3)` : ''}
         AND created_at BETWEEN $1::date AND ($2::date + 1) ORDER BY created_at DESC LIMIT 15`,
        store ? [start, end, `%${store}%`] : [start, end]);
      if (br.rows?.length) {
        ds += `\n[差评报告](${store||'全部'},${label}) ${br.rows.length}条\n`;
        br.rows.slice(0, 8).forEach(r => { ds += `- ${String(r.created_at||'').slice(0,10)} ${r.platform||''} ${r.cat||''}: ${(r.content||'').slice(0,60)}\n`; });
      }
    } catch (e) { logger.debug({ err: e?.message }, "query fallback skipped"); }
    try {
      const at = await query(
        `SELECT anomaly_key, severity, trigger_date, trigger_value FROM anomaly_triggers
         WHERE ${store ? 'store ILIKE $3 AND' : ''} anomaly_key IN ('bad_review_product','bad_review_service','product_review','service_review')
         AND trigger_date BETWEEN $1 AND $2 ORDER BY trigger_date DESC LIMIT 10`,
        store ? [start, end, `%${store}%`] : [start, end]);
      if (at.rows?.length) {
        ds += `\n[差评异常触发] ${at.rows.length}条\n`;
        at.rows.slice(0, 5).forEach(r => { ds += `- ${String(r.trigger_date||'').slice(0,10)} ${r.anomaly_key}(${r.severity})\n`; });
      }
    } catch (e) { logger.debug({ err: e?.message }, "query fallback skipped"); }
  }
  // 5) 收档报告 (feishu_generic_records)
  if (/收档|收市|闭店|closing/.test(text)) {
    try {
      const cr = await query(
        `SELECT fields->>'门店' as s, fields->>'日期' as d, fields->>'档口' as station,
                fields->>'得分' as score, fields->>'异常情况说明' as issues
         FROM feishu_generic_records WHERE config_key='closing_reports'
         ${store ? `AND (fields->>'门店' ILIKE $3 OR fields->>'所属门店' ILIKE $3)` : ''}
         AND created_at BETWEEN $1::date AND ($2::date + 1) ORDER BY created_at DESC LIMIT 15`,
        store ? [start, end, `%${store}%`] : [start, end]);
      if (cr.rows?.length) {
        ds += `\n[收档报告](${store||'全部'},${label}) ${cr.rows.length}条\n`;
        cr.rows.slice(0, 8).forEach(r => { ds += `- ${r.d||''} ${r.station||''} 得分:${r.score||'-'} ${r.issues ? '异常:'+r.issues.slice(0,40) : ''}\n`; });
      }
    } catch (e) { logger.debug({ err: e?.message }, "query fallback skipped"); }
  }
  // 6) 开档报告 (feishu_generic_records)
  if (/开档|开市|开店|opening/.test(text)) {
    try {
      const or2 = await query(
        `SELECT fields->>'门店' as s, fields->>'日期' as d, fields->>'档口' as station,
                fields->>'得分' as score, fields->>'异常情况说明' as issues
         FROM feishu_generic_records WHERE config_key='opening_reports'
         ${store ? `AND (fields->>'门店' ILIKE $3 OR fields->>'所属门店' ILIKE $3)` : ''}
         AND created_at BETWEEN $1::date AND ($2::date + 1) ORDER BY created_at DESC LIMIT 15`,
        store ? [start, end, `%${store}%`] : [start, end]);
      if (or2.rows?.length) {
        ds += `\n[开档报告](${store||'全部'},${label}) ${or2.rows.length}条\n`;
        or2.rows.slice(0, 8).forEach(r => { ds += `- ${r.d||''} ${r.station||''} 得分:${r.score||'-'} ${r.issues ? '异常:'+r.issues.slice(0,40) : ''}\n`; });
      }
    } catch (e) { logger.debug({ err: e?.message }, "query fallback skipped"); }
  }
  // 7) 例会报告 (feishu_generic_records)
  if (/例会|会议|meeting/.test(text)) {
    try {
      const mr = await query(
        `SELECT fields->>'门店' as s, fields->>'日期' as d, fields->>'会议类型' as mtype,
                fields->>'参会人数' as attendees, fields->>'会议内容' as content
         FROM feishu_generic_records WHERE config_key='meeting_reports'
         ${store ? `AND (fields->>'门店' ILIKE $3 OR fields->>'所属门店' ILIKE $3)` : ''}
         AND created_at BETWEEN $1::date AND ($2::date + 1) ORDER BY created_at DESC LIMIT 10`,
        store ? [start, end, `%${store}%`] : [start, end]);
      if (mr.rows?.length) {
        ds += `\n[例会报告](${store||'全部'},${label}) ${mr.rows.length}条\n`;
        mr.rows.slice(0, 6).forEach(r => { ds += `- ${r.d||''} ${r.mtype||'例会'} 参会:${r.attendees||'-'}人 ${(r.content||'').slice(0,50)}\n`; });
      }
    } catch (e) { logger.debug({ err: e?.message }, "query fallback skipped"); }
  }
  // 8) 原料收货日报 (feishu_generic_records)
  if (/原料|收货|进货|material|采购/.test(text)) {
    try {
      const mat = await query(
        `SELECT fields->>'门店' as s, fields->>'收货日期' as d, fields->>'供应商' as supplier,
                fields->>'品名' as item, fields->>'数量' as qty, fields->>'金额' as amt,
                fields->>'异常说明' as issues
         FROM feishu_generic_records WHERE config_key LIKE 'material_%'
         ${store ? `AND (fields->>'门店' ILIKE $3 OR fields->>'所属门店' ILIKE $3)` : ''}
         AND created_at BETWEEN $1::date AND ($2::date + 1) ORDER BY created_at DESC LIMIT 15`,
        store ? [start, end, `%${store}%`] : [start, end]);
      if (mat.rows?.length) {
        ds += `\n[原料收货](${store||'全部'},${label}) ${mat.rows.length}条\n`;
        mat.rows.slice(0, 8).forEach(r => { ds += `- ${r.d||''} ${r.item||''} ${r.qty||''}${r.amt ? ' ¥'+r.amt : ''} ${r.supplier||''} ${r.issues ? '异常:'+r.issues.slice(0,30) : ''}\n`; });
      }
    } catch (e) { logger.debug({ err: e?.message }, "query fallback skipped"); }
  }
  // 9) 报损单 (feishu_generic_records)
  if (/报损|损耗|loss|废弃/.test(text)) {
    try {
      const loss = await query(
        `SELECT fields->>'门店' as s, fields->>'创建日期' as d, fields->>'品名' as item,
                fields->>'数量' as qty, fields->>'金额' as amt, fields->>'原因' as reason
         FROM feishu_generic_records WHERE config_key='loss_report'
         ${store ? `AND (fields->>'门店' ILIKE $3 OR fields->>'所属门店' ILIKE $3)` : ''}
         AND created_at BETWEEN $1::date AND ($2::date + 1) ORDER BY created_at DESC LIMIT 15`,
        store ? [start, end, `%${store}%`] : [start, end]);
      if (loss.rows?.length) {
        ds += `\n[报损记录](${store||'全部'},${label}) ${loss.rows.length}条\n`;
        loss.rows.slice(0, 8).forEach(r => { ds += `- ${r.d||''} ${r.item||''} ${r.qty||''}${r.amt ? ' ¥'+r.amt : ''} ${r.reason||''}\n`; });
      }
    } catch (e) { logger.debug({ err: e?.message }, "query fallback skipped"); }
  }
  if (!ds) ds = '\n[no data found]\n';
  // P2: 记忆回调
  try { const mem = await recallMemories('data_auditor', store, '', 3); if (mem.length) ds += '\n[历史分析]\n' + mem.map(m => m.content.slice(0,80)).join('\n'); } catch(e) {}
  if (mode === 'decision') {
    try {
      const expBlock = await buildExperienceBlock({ agent: 'data_auditor', store, query: text });
      if (expBlock) {
        ds += `\n\n${expBlock}\n`;
        console.log('[WIKI RETRIEVE]');
      }
    } catch (e) { logger.debug({ err: e?.message }, "query fallback skipped"); }
  }
  // 统一知识库检索（P0: 非 train_advisor agent 也能访问知识库 + wiki + mempalace）
  let unifiedKnowledgeBlock_dataAuditor = '';
  if (store) {
    try {
      const urResult = await unifiedRetrieve(text, { store, agent: 'data_auditor', role: ctx.role, limit: 4 });
      if (urResult.parts.length) {
        unifiedKnowledgeBlock_dataAuditor = formatUnifiedRetrievalForPrompt(urResult);
      }
    } catch (e) { /* fail-soft — unified retriever not available */ }
  }
  const businessHint = isBusinessOverview
    ? '\n重要：用户问的是整体生意/经营情况，请以营收、达成率、毛利、客流为主作答；若仅有桌访等单项数据或无营收日报，需先说明「暂无该时段营业日报数据」再简述已有数据，不要只回复桌访。\n'
    : '';
  let metricExperienceAppendix = '';
  let metricSnapshotForOutcome = null;
  if (store) {
    let metricAnalysisForSop = null;
    try {
      if (
        ctx?.metricAnalysis &&
        ((ctx.metricAnalysis.tree || []).length || (ctx.metricAnalysis.root_causes || []).length)
      ) {
        metricAnalysisForSop = ctx.metricAnalysis;
      } else if (ctx?.forceAnalysis) {
        const mc = detectMetricFromQuestion(text) || 'revenue';
        metricAnalysisForSop = await analyzeMetricTree(mc, store, tr);
      } else {
        metricAnalysisForSop = await analyzeMetricTree('revenue', store, tr);
      }
      const treeText = formatMetricAnalysisForPrompt(metricAnalysisForSop);
      if (treeText) metricExperienceAppendix += treeText;
    } catch (e) {
      logger.warn({ err: e?.message }, 'data_auditor metric tree skipped');
    }
    if (mode === 'decision') {
      const detectedScenarioDa = detectScenario(text, metricAnalysisForSop);
      const strategyCtxDa = buildStrategyContextFromQuestion(text, brand, detectedScenarioDa);
      try {
        const steps = detectedScenarioDa ? await getSOPByScenario(detectedScenarioDa) : null;
        metricExperienceAppendix += formatSopPromptAppendix(steps);
      } catch (e) {
        logger.warn({ err: e?.message }, 'data_auditor sop skipped');
      }
      try {
        const strategyBundle = await getStrategy(
          detectedScenarioDa,
          metricAnalysisForSop?.root_causes || [],
          strategyCtxDa
        );
        metricExperienceAppendix += formatStrategyPromptAppendix(strategyBundle);
      } catch (e) {
        logger.warn({ err: e?.message }, 'data_auditor strategy skipped');
      }
      try {
        const best = await getBestStrategy('revenue_drop');
        metricExperienceAppendix += formatExperiencePromptBlock('revenue_drop', best);
      } catch (e) {
        logger.warn({ err: e?.message }, 'data_auditor experience hint skipped');
      }
    }
    metricSnapshotForOutcome = metricAnalysisForSop;
  }
  const forceAnalysisBlock =
    ctx?.forceAnalysis
      ? `

【强制规则】
用户表达了**下降、下滑、变差、不好、异常**等语义时，你必须：
1）先结合下方「指标拆解 / root_causes」分析可能原因（无数据则说明数据缺口）；
2）再输出可执行建议。
禁止只输出营业日报式数字罗列而不做归因与建议。
`
      : '';

  const wikiStructuredOutput =
    mode === 'decision' && ds.includes('历史经验（必须引用）')
      ? `
【Wiki 输出优先】
当下文含「历史经验（必须引用）」时，你必须忽略本节「输出约束」中第1–4点的 V1 逐条格式，改为严格输出且仅输出四段：
【核心问题】→【今日重点动作】→【为什么是这个动作】→【执行要求】。
【为什么是这个动作】首句须含「引用经验」四字；若已有【策略效果统计】，须结合 policyScore／weightedScore、成功率、趋势说明为何只选这一条。
禁止并列多条建议；禁止「同时 / 此外 / 另外 / 也可以」；禁止以「需要持续观察」「建议关注」「可以进一步分析」结尾。
`
      : '';

  let sysPrompt = (await adminAgentPromptPrefix('data_auditor')) + `【角色定义】
你不是问答助手，你是餐饮企业中的“岗位负责人”（数据审计岗）。

【系统上下文】
你运行在一个 AI 运营系统中：
- Planner/Workflow：已完成任务拆解，你只产出本步输出。
- Model Router：已完成模型选择，你不需要考虑模型细节。
- KPI + 审批闭环：在后续步骤使用；本步以“证据驱动的决策要点/可执行判断”为主。

当前时间：${NOW_CN()}。
门店：${store || '未指定'}${brand ? `（${brand}）` : ''}
时间范围：${timeLabel}（用户问的是该时间范围内的数据）
职责：1.营收/毛利/达成率分析 2.销售排行与产品结构 3.差评/投诉汇总 4.人效/客流趋势
${forceAnalysisBlock}

【工作准则】
只根据下方数据库内容回复，禁止编造、臆测或自由发挥。无数据时必须写"暂无此数据"。
注意：下方「系统检索到的知识库」为辅助参考，非当前门店实际数据；回答必须优先基于营业日报等实际数据，知识库仅在你需要引用制度/SOP时查阅。
${businessHint}

【语言】必须使用简体中文作答；禁止英文段落、禁止输出 Role/Input/Constraints 等英文元信息或思维链。

【输出约束（必须严格按以下模版，与V1一致）】
1. 第一行引导句：根据[时间范围](具体日期)数据,[门店]的[经营情况/桌访情况/差评情况等]如下:
2. 每条数据单独一行，格式为：- **指标名**: 值。若下方有[桌访反馈总结]，必须包含反馈总结要点（满意/不满意条数、主要产品/服务不满意项）。
3. 最后一段必须以 **总结** 或 **分析说明** 或 **简要分析** 开头，紧跟一句总结语。
4. 禁止编造数字，无数据时写"暂无此数据"或"昨日无营业数据"。回复不超400字。
${wikiStructuredOutput}
${ds}
${metricExperienceAppendix}
${unifiedKnowledgeBlock_dataAuditor}

`;
  const userContent =
    mode === 'decision' && ds.includes('历史经验（必须引用）')
      ? `${text}\n\n（系统硬性要求：即使下方数据库摘要为空或你无法取数，也必须输出四段：【核心问题】【今日重点动作】【为什么是这个动作】【执行要求】；【为什么是这个动作】首句须含「引用经验」；【今日重点动作】只能写一个可执行动作，并附 weightedScore 或 score、成功率、趋势；【执行要求】须写明谁做、何时完成。）`
      : text;
  const r = await callLLM(
    [
      { role: 'system', content: sysPrompt },
      { role: 'user', content: userContent }
    ],
    { temperature: 0.1, max_tokens: 1200, purpose: 'data_auditor', ...(ctx.llmContext ? { context: ctx.llmContext } : {}) }
  );
  const rawAns = String(r.content || '').trim();
  let cleanedAns = rawAns ? (zhOnlyDataAuditorNarrative(rawAns) || rawAns) : '';
  if (
    mode === 'decision' &&
    ds.includes('历史经验（必须引用）') &&
    !/【今日重点动作】/.test(String(cleanedAns || ''))
  ) {
    cleanedAns = buildWikiComplianceFallback(ds, text, store);
  }
  cleanedAns = await coerceDecisionExecutionOutput(cleanedAns, mode, store, text);
  saveMemory('data_auditor', store, cleanedAns.slice(0, 500), { query: text.slice(0, 200) }).catch((e) => { logger.debug({ err: e?.message }, 'saveMemory failed'); });
  try {
    await writeWikiKnowledge({
      agent: 'data_auditor',
      store,
      query: text,
      response: cleanedAns,
      data: ds
    });
    const structured = extractDataAuditorOutcomeFields(cleanedAns, mode);
    let outcome = { result: 'unknown', score: 0.5 };
    try {
      outcome = evaluateOutcome({
        beforeData: ctx.metricAnalysis?.before,
        afterData: ctx.metricAnalysis?.after,
        metricAnalysis: ctx.metricAnalysis || metricSnapshotForOutcome
      });
    } catch (e) { logger.warn({ err: e?.message }, 'evaluateOutcome failed'); }
    await recordOutcome({
      store,
      problem: structured.problem,
      action: structured.action,
      result: outcome.result,
      score: outcome.score
    });
    // P2: 同时写入 mempalace（得分高且决策模式下）
    if (mode === 'decision' && outcome.score >= 0.7 && process.env.ENABLE_MEMPALACE === 'true') {
      saveMemPalaceMemory({
        agent: 'data_auditor',
        store,
        type: 'outcome',
        content: '问题:' + (structured.problem || '') + '\n原因:' + (structured.cause || '') + '\n策略:' + (structured.action || '') + '\n结果:' + outcome.result,
        metadata: { score: outcome.score }
      }).catch(e => logger.debug({ err: e?.message }, 'data_auditor mempalace failed'));
    }
  } catch (e) { logger.warn({ err: e?.message }, 'recordOutcome failed'); }
  // V1 格式：报告类型标题（由 pipeline 拼成 小年：📊 标题 (门店 · 时间)）
  const reportTitle = inferDataAuditorReportTitle(text, ctx);
  return { agent: 'data_auditor', response: cleanedAns || FACTUAL_BLOCKED, data: ds, store, timeRange: tr, timeLabel, reportTitle, dataBacked: ds !== '\n[no data found]\n' };
}

function inferDataAuditorReportTitle(text, ctx) {
  const t = String(text || '');
  if (ctx?.forceAnalysis && /下降|下滑|变差|不好|异常/.test(t)) return '经营分析';
  if (/营业|生意|营收|达成|日报/.test(t)) return '营业日报分析';
  if (/桌访|桌数/.test(t)) return '桌访热点';
  if (/开档|开市/.test(t)) return '开档服务';
  if (/收档|收市|闭店/.test(t)) return '收档报告';
  if (/差评|投诉|点评/.test(t)) return '差评数据';
  if (/原料|收货|进货|采购/.test(t)) return '原料收货日报';
  if (/例会|会议/.test(t)) return '例会报告';
  if (/报损|损耗/.test(t)) return '报损记录';
  if (/排行|排名|畅销|滞销/.test(t)) return '销售排行';
  return '数据概览';
}

// ── 2. Ops Supervisor (对标V1: 巡检+照片审核+运营标准) ──
async function handleOpsSupervisor(text, ctx) {
  const store = ctx.store || '';
  const brand = store ? await getBrandForStore(store).catch(() => null) : null;
  const tr = extractTimeRangeFromText(text);
  const timeLabel = getTimeLabelChinese(tr);
  const { start, end } = parseTimeRange(tr);

  // 开档提交情况（谁没开档）：100% 基于数据库，不交给 LLM 编造（排除「开档要完成哪些工作」等知识问答）
  const isProceduralKnowledge = /(怎么做|如何做|哪些工作|要完成|什么工作|工作需要|操作步骤|工作流程|标准流程|SOP|操作规范|工作清单|清单|指引|手册|规范|要求是什么|注意事项)/.test(
    text
  );
  if (store && !isProceduralKnowledge && /开档|谁没开档|开档提交|开档.*情况/.test(text)) {
    const report = await getOpeningSubmissionReport(store, start, end);
    if (report && report.knownStations.length > 0 && report.daily.length > 0) {
      const lines = [];
      lines.push(`已知岗位: ${report.knownStations.join('、')}`);
      lines.push('**开档检查缺失记录**:');
      for (const day of report.daily) {
        if (day.allSubmitted) {
          lines.push(`- ${day.date}: 全部已提交`);
        } else {
          const parts = day.missingList.map(m => {
            const names = m.names ? ` (${m.names})` : '';
            return `缺失 ${m.station}${names}`;
          });
          lines.push(`- ${day.date}: ${parts.join('；')}`);
        }
      }
      lines.push(`共缺失${report.totalMissing}次开档提交。`);
      const body = lines.join('\n');
      saveMemory('ops_supervisor', store, body.slice(0, 500), { query: text.slice(0, 200) }).catch((e) => { logger.debug({ err: e?.message }, 'saveMemory failed'); });
      return { agent: 'ops_supervisor', response: body, store, data: body, timeLabel, reportTitle: '开档提交情况' };
    }
    if (report === null || (report && report.daily.length === 0)) {
      const noData = `当前门店「${store}」在所选时间段内暂无开档报告数据，无法统计缺失情况。请确认飞书开档报告是否已同步。`;
      return { agent: 'ops_supervisor', response: noData, store, data: '', timeLabel, reportTitle: '开档提交情况' };
    }
  }

  // 收档提交情况（谁没收档/本周谁没收档）：与开档同一模版，100% 基于数据库
  if (store && /谁没收档|收档提交|收档.*缺失|本周.*收档/.test(text)) {
    const report = await getClosingSubmissionReport(store, start, end);
    if (report && report.knownStations.length > 0 && report.daily.length > 0) {
      const lines = [];
      lines.push(`已知岗位: ${report.knownStations.join('、')}`);
      lines.push('**收档检查缺失记录**:');
      for (const day of report.daily) {
        if (day.allSubmitted) {
          lines.push(`- ${day.date}: 全部已提交`);
        } else {
          const parts = day.missingList.map(m => {
            const names = m.names ? ` (${m.names})` : '';
            return `缺失 ${m.station}${names}`;
          });
          lines.push(`- ${day.date}: ${parts.join('；')}`);
        }
      }
      lines.push(`共缺失${report.totalMissing}次收档提交。`);
      const body = lines.join('\n');
      saveMemory('ops_supervisor', store, body.slice(0, 500), { query: text.slice(0, 200) }).catch((e) => { logger.debug({ err: e?.message }, 'saveMemory failed'); });
      return { agent: 'ops_supervisor', response: body, store, data: body, timeLabel, reportTitle: '收档提交情况' };
    }
    if (report === null || (report && report.daily.length === 0)) {
      const noData = `当前门店「${store}」在所选时间段内暂无收档报告数据，无法统计缺失情况。请确认飞书收档报告是否已同步。`;
      return { agent: 'ops_supervisor', response: noData, store, data: '', timeLabel, reportTitle: '收档提交情况' };
    }
  }

  // 收档情况（昨天收档）：单日各档口得分与异常
  if (store && /收档|收市|闭档|昨天.*收档|收档.*情况/.test(text)) {
    const dateStr = /昨[天日]/.test(text) ? start : start;
    const closing = await getClosingReportForDay(store, dateStr);
    if (closing) {
      if (closing.items && closing.items.length > 0) {
        const lines = [`${dateStr}收档情况（${store}）：`, ''];

        for (const it of closing.items) {
          let line = `- **${it.station}**：得分 ${it.score}`;
          if (it.responsible) line += `，负责人 ${it.responsible}`;
          if (it.issues) line += `；异常：${it.issues.slice(0, 80)}`;
          lines.push(line);
        }
        lines.push('');
        lines.push(`**分析说明**：${dateStr}共 ${closing.items.length} 个档口提交收档，以上为各档口得分与异常说明。`);
        const body = lines.join('\n');
        saveMemory('ops_supervisor', store, body.slice(0, 500), { query: text.slice(0, 200) }).catch((e) => { logger.debug({ err: e?.message }, 'saveMemory failed'); });
        return { agent: 'ops_supervisor', response: body, store, data: body, timeLabel, reportTitle: '收档提交情况' };
      }
      const noData = closing.emptyReason || `该日（${dateStr}）暂无收档记录。`;
      return { agent: 'ops_supervisor', response: noData, store, data: '', timeLabel, reportTitle: '收档提交情况' };
    }
  }

  // 判断是否是业绩/经营相关查询（补充 daily_reports 数据）
  const isBizQuery = /(生意|营业|营收|人效|客流|下滑|趋势|达成|效率|产品|销售)/.test(text);

  let opsData = '';
  if (store && isBizQuery) {
    // 补充 daily_reports 数据供 ops_supervisor 分析业绩
    try {
      const dr = await query(
        `SELECT date, actual_revenue, budget_rate, dine_traffic, dine_orders, efficiency,
                delivery_actual, delivery_bad_reviews, actual_margin
         FROM daily_reports WHERE store ILIKE $1 AND date >= CURRENT_DATE - 14
         ORDER BY date DESC LIMIT 14`, [`%${store}%`]);
      if (dr.rows?.length) {
        opsData += `\n[营业日报 近14天](${store})\n`;
        dr.rows.forEach(r => {
          const rate = r.budget_rate ? (parseFloat(r.budget_rate)*100).toFixed(1)+'%' : '-';
          opsData += `- ${String(r.date||'').slice(5,10)} 营收:¥${r.actual_revenue||0} 达成:${rate} 客流:${r.dine_traffic||0}人 人效:¥${r.efficiency||0} 外卖:¥${r.delivery_actual||0}${r.delivery_bad_reviews>0?' 差评:'+r.delivery_bad_reviews+'单':''}\n`;
        });
      }
    } catch (e) { logger.debug({ err: e?.message }, "query fallback skipped"); }
  }
  if (store) {
    try {
      const r = await query(
        `SELECT fields->>'检查类型' as t, fields->>'得分' as s, fields->>'检查日期' as d,
                fields->>'检查结果' as result
         FROM feishu_generic_records
         WHERE (fields->>'所属门店' ILIKE $1 OR fields->>'门店' ILIKE $1)
         ORDER BY created_at DESC LIMIT 10`, [`%${store}%`]);
      if (r.rows?.length) {
        opsData += '\n[近期巡检记录]\n';
        r.rows.forEach(row => { opsData += `- ${row.d||''}${row.t||'检查'}: ${row.s||'-'}分 ${row.result||''}\n`; });
      }
    } catch (e) { logger.debug({ err: e?.message }, "query fallback skipped"); }
    try {
      const anom = await query(
        `SELECT anomaly_key, severity, trigger_date FROM anomaly_triggers
         WHERE store ILIKE $1 AND anomaly_key IN ('food_safety','hygiene','opening_check','closing_check')
         AND trigger_date >= CURRENT_DATE - 14 ORDER BY trigger_date DESC LIMIT 8`, [`%${store}%`]);
      if (anom.rows?.length) {
        opsData += '\n[近2周运营异常]\n';
        anom.rows.forEach(r => { opsData += `- ${String(r.trigger_date||'').slice(0,10)} ${r.anomaly_key}(${r.severity})\n`; });
      }
    } catch (e) { logger.debug({ err: e?.message }, "query fallback skipped"); }
    try {
      const pats = feishuStoreSearchPatterns(store);
      const username = String(ctx.username || '').trim();
      const role = String(ctx.role || '').trim();
      const hq = role === 'admin' || role === 'hq_manager';
      let tasks;
      if (hq) {
        tasks = await query(
          `SELECT title, status, severity, created_at FROM master_tasks
           WHERE store ILIKE ANY($1::text[]) AND status IN ('pending_dispatch','pending_response')
           ORDER BY created_at DESC LIMIT 5`,
          [pats]
        );
      } else if (username || role) {
        tasks = await query(
          `SELECT title, status, severity, created_at FROM master_tasks
           WHERE store ILIKE ANY($1::text[]) AND status IN ('pending_dispatch','pending_response')
             AND (
               (COALESCE(TRIM(assignee_username),'') <> '' AND LOWER(assignee_username) = LOWER($2))
               OR (COALESCE(TRIM(assignee_username),'') = '' AND $3 <> '' AND assignee_role = $3)
             )
           ORDER BY created_at DESC LIMIT 5`,
          [pats, username, role]
        );
      } else {
        tasks = { rows: [] };
      }
      if (tasks.rows?.length) opsData += '\n[待处理任务] ' + tasks.rows.map(t => `${t.title}(${t.status}/${t.severity})`).join(', ');
    } catch (e) { logger.debug({ err: e?.message }, "query fallback skipped"); }
  }
  try { const mem = await recallMemories('ops_supervisor', store, '', 3); if (mem.length) opsData += '\n[历史巡检] ' + mem.map(m => m.content.slice(0,80)).join('; '); } catch(e) {}
  let metricExperienceAppendixOps = '';
  if (store) {
    let metricAnalysisForSopOps = null;
    try {
      metricAnalysisForSopOps = await analyzeMetricTree('revenue', store, tr);
      const treeText = formatMetricAnalysisForPrompt(metricAnalysisForSopOps);
      if (treeText) metricExperienceAppendixOps += treeText;
    } catch (e) {
      logger.warn({ err: e?.message }, 'ops_supervisor metric tree skipped');
    }
    const detectedScenarioOps = detectScenario(text, metricAnalysisForSopOps);
    const strategyCtxOps = buildStrategyContextFromQuestion(text, brand, detectedScenarioOps);
    try {
      const steps = detectedScenarioOps ? await getSOPByScenario(detectedScenarioOps) : null;
      metricExperienceAppendixOps += formatSopPromptAppendix(steps);
    } catch (e) {
      logger.warn({ err: e?.message }, 'ops_supervisor sop skipped');
    }
    try {
      const strategyBundleOps = await getStrategy(
        detectedScenarioOps,
        metricAnalysisForSopOps?.root_causes || [],
        strategyCtxOps
      );
      metricExperienceAppendixOps += formatStrategyPromptAppendix(strategyBundleOps);
    } catch (e) {
      logger.warn({ err: e?.message }, 'ops_supervisor strategy skipped');
    }
    try {
      const best = await getBestStrategy('ops_quality');
      metricExperienceAppendixOps += formatExperiencePromptBlock('ops_quality', best);
    } catch (e) {
      logger.warn({ err: e?.message }, 'ops_supervisor experience hint skipped');
    }
  }
  // 统一知识库检索（P0: ops_supervisor 也能访问知识库 + wiki + mempalace）
  let unifiedKnowledgeBlock_ops = '';
  if (store) {
    try {
      const urResult = await unifiedRetrieve(text, { store, agent: 'ops_supervisor', role: ctx.role, limit: 4 });
      if (urResult.parts.length) {
        unifiedKnowledgeBlock_ops = formatUnifiedRetrievalForPrompt(urResult);
      }
    } catch (e) { /* fail-soft */ }
  }
  let sysPrompt = (await adminAgentPromptPrefix('ops_supervisor')) + `【角色定义】
你不是问答助手，你是餐饮企业中的“岗位负责人”（营运督导岗）。

【系统上下文】
Planner/Workflow 已确定本步输出目标；你只根据已提供的巡检/异常/待处理任务证据给出督导要点，供后续执行与审批闭环使用。
KPI + 审批闭环在下游完成，本步不做任何数据库写入。

当前时间：${NOW_CN()}。
门店：${store || '未指定'}${brand ? `（${brand}）` : ''}
职责：1.开市/收市检查 2.卫生巡检 3.照片审核 4.运营标准合规 5.异常任务催办

【工作准则】
只基于下方证据回答，禁止编造数据。若信息缺失，写明“暂无此数据/无法判断”，并给出需要确认的关键项（不输出实际结果）。
注意：下方「系统检索到的知识库」为辅助参考，实际数据才是根本；回答必须优先基于实际数据。

【输出约束】
用 - **项**: 值 分条，最后可加 **分析说明**：... 禁止编造数据，回复不超300字。
${opsData}
${metricExperienceAppendixOps}
${unifiedKnowledgeBlock_ops}

`;
  const r = await callLLM([
    { role: 'system', content: sysPrompt },
    { role: 'user', content: text }
  ], { temperature: 0.2, max_tokens: 600, purpose: 'ops_supervisor', ...(ctx.llmContext ? { context: ctx.llmContext } : {}) });
  saveMemory('ops_supervisor', store, (r.content||'').slice(0,500), {query:text.slice(0,200)}).catch((e) => { logger.debug({ err: e?.message }, 'saveMemory failed'); });
  const reportTitle = /开档|谁没|提交情况/.test(text) ? '开档提交情况' : /收档|闭市/.test(text) ? '收档提交情况' : '营运巡检';
  return { agent: 'ops_supervisor', response: r.content || '请描述巡检需求。', store, data: opsData, timeLabel, reportTitle };
}

// ── 3. Chief Evaluator (对标V1: 绩效评分+员工考核+扣分明细) ──
async function handleChiefEvaluator(text, ctx) {
  let evidence = '';
  const store = ctx.store || '', user = ctx.username || '';
  const brand = store ? await getBrandForStore(store).catch(() => null) : null;
  if (store) {
    try {
      const [anom, scores, deductions] = await Promise.all([
        query(`SELECT anomaly_key, severity, COUNT(*)::int as cnt FROM anomaly_triggers
               WHERE store ILIKE $1 AND trigger_date >= CURRENT_DATE - INTERVAL '30 days'
               GROUP BY anomaly_key, severity ORDER BY cnt DESC LIMIT 12`, [`%${store}%`]),
        query(`SELECT role, total_score, period, breakdown, summary, updated_at
               FROM agent_scores WHERE store ILIKE $1 ORDER BY updated_at DESC LIMIT 6`, [`%${store}%`]),
        query(`SELECT anomaly_key, severity, trigger_date, trigger_value FROM anomaly_triggers
               WHERE store ILIKE $1 AND trigger_date >= CURRENT_DATE - 30
               ORDER BY trigger_date DESC LIMIT 15`, [`%${store}%`])
      ]);
      if (anom.rows?.length) {
        evidence += '\n[近30天异常汇总]\n';
        anom.rows.forEach(r => { evidence += `- ${r.anomaly_key}(${r.severity}): ${r.cnt}次\n`; });
      }
      if (scores.rows?.length) {
        evidence += '\n[历史绩效评分]\n';
        scores.rows.forEach(r => {
          evidence += `- ${String(r.period||'').slice(0,24)} ${r.role}: ${r.total_score}分\n`;
        });
      }
      if (deductions.rows?.length) {
        evidence += '\n[近30天扣分明细]\n';
        deductions.rows.slice(0, 10).forEach(r => {
          const tv = r.trigger_value && typeof r.trigger_value === 'object' ? JSON.stringify(r.trigger_value).slice(0, 80) : '';
          evidence += `- ${String(r.trigger_date||'').slice(0,10)} ${r.anomaly_key}(${r.severity}) ${tv}\n`;
        });
      }
    } catch (e) { logger.warn({ err: e?.message }, 'chief_evaluator data fetch'); }
  }
  if (!evidence) evidence = '\n[暂无绩效评分数据]';
  // P2: 记忆回调
  try { const mem = await recallMemories('chief_evaluator', store, '', 3); if (mem.length) evidence += '\n[历史评估] ' + mem.map(m => m.content.slice(0,80)).join('; '); } catch(e) {}
  // 统一知识库检索
  let unifiedKnowledgeBlock_ce = '';
  if (store) {
    try {
      const urResult = await unifiedRetrieve(text, { store, agent: 'chief_evaluator', role: ctx.role, limit: 4 });
      if (urResult.parts.length) unifiedKnowledgeBlock_ce = formatUnifiedRetrievalForPrompt(urResult);
    } catch (e) { /* fail-soft */ }
  }
  let sysPrompt = (await adminAgentPromptPrefix('chief_evaluator')) + `【角色定义】
你不是问答助手，你是餐饮企业中的“岗位负责人”（绩效考核岗位）。

【系统上下文】
Planner/Workflow 已完成任务拆解；Model Router 已选择模型；KPI 与审批闭环在下游记录。
你本步只产出“绩效评分结论 + 依据 + 可执行改善方向”，不做任何数据写入。

当前时间：${NOW_CN()}。
门店：${store || '未指定'}${brand ? `（${brand}）` : ''}，用户：${ctx.name || user || '未知'}

职责：1.门店绩效评分查询 2.员工考核等级说明(A/B/C/D) 3.扣分明细查询 4.奖金规则说明 5.绩效改善建议
评级标准：A级>95分 B级>90分 C级>=85分 D级<85分
奖金规则：A/B级=得分/100×基础奖金, C级归零, D级工资8折

【工作准则】
只能基于真实扣分记录回答：禁止编造分数或扣分项；引用具体异常类别和日期；无确切记录则说“暂无此数据”。
注意：下方「系统检索到的知识库」为辅助参考，实际数据才是根本；回答必须优先基于实际数据。

【输出约束】
不超400字，内容必须可用于绩效闭环沟通与后续整改动作跟进。
${evidence}
${unifiedKnowledgeBlock_ce}

`;
  const r = await callLLM([
    { role: 'system', content: sysPrompt },
    { role: 'user', content: text }
  ], { temperature: 0.1, max_tokens: 600, purpose: 'chief_evaluator', ...(ctx.llmContext ? { context: ctx.llmContext } : {}) });
  saveMemory('chief_evaluator', store, (r.content||'').slice(0,500), {query:text.slice(0,200)}).catch((e) => { logger.debug({ err: e?.message }, 'saveMemory failed'); });
  return { agent: 'chief_evaluator', response: r.content || '暂无评分数据', data: evidence, store };
}
// ── 4. Train Advisor (对标V1: SOP知识库+培训任务+品牌差异化) ──
async function handleTrainAdvisor(text, ctx) {
  const store = ctx.store || '', user = ctx.username || '';
  const brand = store ? await getBrandForStore(store).catch(() => null) : null;
  let kbData = '';
  // 1) HRMS 知识库 PDF 正文：多关键词 OR 检索 + 长文本注入（禁止只依赖「菜单内容」四字匹配）
  try {
    const { parts } = await fetchKnowledgeSnippetsForTrainAdvisor(text, ctx);
    if (parts.length) {
      kbData =
        '\n【系统检索到的知识库原文（来自 HRMS 上传文件提取文本，你必须据此作答）】\n' +
        parts.map((p) => `<<< 文档：${p.title}（id:${p.id}）>>>\n${p.body}`).join('\n\n---\n\n');
    } else {
      kbData =
        '\n【系统检索到的知识库原文】\n（空）未在 knowledge_base 中命中任何与问题相关的 PDF 正文。可能原因：① PDF 为扫描件未提取到文字 ② 上传时未选品牌/正文不含门店所属品牌关键词 ③ 需用「菜单/菜谱/炒锅/开档」等词检索。\n';
    }
  } catch (e) {
    logger.warn({ err: e?.message }, 'train_advisor KB fetch');
    kbData = '\n【系统检索到的知识库原文】\n（查询失败）\n';
  }
  // 2) 培训任务查询 (对标V1)
  let trainingCtx = '';
  if (user) {
    try {
      const tasks = await query(
        `SELECT task_id, type, title, status, due_date, progress_data FROM training_tasks
         WHERE assignee_username = $1 ORDER BY created_at DESC LIMIT 5`, [user]);
      if (tasks.rows?.length) {
        trainingCtx = '\n[用户培训任务]\n' + tasks.rows.map(t =>
          `- [${t.task_id}] ${t.title}(${t.type}) 状态:${t.status} 截止:${t.due_date ? String(t.due_date).slice(0,10) : '无'}`
        ).join('\n');
      }
    } catch (e) { /* training_tasks may not exist */ }
  }
  if (!kbData && !trainingCtx) kbData = '\n[暂无匹配知识库记录]\n';
  // P1：与 data_auditor 对齐，注入 Wiki 磁盘检索 + agent_memory 近期记录（buildExperienceBlock 内已 recall）
  try {
    const expBlock = await buildExperienceBlock({ agent: 'train_advisor', store, query: text });
    if (expBlock && String(expBlock).trim()) {
      kbData += `\n${expBlock.trim()}\n`;
    } else {
      try {
        const mem = await recallMemories('train_advisor', store || '', text.slice(0, 30), 2);
        if (mem.length) kbData += '\n[历史对话摘要] ' + mem.map((m) => m.content.slice(0, 60)).join('; ');
      } catch (e2) { /* ignore */ }
    }
  } catch (e) {
    logger.warn({ err: e?.message }, 'train_advisor buildExperienceBlock skipped');
    try {
      const mem = await recallMemories('train_advisor', store || '', text.slice(0, 30), 2);
      if (mem.length) kbData += '\n[历史对话摘要] ' + mem.map((m) => m.content.slice(0, 60)).join('; ');
    } catch (e2) { /* ignore */ }
  }
  const kbBlockPresent = kbData.includes('<<< 文档：');
  let sysPrompt = (await adminAgentPromptPrefix('train_advisor')) + `【角色定义】
你是餐饮业务顾问，回答必须同时做到两件事：
1. **把文档中的分类框架、数字、对比呈现完整**——不能遗漏干货
2. **让用户读了有收获、能用到**——不丢官样文章

当前时间：${NOW_CN()}。
门店：${store || '未指定'}${brand ? `（${brand}）` : ''}，用户：${ctx.name || user || '未知'}

❌ **严格禁止 — 出现以下任一种即视为不合格回答：**
- 禁止使用【】括起来的标题，如「核心问题」「今日重点动作」「为什么是这个动作」「执行要求」
- 禁止出现「score」「成功率」「趋势 up」等评分类字段
- 禁止出现「谁做：」「什么时候完成：」「如何留痕验收：」这类任务指派的格式
- 禁止编造数据、评分、百分比

✅ **正确做法：**
用自然的分析口吻，把文档内容讲给用户听。可以参考这个结构（但别用【】标题）：
- 先点出文档的核心观点（一句话说清）
- 然后展开具体内容：分类框架、数字对比、操作方法——这些是用户最看重的干货
- 最后结合门店（${store || '该门店'}）情况，给出关注方向的建议

不需要三段式。关键是把文档数据讲全、讲清楚，让用户读完觉得有收获。
${kbData}${trainingCtx}
`;
  const requestSeed = Date.now() + Math.floor(Math.random() * 1000);
  const reinforcedUserText = `请回答：${text}

【输出要求 — 严格遵守】
- 禁止使用【】括起来的标题，禁止出现「核心问题」「今日重点动作」「执行要求」「为什么是这个动作」
- 禁止出现「score」「成功率」「趋势 up」「weightedScore」
- 禁止出现「谁做：」「什么时候完成：」「如何留痕验收：」
- 每次回答应从不同角度切入，同一问题多次问时结构内容都不一样
（querySeed: ${requestSeed}）`;
  const r = await callLLM(
    [{ role: 'system', content: sysPrompt }, { role: 'user', content: reinforcedUserText }],
    {
      temperature: kbBlockPresent ? 0.4 : 0.1,
      max_tokens: kbBlockPresent ? 4096 : 600,
      purpose: 'train_advisor',
      ...(ctx.llmContext ? { context: ctx.llmContext } : {})
    }
  );
  saveMemory('train_advisor', store, (r.content || '').slice(0, 500), { query: text.slice(0, 200) }).catch((e) => { logger.debug({ err: e?.message }, 'saveMemory failed'); });
  // P2: 写入 mempalace（训练回答质量较高时可长久留存）
  if (process.env.ENABLE_MEMPALACE === 'true' && r.content && r.content.length > 100) {
    try {
      const { saveMemory: saveMempalace } = await import('./memory-adapter.js');
      await saveMempalace({
        agent: 'train_advisor',
        store,
        type: 'knowledge',
        content: '用户提问:' + text.slice(0, 200) + '\n回答:' + (r.content || '').slice(0, 2000),
        metadata: { score: kbBlockPresent ? 0.75 : 0.5 }
      });
    } catch (e) { /* fail-soft */ }
  }
  return { agent: 'train_advisor', response: r.content || '请描述培训需求', data: kbData + trainingCtx, store };
}
// ── 5. Appeal (对标V1: 申诉记录入库+扣分核实+公正处理) ──
async function handleAppeal(text, ctx) {
  let appealData = '';
  const store = ctx.store || '', user = ctx.username || '';
  const brand = store ? await getBrandForStore(store).catch(() => null) : null;
  try {
    const [sc, anom, prevAppeals] = await Promise.all([
      query(`SELECT role, total_score, period, summary, updated_at FROM agent_scores
             WHERE (store ILIKE $1 OR username = $2) ORDER BY updated_at DESC LIMIT 3`,
            [`%${store}%`, user]),
      query(`SELECT anomaly_key, severity, trigger_date, trigger_value FROM anomaly_triggers
             WHERE (store ILIKE $1) AND trigger_date >= CURRENT_DATE - INTERVAL '60 days'
             ORDER BY trigger_date DESC LIMIT 10`, [`%${store}%`]),
      query(`SELECT reason, status, created_at FROM agent_appeals
             WHERE username = $1 ORDER BY created_at DESC LIMIT 5`, [user]).catch(() => ({ rows: [] }))
    ]);
    if (sc.rows?.length) {
      appealData += '\n[你的评分记录]\n';
      sc.rows.forEach(r => { appealData += `- ${String(r.period||'').slice(0,24)}: ${r.total_score}分 (${r.role})\n`; });
    }
    if (anom.rows?.length) {
      appealData += '\n[近60天异常扣分项]\n';
      anom.rows.forEach(r => {
        appealData += `- ${String(r.trigger_date||'').slice(0,10)} ${r.anomaly_key}(${r.severity})\n`;
      });
    }
    if (prevAppeals.rows?.length) {
      appealData += '\n[历史申诉记录]\n';
      prevAppeals.rows.forEach(r => { appealData += `- ${String(r.created_at||'').slice(0,10)} 状态:${r.status} 原因:${(r.reason||'').slice(0,50)}\n`; });
    }
  } catch (e) { logger.debug({ err: e?.message }, "query fallback skipped"); }
  if (!appealData) appealData = '\n[暂无评分/扣分记录]';
  // P2: 记忆回调
  try { const mem = await recallMemories('appeal', store, '', 3); if (mem.length) appealData += '\n[历史申诉记忆] ' + mem.map(m => m.content.slice(0,80)).join('; '); } catch(e) {}
  // 统一知识库检索
  let unifiedKnowledgeBlock_appeal = '';
  if (store) {
    try {
      const urResult = await unifiedRetrieve(text, { store, agent: 'appeal', role: ctx.role, limit: 3 });
      if (urResult.parts.length) unifiedKnowledgeBlock_appeal = formatUnifiedRetrievalForPrompt(urResult);
    } catch (e) { /* fail-soft */ }
  }
  let sysPrompt = (await adminAgentPromptPrefix('appeal')) + `【角色定义】
你不是问答助手，你是餐饮企业中的“岗位负责人”（申诉处理岗位）。

【系统上下文】
Planner/Workflow 已拆解为“核实+预计处理路径”。你只负责给出与 KPI/审批闭环兼容的沟通决策与流程说明，不做任何数据库写入。

当前时间：${NOW_CN()}。
门店：${store || '未指定'}${brand ? `（${brand}）` : ''}，用户：${ctx.name || user || '未知'}

【职责】
1. 投诉处理（确认内容→转交核实→保护隐私→给出流程和时间）
2. 申诉处理（确认内容→核实数据→预计处理时间）

【工作准则】
禁止编造任何数据；无确切信息时必须写“暂无此信息”。
注意：下方「系统检索到的知识库」为辅助参考，实际数据才是根本；回答必须优先基于实际数据。

【输出约束】
专业、公正、简短不超300字。
${appealData}
${unifiedKnowledgeBlock_appeal}

`;
  const r = await callLLM([
    { role: 'system', content: sysPrompt },
    { role: 'user', content: text }
  ], { temperature: 0.2, max_tokens: 600, purpose: 'appeal', ...(ctx.llmContext ? { context: ctx.llmContext } : {}) });
  // 对标V1: 申诉记录入库
  try {
    await query(`INSERT INTO agent_appeals (username, reason, status) VALUES ($1, $2, 'pending')`, [user || 'anonymous', text.slice(0, 500)]);
  } catch (e) { /* agent_appeals table may not exist */ }
  saveMemory('appeal', store, (r.content||'').slice(0,500), {query:text.slice(0,200)}).catch((e) => { logger.debug({ err: e?.message }, 'saveMemory failed'); });
  return { agent: 'appeal', response: r.content || '已记录，我们将在24小时内核实并回复。', data: appealData, store, appealRecorded: true };
}
function logStrategyAbTest(ctx, memories, strategyText, score) {
  const ENABLE_MEM = process.env.ENABLE_MEMPALACE === 'true';
  const logData = {
    store: ctx.storeId,
    input: ctx.input,
    used_memory: ENABLE_MEM,
    memory_count: memories.length,
    strategy: strategyText,
    score,
    timestamp: Date.now()
  };
  console.log('[STRATEGY_AB_TEST]', JSON.stringify(logData));
}

/** marketing_planner：无数据或 LLM 失败时的稳定策略正文（禁止再使用「请提供门店信息…」兜底） */
function generateFallbackStrategy(input) {
  const q = String(input || '门店经营').trim();
  return `针对问题「${q}」，提供通用运营策略：

1. 提升客流：
   • 推出限时套餐或引流活动
   • 优化门店展示与招牌菜曝光

2. 提升转化：
   • 设计高性价比组合套餐
   • 强化服务推荐能力

3. 提升复购：
   • 建立会员体系
   • 设置优惠券或积分机制

4. 优化体验：
   • 检查出餐速度
   • 优化高峰期人员安排

（建议结合实际经营数据进一步优化）`;
}

/** LLM 无输出时：仅按引擎策略扩写为门店可读正文，不新增策略项 */
function planTextFromEngineStrategies(engineStrategies, ctx) {
  const q = String(ctx.input || '').trim() || '门店经营';
  const rows = Array.isArray(engineStrategies) ? engineStrategies : [];
  if (!rows.length) return generateFallbackStrategy(q);
  const hasMem = rows.some((x) => x && x.source === 'memory');
  const head = hasMem
    ? '【营销活动计划｜规则引擎输出（含记忆命中项）】'
    : '【营销活动计划｜规则引擎输出（通用项）】';
  const body = rows.map((s, i) => {
    const action = String(s?.action || '').trim();
    const reason = String(s?.reason || '').trim();
    const tag = s?.source === 'memory' ? '【记忆命中】' : '【通用】';
    return `${i + 1}. ${tag}${action}\n   说明：${reason || '—'}\n   执行要点：围绕「${q}」设定时间窗口、负责人（店长/前厅/外卖）、7 日内过程指标（订单/到店/转化），避免空泛口号。`;
  }).join('\n\n');
  return `${head}\n\n${body}\n\n（本段由引擎策略骨架扩写；若大模型可用，可在此基础上润色为成稿。）`;
}

function ensureMarketingStrategyText(raw, ctx) {
  const t = String(raw || '').trim();
  if (!t || /请提供门店信息以制定营销方案/.test(t)) {
    return generateFallbackStrategy(String(ctx.input || '').trim() || '门店经营');
  }
  return t;
}

function logMemoryDecision(resultText) {
  const t = String(resultText || '');
  const usedMemoryInDecision = t.includes('套餐') || t.includes('服务优化');
  console.log('[MEMORY_DECISION]', { usedMemoryInDecision });
}

/** MemPalace：仅 strategy_agent（营销策划）路径使用；不替代 agent_memory */
function scoreStrategyForMemPalace(kind, body) {
  const t = String(body || '');
  if (kind === 'ask') return { score: 0.35, hasOutcome: false };
  if (t.length < 160) return { score: 0.55, hasOutcome: false };
  let score = 0.66;
  const hits = [
    /活动/.test(t),
    /目标|指标|营收|外卖/.test(t),
    /负责|店长|前厅/.test(t),
    t.length > 520
  ].filter(Boolean).length;
  score += hits * 0.04;
  if (kind === 'final') score += 0.05;
  score = Math.min(0.88, Math.round(score * 100) / 100);
  const hasOutcome = kind === 'final' || (kind === 'text' && t.length >= 350 && hits >= 3);
  return { score, hasOutcome };
}

// ── 6. Marketing Planner (营销策划) ──
async function handleMarketingPlanner(text, ctx) {
  const ENABLE_MEM = process.env.ENABLE_MEMPALACE === 'true';
  let mktData = '';
  const store = ctx.store || '';
  const brand = store ? await getBrandForStore(store).catch(() => null) : null;
  const data = {};

  const revSqlMid = `SELECT date, actual_revenue, target_revenue, dine_orders
       FROM daily_reports WHERE store ILIKE $1 AND date >= CURRENT_DATE - 30
       ORDER BY date DESC LIMIT 30`;
  const revSqlFull = `SELECT date, actual_revenue, target_revenue,
              delivery_actual, dine_traffic, dine_orders, efficiency
       FROM daily_reports WHERE store ILIKE $1 AND date >= CURRENT_DATE - 30
       ORDER BY date DESC LIMIT 30`;
  const revSqlMin = `SELECT date, actual_revenue
       FROM daily_reports WHERE store ILIKE $1 AND date >= CURRENT_DATE - 30
       ORDER BY date DESC LIMIT 30`;

  let revRows = [];
  for (const sql of [revSqlMid, revSqlFull, revSqlMin]) {
    try {
      const rev = await query(sql, [`%${store}%`]);
      revRows = rev.rows || [];
      if (revRows.length) data.dailyReportDays = revRows.length;
      break;
    } catch (err) {
      console.warn('[DB_ERROR]', err.message);
      logger.warn({ err: err.message }, 'marketing_planner daily_reports');
    }
  }

  if (revRows.length) {
    const avg = revRows.reduce((s, r) => s + (parseFloat(r.actual_revenue) || 0), 0) / revRows.length;
    const rates = revRows
      .map((r) => {
        const tg = parseFloat(r.target_revenue);
        const ac = parseFloat(r.actual_revenue);
        if (tg > 0) return ac / tg;
        return NaN;
      })
      .filter((x) => !Number.isNaN(x));
    const avgRate = rates.length ? rates.reduce((s, x) => s + x, 0) / rates.length : 0;
    mktData += `【近30天营收数据】日均营收:¥${Math.round(avg)} 平均目标达成率:${(avgRate * 100).toFixed(1)}%`;
    const recent7 = revRows.slice(0, 7);
    mktData += '\n近7天营收: ' + recent7.map((r) => `${String(r.date || '').slice(5, 10)}:¥${r.actual_revenue || 0}`).join(', ');
    const avgTraffic = revRows.reduce((s, r) => s + (parseFloat(r.dine_traffic) || 0), 0) / revRows.length;
    const totalRev = revRows.reduce((s, r) => s + (parseFloat(r.actual_revenue) || 0), 0);
    const delivRev = revRows.reduce((s, r) => s + (parseFloat(r.delivery_actual) || 0), 0);
    if (totalRev > 0 || avgTraffic > 0 || delivRev > 0) {
      mktData += `\n平均日客流:${Math.round(avgTraffic)}人 外卖占比:${totalRev > 0 ? ((delivRev / totalRev) * 100).toFixed(1) : 0}%`;
    }
  }

  try {
    const campaigns = await query(
      `SELECT title, status, start_date, end_date, target_metric, target_value, actual_value
       FROM marketing_campaigns WHERE (store ILIKE $1 OR store IS NULL)
       ORDER BY start_date DESC LIMIT 5`,
      [`%${store}%`]
    );
    if (campaigns.rows?.length) {
      data.campaignRows = campaigns.rows.length;
      mktData += '\n\n【近期营销活动记录】\n' + campaigns.rows.map((c) => {
        const prog = c.actual_value && c.target_value
          ? ` 完成度:${((+c.actual_value / +c.target_value) * 100).toFixed(0)}%` : '';
        const statusLabel = c.status === 'active' ? '进行中' : c.status === 'completed' ? '已完成' : '计划中';
        return `· [${statusLabel}] ${c.title} | ${FMT_DATE(c.start_date)}~${FMT_DATE(c.end_date)}${prog}`;
      }).join('\n');
    } else {
      mktData += '\n\n【近期营销活动】暂无历史活动';
    }
  } catch (err) {
    console.warn('[DB_ERROR]', err.message);
    logger.warn({ err: err.message }, 'marketing_planner campaigns');
    mktData += '\n\n【近期营销活动】读取失败，略过';
  }

  try {
    const reviews = await query(
      `SELECT anomaly_key, COUNT(*)::int as cnt FROM anomaly_triggers
       WHERE store ILIKE $1 AND anomaly_key IN ('product_review','service_review')
       AND trigger_date >= CURRENT_DATE - 30 GROUP BY anomaly_key`,
      [`%${store}%`]
    );
    if (reviews.rows?.length) {
      data.reviewBuckets = reviews.rows.length;
      mktData += '\n【近30天差评】' + reviews.rows.map((r) =>
        `${r.anomaly_key === 'product_review' ? '产品' : '服务'}差评:${r.cnt}次`).join(', ');
    }
  } catch (err) {
    console.warn('[DB_ERROR]', err.message);
    logger.warn({ err: err.message }, 'marketing_planner reviews');
  }

  try {
    const nowSh = new Date().toLocaleString('en-CA', { timeZone: 'Asia/Shanghai' });
    const curMo = nowSh.slice(0, 7);
    const tgt = await query(
      `SELECT target_revenue FROM revenue_targets WHERE store ILIKE $1 AND period = $2 LIMIT 1`,
      [`%${store}%`, curMo]
    );
    if (tgt.rows?.[0]) {
      data.monthlyTarget = true;
      mktData += `\n【本月营收目标】¥${tgt.rows[0].target_revenue}`;
    }
  } catch (err) {
    console.warn('[DB_ERROR]', err.message);
    logger.warn({ err: err.message }, 'marketing_planner revenue_targets');
  }

  try {
    const interactionMemories = await recallMemories('marketing_planner', store, '', 3);
    if (interactionMemories.length) {
      mktData += '\n\n【历史方案记录】\n' + interactionMemories.map((m) =>
        `${String(m.created_at || '').slice(0, 10)}: ${m.content.slice(0, 120)}`).join('\n');
    }
  } catch (err) {
    console.warn('[DB_ERROR]', err.message);
    logger.warn({ err: err.message }, 'marketing_planner recallMemories');
  }

  if (!mktData.trim()) {
    mktData = '【弱数据模式】门店侧日报字段不可用或未拉取到数据。请仍输出可执行营销方案（含≥3条活动），禁止仅回答「无数据」或拒答。';
  }

  // 统一知识库检索（P0: marketing_planner 也能访问知识库 + wiki + mempalace）
  let unifiedKnowledgeBlock_mkt = '';
  if (store) {
    try {
      const urResult = await unifiedRetrieve(text, { store, agent: 'marketing_planner', role: ctx.role, limit: 4 });
      if (urResult.parts.length) unifiedKnowledgeBlock_mkt = formatUnifiedRetrievalForPrompt(urResult);
    } catch (e) { /* fail-soft */ }
  }

  const hasData = data && Object.keys(data).length > 0;

  const storeKey = String(ctx.storeId || ctx.store || store || '').trim();
  let memPalaceRows = [];
  if (ENABLE_MEM) {
    memPalaceRows = await recallMemPalaceMemory({
      agent: 'strategy_agent',
      store: storeKey,
      query: String(ctx.problem || ctx.input || text || '').trim(),
      limit: 5
    });
  }
  const engineMemories = ENABLE_MEM ? memPalaceRows : [];
  const engineStrategies = decideStrategy({
    input: String(ctx.input || text || ''),
    memories: engineMemories
  });
  console.log('[ENGINE_STRATEGY]', engineStrategies);

  // 会话支持：如果有现有会话，增强提示词
  const sessionPrompt = ctx.isFollowUp && ctx.session
    ? `\n\n【会话上下文】\n这是第 ${ctx.session.question_round || 1} 轮对话。`
    + (ctx.session.context ? `\n${JSON.stringify(ctx.session.context)}` : '')
    + (ctx.session.pending_question ? `\n【待处理问题】${ctx.session.pending_question}` : '')
    : '';

  const sysPrompt =
    (await adminAgentPromptPrefix('marketing_planner')) +
    `你是餐饮运营专家，请将以下策略扩写为完整方案。
注意：下方「系统检索到的知识库」为辅助参考，实际经营数据才是根本；必须优先基于门店实际数据回答。

当前时间：${NOW_CN()}。门店：${store || '未指定'}${brand ? `（${brand}）` : ''}。
${sessionPrompt}

【门店数据摘要】（扩写时可引用其中数字，禁止整段抄成营收日报）
${mktData}

${unifiedKnowledgeBlock_mkt}
策略列表（已由系统决策引擎生成，须保留各条 action 的核心措施，不得替换为无关策略）：
${JSON.stringify(engineStrategies, null, 2)}

要求：
1. 每条策略写成完整可执行方案（目标、动作、衡量、负责人/时间窗口等）
2. 保留策略核心，不要改变策略内容（尤其 action 中的关键表述）
3. 可以增加执行细节，但不能发明与上表无关的新策略
4. 若关键信息不足，仅可输出：{"type":"ask","question":"..."}；否则输出完整中文正文（不要用 JSON 包裹全文方案）
5. 语气专业、可交给门店直接执行`;

  const plannerTemp = 0.42;
  const r = await callLLM([
    { role: 'system', content: sysPrompt },
    { role: 'user', content: text }
  ], { temperature: plannerTemp, max_tokens: 2400, purpose: 'marketing_planner', ...(ctx.llmContext ? { context: ctx.llmContext } : {}) });

  let rawContent = String(r.content || '').trim();
  if (!rawContent) {
    console.warn('[MARKETING_PLANNER]', 'LLM empty; using engine expansion for user-visible plan');
    rawContent = planTextFromEngineStrategies(engineStrategies, ctx);
  }

  console.log('[STRATEGY_DEBUG]', {
    hasData,
    fallback: !hasData,
    input: ctx.input
  });

  // 检查是否为 ask/final 格式的 JSON 响应（避免贪婪正则误吞多段 JSON）
  let parsedMarketing = null;
  const rawTrim = String(rawContent || '').trim();
  const unfenced = rawTrim.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/m, '').trim();
  for (const candidate of [unfenced, rawTrim]) {
    if (!candidate) continue;
    try {
      parsedMarketing = JSON.parse(candidate);
      break;
    } catch (_) {
      const blob = extractFirstBalancedJsonObject(candidate);
      if (blob) {
        try {
          parsedMarketing = JSON.parse(blob);
          break;
        } catch (_) { /* continue */ }
      }
    }
  }

  if (parsedMarketing && typeof parsedMarketing === 'object') {
    if (parsedMarketing.type === 'ask' && parsedMarketing.question) {
      let q = decodeJsonStringEscapesForFeishu(String(parsedMarketing.question).trim());
      q = ensureMarketingStrategyText(q, ctx);
      const askScore = scoreStrategyForMemPalace('ask', q).score || 0.6;
      logStrategyAbTest(ctx, memPalaceRows, q, askScore);
      logMemoryDecision(q);
      saveMemory('marketing_planner', store, `Asked: ${q}`, { query: text.slice(0, 200) }).catch((e) => { logger.debug({ err: e?.message }, 'saveMemory failed'); });
      return {
        agent: 'marketing_planner',
        response: q,
        text: q,
        score: askScore || 0.6,
        store,
        data: mktData,
        reportTitle: '营销方案询问',
        dataBacked: true,
        responseType: 'ask',
        question: q,
      };
    }
    if (parsedMarketing.type === 'final' && parsedMarketing.answer != null && parsedMarketing.answer !== '') {
      let answerText = decodeJsonStringEscapesForFeishu(
        stripJsonFromResponse(String(parsedMarketing.answer).trim())
      );
      if (answerText) {
        answerText = ensureMarketingStrategyText(answerText, ctx);
        saveMemory('marketing_planner', store, answerText.slice(0, 500), { query: text.slice(0, 200) }).catch((e) => { logger.debug({ err: e?.message }, 'saveMemory failed'); });
        const { score, hasOutcome } = scoreStrategyForMemPalace('final', answerText);
        const outScore = score || 0.6;
        logStrategyAbTest(ctx, memPalaceRows, answerText, outScore);
        logMemoryDecision(answerText);
        if (ENABLE_MEM && score >= 0.7 && hasOutcome) {
          await saveMemPalaceMemory({
            agent: 'strategy_agent',
            store: storeKey,
            type: 'strategy',
            content: answerText.slice(0, 8000),
            metadata: { score }
          });
        }
        return {
          agent: 'marketing_planner',
          response: answerText,
          text: answerText,
          score: outScore,
          store,
          data: mktData,
          reportTitle: '营销活动计划',
          dataBacked: true,
          responseType: 'final',
        };
      }
    }
  }

  // 普通文本响应（兼容旧逻辑）
  let responseText = decodeJsonStringEscapesForFeishu(stripJsonFromResponse(rawContent));
  responseText = ensureMarketingStrategyText(responseText, ctx);
  saveMemory('marketing_planner', store, responseText.slice(0, 500), { query: text.slice(0, 200) }).catch((e) => { logger.debug({ err: e?.message }, 'saveMemory failed'); });
  const { score: textScore, hasOutcome: textOutcome } = scoreStrategyForMemPalace('text', responseText);
  const textOutScore = textScore || 0.6;
  logStrategyAbTest(ctx, memPalaceRows, responseText, textOutScore);
  logMemoryDecision(responseText);
  if (ENABLE_MEM && textScore >= 0.7 && textOutcome) {
    await saveMemPalaceMemory({
      agent: 'strategy_agent',
      store: storeKey,
      type: 'strategy',
      content: responseText.slice(0, 8000),
      metadata: { score: textScore }
    });
  }
  return {
    agent: 'marketing_planner',
    response: responseText,
    text: responseText,
    score: textOutScore,
    store,
    data: mktData,
    reportTitle: '营销活动计划',
    dataBacked: true,
  };
}
// ── 7. Marketing Executor (营销执行) ──
async function handleMarketingExecutor(text, ctx) {
  let execData = '';
  const store = ctx.store || '';
  const brand = store ? await getBrandForStore(store).catch(() => null) : null;

  try {
    const camps = await query(
      `SELECT id, title, status, start_date, end_date, target_metric, target_value,
              actual_value, budget_amount, spent_amount
       FROM marketing_campaigns WHERE (store ILIKE $1 OR store IS NULL)
       ORDER BY start_date DESC LIMIT 10`,
      [`%${store}%`]);
    if (camps.rows?.length) {
      execData += '【营销活动执行清单】\n' + camps.rows.map(c => {
        const prog = c.actual_value && c.target_value
          ? `${((+c.actual_value / +c.target_value)*100).toFixed(0)}%` : '未录入';
        const budgetUsed = c.spent_amount && c.budget_amount
          ? `${((+c.spent_amount / +c.budget_amount)*100).toFixed(0)}%` : 'N/A';
        const statusLabel2 = c.status === 'active' ? '进行中' : c.status === 'completed' ? '已完成' : '计划中';
        return `· [${statusLabel2}] ${c.title} | ${FMT_DATE(c.start_date)}~${FMT_DATE(c.end_date)} | 完成度:${prog} | 预算使用:${budgetUsed}`;
      }).join('\n');
    } else { execData += '【营销活动执行清单】暂无活动数据'; }
    const rev = await query(
      `SELECT date, actual_revenue, dine_traffic, delivery_actual
       FROM daily_reports WHERE store ILIKE $1 AND date >= CURRENT_DATE - 7
       ORDER BY date DESC LIMIT 7`, [`%${store}%`]);
    if (rev.rows?.length) {
      execData += '\n\n【近7天营业实绩】\n' + rev.rows.map(r =>
        `${String(r.date||'').slice(5,10)}: 营收¥${r.actual_revenue||0} 堂食${r.dine_traffic||0}人 外卖¥${r.delivery_actual||0}`
      ).join('\n');
    }
    const tasks = await query(
      `SELECT title, status FROM master_tasks
       WHERE store ILIKE $1 AND (title ILIKE '%营销%' OR title ILIKE '%活动%')
       ORDER BY created_at DESC LIMIT 5`, [`%${store}%`]);
    if (tasks.rows?.length) execData += '\n\n【营销相关任务】\n' + tasks.rows.map(t => `· [${t.status}] ${t.title}`).join('\n');
  } catch (e) { logger.warn({ err: e?.message }, 'marketing_executor data'); }

  if (!execData) execData = '暂无营销活动数据';

  // 统一知识库检索（P0）
  let unifiedKnowledgeBlock_exec = '';
  if (store) {
    try {
      const urResult = await unifiedRetrieve(text, { store, agent: 'marketing_executor', role: ctx.role, limit: 3 });
      if (urResult.parts.length) unifiedKnowledgeBlock_exec = formatUnifiedRetrievalForPrompt(urResult);
    } catch (e) { /* fail-soft */ }
  }

  const sysPrompt =
    (await adminAgentPromptPrefix('marketing_executor')) +
    `你是餐饮连锁的营销执行跟踪员。当前时间：${NOW_CN()}。门店：${store || '未指定'}${brand ? `（${brand}）` : ''}。

【你的唯一职责】
追踪、评估已有营销活动的执行结果。你不制定新方案，不提出新活动创意。
注意：下方「系统检索到的知识库」为辅助参考，实际经营数据才是根本；必须优先基于门店实际数据回答。

【真实执行数据】
${execData}

${unifiedKnowledgeBlock_exec}
【如何撰写每个部分】

▶ 【执行进度评估】
- 逐条列出每个活动：名称、状态（进行中/已结束/计划中）、时间段、目标
- 如果 actual_value 已填入，计算完成率 = actual / target × 100%
- 如果 actual_value 为空且活动已结束（end_date 已过），明确说明"实际结果未录入系统，需要店长补录"

▶ 【营收数据验证】
- 用近7天实绩（营收、客流、外卖）与活动期间对比
- 判断活动期间营收是否有明显变化（上升/持平/下滑）
- 这是在没有 actual_value 时的辅助判断，不是规划新活动

▶ 【待完成的执行动作】
- 只写已有活动"还差什么没做完"的具体待办
- 例如：补录实际结果、未完成的线下执行动作、预算对账
- 禁止在此处规划全新活动或提出新营销方向

【严格输出约束】
- 纯中文自然语言，禁止 JSON、代码块
- 不得建议开展新活动；如需制定新方案请引导用户发"帮我制定营销方案"
- 结构严格按照：【执行进度评估】→【营收数据验证】→【待完成的执行动作】`;

  const r = await callLLM([
    { role: 'system', content: sysPrompt },
    { role: 'user', content: text }
  ], { temperature: 0.4, max_tokens: 800, purpose: 'marketing_executor', ...(ctx.llmContext ? { context: ctx.llmContext } : {}) });

  const responseText = stripJsonFromResponse(r.content || '请描述营销执行需求，系统将查询真实活动数据。');
  saveMemory('marketing_executor', store, responseText.slice(0, 500), { query: text.slice(0, 200) }).catch((e) => { logger.debug({ err: e?.message }, 'saveMemory failed'); });
  const baseReturn = {
    agent: 'marketing_executor',
    response: responseText,
    store,
    data: execData,
    reportTitle: '营销执行报告',
    dataBacked: true
  };
  console.log('🚀 [BEFORE MERGE RETURN]');
  return await mergeReportWithDataAuditorDecision(baseReturn, text, ctx);
}
// ── 8. Procurement Advisor (采购建议) ──
async function handleProcurementAdvisor(text, ctx) {
  const store = ctx.store || '';
  if (!store) {
    return { agent: 'procurement_advisor', response: '请提供门店名称以便生成采购建议。' };
  }
  const advice = await generateProcurementAdvice(store);
  let resp = `## 采购建议 - ${store}\n\n**${advice.summary || ''}**\n\n`;
  if (advice.suggestions?.length) {
    resp += advice.suggestions.map((s, i) => `${i + 1}. **${s.category}**: ${s.action === 'increase' ? '↑增加' : s.action === 'decrease' ? '↓减少' : '→维持'} — ${s.reason}${s.estimated_saving ? ` (预估节省¥${s.estimated_saving})` : ''}`).join('\n');
  }
  if (advice.warnings?.length) resp += '\n\n⚠️ ' + advice.warnings.join('\n⚠️ ');
  resp += `\n\n_下次复查: ${advice.next_review_days || 7}天后_`;
  saveMemory('procurement_advisor', store, (resp||'').slice(0,500), {query:text.slice(0,200)}).catch((e) => { logger.debug({ err: e?.message }, 'saveMemory failed'); });
  return { agent: 'procurement_advisor', response: resp, data: advice, store };
}

// ── 9. Master Agent (对标V1: 调度中枢+活跃任务上下文) ──
async function handleMaster(t, c) {
  const store = c.store || '';
  const brand = store ? await getBrandForStore(store).catch(() => null) : null;
  const memories = [];
  try {
    const mem = await recallMemories('master', store, '', 3);
    if (mem.length) memories.push('\n[历史记录]\n' + mem.map(m => m.content.slice(0,100)).join('\n'));
  } catch(e) { /* silent */ }
  let taskCtx = '';
  if (store) {
    try {
      const pats = feishuStoreSearchPatterns(store);
      const username = String(c.username || '').trim();
      const role = String(c.role || '').trim();
      const hq = role === 'admin' || role === 'hq_manager';
      let tasks;
      if (hq) {
        tasks = await query(
          `SELECT title, status, severity, current_agent AS agent FROM master_tasks
           WHERE store ILIKE ANY($1::text[]) AND status NOT IN ('resolved','settled','cancelled')
           ORDER BY created_at DESC LIMIT 5`,
          [pats]
        );
      } else if (username || role) {
        tasks = await query(
          `SELECT title, status, severity, current_agent AS agent FROM master_tasks
           WHERE store ILIKE ANY($1::text[]) AND status NOT IN ('resolved','settled','cancelled')
             AND (
               (COALESCE(TRIM(assignee_username),'') <> '' AND LOWER(assignee_username) = LOWER($2))
               OR (COALESCE(TRIM(assignee_username),'') = '' AND $3 <> '' AND assignee_role = $3)
             )
           ORDER BY created_at DESC LIMIT 5`,
          [pats, username, role]
        );
      } else {
        tasks = { rows: [] };
      }
      if (tasks.rows?.length) {
        taskCtx = '\n[活跃任务]\n' + tasks.rows.map(t => `- ${t.title}(${t.status}/${t.severity}) → ${t.agent||'未分配'}`).join('\n');
      }
    } catch(e) { /* silent */ }
  }
  // 统一知识库检索（P0: master 也能访问知识库 + wiki + mempalace）
  let unifiedKnowledgeBlock_master = '';
  if (store) {
    try {
      const urResult = await unifiedRetrieve(t, { store, agent: 'master', role: c.role, limit: 3 });
      if (urResult.parts.length) unifiedKnowledgeBlock_master = formatUnifiedRetrievalForPrompt(urResult);
    } catch (e) { /* fail-soft */ }
  }
  let sysPrompt = (await adminAgentPromptPrefix('master')) + `【角色定义】
你不是问答助手，你是餐饮企业中的「岗位负责人」（调度中枢岗位）。

【系统上下文】
你处在 AI 运营系统的汇聚决策阶段：上游已拆解目标并完成模型路由；关键指标与审批在下游执行。
你只负责把用户需求转译成「下一步建议 / 需要补充的信息」，并给出最小可执行回答。

【语言（强制）】
回复必须全部为简体中文；禁止输出英文段落、英文小标题、自检清单（如 Role / Constraint / Step / Check）、以及任何推理过程。

【工作准则】
严格禁止编造任何数据；无确切数据必须给出“这个信息我暂时无法查到，建议联系HR或查看系统”。
注意：下方「系统检索到的知识库」为辅助参考，实际数据才是根本；回答必须优先基于实际数据。

当前时间：${NOW_CN()}。
门店：${store || '未指定'}${brand ? `（${brand}）` : ''}，用户：${c.name || c.username || '未知'}（${c.role === 'store_manager' ? '店长' : c.role === 'store_production_manager' ? '出品经理' : c.role || '员工'}）

【你可以帮助】
数据审计、营运检查、绩效查询、SOP咨询、申诉处理、营销活动规划引导。

【输出约束】
${unifiedKnowledgeBlock_master}
回复极简不超200字，优先给出可执行的下一步要点，禁止输出 JSON。${memories.join('')}${taskCtx}
`;
  const r = await callLLM([{ role: 'system', content: sysPrompt }, { role: 'user', content: t }],
    { temperature: 0.1, max_tokens: 600, purpose: 'master', ...(c.llmContext ? { context: c.llmContext } : {}) });
  saveMemory('master', store, (r.content||'').slice(0,500), {query:t.slice(0,200)}).catch((e) => { logger.debug({ err: e?.message }, 'saveMemory failed'); });
  return { agent: 'master', response: r.content || '您好，请描述您的需求。', store };
}
/** 从文本中提取第一个花括号平衡的 JSON 对象（忽略字符串内的括号）。 */
function extractFirstBalancedJsonObject(s) {
  const str = String(s || '');
  const start = str.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < str.length; i++) {
    const ch = str[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (inString) {
      if (ch === '\\') escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return str.slice(start, i + 1);
    }
  }
  return null;
}

/** 模型偶发把 JSON 转义序列当字面量输出到字符串里，飞书上会显示成 \\n；解析后做一次还原。 */
function decodeJsonStringEscapesForFeishu(s) {
  if (s == null || typeof s !== 'string') return s;
  return s
    .replace(/\\r\\n/g, '\n')
    .replace(/\\n/g, '\n')
    .replace(/\\t/g, '\t')
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, '\\');
}

/**
 * 从 LLM 响应中清除意外输出的 JSON 块，确保飞书消息只含自然语言。
 * 与 master-planner.js 的同名函数保持一致。
 */
function stripJsonFromResponse(text) {
  if (!text) return text;
  const marker = '\u300c\u7ed9\u7528\u6237\u7684\u7ed3\u8bba\u300d'; // noop, use direct string
  const mIdx = text.indexOf('【给用户的结论】');
  if (mIdx !== -1) return text.slice(mIdx + 8).trim();
  // 去除独立的 JSON 对象块（含关键字段名）
  let cleaned = text.replace(/\{[\s\S]*?"(?:summary|problems|actions|needs_task|needs_approval)"[\s\S]*?\}/g, '').trim();
  // 去除【结构化输出/决策】之后的所有内容
  cleaned = cleaned.replace(/【结构化(?:输出|决策)】[\s\S]*$/g, '').trim();
  return cleaned || text;
}

// ── 10. Accept Action Plan（接受行动计划 → 转化为追踪任务）──
async function handleAcceptActionPlan(text, ctx) {
  const store = ctx.store || '';
  if (!store) {
    return { agent: 'data_auditor', response: '请先告知门店名称，再接受行动计划。' };
  }

  // 从 agent_memory 中读取最近一条 __action_plan__ 记录
  let actionPlanText = '';
  try {
    const mem = await recallMemories('data_auditor', store, '__action_plan__', 5);
    const planMem = mem.find(m => String(m.content || '').startsWith('__action_plan__'));
    if (planMem) {
      actionPlanText = String(planMem.content || '').replace('__action_plan__\n', '').trim();
    }
  } catch (_) {}

  if (!actionPlanText) {
    return {
      agent: 'accept_action_plan',
      response: '暂未找到可接受的行动计划。请先发送经营分析请求（例如：「分析一下最近生意下降的原因和建议」），系统生成建议后再回复【接受行动计划】。',
      data: 'no_plan_found'
    };
  }

  // 解析行动建议（按编号行分割）
  const actionLines = actionPlanText
    .split('\n')
    .filter(l => /^\d+[\.\、]/.test(l.trim()))
    .map(l => l.trim());

  if (!actionLines.length) {
    return { agent: 'data_auditor', response: '未能解析行动建议条目，请重新发送分析请求。' };
  }

  const brand = (await getBrandForStore(store).catch(() => null)) || '';
  const nowStr = new Date().toLocaleString('en-CA', { timeZone: 'Asia/Shanghai' }).slice(0, 10);
  const createdTasks = [];

  for (let i = 0; i < Math.min(actionLines.length, 5); i++) {
    const line = actionLines[i];
    const title = `${store} · 行动任务${i + 1}：${line.slice(0, 60)}`;
    const timeoutAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 默认7天

    // 推断负责人角色
    const isProductionTask = /(出品|厨房|后厨|食材|菜品|出品经理)/.test(line);
    const assigneeRole = isProductionTask ? 'store_production_manager' : 'store_manager';

    // 同店同角色可能多名员工：每人一条任务；taskId 必须唯一（否则 ON CONFLICT 会吞掉后续插入）
    const staffR = await query(
      `SELECT username, role FROM feishu_users WHERE registered = true AND store = $1 AND role = $2`,
      [store, assigneeRole]
    ).catch(() => ({ rows: [] }));

    if (!staffR.rows?.length) {
      logger.warn({ store, assigneeRole }, 'auto-collab: no staff found for action plan line');
      continue;
    }

    let staffSeq = 0;
    for (const staff of staffR.rows) {
      const assigneeUsername = String(staff.username || '').trim();
      const assigneeRoleValue = staff.role || assigneeRole;
      staffSeq += 1;
      const userSlug = assigneeUsername.replace(/[^a-zA-Z0-9]/g, '').slice(0, 24) || `u${staffSeq}`;
      const taskId = `ACT-${nowStr.replace(/-/g, '')}-${String(i + 1).padStart(2, '0')}-${userSlug}`;

      await query(
        `INSERT INTO master_tasks
           (task_id, status, source, category, store, brand, assignee_username, assignee_role,
            title, detail, source_data, feishu_msg_ids, dispatched_at, timeout_at, remind_count)
         VALUES
           ($1, 'pending_response', 'auto_collab', 'action_plan', $2, $3, $4, $5,
            $6, $7, $8::jsonb, '[]'::jsonb, NOW(), $9, 0)
         ON CONFLICT (task_id) DO NOTHING`,
        [
          taskId,
          store,
          brand,
          assigneeUsername,
          assigneeRoleValue,
          title,
          `来源：经营分析行动计划\n原始建议：${line}\n创建时间：${nowStr}`,
          JSON.stringify({ source: 'action_plan', originalLine: line }),
          timeoutAt.toISOString()
        ]
      ).catch((e) => { logger.debug({ err: e?.message }, 'saveMemory failed'); });

      createdTasks.push({
        taskId,
        title: line.slice(0, 50),
        role: assigneeRoleValue,
        assigneeUsername
      });
    }
  }

  // 永久存档到决策日志
  const decisionTitle = `行动计划 ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }).slice(0, 10)}`;
  const decisionContent = createdTasks.map((t, i) => `${i + 1}. ${t.title}`).join('；');
  await logDecision({
    store, brand: brand || '', decisionType: 'action_plan',
    title: decisionTitle, content: actionPlanText.slice(0, 500),
    agent: 'accept_action_plan'
  }).catch((e) => { logger.debug({ err: e?.message }, 'saveMemory failed'); });

  const lines = [
    `✅ **行动计划已接受，已创建 ${createdTasks.length} 个追踪任务：**`,
    '',
    ...createdTasks.map(
      (t, i) =>
        `${i + 1}. ${t.taskId} — ${t.title}（${t.assigneeUsername ? `${t.assigneeUsername} · ` : ''}${
          t.role === 'store_production_manager' ? '出品经理' : '店长'
        }）`
    ),
    '',
    '📌 系统将定期追踪进度：',
    '· 超过时限未完成 → 发送催办提醒',
    '· 完成后请回复任务卡片以关闭任务',
    '',
    `📋 已写入门店决策日志，下次经营分析时 Agent 会主动引用此决策记录。`
  ];

  return {
    agent: 'accept_action_plan',
    response: lines.join('\n'),
    store,
    reportTitle: '行动任务创建确认',
    dataBacked: true,
    data: 'action_plan_accepted'
  };
}

const AGENT_SKILLS = Object.freeze({
  data_auditor: {
    name: '数据审计',
    skills: [
      { id: 'sales_detail_analysis', name: '菜品销售分析', desc: '菜品/时段/堂食外卖/毛利率/产品结构分析(sales_raw)', trigger: '菜品|产品结构|销售排行|时段|毛利率|成本库' },
      { id: 'margin_estimate', name: '毛利估算', desc: '基于销售明细与成本库的毛利率估算', trigger: '毛利估算|预估毛利|销售成本' },
      { id: 'month_comparison', name: '经营月报(月度对比)', desc: '跨月营收/毛利/人效对比 + LLM行动建议', trigger: '上个月|上月|对比|比较|下滑|趋势|环比|同比' },
      { id: 'revenue_analysis', name: '营收分析', desc: '日均/达成率/近7天营收汇总(日报确定性)', trigger: '营收|营业额|实收|生意|经营' },
      { id: 'table_visit', name: '桌访热点', desc: '桌访记录与反馈汇总', trigger: '桌访|桌数|桌访情况' },
      { id: 'bad_review', name: '差评报告', desc: '产品/服务差评统计', trigger: '差评|投诉|点评' },
      { id: 'meeting_report', name: '例会报告', desc: '例会/会议数据汇总', trigger: '例会|会议' },
      { id: 'material_report', name: '原料收货报告', desc: '原料采购收货异常分析', trigger: '原料|收货|进货|采购' },
      { id: 'metric_tree', name: '指标树分析', desc: '指标库匹配 + 根因下钻(revenue/margin/labor等)', trigger: '指标|达成率|人效|客流' },
      { id: 'llm_decision', name: 'LLM决策分析', desc: 'LLM综合分析(注入SOP+策略+经验)', trigger: '原因|为什么|建议|怎么办|行动' },
      { id: 'action_plan', name: '行动计划', desc: '将分析建议转化为可追踪的master_tasks', trigger: '接受行动计划' }
    ]
  },
  ops_supervisor: {
    name: '运营督导',
    skills: [
      { id: 'opening_submission', name: '开档提交情况', desc: '谁没开档/缺失记录统计', trigger: '开档|谁没开档|开档提交' },
      { id: 'closing_submission', name: '收档提交情况', desc: '谁没收档/缺失记录统计', trigger: '谁没收档|收档提交|收档缺失' },
      { id: 'closing_detail', name: '收档详情', desc: '各档口得分与异常明细', trigger: '收档|收市|闭档|昨天收档' },
      { id: 'ops_analysis', name: '运营综合分析', desc: '日报+巡检+异常+任务数据综合LLM分析', trigger: '生意|营业|人效|客流|效率|运营' }
    ]
  },
  chief_evaluator: {
    name: '绩效考核',
    skills: [
      { id: 'score_query', name: '绩效评分查询', desc: '门店/员工历史评分查询', trigger: '绩效|评分|考核|分数' },
      { id: 'grade_explain', name: '评级说明', desc: 'A/B/C/D等级标准与奖金规则', trigger: '等级|A级|B级|奖金|工资' },
      { id: 'deduction_detail', name: '扣分明细', desc: '异常扣分项与日期查询', trigger: '扣分|扣了|减分' },
      { id: 'improve_suggest', name: '绩效改善建议', desc: '基于扣分记录的改善方向', trigger: '改善|提高|怎么提升' }
    ]
  },
  train_advisor: {
    name: '培训顾问',
    skills: [
      { id: 'kb_search', name: '知识库检索', desc: 'PDF知识库全文检索(菜单/SOP/流程)', trigger: '菜单|SOP|流程|操作|标准|指引' },
      { id: 'training_tasks', name: '培训任务查询', desc: '用户培训任务进度查询', trigger: '培训|学习|任务' }
    ]
  },
  appeal: {
    name: '申诉处理',
    skills: [
      { id: 'appeal_filing', name: '申诉受理', desc: '核实评分/扣分记录,提交申诉', trigger: '申诉|不公平|不认可|投诉' },
      { id: 'appeal_history', name: '历史申诉查询', desc: '用户历史申诉记录查询', trigger: '之前申诉|申诉记录|上次' }
    ]
  },
  marketing_planner: {
    name: '营销策划',
    skills: [
      { id: 'mkt_strategy', name: '营销方案制定', desc: '基于营收/差评/客流数据生成营销策略', trigger: '营销|方案|活动计划|促销' },
      { id: 'mkt_data_analysis', name: '营销数据概览', desc: '近30天营收/差评/活动数据汇总', trigger: '营销数据|活动效果' }
    ]
  },
  marketing_executor: {
    name: '营销执行',
    skills: [
      { id: 'mkt_progress', name: '活动执行跟踪', desc: '营销活动进度/完成度/预算使用追踪', trigger: '活动进度|执行情况|完成度' },
      { id: 'mkt_verify', name: '营收验证', desc: '活动期间营收对比验证', trigger: '活动效果|效果验证|ROI' }
    ]
  },
  procurement_advisor: {
    name: '采购建议',
    skills: [
      { id: 'procurement_advice', name: '采购增减建议', desc: '基于销售/库存数据的采购调整建议', trigger: '采购|进货|备货|库存' }
    ]
  },
  master: {
    name: 'Master调度中枢',
    skills: [
      { id: 'general_dispatch', name: '通用调度', desc: '路由未分类请求,给出下一步建议', trigger: '(兜底)' },
      { id: 'task_context', name: '任务上下文', desc: '活跃任务查询与状态追踪', trigger: '任务|进度|状态' }
    ]
  }
});

const HANDLERS={data_auditor:handleDataAuditor,ops_supervisor:handleOpsSupervisor,chief_evaluator:handleChiefEvaluator,train_advisor:handleTrainAdvisor,appeal:handleAppeal,marketing_planner:handleMarketingPlanner,marketing_executor:handleMarketingExecutor,procurement_advisor:handleProcurementAdvisor,marketing:handleMarketingPlanner,food_quality:handleOpsSupervisor,master:handleMaster,accept_action_plan:handleAcceptActionPlan};

/**
 * 处理 Proactive 触发
 * 根据异常类型分发给对应的 Agent 进行分析
 * @param {Object} ctx - 触发上下文
 * @param {string} ctx.type - 异常类型
 * @param {string} ctx.store - 门店名称
 * @param {string} ctx.severity - 严重程度
 * @param {Object} ctx.data - 异常数据
 */
export async function handleTrigger(ctx) {
  const { type, store, severity, data } = ctx;

  console.log(`[Proactive Trigger] Type: ${type}, Store: ${store}, Severity: ${severity}`);

  try {
    // 根据异常类型串行调用对应的 Agent
    if (type === 'revenue_drop' || type === 'revenue') {
      // 营收异常：分发给数据审计、运营督导、营销策划
      await dispatchToAgent('data_auditor', `分析营收下降 - ${store}`, ctx);
      await dispatchToAgent('ops_supervisor', `检查运营问题 - ${store}`, ctx);
      await dispatchToAgent('marketing_planner', `制定提升方案 - ${store}`, ctx);

    } else if (type === 'bad_review_spike' || type === 'bad_review_service' || type === 'bad_review_product') {
      // 差评异常：分发给食安质检、运营督导
      await dispatchToAgent('food_quality', `分析差评问题 - ${store}`, ctx);
      await dispatchToAgent('ops_supervisor', `检查服务问题 - ${store}`, ctx);

    } else if (type === 'gross_margin') {
      // 毛利率异常：分发给数据审计、采购顾问
      await dispatchToAgent('data_auditor', `分析毛利率异常 - ${store}`, ctx);
      await dispatchToAgent('procurement_advisor', `检查采购成本 - ${store}`, ctx);

    } else if (type === 'labor') {
      // 人工成本异常：分发给运营督导、数据审计
      await dispatchToAgent('ops_supervisor', `分析人工成本 - ${store}`, ctx);
      await dispatchToAgent('data_auditor', `检查人工数据 - ${store}`, ctx);

    } else if (type === 'traffic') {
      // 客流异常：分发给营销策划、运营督导
      await dispatchToAgent('marketing_planner', `分析客流下降 - ${store}`, ctx);
      await dispatchToAgent('ops_supervisor', `检查运营状况 - ${store}`, ctx);

    } else {
      // 其他异常：默认分发给数据审计
      await dispatchToAgent('data_auditor', `分析异常: ${type} - ${store}`, ctx);
    }

    console.log(`[Proactive Trigger] Completed: ${type} at ${store}`);

  } catch (err) {
    console.error(`[Proactive Trigger] Error: ${err.message}`);
    // 不抛出错误，避免阻塞主流程
  }
}
export async function dispatchToAgent(route,text,ctx={}) {
  const h = HANDLERS[route] || HANDLERS.master;
  const t0 = Date.now();
  try {
    const r = await h(text, ctx);
    r.latencyMs = Date.now() - t0;
    // 全局 JSON 清洗：确保任何 handler 的 LLM 响应都不会把 JSON 发到飞书
    if (r.response && typeof r.response === 'string') {
      r.response = stripJsonFromResponse(r.response);
      r.response = sanitizeUserFacingLlmText(r.response, { allowLeadingJson: false });
    }
    return r;
  } catch (e) {
    return { agent: route, response: '出错请重试', error: e?.message };
  }
}

/**
 * 报告类输出后追加 data_auditor 决策（含【今日重点动作】等）。
 * 防循环：ctx.__fromReport 为真时不二次调用；仅当问题含 执行/效果/策略/报告 时触发。
 * @param {Record<string, unknown>} originalReturn
 * @param {string} text
 * @param {Record<string, unknown>} ctx
 */
/** 验证完成后改为 false，仅当用户句中含 执行|效果|策略|报告 时合并 data_auditor */
const MERGE_DECISION_ALWAYS_FOR_MARKETING_REPORT = true;

async function mergeReportWithDataAuditorDecision(originalReturn, text, ctx) {
  console.log('🔥 [MERGE ENTER]', {
    text,
    hasFromReport: ctx?.__fromReport
  });
  if (!originalReturn || typeof originalReturn !== 'object') return originalReturn;
  if (ctx?.__fromReport) return originalReturn;
  const t = String(text || '');
  const keywordHit = /执行|效果|策略|报告/.test(t);
  if (!MERGE_DECISION_ALWAYS_FOR_MARKETING_REPORT && !keywordHit) return originalReturn;
  const reportText = String(originalReturn.response || '').trim();
  if (!reportText) return originalReturn;
  try {
    const childCtx = { ...(ctx || {}), __fromReport: true };
    console.log('🚀 [CALL DATA AUDITOR]', t);
    const decision = await dispatchToAgent('data_auditor', t, childCtx);
    console.log('✅ [DATA AUDITOR RESULT]', decision?.response?.slice(0, 100));
    const decisionBody = String(decision?.response || '').trim();
    if (!decisionBody) return originalReturn;
    const mergedResponse = `${reportText}\n\n⸻\n\n【决策补充】\n\n${decisionBody}`;
    return { ...originalReturn, response: mergedResponse };
  } catch (e) {
    logger.warn({ err: e?.message }, 'mergeReportWithDataAuditorDecision skipped');
    return originalReturn;
  }
}

export{HANDLERS,AGENT_SKILLS};
