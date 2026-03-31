#!/usr/bin/env node
/**
 * 快速验证 getStrategy 多策略 + formatStrategyPromptAppendix（需 DATABASE_URL 与 strategy_rules 表）
 */
import 'dotenv/config';
import {
  getStrategy,
  formatStrategyPromptAppendix,
  buildStrategyContextFromQuestion,
  computeStrategyActionPenalty
} from '../src/services/strategy-engine.js';
import { scoreTags } from '../src/services/tag-quality.js';

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('[verify-strategy-engine] Skip: no DATABASE_URL');
    process.exit(0);
  }

  const tagOpts = { skipHistoricalBonus: true };
  const qGood = await scoreTags(['流量', '投放'], '增加曝光（抖音/点评投放）', tagOpts);
  if (qGood.score < 0.5 || !Array.isArray(qGood.issues)) {
    console.error('[verify-strategy-engine] FAIL: scoreTags 正常案例');
    process.exit(1);
  }
  const qBad = await scoreTags(['低价'], '高端旗舰店出品升级，坚持品质路线', tagOpts);
  if (qBad.score >= 0.6) {
    console.error('[verify-strategy-engine] FAIL: scoreTags 应识别低价与高端文案冲突');
    process.exit(1);
  }
  const qConflict = await scoreTags(['堂食', '外卖'], '堂食客流下降分析', tagOpts);
  if (qConflict.score >= 0.95) {
    console.error('[verify-strategy-engine] FAIL: scoreTags 堂食+外卖应拉低一致性');
    process.exit(1);
  }
  for (const label of ['qGood', 'qBad', 'qConflict']) {
    const q = label === 'qGood' ? qGood : label === 'qBad' ? qBad : qConflict;
    if (!Array.isArray(q.tags_detail) || q.tags_detail.length === 0) {
      console.error(`[verify-strategy-engine] FAIL: scoreTags ${label} 应含 tags_detail`);
      process.exit(1);
    }
  }
  console.log('[0c] tag-quality ok', {
    good: qGood.score,
    bad: qBad.score,
    conflict: qConflict.score,
    tags_detail_sample: qGood.tags_detail
  });

  const ctxProbe = buildStrategyContextFromQuestion('外卖单量下降，午市很差', '洪潮', 'delivery_drop');
  console.log('[0] buildStrategyContext:', JSON.stringify(ctxProbe));
  if (ctxProbe.channel !== '外卖' || ctxProbe.time_period !== '午市' || ctxProbe.store_type !== '洪潮') {
    console.error('[verify-strategy-engine] FAIL: context extraction');
    process.exit(1);
  }

  const t1 = computeStrategyActionPenalty('任意文案', { channel: '堂食' }, ['外卖', '平台', '外卖专用'], true);
  if (t1 !== 1.2) {
    console.error('[verify-strategy-engine] FAIL: tags 外卖专用 + 堂食');
    process.exit(1);
  }
  const t2 = computeStrategyActionPenalty('任意', { channel: '堂食' }, ['流量', '投放'], true);
  if (t2 !== 0) {
    console.error('[verify-strategy-engine] FAIL: tags 无外卖专用时不应扣分');
    process.exit(1);
  }
  const t3 = computeStrategyActionPenalty('x', { store_type: '高端旗舰店' }, ['低价'], true);
  if (t3 !== 1.0) {
    console.error('[verify-strategy-engine] FAIL: tags 低价 + 高端店');
    process.exit(1);
  }
  const t4 = computeStrategyActionPenalty('加大外卖与平台投放力度', { channel: '堂食' }, [], false);
  if (t4 !== 1.2) {
    console.error('[verify-strategy-engine] FAIL: tags 空/未审时 fallback 关键词');
    process.exit(1);
  }
  const t5 = computeStrategyActionPenalty('优化套餐', { channel: '堂食', store_type: '高端旗舰店' }, ['客单价'], true);
  if (t5 !== 0) {
    console.error('[verify-strategy-engine] FAIL: 客单价 tag 不误伤高端');
    process.exit(1);
  }
  const t6 = computeStrategyActionPenalty('全场特价促销拉新', { store_type: '高端旗舰店' }, null, false);
  if (t6 !== 1.0) {
    console.error('[verify-strategy-engine] FAIL: fallback 高端+促销文案');
    process.exit(1);
  }
  const t7 = computeStrategyActionPenalty('任意', { channel: '堂食' }, ['外卖专用'], false);
  if (t7 !== 0) {
    console.error('[verify-strategy-engine] FAIL: 未 verified 时不得走 tag 扣分（应用 fallback，此处无平台/外卖文案应 0）');
    process.exit(1);
  }
  console.log('[0b] tags + fallback penalties ok');

  const r = await getStrategy('revenue_drop', [
    { metric: 'traffic', reason: 'down' },
    { metric: 'avg_order_value', reason: 'down' }
  ]);
  console.log('[1] getStrategy revenue_drop traffic+aov:', JSON.stringify(r, null, 2));
  const ap = formatStrategyPromptAppendix(r);
  console.log('[2] appendix chars:', ap.length);
  if (!r?.actions?.length) {
    console.warn('[verify-strategy-engine] SKIP: 无匹配或 strategy_rules 未建表（本地可忽略；部署后会再验）');
    process.exit(0);
  }
  for (const a of r.actions) {
    if (
      typeof a.tag_bonus !== 'number' ||
      typeof a.action_bonus !== 'number' ||
      typeof a.final_score !== 'number'
    ) {
      console.error('[verify-strategy-engine] FAIL: action 需含 tag_bonus / action_bonus / final_score');
      process.exit(1);
    }
  }
  if (r.actions.length > 3) {
    console.error('[verify-strategy-engine] FAIL: max 3 actions');
    process.exit(1);
  }
  if (r.actions.length > 1 && !/【建议策略（系统推荐）】\n1\./.test(ap)) {
    console.error('[verify-strategy-engine] FAIL: expected numbered list when multiple');
    process.exit(1);
  }
  if (r.actions.length === 1 && !/\* .+/.test(ap)) {
    console.error('[verify-strategy-engine] FAIL: expected bullet for single action');
    process.exit(1);
  }

  const rCtx = await getStrategy(
    'revenue_drop',
    [{ metric: 'traffic', reason: 'down' }],
    { store_type: '洪潮', channel: '外卖', time_period: '午市' }
  );
  if (!rCtx?.actions?.length) {
    console.error('[verify-strategy-engine] FAIL: getStrategy with context');
    process.exit(1);
  }
  for (const a of rCtx.actions) {
    if (typeof a.final_score !== 'number') {
      console.error('[verify-strategy-engine] FAIL: context getStrategy 缺少 final_score');
      process.exit(1);
    }
  }
  console.log('[3] getStrategy+context ok, actions:', rCtx.actions.length);

  console.log('[verify-strategy-engine] OK');
}

main().catch((e) => {
  console.error('[verify-strategy-engine]', e?.message || e);
  process.exit(1);
});
