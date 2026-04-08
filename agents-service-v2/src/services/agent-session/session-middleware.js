/**
 * Agent Session Middleware
 *
 * 会话中间件 - 在消息处理流程中注入会话逻辑
 */

import sessionService from './session-service.js';
import config from './config.js';

/**
 * 检查并恢复会话
 * @param {string} userId - 用户ID
 * @returns {Promise<Object|null>} 会话对象或 null
 */
async function checkAndRestoreSession(userId) {
  if (!config.enabled) {
    return null;
  }

  try {
    const session = await sessionService.getActiveSession(userId);
    if (session && sessionService.isSessionValid(session)) {
      if (config.log) {
        console.log(`[Session][Middleware] Restored: ${session.session_id} (${session.agent})`);
      }
      return session;
    }
    return null;
  } catch (err) {
    console.error('[Session][Middleware] Check error:', err.message);
    return null;
  }
}

/**
 * 创建新会话
 * @param {Object} data - 会话数据
 * @returns {Promise<Object>} 会话对象
 */
async function createNewSession(data) {
  if (!config.enabled) {
    return null;
  }

  try {
    const session = await sessionService.createSession(data);
    if (config.log) {
      console.log(`[Session][Middleware] Created: ${session.session_id}`);
    }
    return session;
  } catch (err) {
    console.error('[Session][Middleware] Create error:', err.message);
    return null;
  }
}

/**
 * 关闭会话
 * @param {string} sessionId - 会话ID
 * @param {string} reason - 关闭原因
 */
async function closeSession(sessionId, reason = 'completed') {
  if (!config.enabled) {
    return;
  }

  try {
    await sessionService.closeSession(sessionId, reason);
    if (config.log) {
      console.log(`[Session][Middleware] Closed: ${sessionId}`);
    }
  } catch (err) {
    console.error('[Session][Middleware] Close error:', err.message);
  }
}

/**
 * 处理 Agent 的 ask 响应
 * @param {Object} ctx - 上下文对象
 * @param {Object} agentResponse - Agent 的响应
 * @returns {Promise<Object>} 中间件处理结果
 */
async function handleAgentAskResponse(ctx, agentResponse) {
  if (!config.enabled) {
    return { shouldIntercept: false };
  }

  try {
    const { type, question } = agentResponse;

    if (type !== 'ask') {
      return { shouldIntercept: false };
    }

    const { user, agent } = ctx;

    // 检查是否有现有会话
    let session = await sessionService.getActiveSession(user?.username);

    if (!session) {
      // 创建新会话
      session = await sessionService.createSession({
        userId: user?.username,
        agent: agent,
        store: user?.store,
        context: {
          startTime: new Date().toISOString(),
        },
      });
    } else {
      // 增加问题轮次
      await sessionService.incrementQuestionRound(session.session_id);
    }

    // 设置待处理问题
    if (question) {
      await sessionService.setPendingQuestion(session.session_id, question);
    }

    if (config.log) {
      console.log(`[Session][Middleware] Question set: ${session.session_id}`);
    }

    return {
      shouldIntercept: true,
      session,
      response: {
        type: 'ask',
        question: question,
        sessionId: session.session_id,
      },
    };

  } catch (err) {
    console.error('[Session][Middleware] Handle ask error:', err.message);
    return { shouldIntercept: false };
  }
}

/**
 * 处理 Agent 的 final 响应
 * @param {Object} ctx - 上下文对象
 * @param {Object} agentResponse - Agent 的响应
 * @returns {Promise<Object>} 中间件处理结果
 */
async function handleAgentFinalResponse(ctx, agentResponse) {
  if (!config.enabled) {
    return { shouldIntercept: false };
  }

  try {
    const { type, answer } = agentResponse;

    if (type !== 'final') {
      return { shouldIntercept: false };
    }

    const { user } = ctx;

    // 检查是否有会话需要关闭
    const session = await sessionService.getActiveSession(user?.username);

    if (session) {
      await sessionService.closeSession(session.session_id, 'final_response');

      if (config.log) {
        console.log(`[Session][Middleware] Closed on final: ${session.session_id}`);
      }

      return {
        shouldIntercept: true,
        session,
        response: {
          type: 'final',
          answer: answer,
          sessionId: session.session_id,
        },
      };
    }

    return { shouldIntercept: false };

  } catch (err) {
    console.error('[Session][Middleware] Handle final error:', err.message);
    return { shouldIntercept: false };
  }
}

/**
 * 增强 Agent 的提示词，支持多轮对话
 * @param {Object} session - 会话对象
 * @param {string} basePrompt - 基础提示词
 * @returns {string} 增强后的提示词
 */
function enhancePromptWithSession(session, basePrompt) {
  if (!session) {
    return basePrompt;
  }

  const { context, question_round, pending_question } = session;

  let enhanced = basePrompt;

  // 添加会话上下文
  if (context && Object.keys(context).length > 0) {
    enhanced += `\n\n【会话上下文】\n${JSON.stringify(context, null, 2)}`;
  }

  // 添加问题轮次信息
  if (question_round) {
    enhanced += `\n\n【当前轮次】第 ${question_round} 轮`;
  }

  // 添加待处理问题
  if (pending_question) {
    enhanced += `\n\n【待处理问题】${pending_question}`;
  }

  enhanced += `\n\n【输出格式】如果是最后答案，输出 { "type": "final", "answer": "..." }；如果需要提问，输出 { "type": "ask", "question": "..." }`;

  return enhanced;
}

/**
 * 定期清理过期会话
 * @param {number} intervalMinutes - 清理间隔（分钟）
 */
function startCleanupScheduler(intervalMinutes = 30) {
  setInterval(async () => {
    try {
      const count = await sessionService.cleanupExpiredSessions();
      if (config.log && count > 0) {
        console.log(`[Session][Middleware] Cleaned ${count} expired sessions`);
      }
    } catch (err) {
      console.error('[Session][Middleware] Cleanup scheduler error:', err.message);
    }
  }, intervalMinutes * 60 * 1000);

  if (config.log) {
    console.log(`[Session][Middleware] Cleanup scheduler started (every ${intervalMinutes}min)`);
  }
}

export default {
  checkAndRestoreSession,
  createNewSession,
  closeSession,
  handleAgentAskResponse,
  handleAgentFinalResponse,
  enhancePromptWithSession,
  startCleanupScheduler,
};
