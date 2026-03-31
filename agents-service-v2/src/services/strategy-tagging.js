/**
 * 策略规则标签：固定白名单 + LLM 辅助打标（输出仅允许白名单内词条）。
 */
import { callLLM } from './llm-provider.js';
import { logger } from '../utils/logger.js';
import { isExternalEnabled } from '../utils/safety.js';

/** 标签白名单（禁止扩展为库外新词） */
export const STRATEGY_TAG_WHITELIST = Object.freeze([
  '流量',
  '投放',
  '外卖',
  '外卖专用',
  '堂食',
  '低价',
  '促销',
  '品质',
  '客单价',
  '复购',
  '会员',
  '服务'
]);

export const STRATEGY_TAG_WHITELIST_SET = new Set(STRATEGY_TAG_WHITELIST);

/**
 * @param {unknown} raw JSONB / 数组 / JSON 字符串
 * @returns {string[]}
 */
export function normalizeStrategyTags(raw) {
  try {
    if (raw == null) return [];
    if (Array.isArray(raw)) {
      return raw.map((x) => String(x ?? '').trim()).filter(Boolean);
    }
    if (typeof raw === 'string') {
      const t = raw.trim();
      if (!t) return [];
      try {
        const p = JSON.parse(t);
        if (Array.isArray(p)) return p.map((x) => String(x ?? '').trim()).filter(Boolean);
      } catch {
        return [];
      }
    }
    return [];
  } catch (e) {
    logger.warn({ err: e?.message }, 'normalizeStrategyTags failed');
    return [];
  }
}

/**
 * 仅保留白名单内标签（去重保序）
 * @param {unknown} raw
 * @returns {string[]}
 */
export function filterTagsToWhitelist(raw) {
  const seen = new Set();
  const out = [];
  for (const t of normalizeStrategyTags(raw)) {
    if (!STRATEGY_TAG_WHITELIST_SET.has(t) || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

function parseJsonArrayFromLlm(content) {
  let s = String(content || '').trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

/**
 * 调用 LLM 为策略文本生成标签；结果强制与白名单求交，不会输出库外词。
 * @param {string} actionText
 * @returns {Promise<string[]>}
 */
export async function generateStrategyTags(actionText) {
  const text = String(actionText || '').trim();
  if (!text) return [];

  if (!isExternalEnabled()) {
    logger.warn({}, 'generateStrategyTags: external LLM disabled');
    return [];
  }

  const whitelistLine = STRATEGY_TAG_WHITELIST.join('、');
  const sys = `你是餐饮经营策略标签器。根据用户给出的「策略行动」一句话，从**固定白名单**中选出 zero 个或多个最匹配的标签。

【白名单】（只能使用下列词，禁止自造词、同义词、英文）：
${whitelistLine}

【输出】仅输出一个 JSON 数组，例如 ["流量","投放"]。不要 markdown、不要解释。
若无任何匹配，输出 []。数组中每个字符串必须与白名单中的某一项**完全一致**（含「外卖专用」四字）。`;

  try {
    const r = await callLLM(
      [{ role: 'system', content: sys }, { role: 'user', content: text }],
      { temperature: 0, max_tokens: 120, purpose: 'strategy_tagging', context: { intent: 'query', complexity: 'low', mode: 'single' } }
    );
    if (!r?.ok || r?.error === 'external_disabled') return [];
    const rawArr = parseJsonArrayFromLlm(r.content || '');
    return filterTagsToWhitelist(rawArr);
  } catch (e) {
    logger.warn({ err: e?.message }, 'generateStrategyTags failed');
    return [];
  }
}
