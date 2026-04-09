/**
 * Proactive LLM 行动落地：等价于用户执行「接受行动计划」——写入 master_tasks + 记忆/经验，供后续排序降权。
 */

import { query } from '../../utils/db.js';
import { logger } from '../../utils/logger.js';
import { getBrandForStore } from '../config-service.js';
import { saveOutcome } from '../agent-memory.js';

/** 与异常类型绑定的经营指标维度 */
export function inferMetricFocus(anomalyType) {
  const t = String(anomalyType || '').toLowerCase();
  if (/revenue|recharge|achievement|margin|gross/.test(t)) return 'revenue';
  if (/traffic|flow|customer_flow|客流/.test(t)) return 'traffic';
  if (/review|bad_review|投诉|转化|核销|券/.test(t)) return 'conversion';
  return 'mixed';
}

function priorityToInitialScore(priority) {
  const p = String(priority || 'medium').toLowerCase();
  if (p === 'high') return 7;
  if (p === 'low') return 5;
  return 6;
}

async function logProactiveDecision({ store, brand, title, content }) {
  try {
    await query(
      `INSERT INTO decision_log (store, brand, decision_type, title, content, agent, source_task_id, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        store,
        brand || '',
        'proactive_llm',
        title,
        content,
        'accept_action_plan',
        '',
        'proactive_llm'
      ]
    );
  } catch (e) {
    logger.warn({ err: e?.message }, 'proactive-llm-actions: logProactiveDecision failed');
  }
}

/**
 * 自动「接受行动计划」：为每条 llm action 建 master_task（source=proactive_llm），并 saveOutcome 写入排序依据。
 * 行为对齐 agent-handlers handleAcceptActionPlan 的建任务逻辑，数据源改为 ctx.data.llmActions。
 */
export async function acceptProactiveLlmActionPlan(ctx) {
  const store = String(ctx?.store || '').trim();
  const actions = ctx?.data?.llmActions;
  if (!store || !Array.isArray(actions) || actions.length === 0) {
    return { ok: false, error: 'missing_store_or_actions', createdTasks: [] };
  }

  const brand = (await getBrandForStore(store).catch(() => null)) || '';
  const anomalyType = String(ctx?.type || ctx?.data?.type || ctx?.data?.rule || 'unknown');
  const metricFocus = inferMetricFocus(anomalyType);
  const llmPriority = String(ctx?.data?.llmPriority || 'medium');
  const plannedAt = new Date().toISOString();
  const nowStr = new Date().toLocaleString('en-CA', { timeZone: 'Asia/Shanghai' }).slice(0, 10);
  const baseScore = priorityToInitialScore(llmPriority);

  console.log('[Proactive][accept_action_plan] auto (proactive_llm)', {
    store,
    n: actions.length,
    metricFocus
  });

  const createdTasks = [];
  const capped = actions.slice(0, 5);

  for (let i = 0; i < capped.length; i++) {
    const line = String(capped[i] || '').trim();
    if (!line) continue;

    const isProductionTask = /(出品|厨房|后厨|食材|菜品|出品经理)/.test(line);
    const assigneeRole = isProductionTask ? 'store_production_manager' : 'store_manager';

    const staffR = await query(
      `SELECT username, role FROM feishu_users WHERE registered = true AND store = $1 AND role = $2`,
      [store, assigneeRole]
    ).catch(() => ({ rows: [] }));

    if (!staffR.rows?.length) {
      logger.warn({ store, assigneeRole, i }, 'proactive-llm-actions: no staff for action line');
      continue;
    }

    let staffSeq = 0;
    for (const staff of staffR.rows) {
      const assigneeUsername = String(staff.username || '').trim();
      const assigneeRoleValue = staff.role || assigneeRole;
      staffSeq += 1;
      const userSlug = assigneeUsername.replace(/[^a-zA-Z0-9]/g, '').slice(0, 24) || `u${staffSeq}`;
      const taskId = `PLLM-${nowStr.replace(/-/g, '')}-${String(i + 1).padStart(2, '0')}-${userSlug}-${Math.random().toString(36).slice(2, 6)}`;
      const timeoutAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
      const title = `${store} · Proactive行动${i + 1}：${line.slice(0, 56)}`;

      const sourceData = {
        source: 'proactive_llm',
        accept_action_plan: true,
        metric_focus: metricFocus,
        planned_at: plannedAt,
        due_at: timeoutAt.toISOString(),
        anomaly_type: anomalyType,
        llm_priority: llmPriority,
        action_index: i,
        original_line: line
      };

      await query(
        `INSERT INTO master_tasks
           (task_id, status, source, category, store, brand, assignee_username, assignee_role,
            title, detail, source_data, feishu_msg_ids, dispatched_at, timeout_at, remind_count)
         VALUES
           ($1, 'pending_response', $2, 'action_plan', $3, $4, $5, $6,
            $7, $8, $9::jsonb, '[]'::jsonb, NOW(), $10, 0)
         ON CONFLICT (task_id) DO NOTHING`,
        [
          taskId,
          'proactive_llm',
          store,
          brand,
          assigneeUsername,
          assigneeRoleValue,
          title,
          `来源：Proactive LLM 自动接受行动计划\n指标侧重：${metricFocus}\n计划时间：${plannedAt}\n原始动作：${line}`,
          JSON.stringify(sourceData),
          timeoutAt.toISOString()
        ]
      ).catch((e) => {
        logger.warn({ err: e?.message, taskId }, 'proactive-llm-actions: master_tasks insert failed');
      });

      createdTasks.push({
        taskId,
        title: line.slice(0, 80),
        role: assigneeRoleValue,
        assigneeUsername,
        metricFocus
      });

      const outcomeScore = Math.min(
        10,
        Math.max(1, Math.round((baseScore + (capped.length - 1 - i) * 0.15) * 10) / 10)
      );
      await saveOutcome(
        'proactive_llm',
        store,
        line,
        'plan_dispatched',
        outcomeScore,
        {
          tags: [
            'proactive_llm',
            `store:${store}`,
            `metric:${metricFocus}`,
            `anomaly:${anomalyType}`,
            `task_id:${taskId}`
          ]
        }
      ).catch(() => {});
    }
  }

  const planBody = capped.map((l, j) => `${j + 1}. ${l}`).join('\n');
  await logProactiveDecision({
    store,
    brand,
    title: `Proactive LLM 行动计划 ${nowStr}`,
    content: planBody.slice(0, 4000)
  });

  return { ok: true, createdTasks, count: createdTasks.length };
}
