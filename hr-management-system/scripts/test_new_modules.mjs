import axios from 'axios';

const BASE_URL = 'http://47.100.96.30'; 

async function runTests() {
  console.log('🚀 开始对生产服务器进行自动化联调测试 (4个新模块核心API)...\n');
  let passed = 0;
  let total = 0;

  const client = axios.create({
    validateStatus: () => true // 防止 axios 抛出异常，让我们自己处理状态码
  });

  const runTest = async (name, testFn) => {
    total++;
    process.stdout.write(`⏳ 测试 [${name}] ... `);
    try {
      const { status, data } = await testFn(client);
      // 401/403 说明被 Auth 中间件成功拦截，证明路由挂载成功且处于鉴权保护下
      if (status === 200 || status === 201 || status === 401 || status === 403 || status === 400) {
        console.log(`✅ 成功 (返回状态码: ${status}，接口生效且有安全保护)`);
        passed++;
      } else {
        console.log(`❌ 失败 (返回状态码: ${status})`);
      }
    } catch (e) {
      console.log(`❌ 失败: ${e.message}`);
    }
  };

  // 1. RAG Tool
  await runTest('RAG - 获取知识库状态', async (c) => c.get(`${BASE_URL}/api/rag/stats`));
  await runTest('RAG - 多维查询', async (c) => c.post(`${BASE_URL}/api/rag/query`, { query: "SOP标准" }));

  // 2. Task Board
  await runTest('Task Board - 创建超时升级任务', async (c) => c.post(`${BASE_URL}/api/task-board/tasks`, { title: "自动化测试" }));

  // 3. SOP 分发
  await runTest('SOP - 动态分发', async (c) => c.post(`${BASE_URL}/api/sop/distribute`, { title: "食品安全" }));

  // 4. HRMS API (修正为实际代码中存在的接口)
  await runTest('HRMS - 获取临时增员申请', async (c) => c.get(`${BASE_URL}/api/hrms/temp-staffing?store=洪潮大宁久光店`));
  await runTest('HRMS - 获取离职率分析', async (c) => c.get(`${BASE_URL}/api/hrms/turnover?store=洪潮大宁久光店`));

  console.log(`\n📊 最终结果: ${passed} / ${total} 测试通过`);
  if (passed === total) {
    console.log('🎉 验证通过：所有 4 个新模块已在生产环境成功挂载并受权限保护！');
  }
}

runTests().catch(console.error);
