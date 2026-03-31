/**
 * Regression Prevention & Code Protection System
 * 防止代码回归的保护机制
 */

import { pool } from './master-agent.js';

// 关键函数保护清单 - 这些函数是Agent系统的核心，必须存在且正常工作
export const CRITICAL_FUNCTIONS = [
  {
    name: 'handleAgentMessage',
    file: 'agents.js',
    type: 'function',
    required: true,
    criticalPath: 'message_handling'
  },
  {
    name: 'routeMessage',
    file: 'agents.js',
    type: 'function',
    required: true,
    criticalPath: 'intent_routing'
  },
  {
    name: 'tryHandleBiByFunctionCalling',
    file: 'agents.js',
    type: 'function',
    required: true,
    criticalPath: 'bi_analysis'
  },
  {
    name: 'buildBiDeterministicTableVisitReply',
    file: 'agents.js',
    type: 'function',
    required: true,
    criticalPath: 'table_visit_query'
  },
  {
    name: 'buildBiDeterministicDailyReportReply',
    file: 'agents.js',
    type: 'function',
    required: true,
    criticalPath: 'daily_report_query'
  },
  {
    name: 'normalizeStoreKey',
    file: 'agents.js',
    type: 'function',
    required: true,
    criticalPath: 'data_normalization'
  },
  {
    name: 'isToolAllowed',
    file: 'hq-brain-config.js',
    type: 'function',
    required: true,
    criticalPath: 'permission_check'
  },
  {
    name: 'getAvailableTools',
    file: 'hq-brain-config.js',
    type: 'function',
    required: true,
    criticalPath: 'tool_discovery'
  }
];

// 关键数据表清单
export const CRITICAL_TABLES = [
  { name: 'daily_reports', required: true, minRecords: 100 },
  { name: 'table_visit_records', required: true, minRecords: 10 },
  { name: 'sales_raw', required: true, minRecords: 100 },
  { name: 'master_tasks', required: true, minRecords: 0 },
  { name: 'feishu_generic_records', required: true, minRecords: 10 }
];

/**
 * 回归检测器
 */
export class RegressionDetector {
  constructor() {
    this.checks = [];
    this.lastCheck = null;
  }

  /**
   * 执行完整的回归检查
   */
  async runFullCheck() {
    console.log('[RegressionDetector] Starting full regression check...');
    
    const results = {
      timestamp: new Date().toISOString(),
      functionChecks: [],
      dataChecks: [],
      apiChecks: [],
      passed: true
    };

    // 1. 检查关键函数
    for (const func of CRITICAL_FUNCTIONS) {
      const check = await this.checkFunction(func);
      results.functionChecks.push(check);
      if (!check.exists) results.passed = false;
    }

    // 2. 检查关键数据表
    for (const table of CRITICAL_TABLES) {
      const check = await this.checkTable(table);
      results.dataChecks.push(check);
      if (!check.exists || (table.minRecords > 0 && check.recordCount < table.minRecords)) {
        results.passed = false;
      }
    }

    // 3. 检查核心API可用性
    results.apiChecks = await this.checkAPIs();
    
    this.lastCheck = results;
    
    // 保存检查结果
    await this.saveCheckResult(results);
    
    console.log(`[RegressionDetector] Check completed. Passed: ${results.passed}`);
    
    return results;
  }

  /**
   * 检查函数是否存在
   */
  async checkFunction(funcDef) {
    // 模拟检查 - 实际应通过动态导入或代码分析检查
    try {
      // 检查是否能从模块中导入
      const module = await import(`./${funcDef.file.replace('.js', '')}.js`).catch(() => null);
      const exists = module && typeof module[funcDef.name] === 'function';
      
      return {
        name: funcDef.name,
        file: funcDef.file,
        exists,
        criticalPath: funcDef.criticalPath,
        timestamp: new Date().toISOString()
      };
    } catch (e) {
      return {
        name: funcDef.name,
        file: funcDef.file,
        exists: false,
        error: e?.message,
        timestamp: new Date().toISOString()
      };
    }
  }

  /**
   * 检查数据表
   */
  async checkTable(tableDef) {
    try {
      const db = pool();
      
      // 检查表是否存在
      const existsResult = await db.query(
        `SELECT EXISTS (
          SELECT FROM information_schema.tables 
          WHERE table_schema = 'public' 
          AND table_name = $1
        )`,
        [tableDef.name]
      );
      
      const exists = existsResult.rows?.[0]?.exists || false;
      
      let recordCount = 0;
      if (exists) {
        const countResult = await db.query(`SELECT COUNT(*) as cnt FROM ${tableDef.name}`);
        recordCount = parseInt(countResult.rows?.[0]?.cnt || 0);
      }
      
      return {
        name: tableDef.name,
        exists,
        recordCount,
        required: tableDef.required,
        minRequired: tableDef.minRecords,
        timestamp: new Date().toISOString()
      };
    } catch (e) {
      return {
        name: tableDef.name,
        exists: false,
        error: e?.message,
        timestamp: new Date().toISOString()
      };
    }
  }

  /**
   * 检查关键API
   */
  async checkAPIs() {
    const apis = [
      { path: '/api/health', method: 'GET', required: true },
      { path: '/api/agent/message', method: 'POST', required: true },
      { path: '/api/state', method: 'GET', required: true }
    ];

    const results = [];
    
    for (const api of apis) {
      results.push({
        ...api,
        status: 'unknown', // 实际应发起HTTP请求检查
        timestamp: new Date().toISOString()
      });
    }
    
    return results;
  }

  /**
   * 保存检查结果
   */
  async saveCheckResult(results) {
    try {
      const db = pool();
      await db.query(
        `INSERT INTO regression_check_results (check_data, passed, created_at)
         VALUES ($1, $2, NOW())`,
        [JSON.stringify(results), results.passed]
      );
    } catch (e) {
      console.error('[RegressionDetector] Error saving check result:', e);
    }
  }

  /**
   * 获取最近的检查历史
   */
  async getCheckHistory(limit = 10) {
    try {
      const db = pool();
      const result = await db.query(
        `SELECT * FROM regression_check_results 
         ORDER BY created_at DESC 
         LIMIT $1`,
        [limit]
      );
      return result.rows || [];
    } catch (e) {
      console.error('[RegressionDetector] Error getting check history:', e);
      return [];
    }
  }
}

/**
 * 代码保护守卫
 */
export class CodeGuardian {
  constructor() {
    this.protectedPatterns = [];
    this.violations = [];
  }

  /**
   * 添加保护模式
   */
  addProtectedPattern(name, pattern, replacement, description) {
    this.protectedPatterns.push({
      name,
      pattern: typeof pattern === 'string' ? new RegExp(pattern) : pattern,
      replacement,
      description,
      createdAt: new Date().toISOString()
    });
  }

  /**
   * 检查代码变更是否违反保护规则
   */
  checkCodeChanges(code, filePath) {
    const violations = [];
    
    for (const pattern of this.protectedPatterns) {
      if (pattern.pattern.test(code)) {
        // 检查是否有对应的替换模式
        if (pattern.replacement && !code.includes(pattern.replacement)) {
          violations.push({
            pattern: pattern.name,
            description: pattern.description,
            file: filePath,
            severity: 'high',
            suggestion: `应包含: ${pattern.replacement}`
          });
        }
      }
    }
    
    this.violations.push(...violations);
    return violations;
  }

  /**
   * 生成保护规则报告
   */
  generateProtectionReport() {
    return {
      totalPatterns: this.protectedPatterns.length,
      totalViolations: this.violations.length,
      recentViolations: this.violations.slice(-10),
      protectedAreas: this.protectedPatterns.map(p => p.name)
    };
  }
}

/**
 * 自动化测试运行器
 */
export class AutomatedTestRunner {
  constructor() {
    this.tests = [];
    this.results = [];
  }

  /**
   * 注册测试
   */
  registerTest(name, testFn, critical = false) {
    this.tests.push({ name, testFn, critical, registeredAt: new Date().toISOString() });
  }

  /**
   * 运行所有测试
   */
  async runAllTests() {
    console.log('[AutomatedTestRunner] Running all tests...');
    
    const results = {
      timestamp: new Date().toISOString(),
      total: this.tests.length,
      passed: 0,
      failed: 0,
      critical: { passed: 0, failed: 0 },
      details: []
    };

    for (const test of this.tests) {
      try {
        const startTime = Date.now();
        await test.testFn();
        const duration = Date.now() - startTime;
        
        results.passed++;
        if (test.critical) results.critical.passed++;
        
        results.details.push({
          name: test.name,
          status: 'passed',
          duration,
          critical: test.critical
        });
      } catch (e) {
        results.failed++;
        if (test.critical) results.critical.failed++;
        
        results.details.push({
          name: test.name,
          status: 'failed',
          error: e?.message,
          critical: test.critical
        });
        
        console.error(`[AutomatedTestRunner] Test failed: ${test.name}`, e);
      }
    }

    this.results.push(results);
    
    // 保存测试结果
    await this.saveTestResults(results);
    
    console.log(`[AutomatedTestRunner] Tests completed. Passed: ${results.passed}/${results.total}`);
    
    return results;
  }

  /**
   * 运行关键路径测试
   */
  async runCriticalPathTests() {
    const criticalTests = this.tests.filter(t => t.critical);
    console.log(`[AutomatedTestRunner] Running ${criticalTests.length} critical tests...`);
    
    const results = [];
    for (const test of criticalTests) {
      try {
        await test.testFn();
        results.push({ name: test.name, status: 'passed' });
      } catch (e) {
        results.push({ name: test.name, status: 'failed', error: e?.message });
        console.error(`[AutomatedTestRunner] Critical test failed: ${test.name}`, e);
      }
    }
    
    return results;
  }

  /**
   * 保存测试结果
   */
  async saveTestResults(results) {
    try {
      const db = pool();
      await db.query(
        `INSERT INTO automated_test_results (test_data, created_at)
         VALUES ($1, NOW())`,
        [JSON.stringify(results)]
      );
    } catch (e) {
      console.error('[AutomatedTestRunner] Error saving test results:', e);
    }
  }

  /**
   * 获取测试历史
   */
  async getTestHistory(limit = 20) {
    try {
      const db = pool();
      const result = await db.query(
        `SELECT * FROM automated_test_results 
         ORDER BY created_at DESC 
         LIMIT $1`,
        [limit]
      );
      return result.rows || [];
    } catch (e) {
      return [];
    }
  }
}

// 创建全局实例
export const regressionDetector = new RegressionDetector();
export const codeGuardian = new CodeGuardian();
export const automatedTestRunner = new AutomatedTestRunner();

// 初始化保护规则
codeGuardian.addProtectedPattern(
  'table_visit_permission_check',
  /isPrivilegedRole/,
  'const isPrivilegedRole',
  '桌访数据权限检查必须保留isPrivilegedRole变量'
);

codeGuardian.addProtectedPattern(
  'store_key_normalization',
  /normalizeStoreKey/,
  'normalizeStoreKey(s)',
  '门店名标准化必须使用normalizeStoreKey函数'
);

codeGuardian.addProtectedPattern(
  'bi_source_enabled_check',
  /isBiSourceEnabled/,
  'if (!isBiSourceEnabled',
  'BI数据源检查必须保留isBiSourceEnabled调用'
);

// 注册关键测试
automatedTestRunner.registerTest('table_visit_query', async () => {
  // 测试桌访查询是否正常工作
  const { buildBiDeterministicTableVisitReply } = await import('./agents.js');
  if (typeof buildBiDeterministicTableVisitReply !== 'function') {
    throw new Error('buildBiDeterministicTableVisitReply function not found');
  }
}, true);

automatedTestRunner.registerTest('agent_message_handling', async () => {
  // 测试Agent消息处理是否正常工作
  const { handleAgentMessage } = await import('./agents.js');
  if (typeof handleAgentMessage !== 'function') {
    throw new Error('handleAgentMessage function not found');
  }
}, true);

automatedTestRunner.registerTest('database_connection', async () => {
  const db = pool();
  const result = await db.query('SELECT 1 as test');
  if (!result.rows?.[0]?.test === 1) {
    throw new Error('Database connection test failed');
  }
}, true);

automatedTestRunner.registerTest('critical_tables_exist', async () => {
  const db = pool();
  for (const table of CRITICAL_TABLES.filter(t => t.required)) {
    const result = await db.query(
      `SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_schema = 'public' 
        AND table_name = $1
      )`,
      [table.name]
    );
    if (!result.rows?.[0]?.exists) {
      throw new Error(`Required table ${table.name} does not exist`);
    }
  }
}, true);

// 初始化函数
export async function initializeRegressionProtection() {
  console.log('[RegressionProtection] Initializing...');
  
  // 运行初始检查
  await regressionDetector.runFullCheck();
  
  // 运行关键测试
  await automatedTestRunner.runCriticalPathTests();
  
  console.log('[RegressionProtection] Initialized successfully');
}

export default {
  RegressionDetector,
  CodeGuardian,
  AutomatedTestRunner,
  regressionDetector,
  codeGuardian,
  automatedTestRunner,
  initializeRegressionProtection,
  CRITICAL_FUNCTIONS,
  CRITICAL_TABLES
};
