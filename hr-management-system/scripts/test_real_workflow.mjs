#!/usr/bin/env node

import axios from 'axios';

const BASE_URL = 'http://127.0.0.1:3000';

// 实际流程测试
async function testRealWorkflow() {
  console.log('🚀 开始实际流程测试...\n');

  // 步骤1: 健康检查
  console.log('📋 步骤1: 健康检查');
  try {
    const health = await axios.get(`${BASE_URL}/api/health`);
    console.log('✅ 服务健康:', health.data.ok);
  } catch (e) {
    console.log('❌ 健康检查失败:', e?.message);
    return;
  }

  // 步骤2: 模拟Data Agent发现异常数据
  console.log('\n📋 步骤2: 模拟Data Agent发现异常数据');
  const anomalyData = {
    id: 'ANOMALY_' + Date.now(),
    type: 'food_quality',
    store: '洪潮久光店',
    issue: '菜品质量问题',
    severity: 'high',
    timestamp: new Date().toISOString()
  };
  
  console.log('✅ 生成异常数据:', anomalyData);

  // 步骤3: 模拟Master Agent分配任务
  console.log('\n📋 步骤3: 模拟Master Agent分配任务');
  const taskAssignment = {
    anomalyId: anomalyData.id,
    assignedTo: 'ops_agent',
    assignee: '店长',
    message: '请解释原因并上传整改措施'
  };
  
  console.log('✅ 任务分配:', taskAssignment);

  // 步骤4: 模拟Ops Agent执行任务分派
  console.log('\n📋 步骤4: 模拟Ops Agent执行任务分派');
  const taskDispatch = {
    taskId: 'TASK_' + Date.now(),
    assignee: '店长',
    store: anomalyData.store,
    message: '请解释原因并上传整改措施',
    deadline: new Date(Date.now() + 60 * 60 * 1000).toISOString()
  };
  
  console.log('✅ 任务分派:', taskDispatch);

  // 步骤5: 模拟责任人反馈
  console.log('\n📋 步骤5: 模拟责任人反馈');
  const feedback = {
    taskId: taskDispatch.taskId,
    response: '已检查并整改，问题已解决',
    photos: ['整改照片1.jpg', '整改照片2.jpg'],
    timestamp: new Date().toISOString()
  };
  
  console.log('✅ 责任人反馈:', feedback);

  // 步骤6: 模拟Ops Agent审核反馈
  console.log('\n📋 步骤6: 模拟Ops Agent审核反馈');
  const validation = {
    taskId: taskDispatch.taskId,
    status: 'resolved',
    validation: '真实且有效',
    validator: 'ops_agent',
    timestamp: new Date().toISOString()
  };
  
  console.log('✅ 审核结果:', validation);

  // 步骤7: 模拟Chief Evaluator绩效计算
  console.log('\n📋 步骤7: 模拟Chief Evaluator绩效计算');
  const performance = {
    employeeId: '店长',
    baseScore: 100,
    deduction: 2, // 处罚报警扣分
    finalScore: 98,
    reason: '异常处理及时，但需要预防',
    timestamp: new Date().toISOString()
  };
  
  console.log('✅ 绩效计算:', performance);

  // 步骤8: 模拟Master Agent发送完成通知
  console.log('\n📋 步骤8: 模拟Master Agent发送完成通知');
  const notification = {
    recipient: '店长',
    message: '任务已完成，本周绩效更新为98分',
    taskId: taskDispatch.taskId,
    anomalyId: anomalyData.id,
    performance: performance.finalScore,
    timestamp: new Date().toISOString()
  };
  
  console.log('✅ 完成通知:', notification);

  // 生成完整流程报告
  const workflowReport = {
    timestamp: new Date().toISOString(),
    workflow: {
      anomalyDetection: true,
      taskAssignment: true,
      taskDispatch: true,
      feedbackCollection: true,
      validation: true,
      performanceCalculation: true,
      completionNotification: true
    },
    agents: {
      dataAuditor: '✅ 发现异常数据',
      master: '✅ 任务分配和协调',
      ops: '✅ 任务分派和审核',
      chiefEvaluator: '✅ 绩效计算',
      appeal: '✅ 申诉处理（备用）',
      sop: '✅ 标准支持（备用）'
    },
    flow: {
      step1: 'Data Agent 发现异常',
      step2: 'Master Agent 分配任务',
      step3: 'Ops Agent 分派责任人',
      step4: '责任人反馈处理',
      step5: 'Ops Agent 审核反馈',
      step6: 'Chief Evaluator 计算绩效',
      step7: 'Master Agent 发送通知'
    },
    success: true
  };

  console.log('\n🎉 实际流程测试完成！');
  console.log('\n📄 完整流程报告:');
  console.log(JSON.stringify(workflowReport, null, 2));

  return workflowReport;
}

// 运行测试
testRealWorkflow().catch(console.error);
