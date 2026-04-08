/**
 * Agent Session Service
 *
 * 会话业务逻辑层
 */

import { randomUUID } from 'crypto';
import store from './session-store.js';
import config from './config.js';

/**
 * 创建新会话
 * @param {Object} data - 会话数据
 * @param {string} data.userId - 用户ID
 * @param {string} data.agent - 代理名称
 * @param {string} data.store - 门店名称（可选）
 * @param {Object} data.context - 初始上下文
 * @returns {Promise<Object>} 会话对象
 */
async function createSession(data) {
  try {
    const { userId, agent, store, context = {} } = data;

    // 同一用户只允许一个活动会话，先关闭旧的
    const existing = await store.getActiveSession(userId);
    if (existing) {
      await store.closeSession(existing.session_id, 'replaced');
      if (config.log) {
        console.log(`[Session][Service] Closed existing session: ${existing.session_id}`);
      }
    }

    const sessionId = randomUUID();
    const session = await store.createSession({
      sessionId,
      userId,
      store,
      agent,
      context,
    });

    return session;

  } catch (err) {
    console.error('[Session][Service] Create error:', err.message);
    throw err;
  }
}

/**
 * 获取用户的活动会话
 * @param {string} userId - 用户ID
 * @returns {Promise<Object|null>} 会话对象或 null
 */
async function getActiveSession(userId) {
  try {
    return await store.getActiveSession(userId);
  } catch (err) {
    console.error('[Session][Service] Get active error:', err.message);
    return null;
  }
}

/**
 * 更新会话
 * @param {string} sessionId - 会话ID
 * @param {Object} updates - 更新内容
 * @returns {Promise<Object|null>} 更新后的会话
 */
async function updateSession(sessionId, updates) {
  try {
    return await store.updateSession(sessionId, updates);
  } catch (err) {
    console.error('[Session][Service] Update error:', err.message);
    return null;
  }
}

/**
 * 关闭会话
 * @param {string} sessionId - 会话ID
 * @param {string} reason - 关闭原因
 * @returns {Promise<boolean>} 是否成功
 */
async function closeSession(sessionId, reason = 'completed') {
  try {
    return await store.closeSession(sessionId, reason);
  } catch (err) {
    console.error('[Session][Service] Close error:', err.message);
    return false;
  }
}

/**
 * 更新会话上下文
 * @param {string} sessionId - 会话ID
 * @param {Object} newContext - 要合并的上下文
 * @returns {Promise<Object|null>} 更新后的会话
 */
async function updateContext(sessionId, newContext) {
  try {
    // 获取当前会话
    const sessions = await store.updateSession(sessionId, { context: newContext });
    return sessions;
  } catch (err) {
    console.error('[Session][Service] Update context error:', err.message);
    return null;
  }
}

/**
 * 设置待处理问题
 * @param {string} sessionId - 会话ID
 * @param {string} question - 问题内容
 * @returns {Promise<Object|null>} 更新后的会话
 */
async function setPendingQuestion(sessionId, question) {
  try {
    return await store.updateSession(sessionId, {
      pendingQuestion: question,
    });
  } catch (err) {
    console.error('[Session][Service] Set pending question error:', err.message);
    return null;
  }
}

/**
 * 增加问题轮次
 * @param {string} sessionId - 会话ID
 * @returns {Promise<Object|null>} 更新后的会话
 */
async function incrementQuestionRound(sessionId) {
  try {
    const session = await store.getActiveSession(sessionId);
    if (!session) return null;

    const newRound = (session.question_round || 0) + 1;

    // 检查是否超过最大轮次
    if (newRound > config.maxQuestionRounds) {
      await store.closeSession(sessionId, 'max_rounds_exceeded');
      if (config.log) {
        console.log(`[Session][Service] Max rounds exceeded: ${sessionId}`);
      }
      return null;
    }

    return await store.updateSession(sessionId, {
      questionRound: newRound,
    });

  } catch (err) {
    console.error('[Session][Service] Increment round error:', err.message);
    return null;
  }
}

/**
 * 清理过期会话
 * @returns {Promise<number>} 清理的数量
 */
async function cleanupExpiredSessions() {
  try {
    return await store.cleanupExpiredSessions();
  } catch (err) {
    console.error('[Session][Service] Cleanup error:', err.message);
    return 0;
  }
}

/**
 * 获取会话统计
 * @returns {Promise<Array>} 统计数据
 */
async function getSessionStats() {
  try {
    return await store.getSessionStats();
  } catch (err) {
    console.error('[Session][Service] Stats error:', err.message);
    return [];
  }
}

/**
 * 检查会话是否有效
 * @param {Object} session - 会话对象
 * @returns {boolean} 是否有效
 */
function isSessionValid(session) {
  if (!session) return false;
  if (session.state !== 'active') return false;

  // 检查是否过期
  const elapsed = Date.now() - new Date(session.updated_at).getTime();
  const timeoutMs = config.sessionTimeoutMinutes * 60 * 1000;

  return elapsed <= timeoutMs;
}

export default {
  ensureTable: () => store.ensureTable(),
  createSession,
  getActiveSession,
  updateSession,
  closeSession,
  updateContext,
  setPendingQuestion,
  incrementQuestionRound,
  cleanupExpiredSessions,
  getSessionStats,
  isSessionValid,
};
