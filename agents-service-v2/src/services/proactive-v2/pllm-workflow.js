import { query } from '../../utils/db.js';
import { logger } from '../../utils/logger.js';
import { sendCard, sendText } from '../feishu-client.js';
import { transitionTask } from '../task-state-machine.js';

const DAY_MS = 24 * 60 * 60 * 1000;

function parseSourceData(sd) {
  if (!sd) return {};
  if (typeof sd === 'object' && !Array.isArray(sd)) return sd;
  try {
    return JSON.parse(String(sd));
  } catch {
    return {};
  }
}

function nowIso() {
  return new Date().toISOString();
}

function shanghaiYmd() {
  return new Date().toLocaleString('en-CA', { timeZone: 'Asia/Shanghai' }).slice(0, 10);
}

function shanghaiHm() {
  const p = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Shanghai',
    hour12: false,
    hour: '2-digit',
    minute: '2-digit'
  }).formatToParts(new Date());
  const get = (k) => p.find((x) => x.type === k)?.value || '00';
  return { hh: Number(get('hour') || 0), mm: Number(get('minute') || 0) };
}

async function resolvePllmRecipientsFromTask(task) {
  const sd = parseSourceData(task.source_data);
  const frozen = Array.isArray(sd.assignee_open_ids)
    ? sd.assignee_open_ids.map((x) => String(x || '').trim()).filter(Boolean)
    : [];
  if (frozen.length) return frozen;
  const r = await query(
    `SELECT open_id FROM feishu_users
     WHERE registered = true
       AND role IN ('admin','hq_manager')
       AND open_id IS NOT NULL AND trim(open_id) <> '' AND open_id NOT LIKE '%probe%'
     ORDER BY role = 'admin' DESC, updated_at DESC NULLS LAST`
  );
  return (r.rows || []).map((x) => String(x.open_id || '').trim()).filter(Boolean);
}

function hasExplicitExecutionPlan(text) {
  const t = String(text || '').trim();
  if (!t) return false;
  const hasWhen = /今天|明天|后天|本周|下周|\d{1,2}[点时:\-]\d{0,2}|\d{4}-\d{2}-\d{2}|周[一二三四五六日天]/.test(t);
  const hasWho = /负责人|谁负责|由.+负责|店长|营运|出品|前厅|我负责|我们负责/.test(t);
  const hasHow = /步骤|执行|安排|方案|做法|动作|先.*再|落地|推进/.test(t);
  const hasGoal = /目标|达到|提升|降低|完成|转化|营收|客流|毛利|差评|复购|核销/.test(t);
  return hasWhen && hasWho && hasHow && hasGoal;
}

function buildPllmReminderCard(task, remindSeq) {
  const title = String(task.title || '').slice(0, 80) || 'PLLM智能经营助手';
  const store = String(task.store || '').trim();
  const taskId = String(task.task_id || '').trim();
  const deadline = new Date(Date.now() + DAY_MS).toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    hour12: false,
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  });
  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: `📌 PLLM智能经营助手 · 跟踪 ${remindSeq}/3` },
      template: remindSeq >= 3 ? 'red' : 'orange'
    },
    elements: [
      { tag: 'div', text: { tag: 'lark_md', content: `**门店**：${store}\n**任务**：${title}\n**任务ID**：${taskId}` } },
      { tag: 'hr' },
      {
        tag: 'div',
        text: {
          tag: 'lark_md',
          content:
            `请补充明确执行计划（四要素必须完整）：\n` +
            `1) 什么时候做\n2) 具体怎么做\n3) 谁负责\n4) 目标是什么\n\n` +
            `截止：${deadline}\n` +
            `若连续 3 天提醒后仍未提供明确计划，系统将标记该 PLLM 任务失败并计入月报。`
        }
      }
    ]
  };
}

async function patchTaskSourceData(taskId, patchObj) {
  await query(
    `UPDATE master_tasks
     SET source_data = COALESCE(source_data, '{}'::jsonb) || $2::jsonb,
         updated_at = NOW()
     WHERE task_id = $1`,
    [taskId, JSON.stringify(patchObj)]
  );
}

export async function applyPllmDecision(taskId, decision, operator, planText = '') {
  const t = await query(`SELECT * FROM master_tasks WHERE task_id = $1 LIMIT 1`, [taskId]);
  const task = t.rows?.[0];
  if (!task) return { ok: false, error: 'task_not_found' };
  if (String(task.source || '') !== 'proactive_llm') return { ok: false, error: 'not_pllm_task' };
  if (['closed', 'settled'].includes(String(task.status || ''))) return { ok: false, error: 'task_already_closed' };
  const op = String(operator || '').trim() || 'unknown';
  const d = String(decision || '').trim().toLowerCase();

  if (d === 'not_suitable') {
    const tr = await transitionTask(taskId, 'closed', 'pllm_workflow', {
      resolutionCode: 'pllm_not_suitable',
      responseText: String(planText || '').trim()
    }).catch(() => null);
    if (!tr?.ok) {
      await query(
        `UPDATE master_tasks
         SET status = 'closed',
             closed_at = NOW(),
             updated_at = NOW(),
             resolution_code = 'pllm_not_suitable',
             response_text = COALESCE(NULLIF($2, ''), response_text)
         WHERE task_id = $1`,
        [taskId, String(planText || '').trim()]
      );
    }
    await patchTaskSourceData(taskId, {
      pllm_decision: 'not_suitable',
      pllm_tracking_enabled: false,
      pllm_decision_at: nowIso(),
      pllm_decision_by: op
    });
    await query(
      `INSERT INTO master_events (task_id, event_type, from_agent, to_agent, status_before, status_after, payload)
       VALUES ($1, 'pllm_decision_not_suitable', $2, 'pllm_workflow', $3, 'closed', $4::jsonb)`,
      [taskId, op, String(task.status || ''), JSON.stringify({ decision: 'not_suitable', by: op })]
    ).catch(() => {});
    return { ok: true, taskId, decision: 'not_suitable', closed: true };
  }

  if (d === 'execute') {
    const tr = await transitionTask(taskId, 'pending_response', 'pllm_workflow', {
      responseText: String(planText || '').trim()
    }).catch(() => null);
    if (!tr?.ok) {
      await query(
        `UPDATE master_tasks
         SET status = 'pending_response',
             updated_at = NOW(),
             response_text = COALESCE(NULLIF($2, ''), response_text)
         WHERE task_id = $1`,
        [taskId, String(planText || '').trim()]
      );
    }
    await patchTaskSourceData(taskId, {
      pllm_decision: 'execute',
      pllm_tracking_enabled: true,
      pllm_tracking_started_at: nowIso(),
      pllm_decision_at: nowIso(),
      pllm_decision_by: op,
      pllm_remind_count: 0,
      pllm_last_reminder_at: null
    });
    await query(
      `INSERT INTO master_events (task_id, event_type, from_agent, to_agent, status_before, status_after, payload)
       VALUES ($1, 'pllm_decision_execute', $2, 'pllm_workflow', $3, 'pending_response', $4::jsonb)`,
      [taskId, op, String(task.status || ''), JSON.stringify({ decision: 'execute', by: op })]
    ).catch(() => {});
    return { ok: true, taskId, decision: 'execute', tracking: true };
  }

  return { ok: false, error: 'invalid_decision' };
}

async function finalizePllmTaskAsFailed(task, reason) {
  const sd = parseSourceData(task.source_data);
  const failCount = Number(sd?.pllm_fail_count_total || 0) + 1;
  const tr = await transitionTask(task.task_id, 'closed', 'pllm_workflow', {
    resolutionCode: 'pllm_failed_no_plan'
  }).catch(() => null);
  if (!tr?.ok) {
    await query(
      `UPDATE master_tasks
       SET status = 'closed',
           closed_at = NOW(),
           updated_at = NOW(),
           resolution_code = 'pllm_failed_no_plan'
       WHERE task_id = $1`,
      [task.task_id]
    );
  }
  await patchTaskSourceData(task.task_id, {
    pllm_tracking_enabled: false,
    pllm_failed_at: nowIso(),
    pllm_fail_reason: reason || 'no_explicit_plan_after_3_reminders',
    pllm_fail_count_total: failCount
  });
  await query(
    `INSERT INTO master_events (task_id, event_type, from_agent, to_agent, status_before, status_after, payload)
     VALUES ($1, 'pllm_failed', 'pllm_workflow', 'pllm_workflow', $2, 'closed', $3::jsonb)`,
    [task.task_id, String(task.status || ''), JSON.stringify({ reason, failCount })]
  ).catch(() => {});
}

export async function processPllmWorkflowTick() {
  const r = await query(
    `SELECT task_id, status, source, title, store, source_data, response_text, assignee_username
     FROM master_tasks
     WHERE source = 'proactive_llm'
       AND status IN ('pending_response', 'pending_review')
       AND COALESCE(source_data->>'pllm_tracking_enabled', 'false') = 'true'
     ORDER BY created_at DESC
     LIMIT 300`
  );
  const tasks = r.rows || [];
  const now = Date.now();
  let reminded = 0;
  let failed = 0;
  let completedByPlan = 0;

  for (const task of tasks) {
    const sd = parseSourceData(task.source_data);
    const decision = String(sd?.pllm_decision || '').trim();
    if (decision !== 'execute') continue;
    const rt = String(task.response_text || '').trim();
    if (hasExplicitExecutionPlan(rt)) {
      const tr = await transitionTask(task.task_id, 'resolved', 'pllm_workflow', {
        resolutionCode: 'pllm_plan_submitted'
      }).catch(() => null);
      if (!tr?.ok) {
        await query(
          `UPDATE master_tasks
           SET status = 'resolved',
               resolved_at = NOW(),
               updated_at = NOW(),
               resolution_code = 'pllm_plan_submitted'
           WHERE task_id = $1`,
          [task.task_id]
        );
      }
      await patchTaskSourceData(task.task_id, {
        pllm_tracking_enabled: false,
        pllm_plan_submitted_at: nowIso(),
        pllm_plan_quality: 'explicit'
      });
      completedByPlan += 1;
      continue;
    }

    const remindCount = Number(sd?.pllm_remind_count || 0);
    const lastReminderAt = sd?.pllm_last_reminder_at ? new Date(sd.pllm_last_reminder_at).getTime() : 0;
    const due = remindCount === 0 ? true : now >= lastReminderAt + DAY_MS;
    if (!due) continue;

    if (remindCount >= 3) {
      await finalizePllmTaskAsFailed(task, 'no_explicit_plan_after_3_daily_reminders');
      failed += 1;
      continue;
    }

    const recipients = await resolvePllmRecipientsFromTask(task);
    if (!recipients.length) continue;
    const seq = remindCount + 1;
    const card = buildPllmReminderCard(task, seq);
    const fallback = `【PLLM 跟踪提醒 ${seq}/3】请补充执行计划：什么时候、怎么做、谁负责、目标是什么。任务ID：${task.task_id}`;
    for (const oid of recipients) {
      const rs = await sendCard(oid, card).catch(() => ({ ok: false }));
      if (!rs?.ok) await sendText(oid, fallback, 'open_id').catch(() => {});
    }
    await patchTaskSourceData(task.task_id, {
      pllm_remind_count: seq,
      pllm_last_reminder_at: nowIso()
    });
    reminded += 1;
  }
  return { scanned: tasks.length, reminded, failed, completedByPlan };
}

async function ensureMonthlyReportLogTable() {
  await query(`
    CREATE TABLE IF NOT EXISTS agent_v2_pllm_monthly_report_log (
      report_month VARCHAR(7) PRIMARY KEY,
      sent_at TIMESTAMPTZ DEFAULT NOW(),
      recipient_count INT DEFAULT 0,
      sent_count INT DEFAULT 0
    )`);
}

function prevMonthYm(nowYmd) {
  const d = new Date(`${nowYmd}T12:00:00+08:00`);
  d.setUTCMonth(d.getUTCMonth() - 1);
  return d.toLocaleString('en-CA', { timeZone: 'Asia/Shanghai' }).slice(0, 7);
}

export async function sendPllmMonthlyReportIfDue() {
  return sendPllmMonthlyReport({ force: false });
}

export async function sendPllmMonthlyReport({ force = false } = {}) {
  const ymd = shanghaiYmd();
  if (!/\d{4}-\d{2}-01/.test(ymd) && !force) return { skipped: 'not_month_first' };
  const { hh, mm } = shanghaiHm();
  if (!force) {
    const inWindow = hh === 9 && mm >= 45 && mm <= 49;
    if (!inWindow) return { skipped: 'not_0945_window', now: `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}` };
  }
  const month = prevMonthYm(ymd);
  await ensureMonthlyReportLogTable();
  const already = await query(`SELECT 1 FROM agent_v2_pllm_monthly_report_log WHERE report_month = $1 LIMIT 1`, [month]);
  if (already.rows?.length) return { skipped: 'already_sent', month };

  const stat = await query(
    `SELECT
       COUNT(*)::int AS total,
       COUNT(*) FILTER (WHERE COALESCE(source_data->>'pllm_decision','') = 'execute')::int AS execute_count,
       COUNT(*) FILTER (WHERE resolution_code = 'pllm_not_suitable')::int AS not_suitable_count,
       COUNT(*) FILTER (WHERE resolution_code = 'pllm_failed_no_plan')::int AS failed_count,
       COUNT(*) FILTER (WHERE resolution_code = 'pllm_plan_submitted')::int AS plan_submitted_count,
       COUNT(*) FILTER (WHERE status NOT IN ('closed','settled','resolved'))::int AS open_count
     FROM master_tasks
     WHERE source = 'proactive_llm'
       AND to_char(created_at AT TIME ZONE 'Asia/Shanghai', 'YYYY-MM') = $1`,
    [month]
  );
  const s = stat.rows?.[0] || {};
  const byStoreR = await query(
    `SELECT COALESCE(NULLIF(trim(store), ''), '未标注门店') AS store,
            COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE COALESCE(source_data->>'pllm_decision','') = 'execute')::int AS execute_count,
            COUNT(*) FILTER (WHERE resolution_code = 'pllm_plan_submitted')::int AS plan_submitted_count,
            COUNT(*) FILTER (WHERE resolution_code = 'pllm_not_suitable')::int AS not_suitable_count,
            COUNT(*) FILTER (WHERE resolution_code = 'pllm_failed_no_plan')::int AS failed_count,
            COUNT(*) FILTER (WHERE status NOT IN ('closed','settled','resolved'))::int AS open_count
     FROM master_tasks
     WHERE source = 'proactive_llm'
       AND to_char(created_at AT TIME ZONE 'Asia/Shanghai', 'YYYY-MM') = $1
     GROUP BY 1
     ORDER BY total DESC, store ASC
     LIMIT 50`,
    [month]
  );
  const byStore = byStoreR.rows || [];
  const msg = [
    `📊【PLLM任务月报】${month}`,
    `总任务数：${Number(s.total || 0)}`,
    `选择执行：${Number(s.execute_count || 0)}`,
    `计划已提交（明确计划）：${Number(s.plan_submitted_count || 0)}`,
    `不适合（自动结束）：${Number(s.not_suitable_count || 0)}`,
    `失败（3天仍无明确计划）：${Number(s.failed_count || 0)}`,
    `当前未结束：${Number(s.open_count || 0)}`,
    '',
    '【门店细分】',
    ...byStore.map((x) =>
      `• ${x.store}｜总${x.total}｜执行${x.execute_count}｜已提交${x.plan_submitted_count}｜不适合${x.not_suitable_count}｜失败${x.failed_count}｜未结束${x.open_count}`
    )
  ].join('\n');

  const rr = await query(
    `SELECT open_id, role, username FROM feishu_users
     WHERE registered = true
       AND role IN ('admin','hq_manager')
       AND open_id IS NOT NULL AND trim(open_id) <> '' AND open_id NOT LIKE '%probe%'
     ORDER BY role = 'admin' DESC, updated_at DESC NULLS LAST`
  );
  const rows = rr.rows || [];
  const admin = rows.find((x) => String(x.role || '') === 'admin');
  const hq = rows.find((x) => String(x.role || '') === 'hq_manager');
  const recipients = [admin, hq]
    .filter(Boolean)
    .map((x) => String(x.open_id || '').trim())
    .filter(Boolean);
  let sent = 0;
  for (const oid of recipients) {
    const r0 = await sendText(oid, msg, 'open_id').catch(() => ({ ok: false }));
    if (r0?.ok) sent += 1;
  }

  await query(
    `INSERT INTO agent_v2_pllm_monthly_report_log (report_month, recipient_count, sent_count)
     VALUES ($1, $2, $3)
     ON CONFLICT (report_month) DO NOTHING`,
    [month, recipients.length, sent]
  );
  return { month, recipientCount: recipients.length, sentCount: sent, storeCount: byStore.length };
}

