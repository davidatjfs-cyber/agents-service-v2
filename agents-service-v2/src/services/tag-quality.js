/**
 * 策略标签质量分：覆盖度 / 一致性 / 完整性（启发式关键词，供 auto-tag 门禁）；
 * 可选叠加 agent_experience 历史 tag_bonus。
 */
import { logger } from '../utils/logger.js';
import { filterTagsToWhitelist } from './strategy-tagging.js';
import { getTagPerformance, MIN_SAMPLES_FOR_BONUS } from './tag-performance.js';

/** 聚合后 tag_bonus 允许区间（与单标签 raw 上限一致） */
const TAG_BONUS_AGG_MIN = -0.2;
const TAG_BONUS_AGG_MAX = 0.15;

/**
 * 单标签：历史 raw ∈ [-0.2,+0.15]，再乘样本量权重 min(1, n/10)。
 * @returns {{ raw: number, weight: number, contribution: number }}
 */
export function computeHistoricalTagContribution(successRate, sampleCount, minSamples = MIN_SAMPLES_FOR_BONUS) {
  const n = Number(sampleCount) || 0;
  const sr = successRate != null && Number.isFinite(Number(successRate)) ? Number(successRate) : null;
  let raw = 0;
  if (n >= minSamples && sr != null) {
    if (sr >= 0.7) {
      raw = (sr - 0.7) * 0.5;
    } else if (sr <= 0.4) {
      raw = -(0.4 - sr) * 0.5;
    } else {
      raw = 0;
    }
    raw = Math.max(-0.2, Math.min(0.15, raw));
  }
  const weight = Math.min(1, n / 10);
  const contribution = raw * weight;
  return { raw, weight, contribution };
}

/**
 * 与 scoreTags 历史段一致：仅 tags_verified 时用库内 tags 聚合成排序用 tag_bonus。
 * @returns {Promise<number>}
 */
export async function getHistoricalTagBonusForRuleTags(tagsJson, tagsVerified) {
  if (tagsVerified !== true) return 0;
  try {
    const list = filterTagsToWhitelist(tagsJson);
    if (!list.length) return 0;
    const perfs = await Promise.all(list.map((t) => getTagPerformance(t)));
    const minN = MIN_SAMPLES_FOR_BONUS;
    let sum = 0;
    for (const p of perfs) {
      const { contribution } = computeHistoricalTagContribution(p.success_rate, p.sample_count, minN);
      sum += contribution;
    }
    let tag_bonus = sum / list.length;
    tag_bonus = Math.max(TAG_BONUS_AGG_MIN, Math.min(TAG_BONUS_AGG_MAX, tag_bonus));
    return Number(tag_bonus.toFixed(4));
  } catch (e) {
    logger.warn({ err: e?.message }, 'getHistoricalTagBonusForRuleTags failed');
    return 0;
  }
}

/** 标签 → 策略文本中应能匹配到的关键词（简单子串/正则） */
const TAG_KEYWORD_RX = {
  流量: /流量|曝光|引流|获客|进店|客流|拉新|关注度/i,
  投放: /投放|广告|推广|抖音|点评|美团|饿了么|平台|排名/i,
  外卖: /外卖|配送|饿了么|美团|线上订单|外卖单/i,
  外卖专用: /外卖|配送|平台|排名|饿了么|美团/i,
  堂食: /堂食|店内|到店|堂吃|正餐/i,
  低价: /低价|特价|便宜|折扣|优惠|满减|9\.9|秒杀|团购价/i,
  促销: /促销|优惠|活动|满减|立减|打折/i,
  品质: /品质|口味|出品|质量|温度|食材/i,
  客单价: /客单|单价|套餐|组合|搭配|单均/i,
  复购: /复购|回头|再来|老客|黏性/i,
  会员: /会员|储值|积分|企微|私域/i,
  服务: /服务|态度|等位|体验|接待/i
};

/**
 * @param {string[]} tags
 * @param {string} actionText
 * @param {{ skipHistoricalBonus?: boolean }} [options] 为 true 时不查库、不加 tag_bonus（便于单测稳定）
 * @returns {Promise<{ score: number, issues: string[], base_score: number, tag_bonus: number, tags_detail: Array<{ tag: string, success_rate: number|null, sample_count: number, contribution: number }> }>}
 */
export async function scoreTags(tags, actionText, options = {}) {
  const issues = [];
  try {
    const action = String(actionText || '');
    const list = filterTagsToWhitelist(tags);

    if (list.length === 0) {
      return {
        score: 0,
        issues: ['覆盖度: 无有效标签'],
        base_score: 0,
        tag_bonus: 0,
        tags_detail: []
      };
    }

    // ── 1) 覆盖度：每个标签须在文案中有依据
    let coverHits = 0;
    for (const t of list) {
      const rx = TAG_KEYWORD_RX[t];
      if (rx && rx.test(action)) {
        coverHits++;
      } else {
        issues.push(`覆盖度: 标签「${t}」在策略文本中缺少明显关键词依据`);
      }
    }
    const coverage = coverHits / list.length;

    // ── 2) 一致性：互斥或矛盾组合
    let conflictWeight = 0;
    const set = new Set(list);

    if (set.has('堂食') && (set.has('外卖') || set.has('外卖专用'))) {
      conflictWeight += 1;
      issues.push('一致性: 「堂食」与「外卖/外卖专用」不宜同时出现');
    }
    if (set.has('低价') && set.has('品质')) {
      conflictWeight += 0.7;
      issues.push('一致性: 「低价」与「品质」并存可能口径冲突');
    }
    if (set.has('低价') && /高端|精品店|黑珍珠|米其林|私宴|会所|臻选|旗舰/i.test(action)) {
      conflictWeight += 0.8;
      issues.push('一致性: 文案含高端/精品等表述与「低价」标签可能冲突');
    }

    const consistency = Math.max(0, 1 - 0.35 * conflictWeight);

    // ── 3) 完整性：常见组合缺项
    let completeDeduction = 0;
    if (set.has('投放') && !set.has('流量')) {
      if (/投放|广告|推广|抖音|点评|美团|饿了么|平台/i.test(action)) {
        completeDeduction += 0.35;
        issues.push('完整性: 已标「投放」且文本涉及投放场景，建议同时有「流量」');
      }
    }
    if (/流量|曝光|引流|获客/i.test(action) && !set.has('流量') && list.length > 0) {
      completeDeduction += 0.25;
      issues.push('完整性: 文本强调流量/曝光但未标「流量」');
    }
    if (/会员|储值|积分|老客|复购/i.test(action) && !set.has('会员') && !set.has('复购') && list.length > 0) {
      completeDeduction += 0.2;
      issues.push('完整性: 文本涉及会员/复购但未标对应标签');
    }

    const completeness = Math.max(0, 1 - completeDeduction);

    const raw = 0.42 * coverage + 0.33 * consistency + 0.25 * completeness;
    const base_score = Math.max(0, Math.min(1, Number(raw.toFixed(3))));

    let tag_bonus = 0;
    /** @type {Array<{ tag: string, success_rate: number|null, sample_count: number, contribution: number }>} */
    let tags_detail = [];

    if (options.skipHistoricalBonus) {
      tags_detail = list.map((tag) => ({
        tag,
        success_rate: null,
        sample_count: 0,
        contribution: 0
      }));
    } else if (list.length > 0) {
      const perfs = await Promise.all(list.map((t) => getTagPerformance(t)));
      const minN = MIN_SAMPLES_FOR_BONUS;
      tags_detail = perfs.map((p) => {
        const { contribution } = computeHistoricalTagContribution(p.success_rate, p.sample_count, minN);
        return {
          tag: p.tag,
          success_rate: p.success_rate,
          sample_count: p.sample_count,
          contribution: Number(contribution.toFixed(4))
        };
      });
      const sum = tags_detail.reduce((a, d) => a + d.contribution, 0);
      tag_bonus = sum / list.length;
      tag_bonus = Math.max(TAG_BONUS_AGG_MIN, Math.min(TAG_BONUS_AGG_MAX, tag_bonus));
      tag_bonus = Number(tag_bonus.toFixed(4));
    }

    const score = Math.max(0, Math.min(1, Number((base_score + tag_bonus).toFixed(3))));
    return { score, issues, base_score, tag_bonus, tags_detail };
  } catch (e) {
    logger.warn({ err: e?.message }, 'scoreTags failed');
    return {
      score: 0,
      issues: [`内部错误: ${e?.message || e}`],
      base_score: 0,
      tag_bonus: 0,
      tags_detail: []
    };
  }
}
