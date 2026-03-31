#!/usr/bin/env node

import axios from 'axios';

// 配置信息
const BITABLE_APP_ID = 'cli_a91dae9f9578dcb1'; // 飞书应用的 App ID
const BITABLE_APP_SECRET = 'sjpAzPwu4KixvhbAOD7w4ee1oEKRRBQF';
const BITABLE_APP_TOKEN = 'PtVObRtoPaMAP3stIIFc8DnJngd'; // 从 URL 提取的 app_token
const BITABLE_TABLE_ID = 'tblxHI9ZAKONOTpp'; // 表格 ID

console.log('🔧 配置信息:');
console.log('App ID:', BITABLE_APP_ID);
console.log('App Secret:', BITABLE_APP_SECRET.substring(0, 10) + '...');
console.log('App Token (从URL):', BITABLE_APP_TOKEN);
console.log('Table ID:', BITABLE_TABLE_ID);

async function getBitableTenantToken() {
  try {
    const resp = await axios.post('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
      app_id: BITABLE_APP_ID, 
      app_secret: BITABLE_APP_SECRET
    }, { timeout: 10000 });
    
    const token = resp.data?.tenant_access_token || '';
    const expires = resp.data?.expire || 7200;
    console.log('✅ Token获取成功, 过期时间:', expires, '秒');
    console.log('📝 完整响应:', JSON.stringify(resp.data, null, 2));
    return token;
  } catch (e) {
    console.error('❌ Token获取失败:', e?.response?.data || e?.message);
    console.log('📝 错误详情:', JSON.stringify(e?.response?.data || {}, null, 2));
    return null;
  }
}

async function testBitableConnection() {
  console.log('🚀 开始测试 Bitable 连接...');
  
  // 1. 获取 Token
  const token = await getBitableTenantToken();
  if (!token) {
    console.log('❌ 无法获取 Token，测试终止');
    return;
  }
  
  console.log('✅ Token 获取成功:', token.substring(0, 20) + '...');
  
  // 2. 获取记录
  try {
    const resp = await axios.get(
      `https://open.feishu.cn/open-apis/bitable/v1/apps/${BITABLE_APP_TOKEN}/tables/${BITABLE_TABLE_ID}/records`,
      {
        headers: { 'Authorization': `Bearer ${token}` },
        params: { page_size: 5, user_id_type: 'open_id' },
        timeout: 15000
      }
    );
    
    const records = resp.data?.data?.items || [];
    const total = resp.data?.data?.total || 0;
    
    console.log('✅ Bitable 连接成功!');
    console.log(`📊 表格总记录数: ${total}`);
    console.log(`📋 获取到 ${records.length} 条最新记录:`);
    
    records.forEach((record, index) => {
      console.log(`\n--- 记录 ${index + 1} ---`);
      console.log(`记录ID: ${record.record_id}`);
      console.log(`创建时间: ${record.created_time}`);
      console.log('字段内容:', JSON.stringify(record.fields, null, 2));
    });
    
  } catch (e) {
    console.error('❌ 获取记录失败:', e?.response?.data || e?.message);
    
    if (e?.response?.status === 403) {
      console.log('💡 可能原因: 应用权限不足，请检查 Bitable 权限配置');
    } else if (e?.response?.status === 404) {
      console.log('💡 可能原因: 表格ID错误或表格不存在');
    }
  }
}

// 运行测试
testBitableConnection().catch(console.error);
