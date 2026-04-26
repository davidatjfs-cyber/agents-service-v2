/**
 * Proactive LLM 行动落地：等价于用户执行「接受行动计划」——写入 master_tasks + 记忆/经验，供后续排序降权。
 */

import { query } from '../../utils/db.js';
import { logger } from '../../utils/logger.js';
import { getBrandForStore } from '../config-service.js';
import { getStoreProfileAsync } from '../../config/store-profile.js';
import { saveOutcome } from '../agent-memory.js';
import { getProactiveConfig } from './config.js';
import { sendCard, sendText } from '../feishu-client.js';

/** 与异常类型绑定的经营指标维度（内部存英文键，便于查询/记忆标签） */
export function inferMetricFocus(anomalyType) {
  const t = String(anomalyType || '').toLowerCase();
  if (/revenue|recharge|achievement|margin|gross/.test(t)) return 'revenue';
  if (/traffic|flow|customer_flow|客流/.test(t)) return 'traffic';
  if (/review|bad_review|投诉|转化|核销|券/.test(t)) return 'conversion';
  return 'mixed';
}

/** 卡片与详情展示用中文指标名 */
export function metricFocusLabelZh(metricKey) {
  const k = String(metricKey || '').toLowerCase();
  if (k === 'revenue') return '营收与毛利/实收';
  if (k === 'traffic') return '客流与到店';
  if (k === 'conversion') return '转化与体验（点评/核销等）';
  if (k === 'mixed') return '综合经营';
  return metricKey || '综合经营';
}

/** LLM 常输出重复条；按「去编号、去空白、小写」去重，保证一种建议只发一条 */
export function dedupeActionLines(actions) {
  if (!Array.isArray(actions)) return [];
  const seen = new Set();
  const out = [];
  for (const raw of actions) {
    const line = String(raw || '').trim();
    if (!line) continue;
    const key = line
      .replace(/^\s*[\d０-９]+[\.)．、]\s*/, '')
      .replace(/\s+/g, ' ')
      .toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(line);
  }
  return out;
}

function qualityTokensFromProfile(profile = {}) {
  const tokens = [];
  const brand = String(profile.brand || '').trim();
  const positioning = String(profile.positioning || '').trim();
  const strategy = String(profile.coreStrategy || '').trim();
  if (brand) tokens.push(brand);
  if (positioning) tokens.push(positioning);
  if (strategy) tokens.push(strategy);
  for (const d of profile.topDishes || []) {
    const name = String(d?.name || '').trim();
    if (name) tokens.push(name);
  }
  return tokens.filter(Boolean);
}

export function scoreActionQuality(line, ctx = {}) {
  const s = String(line || '').trim();
  if (!s) return 0;
  let score = 0;
  const metric = String(ctx.metricFocus || '').toLowerCase();
  const avgPrice = Number(ctx.profile?.avgPrice || 0);
  const hasTakeout = !!ctx.profile?.hasTakeout;
  const tokens = qualityTokensFromProfile(ctx.profile);

  if (/\d/.test(s)) score += 2;
  if (/元|折|%|分钟|小时|天|周|单|份|桌|次|券|核销|曝光|转化|客流|毛利|营收|复购/.test(s)) score += 2;
  if (/今天|明天|本周|下周|午市|晚市|闭店|开档|门店|社群|美团|抖音|点评|企微/.test(s)) score += 1;
  if (/谁|负责人|店长|出品|营运|前厅|后厨|由.+负责/.test(s)) score += 1;
  if (/优化服务|提升体验|加强管理|改善品质|做好培训|提高人效/.test(s)) score -= 3;

  if (metric === 'revenue' && /(营收|客单|毛利|套餐|定价|加价|折扣)/.test(s)) score += 2;
  if (metric === 'traffic' && /(客流|曝光|引流|到店|核销|社群|投放)/.test(s)) score += 2;
  if (metric === 'conversion' && /(转化|复购|点评|差评|会员|核销|体验)/.test(s)) score += 2;

  if (avgPrice >= 180) {
    if (/(包房|宴请|高客单|品质|酒水|菜品结构)/.test(s)) score += 2;
    if (/(9\.9|19\.9|低价秒杀|地推小卡)/.test(s)) score -= 2;
  } else if (avgPrice > 0) {
    if (/(套餐|团购|券|核销|翻台|午市|引流)/.test(s)) score += 2;
  }
  if (hasTakeout && /(外卖|平台|打包|配送)/.test(s)) score += 1;
  if (!hasTakeout && /(外卖|配送)/.test(s)) score -= 1;

  if (tokens.some((t) => s.includes(t))) score += 1;
  return score;
}

export function filterQualityActions(actions, ctx = {}) {
  const scored = (actions || [])
    .map((line) => ({ line, score: scoreActionQuality(line, ctx) }))
    .filter((x) => x.score >= 4)
    .sort((a, b) => b.score - a.score);
  const unique = [];
  const seen = new Set();
  for (const x of scored) {
    const k = String(x.line || '').trim();
    if (!k || seen.has(k)) continue;
    seen.add(k);
    unique.push(k);
  }
  return unique;
}

function priorityToInitialScore(priority) {
  const p = String(priority || 'medium').toLowerCase();
  if (p === 'high') return 7;
  if (p === 'low') return 5;
  return 6;
}

function isProactivePllmCreateEnabled() {
  const v = String(process.env.PROACTIVE_PLLM_CREATE_ENABLED || '').trim().toLowerCase();
  if (!v) return true; // 默认开启；由职责策略保证仅管理员+总部营运接收
  return ['1', 'true', 'yes', 'on'].includes(v);
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

async function resolveAdminAssignees() {
  try {
    const r = await query(
      `SELECT DISTINCT ON (lower(trim(username)))
         username, role
       FROM feishu_users
       WHERE registered = true
         AND role = 'admin'
         AND username IS NOT NULL
         AND trim(username) <> ''
       ORDER BY lower(trim(username)), updated_at DESC NULLS LAST`
    );
    const rows = Array.isArray(r.rows) ? r.rows : [];
    return rows.map((x) => ({
      username: String(x.username || '').trim(),
      role: String(x.role || 'admin').trim() || 'admin'
    })).filter((x) => x.username);
  } catch (e) {
    logger.warn({ err: e?.message }, 'proactive-llm-actions: resolveAdminAssignees failed');
    return [];
  }
}

async function resolvePllmResponsibles() {
  try {
    const r = await query(
      `SELECT DISTINCT ON (lower(trim(username)))
         username, role, open_id
       FROM feishu_users
       WHERE registered = true
         AND role IN ('admin', 'hq_manager')
         AND username IS NOT NULL
         AND trim(username) <> ''
         AND open_id IS NOT NULL
         AND trim(open_id) <> ''
         AND open_id NOT LIKE '%probe%'
       ORDER BY lower(trim(username)), updated_at DESC NULLS LAST`
    );
    const rows = Array.isArray(r.rows) ? r.rows : [];
    return rows
      .map((x) => ({
        username: String(x.username || '').trim(),
        role: String(x.role || '').trim(),
        open_id: String(x.open_id || '').trim()
      }))
      .filter((x) => x.username && x.role && x.open_id);
  } catch (e) {
    logger.warn({ err: e?.message }, 'proactive-llm-actions: resolvePllmResponsibles failed');
    return [];
  }
}

async function rerouteOpenProactiveTasksToAdmin(primaryAdminUsername, responsibles = []) {
  const target = String(primaryAdminUsername || '').trim();
  if (!target) return { updated: 0 };
  const usernames = responsibles.map((x) => String(x.username || '').trim()).filter(Boolean);
  const openIds = responsibles.map((x) => String(x.open_id || '').trim()).filter(Boolean);
  try {
    const r = await query(
      `UPDATE master_tasks
       SET assignee_username = $1,
           assignee_role = 'admin',
           updated_at = NOW(),
           source_data = COALESCE(source_data, '{}'::jsonb) || $2::jsonb
       WHERE source = 'proactive_llm'
         AND status IN ('pending_response','pending_review','pending_dispatch','dispatched','escalated')
         AND COALESCE(trim(assignee_username), '') <> trim($1)`,
      [
        target,
        JSON.stringify({
          reassigned_to_admin: true,
          reassigned_at: new Date().toISOString(),
          reassigned_reason: 'suppress_store_disturbance',
          pllm_responsible_usernames: usernames,
          assignee_open_ids: openIds,
          pllm_mode: 'shared_admin_hq'
        })
      ]
    );
    return { updated: Number(r.rowCount || 0), usernames, openIds };
  } catch (e) {
    logger.warn({ err: e?.message }, 'proactive-llm-actions: rerouteOpenProactiveTasksToAdmin failed');
    return { updated: 0, usernames, openIds };
  }
}

function buildPllmDecisionCard({ taskId, store, title, line, metricFocusZh }) {
  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: '🧭 PLLM智能经营助手' },
      template: 'blue'
    },
    elements: [
      {
        tag: 'div',
        text: {
          tag: 'lark_md',
          content:
            `**门店**：${store}\n` +
            `**任务ID**：${taskId}\n` +
            `**任务标题**：${title}\n` +
            `**建议动作**：${line}\n` +
            `**指标侧重**：${metricFocusZh}`
        }
      },
      { tag: 'hr' },
      {
        tag: 'div',
        text: {
          tag: 'lark_md',
          content:
            '请先选择（手机点按钮即可，与食安任务卡一致）：\n' +
            '· **执行** → 进入跟踪模式（每日提醒，最多 3 天）\n' +
            '· **不适合** → 自动结束并计入月报\n\n' +
            '管理员与总部营运任一人操作即可。仍可在对话中回复「执行」「不适合」作为备选。'
        }
      },
      {
        tag: 'action',
        actions: [
          {
            tag: 'input',
            name: 'pllm_execute_plan',
            placeholder: {
              tag: 'plain_text',
              content: '点击「执行」前请填写：执行计划（何时/谁负责/怎么做/目标）'
            }
          },
          {
            tag: 'input',
            name: 'pllm_not_suitable_reason',
            placeholder: {
              tag: 'plain_text',
              content: '点击「不适合」前请填写：不适合原因（可执行性/门店定位/时机）'
            }
          },
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '执行' },
            type: 'primary',
            value: JSON.stringify({ action: 'pllm_execute', taskId })
          },
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '不适合' },
            type: 'default',
            value: JSON.stringify({ action: 'pllm_not_suitable', taskId })
          }
        ]
      }
    ]
  };
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
  const proactiveCfg = await getProactiveConfig().catch(() => ({}));
  const assigneeEnabled = proactiveCfg?.dispatchDefaults?.assignee !== false;

  const responsibles = await resolvePllmResponsibles();
  const primaryAdmin = responsibles.find((x) => x.role === 'admin') || responsibles[0] || null;
  if (!primaryAdmin?.username || !responsibles.length) {
    logger.warn({ store }, 'proactive-llm-actions: no admin/hq responsible found, skip PLLM task creation');
    return { ok: false, error: 'no_admin_or_hq_responsible', createdTasks: [] };
  }
  const responsibleUsernames = responsibles.map((x) => x.username);
  const responsibleOpenIds = responsibles.map((x) => x.open_id);

  const rerouteRes = await rerouteOpenProactiveTasksToAdmin(primaryAdmin.username, responsibles);
  const rerouted = rerouteRes.updated;
  if (rerouted > 0) {
    logger.warn(
      { rerouted, to: primaryAdmin.username },
      'proactive-llm-actions: rerouted open proactive_llm tasks to admin'
    );
  }

  if (!assigneeEnabled) {
    logger.info({ store, admin: primaryAdmin.username }, 'proactive-llm-actions: assignee dispatch disabled by config; only reroute existing tasks');
    return { ok: true, createdTasks: [], count: 0, rerouted };
  }
  if (!isProactivePllmCreateEnabled()) {
    logger.warn(
      { store, admin: primaryAdmin.username },
      'proactive-llm-actions: PLLM auto task creation paused; only reroute existing tasks to admin'
    );
    return { ok: true, createdTasks: [], count: 0, rerouted, paused: true };
  }

  const deduped = dedupeActionLines(actions);
  const metricZh = metricFocusLabelZh(metricFocus);
  const profile = await getStoreProfileAsync(store).catch(() => null);
  const qualityFiltered = filterQualityActions(deduped, { metricFocus, profile });
  const finalActions = qualityFiltered.length ? qualityFiltered : deduped;

  console.log('[Proactive][accept_action_plan] auto (proactive_llm)', {
    store,
    nIn: actions.length,
    nDeduped: deduped.length,
    nQuality: qualityFiltered.length,
    metricFocus
  });

  const createdTasks = [];

  async function runPlanBatch(targetStore, targetBrand, lines) {
    const capped = lines;
    const storeSlug = String(targetStore || 'st').replace(/[^\w\u4e00-\u9fff]/g, '').slice(0, 12) || 'st';
    for (let i = 0; i < capped.length; i++) {
      const line = String(capped[i] || '').trim();
      if (!line) continue;
      const dup = await query(
        `SELECT 1
         FROM master_tasks
         WHERE source = 'proactive_llm'
           AND store = $1
           AND status IN ('pending_response','pending_review','pending_dispatch','dispatched','escalated')
           AND COALESCE(source_data->>'original_line','') = $2
         LIMIT 1`,
        [targetStore, line]
      ).catch(() => ({ rows: [] }));
      if (dup.rows?.length) continue;

      const assigneeUsername = primaryAdmin.username;
      const assigneeRoleValue = 'admin';
      const userSlug = assigneeUsername.replace(/[^a-zA-Z0-9]/g, '').slice(0, 24) || `admin`;
      const taskId = `PLLM-${nowStr.replace(/-/g, '')}-${String(i + 1).padStart(2, '0')}-${storeSlug}-${userSlug}-${Math.random().toString(36).slice(2, 8)}`;
      const timeoutAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
      const title = `${targetStore} · Proactive行动${i + 1}：${line.slice(0, 56)}`;

      const sourceData = {
        source: 'proactive_llm',
        accept_action_plan: true,
        metric_focus: metricFocus,
        metric_focus_zh: metricZh,
        planned_at: plannedAt,
        due_at: timeoutAt.toISOString(),
        anomaly_type: anomalyType,
        llm_priority: llmPriority,
        action_index: i,
        original_line: line,
        assigned_scope: 'admin_only',
        assigned_policy: 'shared_admin_hq',
        assignee_open_ids: responsibleOpenIds,
        pllm_responsible_usernames: responsibleUsernames,
        pllm_responsible_roles: responsibles.map((x) => x.role),
        pllm_mode: 'shared_admin_hq',
        pllm_decision: 'pending',
        pllm_tracking_enabled: false,
        pllm_remind_count: 0,
        pllm_trigger_data: {
          rule: String(ctx?.type || ctx?.data?.type || ctx?.data?.rule || ''),
          severity: String(ctx?.severity || ''),
          detail: String(ctx?.data?.detail || '').slice(0, 800),
          value: ctx?.data?.value ?? null
        }
      };

      const detailLines = [
        '来源：Proactive LLM 自动接受行动计划',
        `触发异常：${String(ctx?.type || ctx?.data?.type || ctx?.data?.rule || 'unknown')}`,
        `指标侧重：${metricZh}（${metricFocus}）`,
        `计划时间：${plannedAt}`,
        `原始动作：${line}`,
        '责任人策略：仅管理员（避免门店骚扰）'
      ];

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
          targetStore,
          targetBrand,
          assigneeUsername,
          assigneeRoleValue,
          title,
          detailLines.join('\n'),
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
        metricFocus,
        store: targetStore
      });

      const decisionCard = buildPllmDecisionCard({
        taskId,
        store: targetStore,
        title,
        line,
        metricFocusZh: metricZh
      });
      for (const oid of responsibleOpenIds) {
        const r0 = await sendCard(oid, decisionCard).catch(() => ({ ok: false }));
        if (!r0?.ok) {
          await sendText(
            oid,
            `【PLLM智能经营助手】${targetStore}\n任务ID：${taskId}\n动作：${line}\n请在手机点卡片按钮「执行 / 不适合」，或回复这两词之一。`,
            'open_id'
          ).catch(() => {});
        }
      }

      const outcomeScore = Math.min(
        10,
        Math.max(1, Math.round((baseScore + (capped.length - 1 - i) * 0.15) * 10) / 10)
      );
      await saveOutcome(
        'proactive_llm',
        targetStore,
        line,
        'plan_dispatched',
        outcomeScore,
        {
          tags: [
            'proactive_llm',
            `store:${targetStore}`,
            `metric:${metricFocus}`,
            `anomaly:${anomalyType}`,
            `task_id:${taskId}`,
            'assignee:admin_only'
          ]
        }
      ).catch(() => {});
    }
  }

  await runPlanBatch(store, brand, finalActions);

  const planBody = finalActions.map((l, j) => `${j + 1}. ${l}`).join('\n');
  await logProactiveDecision({
    store,
    brand,
    title: `Proactive LLM 行动计划 ${nowStr}`,
    content: planBody.slice(0, 4000)
  });

  return { ok: true, createdTasks, count: createdTasks.length, rerouted };
}
