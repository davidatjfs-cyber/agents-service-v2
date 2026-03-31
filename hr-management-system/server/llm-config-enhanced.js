/**
 * Enhanced LLM Configuration & Smart Router
 * 增强大模型配置和智能路由系统
 */

import { 
  getModelTier, 
  getTierConfig, 
  trackLLMCall,
  isTierBudgetExceeded,
  MODEL_TIERS,
  ROLE_TIER_MAP 
} from './hq-brain-config.js';

// 扩展模型配置 - 支持多模型降级策略
export const ENHANCED_MODEL_CONFIG = {
  // 主模型配置
  primary: {
    deepseek: {
      chat: 'deepseek-chat',
      coder: 'deepseek-coder',
      reasoner: 'deepseek-reasoner'
    }
  },
  
  // 备用模型配置（降级策略）
  fallback: {
    // 当主要模型不可用时使用 - 按优先级排序
    level1: 'deepseek-chat',      // 首选降级
    level2: 'qwen-turbo',         // 阿里云Qwen备用
    level3: 'doubao-lite',        // 字节跳动Doubao备用
    level4: null                  // 最终降级：使用规则引擎
  },
  
  // 备用模型API配置
  backupModels: {
    'qwen-turbo': {
      provider: 'aliyun',
      endpoint: 'https://dashscope.aliyuncs.com/api/v1/services/aigc/text-generation/generation',
      model: 'qwen-turbo',
      timeout: 30000
    },
    'doubao-lite': {
      provider: 'bytedance',
      endpoint: 'https://ark.cn-beijing.volces.com/api/v3/chat/completions',
      model: 'doubao-lite-4k',
      timeout: 30000
    }
  },
  
  // 任务类型到模型的映射
  taskRouting: {
    // 复杂推理任务
    complex_reasoning: {
      models: ['deepseek-reasoner', 'deepseek-chat'],
      temperature: 0.3,
      maxTokens: 4096,
      timeout: 60000
    },
    // 代码生成/分析
    code_analysis: {
      models: ['deepseek-coder', 'deepseek-chat'],
      temperature: 0.2,
      maxTokens: 8192,
      timeout: 45000
    },
    // 数据分析
    data_analysis: {
      models: ['deepseek-chat', 'deepseek-reasoner'],
      temperature: 0.1,
      maxTokens: 2048,
      timeout: 30000
    },
    // 简单问答
    simple_qa: {
      models: ['deepseek-chat'],
      temperature: 0.1,
      maxTokens: 1024,
      timeout: 15000
    },
    // 创意生成
    creative: {
      models: ['deepseek-chat'],
      temperature: 0.7,
      maxTokens: 2048,
      timeout: 30000
    }
  }
};

// 模型性能监控
export class ModelPerformanceMonitor {
  constructor() {
    this.metrics = new Map();
    this.errors = [];
    this.latencyHistory = [];
  }

  /**
   * 记录模型调用指标
   */
  recordMetrics(model, task, metrics) {
    const key = `${model}_${task}`;
    if (!this.metrics.has(key)) {
      this.metrics.set(key, {
        calls: 0,
        errors: 0,
        totalLatency: 0,
        avgLatency: 0,
        lastUsed: null
      });
    }

    const stats = this.metrics.get(key);
    stats.calls++;
    stats.totalLatency += metrics.latency || 0;
    stats.avgLatency = stats.totalLatency / stats.calls;
    stats.lastUsed = new Date().toISOString();

    if (metrics.error) {
      stats.errors++;
      this.errors.push({
        model,
        task,
        error: metrics.error,
        timestamp: new Date().toISOString()
      });
    }

    // 保留最近的错误记录
    if (this.errors.length > 100) {
      this.errors = this.errors.slice(-50);
    }
  }

  /**
   * 获取模型性能报告
   */
  getPerformanceReport(model) {
    const modelMetrics = [];
    for (const [key, stats] of this.metrics) {
      if (key.startsWith(model)) {
        const [, task] = key.split('_');
        modelMetrics.push({
          task,
          ...stats,
          errorRate: stats.calls > 0 ? stats.errors / stats.calls : 0
        });
      }
    }

    const totalCalls = modelMetrics.reduce((sum, m) => sum + m.calls, 0);
    const totalErrors = modelMetrics.reduce((sum, m) => sum + m.errors, 0);
    const avgLatency = modelMetrics.length > 0 
      ? modelMetrics.reduce((sum, m) => sum + m.avgLatency, 0) / modelMetrics.length 
      : 0;

    return {
      model,
      totalCalls,
      totalErrors,
      errorRate: totalCalls > 0 ? totalErrors / totalCalls : 0,
      avgLatency,
      taskBreakdown: modelMetrics,
      health: this.assessModelHealth(model, totalCalls, totalErrors, avgLatency)
    };
  }

  /**
   * 评估模型健康度
   */
  assessModelHealth(model, calls, errors, avgLatency) {
    if (calls === 0) return 'unknown';
    
    const errorRate = errors / calls;
    
    if (errorRate > 0.3 || avgLatency > 30000) return 'critical';
    if (errorRate > 0.1 || avgLatency > 15000) return 'warning';
    if (errorRate > 0.05 || avgLatency > 8000) return 'fair';
    return 'healthy';
  }

  /**
   * 获取最佳可用模型
   */
  getBestAvailableModel(preferredModels) {
    const candidates = preferredModels || Object.keys(this.metrics);
    
    const scored = candidates.map(model => {
      const report = this.getPerformanceReport(model);
      const score = this.calculateHealthScore(report);
      return { model, score, report };
    });

    scored.sort((a, b) => b.score - a.score);
    return scored[0]?.model || preferredModels?.[0] || 'deepseek-chat';
  }

  /**
   * 计算健康评分
   */
  calculateHealthScore(report) {
    if (report.health === 'critical') return 0;
    if (report.health === 'warning') return 30;
    if (report.health === 'fair') return 70;
    if (report.health === 'healthy') return 100;
    return 50; // unknown
  }
}

/**
 * 智能模型路由器
 */
export class SmartModelRouter {
  constructor() {
    this.monitor = new ModelPerformanceMonitor();
    this.routingRules = [];
    this.circuitBreakers = new Map();
  }

  /**
   * 分析任务复杂度
   */
  analyzeTaskComplexity(prompt, context = {}) {
    const text = String(prompt || '');
    const complexity = {
      score: 0,
      factors: []
    };

    // 基于提示长度评估
    if (text.length > 2000) {
      complexity.score += 2;
      complexity.factors.push('long_context');
    }

    // 基于关键词评估
    const complexKeywords = [
      /分析|analyze|对比|compare|评估|evaluate|预测|forecast|优化|optimize|策略|strategy|因果|causal/,
      /计算|calculate|统计|statistics|建模|model|算法|algorithm|推理|reasoning/
    ];
    
    for (const pattern of complexKeywords) {
      if (pattern.test(text)) {
        complexity.score += 1;
        complexity.factors.push('complex_keyword');
        break;
      }
    }

    // 基于历史数据评估
    if (context.previousAttempts && context.previousAttempts > 1) {
      complexity.score += 1;
      complexity.factors.push('retry_attempt');
    }

    // 基于上下文大小评估
    if (context.dataSize && context.dataSize > 1000) {
      complexity.score += 1;
      complexity.factors.push('large_data');
    }

    // 确定任务类型
    if (complexity.score >= 4) {
      complexity.type = 'complex_reasoning';
    } else if (complexity.score >= 2) {
      complexity.type = 'data_analysis';
    } else {
      complexity.type = 'simple_qa';
    }

    return complexity;
  }

  /**
   * 选择最佳模型和参数
   */
  async selectModelAndParams(prompt, role, context = {}) {
    // 1. 分析任务复杂度
    const complexity = this.analyzeTaskComplexity(prompt, context);
    
    // 2. 获取角色配置
    const tier = getModelTier(role);
    const tierConfig = getTierConfig(tier);
    
    // 3. 获取任务路由配置
    const taskConfig = ENHANCED_MODEL_CONFIG.taskRouting[complexity.type] || 
                       ENHANCED_MODEL_CONFIG.taskRouting.simple_qa;

    // 4. 检查熔断器状态
    const availableModels = taskConfig.models.filter(m => !this.isCircuitBreakerOpen(m));
    
    // 5. 选择最佳模型
    const selectedModel = availableModels.length > 0 
      ? this.monitor.getBestAvailableModel(availableModels)
      : ENHANCED_MODEL_CONFIG.fallback.level1;

    // 6. 构建最终配置
    const config = {
      model: selectedModel,
      temperature: Math.max(taskConfig.temperature, tierConfig.temperature),
      maxTokens: Math.min(taskConfig.maxTokens, tierConfig.maxTokens),
      timeout: taskConfig.timeout,
      complexity,
      tier,
      fallbackChain: this.buildFallbackChain(selectedModel)
    };

    return config;
  }

  /**
   * 构建降级链
   */
  buildFallbackChain(primaryModel) {
    const chain = [primaryModel];
    
    if (primaryModel !== ENHANCED_MODEL_CONFIG.fallback.level1) {
      chain.push(ENHANCED_MODEL_CONFIG.fallback.level1);
    }
    
    if (ENHANCED_MODEL_CONFIG.fallback.level2 && 
        !chain.includes(ENHANCED_MODEL_CONFIG.fallback.level2)) {
      chain.push(ENHANCED_MODEL_CONFIG.fallback.level2);
    }

    return chain;
  }

  /**
   * 检查熔断器状态
   */
  isCircuitBreakerOpen(model) {
    const breaker = this.circuitBreakers.get(model);
    if (!breaker) return false;
    
    if (breaker.state === 'open') {
      // 检查是否到了半开状态的时间
      if (Date.now() - breaker.lastFailure > 30000) { // 30秒后尝试恢复
        breaker.state = 'half-open';
        console.log(`[SmartModelRouter] Circuit breaker for ${model} moved to half-open`);
      }
      return breaker.state === 'open';
    }
    
    return false;
  }

  /**
   * 记录模型调用结果
   */
  recordCallResult(model, task, success, latency, error = null) {
    this.monitor.recordMetrics(model, task, {
      latency,
      error: error ? error.message : null
    });

    // 更新熔断器状态
    if (!success) {
      this.updateCircuitBreaker(model, false);
    } else if (this.circuitBreakers.has(model)) {
      const breaker = this.circuitBreakers.get(model);
      if (breaker.state === 'half-open') {
        // 半开状态下成功调用，关闭熔断器
        this.circuitBreakers.delete(model);
        console.log(`[SmartModelRouter] Circuit breaker for ${model} closed`);
      }
    }

    // 追踪成本
    trackLLMCall(getModelTier(task), 0); // 简化版，实际应传入token数量
  }

  /**
   * 更新熔断器状态
   */
  updateCircuitBreaker(model, failed) {
    if (!this.circuitBreakers.has(model)) {
      this.circuitBreakers.set(model, {
        failures: 0,
        state: 'closed',
        lastFailure: null
      });
    }

    const breaker = this.circuitBreakers.get(model);
    
    if (failed) {
      breaker.failures++;
      breaker.lastFailure = Date.now();
      
      // 连续3次失败，打开熔断器
      if (breaker.failures >= 3) {
        breaker.state = 'open';
        console.warn(`[SmartModelRouter] Circuit breaker OPENED for ${model} due to ${breaker.failures} consecutive failures`);
      }
    } else {
      breaker.failures = 0;
    }
  }

  /**
   * 获取路由器状态
   */
  getRouterStatus() {
    return {
      circuitBreakers: Array.from(this.circuitBreakers.entries()).map(([model, state]) => ({
        model,
        ...state
      })),
      performance: Array.from(this.monitor.metrics.keys()).map(model => 
        this.monitor.getPerformanceReport(model)
      )
    };
  }
}

/**
 * LLM调用包装器 - 带重试和降级
 */
export class ResilientLLMCaller {
  constructor(router) {
    this.router = router;
    this.maxRetries = 3;
    this.retryDelay = 1000;
  }

  /**
   * 执行带弹性的LLM调用
   */
  async call(prompt, role, context = {}, callFunction) {
    // 1. 获取路由配置
    const config = await this.router.selectModelAndParams(prompt, role, context);
    
    // 2. 尝试主模型
    let lastError = null;
    
    for (const model of config.fallbackChain) {
      for (let attempt = 0; attempt < this.maxRetries; attempt++) {
        try {
          const startTime = Date.now();
          
          const result = await callFunction({
            model,
            temperature: config.temperature,
            maxTokens: config.maxTokens,
            prompt
          });

          const latency = Date.now() - startTime;
          
          // 记录成功调用
          this.router.recordCallResult(model, context.taskType || 'unknown', true, latency);
          
          return {
            success: true,
            result,
            model,
            latency,
            attempt: attempt + 1
          };
        } catch (e) {
          lastError = e;
          const latency = Date.now() - startTime;
          
          console.warn(`[ResilientLLMCaller] Attempt ${attempt + 1} failed for ${model}:`, e.message);
          
          // 记录失败
          this.router.recordCallResult(model, context.taskType || 'unknown', false, latency, e);
          
          // 如果不是最后一次重试，等待后重试
          if (attempt < this.maxRetries - 1) {
            await this.delay(this.retryDelay * Math.pow(2, attempt)); // 指数退避
          }
        }
      }
      
      console.log(`[ResilientLLMCaller] Moving to fallback model from ${model}`);
    }

    // 所有模型都失败了
    return {
      success: false,
      error: lastError?.message || 'All models failed',
      fallbackUsed: true,
      suggestion: '请稍后重试或联系管理员'
    };
  }

  /**
   * 延迟函数
   */
  delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// 创建全局实例
export const modelRouter = new SmartModelRouter();
export const resilientCaller = new ResilientLLMCaller(modelRouter);

/**
 * 评估当前LLM配置
 */
export function evaluateLLMConfiguration() {
  const evaluation = {
    timestamp: new Date().toISOString(),
    issues: [],
    recommendations: [],
    overallHealth: 'healthy'
  };

  // 1. 检查模型配置
  if (MODEL_TIERS.hq_brain.reasoningModel === MODEL_TIERS.store_limb.reasoningModel) {
    evaluation.issues.push({
      severity: 'medium',
      type: 'model_consolidation',
      description: 'HQ Brain和Store Limb使用相同模型，未充分利用分层架构',
      impact: '可能导致成本浪费或性能不足'
    });
    
    evaluation.recommendations.push({
      priority: 'medium',
      action: '考虑为HQ Brain配置更强的推理模型',
      reason: '总部决策需要更强的推理能力'
    });
  }

  // 2. 检查温度设置
  if (MODEL_TIERS.hq_brain.temperature > 0.5) {
    evaluation.issues.push({
      severity: 'low',
      type: 'temperature_high',
      description: 'HQ Brain温度设置偏高，可能影响决策稳定性'
    });
  }

  // 3. 检查预算限制
  for (const [tier, config] of Object.entries(MODEL_TIERS)) {
    if (config.costBudgetDaily < 10) {
      evaluation.issues.push({
        severity: 'low',
        type: 'budget_low',
        description: `${tier}的日预算设置过低(${config.costBudgetDaily}元)`
      });
    }
  }

  // 4. 评估总体健康度
  const criticalIssues = evaluation.issues.filter(i => i.severity === 'critical').length;
  const warningIssues = evaluation.issues.filter(i => i.severity === 'warning').length;

  if (criticalIssues > 0) {
    evaluation.overallHealth = 'critical';
  } else if (warningIssues > 2) {
    evaluation.overallHealth = 'warning';
  } else if (warningIssues > 0) {
    evaluation.overallHealth = 'fair';
  }

  return evaluation;
}

/**
 * 初始化增强LLM配置
 */
export function initializeEnhancedLLMConfig() {
  console.log('[EnhancedLLMConfig] Initializing...');
  
  // 运行配置评估
  const evaluation = evaluateLLMConfiguration();
  
  if (evaluation.issues.length > 0) {
    console.warn('[EnhancedLLMConfig] Configuration issues detected:', evaluation.issues);
  }
  
  if (evaluation.recommendations.length > 0) {
    console.log('[EnhancedLLMConfig] Recommendations:', evaluation.recommendations);
  }
  
  console.log(`[EnhancedLLMConfig] Initialized. Overall health: ${evaluation.overallHealth}`);
  
  return evaluation;
}

export default {
  ENHANCED_MODEL_CONFIG,
  ModelPerformanceMonitor,
  SmartModelRouter,
  ResilientLLMCaller,
  modelRouter,
  resilientCaller,
  evaluateLLMConfiguration,
  initializeEnhancedLLMConfig
};
