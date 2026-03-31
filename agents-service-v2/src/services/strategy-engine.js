/**
 * 策略规则引擎：scenario × root_cause → 多条 strategy_rules，再结合 agent_experience（含上下文加权）排序。
 */
import { query } from '../utils/db.js';
import { logger } from '../utils/logger.js';
import { filterTagsToWhitelist } from './strategy-tagging.js';
import { getHistoricalTagBonusForRuleTags } from './tag-quality.js';
import {
  getStrategyPerformance,
  computeActionBonusFromPerformance
} from './strategy-performance.js';

export { normalizeStrategyTags, STRATEGY_TAG_WHITELIST, filterTagsToWhitelist } from './strategy-tagging.js';

/** 与库中 root_cause 字面量对齐的别名（指标树 metric 与规则键） */
function expandRootCauseKeys(metric) {
  const m = String(metric || '').trim().toLowerCase();
  if (!m) return [];
  const out = new Set([m]);
  if (m === 'avg_order_value') out.add('aov');
  if (m === 'aov') out.add('avg_order_value');
  if (m === 'food_quality' || m === 'bad_review_product') {
    out.add('food');
  }
  if (m === 'food') {
    out.add('food_quality');
    out.add('bad_review_product');
  }
  return [...out];
}

function expandScenarioKeys(scenario) {
  const s = String(scenario || '').trim();
  if (!s) return [];
  const out = new Set([s]);
  if (s === 'bad_reviews_increase') out.add('bad_reviews');
  if (s === 'bad_reviews') out.add('bad_reviews_increase');
  return [...out];
}

const MAX_STRATEGY_ACTIONS = 3;
const W = 10000;
const MEMORY_WEIGHT = 1;
/** RL 历史调整：action 权重大于 tag（与「三元组」闭环更强相关） */
const RL_WEIGHT_TAG = 1;
const RL_WEIGHT_ACTION = 1.65;

/** agent_experience 行与当前 context 对齐时的分层加权（字段可空：缺一则该维度不参与加/减分） */
const CTX_STORE_MATCH = 0.3;
const CTX_STORE_MISMATCH = -0.1;
const CTX_CHANNEL_MATCH = 0.4;
const CTX_CHANNEL_MISMATCH = -0.2;
const CTX_TIME_MATCH = 0.1;

/** tags 命中时从排序用 memory 分上扣减（数值为要减去的量，与「penalty -1.2」语义一致） */
const TAG_PENALTY_DINEIN_TAKEOUT_ONLY = 1.2; // 堂食 + tags 含「外卖专用」
const TAG_PENALTY_HIGHEND_LOW_PRICE_TAG = 1.0; // 高端店 + tags 含「低价」

/** tags 为空时 fallback：按 action 文案关键词（兼容旧数据） */
const FALLBACK_PENALTY_DINEIN_TAKEAWAY_WORDING = 1.2;
const FALLBACK_PENALTY_HIGHEND_LOW_PRICE_WORDING = 1.0;

function ctxNorm(v) {
  const s = String(v ?? '').trim();
  return s || null;
}

/**
 * 从用户问题 + 品牌 + 场景推断策略上下文（字段均可空，缺省时不参与加权）。
 * @param {string} text
 * @param {string|null|undefined} brand 品牌名，作为 store_type
 * @param {string|null|undefined} scenario detectScenario 结果，如 delivery_drop 可暗示外卖渠道
 * @returns {{ store_type: string|null, channel: string|null, time_period: string|null }}
 */
export function buildStrategyContextFromQuestion(text, brand, scenario = null) {
  try {
    const t = String(text || '');
    const store_type = ctxNorm(brand);

    let channel = null;
    if (/(外卖|配送|饿了么|美团外卖|线上外卖|外卖单|外卖订单|外卖平台|delivery)/i.test(t)) {
      channel = '外卖';
    } else if (/(^堂食|堂食为主|店内|到店|堂吃)/.test(t) || (/(堂食)/.test(t) && !/外卖/.test(t))) {
      channel = '堂食';
    } else if (String(scenario || '').trim() === 'delivery_drop') {
      channel = '外卖';
    }

    let time_period = null;
    if (/(早餐|早市)/.test(t)) time_period = '早市';
    else if (/(午市|午餐|中午)/.test(t)) time_period = '午市';
    else if (/(晚市|晚餐|晚高峰)/.test(t)) time_period = '晚市';
    else if (/(夜宵|宵夜)/.test(t)) time_period = '夜宵';
    else if (/下午茶/.test(t)) time_period = '下午茶';

    return { store_type, channel, time_period };
  } catch (e) {
    logger.warn({ err: e?.message }, 'buildStrategyContextFromQuestion failed');
    return { store_type: null, channel: null, time_period: null };
  }
}

/**
 * memory_score = base_score + context_bonus（分层权重；经验侧字段为空则该维度既不加分也不扣 mismatch）
 */
function effectiveMemoryScore(row, context = {}) {
  const baseRaw = row?.score;
  const base = baseRaw != null ? Number(baseRaw) : NaN;
  if (!Number.isFinite(base)) return null;

  const ctxStore = ctxNorm(context?.store_type);
  const ctxChannel = ctxNorm(context?.channel);
  const ctxTime = ctxNorm(context?.time_period);

  let bonus = 0;
  const expStore = ctxNorm(row?.store_type);
  const expChannel = ctxNorm(row?.channel);
  const expTime = ctxNorm(row?.time_period);

  if (ctxStore) {
    if (expStore) {
      bonus += expStore === ctxStore ? CTX_STORE_MATCH : CTX_STORE_MISMATCH;
    }
  }
  if (ctxChannel) {
    if (expChannel) {
      bonus += expChannel === ctxChannel ? CTX_CHANNEL_MATCH : CTX_CHANNEL_MISMATCH;
    }
  }
  if (ctxTime && expTime && expTime === ctxTime) {
    bonus += CTX_TIME_MATCH;
  }

  return base + bonus;
}

function isHighEndStoreType(storeType) {
  const s = ctxNorm(storeType);
  if (!s) return false;
  return /高端|精品|臻选|旗舰店|黑珍珠|米其林|vip|VIP|会所|私宴/.test(s);
}

/**
 * 策略规则与 context 冲突时的扣分（用于排序，不删除条目）。
 * 仅当 tags_verified=true 时使用库内 tags 走标签规则；否则仅用 action 关键词 fallback（未审核的自动标签不参与扣分逻辑）。
 *
 * @param {string} actionText
 * @param {object} [context]
 * @param {unknown} [tags] strategy_rules.tags
 * @param {boolean} [tagsVerified]
 */
export function computeStrategyActionPenalty(actionText, context = {}, tags = null, tagsVerified = false) {
  try {
    const action = String(actionText || '');
    const ch = ctxNorm(context?.channel);
    const store = ctxNorm(context?.store_type);
    const tagList = tagsVerified === true ? filterTagsToWhitelist(tags) : [];
    let pen = 0;

    if (tagList.length > 0) {
      if (ch === '堂食' && tagList.includes('外卖专用')) {
        pen += TAG_PENALTY_DINEIN_TAKEOUT_ONLY;
      }
      if (isHighEndStoreType(store) && tagList.includes('低价')) {
        pen += TAG_PENALTY_HIGHEND_LOW_PRICE_TAG;
      }
      return pen;
    }

    if (ch === '堂食' && /外卖|平台/.test(action)) {
      pen += FALLBACK_PENALTY_DINEIN_TAKEAWAY_WORDING;
    }
    if (isHighEndStoreType(store) && /促销|特价|低价|折扣|满减|甩卖|团购价|9\.9|获客价|秒杀/.test(action)) {
      pen += FALLBACK_PENALTY_HIGHEND_LOW_PRICE_WORDING;
    }

    return pen;
  } catch (e) {
    logger.warn({ err: e?.message }, 'computeStrategyActionPenalty failed');
    return 0;
  }
}

/**
 * 在 agent_experience 中取该规则三元组的最佳加权分（scenario 含别名）
 * @param {string} ruleScenario
 * @param {string} ruleRootCause
 * @param {string} actionText
 * @param {{ store_type?: string|null, channel?: string|null, time_period?: string|null }} [context]
 * @returns {Promise<number|null>}
 */
async function fetchBestExperienceScore(ruleScenario, ruleRootCause, actionText, context = {}) {
  const scenKeys = expandScenarioKeys(ruleScenario);
  if (!scenKeys.length) return null;
  try {
    const r = await query(
      `SELECT score, store_type, channel, time_period FROM agent_experience
       WHERE scenario = ANY($1::text[])
         AND root_cause IS NOT DISTINCT FROM $2
         AND action = $3`,
      [scenKeys, ruleRootCause, actionText]
    );
    const rows = r.rows || [];
    if (!rows.length) return null;

    let best = null;
    for (const row of rows) {
      const eff = effectiveMemoryScore(row, context);
      if (eff == null) continue;
      if (best == null || eff > best) best = eff;
    }
    return best;
  } catch (e) {
    logger.warn({ err: e?.message }, 'fetchBestExperienceScore failed');
    return null;
  }
}

/**
 * 遍历全部 root_causes，收集所有命中的规则行；按 priority 与加权经验分排序，最多 3 条。
 *
 * @param {string|null|undefined} scenario
 * @param {Array<{ metric?: string, reason?: string }>|null|undefined} root_causes
 * @param {{ store_type?: string|null, channel?: string|null, time_period?: string|null }} [context]
 * @returns {Promise<{ actions: Array<{ action: string, priority: number, tag_bonus: number, action_bonus: number, final_score: number }> }|null>}
 */
export async function getStrategy(scenario, root_causes, context = {}) {
  const ctx = context && typeof context === 'object' ? context : {};
  try {
    const sc = String(scenario || '').trim();
    if (!sc || !Array.isArray(root_causes) || root_causes.length === 0) return null;
    const scenarioKeys = expandScenarioKeys(sc);
    if (!scenarioKeys.length) return null;

    const seen = new Set();
    const candidates = [];
    let discoverOrder = 0;

    for (const rc of root_causes) {
      const causeKeys = expandRootCauseKeys(rc?.metric);
      for (const sk of scenarioKeys) {
        for (const ck of causeKeys) {
          const r = await query(
            `SELECT action, priority, scenario, root_cause, tags, tags_verified FROM strategy_rules
             WHERE scenario = $1 AND root_cause = $2
             LIMIT 1`,
            [sk, ck]
          );
          const row = r.rows?.[0];
          if (!row?.action) continue;
          const action = String(row.action).trim();
          if (!action) continue;
          const ruleScenario = String(row.scenario || sk);
          const ruleRootCause = String(row.root_cause || ck);
          const dedupeKey = `${ruleScenario}\0${ruleRootCause}\0${action}`;
          if (seen.has(dedupeKey)) continue;
          seen.add(dedupeKey);
          const priRaw = row.priority != null ? Number(row.priority) : 1;
          const priority = Number.isFinite(priRaw) ? priRaw : 1;
          candidates.push({
            action,
            priority,
            ruleScenario,
            ruleRootCause,
            tags: row.tags,
            tags_verified: row.tags_verified === true,
            _discoverOrder: discoverOrder++
          });
        }
      }
    }

    if (!candidates.length) return null;

    const scored = [];
    for (const c of candidates) {
      let memoryScore = 0;
      try {
        const mem = await fetchBestExperienceScore(c.ruleScenario, c.ruleRootCause, c.action, ctx);
        if (mem != null) memoryScore = mem;
      } catch {
        memoryScore = 0;
      }
      const actionPenalty = computeStrategyActionPenalty(c.action, ctx, c.tags, c.tags_verified);
      const memory_score = memoryScore - actionPenalty;

      let tag_bonus = 0;
      let action_bonus = 0;
      try {
        tag_bonus = await getHistoricalTagBonusForRuleTags(c.tags, c.tags_verified);
      } catch {
        tag_bonus = 0;
      }
      try {
        const perf = await getStrategyPerformance(c.ruleScenario, c.ruleRootCause, c.action);
        action_bonus = computeActionBonusFromPerformance(perf);
      } catch {
        action_bonus = 0;
      }

      // final_score 越小越优先：priority×W − MEMORY×memory_score − RL_WEIGHT_TAG×tag_bonus − RL_WEIGHT_ACTION×action_bonus
      //（tag_bonus / action_bonus 为正表示历史表现好，进一步降低排序键）
      const final_score =
        c.priority * W -
        MEMORY_WEIGHT * memory_score -
        RL_WEIGHT_TAG * tag_bonus -
        RL_WEIGHT_ACTION * action_bonus;

      scored.push({
        action: c.action,
        priority: c.priority,
        tag_bonus,
        action_bonus,
        final_score: Number(final_score.toFixed(4)),
        _discoverOrder: c._discoverOrder
      });
    }

    scored.sort((a, b) => {
      if (a.final_score !== b.final_score) return a.final_score - b.final_score;
      return (a._discoverOrder ?? 0) - (b._discoverOrder ?? 0);
    });

    const top = scored.slice(0, MAX_STRATEGY_ACTIONS).map(
      ({ action, priority, tag_bonus, action_bonus, final_score }) => ({
        action,
        priority,
        tag_bonus,
        action_bonus,
        final_score
      })
    );

    return { actions: top };
  } catch (e) {
    logger.warn({ err: e?.message, scenario }, 'getStrategy failed');
    return null;
  }
}

/**
 * @param {{ actions: Array<{ action: string, priority: number }> }|string|null|undefined} bundle
 * @returns {string}
 */
export function formatStrategyPromptAppendix(bundle) {
  try {
    if (bundle == null) return '';

    if (typeof bundle === 'string') {
      const a = String(bundle).trim();
      if (!a) return '';
      return formatStrategyPromptAppendix({ actions: [{ action: a, priority: 1 }] });
    }

    const actions = bundle?.actions;
    if (!Array.isArray(actions) || actions.length === 0) return '';

    const sorted = [...actions]
      .map((x) => ({ action: String(x.action || '').trim(), priority: Number(x.priority) || 1 }))
      .filter((x) => x.action);
    const lines = sorted.map((x, i) => `${i + 1}. ${x.action}`);

    const body =
      sorted.length > 1
        ? `【建议策略（系统推荐）】\n${lines.join('\n')}\n`
        : `【建议策略（系统推荐）】\n* ${String(sorted[0].action || '').trim()}\n`;

    return (
      `\n${body}\n` +
      `【策略使用规则（强制）】\n` +
      `* 上列为系统根据「当前场景 + root_cause」匹配的规则结果（已按优先级与历史经验分排序），优先于自由发挥。\n` +
      `* 须在 **总结 / 分析说明 / 可执行建议** 中体现上述方向（可改写措辞，不得反向或改主题）。\n`
    );
  } catch (e) {
    logger.warn({ err: e?.message }, 'formatStrategyPromptAppendix failed');
    return '';
  }
}
