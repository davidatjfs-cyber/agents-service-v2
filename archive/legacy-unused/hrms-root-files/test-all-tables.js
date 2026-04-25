#!/usr/bin/env node

// 测试HRMS与多个飞书表格的连通性
const axios = require('axios');

// 飞书应用配置
const FEISHU_CONFIG = {
  app_id: 'cli_a9fc0d13c838dcd6',
  app_secret: 'pRVuBmiWc0hzqP1YzZDqzGUPFlaProDN'
};

// 表格配置
const TABLE_CONFIGS = {
  closing_reports: {
    name: '收档报告DB',
    app_token: 'PTWrbUdcbarCshst0QncMoY7nKe',
    table_id: 'tblXYfSBRrgNGohN',
    view_id: 'vewYvZudua'
  },
  opening_reports: {
    name: '开档报告',
    app_token: 'PTWrbUdcbarCshst0QncMoY7nKe',
    table_id: 'tbl32E6d0CyvLvfi',
    view_id: 'vewUZZmWnZ'
  },
  meeting_reports: {
    name: '例会报告',
    app_token: 'PTWrbUdcbarCshst0QncMoY7nKe',
    table_id: 'tblZXgaU0LpSye2m',
    view_id: 'vewq7G0SpU'
  },
  material_majixian: {
    name: '马己仙原料收货日报',
    app_token: 'PTWrbUdcbarCshst0QncMoY7nKe',
    table_id: 'tblz4kW1cY22XRlL',
    view_id: 'vewyyTyKf6'
  },
  material_hongchao: {
    name: '洪潮原料收货日报',
    app_token: 'PTWrbUdcbarCshst0QncMoY7nKe',
    table_id: 'tbllcV1evqTJyzlN',
    view_id: 'vewyyTyKf6'
  }
};

// 获取访问令牌
async function getAccessToken() {
  try {
    console.log(`🔐 获取飞书访问令牌...`);
    
    const response = await axios.post('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
      app_id: FEISHU_CONFIG.app_id,
      app_secret: FEISHU_CONFIG.app_secret
    });
    
    if (response.data.code === 0) {
      const token = response.data.tenant_access_token;
      const expires = response.data.expire;
      console.log(`✅ 访问令牌获取成功，有效期: ${expires}秒`);
      return token;
    } else {
      console.error(`❌ 访问令牌获取失败: ${response.data.msg}`);
      return null;
    }
  } catch (error) {
    console.error(`❌ 访问令牌请求异常:`, error.response?.data || error.message);
    return null;
  }
}

// 获取表格数据
async function fetchTableData(tableConfig, accessToken) {
  try {
    console.log(`📊 获取${tableConfig.name}数据...`);
    console.log(`   Table ID: ${tableConfig.table_id}`);
    
    const url = `https://open.feishu.cn/open-apis/bitable/v1/apps/${tableConfig.app_token}/tables/${tableConfig.table_id}/records`;
    
    const params = {
      page_size: 10
    };
    
    // 如果有视图ID，添加视图参数
    if (tableConfig.view_id) {
      params.view_id = tableConfig.view_id;
    }
    
    const response = await axios.get(url, {
      headers: {
        'Authorization': `Bearer ${accessToken}`
      },
      params
    });
    
    if (response.data.code === 0) {
      const data = response.data.data;
      console.log(`✅ ${tableConfig.name}数据获取成功!`);
      console.log(`   总记录数: ${data.total}`);
      console.log(`   当前页记录数: ${data.items?.length || 0}`);
      
      return { success: true, data };
    } else {
      console.error(`❌ ${tableConfig.name}数据获取失败: ${response.data.msg}`);
      return { success: false, error: response.data.msg };
    }
  } catch (error) {
    console.error(`❌ ${tableConfig.name}数据请求异常:`, error.response?.data || error.message);
    return { success: false, error: error.message };
  }
}

// 获取表格字段信息
async function fetchTableFields(tableConfig, accessToken) {
  try {
    console.log(`🔍 获取${tableConfig.name}字段信息...`);
    
    const url = `https://open.feishu.cn/open-apis/bitable/v1/apps/${tableConfig.app_token}/tables/${tableConfig.table_id}/fields`;
    
    const response = await axios.get(url, {
      headers: {
        'Authorization': `Bearer ${accessToken}`
      }
    });
    
    if (response.data.code === 0) {
      const fields = response.data.data.items || [];
      console.log(`✅ ${tableConfig.name}字段获取成功!`);
      console.log(`   字段总数: ${fields.length}`);
      
      // 显示主要字段
      const mainFields = fields.slice(0, 8);
      console.log(`   主要字段:`);
      mainFields.forEach((field, index) => {
        console.log(`     ${index + 1}. ${field.field_name} (${field.type})`);
      });
      
      if (fields.length > 8) {
        console.log(`     ... 还有${fields.length - 8}个字段`);
      }
      
      return { success: true, fields };
    } else {
      console.error(`❌ ${tableConfig.name}字段获取失败: ${response.data.msg}`);
      return { success: false, error: response.data.msg };
    }
  } catch (error) {
    console.error(`❌ ${tableConfig.name}字段请求异常:`, error.response?.data || error.message);
    return { success: false, error: error.message };
  }
}

// 显示示例数据
function showSampleData(tableName, records) {
  if (!records || records.length === 0) {
    console.log(`   📝 暂无数据示例`);
    return;
  }
  
  console.log(`   📝 示例数据 (前2条):`);
  
  records.slice(0, 2).forEach((record, index) => {
    console.log(`     记录${index + 1}: ${record.record_id}`);
    
    const fields = record.fields || {};
    const sampleFields = Object.keys(fields).slice(0, 4);
    
    sampleFields.forEach(fieldName => {
      let value = fields[fieldName];
      
      if (Array.isArray(value)) {
        if (value.length > 0 && value[0].text) {
          value = value[0].text;
        } else if (value.length > 0 && typeof value[0] === 'string') {
          value = value[0];
        } else {
          value = JSON.stringify(value);
        }
      } else if (typeof value === 'object' && value !== null) {
        value = JSON.stringify(value).substring(0, 50) + '...';
      } else if (typeof value === 'string' && value.length > 30) {
        value = value.substring(0, 30) + '...';
      }
      
      console.log(`       ${fieldName}: ${value}`);
    });
    console.log(``);
  });
}

// 测试单个表格
async function testTable(tableKey, tableConfig, accessToken) {
  console.log(`\n🔍 测试表格: ${tableConfig.name}`);
  console.log(`─`.repeat(50));
  
  // 1. 获取字段信息
  const fieldResult = await fetchTableFields(tableConfig, accessToken);
  
  // 2. 获取数据
  const dataResult = await fetchTableData(tableConfig, accessToken);
  
  // 3. 显示示例数据
  if (dataResult.success && dataResult.data?.items) {
    showSampleData(tableConfig.name, dataResult.data.items);
  }
  
  return {
    table: tableConfig.name,
    fields: fieldResult.success ? fieldResult.fields?.length || 0 : 0,
    records: dataResult.success ? dataResult.data?.total || 0 : 0,
    success: fieldResult.success && dataResult.success,
    errors: [
      ...(fieldResult.success ? [] : [fieldResult.error]),
      ...(dataResult.success ? [] : [dataResult.error])
    ]
  };
}

// 主测试函数
async function runAllTablesTest() {
  console.log(`🚀 开始测试HRMS与多个飞书表格的连通性`);
  console.log(`📅 测试时间: ${new Date().toLocaleString('zh-CN')}`);
  console.log(`🎯 目标应用: cli_a9fc0d13c838dcd6`);
  console.log(`📋 测试表格: 5个`);
  console.log(``);
  
  // 获取访问令牌
  const accessToken = await getAccessToken();
  if (!accessToken) {
    console.log(`\n❌ 测试失败: 无法获取访问令牌`);
    process.exit(1);
  }
  
  // 测试结果汇总
  const results = [];
  
  // 逐个测试表格
  for (const [tableKey, tableConfig] of Object.entries(TABLE_CONFIGS)) {
    const result = await testTable(tableKey, tableConfig, accessToken);
    results.push(result);
  }
  
  // 汇总报告
  console.log(`\n` + `=`.repeat(60));
  console.log(`📊 测试结果汇总`);
  console.log(`=`.repeat(60));
  
  const successCount = results.filter(r => r.success).length;
  const totalCount = results.length;
  
  console.log(`\n📈 整体情况: ${successCount}/${totalCount} 个表格连通正常`);
  
  results.forEach(result => {
    const status = result.success ? '✅' : '❌';
    console.log(`${status} ${result.table}:`);
    console.log(`   字段数: ${result.fields}, 记录数: ${result.records}`);
    
    if (result.errors.length > 0) {
      result.errors.forEach(error => {
        console.log(`   错误: ${error}`);
      });
    }
  });
  
  // 最终结论
  console.log(`\n` + `─`.repeat(60));
  if (successCount === totalCount) {
    console.log(`🎉 所有表格测试成功! HRMS与飞书多维表格连通性完全正常`);
    console.log(`✅ 可以正常进行数据同步和分析工作`);
  } else if (successCount > 0) {
    console.log(`⚠️  部分表格测试成功! ${successCount}/${totalCount} 个表格可用`);
    console.log(`💡 建议检查失败表格的权限或配置`);
  } else {
    console.log(`❌ 所有表格测试失败! 连通性存在严重问题`);
    console.log(`💡 建议检查应用权限、网络连接或配置信息`);
  }
  
  console.log(`\n📋 详细统计:`);
  const totalRecords = results.reduce((sum, r) => sum + r.records, 0);
  const totalFields = results.reduce((sum, r) => sum + r.fields, 0);
  console.log(`   总记录数: ${totalRecords}`);
  console.log(`   总字段数: ${totalFields}`);
  console.log(`   测试时间: ${new Date().toLocaleString('zh-CN')}`);
}

// 运行测试
runAllTablesTest().catch(console.error);
