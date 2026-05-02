/**
 * Feedback Handler — Agent回答反馈闭环
 *
 * 当用户对Agent回答表示不满时：
 * 1. 找到该用户上次收到的Agent回答
 * 2. 把"用户问什么 / Agent答什么 / 用户反馈什么"存入 agent_memory
 * 3. 调用LLM提取"错误模式"摘要，也存入 agent_memory
 * 4. 后续同类问题通过 buildMemoryContextBlock 自动引用错误模式，避免重复踩坑
 */
import { query } from '../utils/db.js';
import { logger } from '../utils/logger.js';
import { callDeepSeek } from './llm-provider.js';

const FEEDBACK_KEYWORDS = [
  '不对', '错了', '错误', '不对吧', '完全不对',
  '没帮助', '没用', '什么垃圾', '答非所问',
  '你说的不对', '根本不是', '乱说', '瞎说',
  '👎',
];

/**
 * 判断一条消息是否为负反馈
 */
function isNegativeFeedback(text) {
  const t = String(text || '').trim();
  if (!t) return false;
  const lower = t.toLowerCase();
  return FEEDBACK_KEYWORDS.some(k => lower.includes(k));
}

/**
 * 处理负反馈：找到上次Agent回答 → 存档 → 提取错误模式
 * @returns {Promise<{handled: boolean, reply?: string}>}
 */
export async function handleFeedback(text, userId) {
  if (!isNegativeFeedback(text)) return { handled: false };

  const uid = String(userId || '').trim();
  if (!uid) return { handled: false };

  // 查该用户上次收到的Agent回答
  let lastMsg;
  try {
    const r = await query(
      `SELECT content, agent_data, created_at FROM agent_messages
       WHERE direction = 'out' AND feishu_open_id = $1
         AND content IS NOT NULL AND content != ''
       ORDER BY created_at DESC LIMIT 1`,
      [uid]
    );
    lastMsg = r.rows?.[0];
  } catch (e) {
    logger.warn({ err: e?.message }, 'feedback: query last message failed');
    return { handled: false };
  }

  if (!lastMsg) return { handled: false, reply: '暂时未找到最近的回答记录。' };

  const agentData = (typeof lastMsg.agent_data === 'object' && lastMsg.agent_data) || {};
  const lastQuery = String(agentData.query || agentData.text || '').trim();
  const lastAnswer = String(lastMsg.content || '').trim();
  const agentId = String(agentData.agent || 'unknown').trim();
  const store = String(agentData.store || '').trim();

  // 存档反馈
  const feedbackContent = [
    `[用户反馈: 不满意]`,
    lastQuery ? `用户问: ${lastQuery.slice(0, 200)}` : '',
    `Agent答: ${lastAnswer.slice(0, 200)}`,
    `用户说: ${text.slice(0, 100)}`,
  ].filter(Boolean).join('\n');

  try {
    await query(
      `INSERT INTO agent_memory (agent_id, store, memory_type, content, context)
       VALUES ($1, $2, 'feedback_bad', $3, $4)`,
      [agentId, store || null, feedbackContent.slice(0, 2000),
       JSON.stringify({ originalQuery: lastQuery.slice(0, 200) })]
    );
  } catch (e) {
    logger.warn({ err: e?.message }, 'feedback: save failed');
  }

  // 异步提取错误模式（不阻塞反馈确认）
  extractAndSaveErrorPattern(agentId, store, lastQuery, lastAnswer, text).catch(e => {
    logger.warn({ err: e?.message }, 'feedback: pattern extraction failed');
  });

  return {
    handled: true,
    reply: '已记录您的反馈，系统将避免重复同样的问题。',
  };
}

/**
 * 调 DeepSeek 提取「错误模式」摘要，写入 agent_memory
 */
async function extractAndSaveErrorPattern(agentId, store, originalQuery, answer, feedback) {
  if (!originalQuery && !answer) return;

  const prompt = `你是一个AI回答质量分析器。分析以下记录，输出一句话的「错误模式」摘要（不超过50字），用于后续避免同类错误。

用户问：${(originalQuery || '').slice(0, 300)}
AI回答：${(answer || '').slice(0, 300)}
用户反馈：${(feedback || '').slice(0, 100)}

只输出一句话摘要，不要解释。`;

  try {
    const res = await callDeepSeek(prompt, { timeoutMs: 10000 });
    const pattern = String(res?.content || res || '').trim().replace(/^["']|["']$/g, '').slice(0, 100);
    if (!pattern) return;

    await query(
      `INSERT INTO agent_memory (agent_id, store, memory_type, content)
       VALUES ($1, $2, 'error_pattern', $3)`,
      [agentId, store || null, `[error-pattern] ${pattern}`]
    );
    logger.info({ agentId, store, pattern: pattern.slice(0, 60) }, 'feedback: error pattern saved');
  } catch (e) {
    logger.warn({ err: e?.message }, 'feedback: deepseek pattern extraction failed');
  }
}
