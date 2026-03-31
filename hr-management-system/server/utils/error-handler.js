/**
 * 统一错误处理模块
 * 防止错误循环传播
 */

// 错误统计
const errorStats = {
  total: 0,
  byType: {},
  recent: []
};

// 安全的错误记录
export function safeErrorLog(context, error, details = {}) {
  try {
    errorStats.total++;
    errorStats.byType[context] = (errorStats.byType[context] || 0) + 1;
    
    const errorInfo = {
      timestamp: new Date().toISOString(),
      context,
      message: error.message,
      stack: error.stack,
      details
    };
    
    // 只保留最近10个错误
    errorStats.recent.unshift(errorInfo);
    if (errorStats.recent.length > 10) {
      errorStats.recent.pop();
    }
    
    // 记录到控制台（安全操作）
    console.error(`[${context}] ${error.message}`, details);
    
    // 如果错误过多，停止记录防止日志爆炸
    if (errorStats.total > 100) {
      console.warn('[error-handler] Too many errors, throttling logs');
      return;
    }
    
  } catch (logError) {
    // 连错误记录都失败了，只能静默处理
    console.error('[error-handler] Failed to log error:', logError.message);
  }
}

// 安全的函数执行包装
export async function safeExecute(context, fn, fallback = null) {
  try {
    return await fn();
  } catch (error) {
    safeErrorLog(context, error);
    
    if (fallback) {
      try {
        return await fallback();
      } catch (fallbackError) {
        safeErrorLog(`${context}-fallback`, fallbackError);
        return null;
      }
    }
    
    return null;
  }
}

// 获取错误统计
export function getErrorStats() {
  return { ...errorStats };
}

// 重置错误统计
export function resetErrorStats() {
  errorStats.total = 0;
  errorStats.byType = {};
  errorStats.recent = [];
}
