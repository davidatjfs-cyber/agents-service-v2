#!/usr/bin/env node

// 测试HRMS数据提取功能
const axios = require('axios');

// 模拟HRMS服务器的数据提取函数
async function testHRMSDataExtraction() {
  console.log(`🔧 测试HRMS内置数据提取功能...`);
  
  try {
    // 这里我们直接调用agents.js中的函数
    // 首先需要加载环境变量
    require('dotenv').config();
    
    // 动态导入agents模块
    const { getBitableRecords } = require('./server/agents.js');
    
    console.log(`📊 提取桌访表数据...`);
    
    const result = await getBitableRecords('table_visit', {
      page_size: 10
    });
    
    if (result.ok) {
      console.log(`✅ 数据提取成功!`);
      console.log(`   记录数: ${result.records?.length || 0}`);
      console.log(`   总数: ${result.total}`);
      console.log(`   是否有更多: ${result.hasMore}`);
      
      // 显示一些示例数据
      if (result.records && result.records.length > 0) {
        console.log(`\n📋 示例数据:`);
        result.records.slice(0, 3).forEach((record, index) => {
          console.log(`   记录${index + 1}: ${record.record_id}`);
          
          const fields = record.fields || {};
          const keyFields = ['日期', '所属门店', '所属品牌', '桌号', '人数', '消费金额'];
          
          keyFields.forEach(field => {
            if (fields[field]) {
              let value = fields[field];
              if (Array.isArray(value) && value[0]?.text) {
                value = value[0].text;
              } else if (typeof value === 'object' && value !== null) {
                value = JSON.stringify(value);
              }
              console.log(`     ${field}: ${value}`);
            }
          });
          console.log(``);
        });
      }
      
      return { success: true, result };
    } else {
      console.error(`❌ 数据提取失败: ${result.error}`);
      return { success: false, error: result.error };
    }
  } catch (error) {
    console.error(`❌ 数据提取异常:`, error.message);
    return { success: false, error: error.message };
  }
}

// 测试特定日期范围的数据
async function testDateRangeExtraction() {
  console.log(`📅 测试日期范围数据提取...`);
  
  try {
    require('dotenv').config();
    const { getBitableRecords } = require('./server/agents.js');
    
    // 获取最近7天的数据
    const today = new Date();
    const sevenDaysAgo = new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000);
    
    console.log(`   查询时间范围: ${sevenDaysAgo.toLocaleDateString('zh-CN')} - ${today.toLocaleDateString('zh-CN')}`);
    
    // 这里可以添加过滤条件，但需要根据实际API支持情况
    const result = await getBitableRecords('table_visit', {
      page_size: 20
    });
    
    if (result.ok && result.records) {
      // 过滤最近7天的数据
      const recentRecords = result.records.filter(record => {
        const dateField = record.fields?.['日期'];
        if (!dateField || !Array.isArray(dateField) || !dateField[0]?.text) {
          return false;
        }
        
        const recordDate = new Date(dateField[0].text);
        return recordDate >= sevenDaysAgo && recordDate <= today;
      });
      
      console.log(`✅ 最近7天数据: ${recentRecords.length}条`);
      
      if (recentRecords.length > 0) {
        // 按门店分组统计
        const storeStats = {};
        recentRecords.forEach(record => {
          const store = record.fields?.['所属门店'];
          if (store && Array.isArray(store) && store[0]?.text) {
            const storeName = store[0].text;
            storeStats[storeName] = (storeStats[storeName] || 0) + 1;
          }
        });
        
        console.log(`\n📊 门店统计 (最近7天):`);
        Object.entries(storeStats).forEach(([store, count]) => {
          console.log(`   ${store}: ${count}条`);
        });
      }
      
      return { success: true, recentRecords: recentRecords.length };
    } else {
      return { success: false, error: result?.error || 'Unknown error' };
    }
  } catch (error) {
    console.error(`❌ 日期范围提取异常:`, error.message);
    return { success: false, error: error.message };
  }
}

// 主测试函数
async function runExtractionTest() {
  console.log(`🚀 开始测试HRMS数据提取功能`);
  console.log(`📅 测试时间: ${new Date().toLocaleString('zh-CN')}`);
  console.log(``);
  
  // 1. 测试基本数据提取
  const basicResult = await testHRMSDataExtraction();
  
  console.log(``);
  
  // 2. 测试日期范围数据提取
  const dateResult = await testDateRangeExtraction();
  
  console.log(``);
  
  // 3. 总结
  if (basicResult.success && dateResult.success) {
    console.log(`🎉 数据提取测试成功!`);
    console.log(`✅ 基本数据提取正常`);
    console.log(`✅ 日期范围过滤正常 (最近7天${dateResult.recentRecords}条记录)`);
    console.log(`\n💡 HRMS系统可以正常从飞书多维表格提取和分析数据`);
  } else {
    console.log(`❌ 数据提取测试失败!`);
    if (!basicResult.success) {
      console.log(`❌ 基本数据提取失败: ${basicResult.error}`);
    }
    if (!dateResult.success) {
      console.log(`❌ 日期范围提取失败: ${dateResult.error}`);
    }
  }
}

// 运行测试
runExtractionTest().catch(console.error);
