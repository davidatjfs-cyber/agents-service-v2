#!/usr/bin/env node
/**
 * 核验 BI「桌访产品异常」口径（与聊天宽口径区分）：
 * - fetchMergedTableVisitEntries（上周一～上周日）
 * - tableVisitEntryEligibleForTableVisitProductBi + dissatisfactionDishForTableVisitProductBi（仅「今天不满意菜品」列）
 * - dissatisfactionMainReasonFromEntry
 * - checkTableVisitProduct
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
  tableVisitEntryEligibleForTableVisitProductBi,
  dissatisfactionDishForTableVisitProductBi,
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
  const dissatisfiedBi = entries.filter(tableVisitEntryEligibleForTableVisitProductBi);

  const perRow = entries.map((e, i) => {
    const f = e.fields && typeof e.fields === 'object' ? e.fields : {};
    const sat = String(e.sat || ext(f['今天用餐是否满意']) || ext(f['满意度']) || '').trim();
    const dishColStrict = ext(f['今天不满意菜品'] || f['今天 不满意菜品'] || '');
    const satPos = sat ? isPositiveTableVisitSatisfaction(sat) : false;
    const biDish = dissatisfactionDishForTableVisitProductBi(e) || '';
    return {
      n: i + 1,
      eligibleBi: tableVisitEntryEligibleForTableVisitProductBi(e),
      sat: snippet(sat, 40),
      satPositive: sat ? satPos : null,
      biColumn今天不满意菜品: snippet(dishColStrict, 60),
      biDishLine: snippet(biDish, 80),
      mergedReason: snippet(dissatisfactionMainReasonFromEntry(e), 80),
      entryDishFallback: snippet(e.dish || '', 60)
    };
  });

  // 明确满意却仍填「今天不满意菜品」的假阳性
  const suspicious = perRow.filter((r) => {
    if (r.eligibleBi) return false;
    if (r.satPositive !== true) return false;
    const d = String(r.biDishLine || '').replace(/…$/, '').trim();
    return d.length >= 2;
  });

  const biResult = await checkTableVisitProduct(store);

  const out = {
    store,
    window: { weekStart, weekEnd },
    totals: {
      mergedEntries: entries.length,
      dissatisfiedRowsBi: dissatisfiedBi.length,
      suspiciousPositiveSatWithUnhappyDish: suspicious.length
    },
    biTableVisitProduct: {
      triggered: biResult.triggered,
      severity: biResult.severity || null,
      detail: biResult.detail,
      products: biResult.value?.products || [],
      threshold: biResult.threshold
    },
    dissatisfiedBreakdownBi: dissatisfiedBi.map((e, i) => ({
      n: i + 1,
      dish: dissatisfactionDishForTableVisitProductBi(e),
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
    console.log(`计为「不满意」(BI·仅今天不满意菜品列)条数: ${out.totals.dissatisfiedRowsBi}`);
    console.log(`可疑(满意度为正向却仍带不满意菜品): ${out.totals.suspiciousPositiveSatWithUnhappyDish}`);
    console.log('\n--- checkTableVisitProduct 结果 ---');
    console.log(`triggered: ${biResult.triggered}  severity: ${biResult.severity || '—'}`);
    console.log(`detail: ${biResult.detail}`);
    console.log('products:', JSON.stringify(biResult.value?.products || [], null, 2));
    if (out.dissatisfiedBreakdownBi.length) {
      console.log('\n--- 计入 BI 不满意汇总明细(前30条) ---');
      out.dissatisfiedBreakdownBi.slice(0, 30).forEach((x) => {
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
    console.error('\n[verify] FAIL: 存在「满意度为正向却仍填今天不满意菜品」记录，请核对飞书满意度与该列。');
    process.exit(2);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
