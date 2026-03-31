/**
 * 评分模型测试脚本
 */

import { calculateStoreRating, calculateEmployeeScore } from './new-scoring-model.js';
import { pool, setPool } from './utils/database.js';
import { Pool } from 'pg';

async function testScoring() {
  console.log('🧪 开始测试评分模型...\n');
  
  // 设置数据库连接
  const dbPool = new Pool({
    connectionString: process.env.DATABASE_URL
  });
  setPool(dbPool);
  
  try {
    // 测试门店评级
    console.log('📊 测试门店评级:');
    const storeRating = await calculateStoreRating('洪潮久光店', '洪潮', '2026-02');
    console.log('门店评级结果:', storeRating);
    
    // 测试员工评分
    console.log('\n👥 测试员工评分:');
    const employeeScore = await calculateEmployeeScore('洪潮久光店', 'test_manager', 'store_manager', '2026-02');
    console.log('员工评分结果:', employeeScore);
    
    // 测试数据查询
    console.log('\n🔍 验证数据完整性:');
    const dailyReport = await pool().query(`
      SELECT * FROM daily_reports 
      WHERE store = '洪潮久光店' AND date = '2026-02-20'
    `);
    console.log('营业日报数据:', dailyReport.rows[0]);
    
    const revenueTarget = await pool().query(`
      SELECT * FROM revenue_targets 
      WHERE store = '洪潮久光店' AND period = '2026-02'
    `);
    console.log('营业目标数据:', revenueTarget.rows[0]);
    
    const marginTarget = await pool().query(`
      SELECT * FROM margin_targets 
      WHERE store = '洪潮久光店' AND period = '2026-02'
    `);
    console.log('毛利率目标数据:', marginTarget.rows[0]);
    
  } catch (error) {
    console.error('❌ 测试失败:', error);
  } finally {
    await dbPool.end();
  }
}

// 运行测试
testScoring().then(() => {
  console.log('\n✅ 测试完成');
  process.exit(0);
}).catch(error => {
  console.error('❌ 测试异常:', error);
  process.exit(1);
});
