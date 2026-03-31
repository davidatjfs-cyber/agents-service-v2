/**
 * 测试营业日报数据
 */

import { pool } from './utils/database.js';
import { Pool } from 'pg';

async function testDailyReportsData() {
  console.log('🧪 测试营业日报数据...\n');
  
  // 设置数据库连接
  const dbPool = new Pool({
    connectionString: process.env.DATABASE_URL
  });
  
  try {
    // 1. 检查JSON数据
    console.log('📊 检查JSON数据:');
    const jsonResult = await dbPool.query(`
      SELECT 
        data->'dailyReports'->0->'data'->>'target_revenue' as target_revenue,
        data->'dailyReports'->0->'data'->>'target_margin' as target_margin,
        data->'dailyReports'->0->'data'->>'dianping_rating' as dianping_rating,
        data->'dailyReports'->0->'data'->>'margin' as actual_margin
      FROM hrms_state
    `);
    
    console.log('JSON数据结果:');
    jsonResult.rows.forEach((row, index) => {
      console.log(`记录 ${index + 1}:`);
      console.log(`  目标营业额: ${row.target_revenue}`);
      console.log(`  目标毛利率: ${row.target_margin}%`);
      console.log(`  大众点评星级: ${row.dianping_rating}`);
      console.log(`  实际毛利率: ${row.actual_margin}%`);
      console.log('');
    });
    
    // 2. 检查数据库表数据
    console.log('📊 检查数据库表数据:');
    const tableResult = await dbPool.query(`
      SELECT store, date, actual_revenue, actual_margin, target_revenue, target_margin, dianping_rating
      FROM daily_reports 
      ORDER BY date DESC
    `);
    
    console.log('数据库表结果:');
    tableResult.rows.forEach((row, index) => {
      console.log(`记录 ${index + 1}:`);
      console.log(`  门店: ${row.store}`);
      console.log(`  日期: ${row.date}`);
      console.log(`  目标营业额: ${row.target_revenue}`);
      console.log(`  目标毛利率: ${row.target_margin}%`);
      console.log(`  大众点评星级: ${row.dianping_rating}`);
      console.log(`  实际毛利率: ${row.actual_margin}%`);
      console.log('');
    });
    
    // 3. 检查数据一致性
    console.log('🔍 检查数据一致性:');
    if (jsonResult.rows.length > 0 && tableResult.rows.length > 0) {
      const jsonRow = jsonResult.rows[0];
      const tableRow = tableResult.rows[0];
      
      console.log('JSON vs 数据库表对比:');
      console.log(`目标营业额: JSON=${jsonRow.target_revenue}, 表=${tableRow.target_revenue} ${jsonRow.target_revenue == tableRow.target_revenue ? '✅' : '❌'}`);
      console.log(`目标毛利率: JSON=${jsonRow.target_margin}, 表=${tableRow.target_margin} ${jsonRow.target_margin == tableRow.target_margin ? '✅' : '❌'}`);
      console.log(`大众点评星级: JSON=${jsonRow.dianping_rating}, 表=${tableRow.dianping_rating} ${jsonRow.dianping_rating == tableRow.dianping_rating ? '✅' : '❌'}`);
    }
    
  } catch (error) {
    console.error('❌ 测试失败:', error);
  } finally {
    await dbPool.end();
  }
}

// 运行测试
testDailyReportsData().then(() => {
  console.log('\n✅ 营业日报数据测试完成');
  process.exit(0);
}).catch(error => {
  console.error('❌ 测试异常:', error);
  process.exit(1);
});
