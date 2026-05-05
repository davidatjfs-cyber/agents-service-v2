/**
 * exam-engine.js — Feishu card exam interactions for SOP system
 *
 * Builds interactive exam cards, tracks answer selection, submits for scoring,
 * and returns pass/fail results.
 */
import { randomUUID } from 'crypto';
import { query } from '../utils/db.js';
import { logger } from '../utils/logger.js';
import { sendCard } from './feishu-client.js';
import { getHrmsEmployeeByFeishuOpenId } from './feishu-users.js';
import { scoreExam, saveTrainingRecord, getSopDefinition, pickExamQuestions } from './sop-engine.js';

// ═══════════════════════════════════════════════════════════
// Tables
// ═══════════════════════════════════════════════════════════

let _tablesEnsured = false;

async function ensureExamTables() {
  if (_tablesEnsured) return;
  _tablesEnsured = true;
  try {
    await query(`
      CREATE TABLE IF NOT EXISTS sop_exam_sessions (
        id UUID PRIMARY KEY,
        sop_id UUID NOT NULL,
        user_open_id TEXT NOT NULL DEFAULT '',
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await query(`
      CREATE TABLE IF NOT EXISTS sop_exam_answers (
        session_id UUID NOT NULL,
        question_id TEXT NOT NULL,
        answer TEXT NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        PRIMARY KEY (session_id, question_id)
      )
    `);
  } catch (e) {
    logger.warn({ err: e?.message }, 'exam-engine: ensureExamTables failed');
  }
}

// ═══════════════════════════════════════════════════════════
// Answer Tracking Helpers
// ═══════════════════════════════════════════════════════════

async function createExamSession(trainingRecordId, sopId, userOpenId) {
  await ensureExamTables();
  await query(
    `INSERT INTO sop_exam_sessions (id, sop_id, user_open_id)
     VALUES ($1, $2, $3)
     ON CONFLICT (id) DO NOTHING`,
    [trainingRecordId, sopId, userOpenId || '']
  ).catch(e => {
    logger.warn({ err: e?.message, trainingRecordId }, 'exam-engine: createExamSession failed');
  });
}

async function recordAnswer(trainingRecordId, questionId, answer) {
  await ensureExamTables();
  await query(
    `INSERT INTO sop_exam_answers (session_id, question_id, answer)
     VALUES ($1, $2, $3)
     ON CONFLICT (session_id, question_id) DO UPDATE
       SET answer = EXCLUDED.answer, created_at = NOW()`,
    [trainingRecordId, questionId, String(answer || '').trim().toUpperCase()]
  ).catch(e => {
    logger.warn({ err: e?.message, trainingRecordId, questionId }, 'exam-engine: recordAnswer failed');
  });
}

/**
 * Build the full answers array from recorded answers and expected question IDs.
 * Unanswered questions get an empty-string answer.
 */
async function getRecordedAnswers(trainingRecordId, questionIds) {
  await ensureExamTables();
  const r = await query(
    `SELECT question_id, answer FROM sop_exam_answers WHERE session_id = $1`,
    [trainingRecordId]
  ).catch(() => ({ rows: [] }));

  const answerMap = {};
  for (const row of r.rows || []) {
    answerMap[row.question_id] = row.answer;
  }

  return questionIds.map(id => ({
    questionId: id,
    answer: answerMap[id] || ''
  }));
}

async function clearExamSession(trainingRecordId) {
  await query(`DELETE FROM sop_exam_answers WHERE session_id = $1`, [trainingRecordId]).catch(() => {});
  await query(`DELETE FROM sop_exam_sessions WHERE id = $1`, [trainingRecordId]).catch(() => {});
}

// ═══════════════════════════════════════════════════════════
// Card Builders
// ═══════════════════════════════════════════════════════════

/**
 * Build a Feishu interactive card showing all exam questions at once
 * with clickable answer buttons (A/B/C/D) and a submit button at the bottom.
 *
 * @param {object} sopData         SOP definition (id, title, dish_name, etc.)
 * @param {Array}  questions       Array of question objects { id, question, options }
 * @param {string} [trainingRecordId]  Optional session ID (auto-generated if omitted)
 * @returns {{ card: object, trainingRecordId: string }}
 */
export function buildSopExamCard(sopData, questions, trainingRecordId) {
  const tid = trainingRecordId || randomUUID();
  const sopId = sopData.id;
  const optionLabels = ['A', 'B', 'C', 'D'];
  const questionIds = questions.map(q => q.id);

  const elements = [];

  elements.push({
    tag: 'div',
    text: {
      tag: 'lark_md',
      content: `📝 **${sopData.title || 'SOP 考试'}**\n请认真完成以下 ${questions.length} 道考题，点击选项按钮选择答案，全部答完后点击底部「提交答案」`
    }
  });

  elements.push({ tag: 'hr' });

  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
    const options = (q.options || []).slice(0, 4);

    elements.push({
      tag: 'div',
      text: {
        tag: 'lark_md',
        content: `**${i + 1}.** ${q.question}`
      }
    });

    elements.push({
      tag: 'action',
      actions: options.map((opt, optIdx) => ({
        tag: 'button',
        text: { tag: 'plain_text', content: `${optionLabels[optIdx]}. ${String(opt).slice(0, 40)}` },
        type: 'default',
        value: JSON.stringify({
          action: 'sop_select_answer',
          trainingRecordId: tid,
          sopId,
          questionId: q.id,
          answer: optionLabels[optIdx]
        })
      }))
    });
  }

  elements.push({ tag: 'hr' });

  elements.push({
    tag: 'action',
    actions: [{
      tag: 'button',
      text: { tag: 'plain_text', content: '📨 提交答案' },
      type: 'primary',
      value: JSON.stringify({
        action: 'sop_submit_exam',
        trainingRecordId: tid,
        sopId,
        questionIds
      })
    }]
  });

  const card = {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: `📝 ${sopData.title || 'SOP 考试'}` },
      template: 'blue'
    },
    elements
  };

  return card;
}

/**
 * Build the exam result card showing score, pass/fail status,
 * and a retry button if the user did not pass.
 *
 * @param {object} sopData            SOP definition
 * @param {{ score: number, correct: number, total: number }} scoreResult  Scoring result
 * @param {string} trainingRecordId   Session ID
 * @returns {object} Feishu interactive card
 */
export function buildExamResultCard(sopData, scoreResult, trainingRecordId) {
  const passed = scoreResult.score >= 95;
  const elements = [];

  if (passed) {
    elements.push({
      tag: 'div',
      text: {
        tag: 'lark_md',
        content: `🎉 **${sopData.title || 'SOP 考试'}**\n\n✅ **通过！**\n\n分数：**${scoreResult.score}分**\n正确：${scoreResult.correct} / ${scoreResult.total}`
      }
    });
  } else {
    elements.push({
      tag: 'div',
      text: {
        tag: 'lark_md',
        content: `📝 **${sopData.title || 'SOP 考试'}**\n\n❌ **未通过**\n\n分数：**${scoreResult.score}分**（≥ 95 分通过）\n正确：${scoreResult.correct} / ${scoreResult.total}`
      }
    });

    elements.push({ tag: 'hr' });

    elements.push({
      tag: 'action',
      actions: [{
        tag: 'button',
        text: { tag: 'plain_text', content: '🔄 重考' },
        type: 'default',
        value: JSON.stringify({
          action: 'sop_retry_exam',
          sopId: sopData.id,
          trainingRecordId
        })
      }]
    });
  }

  elements.push({
    tag: 'note',
    elements: [{
      tag: 'plain_text',
      content: passed ? '✅ 已通过，无需重考' : '未达到 95 分，请点击「重考」重新答题'
    }]
  });

  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: passed ? '✅ 考试通过' : '❌ 考试未通过' },
      template: passed ? 'green' : 'red'
    },
    elements
  };
}

// ═══════════════════════════════════════════════════════════
// Card Action Handler
// ═══════════════════════════════════════════════════════════

/**
 * Process exam-related card actions.
 *
 * Checks if the action value starts with 'sop_' and routes accordingly.
 * Returns null for non-exam actions so the caller can fall through.
 *
 * @param {object} action      Card action object with a .value property
 * @param {string} userOpenId  Feishu open_id of the operator
 * @returns {Promise<object|null>} Feishu callback response { toast } or null
 */
export async function handleExamCardAction(action, userOpenId) {
  const value = action?.value || {};
  const actionType = String(value.action || '').trim();

  if (!actionType.startsWith('sop_')) return null;
  if (!userOpenId) {
    return { toast: { type: 'error', content: '无法识别用户身份' } };
  }

  switch (actionType) {
    case 'sop_select_answer':
      return handleSelectAnswer(value, userOpenId);
    case 'sop_submit_exam':
      return handleSubmitExam(value, userOpenId);
    case 'sop_retry_exam':
      return handleRetryExam(value, userOpenId);
    default:
      return null;
  }
}

/**
 * Record an individual answer selection.
 */
async function handleSelectAnswer(value, userOpenId) {
  const { trainingRecordId, sopId, questionId, answer } = value;
  if (!trainingRecordId || !questionId || !answer) {
    return { toast: { type: 'error', content: '参数缺失' } };
  }

  // Create session lazily on first answer click
  if (sopId) {
    await createExamSession(trainingRecordId, sopId, userOpenId);
  }

  await recordAnswer(trainingRecordId, questionId, answer);
  return { toast: { type: 'success', content: `已选择 ${answer}` } };
}

/**
 * Submit all recorded answers for scoring and save the training record.
 * Sends the result card to the user.
 */
async function handleSubmitExam(value, userOpenId) {
  const { trainingRecordId, sopId, questionIds } = value;
  if (!trainingRecordId) {
    return { toast: { type: 'error', content: '考试会话 ID 缺失' } };
  }
  if (!sopId || !questionIds || !Array.isArray(questionIds) || !questionIds.length) {
    return { toast: { type: 'error', content: '考试参数缺失，请重新开始考试' } };
  }

  try {
    // 1. Load questions from DB by IDs
    const questionsR = await query(
      `SELECT * FROM sop_questions WHERE id = ANY($1::uuid[])`,
      [questionIds]
    );
    const questionsMap = {};
    for (const q of questionsR.rows || []) {
      questionsMap[q.id] = q;
    }

    // Build questions array preserving order from questionIds
    const questions = questionIds.map(id => questionsMap[id]).filter(Boolean);
    if (questions.length === 0) {
      return { toast: { type: 'error', content: '未找到考题，请重新开始考试' } };
    }

    // 2. Get recorded answers (unanswered → '')
    const answers = await getRecordedAnswers(trainingRecordId, questionIds);

    // 3. Score
    const scoreResult = scoreExam(questions, answers);

    // 4. Look up user info for training record
    let employeeId = userOpenId;
    let employeeName = '';
    let store = '';
    try {
      const emp = await getHrmsEmployeeByFeishuOpenId(userOpenId);
      if (emp) {
        employeeId = emp.employee_id || emp.username || userOpenId;
        employeeName = emp.name || emp.username || '';
        store = emp.store || '';
      }
    } catch (_) {
      // fallback: use openId as employeeId
    }

    // 5. Load SOP title
    let sopTitle = '';
    try {
      const sopDef = await getSopDefinition(sopId);
      sopTitle = sopDef?.title || '';
    } catch (_) { /* ignore */ }

    // 6. Save training record
    const passed = scoreResult.score >= 95;
    await saveTrainingRecord({
      employeeId,
      employeeName,
      store,
      trainingType: 'sop_exam',
      sopId,
      sopTitle,
      triggerSource: 'sop_exam_card',
      examScore: scoreResult.score,
      totalQuestions: scoreResult.total,
      correctCount: scoreResult.correct,
      attempts: 1,
      passed,
      deadline: null
    });

    // 7. Build and send result card
    const sopData = { id: sopId, title: sopTitle };
    const resultCard = buildExamResultCard(sopData, scoreResult, trainingRecordId);
    await sendCard(userOpenId, resultCard);

    // 8. Clean up session
    await clearExamSession(trainingRecordId).catch(() => {});

    return { toast: { type: 'success', content: passed ? '🎉 考试通过！' : '❌ 未通过，可点击重考' } };
  } catch (e) {
    logger.warn({ err: e?.message, trainingRecordId }, 'exam-engine: submit failed');
    return { toast: { type: 'error', content: '提交失败：' + (e?.message || '请稍后重试') } };
  }
}

/**
 * Retry exam: pick new questions and send a new exam card.
 */
async function handleRetryExam(value, userOpenId) {
  const { sopId } = value;
  if (!sopId) {
    return { toast: { type: 'error', content: 'SOP ID 缺失' } };
  }

  try {
    // 1. Load SOP and pick fresh questions
    const sopData = await getSopDefinition(sopId);
    if (!sopData) {
      return { toast: { type: 'error', content: '未找到对应 SOP' } };
    }

    const questions = await pickExamQuestions(sopId, 20);
    if (!questions.length) {
      return { toast: { type: 'error', content: '题库为空，无法生成考卷' } };
    }

    // 2. Build new exam card
    const card = buildSopExamCard(sopData, questions);

    // 3. Send to user
    await sendCard(userOpenId, card);

    return { toast: { type: 'success', content: '已生成新的考卷，请作答' } };
  } catch (e) {
    logger.warn({ err: e?.message, sopId }, 'exam-engine: retry failed');
    return { toast: { type: 'error', content: '重考失败：' + (e?.message || '请稍后重试') } };
  }
}
