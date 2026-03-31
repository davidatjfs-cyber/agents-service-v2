/**
 * 飞书同步测试脚本
 */

import { getFeishuAccessToken, fetchTableRecords } from './feishu-sync.js';
import { Pool } from 'pg';

async function testFeishuSync() {
  console.log('🧪 开始测试飞书同步...\n');
  
  // 设置数据库连接
  const dbPool = new Pool({
    connectionString: process.env.DATABASE_URL
  });
  
  try {
    // 测试获取访问令牌
    console.log('🔑 测试获取飞书访问令牌:');
    const accessToken = await getFeishuAccessToken();
    console.log('✅ 访问令牌获取成功:', accessToken ? '成功' : '失败');
    
    // 测试获取表格数据
    console.log('\n📊 测试获取收档报告数据:');
    const closingReports = await fetchTableRecords({
      app_token: 'PTWrbUdcbarCshst0QncMoY7nKe',
      table_id: 'tblXYfSBRrgNGohN',
      view_id: 'vewYvZudua'
    }, accessToken);
    console.log(`✅ 收档报告数据: ${closingReports.length} 条记录`);
    
    if (closingReports.length > 0) {
      console.log('📋 第一条记录示例:', {
        record_id: closingReports[0].record_id,
        fields: Object.keys(closingReports[0].fields).slice(0, 5)
      });
    }
    
    console.log('\n📊 测试获取开档报告数据:');
    const openingReports = await fetchTableRecords({
      app_token: 'PTWrbUdcbarCshst0QncMoY7nKe',
      table_id: 'tbl32E6d0CyvLvfi',
      view_id: 'vewUZZmWnZ'
    }, accessToken);
    console.log(`✅ 开档报告数据: ${openingReports.length} 条记录`);
    
    console.log('\n📊 测试获取例会报告数据:');
    const meetingReports = await fetchTableRecords({
      app_token: 'PTWrbUdcbarCshst0QncMoY7nKe',
      table_id: 'tblZXgaU0LpSye2m',
      view_id: 'vewq7G0SpU'
    }, accessToken);
    console.log(`✅ 例会报告数据: ${meetingReports.length} 条记录`);
    
    console.log('\n📊 测试获取马己仙原料收货日报:');
    const majixianReports = await fetchTableRecords({
      app_token: 'PTWrbUdcbarCshst0QncMoY7nKe',
      table_id: 'tblz4kW1cY22XRlL',
      view_id: 'vewyyTyKf6'
    }, accessToken);
    console.log(`✅ 马己仙原料收货日报: ${majixianReports.length} 条记录`);
    
    console.log('\n📊 测试获取洪潮原料收货日报:');
    const hongchaoReports = await fetchTableRecords({
      app_token: 'PTWrbUdcbarCshst0QncMoY7nKe',
      table_id: 'tbllcV1evqTJyzlN',
      view_id: 'vewyyTyKf6'
    }, accessToken);
    console.log(`✅ 洪潮原料收货日报: ${hongchaoReports.length} 条记录`);
    
  } catch (error) {
    console.error('❌ 测试失败:', error);
  } finally {
    await dbPool.end();
  }
}

// 运行测试
testFeishuSync().then(() => {
  console.log('\n✅ 飞书同步测试完成');
  process.exit(0);
}).catch(error => {
  console.error('❌ 测试异常:', error);
  process.exit(1);
});
