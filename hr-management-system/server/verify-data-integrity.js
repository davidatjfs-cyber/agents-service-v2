/**
 * 数据完整性验证脚本
 */

import { pool } from './utils/database.js';
import { Pool } from 'pg';

async function verifyDataIntegrity() {
  console.log('🔍 验证数据完整性...\n');
  
  // 设置数据库连接
  const dbPool = new Pool({
    connectionString: process.env.DATABASE_URL
  });
  
  try {
    // 1. 检查daily_reports表数据
    console.log('📊 检查daily_reports表:');
    const dailyReports = await dbPool.query(`
      SELECT store, date, actual_revenue, actual_margin, target_margin, target_revenue, dianping_rating
      FROM daily_reports 
      ORDER BY date DESC
    `);
    
    console.log(`记录数: ${dailyReports.rows.length}`);
    dailyReports.rows.forEach((row, index) => {
      console.log(`${index + 1}. ${row.store} ${row.date}`);
      console.log(`   实际营业额: ${row.actual_revenue}`);
      console.log(`   实际毛利率: ${row.actual_margin}%`);
      console.log(`   目标毛利率: ${row.target_margin}%`);
      console.log(`   目标营业额: ${row.target_revenue}`);
      console.log(`   大众点评星级: ${row.dianping_rating}`);
      console.log('');
    });
    
    // 2. 检查revenue_targets表数据
    console.log('🎯 检查revenue_targets表:');
    const revenueTargets = await dbPool.query(`
      SELECT store, brand, period, target_revenue
      FROM revenue_targets 
      ORDER BY period DESC
    `);
    
    console.log(`记录数: ${revenueTargets.rows.length}`);
    revenueTargets.rows.forEach((row, index) => {
      console.log(`${index + 1}. ${row.store} ${row.brand} ${row.period}`);
      console.log(`   目标营业额: ${row.target_revenue}`);
      console.log('');
    });
    
    // 3. 检查margin_targets表数据
    console.log('💰 检查margin_targets表:');
    const marginTargets = await dbPool.query(`
      SELECT store, brand, period, target_margin
      FROM margin_targets 
      ORDER BY period DESC
    `);
    
    console.log(`记录数: ${marginTargets.rows.length}`);
    marginTargets.rows.forEach((row, index) => {
      console.log(`${index + 1}. ${row.store} ${row.brand} ${row.period}`);
      console.log(`   目标毛利率: ${row.target_margin}%`);
      console.log('');
    });
    
    // 4. 检查monthly_margins表数据
    console.log('📈 检查monthly_margins表:');
    const monthlyMargins = await dbPool.query(`
      SELECT store, brand, period, actual_margin, source
      FROM monthly_margins 
      ORDER BY period DESC
    `);
    
    console.log(`记录数: ${monthlyMargins.rows.length}`);
    monthlyMargins.rows.forEach((row, index) => {
      console.log(`${index + 1}. ${row.store} ${row.brand} ${row.period}`);
      console.log(`   实际毛利率: ${row.actual_margin}%`);
      console.log(`   数据来源: ${row.source}`);
      console.log('');
    });
    
    // 5. 数据一致性检查
    console.log('🔍 数据一致性检查:');
    const consistencyCheck = await dbPool.query(`
      SELECT 
        dr.store,
        dr.date,
        dr.actual_revenue,
        dr.actual_margin,
        dr.target_revenue,
        dr.target_margin,
        rt.target_revenue as rt_target,
        mt.target_margin as mt_target
      FROM daily_reports dr
      LEFT JOIN revenue_targets rt ON dr.store = rt.store AND EXTRACT(YEAR_MONTH FROM dr.date) = rt.period
      LEFT JOIN margin_targets mt ON dr.store = mt.store AND EXTRACT(YEAR_MONTH FROM dr.date) = mt.period
      ORDER BY dr.date DESC
    `);
    
    console.log(`一致性检查记录数: ${consistencyCheck.rows.length}`);
    let inconsistencies = 0;
    
    consistencyCheck.rows.forEach((row, index) => {
      const issues = [];
      
      if (row.target_revenue !== row.rt_target) {
        issues.push(`营业目标不一致: 表=${row.target_revenue}, 目标表=${row.rt_target}`);
      }
      
      if (row.target_margin !== row.mt_target) {
        issues.push(`毛利率目标不一致: 表=${row.target_margin}, 目标表=${row.mt_target}`);
      }
      
      if (issues.length > 0) {
        inconsistencies++;
        console.log(`❌ ${row.store} ${row.date}:`);
        issues.forEach(issue => console.log(`   - ${issue}`));
        console.log('');
      }
    });
    
    if (inconsistencies === 0) {
      console.log('✅ 所有数据一致性检查通过');
    } else {
      console.log(`⚠️ 发现 ${inconsistencies} 个数据不一致问题`);
    }
    
  } catch (error) {
    console.error('❌ 验证失败:', error);
  } finally {
    await dbPool.end();
  }
}

// 运行验证
verifyDataIntegrity().then(() => {
  console.log('\n✅ 数据完整性验证完成');
  process.exit(0);
}).catch(error => {
  console.error('❌ 验证异常:', error);
  process.exit(1);
});
