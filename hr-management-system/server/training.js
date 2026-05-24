/**
 * HRMS 培训认证模块
 *
 * 功能：知识点管理、培训指派、AI 辅助学习、测验、实操判定、认证管理
 * 权限：管理端（admin/hq_manager/store_manager/store_production_manager/hr_manager）
 *       员工端（所有登录用户）
 */

import { pool as getPool } from './utils/database.js';
import { callLLM, callVisionLLM, callVisionLLMVideo, lookupFeishuUserByUsername, sendLarkMessage } from './agents.js';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import axios from 'axios';
import { randomUUID } from 'crypto';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const uploadsDir = path.join(__dirname, 'uploads', 'training');
function pool() { return getPool(); }

const MANAGER_ROLES = ['admin', 'hq_manager', 'store_manager', 'store_production_manager', 'hr_manager'];
function isManager(role) { return MANAGER_ROLES.includes(role); }
const TRAINING_REMINDER_INTERVAL_MS = Math.max(30 * 60 * 1000, Number(process.env.TRAINING_REMINDER_INTERVAL_MS || 60 * 60 * 1000));
let _trainingReminderSchedulerStarted = false;

// JWT 不含 store，从 employees 表实时查
async function getUserStore(username) {
  try {
    const r = await pool().query(`SELECT store FROM employees WHERE username = $1 LIMIT 1`, [username]);
    return String(r.rows[0]?.store || '').trim();
  } catch (_) { return ''; }
}

// 角色层级：谁能给谁布置培训
// admin/hr_manager → 所有人
// hq_manager → 店长 + 出品经理 + 所有员工
// store_manager → 前厅员工（cashier, front_manager, store_employee）
// store_production_manager → 后厨员工（store_employee，或岗位含厨房关键词）
function getAssignableRoles(assignerRole) {
  if (['admin', 'hr_manager'].includes(assignerRole)) return null; // null = 所有人
  if (assignerRole === 'hq_manager') return ['store_manager', 'store_production_manager', 'store_employee', 'cashier', 'front_manager'];
  if (assignerRole === 'store_manager') return ['store_employee', 'cashier', 'front_manager'];
  if (assignerRole === 'store_production_manager') return ['store_employee'];
  return null;
}

function getShanghaiDateKey(date = new Date()) {
  return date.toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
}

function parseScoringJson(jsonText) {
  try {
    const parsed = JSON.parse(jsonText);
    const steps = parsed.steps || [];
    const totalScore = parsed.total_score != null ? Number(parsed.total_score) : null;
    const verdict = ['passed', 'review', 'failed'].includes(parsed.verdict) ? parsed.verdict : 'review';
    const summary = parsed.summary || '';
    // AI sometimes returns the string "null" — treat it as absent
    const failReason = (parsed.fail_reason && parsed.fail_reason !== 'null') ? parsed.fail_reason : null;
    // If fail_reason is present, force failed
    const finalVerdict = failReason ? 'failed' : verdict;
    const feedback = failReason ? `【一票否决】${failReason}。${summary}` : summary;
    return { aiVerdict: finalVerdict, aiFeedback: feedback, aiStepScores: steps, aiTotalScore: totalScore };
  } catch (e) {
    return { aiVerdict: 'review', aiFeedback: '评分解析失败，需人工审核', aiStepScores: null, aiTotalScore: null };
  }
}

function getShanghaiDateTimeText(date = new Date()) {
  return date.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
}

function parseReminderMeta(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  return raw;
}

async function createTrainingUserNotification(targetUsername, title, message, meta) {
  try {
    await pool().query(
      `INSERT INTO hrms_user_notifications (target_username, title, message, type, meta, created_at)
       VALUES ($1, $2, $3, $4, $5, NOW())`,
      [
        targetUsername,
        title,
        message,
        'training_assignment',
        JSON.stringify(meta || {})
      ]
    );
  } catch (_) {}
}

async function sendTrainingFeishuMessage(username, message) {
  try {
    const fu = await lookupFeishuUserByUsername(username);
    if (fu?.open_id) {
      await sendLarkMessage(fu.open_id, message, { skipDedup: true });
      return true;
    }
  } catch (_) {}
  return false;
}

// ─── Schema ───────────────────────────────────────────────
export async function ensureTrainingSchema() {
  try {
    // 知识点表
    await pool().query(`
      CREATE TABLE IF NOT EXISTS training_topics (
        id SERIAL PRIMARY KEY,
        title VARCHAR(100) NOT NULL,
        position VARCHAR(50) NOT NULL,
        description TEXT,
        key_points JSONB DEFAULT '[]',
        practice_task TEXT,
        sort_order INT DEFAULT 0,
        is_active BOOLEAN DEFAULT true,
        created_by VARCHAR(100),
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);

    // 培训指派表
    await pool().query(`
      CREATE TABLE IF NOT EXISTS training_assignments (
        id SERIAL PRIMARY KEY,
        employee_username VARCHAR(100) NOT NULL,
        topic_id INT NOT NULL REFERENCES training_topics(id),
        assigned_by VARCHAR(100),
        due_date DATE,
        note TEXT,
        created_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(employee_username, topic_id)
      )
    `);
    await pool().query(`CREATE INDEX IF NOT EXISTS idx_ta_employee ON training_assignments (employee_username)`);
    await pool().query(`CREATE INDEX IF NOT EXISTS idx_ta_topic ON training_assignments (topic_id)`);
    await pool().query(`CREATE INDEX IF NOT EXISTS idx_ta_due_date ON training_assignments (due_date)`);
    await pool().query(`ALTER TABLE training_assignments ADD COLUMN IF NOT EXISTS require_practice BOOLEAN DEFAULT false`);
    await pool().query(`ALTER TABLE training_assignments ADD COLUMN IF NOT EXISTS reminder_meta JSONB DEFAULT '{}'::jsonb`);

    // 学习会话表
    await pool().query(`
      CREATE TABLE IF NOT EXISTS training_sessions (
        id SERIAL PRIMARY KEY,
        employee_username VARCHAR(100) NOT NULL,
        topic_id INT NOT NULL REFERENCES training_topics(id),
        chat_history JSONB DEFAULT '[]',
        quiz_questions JSONB DEFAULT '[]',
        quiz_answers JSONB DEFAULT '[]',
        quiz_score INT,
        quiz_passed BOOLEAN DEFAULT false,
        status VARCHAR(20) DEFAULT 'learning',
        started_at TIMESTAMP DEFAULT NOW(),
        quiz_passed_at TIMESTAMP,
        UNIQUE(employee_username, topic_id)
      )
    `);
    await pool().query(`CREATE INDEX IF NOT EXISTS idx_ts_employee ON training_sessions (employee_username)`);
    await pool().query(`CREATE INDEX IF NOT EXISTS idx_ts_topic ON training_sessions (topic_id)`);

    // 认证记录表
    await pool().query(`
      CREATE TABLE IF NOT EXISTS training_certifications (
        id SERIAL PRIMARY KEY,
        session_id INT NOT NULL REFERENCES training_sessions(id),
        employee_username VARCHAR(100) NOT NULL,
        topic_id INT NOT NULL,
        media_url VARCHAR(500),
        media_type VARCHAR(20),
        ai_verdict VARCHAR(20),
        ai_feedback TEXT,
        ai_raw_response JSONB,
        manager_verdict VARCHAR(20),
        manager_note TEXT,
        manager_reviewed_by VARCHAR(100),
        certified_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    await pool().query(`CREATE INDEX IF NOT EXISTS idx_tc_session ON training_certifications (session_id)`);
    await pool().query(`CREATE INDEX IF NOT EXISTS idx_tc_employee ON training_certifications (employee_username)`);

    // 关联知识库文章（多选）
    await pool().query(`ALTER TABLE training_topics ADD COLUMN IF NOT EXISTS kb_article_ids UUID[] DEFAULT '{}'`);
    // 门店归属（空=全部门店可见）
    await pool().query(`ALTER TABLE training_topics ADD COLUMN IF NOT EXISTS store VARCHAR(100) DEFAULT ''`);
    // 允许同一员工对同一知识点有多次指派（移除唯一约束）
    await pool().query(`ALTER TABLE training_assignments DROP CONSTRAINT IF EXISTS training_assignments_employee_username_topic_id_key`);
    // AI 智能解析缓存（生成一次，全员复用）
    await pool().query(`ALTER TABLE knowledge_base ADD COLUMN IF NOT EXISTS ai_explanation TEXT`);
    // 考试历史记录（每次提交均追加）
    await pool().query(`ALTER TABLE training_sessions ADD COLUMN IF NOT EXISTS quiz_history JSONB DEFAULT '[]'`);

    // ── 实操图谱评分（2026-05-23新增）──
    await pool().query(`ALTER TABLE knowledge_base ADD COLUMN IF NOT EXISTS step_rubric JSONB`);
    await pool().query(`ALTER TABLE training_topics ADD COLUMN IF NOT EXISTS step_rubric JSONB`);
    await pool().query(`ALTER TABLE training_certifications ADD COLUMN IF NOT EXISTS ai_step_scores JSONB`);
    await pool().query(`ALTER TABLE training_certifications ADD COLUMN IF NOT EXISTS ai_total_score INT`);
    await pool().query(`ALTER TABLE training_certifications ADD COLUMN IF NOT EXISTS review_status VARCHAR(20) DEFAULT 'pending'`);
    await pool().query(`ALTER TABLE training_certifications ADD COLUMN IF NOT EXISTS manager_score INT`);
    await pool().query(`ALTER TABLE training_certifications ADD COLUMN IF NOT EXISTS final_score INT`);

    console.log('[Training] Schema ensured');
  } catch (e) {
    console.error('[Training] Schema error:', e?.message);
  }
}

// ─── Routes Registration ───────────────────────────────────────────────
export function registerTrainingRoutes(app, authMiddleware, uploadMiddleware) {

  // ═══════════════════════════════════════════════════════════
  // 管理端路由
  // ═══════════════════════════════════════════════════════════

  // GET /api/training/topics - 列出知识点
  app.get('/api/training/topics', authMiddleware, async (req, res) => {
    try {
      if (!isManager(req.user?.role)) {
        return res.status(403).json({ error: '无权限访问' });
      }
      const position = req.query.position || '';
      const params = [];
      let sql = `SELECT * FROM training_topics WHERE is_active = true`;
      // 门店过滤：店长/出品经理只看自己门店（或全部门店的知识点）
      const userRole = req.user?.role;
      const userStore = ['store_manager', 'store_production_manager'].includes(userRole)
        ? await getUserStore(req.user?.username) : '';
      if (userStore) {
        sql += ` AND (store = '' OR store = $${params.length + 1})`;
        params.push(userStore);
      }
      if (position) {
        sql += ` AND (position = $${params.length + 1} OR position LIKE $${params.length + 2} OR position LIKE $${params.length + 3} OR position LIKE $${params.length + 4})`;
        params.push(position, position + ',%', '%,' + position, '%,' + position + ',%');
      }
      sql += ` ORDER BY sort_order, id`;
      const result = await pool().query(sql, params);
      res.json({ success: true, topics: result.rows });
    } catch (e) {
      res.json({ success: false, error: e?.message });
    }
  });

  // POST /api/training/topics - 创建知识点
  app.post('/api/training/topics', authMiddleware, async (req, res) => {
    try {
      if (!['admin', 'hq_manager'].includes(req.user?.role)) {
        return res.status(403).json({ error: '仅管理员和总部营运可新建知识点' });
      }
      const { title, positions, position, description, key_points, practice_task, sort_order, kb_article_ids, store } = req.body;
      // positions 优先（新格式：数组），position 备用（旧格式：字符串）
      const posArr = Array.isArray(positions) && positions.length ? positions : (position ? [position] : []);
      const posStr = posArr.join(',');
      if (!title?.trim() || !posStr) {
        return res.json({ success: false, error: '标题和岗位必填' });
      }
      const kbIds = Array.isArray(kb_article_ids) ? kb_article_ids : [];
      // 门店：store_manager/production_mgr 强制使用自己的门店
      const userRole = req.user?.role;
      let storeVal = String(store || '').trim();
      if (['store_manager', 'store_production_manager'].includes(userRole)) {
        storeVal = await getUserStore(req.user?.username);
      }
      const result = await pool().query(
        `INSERT INTO training_topics (title, position, description, key_points, practice_task, sort_order, created_by, kb_article_ids, store)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING *`,
        [title, posStr, description || '', JSON.stringify(key_points || []), practice_task || '', sort_order || 0, req.user?.username, kbIds, storeVal]
      );
      res.json({ success: true, topic: result.rows[0] });
    } catch (e) {
      res.json({ success: false, error: e?.message });
    }
  });

  // PUT /api/training/topics/:id - 更新知识点
  app.put('/api/training/topics/:id', authMiddleware, async (req, res) => {
    try {
      if (!['admin', 'hq_manager'].includes(req.user?.role)) {
        return res.status(403).json({ error: '仅管理员和总部营运可编辑知识点' });
      }
      const { id } = req.params;
      const { title, positions, position, description, key_points, practice_task, sort_order, kb_article_ids, store } = req.body;
      const posArr = Array.isArray(positions) && positions.length ? positions : (position ? [position] : null);
      const posStr = posArr ? posArr.join(',') : null;
      const kbIds = Array.isArray(kb_article_ids) ? kb_article_ids : null;
      // 门店：store_manager/production_mgr 强制使用自己的门店
      const userRole = req.user?.role;
      let storeVal = store !== undefined ? String(store || '').trim() : null;
      if (['store_manager', 'store_production_manager'].includes(userRole)) {
        storeVal = await getUserStore(req.user?.username);
      }
      const result = await pool().query(
        `UPDATE training_topics
         SET title = COALESCE($1, title),
             position = COALESCE($2, position),
             description = COALESCE($3, description),
             key_points = COALESCE($4, key_points),
             practice_task = COALESCE($5, practice_task),
             sort_order = COALESCE($6, sort_order),
             kb_article_ids = COALESCE($7, kb_article_ids),
             store = COALESCE($9, store)
         WHERE id = $8
         RETURNING *`,
        [title, posStr, description, JSON.stringify(key_points), practice_task, sort_order, kbIds, id, storeVal]
      );
      if (result.rows.length === 0) {
        return res.json({ success: false, error: '知识点不存在' });
      }
      res.json({ success: true, topic: result.rows[0] });
    } catch (e) {
      res.json({ success: false, error: e?.message });
    }
  });

  // DELETE /api/training/topics/:id - 软删除知识点
  app.delete('/api/training/topics/:id', authMiddleware, async (req, res) => {
    try {
      if (!['admin', 'hq_manager'].includes(req.user?.role)) {
        return res.status(403).json({ error: '仅管理员和总部营运可删除知识点' });
      }
      await pool().query(`UPDATE training_topics SET is_active = false WHERE id = $1`, [req.params.id]);
      res.json({ success: true });
    } catch (e) {
      res.json({ success: false, error: e?.message });
    }
  });

  // ═══════════════════════════════════════════════════════════
  // 步骤图谱生成 & 管理
  // ═══════════════════════════════════════════════════════════

  // POST /api/knowledge/:id/analyze-rubric — 分析KB视频/图片，生成步骤图谱
  app.post('/api/knowledge/:id/analyze-rubric', authMiddleware, async (req, res) => {
    try {
      if (!isManager(req.user?.role)) {
        return res.status(403).json({ error: '无权限' });
      }
      const { id } = req.params;
      const article = (await pool().query(`SELECT * FROM knowledge_base WHERE id = $1`, [id])).rows[0];
      if (!article) return res.json({ success: false, error: '知识条目不存在' });

      const fileField = article.file_path || '';
      const isVideo = /\.(mp4|mov|webm|avi)$/i.test(fileField);
      const baseUrl = process.env.SERVER_BASE_URL || 'https://nnyx.cc';

      const dishName = (article.title || '').trim();
      const dishDesc = article.content ? `\n菜品描述：${article.content.slice(0, 200)}` : '';

      const rubricPrompt = `你是餐饮培训标准制定专家。
【重要】当前考核菜品/操作的准确名称是：「${dishName}」${dishDesc}
这个名称来自文件名，是该菜品/操作的真实名称，请严格以此为准，不要根据图片自行猜测菜名。

请认真观看视频/图片，提取标准化的培训考核评分表。输出格式必须严格对齐厨房SOP结构，包含每步的：操作动作、评分权重、质量标准、常见失败、补救措施、是否为关键步骤，以及3-5个可视化检查点用于实操评分。

要求：
1. 第一项必须是「菜品核验：${dishName || '考核内容'}」（权重10分）：核查员工提交的实操图片/视频是否为「${dishName || '考核内容'}」，checks中列出该菜品的唯一识别特征。
2. 提取后续操作步骤时，每步必须包含完整厨房SOP字段。
3. action/checks 必须是视觉上可判定的（能看到），不能是不可见的（"温度""时间"等抽象概念转为视觉描述）。
4. 判断工位(station)名称，如"烧味""切配""炒锅""凉菜"等。
5. 列出3-5个一票否决项（fail_criteria），出现任一即不合格。
6. 合格线设为80分（pass_threshold）。
7. 权重：菜品核验10分 + 其余步骤合计90分（权重根据重要性分配）。
8. 严格返回JSON，不要额外文字。

返回JSON格式（严格使用厨房SOP结构）：
{
  "dish_name": "${dishName}",
  "station": "识别出的工位",
  "type": "steps",
  "items": [
    {
      "step_seq": 1,
      "action": "操作动作名称，如：烫鸭",
      "weight": 10,
      "quality_standard": "质量标准，如：表皮均匀收缩",
      "common_failure": "常见失败，如：烫制不均",
      "failure_action": "补救措施，如：重新烫制",
      "is_critical": false,
      "time_limit_seconds": null,
      "checks": ["可视化检查点1", "可视化检查点2"]
    }
  ],
  "fail_criteria": ["一票否决项1", "一票否决项2"],
  "pass_threshold": 80
}`;

      let llmResult;
      if (isVideo) {
        const videoUrl = `${baseUrl}${fileField}`;
        const framePath = path.join(uploadsDir, `rubric-frame-${randomUUID()}.jpg`);
        try {
          const localVideoPath = path.join(__dirname, '..', fileField);
          execFileSync('ffmpeg', ['-i', localVideoPath, '-ss', '00:00:05', '-frames:v', '1', framePath], { timeout: 30000 });
          llmResult = await callVisionLLM(framePath, rubricPrompt);
          try { fs.unlinkSync(framePath); } catch (_) {}
        } catch (ffmpegErr) {
          // Try video API as fallback
          try {
            llmResult = await callVisionLLMVideo(videoUrl, rubricPrompt);
          } catch (vErr) {
            return res.json({ success: false, error: '视频分析失败: ' + (ffmpegErr?.message || vErr?.message) });
          }
        }
      } else {
        const fileAbsPath = path.join(__dirname, '..', fileField);
        if (!fs.existsSync(fileAbsPath)) return res.json({ success: false, error: '文件未找到' });
        llmResult = await callVisionLLM(fileAbsPath, rubricPrompt);
      }

      if (!llmResult?.ok) return res.json({ success: false, error: 'AI分析失败: ' + (llmResult?.error || 'unknown') });

      const text = llmResult.content || '';
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return res.json({ success: false, error: 'AI返回格式异常: ' + text.slice(0, 200) });

      const rubric = JSON.parse(jsonMatch[0]);
      if (!rubric.items || !Array.isArray(rubric.items)) return res.json({ success: false, error: '返回数据缺少items字段' });

      const totalWeight = rubric.items.reduce((s, item) => s + (Number(item.weight) || 0), 0);
      if (Math.abs(totalWeight - 100) > 5) {
        return res.json({ success: false, error: `步骤权重总和应为100，当前为${totalWeight}`, raw_rubric: rubric });
      }

      await pool().query(`UPDATE knowledge_base SET step_rubric = $1 WHERE id = $2`, [JSON.stringify(rubric), id]);
      res.json({ success: true, rubric });
    } catch (e) {
      console.error('[Training] analyze-rubric error:', e?.message);
      res.json({ success: false, error: e?.message });
    }
  });

  // POST /api/training/topics/:id/generate-rubric — 话题从关联KB视频生成图谱
  app.post('/api/training/topics/:id/generate-rubric', authMiddleware, async (req, res) => {
    try {
      if (!isManager(req.user?.role)) return res.status(403).json({ error: '无权限' });
      const { id } = req.params;
      const topic = (await pool().query(`SELECT * FROM training_topics WHERE id = $1 AND is_active = true`, [id])).rows[0];
      if (!topic) return res.json({ success: false, error: '知识点不存在' });
      const kbIds = topic.kb_article_ids || [];
      if (!kbIds.length) return res.json({ success: false, error: '该知识点未关联任何知识库文章，无法生成图谱' });

      // 优先取已有 step_rubric 的KB文章（媒体文件优先），否则取第一个视频/图片文件
      // 注意：1对1设计原则——每个培训话题对应1个SOP文件，多关联时只取第一个可用媒体文件
      const kbResult = await pool().query(
        `SELECT id, title, file_path, step_rubric FROM knowledge_base
         WHERE id = ANY($1) AND (file_path IS NOT NULL OR step_rubric IS NOT NULL)
         ORDER BY step_rubric IS NOT NULL DESC, file_path IS NOT NULL DESC
         LIMIT 1`,
        [kbIds]
      );
      if (kbResult.rows.length === 0) return res.json({ success: false, error: '关联的KB文章不存在或无媒体文件' });
      const kbArticle = kbResult.rows[0];
      const usedKbCount = kbIds.length;
      const warningMsg = usedKbCount > 1
        ? `注意：该话题关联了${usedKbCount}篇KB文章，图谱仅基于「${kbArticle.title}」生成。建议每个话题只关联1篇SOP文件。`
        : null;

      let rubric;
      if (kbArticle.step_rubric) {
        rubric = kbArticle.step_rubric;
      } else {
        // 检查是否有现成的厨房 SOP 步骤数据（根据菜品名称匹配）
        const dishMatch = await pool().query(
          `SELECT DISTINCT dish_name, station FROM kitchen_sop_steps WHERE dish_name ILIKE $1 OR $2 ILIKE '%' || dish_name || '%' LIMIT 1`,
          [`%${topic.title}%`, topic.title]
        );
        if (dishMatch.rows.length > 0) {
          const { dish_name: matchedDish, station: matchedStation } = dishMatch.rows[0];
          const steps = await pool().query(
            `SELECT step_seq, action, time_limit_seconds, quality_standard, common_failure, failure_action, is_critical
             FROM kitchen_sop_steps WHERE dish_name = $1 ORDER BY step_seq`,
            [matchedDish]
          );
          // Convert to rubric format: 第一项菜品核验 + 每步默认权重
          const totalSteps = steps.rows.length;
          const baseWeight = totalSteps > 0 ? Math.floor(90 / totalSteps) : 0;
          const remainder = 90 - baseWeight * totalSteps;
          rubric = {
            dish_name: matchedDish,
            station: matchedStation,
            type: 'steps',
            items: [
              {
                step_seq: 0,
                action: `菜品核验：${matchedDish}`,
                weight: 10,
                quality_standard: `确认提交内容为「${matchedDish}」`,
                common_failure: null,
                failure_action: null,
                is_critical: true,
                time_limit_seconds: null,
                checks: [`外观符合${matchedDish}特征`, '主料颜色正确', '摆盘/器具符合标准']
              },
              ...steps.rows.map((s, i) => ({
                step_seq: s.step_seq,
                action: s.action,
                weight: baseWeight + (i < remainder ? 1 : 0),
                quality_standard: s.quality_standard || null,
                common_failure: s.common_failure || null,
                failure_action: s.failure_action || null,
                is_critical: s.is_critical || false,
                time_limit_seconds: s.time_limit_seconds || null,
                checks: (s.quality_standard ? [s.quality_standard] : []).concat(s.common_failure ? [`避免：${s.common_failure}`] : [])
              }))
            ],
            fail_criteria: ['提交的实操内容与考核菜品明显不符', '操作区域严重污秽', '明显操作安全隐患'],
            pass_threshold: 80,
            source: 'kitchen_sop_steps'
          };
        } else {
          // Check file type — only images/videos can be analyzed
          const fileField = kbArticle.file_path || '';
          const isMedia = /\.(mp4|mov|webm|avi|jpg|jpeg|png|gif|webp)$/i.test(fileField);
          if (!isMedia) {
            return res.json({ success: false, error: `关联的知识库文章（${kbArticle.title}）是${kbArticle.file_type || 'PDF'}格式，图谱分析需要视频或图片文件。请先上传包含操作视频/图片的知识库文章，或手动配置图谱。` });
          }
          // Trigger KB analysis
          try {
            const analyzeRes = await axios.post(
              `http://localhost:3000/api/knowledge/${kbArticle.id}/analyze-rubric`,
              {},
              { headers: { 'Authorization': req.headers['authorization'] || '' } }
            );
            if (!analyzeRes.data?.success) {
              return res.json({ success: false, error: '步骤图谱生成失败: ' + (analyzeRes.data?.error || '') });
            }
            rubric = analyzeRes.data.rubric;
          } catch (innerE) {
            return res.json({ success: false, error: '分析请求失败: ' + innerE?.message });
          }
        }
      }

      await pool().query(`UPDATE training_topics SET step_rubric = $1 WHERE id = $2`, [JSON.stringify(rubric), id]);
      res.json({ success: true, rubric, source_kb: { id: kbArticle.id, title: kbArticle.title }, warning: warningMsg });
    } catch (e) {
      console.error('[Training] generate-rubric error:', e?.message);
      res.json({ success: false, error: e?.message });
    }
  });

  // GET /api/training/topics/:id/rubric — 获取话题图谱
  app.get('/api/training/topics/:id/rubric', authMiddleware, async (req, res) => {
    try {
      const topic = (await pool().query(`SELECT step_rubric FROM training_topics WHERE id = $1`, [req.params.id])).rows[0];
      if (!topic) return res.json({ success: false, error: '知识点不存在' });
      res.json({ success: true, rubric: topic.step_rubric || null });
    } catch (e) {
      res.json({ success: false, error: e?.message });
    }
  });

  // ═══════════════════════════════════════════════════════════
  // 实操评分明细
  // ═══════════════════════════════════════════════════════════

  // GET /api/training/certifications/:id/score-detail — 查看评分明细（员工端/管理端通用）
  app.get('/api/training/certifications/:id/score-detail', authMiddleware, async (req, res) => {
    try {
      const { id } = req.params;
      const username = req.user?.username;
      const isMgr = isManager(req.user?.role);
      const certResult = await pool().query(`
        SELECT c.*, t.title, t.position
        FROM training_certifications c JOIN training_topics t ON t.id = c.topic_id
        WHERE c.id = $1`, [id]);
      if (certResult.rows.length === 0) return res.json({ success: false, error: '认证记录不存在' });
      const cert = certResult.rows[0];
      if (!isMgr && cert.employee_username !== username) return res.status(403).json({ error: '无权查看' });
      res.json({
        success: true,
        certification: cert,
        ai_step_scores: cert.ai_step_scores || null,
        ai_total_score: cert.ai_total_score || null,
        review_status: cert.review_status || 'pending',
        manager_score: cert.manager_score || null,
        final_score: cert.final_score || null,
        manager_note: cert.manager_note || ''
      });
    } catch (e) {
      res.json({ success: false, error: e?.message });
    }
  });

  // GET /api/training/kb-search?q=关键词 - 搜索知识库文章（供知识点关联使用）
  app.get('/api/training/kb-search', authMiddleware, async (req, res) => {
    try {
      if (!isManager(req.user?.role)) {
        return res.status(403).json({ error: '无权限' });
      }
      const q = (req.query.q || '').trim();
      const idsParam = (req.query.ids || '').trim();
      let sql, params;
      if (idsParam) {
        const ids = idsParam.split(',').map(s => s.trim()).filter(Boolean).slice(0, 50);
        const placeholders = ids.map((_, i) => '$' + (i + 1)).join(',');
        sql = `SELECT id, title, category, LEFT(content, 200) AS excerpt FROM knowledge_base WHERE enabled = true AND id::text IN (${placeholders}) ORDER BY title`;
        params = ids;
      } else if (q) {
        sql = `SELECT id, title, category, LEFT(content, 200) AS excerpt FROM knowledge_base WHERE enabled = true AND (title ILIKE $1 OR content ILIKE $1) ORDER BY title LIMIT 20`;
        params = ['%' + q + '%'];
      } else {
        sql = `SELECT id, title, category, LEFT(content, 200) AS excerpt FROM knowledge_base WHERE enabled = true ORDER BY updated_at DESC LIMIT 20`;
        params = [];
      }
      const result = await pool().query(sql, params);
      res.json({ success: true, articles: result.rows });
    } catch (e) {
      res.json({ success: false, error: e?.message });
    }
  });

  // GET /api/training/stores - 获取可指派的门店列表
  app.get('/api/training/stores', authMiddleware, async (req, res) => {
    try {
      if (!isManager(req.user?.role)) return res.status(403).json({ error: '无权限' });
      const userRole = req.user?.role;
      // store_manager/production_mgr 只看自己的门店
      if (['store_manager', 'store_production_manager'].includes(userRole)) {
        const userStore = await getUserStore(req.user?.username);
        if (userStore) return res.json({ success: true, stores: [userStore] });
      }
      const result = await pool().query(`SELECT DISTINCT store FROM employees WHERE store != '' AND status != 'inactive' ORDER BY store`);
      res.json({ success: true, stores: result.rows.map(r => r.store) });
    } catch (e) {
      res.json({ success: false, error: e?.message });
    }
  });

  // GET /api/training/search-employees?q=&store=&position= - 搜索可指派的员工（支持门店+岗位过滤）
  app.get('/api/training/search-employees', authMiddleware, async (req, res) => {
    try {
      if (!isManager(req.user?.role)) {
        return res.status(403).json({ error: '无权限' });
      }
      const q = (req.query.q || '').trim();
      const filterStore = (req.query.store || '').trim();
      const filterPosition = (req.query.position || '').trim();
      const assignableRoles = getAssignableRoles(req.user?.role);
      const userRole = req.user?.role;

      const clauses = [`status != 'inactive'`];
      const params = [];

      // 角色过滤
      if (assignableRoles !== null) {
        params.push(assignableRoles);
        clauses.push(`role = ANY($${params.length})`);
      }

      // 门店过滤：store_manager/production_mgr 强制自己的门店
      if (['store_manager', 'store_production_manager'].includes(userRole)) {
        const userStore = await getUserStore(req.user?.username);
        if (userStore) {
          params.push(userStore);
          clauses.push(`store = $${params.length}`);
        }
      } else if (filterStore) {
        params.push(filterStore);
        clauses.push(`store = $${params.length}`);
      }

      // 岗位过滤（employees.position 字段）
      if (filterPosition) {
        params.push('%' + filterPosition + '%');
        clauses.push(`position ILIKE $${params.length}`);
      }

      // 姓名搜索
      if (q) {
        params.push('%' + q + '%');
        clauses.push(`(name ILIKE $${params.length} OR username ILIKE $${params.length})`);
      }

      const sql = `SELECT username, name, role, position, store FROM employees WHERE ${clauses.join(' AND ')} ORDER BY store, name LIMIT 50`;
      const result = await pool().query(sql, params);
      res.json({ success: true, employees: result.rows });
    } catch (e) {
      res.json({ success: false, error: e?.message });
    }
  });

  // GET /api/training/assignments - 列出指派
  app.get('/api/training/assignments', authMiddleware, async (req, res) => {
    try {
      const role = req.user?.role;
      const username = req.user?.username;
      const _canAssign = ['admin', 'hq_manager', 'store_manager', 'store_production_manager'];
      if (!_canAssign.includes(role)) {
        return res.status(403).json({ error: '无权限访问' });
      }
      const name = (req.query.name || '').trim();
      const params = [];
      let sql = `
        SELECT a.*, t.title, t.position,
               s.status AS session_status, s.quiz_passed, s.quiz_score,
               CASE
                 WHEN a.due_date IS NOT NULL
                  AND a.due_date < ((NOW() AT TIME ZONE 'Asia/Shanghai')::date)
                  AND COALESCE(s.status, 'not_started') != 'certified'
                 THEN true ELSE false
               END AS is_overdue,
               CASE
                 WHEN a.due_date IS NOT NULL
                  AND a.due_date = ((NOW() AT TIME ZONE 'Asia/Shanghai')::date)
                  AND COALESCE(s.status, 'not_started') != 'certified'
                 THEN true ELSE false
               END AS is_due_today,
               CASE
                 WHEN a.due_date IS NOT NULL
                  AND a.due_date < ((NOW() AT TIME ZONE 'Asia/Shanghai')::date)
                  AND COALESCE(s.status, 'not_started') != 'certified'
                 THEN (((NOW() AT TIME ZONE 'Asia/Shanghai')::date) - a.due_date)
                 ELSE 0
               END AS days_overdue,
               e.name AS employee_name
        FROM training_assignments a
        JOIN training_topics t ON t.id = a.topic_id
        LEFT JOIN training_sessions s ON s.topic_id = a.topic_id AND s.employee_username = a.employee_username
        LEFT JOIN employees e ON e.username = a.employee_username
        WHERE 1=1
      `;
      // 非管理员/总部营运只能看自己指派的任务
      if (!['admin', 'hq_manager'].includes(role)) {
        params.push(username);
        sql += ` AND a.assigned_by = $${params.length}`;
      }
      if (name) {
        params.push('%' + name + '%');
        sql += ` AND (e.name ILIKE $${params.length} OR a.employee_username ILIKE $${params.length})`;
      }
      sql += ` ORDER BY a.created_at DESC`;
      const result = await pool().query(sql, params);
      res.json({ success: true, assignments: result.rows });
    } catch (e) {
      res.json({ success: false, error: e?.message });
    }
  });

  // POST /api/training/assignments - 批量指派知识点给员工（支持多员工）
  app.post('/api/training/assignments', authMiddleware, async (req, res) => {
    try {
      const _canAssign = ['admin', 'hq_manager', 'store_manager', 'store_production_manager'];
      if (!_canAssign.includes(req.user?.role)) {
        return res.status(403).json({ error: '仅店长及以上角色可指派培训任务' });
      }
      // 支持旧格式 employee_username（字符串）和新格式 employee_usernames（数组）
      const { employee_username, employee_usernames, topic_id, due_date, note } = req.body;
      const usernames = Array.isArray(employee_usernames) && employee_usernames.length
        ? employee_usernames
        : (employee_username ? [employee_username] : []);
      if (!usernames.length || !topic_id) {
        return res.json({ success: false, error: '员工和知识点必填' });
      }

      // 获取知识点标题（用于通知）
      const topicRes = await pool().query(`SELECT title FROM training_topics WHERE id = $1`, [topic_id]);
      const topicTitle = topicRes.rows[0]?.title || '培训任务';

      const assignableRoles = getAssignableRoles(req.user?.role);
      const assignerName = req.user?.name || req.user?.username;
      const requirePractice = req.body.require_practice === true || req.body.require_practice === 'true';
      const created = [];

      for (const username of usernames) {
        if (!username.trim()) continue;
        // 角色层级验证
        if (assignableRoles !== null) {
          const empCheck = await pool().query(`SELECT role, name FROM employees WHERE username = $1`, [username]);
          if (empCheck.rows.length === 0) continue;
          if (!assignableRoles.includes(empCheck.rows[0].role)) continue;
        }
        const r = await pool().query(
          `INSERT INTO training_assignments (employee_username, topic_id, assigned_by, due_date, note, require_practice)
           VALUES ($1, $2, $3, $4, $5, $6)
           RETURNING *`,
          [username, topic_id, req.user?.username, due_date || null, note || '', requirePractice]
        );
        if (r.rows.length) created.push(r.rows[0]);

        // ── HRMS 站内通知 ──
        try {
          await pool().query(
            `INSERT INTO hrms_user_notifications (target_username, title, message, type, meta, created_at)
             VALUES ($1, $2, $3, $4, $5, NOW())`,
            [
              username,
              '你有新的培训任务',
              `${assignerName} 为你指派了培训任务「${topicTitle}」${due_date ? '，截止日期：' + due_date : ''}，请尽快完成。`,
              'training_assignment',
              JSON.stringify({ topic_id, topic_title: topicTitle, assigned_by: req.user?.username })
            ]
          );
        } catch (_) {}

        // ── 飞书消息通知 ──
        try {
          const fu = await lookupFeishuUserByUsername(username);
          if (fu?.open_id) {
            const feishuMsg = `📚 培训任务通知\n\n${assignerName} 为您指派了培训任务：\n【${topicTitle}】\n${due_date ? '截止日期：' + due_date + '\n' : ''}${note ? '备注：' + note + '\n' : ''}\n请登录 HRMS 系统完成培训。`;
            await sendLarkMessage(fu.open_id, feishuMsg, { skipDedup: true });
          }
        } catch (_) {}
      }

      res.json({ success: true, count: created.length, assignments: created });
    } catch (e) {
      res.json({ success: false, error: e?.message });
    }
  });

  // DELETE /api/training/assignments/:id - 撤销指派（仅自己指派的，或管理员/总部营运）
  app.delete('/api/training/assignments/:id', authMiddleware, async (req, res) => {
    try {
      const role = req.user?.role;
      const username = req.user?.username;
      const _canAssign = ['admin', 'hq_manager', 'store_manager', 'store_production_manager'];
      if (!_canAssign.includes(role)) {
        return res.status(403).json({ error: '无权限操作' });
      }
      // 非管理员/总部营运只能撤销自己指派的
      if (!['admin', 'hq_manager'].includes(role)) {
        const check = await pool().query(`SELECT assigned_by FROM training_assignments WHERE id = $1`, [req.params.id]);
        if (check.rows.length === 0) return res.json({ success: false, error: '记录不存在' });
        if (check.rows[0].assigned_by !== username) {
          return res.status(403).json({ error: '只能撤销自己指派的任务' });
        }
      }
      await pool().query(`DELETE FROM training_assignments WHERE id = $1`, [req.params.id]);
      res.json({ success: true });
    } catch (e) {
      res.json({ success: false, error: e?.message });
    }
  });

  // GET /api/training/dashboard - 团队通过率看板（含每人明细）
  app.get('/api/training/dashboard', authMiddleware, async (req, res) => {
    try {
      const role = req.user?.role;
      const username = req.user?.username;
      if (!isManager(role)) {
        return res.status(403).json({ error: '无权限访问' });
      }

      // admin / hq_manager 看所有人派发的任务；其他管理者只看自己派发的
      const isHQ = ['admin', 'hr_manager', 'hq_manager'].includes(role);
      const assignedByFilter = isHQ ? '' : `AND a.assigned_by = '${username.replace(/'/g, "''")}'`;

      // 是否在结果中显示派发人（HQ 看全量需要知道是谁派的）
      const assignerField = isHQ
        ? `, a.assigned_by AS assigned_by, COALESCE(ae.name, a.assigned_by) AS assigner_name`
        : '';
      const assignerJoin = isHQ
        ? `LEFT JOIN employees ae ON ae.username = a.assigned_by`
        : '';
      const groupExtra = isHQ ? `, a.assigned_by, ae.name` : '';

      const result = await pool().query(`
        SELECT t.id, t.title, t.position
               ${assignerField},
               COUNT(DISTINCT a.employee_username) AS assigned_count,
               COUNT(DISTINCT CASE WHEN s.status = 'certified' THEN s.employee_username END) AS certified_count,
               COUNT(DISTINCT CASE
                 WHEN a.due_date IS NOT NULL
                  AND a.due_date < ((NOW() AT TIME ZONE 'Asia/Shanghai')::date)
                  AND COALESCE(s.status, 'not_started') != 'certified'
                 THEN a.employee_username
               END) AS overdue_count,
               COALESCE(
                 json_agg(
                   json_build_object(
                     'username', a.employee_username,
                     'name', COALESCE(e.name, a.employee_username),
                     'status', COALESCE(s.status, 'not_started'),
                     'quiz_score', s.quiz_score,
                     'quiz_history', COALESCE(s.quiz_history, '[]'::jsonb),
                     'due_date', a.due_date,
                     'is_overdue', CASE
                       WHEN a.due_date IS NOT NULL
                        AND a.due_date < ((NOW() AT TIME ZONE 'Asia/Shanghai')::date)
                        AND COALESCE(s.status, 'not_started') != 'certified'
                       THEN true ELSE false
                     END,
                     'is_due_today', CASE
                       WHEN a.due_date IS NOT NULL
                        AND a.due_date = ((NOW() AT TIME ZONE 'Asia/Shanghai')::date)
                        AND COALESCE(s.status, 'not_started') != 'certified'
                       THEN true ELSE false
                     END,
                     'days_overdue', CASE
                       WHEN a.due_date IS NOT NULL
                        AND a.due_date < ((NOW() AT TIME ZONE 'Asia/Shanghai')::date)
                        AND COALESCE(s.status, 'not_started') != 'certified'
                       THEN (((NOW() AT TIME ZONE 'Asia/Shanghai')::date) - a.due_date)
                       ELSE 0
                     END
                   ) ORDER BY e.name
                 ) FILTER (WHERE a.employee_username IS NOT NULL),
                 '[]'::json
               ) AS members
        FROM training_topics t
        LEFT JOIN training_assignments a ON a.topic_id = t.id ${assignedByFilter}
        LEFT JOIN training_sessions s ON s.topic_id = t.id AND s.employee_username = a.employee_username
        LEFT JOIN employees e ON e.username = a.employee_username
        ${assignerJoin}
        WHERE t.is_active = true
        GROUP BY t.id, t.title, t.position ${groupExtra}
        ORDER BY t.sort_order, t.id
      `);
      res.json({ success: true, dashboard: result.rows });
    } catch (e) {
      res.json({ success: false, error: e?.message });
    }
  });

  // GET /api/training/certifications/pending - 待审核列表（谁派发谁审核）
  app.get('/api/training/certifications/pending', authMiddleware, async (req, res) => {
    try {
      if (!isManager(req.user?.role)) {
        return res.status(403).json({ error: '无权限访问' });
      }
      const username = String(req.user?.username || '').trim();
      const role = String(req.user?.role || '').trim();
      const isAdminOrHQ = role === 'admin' || role === 'hq_manager';
      // 谁派发谁审核：非管理员/总部只能看到自己派发的任务的认证
      const assignerClause = isAdminOrHQ
        ? ''
        : `AND EXISTS (
             SELECT 1 FROM training_assignments a2
             WHERE a2.employee_username = c.employee_username
               AND a2.topic_id = c.topic_id
               AND lower(a2.assigned_by) = lower('${username.replace(/'/g, "''")}')
           )`;
      const result = await pool().query(`
        SELECT c.*, t.title, t.position, s.employee_username,
               e.name AS employee_name
        FROM training_certifications c
        JOIN training_sessions s ON s.id = c.session_id
        JOIN training_topics t ON t.id = c.topic_id
        LEFT JOIN employees e ON e.username = c.employee_username
        WHERE c.manager_verdict IS NULL
        ${assignerClause}
        ORDER BY c.created_at DESC
      `);
      res.json({ success: true, pending: result.rows });
    } catch (e) {
      res.json({ success: false, error: e?.message });
    }
  });

  // POST /api/training/certifications/:id/review - 人工复核（谁派发谁审核）
  app.post('/api/training/certifications/:id/review', authMiddleware, async (req, res) => {
    try {
      if (!isManager(req.user?.role)) {
        return res.status(403).json({ error: '无权限访问' });
      }
      const { id } = req.params;
      const { action, verdict, note, steps } = req.body;
      const reviewer = req.user?.username;
      const role = String(req.user?.role || '').trim();
      const isAdminOrHQ = role === 'admin' || role === 'hq_manager';

      // 获取认证记录
      const existing = (await pool().query(`SELECT * FROM training_certifications WHERE id = $1`, [id])).rows[0];
      if (!existing) return res.json({ success: false, error: '认证记录不存在' });

      // 谁派发谁审核：非管理员/总部校验是否为派发人
      if (!isAdminOrHQ) {
        const assignCheck = await pool().query(
          `SELECT 1 FROM training_assignments WHERE employee_username = $1 AND topic_id = $2 AND lower(assigned_by) = lower($3) LIMIT 1`,
          [existing.employee_username, existing.topic_id, reviewer]
        );
        if (!assignCheck.rows.length) {
          return res.status(403).json({ error: '只有派发人才能审核此认证' });
        }
      }

      let finalScore = null;
      let managerScore = null;
      let reviewStatus = 'pending';
      let passed = false;
      let managerNote = note || '';
      let stepScores = existing.ai_step_scores;

      if (action === 'confirm') {
        // 确认AI评分
        reviewStatus = 'confirmed';
        finalScore = existing.ai_total_score || 0;
        passed = (existing.ai_verdict === 'passed' || finalScore >= 80);
      } else if (action === 'override' && Array.isArray(steps)) {
        // 人工覆盖评分
        reviewStatus = 'overridden';
        managerScore = steps.reduce((sum, s) => sum + (Number(s.score) || 0), 0);
        finalScore = managerScore;
        stepScores = steps;
        passed = managerScore >= 80; // rubric pass_threshold always 80
      } else if (verdict && ['passed', 'failed'].includes(verdict)) {
        // 兼容旧版调用（直接传passed/failed）
        reviewStatus = 'confirmed';
        passed = verdict === 'passed';
        finalScore = existing.ai_total_score || (passed ? 100 : 0);
      } else {
        return res.json({ success: false, error: '请提供 action (confirm/override) 或 verdict (passed/failed)' });
      }

      await pool().query(
        `UPDATE training_certifications
         SET manager_verdict = $1, manager_note = $2, manager_reviewed_by = $3,
             review_status = $4, manager_score = $5, final_score = $6,
             ai_step_scores = CASE WHEN $7::jsonb IS NOT NULL THEN $7::jsonb ELSE ai_step_scores END,
             certified_at = CASE WHEN $8 THEN NOW() ELSE NULL END
         WHERE id = $9`,
        [passed ? 'passed' : 'failed', managerNote, reviewer,
         reviewStatus, managerScore, finalScore, JSON.stringify(stepScores), passed, id]
      );

      if (passed) {
        await pool().query(`UPDATE training_sessions SET status = 'certified' WHERE id = $1`, [existing.session_id]);
      }

      const updated = (await pool().query(`SELECT * FROM training_certifications WHERE id = $1`, [id])).rows[0];
      res.json({ success: true, certification: updated, final_score: finalScore });
    } catch (e) {
      res.json({ success: false, error: e?.message });
    }
  });

  // ═══════════════════════════════════════════════════════════
  // 员工端路由
  // ═══════════════════════════════════════════════════════════

  // GET /api/training/my-topics - 我的培训任务
  app.get('/api/training/my-topics', authMiddleware, async (req, res) => {
    try {
      const username = req.user?.username;
      if (!username) {
        return res.status(401).json({ error: '未登录' });
      }

      const result = await pool().query(`
        SELECT a.id AS assignment_id, a.due_date, a.note, a.require_practice, a.assigned_by,
               t.id AS topic_id, t.title, t.position, t.description, t.key_points,
               s.id AS session_id, s.status AS session_status, s.quiz_passed, s.quiz_score,
               CASE
                 WHEN a.due_date IS NOT NULL
                  AND a.due_date < ((NOW() AT TIME ZONE 'Asia/Shanghai')::date)
                  AND COALESCE(s.status, 'not_started') != 'certified'
                 THEN true ELSE false
               END AS is_overdue,
               CASE
                 WHEN a.due_date IS NOT NULL
                  AND a.due_date = ((NOW() AT TIME ZONE 'Asia/Shanghai')::date)
                  AND COALESCE(s.status, 'not_started') != 'certified'
                 THEN true ELSE false
               END AS is_due_today,
               CASE
                 WHEN a.due_date IS NOT NULL
                  AND a.due_date < ((NOW() AT TIME ZONE 'Asia/Shanghai')::date)
                  AND COALESCE(s.status, 'not_started') != 'certified'
                 THEN (((NOW() AT TIME ZONE 'Asia/Shanghai')::date) - a.due_date)
                 ELSE 0
               END AS days_overdue
        FROM training_assignments a
        JOIN training_topics t ON t.id = a.topic_id
        LEFT JOIN training_sessions s ON s.topic_id = a.topic_id AND s.employee_username = a.employee_username
        WHERE a.employee_username = $1 AND t.is_active = true
        ORDER BY a.created_at DESC
      `, [username]);

      res.json({ success: true, topics: result.rows });
    } catch (e) {
      res.json({ success: false, error: e?.message });
    }
  });

  // GET /api/training/topics/:id/session - 获取或创建 session（含 KB 文章内容）
  app.get('/api/training/topics/:id/session', authMiddleware, async (req, res) => {
    try {
      const username = req.user?.username;
      const topicId = req.params.id;

      const topicResult = await pool().query(`SELECT * FROM training_topics WHERE id = $1 AND is_active = true`, [topicId]);
      if (topicResult.rows.length === 0) {
        return res.json({ success: false, error: '知识点不存在' });
      }
      const topic = topicResult.rows[0];

      // 拉取关联知识库文章全文供员工阅读
      let kbArticles = [];
      if (Array.isArray(topic.kb_article_ids) && topic.kb_article_ids.length > 0) {
        const kbResult = await pool().query(
          `SELECT id, title, content, file_path, file_type FROM knowledge_base WHERE id = ANY($1) AND enabled = true ORDER BY title`,
          [topic.kb_article_ids]
        );
        kbArticles = kbResult.rows;
      }

      let sessionResult = await pool().query(
        `SELECT * FROM training_sessions WHERE employee_username = $1 AND topic_id = $2`,
        [username, topicId]
      );
      if (sessionResult.rows.length === 0) {
        sessionResult = await pool().query(
          `INSERT INTO training_sessions (employee_username, topic_id) VALUES ($1, $2) RETURNING *`,
          [username, topicId]
        );
      }

      res.json({ success: true, topic, session: sessionResult.rows[0], kb_articles: kbArticles });
    } catch (e) {
      res.json({ success: false, error: e?.message });
    }
  });

  // GET /api/training/kb-file/:articleId - 直接提供培训文章文件（绕过知识库受众权限检查）
  app.get('/api/training/kb-file/:articleId', authMiddleware, async (req, res) => {
    const articleId = String(req.params.articleId || '').trim();
    if (!articleId) return res.status(400).json({ error: 'missing_id' });
    try {
      const check = await pool().query(
        `SELECT id FROM training_topics WHERE $1 = ANY(kb_article_ids) AND is_active = true LIMIT 1`,
        [articleId]
      );
      if (check.rows.length === 0) return res.status(403).json({ error: 'forbidden' });

      const r = await pool().query(
        `SELECT file_path, file_type FROM knowledge_base WHERE id = $1 AND enabled = true LIMIT 1`,
        [articleId]
      );
      const row = r.rows[0];
      if (!row?.file_path) return res.status(404).json({ error: 'not_found' });

      const kbUploadsDir = path.resolve(path.join(__dirname, '..', 'uploads'));
      const raw = String(row.file_path || '').trim();
      const rel = raw.replace(/^\/uploads\//, '').replace(/^uploads\//, '');
      const normalized = path.posix.normalize(rel).replace(/^\/+/, '');
      if (!normalized || normalized.includes('..')) return res.status(400).json({ error: 'invalid_path' });
      const abs = path.join(kbUploadsDir, normalized);
      if (!fs.existsSync(abs)) return res.status(404).json({ error: 'file_not_found' });

      const ft = String(row.file_type || '').toLowerCase();
      const ctMap = { pdf: 'application/pdf', video: 'video/mp4', img: 'image/jpeg', image: 'image/jpeg' };
      if (ctMap[ft]) res.setHeader('Content-Type', ctMap[ft]);
      res.setHeader('Content-Disposition', 'inline');
      return res.sendFile(abs);
    } catch (e) {
      console.error('[Training] kb-file error:', e?.message);
      res.status(500).json({ error: e?.message });
    }
  });

  // GET /api/training/kb/:articleId/explanation - AI智能解析（首次生成后缓存，全员共用）
  app.get('/api/training/kb/:articleId/explanation', authMiddleware, async (req, res) => {
    const articleId = String(req.params.articleId || '').trim();
    if (!articleId) return res.status(400).json({ error: 'missing_id' });
    try {
      const check = await pool().query(
        `SELECT id FROM training_topics WHERE $1 = ANY(kb_article_ids) AND is_active = true LIMIT 1`,
        [articleId]
      );
      if (check.rows.length === 0) return res.status(403).json({ error: 'forbidden' });

      const r = await pool().query(
        `SELECT title, content, file_type, ai_explanation FROM knowledge_base WHERE id = $1 AND enabled = true LIMIT 1`,
        [articleId]
      );
      const row = r.rows[0];
      if (!row) return res.status(404).json({ error: 'not_found' });

      // 已有缓存直接返回
      if (row.ai_explanation && row.ai_explanation.trim().length > 50) {
        return res.json({ success: true, explanation: row.ai_explanation, cached: true });
      }

      const rawContent = String(row.content || '').trim();
      if (!rawContent || rawContent.length < 20) {
        return res.json({ success: false, error: 'no_content', message: '此文章暂无文字内容，无法生成AI解析' });
      }

      const isSopContent = /SOP|标准操作|工序|步骤\s*\d|操作动作|质量标准|常见失败|补救/.test(rawContent);
      const fileType = (row.file_type || '').toLowerCase();
      const isMediaFile = /video|image|mp4|mov|jpg|jpeg|png|gif/.test(fileType);

      let prompt;
      if (isSopContent || isMediaFile) {
        prompt = `你是一名餐饮培训标准制定专家，请根据以下原始内容，输出严格对齐厨房SOP格式的标准培训解析。

【原始SOP内容】
${rawContent}

请严格按以下结构输出（保留 ## 标题符号），每步必须包含：操作动作、质量标准、常见失败、补救措施、是否为关键步骤：

## 🍳 工序：${row.title}

## 📋 SOP步骤分解
按原始内容的步骤顺序，每一步用以下格式输出：

### 步骤N：操作动作名称

> **关键步骤**：是/否

- **操作动作**：具体做什么，一线员工能直接照着做的动作描述
- **质量标准**：做到什么程度算合格（可视化可判定）
- **⏱ 建议时长**：N分钟

> **常见失败**：可能会出什么问题

> **补救措施**：出了问题怎么办

### 步骤N+1：...

---

## ⚠️ 一票否决项
列出3-5条绝对不能出现的情况（出现任一即不合格）：

## ✅ 关键记忆
用"到岗→操作→复核"格式的口诀，帮助员工快速记住核心流程。

输出语言：简体中文。不要添加任何开场白或结尾语，直接从"## 🍳 工序"开始输出。`;
      } else {
        prompt = `你是一名经验丰富的餐饮培训导师，正在为餐厅一线员工制作培训材料。

【培训文章标题】${row.title}

【原始内容】
${rawContent}

请根据以上内容，生成一份**结构清晰、语言通俗、实用性强**的培训解析。要求：
- 用一线员工能听懂的大白话，避免生硬术语
- 每个要点配合餐饮工作实际场景说明
- 重要步骤用数字编号，方便记忆

请严格按以下结构输出（保留 ## 标题符号）：

## 📌 一句话总结
用一两句话说清楚这篇培训的核心是什么，让员工知道学完能干什么。

## 🎯 必须掌握的要点
列出3-6条最关键的知识点或操作步骤，每条单独一行，用"- "开头，简短有力。

## 📖 详细讲解
把每个要点展开说明，结合实际工作场景举例，让员工能"对号入座"。遇到操作流程要按1、2、3步骤列出。

## ⚠️ 常见错误 & 注意事项
列出2-4条实际工作中容易犯的错误或被忽视的细节，用"- "开头。帮助员工提前避坑。

## ✅ 记住这几点就够了
用3-5条极简口诀或行动清单，帮助员工快速记住最核心的内容，类似"到岗先检查→操作按流程→完成后复核"这种格式。

输出语言：简体中文。不要添加任何开场白或结尾语，直接从"## 📌 一句话总结"开始输出。`;
      }

      const aiResp = await callLLM([
        { role: 'system', content: '你是专业的餐饮培训导师，擅长把复杂的操作规程转化成一线员工能快速理解和记忆的培训内容。输出时严格遵守给定的结构，不添加多余内容。' },
        { role: 'user', content: prompt }
      ], { max_tokens: 3500, temperature: 0.45 });

      const explanation = String(aiResp?.content || '').trim();
      if (!explanation || explanation.length < 100) {
        return res.json({ success: false, error: 'ai_failed', message: 'AI生成失败，请稍后重试' });
      }

      // 缓存到数据库，后续所有员工直接读缓存无需重新生成
      await pool().query(
        `UPDATE knowledge_base SET ai_explanation = $1, updated_at = NOW() WHERE id = $2`,
        [explanation, articleId]
      );

      res.json({ success: true, explanation, cached: false });
    } catch (e) {
      console.error('[Training] explanation error:', e?.message);
      res.status(500).json({ error: e?.message });
    }
  });

  // GET /api/training/my-certifications - 我的认证记录
  app.get('/api/training/my-certifications', authMiddleware, async (req, res) => {
    try {
      const username = req.user?.username;
      if (!username) return res.status(401).json({ error: '未登录' });
      const result = await pool().query(`
        SELECT c.id, c.session_id, c.topic_id, c.media_url, c.media_type,
               c.ai_verdict, c.ai_feedback, c.ai_total_score, c.ai_step_scores,
               c.manager_verdict, c.manager_note, c.final_score, c.manager_score,
               c.review_status, c.certified_at, c.created_at,
               t.title, t.position,
               s.quiz_score, s.status AS session_status
        FROM training_certifications c
        JOIN training_topics t ON t.id = c.topic_id
        JOIN training_sessions s ON s.id = c.session_id
        WHERE c.employee_username = $1
        ORDER BY c.created_at DESC
      `, [username]);
      res.json({ success: true, certifications: result.rows });
    } catch (e) {
      res.json({ success: false, error: e?.message });
    }
  });

  // POST /api/training/sessions/:id/chat - AI 对话
  app.post('/api/training/sessions/:id/chat', authMiddleware, async (req, res) => {
    try {
      const { id } = req.params;
      const { message } = req.body;
      const username = req.user?.username;

      if (!message?.trim()) {
        return res.json({ success: false, error: '消息不能为空' });
      }

      // 获取 session 和 topic（含关联知识库文章ID）
      const sessionResult = await pool().query(`
        SELECT s.*, t.title, t.position, t.description, t.key_points, t.kb_article_ids
        FROM training_sessions s
        JOIN training_topics t ON t.id = s.topic_id
        WHERE s.id = $1 AND s.employee_username = $2
      `, [id, username]);

      if (sessionResult.rows.length === 0) {
        return res.json({ success: false, error: '会话不存在' });
      }

      const session = sessionResult.rows[0];
      const topic = {
        title: session.title,
        position: session.position,
        description: session.description,
        key_points: session.key_points,
        kb_article_ids: session.kb_article_ids || []
      };

      // 构建对话历史
      const chatHistory = session.chat_history || [];
      chatHistory.push({ role: 'user', content: message });

      // 拼接关联知识库文章内容
      let kbContext = '';
      if (topic.kb_article_ids.length > 0) {
        const kbResult = await pool().query(
          `SELECT title, LEFT(content, 6000) AS content FROM knowledge_base WHERE id = ANY($1) AND enabled = true`,
          [topic.kb_article_ids]
        );
        if (kbResult.rows.length > 0) {
          kbContext = '\n\n以下是相关参考资料，请结合这些内容回答：\n\n' +
            kbResult.rows.map(r => `【${r.title}】\n${r.content}`).join('\n\n---\n\n');
        }
      }

      // 构建 system prompt（key_points 为空时只靠知识库内容）
      const kpText = Array.isArray(topic.key_points) && topic.key_points.length > 0
        ? `\n核心要点：${topic.key_points.join('、')}` : '';
      const systemPrompt = `你是一名餐饮培训助手，正在帮助员工学习「${topic.title}」。
岗位：${topic.position}${kpText}${kbContext}
请用简体中文，结合实际工作场景解释，适当提问检验理解。每次回复控制在150字以内。`;

      const messages = [
        { role: 'system', content: systemPrompt },
        ...chatHistory.slice(-10).map(h => ({ role: h.role, content: h.content }))
      ];

      // 调用 AI
      const aiResponse = await callLLM(messages, { max_tokens: 500, temperature: 0.7 });
      const aiReply = aiResponse?.content || '抱歉，AI 服务暂时不可用。';

      // 保存对话历史
      chatHistory.push({ role: 'assistant', content: aiReply });
      await pool().query(
        `UPDATE training_sessions SET chat_history = $1 WHERE id = $2`,
        [JSON.stringify(chatHistory), id]
      );

      res.json({ success: true, reply: aiReply, chat_history: chatHistory });
    } catch (e) {
      console.error('[Training] Chat error:', e?.message);
      res.json({ success: false, error: e?.message });
    }
  });

  // POST /api/training/sessions/:id/start-quiz - 开始测验
  app.post('/api/training/sessions/:id/start-quiz', authMiddleware, async (req, res) => {
    try {
      const { id } = req.params;
      const username = req.user?.username;

      // 获取 session 和 topic（含关联知识库文章ID）
      const sessionResult = await pool().query(`
        SELECT s.*, t.title, t.position, t.description, t.key_points, t.kb_article_ids
        FROM training_sessions s
        JOIN training_topics t ON t.id = s.topic_id
        WHERE s.id = $1 AND s.employee_username = $2
      `, [id, username]);

      if (sessionResult.rows.length === 0) {
        return res.json({ success: false, error: '会话不存在' });
      }

      const session = sessionResult.rows[0];
      // Only block retake if already certified (passed and certified)
      if (session.status === 'certified') {
        return res.json({ success: false, error: '已完成认证，无需重复测试' });
      }

      const topic = {
        title: session.title,
        key_points: session.key_points,
        description: session.description,
        kb_article_ids: session.kb_article_ids || []
      };

      // Collect previous questions to avoid repetition (70%+ variety)
      let prevQuestionsSection = '';
      const prevQs = session.quiz_questions || [];
      if (prevQs.length > 0) {
        const prevTexts = prevQs.map((q, i) => `${i + 1}. ${q.q}`).join('\n');
        prevQuestionsSection = `\n\n【重要】以下是上次已出过的题目，本次必须避免重复，至少70%以上题目要全新不同：\n${prevTexts}`;
      }

      // 拼接关联知识库内容用于出题
      let kbQuizContext = '';
      if (topic.kb_article_ids.length > 0) {
        const kbResult = await pool().query(
          `SELECT title, LEFT(content, 6000) AS content FROM knowledge_base WHERE id = ANY($1) AND enabled = true`,
          [topic.kb_article_ids]
        );
        if (kbResult.rows.length > 0) {
          kbQuizContext = '\n参考资料：\n' +
            kbResult.rows.map(r => `【${r.title}】\n${r.content}`).join('\n---\n');
        }
      }

      // 生成测验题目（key_points 为空时纯靠知识库内容出题）
      const kpSection = Array.isArray(topic.key_points) && topic.key_points.length > 0
        ? `\n核心要点：${JSON.stringify(topic.key_points)}` : '';
      const randomSeed = Math.random().toString(36).slice(2, 8);
      // 用 username + seed 双重保证多人同时考试题目不同
      const quizPrompt = `根据以下培训内容，为员工[${username}]生成20道单选题，JSON格式返回（随机种子:${randomSeed}）：
{"questions":[{"q":"题目","options":["选项A","选项B","选项C","选项D"],"answer":2,"explanation":"解析"}]}
重要要求：
1. answer 为正确选项的 index（0-3），每道题的正确答案位置必须随机分布，不能总是0或固定位置。
2. 20道题中正确答案在选项0、1、2、3位置各约5道，随机打散。
3. 题目要贴近实际操作场景，测试真实理解，避免纯记忆题。
4. 从培训内容的不同角度、不同知识点出题，确保题目多样性。
培训主题：${topic.title}（岗位：${topic.position}）${kpSection}${kbQuizContext}${prevQuestionsSection}`;

      const aiResponse = await callLLM([
        { role: 'system', content: '你是一个专业的餐饮培训出题专家。请严格按照JSON格式返回题目，不要添加任何其他文字。确保每道题正确答案的位置（answer字段）在0-3之间均匀随机分布。' },
        { role: 'user', content: quizPrompt }
      ], { max_tokens: 4000, temperature: 0.7 });

      let quizText = aiResponse?.content || '';
      // 提取 JSON
      const jsonMatch = quizText.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        return res.json({ success: false, error: 'AI 生成题目失败，请重试' });
      }

      let questions;
      try {
        questions = JSON.parse(jsonMatch[0]);
      } catch (parseErr) {
        return res.json({ success: false, error: '题目格式错误，请重试' });
      }

      if (!questions.questions || !Array.isArray(questions.questions) || questions.questions.length < 5) {
        return res.json({ success: false, error: '题目数量不足，请重试' });
      }

      // 对每道题的选项进行随机洗牌，防止答案位置固定
      function shuffleQuizOptions(q) {
        const correctAnswer = q.options[q.answer];
        const shuffled = [...q.options].sort(() => Math.random() - 0.5);
        const newAnswerIdx = shuffled.indexOf(correctAnswer);
        return { ...q, options: shuffled, answer: newAnswerIdx };
      }
      questions.questions = questions.questions.map(shuffleQuizOptions);

      // 保存题目（不含答案）
      const questionsForClient = questions.questions.map(q => ({
        q: q.q,
        options: q.options
      }));

      await pool().query(
        `UPDATE training_sessions SET quiz_questions = $1, status = 'quiz' WHERE id = $2`,
        [JSON.stringify(questions.questions), id]
      );

      res.json({ success: true, questions: questionsForClient });
    } catch (e) {
      console.error('[Training] Start quiz error:', e?.message);
      res.json({ success: false, error: e?.message });
    }
  });

  // POST /api/training/sessions/:id/submit-quiz - 提交测验答案
  app.post('/api/training/sessions/:id/submit-quiz', authMiddleware, async (req, res) => {
    try {
      const { id } = req.params;
      const { answers } = req.body; // [0, 2, 1] 格式
      const username = req.user?.username;

      if (!Array.isArray(answers) || answers.length < 1) {
        return res.json({ success: false, error: '请提交完整答案' });
      }

      // 获取 session
      const sessionResult = await pool().query(
        `SELECT * FROM training_sessions WHERE id = $1 AND employee_username = $2`,
        [id, username]
      );

      if (sessionResult.rows.length === 0) {
        return res.json({ success: false, error: '会话不存在' });
      }

      const session = sessionResult.rows[0];
      const questions = session.quiz_questions || [];

      // 查询 assignment 的 require_practice 标志
      const assignmentRes = await pool().query(
        `SELECT require_practice FROM training_assignments WHERE employee_username = $1 AND topic_id = $2`,
        [username, session.topic_id]
      );
      const requirePractice = assignmentRes.rows[0]?.require_practice ?? true; // 默认需要实操

      // 计算得分（百分制）
      let correctCount = 0;
      const results = questions.map((q, i) => {
        const userAnswer = answers[i];
        const correct = q.answer;
        const isCorrect = userAnswer === correct;
        if (isCorrect) correctCount++;
        return {
          q: q.q,
          options: q.options,
          userAnswer,
          correct,
          isCorrect,
          explanation: q.explanation
        };
      });

      const score = Math.round(correctCount / questions.length * 100); // 0-100分
      const passed = score >= 90; // 90分即通过

      // 通过且不需要实操 → 直接 certified；通过且需要实操 → practice；未通过 → 留在 quiz
      let nextStatus = 'quiz';
      if (passed) {
        nextStatus = requirePractice ? 'practice' : 'certified';
      }

      // 追加本次考试到 quiz_history（保留完整历史记录）
      await pool().query(
        `UPDATE training_sessions
         SET quiz_answers = $1, quiz_score = $2, quiz_passed = $3,
             quiz_passed_at = CASE WHEN $3 THEN NOW() ELSE quiz_passed_at END,
             status = $4,
             certified_at = CASE WHEN $5 THEN NOW() ELSE certified_at END,
             quiz_questions = NULL,
             quiz_history = COALESCE(quiz_history, '[]'::jsonb) || $6::jsonb
         WHERE id = $7`,
        [
          JSON.stringify(answers), score, passed, nextStatus, nextStatus === 'certified',
          JSON.stringify([{ score, passed, at: new Date().toISOString() }]),
          id
        ]
      );

      res.json({ success: true, score, passed, total: questions.length, results, require_practice: requirePractice, next_status: nextStatus });
    } catch (e) {
      console.error('[Training] Submit quiz error:', e?.message);
      res.json({ success: false, error: e?.message });
    }
  });

  // POST /api/training/sessions/:id/upload-practice - 上传实操视频/图片（图谱评分版）
  app.post('/api/training/sessions/:id/upload-practice', authMiddleware, uploadMiddleware.single('file'), async (req, res) => {
    try {
      const { id } = req.params;
      const username = req.user?.username;

      if (!req.file) {
        return res.json({ success: false, error: '请上传文件' });
      }

      const sessionResult = await pool().query(`
        SELECT s.*, t.title, t.position, t.description, t.key_points, t.practice_task, t.step_rubric
        FROM training_sessions s JOIN training_topics t ON t.id = s.topic_id
        WHERE s.id = $1 AND s.employee_username = $2
      `, [id, username]);

      if (sessionResult.rows.length === 0) return res.json({ success: false, error: '会话不存在' });
      const session = sessionResult.rows[0];
      if (!session.quiz_passed) return res.json({ success: false, error: '请先通过测验' });

      const rubric = session.step_rubric;
      const topicTitle = session.title || '';

      const filePath = req.file.path;
      const fileName = req.file.filename;
      const mediaUrl = `/uploads/training/${fileName}`;
      const originalExt = path.extname(req.file.originalname).toLowerCase();
      const mediaType = ['.mp4', '.mov', '.webm'].includes(originalExt) ? 'video' : 'image';
      const baseUrl = process.env.SERVER_BASE_URL || 'https://nnyx.cc';

      let aiVerdict = 'review';
      let aiFeedback = '';
      let aiRawResponse = null;
      let aiStepScores = null;
      let aiTotalScore = null;

      if (rubric && Array.isArray(rubric.items) && rubric.items.length) {
        // ──── 图谱评分模式（兼容新旧格式）────
        const isKitchenSop = rubric.items[0].action !== undefined;  // 厨房SOP格式用action，旧格式用name
        const dishInfo = rubric.dish_name ? `考核菜品：${rubric.dish_name}（${rubric.station || '未知工位'}）` : '';
        const scoringPrompt = `你是餐饮实操考试审评官。请根据以下步骤评分表，逐项判断员工操作是否合格，给出具体得分和扣分原因。

【评分表】
${dishInfo}
项目：
${rubric.items.map((item, i) => {
  const name = item.action || item.name || `步骤${i+1}`;
  const checks = item.checks || [];
  const quality = item.quality_standard ? `质量标准：${item.quality_standard}` : '';
  const failure = item.common_failure ? `常见失败：${item.common_failure}` : '';
  const critical = item.is_critical ? '【关键步骤】' : '';
  return `  ${i+1}. ${critical} ${name}（${item.weight}分）: ${checks.join('；')}${quality ? '\n     质量：'+quality : ''}${failure ? '\n     注意：'+failure : ''}`;
}).join('\n')}
一票否决项：${(rubric.fail_criteria || []).join('；')}
合格线：${rubric.pass_threshold || 80}分
实操科目：${topicTitle}

请先认真观看${mediaType === 'video' ? '完整视频' : '图片'}，然后逐项评分。严格返回JSON：
{
  "steps": [{"name":"步骤名称","score":12,"max":15,"feedback":"得分或扣分具体原因"}],
  "total_score": 88,
  "verdict": "passed/review/failed",
  "fail_reason": "一票否决原因（无则填null）",
  "summary": "整体评价，50字以内"
}
verdict说明：passed=总分≥${rubric.pass_threshold || 80}且无一票否决，review=总分60-79或存疑，failed=总分<60或有一票否决。
注意：只能输出JSON，不要任何额外文字。`;

        try {
          if (mediaType === 'image') {
            const visionResult = await callVisionLLM(filePath, scoringPrompt);
            aiRawResponse = visionResult;
            const text = visionResult?.content || '';
            const jsonMatch = text.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
              const p = parseScoringJson(jsonMatch[0]);
              aiVerdict = p.aiVerdict; aiFeedback = p.aiFeedback;
              aiStepScores = p.aiStepScores; aiTotalScore = p.aiTotalScore;
            }
          } else {
            const videoUrl = `${baseUrl}${mediaUrl}`;
            // Try native video analysis first
            let visionResult = await callVisionLLMVideo(videoUrl, scoringPrompt);
            if (!visionResult?.ok) {
              // Fallback: multi-frame extraction
              const frames = [];
              const frameDir = path.join(uploadsDir, `frames-${randomUUID()}`);
              fs.mkdirSync(frameDir, { recursive: true });
              try {
                execFileSync('ffmpeg', ['-i', filePath, '-vf', 'fps=1/5,scale=480:-1', '-frames:v', '8', path.join(frameDir, '%03d.jpg')], { timeout: 60000 });
                const frameFiles = fs.readdirSync(frameDir).sort().slice(0, 8);
                for (const f of frameFiles) {
                  const buf = fs.readFileSync(path.join(frameDir, f));
                  frames.push({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${buf.toString('base64')}` } });
                }
                frames.push({ type: 'text', text: scoringPrompt });
                visionResult = await callVisionLLM(frames, '');
              } finally {
                try { fs.rmSync(frameDir, { recursive: true, force: true }); } catch (_) {}
              }
            }
            aiRawResponse = visionResult;
            const text = visionResult?.content || '';
            const jsonMatch = text.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
              const p = parseScoringJson(jsonMatch[0]);
              aiVerdict = p.aiVerdict; aiFeedback = p.aiFeedback;
              aiStepScores = p.aiStepScores; aiTotalScore = p.aiTotalScore;
            }
          }
        } catch (scoreErr) {
          console.error('[Training] Rubric scoring error:', scoreErr?.message);
          aiVerdict = 'review';
          aiFeedback = 'AI评分失败，需人工审核';
        }
      } else {
        // ──── 无图谱：传统单帧判断 ────
        const judgmentPrompt = `你是餐饮培训评审官。请根据以下实操任务要求，判断图片/视频帧中的操作是否合格。
任务要求：${session.practice_task || '按要求完成操作'}
考核要点：${JSON.stringify(session.key_points)}
请返回JSON：{"verdict":"passed/review/failed","feedback":"具体说明，50字以内"}
verdict说明：passed=合格，review=需人工复核，failed=不合格需重练。`;

        try {
          if (mediaType === 'image') {
            const visionResult = await callVisionLLM(filePath, judgmentPrompt);
            aiRawResponse = visionResult;
            const text = visionResult?.content || '';
            const jsonMatch = text.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
              const parsed = JSON.parse(jsonMatch[0]);
              aiVerdict = parsed.verdict || 'review';
              aiFeedback = parsed.feedback || '';
            }
          } else {
            try {
              const framePath = path.join(uploadsDir, `frame-${randomUUID()}.jpg`);
              execFileSync('ffmpeg', ['-i', filePath, '-ss', '00:00:05', '-frames:v', '1', framePath], { timeout: 30000 });
              const visionResult = await callVisionLLM(framePath, judgmentPrompt);
              aiRawResponse = visionResult;
              const text = visionResult?.content || '';
              const jsonMatch = text.match(/\{[\s\S]*\}/);
              if (jsonMatch) {
                const parsed = JSON.parse(jsonMatch[0]);
                aiVerdict = parsed.verdict || 'review';
                aiFeedback = parsed.feedback || '';
              }
              try { fs.unlinkSync(framePath); } catch (_) {}
            } catch (ffmpegErr) {
              aiVerdict = 'review';
              aiFeedback = '视频处理失败，需人工审核';
            }
          }
        } catch (aiErr) {
          aiVerdict = 'review';
          aiFeedback = 'AI 判定失败，需人工审核';
        }
      }

      // 保存认证记录（图谱评分始终设为 pending review，等派发人确认）
      const certResult = await pool().query(
        `INSERT INTO training_certifications (session_id, employee_username, topic_id, media_url, media_type, ai_verdict, ai_feedback, ai_raw_response, ai_step_scores, ai_total_score, review_status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'pending')
         RETURNING *`,
        [id, username, session.topic_id, mediaUrl, mediaType, aiVerdict, aiFeedback || '', aiRawResponse, JSON.stringify(aiStepScores), aiTotalScore]
      );

      res.json({
        success: true,
        certification: certResult.rows[0],
        verdict: aiVerdict,
        feedback: aiFeedback,
        step_scores: aiStepScores,
        total_score: aiTotalScore,
        has_rubric: !!rubric
      });
    } catch (e) {
      console.error('[Training] Upload practice error:', e?.message);
      res.json({ success: false, error: e?.message });
    }
  });

}

export async function runTrainingReminderSweep() {
  const todayKey = getShanghaiDateKey();
  let preDueSent = 0;
  let overdueEscalated = 0;

  try {
    const result = await pool().query(`
      SELECT
        a.id,
        a.employee_username,
        a.assigned_by,
        a.topic_id,
        a.due_date,
        a.reminder_meta,
        t.title,
        COALESCE(e.name, a.employee_username) AS employee_name,
        COALESCE(assigner_emp.name, a.assigned_by, '管理员') AS assigner_name,
        COALESCE(s.status, 'not_started') AS session_status
      FROM training_assignments a
      JOIN training_topics t ON t.id = a.topic_id
      LEFT JOIN training_sessions s ON s.topic_id = a.topic_id AND s.employee_username = a.employee_username
      LEFT JOIN employees e ON e.username = a.employee_username
      LEFT JOIN employees assigner_emp ON assigner_emp.username = a.assigned_by
      WHERE a.due_date IS NOT NULL
        AND t.is_active = true
        AND COALESCE(s.status, 'not_started') != 'certified'
      ORDER BY a.due_date ASC, a.created_at ASC
    `);

    for (const row of result.rows || []) {
      const dueDate = String(row.due_date || '').slice(0, 10);
      if (!dueDate) continue;
      const reminderMeta = parseReminderMeta(row.reminder_meta);
      const topicTitle = String(row.title || '培训任务').trim();
      const assigneeName = String(row.employee_name || row.employee_username || '').trim() || '员工';
      const assignerName = String(row.assigner_name || row.assigned_by || '').trim() || '管理员';
      const isOverdue = todayKey > dueDate;

      if (!isOverdue) {
        if (reminderMeta.last_pre_due_reminder_on === todayKey) continue;
        const message = `请在 ${dueDate} 前完成培训任务「${topicTitle}」。系统将每天提醒一次，当前仍未完成，请尽快登录 HRMS 完成学习。`;
        await createTrainingUserNotification(
          row.employee_username,
          '培训任务完成提醒',
          message,
          {
            assignment_id: row.id,
            topic_id: row.topic_id,
            due_date: dueDate,
            reminder_phase: 'pre_due',
            reminded_on: todayKey
          }
        );
        await sendTrainingFeishuMessage(
          row.employee_username,
          `📚 培训任务提醒\n\n你被指派的培训任务【${topicTitle}】尚未完成。\n截止日期：${dueDate}\n系统会在截止前每天提醒 1 次，请尽快登录 HRMS 完成学习。`
        );
        await pool().query(
          `UPDATE training_assignments
           SET reminder_meta = COALESCE(reminder_meta, '{}'::jsonb) || $1::jsonb
           WHERE id = $2`,
          [
            JSON.stringify({
              last_pre_due_reminder_on: todayKey,
              pre_due_reminder_count: Number(reminderMeta.pre_due_reminder_count || 0) + 1,
              last_pre_due_reminder_at: getShanghaiDateTimeText()
            }),
            row.id
          ]
        );
        preDueSent++;
        continue;
      }

      if (reminderMeta.last_overdue_reminder_on === todayKey) continue;
      const daysOverdue = Math.max(1, Math.floor((Date.parse(`${todayKey}T00:00:00+08:00`) - Date.parse(`${dueDate}T00:00:00+08:00`)) / 86400000));
      await sendTrainingFeishuMessage(
        row.employee_username,
        `⚠️ 培训任务已逾期\n\n培训任务【${topicTitle}】已超过截止日期 ${daysOverdue} 天（截止：${dueDate}）。请立即登录 HRMS 补完成，进度看板已标记为逾期。`
      );
      if (row.assigned_by) {
        await sendTrainingFeishuMessage(
          row.assigned_by,
          `🚨 培训任务逾期提醒\n\n${assigneeName} 的培训任务【${topicTitle}】已逾期 ${daysOverdue} 天（截止：${dueDate}），当前仍未完成。请在培训进度看板中查看并跟进。`
        );
        await createTrainingUserNotification(
          row.assigned_by,
          '培训任务逾期提醒',
          `${assigneeName} 的培训任务「${topicTitle}」已逾期 ${daysOverdue} 天，请及时跟进。`,
          {
            assignment_id: row.id,
            topic_id: row.topic_id,
            due_date: dueDate,
            assignee_username: row.employee_username,
            reminder_phase: 'overdue_escalation',
            reminded_on: todayKey
          }
        );
      }
      await pool().query(
        `UPDATE training_assignments
         SET reminder_meta = COALESCE(reminder_meta, '{}'::jsonb) || $1::jsonb
         WHERE id = $2`,
        [
          JSON.stringify({
            last_overdue_reminder_on: todayKey,
            overdue_reminder_count: Number(reminderMeta.overdue_reminder_count || 0) + 1,
            last_overdue_reminder_at: getShanghaiDateTimeText()
          }),
          row.id
        ]
      );
      overdueEscalated++;
    }
  } catch (e) {
    console.error('[Training] reminder sweep error:', e?.message || e);
    return { ok: false, error: e?.message || String(e), preDueSent, overdueEscalated };
  }

  if (preDueSent || overdueEscalated) {
    console.log(`[Training] reminder sweep complete: preDue=${preDueSent}, overdue=${overdueEscalated}`);
  }
  return { ok: true, preDueSent, overdueEscalated };
}

export function startTrainingReminderScheduler() {
  if (_trainingReminderSchedulerStarted) return;
  _trainingReminderSchedulerStarted = true;

  const tick = () => {
    runTrainingReminderSweep().catch((e) => {
      console.error('[Training] reminder scheduler tick error:', e?.message || e);
    });
  };

  setTimeout(tick, 90 * 1000);
  setInterval(tick, TRAINING_REMINDER_INTERVAL_MS);
  console.log('[Training] reminder scheduler started');
}
