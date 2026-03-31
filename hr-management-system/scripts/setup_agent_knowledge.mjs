/**
 * HRMS Agent 知识库设置脚本
 * 
 * 用法: node scripts/setup_agent_knowledge.mjs
 * 功能: 
 * 1. 检查现有知识库文件
 * 2. 为文件添加 Agent 标签
 * 3. 提供上传建议
 */

import fs from 'fs';
import path from 'path';
import axios from 'axios';

const BASE = 'http://127.0.0.1:3000';
let TOKEN = '';

// Agent 知识库配置
const AGENT_KNOWLEDGE = {
  'sop_advisor': {
    tags: ['sop', '流程', '标准', '规范'],
    keywords: ['流程', '标准', 'SOP', '规范', '手册', '操作', '步骤'],
    examples: [
      '卫生检查标准.pdf',
      '外卖赔付流程.docx', 
      '收货验收流程.xlsx',
      '开店闭店标准.pdf'
    ]
  },
  'data_auditor': {
    tags: ['数据', '审计', '异常', '标准'],
    keywords: ['损耗', '毛利', '成本', '异常', '标准', '阈值'],
    examples: [
      '损耗标准.xlsx',
      '毛利分析标准.pdf',
      '成本控制规范.xlsx',
      '数据异常处理流程.docx'
    ]
  },
  'ops_supervisor': {
    tags: ['审核', '检查', '图片', '卫生'],
    keywords: ['卫生', '检查', '审核', '图片', '摆盘', '验收'],
    examples: [
      '卫生检查清单.xlsx',
      '摆盘标准图片集.pdf',
      '收货验收标准.pdf',
      '消毒流程.docx'
    ]
  },
  'chief_evaluator': {
    tags: ['绩效', '考核', '评分', '权重'],
    keywords: ['绩效', '考核', '评分', '权重', '奖金'],
    examples: [
      '绩效考核标准.xlsx',
      '评分权重配置.pdf',
      '奖金计算规则.xlsx',
      '绩效评估流程.docx'
    ]
  },
  'appeal': {
    tags: ['申诉', '处理', '流程'],
    keywords: ['申诉', '处理', '流程', '复核'],
    examples: [
      '申诉处理流程.docx',
      '扣分复核标准.pdf',
      '申诉表单.xlsx'
    ]
  }
};

async function api(method, path, data, auth = true) {
  const headers = auth && TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {};
  const resp = await axios({ method, url: BASE + path, data, headers, timeout: 15000 });
  return resp.data;
}

function log(icon, text) {
  console.log(`${icon} ${text}`);
}

async function login() {
  try {
    const d = await api('POST', '/api/auth/login', { username: 'admin', password: 'admin123' }, false);
    if (!d.token) throw new Error('登录失败');
    TOKEN = d.token;
    log('✅', '管理员登录成功');
    return true;
  } catch (e) {
    log('❌', `登录失败: ${e.message}`);
    return false;
  }
}

async function checkKnowledgeBase() {
  try {
    const d = await api('GET', '/api/knowledge', null, true);
    const items = d?.items || [];
    log('📚', `现有知识库文件: ${items.length} 个`);
    
    if (items.length) {
      console.log('\n现有文件列表:');
      items.forEach(item => {
        const tags = item.tags || [];
        const tagStr = tags.length ? `[${tags.join(', ')}]` : '[无标签]';
        console.log(`  📄 ${item.title} ${tagStr}`);
      });
    }
    return items;
  } catch (e) {
    log('❌', `查询知识库失败: ${e.message}`);
    return [];
  }
}

function suggestFiles() {
  console.log('\n📋 建议上传的知识库文件:');
  
  Object.entries(AGENT_KNOWLEDGE).forEach(([agent, config]) => {
    console.log(`\n🤖 ${agent} (${getAgentName(agent)})`);
    console.log(`   🏷️  建议标签: ${config.tags.join(', ')}`);
    console.log(`   📝 示例文件:`);
    config.examples.forEach(file => {
      console.log(`     - ${file}`);
    });
  });
}

function getAgentName(agent) {
  const names = {
    'sop_advisor': 'SOP顾问',
    'data_auditor': '数据审计员', 
    'ops_supervisor': '营运督导员',
    'chief_evaluator': '绩效考核官',
    'appeal': '申诉处理'
  };
  return names[agent] || agent;
}

async function updateFileTags(fileId, tags) {
  try {
    const d = await api('PUT', `/api/knowledge/${fileId}`, { tags }, true);
    log('✅', `文件标签已更新: ${tags.join(', ')}`);
    return true;
  } catch (e) {
    log('❌', `更新标签失败: ${e.message}`);
    return false;
  }
}

function detectAgentFromFile(filename) {
  const lower = filename.toLowerCase();
  
  for (const [agent, config] of Object.entries(AGENT_KNOWLEDGE)) {
    if (config.keywords.some(kw => lower.includes(kw.toLowerCase()))) {
      return { agent, tags: config.tags };
    }
  }
  
  return null;
}

async function suggestTagUpdates(items) {
  console.log('\n🏷️  建议标签更新:');
  
  let needsUpdate = 0;
  items.forEach(item => {
    const currentTags = item.tags || [];
    const detection = detectAgentFromFile(item.title);
    
    if (detection && !detection.tags.every(tag => currentTags.includes(tag))) {
      const suggestedTags = [...new Set([...currentTags, ...detection.tags])];
      console.log(`\n📄 ${item.title}`);
      console.log(`   当前标签: [${currentTags.join(', ') || '无'}]`);
      console.log(`   建议标签: [${suggestedTags.join(', ')}]`);
      console.log(`   对应Agent: ${getAgentName(detection.agent)}`);
      needsUpdate++;
    }
  });
  
  return needsUpdate;
}

async function main() {
  console.log('══════════════════════════════════════════');
  console.log('  HRMS Agent 知识库设置');
  console.log('══════════════════════════════════════════\n');
  
  // 1. 登录
  if (!await login()) return;
  
  // 2. 检查现有知识库
  const items = await checkKnowledgeBase();
  
  // 3. 建议文件上传
  suggestFiles();
  
  // 4. 建议标签更新
  const needsUpdate = await suggestTagUpdates(items);
  
  if (needsUpdate > 0) {
    console.log('\n💡 提示: 可以通过 HRMS 前端 → 知识库管理 → 编辑文件 → 添加标签来更新');
  }
  
  console.log('\n📖 使用指南:');
  console.log('1. 准备知识库文件 (PDF/DOCX/XLSX)');
  console.log('2. 在 HRMS 前端 → 知识库管理 → 上传文件');
  console.log('3. 为文件添加对应的 Agent 标签');
  console.log('4. 在飞书里问机器人相关问题测试');
  
  console.log('\n🎯 测试示例:');
  console.log('- 问: "卫生检查标准是什么？" → SOP顾问会查询带"卫生"标签的文件');
  console.log('- 问: "损耗超标怎么办？" → 数据审计员会查询带"损耗"标签的文件');
  console.log('- 问: "绩效考核怎么算？" → 绩效考核官会查询带"绩效"标签的文件');
}

main().catch(console.error);
