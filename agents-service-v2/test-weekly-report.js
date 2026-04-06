#!/usr/bin/env node
/**
 * 测试发送绩效考核周报给 NNYXCS35
 */
import { query } from './src/utils/db.js';
import { sendCard, buildPerformanceSummaryCard } from './src/services/feishu-client.js';

async function main() {
  try {
    const openId = 'ou_eb2f31bcb777a42b9876758730bc4cd8';
    
    const scoreR = await query(
      `SELECT total_score, deductions FROM agent_scores 
       WHERE username = 'NNYXCS35' AND score_model = 'anomaly_rollups_v2' AND period = 'week_2026-03-30' LIMIT 1`
    );
    const score = scoreR.rows?.[0];
    if (!score) { console.error('❌ 未找到上周得分'); process.exit(1); }
    console.log('✅ 上周得分:', score.total_score);

    const ratingR = await query(
      `SELECT breakdown FROM agent_scores 
       WHERE username = 'NNYXCS35' AND store = '马己仙上海音乐广场店' AND score_model = 'new_model'
       ORDER BY updated_at DESC LIMIT 1`
    );
    let dimensionRatings = null;
    if (ratingR.rows?.[0]?.breakdown) {
      const bd = ratingR.rows[0].breakdown;
      dimensionRatings = {
        store_rating: bd.store_rating || 'C',
        ability_rating: bd.ability_rating || 'C',
        attitude_rating: bd.attitude_rating || 'D',
        execution_rating: bd.execution_rating || 'C'
      };
    } else {
      dimensionRatings = { store_rating: 'C', ability_rating: 'C', attitude_rating: 'D', execution_rating: 'C' };
    }
    console.log('✅ 维度评级:', JSON.stringify(dimensionRatings));

    let ded = score.deductions;
    if (typeof ded === 'string') { try { ded = JSON.parse(ded); } catch { ded = []; } }
    ded = Array.isArray(ded) ? ded : [];

    const CAT_ZH = {
      revenue_anomaly: '营收/实收异常', efficiency_anomaly: '人效异常', recharge_anomaly: '充值异常',
      table_visit_anomaly: '桌访相关异常', table_visit_ratio_anomaly: '桌访占比异常', margin_anomaly: '毛利异常',
      product_review: '产品差评异常', service_review: '服务差评异常', private_room_anomaly: '包房使用异常'
    };
    const ANOMALY_KEY_ZH = {
      revenue_achievement: '实收营收异常', labor_efficiency: '人效值异常', recharge_zero: '充值异常',
      table_visit_product: '桌访产品异常', table_visit_ratio: '桌访占比异常', gross_margin: '总实收毛利率异常',
      bad_review_product: '差评产品异常', bad_review_service: '差评服务异常'
    };

    const detailMd = ded.length > 0
      ? ded.map(d => {
          const cat = CAT_ZH[d.category] || '异常扣分';
          const kz = ANOMALY_KEY_ZH[d.anomaly_key] || '';
          return `• ${cat}${kz ? `（${kz}）` : ''}：**-${d.points}** 分`;
        }).join('\n')
      : '本周无异常扣分项。';

    const card = buildPerformanceSummaryCard({
      title: '📊 绩效考核周报',
      store: '马己仙上海音乐广场店',
      periodLabel: '2026-03-30～2026-04-05',
      totalScore: score.total_score,
      role: '出品经理',
      detailMd,
      dimensionRatings
    });

    console.log('\n📋 卡片内容:');
    console.log(JSON.stringify(card, null, 2));

    const res = await sendCard(openId, card);
    if (res?.ok || res?.data?.code === 0) {
      console.log('\n✅ 测试周报已发送至 NNYXCS35 飞书！');
    } else {
      console.error('❌ 发送失败:', res);
    }
  } catch (e) {
    console.error('❌ 异常:', e.message);
    console.error(e.stack);
    process.exit(1);
  }
}

main();
