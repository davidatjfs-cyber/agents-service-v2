#!/usr/bin/env node

// 测试马己仙原料收货日报表格
const axios = require('axios');

// 从URL解析的配置
const TABLE_CONFIG = {
  name: '马己仙原料收货日报',
  app_token: 'PTWrbUdcbarCshst0QncMoY7nKe',
  table_id: 'tblz4kW1cY22XRlL',
  view_id: 'vewyyTyKf6'
};

// 飞书应用配置
const APP_CONFIG = {
  app_id: 'cli_a9fc0d13c838dcd6',
  app_secret: 'pRVuBmiWc0hzqP1YzZDqzGUPFlaProDN'
};

// 获取访问令牌
async function getAccessToken() {
  try {
    console.log(`🔐 获取飞书访问令牌...`);
    
    const response = await axios.post('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
      app_id: APP_CONFIG.app_id,
      app_secret: APP_CONFIG.app_secret
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

// 测试表格字段
async function testTableFields(accessToken) {
  try {
    console.log(`🔍 获取${TABLE_CONFIG.name}字段信息...`);
    
    const url = `https://open.feishu.cn/open-apis/bitable/v1/apps/${TABLE_CONFIG.app_token}/tables/${TABLE_CONFIG.table_id}/fields`;
    
    const response = await axios.get(url, {
      headers: {
        'Authorization': `Bearer ${accessToken}`
      }
    });
    
    if (response.data.code === 0) {
      const fields = response.data.data.items || [];
      console.log(`✅ 字段获取成功! 总数: ${fields.length}`);
      
      console.log(`\n📝 字段列表:`);
      fields.forEach((field, index) => {
        console.log(`   ${index + 1}. ${field.field_name} (${field.type})`);
      });
      
      return { success: true, fields };
    } else {
      console.error(`❌ 字段获取失败: ${response.data.msg}`);
      return { success: false, error: response.data.msg };
    }
  } catch (error) {
    console.error(`❌ 字段请求异常:`, error.response?.data || error.message);
    return { success: false, error: error.message };
  }
}

// 测试表格数据
async function testTableData(accessToken) {
  try {
    console.log(`\n📊 获取${TABLE_CONFIG.name}数据...`);
    
    const url = `https://open.feishu.cn/open-apis/bitable/v1/apps/${TABLE_CONFIG.app_token}/tables/${TABLE_CONFIG.table_id}/records`;
    
    const params = {
      page_size: 10
    };
    
    // 添加视图ID
    if (TABLE_CONFIG.view_id) {
      params.view_id = TABLE_CONFIG.view_id;
      console.log(`   使用视图: ${TABLE_CONFIG.view_id}`);
    }
    
    const response = await axios.get(url, {
      headers: {
        'Authorization': `Bearer ${accessToken}`
      },
      params
    });
    
    if (response.data.code === 0) {
      const data = response.data.data;
      console.log(`✅ 数据获取成功!`);
      console.log(`   总记录数: ${data.total}`);
      console.log(`   当前页记录数: ${data.items?.length || 0}`);
      
      if (data.items && data.items.length > 0) {
        console.log(`\n📋 示例记录:`);
        data.items.slice(0, 3).forEach((record, index) => {
          console.log(`\n   记录${index + 1}: ${record.record_id}`);
          
          const fields = record.fields || {};
          const fieldNames = Object.keys(fields);
          
          // 显示前8个字段
          fieldNames.slice(0, 8).forEach(fieldName => {
            let value = fields[fieldName];
            
            if (Array.isArray(value)) {
              if (value.length > 0 && value[0]?.text) {
                value = value[0].text;
              } else if (value.length > 0 && typeof value[0] === 'string') {
                value = value[0];
              } else if (value.length > 0) {
                value = JSON.stringify(value[0]);
              } else {
                value = '[]';
              }
            } else if (typeof value === 'object' && value !== null) {
              value = JSON.stringify(value).substring(0, 50) + '...';
            } else if (typeof value === 'string' && value.length > 30) {
              value = value.substring(0, 30) + '...';
            }
            
            console.log(`     ${fieldName}: ${value}`);
          });
          
          if (fieldNames.length > 8) {
            console.log(`     ... 还有${fieldNames.length - 8}个字段`);
          }
        });
      }
      
      return { success: true, data };
    } else {
      console.error(`❌ 数据获取失败: ${response.data.msg}`);
      return { success: false, error: response.data.msg };
    }
  } catch (error) {
    console.error(`❌ 数据请求异常:`, error.response?.data || error.message);
    return { success: false, error: error.message };
  }
}

// 测试不同视图
async function testWithoutView(accessToken) {
  try {
    console.log(`\n🔄 测试不使用视图获取数据...`);
    
    const url = `https://open.feishu.cn/open-apis/bitable/v1/apps/${TABLE_CONFIG.app_token}/tables/${TABLE_CONFIG.table_id}/records`;
    
    const response = await axios.get(url, {
      headers: {
        'Authorization': `Bearer ${accessToken}`
      },
      params: {
        page_size: 5
      }
    });
    
    if (response.data.code === 0) {
      const data = response.data.data;
      console.log(`✅ 无视图数据获取成功! 总记录数: ${data.total}`);
      return { success: true, total: data.total };
    } else {
      console.error(`❌ 无视图数据获取失败: ${response.data.msg}`);
      return { success: false, error: response.data.msg };
    }
  } catch (error) {
    console.error(`❌ 无视图数据请求异常:`, error.response?.data || error.message);
    return { success: false, error: error.message };
  }
}

// 主测试函数
async function runMajixianTest() {
  console.log(`🚀 开始测试马己仙原料收货日报表格`);
  console.log(`📅 测试时间: ${new Date().toLocaleString('zh-CN')}`);
  console.log(`🎯 目标表格: ${TABLE_CONFIG.name}`);
  console.log(`🔗 表格URL: https://qcniocx2wuu8.feishu.cn/base/${TABLE_CONFIG.app_token}?table=${TABLE_CONFIG.table_id}&view=${TABLE_CONFIG.view_id}`);
  console.log(``);
  
  // 获取访问令牌
  const accessToken = await getAccessToken();
  if (!accessToken) {
    console.log(`\n❌ 测试失败: 无法获取访问令牌`);
    process.exit(1);
  }
  
  let successCount = 0;
  let totalTests = 0;
  
  // 1. 测试字段信息
  console.log(`\n` + `─`.repeat(60));
  const fieldResult = await testTableFields(accessToken);
  totalTests++;
  if (fieldResult.success) successCount++;
  
  // 2. 测试带视图的数据
  console.log(`\n` + `─`.repeat(60));
  const dataResult = await testTableData(accessToken);
  totalTests++;
  if (dataResult.success) successCount++;
  
  // 3. 测试不带视图的数据
  console.log(`\n` + `─`.repeat(60));
  const noViewResult = await testWithoutView(accessToken);
  totalTests++;
  if (noViewResult.success) successCount++;
  
  // 汇总结果
  console.log(`\n` + `=`.repeat(60));
  console.log(`📊 测试结果汇总`);
  console.log(`=`.repeat(60));
  
  console.log(`\n📈 测试通过率: ${successCount}/${totalTests} (${((successCount/totalTests)*100).toFixed(1)}%)`);
  
  if (successCount === totalTests) {
    console.log(`🎉 所有测试通过! 马己仙原料收货日报表格连通性正常`);
    console.log(`✅ HRMS系统可以正常提取和分析该表格数据`);
  } else if (successCount > 0) {
    console.log(`⚠️  部分测试通过! 连通性存在问题但仍有可用功能`);
  } else {
    console.log(`❌ 所有测试失败! 表格无法访问`);
    console.log(`💡 建议: 检查应用权限、表格配置或联系飞书管理员`);
  }
  
  console.log(`\n🔧 详细结果:`);
  console.log(`   字段信息: ${fieldResult.success ? '✅' : '❌'}`);
  console.log(`   带视图数据: ${dataResult.success ? '✅' : '❌'}`);
  console.log(`   无视图数据: ${noViewResult.success ? '✅' : '❌'}`);
  
  if (fieldResult.success) {
    console.log(`   字段数量: ${fieldResult.fields?.length || 0}`);
  }
  if (dataResult.success) {
    console.log(`   记录数量: ${dataResult.data?.total || 0}`);
  }
  if (noViewResult.success) {
    console.log(`   无视图记录数: ${noViewResult.total || 0}`);
  }
}

// 运行测试
runMajixianTest().catch(console.error);
