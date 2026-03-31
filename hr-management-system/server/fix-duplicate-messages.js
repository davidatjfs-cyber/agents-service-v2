/**
 * 修复重复消息问题
 */

import { pool } from './utils/database.js';
import { Pool } from 'pg';

async function fixDuplicateMessages() {
  console.log('🔧 修复重复消息问题...\n');
  
  // 设置数据库连接
  const dbPool = new Pool({
    connectionString: process.env.DATABASE_URL
  });
  
  try {
    // 1. 检查最近的重复消息
    console.log('📊 检查最近的重复消息:');
    const recentMessages = await dbPool.query(`
      SELECT content, COUNT(*) as count, 
             MIN(created_at) as first_seen,
             MAX(created_at) as last_seen
      FROM agent_messages 
      WHERE created_at >= NOW() - INTERVAL '2 hours'
      GROUP BY content 
      HAVING COUNT(*) > 3
      ORDER BY count DESC
    `);
    
    console.log('重复消息统计:');
    recentMessages.rows.forEach(row => {
      console.log(`- ${row.content}: ${row.count} 次`);
      console.log(`  首次: ${row.first_seen}`);
      console.log(`  最后: ${row.last_seen}`);
    });
    
    // 2. 检查是否有重复的图片审核任务
    console.log('\n🔍 检查图片审核任务:');
    const auditTasks = await dbPool.query(`
      SELECT COUNT(*) as count,
             status,
             created_at
      FROM agent_visual_audits 
      WHERE created_at >= NOW() - INTERVAL '2 hours'
      GROUP BY status, created_at
      ORDER BY created_at DESC
      LIMIT 10
    `);
    
    console.log('图片审核任务:');
    auditTasks.rows.forEach(row => {
      console.log(`- ${row.status}: ${row.count} 个 (${row.created_at})`);
    });
    
    // 3. 检查master_events中的错误
    console.log('\n📋 检查Master事件:');
    const masterEvents = await dbPool.query(`
      SELECT COUNT(*) as count,
             type,
             data->>'error' as error
      FROM master_events 
      WHERE created_at >= NOW() - INTERVAL '2 hours'
        AND data->>'error' IS NOT NULL
      GROUP BY type, data->>'error'
      ORDER BY count DESC
    `);
    
    console.log('Master错误事件:');
    masterEvents.rows.forEach(row => {
      console.log(`- ${row.type}: ${row.count} 次`);
      console.log(`  错误: ${row.error}`);
    });
    
    // 4. 检查定时任务状态
    console.log('\n⏰ 检查定时任务状态:');
    const scheduledTasks = await dbPool.query(`
      SELECT task_type, status, last_run, next_run
      FROM scheduled_tasks 
      WHERE last_run >= NOW() - INTERVAL '2 hours'
      ORDER BY last_run DESC
    `);
    
    console.log('定时任务:');
    scheduledTasks.rows.forEach(row => {
      console.log(`- ${row.task_type}: ${row.status}`);
      console.log(`  上次运行: ${row.last_run}`);
      console.log(`  下次运行: ${row.next_run}`);
    });
    
  } catch (error) {
    console.error('❌ 修复失败:', error);
  } finally {
    await dbPool.end();
  }
}

// 运行修复
fixDuplicateMessages().then(() => {
  console.log('\n✅ 重复消息问题诊断完成');
  process.exit(0);
}).catch(error => {
  console.error('❌ 修复异常:', error);
  process.exit(1);
});
