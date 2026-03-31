// SOP 动态分发 API + 阅读回执 + 小测验 (TRAIN 接入)
import { pool as getPool } from './utils/database.js';
function pool() { return getPool(); }

export async function ensureSOPDistributionSchema() {
  const p = pool();
  try {
    // SOP 版本管理
    await p.query(`CREATE TABLE IF NOT EXISTS sop_versions (
      id SERIAL PRIMARY KEY,
      sop_id TEXT NOT NULL,
      title TEXT NOT NULL,
      content TEXT,
      version INT DEFAULT 1,
      category TEXT,
      brand TEXT,
      store TEXT,
      target_roles TEXT[] DEFAULT '{}',
      status TEXT DEFAULT 'draft',
      published_at TIMESTAMPTZ,
      published_by TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )`);

    // SOP 分发记录
    await p.query(`CREATE TABLE IF NOT EXISTS sop_distributions (
      id SERIAL PRIMARY KEY,
      sop_version_id INT REFERENCES sop_versions(id),
      employee_username TEXT NOT NULL,
      employee_name TEXT,
      store TEXT,
      distributed_at TIMESTAMPTZ DEFAULT NOW(),
      feishu_msg_id TEXT,
      read_at TIMESTAMPTZ,
      read_confirmed BOOLEAN DEFAULT false,
      quiz_score NUMERIC(5,2),
      quiz_passed BOOLEAN,
      quiz_completed_at TIMESTAMPTZ,
      quiz_answers JSONB DEFAULT '[]'::jsonb,
      reminder_count INT DEFAULT 0,
      last_reminder_at TIMESTAMPTZ,
      status TEXT DEFAULT 'sent',
      UNIQUE(sop_version_id, employee_username)
    )`);

    // SOP 测验题库
    await p.query(`CREATE TABLE IF NOT EXISTS sop_quiz_questions (
      id SERIAL PRIMARY KEY,
      sop_id TEXT NOT NULL,
      question TEXT NOT NULL,
      options JSONB NOT NULL DEFAULT '[]'::jsonb,
      correct_answer INT NOT NULL,
      explanation TEXT,
      difficulty TEXT DEFAULT 'easy',
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`);

    await p.query(`CREATE INDEX IF NOT EXISTS idx_sop_dist_emp ON sop_distributions (employee_username, status)`);
    await p.query(`CREATE INDEX IF NOT EXISTS idx_sop_dist_ver ON sop_distributions (sop_version_id)`);
    await p.query(`CREATE INDEX IF NOT EXISTS idx_sop_ver_id ON sop_versions (sop_id, version)`);

    console.log('[SOP-Distribution] Tables ensured');
  } catch (e) { console.error('[SOP-Distribution] schema error:', e?.message); }
}

// ─── SOP 版本管理 ───
export async function createSOPVersion(data) {
  try {
    // 获取最新版本号
    const vr = await pool().query(`SELECT COALESCE(MAX(version),0)+1 as next_ver FROM sop_versions WHERE sop_id=$1`, [data.sopId]);
    const nextVer = vr.rows[0]?.next_ver || 1;
    const r = await pool().query(
      `INSERT INTO sop_versions (sop_id,title,content,version,category,brand,store,target_roles,status,published_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [data.sopId, data.title, data.content||'', nextVer, data.category||null,
       data.brand||null, data.store||null, data.targetRoles||['store_staff','store_manager','store_production_manager'],
       data.status||'draft', data.publishedBy||null]
    );
    return { success: true, sopVersion: r.rows[0] };
  } catch (e) { return { success: false, error: e?.message }; }
}

export async function publishSOP(sopVersionId, publishedBy) {
  try {
    const r = await pool().query(
      `UPDATE sop_versions SET status='published', published_at=NOW(), published_by=$1, updated_at=NOW() WHERE id=$2 RETURNING *`,
      [publishedBy, sopVersionId]
    );
    if (!r.rows.length) return { success: false, error: 'not_found' };
    return { success: true, sopVersion: r.rows[0] };
  } catch (e) { return { success: false, error: e?.message }; }
}

// ─── SOP 分发 ───
export async function distributeSOP(sopVersionId, employees, sendMessageFn) {
  const results = { sent: 0, failed: 0, errors: [] };
  const sop = await pool().query('SELECT * FROM sop_versions WHERE id=$1', [sopVersionId]);
  if (!sop.rows.length) return { success: false, error: 'sop_not_found' };
  const sopData = sop.rows[0];

  for (const emp of employees) {
    try {
      // 创建分发记录
      const dr = await pool().query(
        `INSERT INTO sop_distributions (sop_version_id,employee_username,employee_name,store)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (sop_version_id,employee_username) DO UPDATE SET
           distributed_at=NOW(), status='sent', reminder_count=0
         RETURNING *`,
        [sopVersionId, emp.username, emp.name||null, emp.store||null]
      );

      // 通过飞书推送
      if (sendMessageFn) {
        try {
          const msgId = await sendMessageFn({
            username: emp.username,
            title: `📋 SOP更新通知: ${sopData.title} (v${sopData.version})`,
            content: `${sopData.title}\n\n${String(sopData.content||'').slice(0,500)}...\n\n请仔细阅读后点击确认，完成后需通过小测验验证掌握程度。`,
            sopVersionId,
            distributionId: dr.rows[0]?.id
          });
          if (msgId && dr.rows[0]) {
            await pool().query('UPDATE sop_distributions SET feishu_msg_id=$1 WHERE id=$2', [msgId, dr.rows[0].id]);
          }
        } catch (e) { /* 飞书发送失败不阻断 */ }
      }
      results.sent++;
    } catch (e) {
      results.failed++;
      results.errors.push({ username: emp.username, error: e?.message });
    }
  }
  return { success: true, ...results };
}

// ─── 阅读回执 ───
export async function confirmSOPRead(distributionId, employeeUsername) {
  try {
    const r = await pool().query(
      `UPDATE sop_distributions SET read_at=NOW(), read_confirmed=true, status='read', updated_at=NOW()
       WHERE id=$1 AND employee_username=$2 RETURNING *`,
      [distributionId, employeeUsername]
    );
    if (!r.rows.length) return { success: false, error: 'not_found' };
    return { success: true, distribution: r.rows[0] };
  } catch (e) { return { success: false, error: e?.message }; }
}

// ─── 小测验 ───
export async function generateQuizForSOP(sopId, count = 3) {
  try {
    const r = await pool().query(
      `SELECT * FROM sop_quiz_questions WHERE sop_id=$1 ORDER BY RANDOM() LIMIT $2`,
      [sopId, count]
    );
    if (!r.rows.length) return { success: true, questions: [], message: '暂无测验题，请管理员添加' };
    return {
      success: true,
      questions: r.rows.map(q => ({
        id: q.id,
        question: q.question,
        options: q.options,
        difficulty: q.difficulty
      }))
    };
  } catch (e) { return { success: false, error: e?.message }; }
}

export async function submitQuizAnswers(distributionId, employeeUsername, answers) {
  try {
    // 获取分发记录关联的 SOP
    const dist = await pool().query(
      `SELECT d.*, sv.sop_id FROM sop_distributions d JOIN sop_versions sv ON d.sop_version_id=sv.id WHERE d.id=$1 AND d.employee_username=$2`,
      [distributionId, employeeUsername]
    );
    if (!dist.rows.length) return { success: false, error: 'distribution_not_found' };

    // 批量获取正确答案
    const qIds = answers.map(a => a.questionId);
    const qs = await pool().query(`SELECT id, correct_answer, explanation FROM sop_quiz_questions WHERE id = ANY($1)`, [qIds]);
    const answerMap = {};
    for (const q of qs.rows) answerMap[q.id] = q;

    let correct = 0;
    const graded = answers.map(a => {
      const q = answerMap[a.questionId];
      const isCorrect = q && q.correct_answer === a.answer;
      if (isCorrect) correct++;
      return { questionId: a.questionId, answer: a.answer, correct: isCorrect, explanation: q?.explanation };
    });

    const score = answers.length > 0 ? (correct / answers.length * 100) : 0;
    const passed = score >= 60;

    await pool().query(
      `UPDATE sop_distributions SET quiz_score=$1, quiz_passed=$2, quiz_completed_at=NOW(), quiz_answers=$3,
       status=$4 WHERE id=$5`,
      [score, passed, JSON.stringify(graded), passed ? 'completed' : 'quiz_failed', distributionId]
    );

    return { success: true, score, passed, correct, total: answers.length, details: graded };
  } catch (e) { return { success: false, error: e?.message }; }
}

// ─── 添加测验题 ───
export async function addQuizQuestion(data) {
  try {
    const r = await pool().query(
      `INSERT INTO sop_quiz_questions (sop_id,question,options,correct_answer,explanation,difficulty)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [data.sopId, data.question, JSON.stringify(data.options||[]), data.correctAnswer, data.explanation||null, data.difficulty||'easy']
    );
    return { success: true, question: r.rows[0] };
  } catch (e) { return { success: false, error: e?.message }; }
}

// ─── 分发统计 ───
export async function getSOPDistributionStats(sopVersionId) {
  try {
    const r = await pool().query(
      `SELECT COUNT(*)::int as total,
              COUNT(*) FILTER (WHERE read_confirmed)::int as read_count,
              COUNT(*) FILTER (WHERE quiz_passed)::int as quiz_passed,
              COUNT(*) FILTER (WHERE quiz_completed_at IS NOT NULL AND NOT quiz_passed)::int as quiz_failed,
              COUNT(*) FILTER (WHERE status='sent')::int as pending_read,
              AVG(quiz_score) FILTER (WHERE quiz_score IS NOT NULL) as avg_score
       FROM sop_distributions WHERE sop_version_id=$1`,
      [sopVersionId]
    );
    return { success: true, stats: r.rows[0] };
  } catch (e) { return { success: false, error: e?.message }; }
}

// ─── 催促未读 ───
export async function remindUnreadSOP(sopVersionId, sendMessageFn) {
  try {
    const unread = await pool().query(
      `SELECT d.*, sv.title as sop_title FROM sop_distributions d
       JOIN sop_versions sv ON d.sop_version_id=sv.id
       WHERE d.sop_version_id=$1 AND d.read_confirmed=false
       AND (d.last_reminder_at IS NULL OR d.last_reminder_at < NOW() - INTERVAL '4 hours')`,
      [sopVersionId]
    );
    let reminded = 0;
    for (const d of unread.rows || []) {
      if (sendMessageFn) {
        try {
          await sendMessageFn({
            username: d.employee_username,
            title: `⏰ SOP阅读提醒: ${d.sop_title}`,
            content: `您有一条SOP更新尚未阅读确认，请尽快查看并完成测验。`
          });
        } catch (e) {}
      }
      await pool().query('UPDATE sop_distributions SET reminder_count=reminder_count+1, last_reminder_at=NOW() WHERE id=$1', [d.id]);
      reminded++;
    }
    return { success: true, reminded };
  } catch (e) { return { success: false, error: e?.message }; }
}

// ─── 注册 Express 路由 ───
export function registerSOPDistributionRoutes(app, authMiddleware) {
  const auth = authMiddleware;

  // SOP 版本
  app.get('/api/sop/versions', auth, async (req, res) => {
    try {
      const r = await pool().query(`SELECT * FROM sop_versions ORDER BY created_at DESC LIMIT 50`);
      res.json({ success: true, versions: r.rows });
    } catch (e) { res.status(500).json({ error: e?.message }); }
  });
  app.post('/api/sop/versions', auth, async (req, res) => {
    res.json(await createSOPVersion({ ...req.body, publishedBy: req.user?.username }));
  });
  app.put('/api/sop/versions/:id/publish', auth, async (req, res) => {
    res.json(await publishSOP(req.params.id, req.user?.username));
  });

  // 分发
  app.post('/api/sop/distribute', auth, async (req, res) => {
    if (!req.body.sopVersionId || !Array.isArray(req.body.employees)) return res.status(400).json({ error: 'sopVersionId and employees required' });
    res.json(await distributeSOP(req.body.sopVersionId, req.body.employees));
  });

  // 阅读确认
  app.post('/api/sop/confirm-read', auth, async (req, res) => {
    res.json(await confirmSOPRead(req.body.distributionId, req.user?.username));
  });

  // 测验
  app.get('/api/sop/quiz/:sopId', auth, async (req, res) => {
    res.json(await generateQuizForSOP(req.params.sopId, Number(req.query.count)||3));
  });
  app.post('/api/sop/quiz/submit', auth, async (req, res) => {
    if (!req.body.distributionId || !Array.isArray(req.body.answers)) return res.status(400).json({ error: 'distributionId and answers required' });
    res.json(await submitQuizAnswers(req.body.distributionId, req.user?.username, req.body.answers));
  });
  app.post('/api/sop/quiz/questions', auth, async (req, res) => {
    res.json(await addQuizQuestion(req.body));
  });

  // 统计
  app.get('/api/sop/stats/:sopVersionId', auth, async (req, res) => {
    res.json(await getSOPDistributionStats(req.params.sopVersionId));
  });

  // 催促
  app.post('/api/sop/remind/:sopVersionId', auth, async (req, res) => {
    res.json(await remindUnreadSOP(req.params.sopVersionId));
  });
}
