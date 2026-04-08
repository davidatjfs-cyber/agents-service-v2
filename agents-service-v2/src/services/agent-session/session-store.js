/**
 * Agent Session Store
 *
 * 会话存储层 - 数据库操作
 */

import { query } from '../../utils/db.js';
import config from './config.js';

/**
 * 确保表存在
 */
async function ensureTable() {
  const sql = `
    CREATE TABLE IF NOT EXISTS agent_sessions (
      session_id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      store TEXT,
      agent TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'active',
      context JSONB DEFAULT '{}',
      pending_question TEXT,
      question_round INTEGER DEFAULT 0,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
      updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_agent_sessions_user_id ON agent_sessions(user_id);
    CREATE INDEX IF NOT EXISTS idx_agent_sessions_state ON agent_sessions(state);
    CREATE INDEX IF NOT EXISTS idx_agent_sessions_updated_at ON agent_sessions(updated_at);
  `;

  try {
    await query(sql);
    console.log('[Session][Store] Table ensured');
  } catch (err) {
    console.error('[Session][Store] Ensure table error:', err.message);
    throw err;
  }
}

/**
 * 创建会话
 */
async function createSession(data) {
  const {
    sessionId,
    userId,
    store = null,
    agent,
    context = {},
    pendingQuestion = null,
  } = data;

  try {
    const sql = `
      INSERT INTO agent_sessions (
        session_id, user_id, store, agent, state,
        context, pending_question, question_round
      ) VALUES ($1, $2, $3, $4, 'active', $5, $6, 1)
      RETURNING *
    `;

    const result = await query(sql, [
      sessionId,
      userId,
      store,
      agent,
      JSON.stringify(context),
      pendingQuestion,
    ]);

    if (config.log) {
      console.log(`[Session][Store] Created: ${sessionId} for user ${userId}`);
    }

    return result.rows[0];

  } catch (err) {
    console.error('[Session][Store] Create error:', err.message);
    throw err;
  }
}

/**
 * 获取用户的活动会话
 */
async function getActiveSession(userId) {
  try {
    const sql = `
      SELECT * FROM agent_sessions
      WHERE user_id = $1 AND state = 'active'
      ORDER BY updated_at DESC
      LIMIT 1
    `;

    const result = await query(sql, [userId]);

    if (result.rows.length === 0) {
      return null;
    }

    const session = result.rows[0];

    // 检查是否过期
    const elapsed = Date.now() - new Date(session.updated_at).getTime();
    const timeoutMs = config.sessionTimeoutMinutes * 60 * 1000;

    if (elapsed > timeoutMs) {
      // 自动关闭过期会话
      await closeSession(session.session_id);
      if (config.log) {
        console.log(`[Session][Store] Expired: ${session.session_id}`);
      }
      return null;
    }

    return session;

  } catch (err) {
    console.error('[Session][Store] Get active error:', err.message);
    return null;
  }
}

/**
 * 更新会话
 */
async function updateSession(sessionId, updates) {
  try {
    const fields = [];
    const values = [];
    let paramIndex = 1;

    if (updates.context !== undefined) {
      fields.push(`context = $${paramIndex}`);
      values.push(JSON.stringify(updates.context));
      paramIndex++;
    }

    if (updates.pendingQuestion !== undefined) {
      fields.push(`pending_question = $${paramIndex}`);
      values.push(updates.pendingQuestion);
      paramIndex++;
    }

    if (updates.questionRound !== undefined) {
      fields.push(`question_round = $${paramIndex}`);
      values.push(updates.questionRound);
      paramIndex++;
    }

    if (updates.state !== undefined) {
      fields.push(`state = $${paramIndex}`);
      values.push(updates.state);
      paramIndex++;
    }

    if (fields.length === 0) {
      // 只更新时间戳
      fields.push(`updated_at = NOW()`);
    } else {
      fields.push(`updated_at = NOW()`);
    }

    values.push(sessionId);

    const sql = `
      UPDATE agent_sessions
      SET ${fields.join(', ')}
      WHERE session_id = $${paramIndex}
      RETURNING *
    `;

    const result = await query(sql, values);

    if (result.rows.length === 0) {
      return null;
    }

    if (config.log) {
      console.log(`[Session][Store] Updated: ${sessionId}`);
    }

    return result.rows[0];

  } catch (err) {
    console.error('[Session][Store] Update error:', err.message);
    throw err;
  }
}

/**
 * 关闭会话
 */
async function closeSession(sessionId, reason = 'completed') {
  try {
    const sql = `
      UPDATE agent_sessions
      SET state = 'closed',
          context = jsonb_set(
            COALESCE(context, '{}'::jsonb),
            '{close_reason}',
            $1
          ),
          updated_at = NOW()
      WHERE session_id = $2
      RETURNING *
    `;

    const result = await query(sql, [JSON.stringify(reason), sessionId]);

    if (result.rows.length > 0 && config.log) {
      console.log(`[Session][Store] Closed: ${sessionId} (${reason})`);
    }

    return result.rows[0]?.length > 0;

  } catch (err) {
    console.error('[Session][Store] Close error:', err.message);
    return false;
  }
}

/**
 * 清理过期会话
 */
async function cleanupExpiredSessions() {
  try {
    const timeoutMinutes = config.sessionTimeoutMinutes;

    const sql = `
      UPDATE agent_sessions
      SET state = 'expired',
          updated_at = NOW()
      WHERE state = 'active'
        AND updated_at < NOW() - INTERVAL '${timeoutMinutes} minutes'
      RETURNING session_id
    `;

    const result = await query(sql);

    if (result.rows.length > 0 && config.log) {
      console.log(`[Session][Store] Cleaned up ${result.rows.length} expired sessions`);
    }

    return result.rows.length;

  } catch (err) {
    console.error('[Session][Store] Cleanup error:', err.message);
    return 0;
  }
}

/**
 * 获取会话统计
 */
async function getSessionStats() {
  try {
    const sql = `
      SELECT
        state,
        COUNT(*) as count
      FROM agent_sessions
      WHERE updated_at >= NOW() - INTERVAL '24 hours'
      GROUP BY state
    `;

    const result = await query(sql);
    return result.rows;
  } catch (err) {
    console.error('[Session][Store] Stats error:', err.message);
    return [];
  }
}

export default {
  ensureTable,
  createSession,
  getActiveSession,
  updateSession,
  closeSession,
  cleanupExpiredSessions,
  getSessionStats,
};
