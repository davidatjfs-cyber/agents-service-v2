/**
 * 检查错误统计和飞书消息状态
 */

import { getErrorStats } from './utils/error-handler.js';
import { pool } from './utils/database.js';
import { Pool } from 'pg';

async function checkSystemStatus() {
  console.log('🔍 检查系统状态...\n');
  
  // 设置数据库连接
  const dbPool = new Pool({
    connectionString: process.env.DATABASE_URL
  });
  
  try {
    // 1. 检查错误统计
    console.log('📊 错误统计:');
    const errorStats = getErrorStats();
    console.log('总错误数:', errorStats.total);
    console.log('错误类型:', errorStats.byType);
    console.log('最近错误:', errorStats.recent.slice(0, 3));
    
    // 2. 检查飞书消息记录
    console.log('\n📱 飞书消息记录:');
    const larkMessages = await dbPool.query(`
      SELECT COUNT(*) as count, 
             MIN(created_at) as earliest,
             MAX(created_at) as latest
      FROM lark_messages 
      WHERE created_at >= NOW() - INTERVAL '1 hour'
    `);
    
    console.log('最近1小时消息数:', larkMessages.rows[0]?.count || 0);
    console.log('最早消息:', larkMessages.rows[0]?.earliest);
    console.log('最新消息:', larkMessages.rows[0]?.latest);
    
    // 3. 检查agent问题
    console.log('\n🤖 Agent问题记录:');
    const agentIssues = await dbPool.query(`
      SELECT COUNT(*) as count,
             COUNT(*) FILTER (WHERE status = 'open') as open_count
      FROM agent_issues 
      WHERE created_at >= NOW() - INTERVAL '1 hour'
    `);
    
    console.log('最近1小时问题数:', agentIssues.rows[0]?.count || 0);
    console.log('未解决问题数:', agentIssues.rows[0]?.open_count || 0);
    
    // 4. 检查master_events
    console.log('\n📋 Master事件记录:');
    const masterEvents = await dbPool.query(`
      SELECT COUNT(*) as count,
             type,
             COUNT(*) FILTER (WHERE data->>'error' IS NOT NULL) as error_count
      FROM master_events 
      WHERE created_at >= NOW() - INTERVAL '1 hour'
      GROUP BY type
    `);
    
    masterEvents.rows.forEach(row => {
      console.log(`${row.type}: ${row.count} 条, 错误: ${row.error_count} 条`);
    });
    
  } catch (error) {
    console.error('❌ 检查失败:', error);
  } finally {
    await dbPool.end();
  }
}

// 运行检查
checkSystemStatus().then(() => {
  console.log('\n✅ 系统状态检查完成');
  process.exit(0);
}).catch(error => {
  console.error('❌ 检查异常:', error);
  process.exit(1);
});
