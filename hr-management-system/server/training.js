/**
 * HRMS 培训认证模块
 *
 * 功能：知识点管理、培训指派、AI 辅助学习、测验、实操判定、认证管理
 * 权限：管理端（admin/hq_manager/store_manager/store_production_manager/hr_manager）
 *       员工端（所有登录用户）
 */

import { pool as getPool } from './utils/database.js';
import { callLLM, callVisionLLM, lookupFeishuUserByUsername, sendLarkMessage } from './agents.js';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { randomUUID } from 'crypto';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const uploadsDir = path.join(__dirname, 'uploads', 'training');
function pool() { return getPool(); }

const MANAGER_ROLES = ['admin', 'hq_manager', 'store_manager', 'store_production_manager', 'hr_manager'];
function isManager(role) { return MANAGER_ROLES.includes(role); }

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
      if (!isManager(req.user?.role)) {
        return res.status(403).json({ error: '无权限访问' });
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
      if (!isManager(req.user?.role)) {
        return res.status(403).json({ error: '无权限访问' });
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
      if (!isManager(req.user?.role)) {
        return res.status(403).json({ error: '无权限访问' });
      }
      await pool().query(`UPDATE training_topics SET is_active = false WHERE id = $1`, [req.params.id]);
      res.json({ success: true });
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
      const params = q ? ['%' + q + '%'] : [];
      const sql = q
        ? `SELECT id, title, category, LEFT(content, 200) AS excerpt
           FROM knowledge_base
           WHERE enabled = true AND (title ILIKE $1 OR content ILIKE $1)
           ORDER BY title LIMIT 20`
        : `SELECT id, title, category, LEFT(content, 200) AS excerpt
           FROM knowledge_base
           WHERE enabled = true
           ORDER BY updated_at DESC LIMIT 20`;
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
      if (!isManager(req.user?.role)) {
        return res.status(403).json({ error: '无权限访问' });
      }
      const name = (req.query.name || '').trim();
      const params = [];
      let sql = `
        SELECT a.*, t.title, t.position,
               s.status AS session_status, s.quiz_passed, s.quiz_score,
               e.name AS employee_name
        FROM training_assignments a
        JOIN training_topics t ON t.id = a.topic_id
        LEFT JOIN training_sessions s ON s.topic_id = a.topic_id AND s.employee_username = a.employee_username
        LEFT JOIN employees e ON e.username = a.employee_username
        WHERE 1=1
      `;
      if (name) {
        sql += ` AND (e.name ILIKE $1 OR a.employee_username ILIKE $1)`;
        params.push('%' + name + '%');
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
      if (!isManager(req.user?.role)) {
        return res.status(403).json({ error: '无权限访问' });
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
          `INSERT INTO training_assignments (employee_username, topic_id, assigned_by, due_date, note)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (employee_username, topic_id) DO UPDATE
           SET due_date = EXCLUDED.due_date, note = EXCLUDED.note, assigned_by = EXCLUDED.assigned_by
           RETURNING *`,
          [username, topic_id, req.user?.username, due_date || null, note || '']
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

  // DELETE /api/training/assignments/:id - 撤销指派
  app.delete('/api/training/assignments/:id', authMiddleware, async (req, res) => {
    try {
      if (!isManager(req.user?.role)) {
        return res.status(403).json({ error: '无权限访问' });
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
               COALESCE(
                 json_agg(
                   json_build_object(
                     'username', a.employee_username,
                     'name', COALESCE(e.name, a.employee_username),
                     'status', COALESCE(s.status, 'not_started'),
                     'quiz_score', s.quiz_score
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

  // GET /api/training/certifications/pending - 待审核列表
  app.get('/api/training/certifications/pending', authMiddleware, async (req, res) => {
    try {
      if (!isManager(req.user?.role)) {
        return res.status(403).json({ error: '无权限访问' });
      }
      const result = await pool().query(`
        SELECT c.*, t.title, t.position, s.employee_username,
               e.name AS employee_name
        FROM training_certifications c
        JOIN training_sessions s ON s.id = c.session_id
        JOIN training_topics t ON t.id = c.topic_id
        LEFT JOIN employees e ON e.username = c.employee_username
        WHERE c.manager_verdict IS NULL
        ORDER BY c.created_at DESC
      `);
      res.json({ success: true, pending: result.rows });
    } catch (e) {
      res.json({ success: false, error: e?.message });
    }
  });

  // POST /api/training/certifications/:id/review - 人工复核
  app.post('/api/training/certifications/:id/review', authMiddleware, async (req, res) => {
    try {
      if (!isManager(req.user?.role)) {
        return res.status(403).json({ error: '无权限访问' });
      }
      const { id } = req.params;
      const { verdict, note } = req.body;
      if (!['passed', 'failed'].includes(verdict)) {
        return res.json({ success: false, error: '判定结果无效' });
      }

      // 更新认证记录
      const certResult = await pool().query(
        `UPDATE training_certifications
         SET manager_verdict = $1, manager_note = $2, manager_reviewed_by = $3,
             certified_at = CASE WHEN $4 THEN NOW() ELSE certified_at END
         WHERE id = $5
         RETURNING *`,
        [verdict, note || '', req.user?.username, verdict === 'passed', id]
      );

      if (certResult.rows.length === 0) {
        return res.json({ success: false, error: '认证记录不存在' });
      }

      // 如果通过，更新 session 状态
      if (verdict === 'passed') {
        const cert = certResult.rows[0];
        await pool().query(
          `UPDATE training_sessions SET status = 'certified' WHERE id = $1`,
          [cert.session_id]
        );
      }

      res.json({ success: true, certification: certResult.rows[0] });
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
        SELECT a.id AS assignment_id, a.due_date, a.note,
               t.id AS topic_id, t.title, t.position, t.description, t.key_points,
               s.id AS session_id, s.status AS session_status, s.quiz_passed, s.quiz_score
        FROM training_assignments a
        JOIN training_topics t ON t.id = a.topic_id
        LEFT JOIN training_sessions s ON s.topic_id = a.topic_id AND s.employee_username = a.employee_username
        WHERE a.employee_username = $1 AND t.is_active = true
        ORDER BY a.due_date NULLS LAST, a.created_at DESC
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
          `SELECT id, title, content FROM knowledge_base WHERE id = ANY($1) AND enabled = true ORDER BY title`,
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
          `SELECT title, LEFT(content, 2000) AS content FROM knowledge_base WHERE id = ANY($1) AND enabled = true`,
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
      if (session.quiz_passed) {
        return res.json({ success: false, error: '已通过测验，无需重复测试' });
      }

      const topic = {
        title: session.title,
        key_points: session.key_points,
        description: session.description,
        kb_article_ids: session.kb_article_ids || []
      };

      // 拼接关联知识库内容用于出题
      let kbQuizContext = '';
      if (topic.kb_article_ids.length > 0) {
        const kbResult = await pool().query(
          `SELECT title, LEFT(content, 1500) AS content FROM knowledge_base WHERE id = ANY($1) AND enabled = true`,
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
      const quizPrompt = `根据以下培训内容，生成20道单选题，JSON格式返回：
{"questions":[{"q":"题目","options":["选项A","选项B","选项C","选项D"],"answer":2,"explanation":"解析"}]}
重要要求：
1. answer 为正确选项的 index（0-3），每道题的正确答案位置必须随机分布，不能总是0或固定位置。
2. 20道题中正确答案在选项0、1、2、3位置各约5道，随机打散。
3. 题目要贴近实际操作场景，测试真实理解，避免纯记忆题。
培训主题：${topic.title}（岗位：${topic.position}）${kpSection}${kbQuizContext}`;

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

      // 计算得分
      let score = 0;
      const results = questions.map((q, i) => {
        const userAnswer = answers[i];
        const correct = q.answer;
        const isCorrect = userAnswer === correct;
        if (isCorrect) score++;
        return {
          q: q.q,
          options: q.options,
          userAnswer,
          correct,
          isCorrect,
          explanation: q.explanation
        };
      });

      const passed = score >= Math.ceil(questions.length * 0.7); // 70% 即通过

      // 更新 session
      await pool().query(
        `UPDATE training_sessions
         SET quiz_answers = $1, quiz_score = $2, quiz_passed = $3, quiz_passed_at = CASE WHEN $3 THEN NOW() ELSE quiz_passed_at END,
             status = CASE WHEN $3 THEN 'practice' ELSE 'quiz' END
         WHERE id = $4`,
        [JSON.stringify(answers), score, passed, id]
      );

      res.json({ success: true, score, passed, total: questions.length, results });
    } catch (e) {
      console.error('[Training] Submit quiz error:', e?.message);
      res.json({ success: false, error: e?.message });
    }
  });

  // POST /api/training/sessions/:id/upload-practice - 上传实操视频/图片
  app.post('/api/training/sessions/:id/upload-practice', authMiddleware, uploadMiddleware.single('file'), async (req, res) => {
    try {
      const { id } = req.params;
      const username = req.user?.username;

      if (!req.file) {
        return res.json({ success: false, error: '请上传文件' });
      }

      // 获取 session 和 topic
      const sessionResult = await pool().query(`
        SELECT s.*, t.title, t.position, t.description, t.key_points, t.practice_task
        FROM training_sessions s
        JOIN training_topics t ON t.id = s.topic_id
        WHERE s.id = $1 AND s.employee_username = $2
      `, [id, username]);

      if (sessionResult.rows.length === 0) {
        return res.json({ success: false, error: '会话不存在' });
      }

      const session = sessionResult.rows[0];
      if (!session.quiz_passed) {
        return res.json({ success: false, error: '请先通过测验' });
      }

      const topic = {
        title: session.title,
        key_points: session.key_points,
        practice_task: session.practice_task
      };

      const filePath = req.file.path;
      const fileName = req.file.filename;
      const mediaUrl = `/uploads/training/${fileName}`;
      const originalExt = path.extname(req.file.originalname).toLowerCase();
      const mediaType = ['.mp4', '.mov', '.webm'].includes(originalExt) ? 'video' : 'image';

      // AI 判定
      let aiVerdict = 'review';
      let aiFeedback = '';
      let aiRawResponse = null;

      const judgmentPrompt = `你是餐饮培训评审官。请根据以下实操任务要求，判断图片/视频帧中的操作是否合格。
任务要求：${topic.practice_task || '按要求完成操作'}
考核要点：${JSON.stringify(topic.key_points)}
请返回JSON：{"verdict":"passed/review/failed","feedback":"具体说明，50字以内"}
verdict说明：passed=合格，review=需人工复核，failed=不合格需重练。`;

      try {
        if (mediaType === 'image') {
          // 图片直接调用视觉 AI
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
          // 视频：尝试提取帧
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

            // 清理临时帧
            try { fs.unlinkSync(framePath); } catch (_) {}
          } catch (ffmpegErr) {
            console.warn('[Training] FFmpeg failed, fallback to manual review:', ffmpegErr?.message);
            aiVerdict = 'review';
            aiFeedback = '视频处理失败，需人工审核';
          }
        }
      } catch (aiErr) {
        console.error('[Training] AI judgment error:', aiErr?.message);
        aiVerdict = 'review';
        aiFeedback = 'AI 判定失败，需人工审核';
      }

      // 保存认证记录
      const certResult = await pool().query(
        `INSERT INTO training_certifications (session_id, employee_username, topic_id, media_url, media_type, ai_verdict, ai_feedback, ai_raw_response)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING *`,
        [id, username, session.topic_id, mediaUrl, mediaType, aiVerdict, aiFeedback, aiRawResponse]
      );

      // 如果 AI 判定通过，更新 session 状态
      if (aiVerdict === 'passed') {
        await pool().query(`UPDATE training_sessions SET status = 'certified' WHERE id = $1`, [id]);
      }

      res.json({
        success: true,
        certification: certResult.rows[0],
        verdict: aiVerdict,
        feedback: aiFeedback
      });
    } catch (e) {
      console.error('[Training] Upload practice error:', e?.message);
      res.json({ success: false, error: e?.message });
    }
  });

  // GET /api/training/my-certifications - 我的认证记录
  app.get('/api/training/my-certifications', authMiddleware, async (req, res) => {
    try {
      const username = req.user?.username;
      const result = await pool().query(`
        SELECT c.*, t.title, t.position
        FROM training_certifications c
        JOIN training_topics t ON t.id = c.topic_id
        WHERE c.employee_username = $1
        ORDER BY c.created_at DESC
      `, [username]);
      res.json({ success: true, certifications: result.rows });
    } catch (e) {
      res.json({ success: false, error: e?.message });
    }
  });
}
