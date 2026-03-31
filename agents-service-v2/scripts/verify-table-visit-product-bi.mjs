#!/usr/bin/env node
/**
 * 核验 BI「桌访产品异常」与 chat/KPI 同源口径：
 * - fetchMergedTableVisitEntries + tableVisitEntryIsDissatisfied
 * - dissatisfactionDishFromMergedEntry（优先「今天不满意的菜品」）
 * - dissatisfactionMainReasonFromEntry（优先「不满意的主要原因是什么」）
 * - checkTableVisitProduct 汇总结果（上周一至上周日，上海自然周）
 *
 * 用法：
 *   cd agents-service-v2 && DATABASE_URL=... node scripts/verify-table-visit-product-bi.mjs "马己仙上海音乐广场店"
 *   node scripts/verify-table-visit-product-bi.mjs "门店名" --json
 */
import 'dotenv/config';
import { checkTableVisitProduct } from '../src/services/anomaly-engine.js';
import {
  ext,
  fetchMergedTableVisitEntries,
  tableVisitEntryIsDissatisfied,
  dissatisfactionDishFromMergedEntry,
  dissatisfactionMainReasonFromEntry,
  isPositiveTableVisitSatisfaction
} from '../src/services/deterministic-replies.js';
import { shanghaiLastCompletedWeekBounds } from '../src/utils/anomaly-week-bounds.js';

function snippet(s, n = 80) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  if (t.length <= n) return t;
  return `${t.slice(0, n)}…`;
}

async function main() {
  const args = process.argv.slice(2).filter((a) => a !== '--json');
  const jsonOut = process.argv.includes('--json');
  const store = args[0] || '马己仙上海音乐广场店';

  if (!process.env.DATABASE_URL) {
    console.error('Missing DATABASE_URL');
    process.exit(1);
  }

  const { weekStart, weekEnd } = shanghaiLastCompletedWeekBounds();
  const entries = await fetchMergedTableVisitEntries(store, weekStart, weekEnd);
  const dissatisfied = entries.filter(tableVisitEntryIsDissatisfied);

  const perRow = entries.map((e, i) => {
    const f = e.fields && typeof e.fields === 'object' ? e.fields : {};
    const sat = String(e.sat || ext(f['今天用餐是否满意']) || ext(f['满意度']) || '').trim();
    const dishCol = ext(
      f['今天不满意的菜品'] || f['今天 不满意菜品'] || f['今天不满意菜品'] || ''
    );
    const satPos = sat ? isPositiveTableVisitSatisfaction(sat) : false;
    const mergedD = dissatisfactionDishFromMergedEntry(e) || '';
    return {
      n: i + 1,
      isDissatisfied: tableVisitEntryIsDissatisfied(e),
      sat: snippet(sat, 40),
      satPositive: sat ? satPos : null,
      feishuUnsatDishField: snippet(dishCol, 60),
      mergedDishLine: snippet(mergedD, 80),
      mergedReason: snippet(dissatisfactionMainReasonFromEntry(e), 80),
      entryDishFallback: snippet(e.dish || '', 60)
    };
  });

  // 只看「明确满意却仍带不满意菜品」的假阳性；有菜无原因/未填满意度而排除属正常口径
  const suspicious = perRow.filter((r) => {
    if (r.isDissatisfied) return false;
    if (r.satPositive !== true) return false;
    const d = String(r.mergedDishLine || '').replace(/…$/,'').trim();
    return d.length >= 2;
  });

  const biResult = await checkTableVisitProduct(store);

  const out = {
    store,
    window: { weekStart, weekEnd },
    totals: {
      mergedEntries: entries.length,
      dissatisfiedRows: dissatisfied.length,
      suspiciousPositiveSatWithUnhappyDish: suspicious.length
    },
    biTableVisitProduct: {
      triggered: biResult.triggered,
      severity: biResult.severity || null,
      detail: biResult.detail,
      products: biResult.value?.products || [],
      threshold: biResult.threshold
    },
    dissatisfiedBreakdown: dissatisfied.map((e, i) => ({
      n: i + 1,
      dish: dissatisfactionDishFromMergedEntry(e),
      reason: dissatisfactionMainReasonFromEntry(e)
    })),
    suspiciousPreview: suspicious.slice(0, 25)
  };

  if (jsonOut) {
    console.log(JSON.stringify(out, null, 2));
  } else {
    console.log('=== 桌访产品异常 BI 口径核验 ===\n');
    console.log(`门店: ${store}`);
    console.log(`统计窗口(上周自然周): ${weekStart} ~ ${weekEnd}`);
    console.log(`合并桌访条数: ${out.totals.mergedEntries}`);
    console.log(`计为「不满意」条数: ${out.totals.dissatisfiedRows}`);
    console.log(`可疑(满意度为正向却仍带不满意菜品): ${out.totals.suspiciousPositiveSatWithUnhappyDish}`);
    console.log('\n--- checkTableVisitProduct 结果 ---');
    console.log(`triggered: ${biResult.triggered}  severity: ${biResult.severity || '—'}`);
    console.log(`detail: ${biResult.detail}`);
    console.log('products:', JSON.stringify(biResult.value?.products || [], null, 2));
    if (out.dissatisfiedBreakdown.length) {
      console.log('\n--- 计入不满意汇总明细(前30条) ---');
      out.dissatisfiedBreakdown.slice(0, 30).forEach((x) => {
        console.log(`  ${x.n}. 菜品: ${snippet(x.dish, 100)} | 原因: ${snippet(x.reason, 100)}`);
      });
    }
    if (out.suspiciousPreview.length) {
      console.log('\n--- 可疑行(满意+不满意菜并存; 应对照飞书; 理想为 0) ---');
      console.log(JSON.stringify(out.suspiciousPreview, null, 2));
    }
    console.log('\n完整 JSON 请加参数: --json');
  }

  const ok =
    out.totals.suspiciousPositiveSatWithUnhappyDish === 0 || process.env.VERIFY_ALLOW_SUSPICIOUS === '1';
  if (!ok) {
    console.error('\n[verify] FAIL: 存在「满意度为正向却仍带不满意菜品」记录，请核对飞书满意度与「今天不满意的菜品」。');
    process.exit(2);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
