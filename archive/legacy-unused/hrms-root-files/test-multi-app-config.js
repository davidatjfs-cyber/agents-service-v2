#!/usr/bin/env node

// 测试多个飞书应用配置的连通性
const axios = require('axios');

// 可能的应用配置
const APP_CONFIGS = {
  app1: {
    name: '应用1 (cli_a9fc0d13c838dcd6)',
    app_id: 'cli_a9fc0d13c838dcd6',
    app_secret: 'pRVuBmiWc0hzqP1YzZDqzGUPFlaProDN'
  },
  app2: {
    name: '应用2 (cli_a91dae9f9578dcb1)',
    app_id: 'cli_a91dae9f9578dcb1',
    app_secret: 'sjpAzPwu4KixvhbAOD7w4ee1oEKRRBQF'
  }
};

// 需要测试的表格
const TABLES_TO_TEST = [
  {
    name: '收档报告DB',
    app_token: 'PTWrbUdcbarCshst0QncMoY7nKe',
    table_id: 'tblXYfSBRrgNGohN',
    view_id: 'vewYvZudua'
  },
  {
    name: '开档报告',
    app_token: 'PTWrbUdcbarCshst0QncMoY7nKe',
    table_id: 'tbl32E6d0CyvLvfi',
    view_id: 'vewUZZmWnZ'
  },
  {
    name: '例会报告',
    app_token: 'PTWrbUdcbarCshst0QncMoY7nKe',
    table_id: 'tblZXgaU0LpSye2m',
    view_id: 'vewq7G0SpU'
  },
  {
    name: '马己仙原料收货日报',
    app_token: 'PTWrbUdcbarCshst0QncMoY7nKe',
    table_id: 'tblz4kW1cY22XRlL',
    view_id: 'vewyyTyKf6'
  },
  {
    name: '洪潮原料收货日报',
    app_token: 'PTWrbUdcbarCshst0QncMoY7nKe',
    table_id: 'tbllcV1evqTJyzlN',
    view_id: 'vewyyTyKf6'
  }
];

// 获取访问令牌
async function getAccessToken(appConfig) {
  try {
    console.log(`🔐 获取${appConfig.name}的访问令牌...`);
    
    const response = await axios.post('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
      app_id: appConfig.app_id,
      app_secret: appConfig.app_secret
    });
    
    if (response.data.code === 0) {
      const token = response.data.tenant_access_token;
      console.log(`✅ ${appConfig.name}访问令牌获取成功`);
      return token;
    } else {
      console.error(`❌ ${appConfig.name}访问令牌获取失败: ${response.data.msg}`);
      return null;
    }
  } catch (error) {
    console.error(`❌ ${appConfig.name}访问令牌请求异常:`, error.response?.data || error.message);
    return null;
  }
}

// 测试表格访问
async function testTableAccess(appConfig, accessToken, table) {
  try {
    console.log(`📊 使用${appConfig.name}测试${table.name}...`);
    
    const url = `https://open.feishu.cn/open-apis/bitable/v1/apps/${table.app_token}/tables/${table.table_id}/records`;
    
    const params = {
      page_size: 1
    };
    
    if (table.view_id) {
      params.view_id = table.view_id;
    }
    
    const response = await axios.get(url, {
      headers: {
        'Authorization': `Bearer ${accessToken}`
      },
      params
    });
    
    if (response.data.code === 0) {
      const total = response.data.data?.total || 0;
      console.log(`✅ ${appConfig.name}可以访问${table.name} (总记录数: ${total})`);
      return { success: true, total };
    } else {
      console.error(`❌ ${appConfig.name}无法访问${table.name}: ${response.data.msg}`);
      return { success: false, error: response.data.msg };
    }
  } catch (error) {
    console.error(`❌ ${appConfig.name}访问${table.name}异常:`, error.response?.data || error.message);
    return { success: false, error: error.message };
  }
}

// 主测试函数
async function runMultiAppTest() {
  console.log(`🚀 开始测试多应用配置连通性`);
  console.log(`📅 测试时间: ${new Date().toLocaleString('zh-CN')}`);
  console.log(`📋 测试表格: ${TABLES_TO_TEST.length}个`);
  console.log(`🔧 测试应用: ${Object.keys(APP_CONFIGS).length}个`);
  console.log(``);
  
  const results = {};
  
  // 为每个应用获取令牌并测试
  for (const [appKey, appConfig] of Object.entries(APP_CONFIGS)) {
    console.log(`\n` + `=`.repeat(60));
    console.log(`🔧 测试应用: ${appConfig.name}`);
    console.log(`=`.repeat(60));
    
    const accessToken = await getAccessToken(appConfig);
    if (!accessToken) {
      console.log(`❌ ${appConfig.name}无法获取访问令牌，跳过测试`);
      continue;
    }
    
    results[appKey] = {
      appName: appConfig.name,
      tables: {},
      successCount: 0,
      totalCount: 0
    };
    
    // 测试每个表格
    for (const table of TABLES_TO_TEST) {
      const result = await testTableAccess(appConfig, accessToken, table);
      results[appKey].tables[table.name] = result;
      results[appKey].totalCount++;
      if (result.success) {
        results[appKey].successCount++;
      }
    }
  }
  
  // 汇总报告
  console.log(`\n` + `=`.repeat(80));
  console.log(`📊 多应用测试结果汇总`);
  console.log(`=`.repeat(80));
  
  console.log(`\n📈 应用访问能力:`);
  for (const [appKey, appResult] of Object.entries(results)) {
    const rate = appResult.successCount / appResult.totalCount;
    console.log(`${appResult.appName}: ${appResult.successCount}/${appResult.totalCount} 表格可访问 (${(rate * 100).toFixed(1)}%)`);
  }
  
  console.log(`\n📋 表格访问矩阵:`);
  console.log(`表格名称`.padEnd(20) + Object.keys(APP_CONFIGS).map(k => APP_CONFIGS[k].name).join(' | '));
  console.log(`-`.repeat(20 + Object.keys(APP_CONFIGS).length * 25));
  
  for (const table of TABLES_TO_TEST) {
    const row = [table.name.padEnd(20)];
    for (const appKey of Object.keys(APP_CONFIGS)) {
      const result = results[appKey]?.tables[table.name];
      const status = result?.success ? '✅' : '❌';
      const info = result?.success ? `(${result.total})` : '';
      row.push(`${status} ${info}`.padEnd(23));
    }
    console.log(row.join(' | '));
  }
  
  // 推荐配置
  console.log(`\n💡 推荐配置:`);
  let bestApp = null;
  let bestSuccessRate = 0;
  
  for (const [appKey, appResult] of Object.entries(results)) {
    const rate = appResult.successCount / appResult.totalCount;
    if (rate > bestSuccessRate) {
      bestSuccessRate = rate;
      bestApp = appResult.appName;
    }
  }
  
  if (bestApp && bestSuccessRate > 0) {
    console.log(`🎯 推荐使用: ${bestApp} (成功率: ${(bestSuccessRate * 100).toFixed(1)}%)`);
    
    // 显示该应用可以访问的表格
    const bestAppKey = Object.keys(results).find(k => results[k].appName === bestApp);
    const accessibleTables = Object.entries(results[bestAppKey].tables)
      .filter(([name, result]) => result.success)
      .map(([name]) => name);
    
    console.log(`📋 可访问表格: ${accessibleTables.join(', ')}`);
    
    if (bestSuccessRate < 1) {
      console.log(`⚠️  注意: 还有${TABLES_TO_TEST.length - accessibleTables.length}个表格无法访问，可能需要额外权限配置`);
    }
  } else {
    console.log(`❌ 没有找到可用的应用配置，所有表格都无法访问`);
    console.log(`💡 建议: 检查飞书应用权限配置，确保应用有权限访问对应的多维表格`);
  }
  
  console.log(`\n🔧 下一步操作建议:`);
  if (bestSuccessRate > 0) {
    console.log(`1. 使用${bestApp}的配置更新HRMS系统`);
    console.log(`2. 为无法访问的表格申请额外权限`);
    console.log(`3. 考虑将表格迁移到同一应用下以便管理`);
  } else {
    console.log(`1. 联系飞书应用管理员检查权限配置`);
    console.log(`2. 确认表格是否存在于正确的应用下`);
    console.log(`3. 验证应用ID和密钥是否正确`);
  }
}

// 运行测试
runMultiAppTest().catch(console.error);
