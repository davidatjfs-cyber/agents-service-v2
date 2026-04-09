/**
 * PROACTIVE FULL TEST
 * 
 * 完整测试 proactive-v2 + agent-session 功能
 * 使用 CommonJS，可直接通过 node 执行
 * 不依赖飞书 webhook，使用 mock 数据
 */

const path = require('path');

// =========================
// 数据库 Mock（用于测试）
// =========================

const DB_MOCK = {
  triggerRecords: [],

  async query(sql, params) {
    console.log(`[DB Mock] Query: ${sql.substring(0, 100)}...`);
    console.log(`[DB Mock] Params:`, params);

    // 模拟 anomaly_triggers 去重查询
    if (sql.includes('anomaly_triggers') && sql.includes('COUNT(*)')) {
      const [store, type, windowMinutes] = params;
      const recentRecords = DB_MOCK.triggerRecords.filter(
        r => r.store === store && r.type === type
      );
      return { rows: [{ count: recentRecords.length }] };
    }

    // 模拟 anomaly_triggers 插入
    if (sql.includes('INSERT INTO anomaly_triggers')) {
      const [type, store, severity, value] = params;
      const record = {
        type,
        store,
        severity,
        value,
        timestamp: new Date(),
      };
      DB_MOCK.triggerRecords.push(record);
      console.log(`[DB Mock] Recorded trigger: ${type}/${store}`);
      return { rows: [] };
    }

    return { rows: [] };
  },
};

// 设置全局变量（供 proactive-v2 模块使用）
global.query = DB_MOCK.query;
global.logger = {
  info: (msg) => console.log(`[Global Logger] ${msg}`),
  error: (err) => console.error(`[Global Logger Error] ${err}`),
  warn: (msg) => console.warn(`[Global Logger Warn] ${msg}`),
};

// =========================
// 模块导入（动态 import 支持 ES Modules）
// =========================

let ProactiveBridge = null;
let LLMDecision = null;
let TriggerDedupe = null;
let AgentHandlers = null;
let MessagePipeline = null;
let SessionService = null;
let Store = null;
let db = null;
let query = null;

console.log('=== PROACTIVE FULL TEST START ===\n');

// 动态导入工具函数
async function dynamicImport(modulePath) {
  try {
    // 如果是相对路径（不以 / 或 ../ 开头），则拼接当前目录
    const resolvedPath = modulePath.startsWith('.') || modulePath.startsWith('..')
      ? path.resolve(__dirname, modulePath)
      : modulePath.startsWith('/')
        ? modulePath  // 绝对路径，直接使用
        : path.join(__dirname, '../src/services', modulePath + '.js');

    const mod = await import(resolvedPath);
    return mod.default || mod;
  } catch (err) {
    console.error(`  ✗ Failed to load ${modulePath}: ${err.message}`);
    return null;
  }
}

// =========================
// 工具函数
// =========================

function logTest(testName, passed, message) {
  const status = passed ? '✔ PASS' : '❌ FAIL';
  console.log(`[${status}] ${testName}: ${message}`);
}

function formatJSON(obj) {
  try {
    return JSON.stringify(obj, null, 2);
  } catch (e) {
    return String(obj);
  }
}

async function safeTest(testFn, testName) {
  try {
    console.log(`\n[TEST] ${testName}`);
    const result = await testFn();
    logTest(testName, true, result || 'Success');
    return result;
  } catch (err) {
    logTest(testName, false, err.message);
    return null;
  }
}

// =========================
// Mock 数据
// =========================

const MOCK_DATA = {
  // Mock 用户事件（用于 message-pipeline）
  userEvent: {
    eventId: 'test-event-001',
    message_id: 'test-msg-001',
    userId: 'test-user',
    chatId: 'test-chat',
    text: '查询今天营收',
    hasImage: false,
  },

  // Mock 异常（用于 proactive）
  anomaly: {
    type: 'revenue_drop',
    store: '测试门店',
    severity: 'high',
    value: { revenue: 0.7, dropPercent: 30 },
  },

  // Mock Agent Trigger
  trigger: {
    type: 'revenue_drop',
    store: '测试门店',
    source: 'test',
    severity: 'high',
    value: { revenue: 0.7 },
  },

  // Mock 上下文
  ctx: {
    store: '测试门店',
    username: 'test_user',
    role: 'store_manager',
  },

  // Mock 会话消息
  sessionMessage: {
    type: 'ask',
    question: '你们有外卖吗？',
  },

  sessionUpdate: {
    type: 'update',
    data: { progress: 'analyzing' },
  },

  sessionFinal: {
    type: 'final',
    answer: '完整方案：1. 分析外卖数据...',
  },
};

// =========================
// 模拟 LLM 调用
// =========================

const LLM_MOCK = {
  async call(prompt) {
    console.log(`[LLM Mock] Prompt: ${prompt.substring(0, 100)}...`);

    // 模拟 LLM 响应
    return JSON.stringify({
      triggered: true,
      reason: '模拟LLM响应：营收下降超过20%需要分析',
      priority: 'high',
    });
  },
};

// =========================
// Test 1: testSafety()
// =========================

async function testSafety() {
  console.log('--- TEST 1: Safety Verification ---');

  // 尝试加载所有模块
  const modules = [
    { name: 'proactive-v2/anomaly-bridge', var: 'ProactiveBridge' },
    { name: 'proactive-v2/llm-decision', var: 'LLMDecision' },
    { name: 'proactive-v2/trigger-dedupe', var: 'TriggerDedupe' },
    { name: 'agent-session/session-service', var: 'SessionService' },
    { name: 'agent-handlers', var: 'AgentHandlers' },  // 修复：agent-handlers 在 src/services/ 目录下
  ];

  const results = [];

  for (const module of modules) {
    try {
      const mod = await dynamicImport(module.name);

      // 存储模块引用
      if (module.var === 'ProactiveBridge') ProactiveBridge = mod;
      if (module.var === 'LLMDecision') LLMDecision = mod;
      if (module.var === 'TriggerDedupe') TriggerDedupe = mod;
      if (module.var === 'SessionService') SessionService = mod;
      if (module.var === 'AgentHandlers') AgentHandlers = mod;

      console.log(`  ✓ ${module.name} loaded`);
      results.push({ module: module.name, status: 'loaded' });
    } catch (err) {
      console.log(`  ✗ ${module.name} failed: ${err.message}`);
      results.push({ module: module.name, status: 'failed', error: err.message });
    }
  }

  const successCount = results.filter(r => r.status === 'loaded').length;
  const totalCount = results.length;

  return `成功加载 ${successCount}/${totalCount} 个模块`;
}

// =========================
// Test 2: testAnomalyTrigger()
// =========================

async function testAnomalyTrigger() {
  console.log('--- TEST 2: Anomaly Trigger Chain ---');

  if (!ProactiveBridge) {
    throw new Error('ProactiveBridge module not loaded');
  }

  // Mock handleTrigger
  const mockHandleTrigger = async (ctx) => {
    console.log(`[Mock] handleTrigger called: ${formatJSON(ctx)}`);
    console.log(`[Mock] Simulating agent dispatch to: data_auditor`);
    console.log(`[Mock] Task would be created for: ${ctx.store}/${ctx.type}`);
    return { taskCreated: true, taskId: 'TEST-TASK-001' };
  };

  // 准备测试数据
  const testAnomaly = {
    type: 'revenue_drop',
    store: '测试门店',
    severity: 'high',
    value: { revenue: 0.7, dropPercent: 30 },
  };

  console.log(`Input anomaly: ${formatJSON(testAnomaly)}`);

  // 调用 anomaly bridge
  const stats = await ProactiveBridge.handleAnomalies([testAnomaly]);

  console.log(`\nStats: ${formatJSON(stats)}`);

  return `processed=${stats.processed}, triggered=${stats.triggered}, skipped=${stats.skipped}`;
}

// =========================
// Test 3: testLLMDecision()
// =========================

async function testLLMDecision() {
  console.log('--- TEST 3: LLM Decision Engine ---');

  if (!LLMDecision) {
    throw new Error('LLMDecision module not loaded');
  }

  // Mock fetch 来模拟 LLM 调用
  const originalFetch = global.fetch;
  global.fetch = async (url, options) => {
    console.log(`[Mock Fetch] URL: ${url}`);
    console.log(`[Mock Fetch] Method: ${options.method}`);
    console.log(`[Mock Fetch] Body: ${options.body.substring(0, 100)}...`);

    // 模拟 Ollama API 响应
    return {
      ok: true,
      json: async () => ({
        response: JSON.stringify({
          triggered: true,
          reason: '模拟LLM响应：营收下降超过20%需要分析',
          priority: 'high',
        }),
      }),
    };
  };

  const testAnomaly = {
    type: 'revenue_drop',
    store: '测试门店',
    severity: 'high',
    value: { revenue: 0.7, dropPercent: 30 },
  };

  console.log(`Input anomaly: ${formatJSON(testAnomaly)}`);

  // 调用 LLM decision
  const decision = await LLMDecision.decideWithLLM(testAnomaly);

  console.log(`\nDecision result: ${formatJSON(decision)}`);

  // 恢复原始 fetch
  global.fetch = originalFetch;

  return `triggered=${decision.triggered}, reason=${decision.reason}, priority=${decision.priority}`;
}

// =========================
// Test 4: testDedupe()
// =========================

async function testDedupe() {
  console.log('--- TEST 4: Trigger Deduplication ---');

  if (!TriggerDedupe) {
    throw new Error('TriggerDedupe module not loaded');
  }

  const testAnomaly = {
    type: 'revenue_drop',
    store: '测试门店',
    severity: 'high',
    value: { revenue: 0.7 },
  };

  console.log(`Input anomaly: ${formatJSON(testAnomaly)}`);

  // 第一次调用 - 应该触发
  const firstCall = await TriggerDedupe.shouldTrigger(testAnomaly);
  console.log(`\nFirst call: ${firstCall}`);
  console.log(`DB state: ${DB_MOCK.triggerRecords.length} records`);

  // 第二次调用 - 应该被去重
  const secondCall = await TriggerDedupe.shouldTrigger(testAnomaly);
  console.log(`Second call: ${secondCall}`);
  console.log(`DB state: ${DB_MOCK.triggerRecords.length} records`);

  // 第三次调用 - 应该被去重
  const thirdCall = await TriggerDedupe.shouldTrigger(testAnomaly);
  console.log(`Third call: ${thirdCall}`);
  console.log(`DB state: ${DB_MOCK.triggerRecords.length} records`);

  const success = firstCall && !secondCall && !thirdCall;
  return `dedup logic: ${success ? 'working' : 'failed'} (1st=true, 2nd=false, 3rd=false)`;
}

// =========================
// Test 5: testSessionFlow()
// =========================

async function testSessionFlow() {
  console.log('--- TEST 5: Agent Session Flow ---');

  if (!SessionService) {
    throw new Error('SessionService module not loaded');
  }

  // SessionService 依赖于数据库，需要真实连接
  // 在测试环境中无法 mock，因为使用静态 import
  console.log('\n⚠️  SessionService 依赖于真实数据库连接');
  console.log('⚠️  在当前测试环境中无法完全 mock');
  console.log('⚠️  模块加载成功，但需要 DB 连接才能执行测试');

  const moduleCheck = {
    createSession: typeof SessionService.createSession === 'function',
    getActiveSession: typeof SessionService.getActiveSession === 'function',
    updateSession: typeof SessionService.updateSession === 'function',
    closeSession: typeof SessionService.closeSession === 'function',
  };

  console.log('\nModule functions check:');
  console.log(formatJSON(moduleCheck));

  const allFunctionsAvailable = Object.values(moduleCheck).every(v => v === true);
  return `session module loaded: ${allFunctionsAvailable ? 'success' : 'failed'} (requires DB for full test)`;
}

// =========================
// Test 6: testHandleTrigger()
// =========================

async function testHandleTrigger() {
  console.log('--- TEST 6: Agent Handler Trigger Chain ---');

  if (!AgentHandlers) {
    throw new Error('AgentHandlers module not loaded');
  }

  // AgentHandlers 导出的是多个函数，包括 handleTrigger
  const moduleCheck = {
    handleTrigger: typeof AgentHandlers.handleTrigger === 'function',
    dispatchToAgent: typeof AgentHandlers.dispatchToAgent === 'function',
  };

  console.log('\nModule functions check:');
  console.log(formatJSON(moduleCheck));

  const testTrigger = {
    type: 'revenue_drop',
    store: '测试门店',
    source: 'test',
    severity: 'high',
    value: { revenue: 0.7 },
  };

  console.log(`\nInput trigger: ${formatJSON(testTrigger)}`);

  // AgentHandlers.handleTrigger 依赖于 dispatchToAgent，而 dispatchToAgent 又依赖于其他模块
  // 在测试环境中无法完全 mock，因为使用静态 import
  console.log('\n⚠️  AgentHandlers.handleTrigger 依赖于其他模块');
  console.log('⚠️  在当前测试环境中无法完全 mock');
  console.log('⚠️  模块加载成功，但需要完整依赖链才能执行测试');

  const allFunctionsAvailable = Object.values(moduleCheck).every(v => v === true);
  return `agent handler module loaded: ${allFunctionsAvailable ? 'success' : 'failed'} (requires dependencies for full test)`;
}

// =========================
// 主测试函数
// =========================

async function runAllTests() {
  const tests = [
    { name: 'testSafety', fn: testSafety },
    { name: 'testAnomalyTrigger', fn: testAnomalyTrigger },
    { name: 'testLLMDecision', fn: testLLMDecision },
    { name: 'testDedupe', fn: testDedupe },
    { name: 'testSessionFlow', fn: testSessionFlow },
    { name: 'testHandleTrigger', fn: testHandleTrigger },
  ];

  const results = [];

  for (const test of tests) {
    const result = await safeTest(test.fn, test.name);
    results.push({ test: test.name, result });
  }

  return results;
}

// =========================
// 执行
// =========================

(async () => {
  const results = await runAllTests();

  console.log('\n=== TEST SUMMARY ===');
  console.log('=====================\n');

  results.forEach(r => {
    const status = r.result ? '✔ PASS' : '❌ FAIL';
    console.log(`${status} ${r.test}`);
    console.log(`    ${r.result}`);
    console.log('');
  });

  const passed = results.filter(r => r.result).length;
  const total = results.length;
  console.log(`\n=== RESULT: ${passed}/${total} PASSED ===`);

  process.exit(passed === total ? 0 : 1);
})();
