#!/usr/bin/env node

import axios from 'axios';

const BASE_URL = 'http://127.0.0.1:3000';

// 测试飞书机器人响应
async function testFeishuBot() {
  console.log('🚀 开始测试飞书机器人响应...\n');

  // 测试1: 健康检查
  console.log('📋 测试1: 健康检查');
  try {
    const health = await axios.get(`${BASE_URL}/api/health`);
    console.log('✅ 服务健康:', health.data.ok);
  } catch (e) {
    console.log('❌ 健康检查失败:', e?.message);
    return;
  }

  // 测试2: 模拟飞书消息发送
  console.log('\n📋 测试2: 模拟飞书消息发送');
  const testMessages = [
    '开市检查',
    '收档检查',
    '食品安全',
    '帮助',
    '状态',
    '绩效查询',
    '异常报告'
  ];

  for (const message of testMessages) {
    console.log(`\n🔍 测试消息: "${message}"`);
    
    try {
      // 模拟飞书webhook请求
      const webhookPayload = {
        "schema": "2.0",
        "header": {
          "event_id": "test_" + Date.now(),
          "timestamp": Date.now().toString(),
          "event_type": "im.message.receive_v1",
          "tenant_key": "test_tenant"
        },
        "event": {
          "sender": {
            "sender_id": {
              "open_id": "test_user",
              "user_id": "test_user"
            },
            "sender_type": "user",
            "nickname": "测试用户"
          },
          "message": {
            "message_id": "test_msg_" + Date.now(),
            "create_time": Date.now().toString(),
            "message_type": "text",
            "content": JSON.stringify({
              "text": message
            }),
            "chat_type": "private"
          }
        }
      };

      const response = await axios.post(`${BASE_URL}/api/feishu/webhook`, webhookPayload, {
        headers: {
          'Content-Type': 'application/json',
          'X-Lark-Request-Timestamp': Date.now().toString(),
          'X-Lark-Request-Nonce': 'test_nonce'
        }
      });

      console.log('✅ 消息发送成功:', response.status);
      
      // 等待一下让系统处理
      await new Promise(resolve => setTimeout(resolve, 1000));
      
    } catch (e) {
      console.log('❌ 消息发送失败:', e?.response?.status || e?.message);
      if (e?.response?.data) {
        console.log('错误详情:', e.response.data);
      }
    }
  }

  // 测试3: 检查Agent路由
  console.log('\n📋 测试3: 检查Agent路由');
  try {
    const agentRoutes = await axios.get(`${BASE_URL}/api/agents/routes`);
    console.log('✅ Agent路由:', agentRoutes.data);
  } catch (e) {
    console.log('❌ Agent路由检查失败:', e?.message);
  }

  // 测试4: 检查飞书配置
  console.log('\n📋 测试4: 检查飞书配置');
  try {
    const feishuConfig = await axios.get(`${BASE_URL}/api/feishu/config`);
    console.log('✅ 飞书配置:', feishuConfig.data);
  } catch (e) {
    console.log('❌ 飞书配置检查失败:', e?.message);
  }

  console.log('\n🎉 飞书机器人测试完成！');
  console.log('\n💡 如果机器人没有响应，请检查：');
  console.log('   1. 飞书应用是否正确配置');
  console.log('   2. Webhook URL是否正确');
  console.log('   3. 机器人权限是否足够');
  console.log('   4. 网络连接是否正常');
}

// 运行测试
testFeishuBot().catch(console.error);
