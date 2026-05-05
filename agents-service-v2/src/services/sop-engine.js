/**
 * SOP 执行保障引擎
 *
 * 职责：
 *   1. SOP 定义 CRUD（增删改查）
 *   2. AI 从 SOP 内容生成考题
 *   3. 问题 → SOP 步骤拆解（多根因关键词 + embedding fallback）
 *   4. 考试评分 & 记录
 */
import { query } from '../utils/db.js';
import { logger } from '../utils/logger.js';

/* ── 启动时确保表存在 ── */
export async function ensureSopTables() {
  try {
    await query(`
      CREATE TABLE IF NOT EXISTS sop_definitions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        dish_name TEXT NOT NULL, station TEXT NOT NULL, store TEXT,
        title TEXT NOT NULL, category TEXT DEFAULT 'product',
        version INT DEFAULT 1, status TEXT DEFAULT 'active',
        created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await query(`
      CREATE TABLE IF NOT EXISTS sop_steps (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        sop_id UUID REFERENCES sop_definitions(id) ON DELETE CASCADE,
        seq INT NOT NULL, action TEXT NOT NULL, responsible_role TEXT,
        time_limit_seconds INT, quality_standard TEXT,
        common_failure TEXT, failure_action TEXT, evidence_required TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await query(`
      CREATE TABLE IF NOT EXISTS sop_questions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        sop_id UUID REFERENCES sop_definitions(id) ON DELETE CASCADE,
        step_id UUID REFERENCES sop_steps(id) ON DELETE SET NULL,
        question TEXT NOT NULL, options JSONB, correct_answer TEXT NOT NULL,
        explanation TEXT, difficulty TEXT DEFAULT 'medium', status TEXT DEFAULT 'active',
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await query(`
      CREATE TABLE IF NOT EXISTS employee_training_records (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        employee_id TEXT NOT NULL, employee_name TEXT NOT NULL, store TEXT,
        training_type TEXT NOT NULL, sop_id UUID REFERENCES sop_definitions(id),
        sop_title TEXT, trigger_source TEXT, problem_description TEXT,
        exam_score NUMERIC(5,2), total_questions INT, correct_count INT,
        attempts INT DEFAULT 1, passed BOOLEAN DEFAULT false, deadline DATE,
        passed_at TIMESTAMPTZ, escalated BOOLEAN DEFAULT false,
        escalated_at TIMESTAMPTZ, created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await query(`CREATE INDEX IF NOT EXISTS idx_sop_steps_sop ON sop_steps(sop_id, seq)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_sop_questions_sop ON sop_questions(sop_id)`);
    logger.info('sop-engine: tables ensured');
  } catch (e) {
    logger.warn({ err: e?.message }, 'sop-engine: ensureSopTables failed');
  }
}

/* ── SOP 定义 CRUD ── */

export async function listSopDefinitions({ dishName, station, store, status, category, page = 1, limit = 50 } = {}) {
  const conds = [];
  const params = [];
  let idx = 1;
  if (dishName) { conds.push(`dish_name ILIKE $${idx++}`); params.push(`%${dishName}%`); }
  if (station) { conds.push(`station = $${idx++}`); params.push(station); }
  if (store) { conds.push(`(store IS NULL OR store = $${idx++})`); params.push(store); }
  if (status) { conds.push(`status = $${idx++}`); params.push(status); }
  if (category) { conds.push(`category = $${idx++}`); params.push(category); }
  const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
  const offset = (page - 1) * limit;
  const countR = await query(`SELECT COUNT(*)::int AS c FROM sop_definitions ${where}`, params);
  const rowsR = await query(
    `SELECT * FROM sop_definitions ${where} ORDER BY updated_at DESC LIMIT $${idx++} OFFSET $${idx++}`,
    [...params, limit, offset]
  );
  return { rows: rowsR.rows || [], total: countR.rows?.[0]?.c || 0, page, limit };
}

export async function getSopDefinition(id) {
  const r = await query(`SELECT * FROM sop_definitions WHERE id = $1`, [id]);
  const sop = r.rows?.[0];
  if (!sop) return null;
  const stepsR = await query(`SELECT * FROM sop_steps WHERE sop_id = $1 ORDER BY seq`, [id]);
  const questionsR = await query(`SELECT * FROM sop_questions WHERE sop_id = $1 AND status='active' ORDER BY difficulty`, [id]);
  return { ...sop, steps: stepsR.rows || [], questions: questionsR.rows || [] };
}

export async function createSopDefinition({ dishName, station, store, title, category }) {
  const r = await query(
    `INSERT INTO sop_definitions (dish_name, station, store, title, category) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [dishName, station, store || null, title, category || 'product']
  );
  return r.rows?.[0] || null;
}

export async function updateSopDefinition(id, fields) {
  const sets = []; const params = []; let idx = 1;
  for (const [k, v] of Object.entries(fields)) {
    if (['dish_name', 'station', 'store', 'title', 'category', 'status', 'version'].includes(k)) {
      sets.push(`${k} = $${idx++}`);
      params.push(v);
    }
  }
  if (!sets.length) return null;
  sets.push(`updated_at = NOW()`);
  params.push(id);
  const r = await query(`UPDATE sop_definitions SET ${sets.join(', ')} WHERE id = $${idx} RETURNING *`, params);
  return r.rows?.[0] || null;
}

export async function deleteSopDefinition(id) {
  await query(`DELETE FROM sop_definitions WHERE id = $1`, [id]);
  return { ok: true };
}

/* ── SOP 步骤 CRUD ── */

export async function upsertSopSteps(sopId, steps) {
  await query(`DELETE FROM sop_steps WHERE sop_id = $1`, [sopId]);
  for (const s of steps) {
    await query(
      `INSERT INTO sop_steps (sop_id, seq, action, responsible_role, time_limit_seconds, quality_standard, common_failure, failure_action, evidence_required) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [sopId, s.seq, s.action, s.responsible_role || null, s.time_limit_seconds || null, s.quality_standard || null, s.common_failure || null, s.failure_action || null, s.evidence_required || null]
    );
  }
  return { ok: true, count: steps.length };
}

/* ── 问题拆解：多根因匹配 ── */

/**
 * 根据问题描述和菜品名称，查找所有匹配的 SOP 步骤（多根因）
 * @param {string} dishName 菜品名称
 * @param {string} problem 问题描述（如"太咸"、"肉太柴"）
 * @param {string} store 门店（可选）
 * @returns {Promise<Array<{sop, step, matchType}>>}
 */
export async function resolveProblemToSteps(dishName, problem, store) {
  if (!dishName || !problem) return [];

  // 1. 查找菜品对应的 SOP
  const sopR = await query(
    `SELECT * FROM sop_definitions
     WHERE dish_name ILIKE $1 AND status = 'active'
       AND (store IS NULL OR store = $2 OR $2 IS NULL)
     ORDER BY store IS NOT NULL DESC, version DESC
     LIMIT 1`,
    [dishName, store || '']
  );
  const sop = sopR.rows?.[0];
  if (!sop) return [];

  // 2. 关键词拆解（按常见问题词拆分）
  const keywords = problem.replace(/[，。、！？\s]/g, ' ').split(/\s+/).filter(Boolean);

  // 3. SQL 多条件匹配 common_failure
  if (keywords.length) {
    const likeClauses = keywords.map((_, i) => `common_failure ILIKE $${i + 2}`);
    const stepsR = await query(
      `SELECT * FROM sop_steps WHERE sop_id = $1 AND (${likeClauses.join(' OR ')}) ORDER BY seq`,
      [sop.id, ...keywords.map(k => `%${k}%`)]
    );
    if (stepsR.rows?.length) {
      return stepsR.rows.map(step => ({ sop, step, matchType: 'keyword' }));
    }
  }

  // 4. fallback: 返回 SOP 所有步骤（无精确匹配时）
  const allStepsR = await query(`SELECT * FROM sop_steps WHERE sop_id = $1 ORDER BY seq`, [sop.id]);
  return (allStepsR.rows || []).map(step => ({ sop, step, matchType: 'all' }));
}

/* ── AI 出题 ── */

/**
 * 为指定 SOP 生成考题（调用 LLM）
 * @param {string} sopId
 * @param {number} count 生成题目数量
 * @returns {Promise<Array>} 生成的题目数组
 */
export async function generateQuestionsForSop(sopId, count = 20) {
  const sop = await getSopDefinition(sopId);
  if (!sop) throw new Error(`SOP not found: ${sopId}`);

  // 构建 SOP 内容摘要
  const stepTexts = (sop.steps || []).map(s =>
    `步骤${s.seq}: ${s.action}\n  标准: ${s.quality_standard || '无'}\n  常见问题: ${s.common_failure || '无'}\n  补救: ${s.failure_action || '无'}`
  ).join('\n');
  const content = `菜品: ${sop.dish_name}\n档口: ${sop.station}\nSOP标题: ${sop.title}\n\n${stepTexts}`;

  // 调用 LLM 生成题目
  const prompt = `你是一位专业的餐饮培训师。请根据以下 SOP 内容，生成 ${count} 道高质量选择题，用于考核员工对操作标准的掌握程度。

SOP 内容：
${content}

要求：
1. 每道题 4 个选项（A/B/C/D），有且仅有一个正确答案
2. 题目难度覆盖 easy(30%) / medium(40%) / hard(30%)
3. 题型包括：知识题（考查操作参数/标准值）、情景题（考查面对问题时的处理方式）
4. 每道题附带简短解析（说明为什么这个答案正确）
5. 输出格式为 JSON 数组，每项包含：question, options(数组), correctAnswer, explanation, difficulty

只输出 JSON，不要其他文字。`;

  try {
    const { callDeepSeek } = await import('./llm-provider.js');
    const resp = await callDeepSeek(prompt, { temperature: 0.7, maxTokens: 4096 });
    const text = typeof resp === 'string' ? resp : (resp?.text || resp?.content || '');
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (!jsonMatch) throw new Error('No JSON array found in LLM response');
    const questions = JSON.parse(jsonMatch[0]);

    // 入库
    let created = 0;
    for (const q of questions) {
      if (!q.question || !q.options || !q.correctAnswer) continue;
      const optArr = Array.isArray(q.options) ? q.options.map(o => String(o).startsWith('A.') || String(o).startsWith('B.') || String(o).startsWith('C.') || String(o).startsWith('D.') ? o : o) : [];
      if (!optArr.length) continue;
      await query(
        `INSERT INTO sop_questions (sop_id, question, options, correct_answer, explanation, difficulty) VALUES ($1,$2,$3,$4,$5,$6)`,
        [sopId, q.question, JSON.stringify(optArr), q.correctAnswer, q.explanation || '', q.difficulty || 'medium']
      );
      created++;
    }
    return { generated: created, total: created };
  } catch (e) {
    logger.warn({ err: e?.message, sopId }, 'sop-engine: generateQuestions failed');
    throw e;
  }
}

/* ── 考试引擎 ── */

/**
 * 从 sop_questions 随机抽题
 * @param {string} sopId
 * @param {number} count 抽题数量
 */
export async function pickExamQuestions(sopId, count = 20) {
  // 先拿该 SOP 的题目
  let r = await query(
    `SELECT * FROM sop_questions WHERE sop_id = $1 AND status = 'active' ORDER BY random() LIMIT $2`,
    [sopId, count]
  );
  // 如果不够，从同类菜品 SOP 补充
  if ((r.rows?.length || 0) < count) {
    const sop = await query(`SELECT dish_name, station FROM sop_definitions WHERE id = $1`, [sopId]);
    const dishName = sop.rows?.[0]?.dish_name;
    if (dishName) {
      const extra = await query(
        `SELECT q.* FROM sop_questions q JOIN sop_definitions d ON d.id = q.sop_id
         WHERE d.dish_name ILIKE $1 AND q.sop_id != $2 AND q.status = 'active'
         ORDER BY random() LIMIT $3`,
        [dishName, sopId, count - (r.rows?.length || 0)]
      );
      if (extra.rows?.length) r.rows.push(...extra.rows);
    }
  }
  return (r.rows || []).slice(0, count);
}

/**
 * 评分：选择题直接比对
 * @param {Array} questions 题目数组（含 id, correct_answer）
 * @param {Array} answers 用户答案数组 [{questionId, answer}]
 */
export function scoreExam(questions, answers) {
  const answerMap = {};
  for (const a of answers || []) answerMap[a.questionId] = String(a.answer || '').trim().toUpperCase();

  let correct = 0;
  const results = [];
  for (const q of questions) {
    const userAns = answerMap[q.id] || '';
    const isCorrect = userAns === String(q.correct_answer || '').trim().toUpperCase();
    if (isCorrect) correct++;
    results.push({
      questionId: q.id,
      question: q.question,
      options: q.options,
      correctAnswer: q.correct_answer,
      userAnswer: userAns,
      isCorrect,
      explanation: q.explanation
    });
  }
  const score = questions.length > 0 ? Math.round((correct / questions.length) * 10000) / 100 : 0;
  return { score, correct, total: questions.length, results };
}

/**
 * 保存考试记录
 */
export async function saveTrainingRecord({
  employeeId, employeeName, store, trainingType, sopId, sopTitle,
  triggerSource, problemDescription, examScore, totalQuestions, correctCount,
  attempts, passed, deadline
}) {
  const r = await query(
    `INSERT INTO employee_training_records
     (employee_id, employee_name, store, training_type, sop_id, sop_title,
      trigger_source, problem_description, exam_score, total_questions, correct_count,
      attempts, passed, deadline)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
     RETURNING *`,
    [employeeId, employeeName, store || null, trainingType, sopId || null, sopTitle || null,
     triggerSource || null, problemDescription || null, examScore, totalQuestions, correctCount,
     attempts, passed, deadline || null]
  );
  return r.rows?.[0] || null;
}
