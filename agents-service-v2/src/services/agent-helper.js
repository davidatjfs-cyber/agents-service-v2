/**
 * Agent Helper — 跨Agent互助请求机制
 *
 * 功能:
 * 1. requestAgent: 一个Agent向另一个Agent请求信息
 * 2. 循环检测: 防止A→B→A死循环
 * 3. 超时控制: 避免协作拖慢主响应
 */
import { dispatchToAgent } from './agent-handlers.js';
import { logger } from '../utils/logger.js';

const INFLIGHT = new Map();
const CIRCULAR_KEYS = new Set();

/**
 * Agent 互助请求
 *
 * @param {string} requester   - 发起请求的 agentId
 * @param {string} targetAgentId - 目标 agentId
 * @param {string} question   - 要问的问题
 * @param {object} ctx        - 上下文（含 store 等）
 * @param {number} [timeoutMs=8000] - 超时
 * @returns {Promise<{ok:boolean, response?:string, error?:string}>}
 */
export async function requestAgent(requester, targetAgentId, question, ctx, timeoutMs = 8000) {
  const store = String(ctx?.store || '').trim();
  if (!store || !requester || !targetAgentId) {
    return { ok: false, error: 'missing requester/target/store' };
  }

  const circKey = `${store}:${requester}:${targetAgentId}`;
  if (CIRCULAR_KEYS.has(circKey)) {
    logger.warn({ store, requester, targetAgentId }, 'agent-helper: circular request blocked');
    return { ok: false, error: 'circular_request' };
  }

  const infKey = `${store}:${requester}`;
  if (!INFLIGHT.has(infKey)) INFLIGHT.set(infKey, new Set());
  if (INFLIGHT.get(infKey).has(targetAgentId)) {
    return { ok: false, error: 'inflight' };
  }

  INFLIGHT.get(infKey).add(targetAgentId);
  CIRCULAR_KEYS.add(circKey);

  try {
    const result = await Promise.race([
      dispatchToAgent(targetAgentId, question, { ...ctx, isSubRequest: true }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), timeoutMs)),
    ]);
    return {
      ok: true,
      response: String(result?.response || '').trim(),
      data: result?.data || '',
    };
  } catch (e) {
    const msg = e?.message || 'unknown';
    logger.warn({ err: msg, requester, targetAgentId, store }, 'agent-helper: request failed');
    return { ok: false, error: msg };
  } finally {
    INFLIGHT.get(infKey)?.delete(targetAgentId);
  }
}

/**
 * 清空循环记录（每次新对话开始时调用）
 */
export function resetCircularGuard() {
  CIRCULAR_KEYS.clear();
}
