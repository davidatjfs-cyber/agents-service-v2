/**
 * 消息去重机制
 */

// 消息去重缓存
const messageCache = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5分钟

// 消息去重函数
export function deduplicateMessage(content, sender = 'system') {
  const key = `${sender}:${content}`;
  const now = Date.now();
  
  // 检查缓存中是否有相同消息
  if (messageCache.has(key)) {
    const lastSent = messageCache.get(key);
    if (now - lastSent < CACHE_TTL) {
      console.log(`[dedup] 消息被去重: ${content.substring(0, 50)}...`);
      return false; // 不发送
    }
  }
  
  // 更新缓存
  messageCache.set(key, now);
  
  // 清理过期缓存
  cleanupCache();
  
  return true; // 允许发送
}

// 清理过期缓存
function cleanupCache() {
  const now = Date.now();
  for (const [key, timestamp] of messageCache.entries()) {
    if (now - timestamp > CACHE_TTL) {
      messageCache.delete(key);
    }
  }
}

// 获取缓存状态
export function getCacheStatus() {
  return {
    size: messageCache.size,
    ttl: CACHE_TTL,
    messages: Array.from(messageCache.keys()).slice(0, 5)
  };
}
