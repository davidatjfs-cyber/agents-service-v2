import { pool } from './utils/database.js';
import { calculateEmployeeScore } from './new-scoring-model.js';
import { sendLarkCard } from './agents.js';

function getShanghaiYmd() {
  return new Date().toLocaleString('en-CA', { timeZone: 'Asia/Shanghai' }).slice(0, 10);
}

function getShanghaiPrevYm() {
  const d = new Date();
  const shD = new Date(d.toLocaleString('en-US', { timeZone: 'Asia/Shanghai' }));
  shD.setMonth(shD.getMonth() - 1);
  const y = shD.getFullYear();
  const m = String(shD.getMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

function isWithin3DaysAndSameMonth(createdAt) {
  const now = new Date();
  const created = new Date(createdAt);
  const diffMs = now - created;
  const diffDays = diffMs / (1000 * 60 * 60 * 24);
  if (diffDays > 3) return false;
  const shNow = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Shanghai' }));
  const shCreated = new Date(created.toLocaleString('en-US', { timeZone: 'Asia/Shanghai' }));
  if (shNow.getFullYear() !== shCreated.getFullYear() || shNow.getMonth() !== shCreated.getMonth()) return false;
  return true;
}

function buildChangeCard(before, after, username, name, store, role, period) {
  const roleLabel = role === 'store_manager' ? '店长' : role === 'store_production_manager' ? '出品经理' : role;
  const lines = [];

  const scoreBefore = before.total_score ?? '—';
  const scoreAfter = after.total_score ?? '—';
  if (scoreBefore !== scoreAfter) lines.push(`• 绩效得分：${scoreBefore} → ${scoreAfter}`);

  const dims = [
    { key: 'execution_rating', label: '执行力' },
    { key: 'attitude_rating', label: '工作态度' },
    { key: 'ability_rating', label: '工作能力' }
  ];
  for (const d of dims) {
    const b = before[d.key] ?? '—';
    const a = after[d.key] ?? '—';
    if (b !== a) lines.push(`• ${d.label}：${b} → ${a}`);
  }

  if (!lines.length) return null;

  const content = `**门店**：${store}
**岗位**：${roleLabel} · ${name || username}
**统计月**：${period}

**变更明细**
${lines.join('\n')}

**变更后**
• 绩效得分：**${scoreAfter}**
• 执行力：**${after.execution_rating ?? '—'}**
• 工作态度：**${after.attitude_rating ?? '—'}**
• 工作能力：**${after.ability_rating ?? '—'}**`;

  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: `\u270f\ufe0f 绩效数据变更通知 \xb7 ${period}` },
      template: 'orange'
    },
    elements: [
      { tag: 'div', text: { tag: 'lark_md', content } },
      { tag: 'note', elements: [{ tag: 'plain_text', content: '管理员已变更绩效记录，数据即刻生效' }] }
    ]
  };
}

export function registerPerformanceInvalidationRoutes(app, authRequired) {

  app.get('/api/admin/performance-records', authRequired, async (req, res) => {
    const role = String(req.user?.role || '').trim();
    if (role !== 'admin') return res.status(403).json({ error: 'admin_only' });

    const { username, period } = req.query;
    if (!period) return res.status(400).json({ error: 'period_required' });

    const p = pool();
    try {
      const weeklyParams = [];
      let weeklyWhere = `WHERE period LIKE 'week_%'
        AND score_model = 'anomaly_rollups_v2'`;
      if (username) {
        weeklyWhere += ` AND LOWER(TRIM(username)) = LOWER(TRIM($${weeklyParams.length + 1}))`;
        weeklyParams.push(username);
      }
      const weekEnd = period.includes('-') ? `${period}-${String(new Date(Number(period.split('-')[0]), Number(period.split('-')[1]), 0).getDate()).padStart(2, '0')}` : period;
      const monthKey = period.replace('-', '');
      if (period.match(/^\d{4}-\d{2}$/)) {
        weeklyWhere += ` AND (
          (POSITION('__' IN period) = 0
            AND substring(period from 6 for 10)::date >= $${weeklyParams.length + 1}::date
            AND substring(period from 6 for 10)::date <= $${weeklyParams.length + 2}::date)
          OR
          (POSITION('__' IN period) > 0 AND split_part(period, '__', 2) = $${weeklyParams.length + 3})
        )`;
        weeklyParams.push(`${period}-01`, weekEnd, monthKey);
      }

      const weekly = await p.query(
        `SELECT id, brand, store, username, name, role, period, total_score, deductions, breakdown, summary,
                COALESCE(is_invalidated, false) AS is_invalidated,
                invalidated_at, created_at
         FROM agent_scores ${weeklyWhere}
         ORDER BY created_at DESC`,
        weeklyParams
      );

      const mtSources = ['random_inspection', 'scheduled_inspection', 'bi_anomaly', 'auto_collab', 'data_auditor'];
      let mtWhere = `WHERE mt.source = ANY($1::text[])
        AND COALESCE(mt.hr_performance_recorded, false) = true
        AND (mt.dispatched_at AT TIME ZONE 'Asia/Shanghai')::date >= $2::date
        AND (mt.dispatched_at AT TIME ZONE 'Asia/Shanghai')::date <= $3::date`;
      const mtParams = [mtSources, `${period}-01`, weekEnd];
      if (username) {
        mtWhere += ` AND LOWER(TRIM(COALESCE(mt.assignee_username, ''))) = LOWER(TRIM($${mtParams.length + 1}))`;
        mtParams.push(username);
      }

      const filings = await p.query(
        `SELECT mt.task_id, mt.store, mt.assignee_username, mt.assignee_role, mt.source, mt.category, mt.title, mt.detail,
                mt.dispatched_at,
                COALESCE(NULLIF(TRIM(fu.name), ''), mt.assignee_username) AS assignee_name,
                EXISTS (
                  SELECT 1 FROM performance_invalidation_records pir
                  WHERE pir.source_type = 'master_tasks_filing' AND pir.source_id = mt.task_id
                ) AS is_invalidated
         FROM master_tasks mt
         LEFT JOIN feishu_users fu ON LOWER(TRIM(fu.username)) = LOWER(TRIM(mt.assignee_username))
         ${mtWhere}
         ORDER BY mt.dispatched_at DESC`,
        mtParams
      );

      const invalidations = await p.query(
        `SELECT * FROM performance_invalidation_records
         WHERE period = $1 ${username ? 'AND LOWER(TRIM(username)) = LOWER(TRIM($2))' : ''}
         ORDER BY invalidated_at DESC`,
        username ? [period, username] : [period]
      );

      let dailyBi = { rows: [] };
      if (/^\d{4}-\d{2}$/.test(String(period || '').trim())) {
        const monthStart = `${period}-01`;
        const monthEnd = weekEnd;
        const dailyParams = [monthStart, monthEnd];
        let dailyWhere = `WHERE at.trigger_date >= $1::date AND at.trigger_date <= $2::date`;
        if (username) {
          dailyWhere += ` AND at.store IN (
              SELECT DISTINCT TRIM(store)
              FROM feishu_users
              WHERE LOWER(TRIM(username)) = LOWER(TRIM($3))
                AND TRIM(COALESCE(store, '')) <> ''
            )`;
          dailyParams.push(username);
        }
        const dailyLimit = username ? 800 : 300;
        dailyBi = await p.query(
          `SELECT at.id, at.anomaly_key, at.store, at.severity, at.trigger_date, at.status, at.created_at
           FROM anomaly_triggers at
           ${dailyWhere}
           ORDER BY at.trigger_date DESC, at.created_at DESC
           LIMIT ${dailyLimit}`,
          dailyParams
        );
      }

      let employeeMonthlyScores = [];
      if (username && /^\d{4}-\d{2}$/.test(String(period || '').trim())) {
        const em = await p.query(
          `SELECT store, role, total_score, execution_rating, attitude_rating, ability_rating, updated_at
           FROM employee_scores
           WHERE LOWER(TRIM(username)) = LOWER(TRIM($1)) AND period = $2
           ORDER BY updated_at DESC NULLS LAST`,
          [username, period]
        );
        employeeMonthlyScores = em.rows;
      }

      res.json({
        success: true,
        data: {
          weekly_scores: weekly.rows,
          filings: filings.rows,
          invalidations: invalidations.rows,
          daily_bi_triggers: dailyBi.rows,
          employee_monthly_scores: employeeMonthlyScores
        }
      });
    } catch (e) {
      console.error('[performance-records] error:', e?.message);
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  app.post('/api/admin/performance-invalidate', authRequired, async (req, res) => {
    const role = String(req.user?.role || '').trim();
    if (role !== 'admin') return res.status(403).json({ error: 'admin_only' });

    const { source_type, source_id, username, store, period } = req.body;
    if (!source_type || !source_id || !username || !period) {
      return res.status(400).json({ error: 'missing_fields' });
    }

    if (!/^\d{4}-\d{2}$/.test(period)) {
      return res.status(400).json({ error: 'invalid_period_format' });
    }

    const adminUser = String(req.user?.username || '').trim();
    const p = pool();

    try {
      // ── Phase 1: Commit invalidation (own transaction) ──
      let beforeData = {};
      let empStore = store || '';
      let empRole = '';

      await p.query('BEGIN');

      // 3-day + same-month check
      let createdAt;
      if (source_type === 'agent_scores_weekly') {
        const chk = await p.query(
          `SELECT id, created_at FROM agent_scores WHERE id::text = $1 LIMIT 1`,
          [String(source_id)]
        );
        if (!chk.rows?.length) {
          await p.query('ROLLBACK');
          return res.status(404).json({ error: 'record_not_found' });
        }
        createdAt = chk.rows[0].created_at;
        if (!isWithin3DaysAndSameMonth(createdAt)) {
          await p.query('ROLLBACK');
          return res.status(400).json({ error: 'out_of_invalidation_window', message: '只能失效3天内且同月的记录' });
        }
      } else if (source_type === 'master_tasks_filing') {
        const chk = await p.query(
          `SELECT task_id, dispatched_at FROM master_tasks WHERE task_id = $1 LIMIT 1`,
          [String(source_id)]
        );
        if (!chk.rows?.length) {
          await p.query('ROLLBACK');
          return res.status(404).json({ error: 'record_not_found' });
        }
        createdAt = chk.rows[0].dispatched_at;
        if (!isWithin3DaysAndSameMonth(createdAt)) {
          await p.query('ROLLBACK');
          return res.status(400).json({ error: 'out_of_invalidation_window', message: '只能失效3天内且同月的记录' });
        }
      } else {
        await p.query('ROLLBACK');
        return res.status(400).json({ error: 'unsupported_source_type' });
      }

      // Check already invalidated
      const dupChk = await p.query(
        `SELECT 1 FROM performance_invalidation_records
         WHERE source_type = $1 AND source_id = $2 LIMIT 1`,
        [source_type, String(source_id)]
      );
      if (dupChk.rows?.length) {
        await p.query('ROLLBACK');
        return res.status(409).json({ error: 'already_invalidated' });
      }

      // Capture before state
      const empBefore = await p.query(
        `SELECT total_score, execution_rating, attitude_rating, ability_rating
         FROM employee_scores
         WHERE LOWER(TRIM(username)) = LOWER(TRIM($1)) AND period = $2
         LIMIT 1`,
        [username, period]
      );
      beforeData = empBefore.rows?.[0] || {};

      // Mark invalidation
      if (source_type === 'agent_scores_weekly') {
        await p.query(
          `UPDATE agent_scores SET is_invalidated = TRUE, invalidated_at = NOW() WHERE id::text = $1`,
          [String(source_id)]
        );
      }

      await p.query(
        `INSERT INTO performance_invalidation_records (source_type, source_id, username, store, period, invalidated_by)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (source_type, source_id) DO NOTHING`,
        [source_type, String(source_id), username, store || null, period, adminUser]
      );

      // Resolve employee store/role
      const fuRow = await p.query(
        `SELECT store, role FROM feishu_users
         WHERE LOWER(TRIM(username)) = LOWER(TRIM($1)) AND registered = TRUE LIMIT 1`,
        [username]
      );
      if (!empStore) empStore = fuRow.rows?.[0]?.store || '';
      empRole = fuRow.rows?.[0]?.role || '';

      // COMMIT the invalidation so pool() queries can see it
      await p.query('COMMIT');

      // ── Phase 2: Recalculate (pool connections now see committed invalidation) ──
      let afterData = null;
      if (empStore && empRole) {
        try {
          afterData = await calculateEmployeeScore(empStore, username, empRole, period);
        } catch (calcErr) {
          console.error('[performance-invalidate] recalc error:', calcErr?.message);
        }
      }

      // B2 fix: guard against null afterData
      const safeAfter = afterData || {};
      const calcSucceeded = afterData !== null && typeof afterData.total_score !== 'undefined';

      const hasChange = calcSucceeded && (
        beforeData.total_score !== safeAfter.total_score
        || beforeData.execution_rating !== safeAfter.execution_rating
        || beforeData.attitude_rating !== safeAfter.attitude_rating
        || beforeData.ability_rating !== safeAfter.ability_rating
      );

      // ── Phase 3: Notifications (only if score actually changed) ──
      if (hasChange) {
        const nameRow = await p.query(
          `SELECT COALESCE(NULLIF(TRIM(name), ''), username) AS name FROM feishu_users
           WHERE LOWER(TRIM(username)) = LOWER(TRIM($1)) AND registered = TRUE LIMIT 1`,
          [username]
        );
        const empName = nameRow.rows?.[0]?.name || username;

        await p.query(
          `INSERT INTO hrms_user_notifications (target_username, title, message, type, meta)
           VALUES ($1, $2, $3, $4, $5::jsonb)`,
          [
            username,
            `绩效数据变更通知｜${period}`,
            `您的${period}月绩效数据已变更。绩效得分：${beforeData.total_score ?? '—'} → ${safeAfter.total_score ?? '—'}；执行力：${beforeData.execution_rating ?? '—'} → ${safeAfter.execution_rating ?? '—'}；态度：${beforeData.attitude_rating ?? '—'} → ${safeAfter.attitude_rating ?? '—'}；能力：${beforeData.ability_rating ?? '—'} → ${safeAfter.ability_rating ?? '—'}`,
            'performance_invalidation_change',
            JSON.stringify({ period, source_type, source_id: String(source_id), before: beforeData, after: safeAfter })
          ]
        );

        const card = buildChangeCard(beforeData, safeAfter, username, empName, empStore, empRole, period);
        if (card) {
          const openIdRow = await p.query(
            `SELECT open_id FROM feishu_users
             WHERE LOWER(TRIM(username)) = LOWER(TRIM($1)) AND registered = TRUE AND open_id IS NOT NULL AND open_id <> ''
             LIMIT 1`,
            [username]
          );
          if (openIdRow.rows?.[0]?.open_id) {
            sendLarkCard(openIdRow.rows[0].open_id, card).catch((e) =>
              console.warn('[performance-invalidate] feishu card to user failed:', e?.message)
            );
          }

          const adminOpenId = await p.query(
            `SELECT open_id FROM feishu_users
             WHERE LOWER(TRIM(username)) = LOWER(TRIM($1)) AND registered = TRUE AND open_id IS NOT NULL AND open_id <> ''
               AND open_id NOT LIKE '%probe%'
             ORDER BY updated_at DESC LIMIT 1`,
            [adminUser]
          );
          if (adminOpenId.rows?.[0]?.open_id) {
            sendLarkCard(adminOpenId.rows[0].open_id, card).catch((e) =>
              console.warn('[performance-invalidate] feishu card to admin failed:', e?.message)
            );
          }
        }
      }

      res.json({
        success: true,
        data: {
          invalidated: { source_type, source_id, username, period },
          before: beforeData,
          after: safeAfter,
          changed: hasChange,
          recalc_failed: !calcSucceeded
        }
      });
    } catch (e) {
      console.error('[performance-invalidate] error:', e?.message);
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  console.log('[api] 绩效审核失效API路由已注册');
}