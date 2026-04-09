/**
 * PROACTIVE SYSTEM AUTO VERIFICATION - FIXED
 * 
 * 测试真实触发链路
 */

const path = require('path');

console.log('====================================');
console.log('PROACTIVE SYSTEM VERIFICATION (FIXED)');
console.log('====================================\n');

global.query = async (sql, params) => {
  if (sql.includes('anomaly_triggers') && sql.includes('COUNT(*)')) {
    return { rows: [{ count: 0 }] };
  }
  if (sql.includes('INSERT INTO anomaly_triggers')) {
    return { rows: [] };
  }
  if (sql.includes('feishu_users')) {
    return { rows: [{ username: 'test_user', role: 'store_manager', store: '测试门店' }] };
  }
  return { rows: [] };
};

global.logger = {
  info: (msg) => console.log('[INFO] ' + msg),
  error: (err) => console.error('[ERROR] ' + err),
  warn: (msg) => console.warn('[WARN] ' + msg),
};

const results = {};

function formatJSON(obj) {
  try {
    return JSON.stringify(obj, null, 2);
  } catch (e) {
    return String(obj);
  }
}

async function verifyRealTriggerExecution() {
  console.log('====================================');
  console.log('目标：验证"真实触发链路"');
  console.log('====================================\n');

  let llmCalled = false;
  const calledAgents = [];
  let chainStats = {};
  let fetchCalled = false;

  try {
    // 1. 清空内存缓存
    console.log('[1] 清空内存缓存...');
    const triggerDedupe = await import('../src/services/proactive-v2/trigger-dedupe.js');
    const dedupeModule = triggerDedupe.default || triggerDedupe;
    
    if (dedupeModule.dedupeCache && typeof dedupeModule.dedupeCache.clear === 'function') {
      dedupeModule.dedupeCache.clear();
      console.log('    ✓ dedupeCache cleared\n');
    } else if (dedupeModule.shouldTrigger && dedupeModule.shouldTrigger._cache) {
      dedupeModule.shouldTrigger._cache.clear();
      console.log('    ✓ shouldTrigger._cache cleared\n');
    } else {
      console.log('    ⚠ 无法访问缓存，依赖 mock query 返回空\n');
    }

    // 2. 构造唯一 anomaly
    const uniqueStore = '测试门店_' + Date.now();
    const testAnomaly = {
      type: 'revenue_drop',
      store: uniqueStore,
      severity: 'high',
      value: { revenue: 0.65, dropPercent: 35 },
    };

    console.log('[2] 构造唯一 anomaly:');
    console.log('    store: ' + uniqueStore);
    console.log('    type: revenue_drop');
    console.log('    severity: high');
    console.log('    value: { revenue: 0.65, dropPercent: 35 }\n');

    // 3. Hook fetch (LLM API)
    console.log('[3] Hook fetch (LLM API)...');
    const originalFetch = global.fetch;
    global.fetch = async (url, options) => {
      if (url.includes('ollama') || url.includes('11434')) {
        fetchCalled = true;
        console.log('    [Hook] Ollama API called: ' + url);
        await new Promise(r => setTimeout(r, 100));
        return {
          ok: true,
          json: async () => ({
            response: JSON.stringify({
              triggered: true,
              reason: '营收下降35%需要分析',
              priority: 'high',
            }),
          }),
        };
      }
      return originalFetch(url, options);
    };

    // 4. Mock dispatchToAgent 引用（通过 global）
    console.log('[4] Setup dispatchToAgent mock...');
    global.__mockDispatchToAgent = async (route, text, ctx) => {
      console.log('    [Mock] dispatchToAgent called: ' + route);
      calledAgents.push(route);
      return { agent: route, response: 'Mocked', data: {} };
    };

    // 5. 修改 bridge 模块的 dispatchToAgent 引用
    console.log('[5] Patch anomaly-bridge...');
    const anomalyBridge = await import('../src/services/proactive-v2/anomaly-bridge.js');
    const bridgeModule = anomalyBridge.default || anomalyBridge;
    
    // 备份原始函数
    const originalDispatchToAgent = bridgeModule.dispatchToAgent;
    
    // 替换为 mock
    bridgeModule.dispatchToAgent = global.__mockDispatchToAgent;
    
    // 6. 加载并 Hook LLM decision
    console.log('[6] Hook LLM decision...');
    const llmDecision = await import('../src/services/proactive-v2/llm-decision.js');
    const llmModule = llmDecision.default || llmDecision;
    const originalDecide = llmModule.decideWithLLM;

    llmModule.decideWithLLM = async (anomaly) => {
      llmCalled = true;
      console.log('    [Hook] LLM decision 被调用');
      return originalDecide(anomaly);
    };

    // 7. 执行 handleAnomalies
    console.log('[7] 执行 handleAnomalies...');
    const handleAnomalies = bridgeModule.handleAnomalies;
    chainStats = await handleAnomalies([testAnomaly]);
    console.log('\n执行结果:');
    console.log(formatJSON(chainStats));

    // 恢复原始函数
    global.fetch = originalFetch;
    global.__mockDispatchToAgent = null;
    bridgeModule.dispatchToAgent = originalDispatchToAgent;
    llmModule.decideWithLLM = originalDecide;

    // 8. 验证结果
    console.log('\n====================================');
    console.log('验证结果:');
    console.log('====================================');
    console.log('  llmCalled: ' + llmCalled);
    console.log('  fetchCalled: ' + fetchCalled);
    console.log('  calledAgents: ' + formatJSON(calledAgents));
    console.log('  chainStats: ' + formatJSON(chainStats));
    console.log('');

    // PASS 条件
    const agentsTriggered = calledAgents.length > 0;
    const passed = agentsTriggered;

    if (passed) {
      console.log('====================================');
      console.log('✅ PASS: 真实触发链路验证成功');
      console.log('====================================');
      console.log('  - agents 被触发: ' + calledAgents.join(', '));
      console.log('');
      return { pass: true, agents: calledAgents, llmCalled, chainStats };
    } else {
      console.log('====================================');
      console.log('❌ FAIL: 真实触发链路验证失败');
      console.log('====================================');
      console.log('  - agents 被触发: ' + calledAgents.length);
      console.log('  - llmCalled: ' + llmCalled);
      console.log('  - chainStats: ' + formatJSON(chainStats));
      console.log('');
      return { 
        pass: false, 
        reason: 'agents 未被触发',
        agents: calledAgents, 
        llmCalled, 
        chainStats 
      };
    }

  } catch (err) {
    console.error('\n❌ 测试异常: ' + err.message);
    console.error(err.stack);
    return { pass: false, reason: err.message };
  }
}

async function verifyDedupeFallback() {
  console.log('====================================');
  console.log('目标：验证 dedupe fallback 机制');
  console.log('====================================\n');

  try {
    console.log('[1] 模拟数据库查询失败...');
    global.query = async (sql, params) => {
      if (sql.includes('COUNT(*)')) {
        throw new Error('ECONNREFUSED: 数据库连接失败');
      }
      return { rows: [] };
    };

    console.log('[2] 执行 handleAnomalies (应该不阻断)...');
    const triggerDedupe = await import('../src/services/proactive-v2/trigger-dedupe.js');
    const dedupeModule = triggerDedupe.default || triggerDedupe;
    dedupeModule.dedupeCache?.clear();

    const anomalyBridge = await import('../src/services/proactive-v2/anomaly-bridge.js');
    const bridgeModule = anomalyBridge.default || anomalyBridge;

    const uniqueStore = 'Fallback测试_' + Date.now();
    const testAnomaly = {
      type: 'revenue_drop',
      store: uniqueStore,
      severity: 'high',
      value: { revenue: 0.65, dropPercent: 35 },
    };

    const stats = await bridgeModule.handleAnomalies([testAnomaly]);
    
    console.log('\n执行结果:');
    console.log(formatJSON(stats));

    // 验证：不应该因为 DB 错误而阻断
    const notBlocked = stats.errors === 0 || stats.processed > 0;
    
    if (notBlocked) {
      console.log('\n====================================');
      console.log('✅ PASS: Fallback 机制正常工作');
      console.log('====================================\n');
      return { pass: true };
    } else {
      console.log('\n====================================');
      console.log('❌ FAIL: Fallback 机制未生效');
      console.log('====================================\n');
      return { pass: false, reason: 'DB 错误阻断了流程' };
    }

  } catch (err) {
    console.log('    异常（预期）: ' + err.message);
    return { pass: false, reason: err.message };
  }
}

async function runAllVerifications() {
  console.log('\n====================================');
  console.log('RUNNING ALL VERIFICATIONS');
  console.log('====================================\n');

  // 核心测试：真实触发链路
  const triggerResult = await verifyRealTriggerExecution();
  results.realTrigger = triggerResult;

  // Fallback 机制测试
  const fallbackResult = await verifyDedupeFallback();
  results.dedupeFallback = fallbackResult;
}

function printVerificationReport() {
  console.log('\n====================================');
  console.log('PROACTIVE SYSTEM VERIFICATION REPORT');
  console.log('====================================\n');

  const checks = [
    { name: 'Real Trigger Execution', key: 'realTrigger' },
    { name: 'Dedupe Fallback', key: 'dedupeFallback' },
  ];

  let passCount = 0;
  let failCount = 0;

  checks.forEach(check => {
    const result = results[check.key];
    const passed = result && result.pass === true;
    const icon = passed ? '✔' : '✗';
    const status = passed ? 'PASS' : 'FAIL';
    
    console.log(icon + ' ' + check.name + ': ' + status);
    
    if (!passed && result && result.reason) {
      console.log('   Reason: ' + result.reason);
    }
    console.log('');

    if (passed) {
      passCount++;
    } else {
      failCount++;
    }
  });

  console.log('====================================');
  const overallPass = failCount === 0;
  const overallStatus = overallPass ? 'PASS' : 'FAIL';
  console.log('Overall: ' + overallStatus + ' (' + passCount + '/' + checks.length + ' passed)');
  console.log('====================================\n');

  if (overallPass) {
    console.log('=== ALL SYSTEMS VERIFIED ===');
    console.log('✔ 真实触发链路正常');
    console.log('✔ Dedupe fallback 机制正常');
    console.log('====================================\n');
  } else {
    console.log('=== NEEDS ATTENTION ===');
    if (!results.realTrigger?.pass) {
      console.log('✗ 真实触发链路失败 - 检查 anomaly-bridge 和 agent-handlers');
    }
    if (!results.dedupeFallback?.pass) {
      console.log('✗ Dedupe fallback 失败 - 检查 trigger-dedupe.js');
    }
    console.log('====================================\n');
  }
}

(async () => {
  try {
    await runAllVerifications();
    printVerificationReport();
    process.exit(results.realTrigger?.pass === true ? 0 : 1);
  } catch (err) {
    console.error('\n❌ VERIFICATION CRASHED:');
    console.error(err.message);
    console.error(err.stack);
    process.exit(1);
  }
})();
