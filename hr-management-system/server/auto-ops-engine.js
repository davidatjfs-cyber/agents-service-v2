// ─────────────────────────────────────────────────────────────────
// Auto-Ops Engine — 自动化营运引擎
// ─────────────────────────────────────────────────────────────────
//
// 4大自动化能力:
//   1. 巡检闭环 (Inspection Closed Loop)   — 超时催办 + 自动升级 + Vision验收
//   2. BI主动推送 (Proactive BI Push)      — 每日关键偏差主动推送责任人
//   3. 排班人效建议 (Labor Efficiency)     — 基于营收趋势的排班优化建议
//   4. 培训闭环 (Training Closed Loop)     — 异常频发 → 自动培训 → 考核追踪
//
// 算力控制:
//   - 巡检闭环: 催办/升级零LLM, Vision验收复用已有能力
//   - BI推送: 零LLM, 纯数据对比
//   - 排班建议: 零LLM, 基于历史数据规则
//   - 培训闭环: 仅生成培训内容时消耗1次LLM
// ─────────────────────────────────────────────────────────────────

import { pool as getUnifiedPool } from './utils/database.js';

let _pool = null;
let _sendLarkMessage = null;
let _sendLarkCard = null;
let _lookupFeishuUser = null;
let _findStoreManager = null;
let _callLLM = null;
let _prefixWithAgentName = null;
let _inferBrandFromStoreName = null;

export function setAutoOpsPool(p) { _pool = p; }
export function setAutoOpsDeps({
  sendLarkMessage, sendLarkCard, lookupFeishuUserByUsername,
  findStoreManager, callLLM, prefixWithAgentName, inferBrandFromStoreName
}) {
  _sendLarkMessage = sendLarkMessage;
  _sendLarkCard = sendLarkCard;
  _lookupFeishuUser = lookupFeishuUserByUsername;
  _findStoreManager = findStoreManager;
  _callLLM = callLLM;
  _prefixWithAgentName = prefixWithAgentName;
  _inferBrandFromStoreName = inferBrandFromStoreName;
}

function pool() { return _pool || getUnifiedPool(); }

// ─────────────────────────────────────────────
// 1. 巡检闭环自动化
// ─────────────────────────────────────────────

const REMINDER_HOURS = 2;    // 2小时未回复 → 催办
const ESCALATE_HOURS = 4;    // 4小时未回复 → 升级上级
const MAX_REMINDERS = 3;     // 最多催办3次

export async function inspectionClosedLoopTick() {
  let actions = 0;

  // ── 1a. 催办: pending_response 超过2小时 ──
  try {
    const r = await pool().query(
      `SELECT t.*, 
              EXTRACT(EPOCH FROM (NOW() - t.dispatched_at))/3600 as hours_waiting,
              COALESCE((t.source_data->>'reminder_count')::int, 0) as reminder_count
       FROM master_tasks t
       WHERE t.status = 'pending_response'
         AND t.dispatched_at < NOW() - INTERVAL '${REMINDER_HOURS} hours'
       ORDER BY t.dispatched_at ASC LIMIT 10`
    );

    for (const task of (r.rows || [])) {
      const reminderCount = parseInt(task.reminder_count || 0);
      const hoursWaiting = parseFloat(task.hours_waiting || 0);

      // ── 升级: 超过4小时未回复 → 通知上级 ──
      if (hoursWaiting >= ESCALATE_HOURS && reminderCount >= 1) {
        await escalateTask(task, hoursWaiting);
        actions++;
        continue;
      }

      // ── 催办: 超过2小时, 未达到最大催办次数 ──
      if (reminderCount < MAX_REMINDERS) {
        await sendReminder(task, reminderCount + 1, hoursWaiting);
        actions++;
      }
    }
  } catch (e) {
    console.error('[auto-ops] inspection reminder error:', e?.message);
  }

  // ── 1b. 自动验收跟踪: 任务resolved后记录闭环时间 ──
  try {
    const resolved = await pool().query(
      `SELECT task_id, dispatched_at, responded_at,
              EXTRACT(EPOCH FROM (responded_at - dispatched_at))/3600 as resolve_hours
       FROM master_tasks
       WHERE status IN ('resolved', 'pending_settlement')
         AND responded_at IS NOT NULL
         AND dispatched_at IS NOT NULL
         AND source_data->>'closed_loop_logged' IS NULL
       LIMIT 10`
    );
    for (const task of (resolved.rows || [])) {
      await pool().query(
        `UPDATE master_tasks SET source_data = COALESCE(source_data, '{}'::jsonb) || $1::jsonb WHERE task_id = $2`,
        [JSON.stringify({ closed_loop_logged: true, resolve_hours: parseFloat(task.resolve_hours || 0).toFixed(1) }), task.task_id]
      );
    }
  } catch (e) {
    console.error('[auto-ops] closed loop log error:', e?.message);
  }

  return actions;
}

async function sendReminder(task, reminderNum, hoursWaiting) {
  if (!task.assignee_username || !_lookupFeishuUser || !_sendLarkCard) return;
  const fu = await _lookupFeishuUser(task.assignee_username);
  if (!fu?.open_id) return;

  const card = {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: `⏰ 催办提醒 (第${reminderNum}次) [${task.task_id}]` },
      template: reminderNum >= 2 ? 'red' : 'orange'
    },
    elements: [
      {
        tag: 'div',
        text: { tag: 'lark_md', content: `**门店**: ${task.store || '-'}\n**异常**: ${task.title || '-'}\n**已等待**: ${hoursWaiting.toFixed(1)}小时\n\n⚠️ 请尽快回复整改说明和照片，超过${ESCALATE_HOURS}小时未回复将自动升级至上级处理。` }
      },
      { tag: 'hr' },
      { tag: 'note', elements: [{ tag: 'plain_text', content: `小年 · 自动催办 · 任务编号 ${task.task_id}` }] }
    ]
  };

  const result = await _sendLarkCard(fu.open_id, card);
  if (result?.ok) {
    await pool().query(
      `UPDATE master_tasks SET source_data = COALESCE(source_data, '{}'::jsonb) || $1::jsonb WHERE task_id = $2`,
      [JSON.stringify({ reminder_count: reminderNum, last_reminder_at: new Date().toISOString() }), task.task_id]
    );
    console.log(`[auto-ops] reminder #${reminderNum} sent for ${task.task_id} to ${task.assignee_username}`);
  }
}

async function escalateTask(task, hoursWaiting) {
  if (!_lookupFeishuUser || !_sendLarkCard || !_findStoreManager) return;

  // 找到上级: 如果当前是出品经理 → 升级到店长; 如果是店长 → 升级到HQ
  let escalateTo = null;
  if (task.assignee_role === 'store_production_manager') {
    escalateTo = await _findStoreManager(task.store);
  }

  // 如果找不到上级或已经是店长, 升级到HQ admin
  if (!escalateTo) {
    try {
      const hqR = await pool().query(
        `SELECT f.open_id, u.username, u.real_name FROM feishu_users f JOIN users u ON f.username = u.username WHERE u.role IN ('admin', 'hq_manager') AND u.is_active = true LIMIT 1`
      );
      if (hqR.rows?.length) {
        escalateTo = { open_id: hqR.rows[0].open_id, username: hqR.rows[0].username, name: hqR.rows[0].real_name };
      }
    } catch (e) {}
  }

  if (!escalateTo?.open_id) return;

  const card = {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: `🔺 任务升级 [${task.task_id}]` },
      template: 'red'
    },
    elements: [
      {
        tag: 'div',
        text: { tag: 'lark_md', content: `**门店**: ${task.store || '-'}\n**异常**: ${task.title || '-'}\n**原责任人**: ${task.assignee_username}\n**已等待**: ${hoursWaiting.toFixed(1)}小时\n\n🔴 该任务超过${ESCALATE_HOURS}小时未得到回复，已自动升级至您处理。\n\n请协调跟进或直接回复整改方案。` }
      },
      { tag: 'hr' },
      { tag: 'note', elements: [{ tag: 'plain_text', content: `小年 · 自动升级 · 原责任人未响应` }] }
    ]
  };

  const result = await _sendLarkCard(escalateTo.open_id, card);
  if (result?.ok) {
    await pool().query(
      `UPDATE master_tasks SET source_data = COALESCE(source_data, '{}'::jsonb) || $1::jsonb WHERE task_id = $2`,
      [JSON.stringify({
        escalated: true,
        escalated_to: escalateTo.username,
        escalated_at: new Date().toISOString(),
        escalate_reason: `超过${hoursWaiting.toFixed(1)}小时未回复`
      }), task.task_id]
    );
    console.log(`[auto-ops] task ${task.task_id} escalated to ${escalateTo.username}`);

    // 同时通知原责任人已升级
    const origFu = await _lookupFeishuUser(task.assignee_username);
    if (origFu?.open_id && _sendLarkMessage) {
      await _sendLarkMessage(origFu.open_id, `⚠️ 任务 [${task.task_id}] 因超时未回复已升级至上级处理。请尽快配合处理。`);
    }
  }
}


// ─────────────────────────────────────────────
// 2. BI主动推送 (每日10:00)
// ─────────────────────────────────────────────

// 配置: 各指标阈值
const BI_PUSH_THRESHOLDS = {
  revenue_miss_pct: 10,       // 营收达成率偏差 > 10%
  bad_review_spike: 3,        // 差评数 > 3条/天
  material_anomaly_count: 2,  // 原料异常 > 2次/天
  inspection_fail_rate: 30,   // 巡检不合格率 > 30%
};

export async function biProactivePushTick() {
  const now = new Date();
  const cstHour = (now.getUTCHours() + 8) % 24;

  // 仅在 CST 10:00-10:14 执行 (配合15分钟间隔)
  if (cstHour !== 10 || now.getMinutes() > 14) return 0;

  // 防重: 检查今天是否已推送
  try {
    const check = await pool().query(
      `SELECT 1 FROM master_events WHERE event_type = 'bi_proactive_push' AND created_at > CURRENT_DATE`
    );
    if (check.rows?.length) return 0;
  } catch (e) {}

  let pushed = 0;
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);

  try {
    // 获取所有门店
    const storesR = await pool().query(
      `SELECT DISTINCT store FROM feishu_users WHERE store IS NOT NULL AND store != '' AND store != '总部'`
    );
    const stores = (storesR.rows || []).map(r => r.store);

    for (const storeName of stores) {
      const alerts = [];

      // ── 差评数 ──
      try {
        const badR = await pool().query(
          `SELECT COUNT(*) as cnt FROM feishu_generic_records
           WHERE table_key = 'bad_reviews' AND (record_data->>'门店' = $1 OR record_data->>'store' = $1)
             AND created_at::date = $2::date`,
          [storeName, yesterday]
        );
        const badCount = parseInt(badR.rows?.[0]?.cnt || 0);
        if (badCount >= BI_PUSH_THRESHOLDS.bad_review_spike) {
          alerts.push(`📢 差评: 昨日${badCount}条 (阈值${BI_PUSH_THRESHOLDS.bad_review_spike}条)`);
        }
      } catch (e) {}

      // ── 原料异常 ──
      try {
        const matR = await pool().query(
          `SELECT COUNT(*) as cnt FROM feishu_generic_records
           WHERE table_key = 'raw_material_orders' AND (record_data->>'门店' = $1 OR record_data->>'store' = $1)
             AND record_data->>'异常' IS NOT NULL AND record_data->>'异常' != ''
             AND created_at::date = $2::date`,
          [storeName, yesterday]
        );
        const matCount = parseInt(matR.rows?.[0]?.cnt || 0);
        if (matCount >= BI_PUSH_THRESHOLDS.material_anomaly_count) {
          alerts.push(`🥬 原料异常: 昨日${matCount}次 (阈值${BI_PUSH_THRESHOLDS.material_anomaly_count}次)`);
        }
      } catch (e) {}

      // ── 未关闭的高严重度任务 ──
      try {
        const taskR = await pool().query(
          `SELECT COUNT(*) as cnt FROM master_tasks
           WHERE store = $1 AND severity = 'high' AND status NOT IN ('closed', 'settled', 'resolved')`,
          [storeName]
        );
        const openHigh = parseInt(taskR.rows?.[0]?.cnt || 0);
        if (openHigh > 0) {
          alerts.push(`🔴 高严重度未关闭任务: ${openHigh}个`);
        }
      } catch (e) {}

      // ── 巡检不合格率 ──
      try {
        const inspR = await pool().query(
          `SELECT
             COUNT(*) FILTER (WHERE record_data->>'status' = 'fail') as fail_cnt,
             COUNT(*) as total
           FROM feishu_generic_records
           WHERE table_key = 'ops_checklists' AND (record_data->>'store' = $1 OR record_data->>'门店' = $1)
             AND created_at > NOW() - INTERVAL '7 days'`,
          [storeName]
        );
        const total = parseInt(inspR.rows?.[0]?.total || 0);
        const failCnt = parseInt(inspR.rows?.[0]?.fail_cnt || 0);
        const failRate = total > 0 ? Math.round(failCnt / total * 100) : 0;
        if (failRate >= BI_PUSH_THRESHOLDS.inspection_fail_rate && total >= 3) {
          alerts.push(`📋 近7天巡检不合格率: ${failRate}% (${failCnt}/${total}次)`);
        }
      } catch (e) {}

      // ── 推送 ──
      if (alerts.length > 0) {
        const mgr = await _findStoreManager?.(storeName);
        if (mgr?.username) {
          const fu = await _lookupFeishuUser?.(mgr.username);
          if (fu?.open_id) {
            const card = {
              config: { wide_screen_mode: true },
              header: { title: { tag: 'plain_text', content: `📊 每日经营预警 · ${storeName}` }, template: 'orange' },
              elements: [
                { tag: 'div', text: { tag: 'lark_md', content: `**日期**: ${yesterday}\n\n${alerts.map(a => `• ${a}`).join('\n')}` } },
                { tag: 'hr' },
                { tag: 'div', text: { tag: 'lark_md', content: '💡 如需详情可回复门店名查询（如"洪潮大宁久光店健康度"）' } },
                { tag: 'note', elements: [{ tag: 'plain_text', content: '小年 · BI 每日预警 · 仅显示超过阈值的指标' }] }
              ]
            };
            const sendR = await _sendLarkCard?.(fu.open_id, card);
            if (sendR?.ok) pushed++;
          }
        }

        // 同时推送给HQ管理员
        try {
          const hqR = await pool().query(
            `SELECT f.open_id FROM feishu_users f JOIN users u ON f.username = u.username WHERE u.role = 'admin' AND u.is_active = true LIMIT 1`
          );
          if (hqR.rows?.[0]?.open_id) {
            const hqMsg = `📊 【${storeName}】昨日预警:\n${alerts.join('\n')}`;
            await _sendLarkMessage?.(hqR.rows[0].open_id, hqMsg);
          }
        } catch (e) {}
      }
    }

    // 记录推送事件
    if (pushed > 0 || stores.length > 0) {
      await pool().query(
        `INSERT INTO master_events (task_id, event_type, agent_name, data) VALUES ($1, 'bi_proactive_push', 'auto_ops', $2::jsonb)`,
        [`BI-PUSH-${yesterday}`, JSON.stringify({ date: yesterday, storesChecked: stores.length, alertsPushed: pushed })]
      );
    }
    console.log(`[auto-ops] BI proactive push: ${stores.length} stores checked, ${pushed} alerts pushed`);
  } catch (e) {
    console.error('[auto-ops] BI push error:', e?.message);
  }

  return pushed;
}


// ─────────────────────────────────────────────
// 3. 排班与人效自动建议 (每周一09:00)
// ─────────────────────────────────────────────

export async function laborEfficiencyTick() {
  const now = new Date();
  const cstHour = (now.getUTCHours() + 8) % 24;
  const cstDay = new Date(now.getTime() + 8 * 3600000).getDay(); // 0=Sunday

  // 仅在周一 CST 09:00-09:14 执行
  if (cstDay !== 1 || cstHour !== 9 || now.getMinutes() > 14) return 0;

  // 防重
  try {
    const check = await pool().query(
      `SELECT 1 FROM master_events WHERE event_type = 'labor_efficiency_push' AND created_at > CURRENT_DATE`
    );
    if (check.rows?.length) return 0;
  } catch (e) {}

  let pushed = 0;

  try {
    const storesR = await pool().query(
      `SELECT DISTINCT store FROM feishu_users WHERE store IS NOT NULL AND store != '' AND store != '总部'`
    );

    for (const row of (storesR.rows || [])) {
      const storeName = row.store;

      // 分析上周的巡检和任务数据，生成人效建议
      const [taskStats, inspStats] = await Promise.all([
        pool().query(
          `SELECT
             COUNT(*) as total_tasks,
             COUNT(*) FILTER (WHERE severity = 'high') as high_tasks,
             AVG(EXTRACT(EPOCH FROM (COALESCE(responded_at, NOW()) - dispatched_at))/3600) as avg_response_hours
           FROM master_tasks
           WHERE store = $1 AND created_at > NOW() - INTERVAL '7 days'`,
          [storeName]
        ),
        pool().query(
          `SELECT
             COUNT(*) as total,
             COUNT(*) FILTER (WHERE record_data->>'status' = 'fail') as fail_cnt
           FROM feishu_generic_records
           WHERE table_key = 'ops_checklists' AND (record_data->>'store' = $1)
             AND created_at > NOW() - INTERVAL '7 days'`,
          [storeName]
        )
      ]);

      const totalTasks = parseInt(taskStats.rows?.[0]?.total_tasks || 0);
      const highTasks = parseInt(taskStats.rows?.[0]?.high_tasks || 0);
      const avgResponseH = parseFloat(taskStats.rows?.[0]?.avg_response_hours || 0);
      const inspTotal = parseInt(inspStats.rows?.[0]?.total || 0);
      const inspFail = parseInt(inspStats.rows?.[0]?.fail_cnt || 0);

      // 生成建议
      const suggestions = [];
      if (avgResponseH > 3) {
        suggestions.push(`⏰ 上周平均响应时间 ${avgResponseH.toFixed(1)}h，建议安排专人负责异常跟进`);
      }
      if (highTasks > 3) {
        suggestions.push(`🔴 上周高严重度任务 ${highTasks}个，建议加强高峰时段人员配置`);
      }
      if (inspFail > 2 && inspTotal > 0) {
        suggestions.push(`📋 巡检不合格 ${inspFail}/${inspTotal}次 (${Math.round(inspFail/inspTotal*100)}%)，建议加强开市/收档检查督导`);
      }
      if (totalTasks > 10) {
        suggestions.push(`📊 上周异常任务共 ${totalTasks}个，建议审视排班是否合理`);
      }

      if (suggestions.length === 0) continue;

      const mgr = await _findStoreManager?.(storeName);
      if (!mgr?.username) continue;
      const fu = await _lookupFeishuUser?.(mgr.username);
      if (!fu?.open_id) continue;

      const card = {
        config: { wide_screen_mode: true },
        header: { title: { tag: 'plain_text', content: `📅 周度人效建议 · ${storeName}` }, template: 'blue' },
        elements: [
          { tag: 'div', text: { tag: 'lark_md', content: `**统计周期**: 上周\n**异常任务**: ${totalTasks}个 (高${highTasks})\n**平均响应**: ${avgResponseH.toFixed(1)}h\n**巡检**: ${inspTotal}次 (不合格${inspFail})\n\n**💡 建议:**\n${suggestions.join('\n')}` } },
          { tag: 'hr' },
          { tag: 'note', elements: [{ tag: 'plain_text', content: '小年 · 周度人效分析 · 基于上周运营数据' }] }
        ]
      };

      const sendR = await _sendLarkCard?.(fu.open_id, card);
      if (sendR?.ok) pushed++;
    }

    if (pushed > 0) {
      await pool().query(
        `INSERT INTO master_events (task_id, event_type, agent_name, data) VALUES ($1, 'labor_efficiency_push', 'auto_ops', $2::jsonb)`,
        [`LABOR-${now.toISOString().slice(0, 10)}`, JSON.stringify({ pushed })]
      );
    }
    console.log(`[auto-ops] labor efficiency: ${pushed} suggestions pushed`);
  } catch (e) {
    console.error('[auto-ops] labor efficiency error:', e?.message);
  }

  return pushed;
}


// ─────────────────────────────────────────────
// 4. 培训闭环
// ─────────────────────────────────────────────

const TRAINING_ANOMALY_THRESHOLD = 3; // 7天内同类异常 >= 3次 → 触发培训
const TRAINING_LOOKBACK_DAYS = 7;

export async function trainingClosedLoopTick() {
  const now = new Date();
  const cstHour = (now.getUTCHours() + 8) % 24;

  // 每天 CST 11:00-11:14 执行
  if (cstHour !== 11 || now.getMinutes() > 14) return 0;

  // 防重
  try {
    const check = await pool().query(
      `SELECT 1 FROM master_events WHERE event_type = 'training_closed_loop' AND created_at > CURRENT_DATE`
    );
    if (check.rows?.length) return 0;
  } catch (e) {}

  let created = 0;

  try {
    // 查找近7天各门店各类别的异常次数
    const anomalyR = await pool().query(
      `SELECT store, category, COUNT(*) as cnt,
              array_agg(DISTINCT title ORDER BY title) as sample_titles
       FROM master_tasks
       WHERE created_at > NOW() - INTERVAL '${TRAINING_LOOKBACK_DAYS} days'
         AND status NOT IN ('closed')
       GROUP BY store, category
       HAVING COUNT(*) >= $1
       ORDER BY cnt DESC LIMIT 20`,
      [TRAINING_ANOMALY_THRESHOLD]
    );

    for (const row of (anomalyR.rows || [])) {
      const { store, category, cnt, sample_titles } = row;
      if (!store || !category) continue;

      // 检查是否已有同类培训任务在进行中
      const existingR = await pool().query(
        `SELECT 1 FROM training_tasks
         WHERE store = $1 AND type = $2
           AND status NOT IN ('completed', 'cancelled')
           AND created_at > NOW() - INTERVAL '14 days'
         LIMIT 1`,
        [store, category]
      );
      if (existingR.rows?.length) continue;

      // 找到该门店的责任人
      const mgr = await _findStoreManager?.(store);
      if (!mgr?.username) continue;

      // 生成培训内容 (使用LLM)
      let trainingContent = '';
      try {
        const titles = Array.isArray(sample_titles) ? sample_titles.slice(0, 5) : [];
        const llmResult = await _callLLM?.([
          { role: 'system', content: `你是年年有喜餐饮集团的培训专家。请基于以下反复出现的异常，生成一份简短的培训要点（不超过200字），供门店员工学习。
只列出关键要点，不要废话。格式：用编号列出3-5个要点。` },
          { role: 'user', content: `门店: ${store}\n异常类别: ${category}\n近${TRAINING_LOOKBACK_DAYS}天发生${cnt}次\n典型异常: ${titles.join('; ')}` }
        ], { temperature: 0.3, max_tokens: 500 });
        trainingContent = llmResult?.content || '';
      } catch (e) {
        trainingContent = `针对"${category}"问题的专项培训。近${TRAINING_LOOKBACK_DAYS}天该门店发生${cnt}次此类异常，请认真学习相关SOP并整改。`;
      }

      // 创建培训任务
      try {
        const taskId = `TRAIN-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
        await pool().query(
          `INSERT INTO training_tasks (task_id, title, type, store, assignee_username, status, progress_data, created_at)
           VALUES ($1, $2, $3, $4, $5, 'pending', $6::jsonb, NOW())`,
          [
            taskId,
            `【自动培训】${category} 专项培训 — ${store}`,
            category,
            store,
            mgr.username,
            JSON.stringify({ source: 'auto_anomaly', content: trainingContent, anomaly_count: parseInt(cnt) })
          ]
        );
        created++;
        console.log(`[auto-ops] training task created: ${category} for ${store} (${cnt} anomalies)`);

        // 通知责任人
        const fu = await _lookupFeishuUser?.(mgr.username);
        if (fu?.open_id && _sendLarkCard) {
          const card = {
            config: { wide_screen_mode: true },
            header: { title: { tag: 'plain_text', content: `📚 自动培训任务` }, template: 'turquoise' },
            elements: [
              { tag: 'div', text: { tag: 'lark_md', content: `**门店**: ${store}\n**异常类别**: ${category}\n**近${TRAINING_LOOKBACK_DAYS}天发生**: ${cnt}次\n\n系统检测到该类异常频发，已自动生成培训任务:` } },
              { tag: 'hr' },
              { tag: 'div', text: { tag: 'lark_md', content: trainingContent || '请学习相关SOP' } },
              { tag: 'hr' },
              { tag: 'div', text: { tag: 'lark_md', content: '📝 学习完成后请回复"培训完成"确认。' } },
              { tag: 'note', elements: [{ tag: 'plain_text', content: '小年 · 自动培训 · 基于异常频率自动触发' }] }
            ]
          };
          await _sendLarkCard(fu.open_id, card);
        }
      } catch (e) {
        console.error('[auto-ops] create training task error:', e?.message);
      }
    }

    // ── 培训任务到期提醒: 3天未完成的培训任务 ──
    try {
      const overdueR = await pool().query(
        `SELECT * FROM training_tasks
         WHERE status IN ('pending', 'in_progress')
           AND progress_data->>'source' = 'auto_anomaly'
           AND created_at < NOW() - INTERVAL '3 days'
           AND (progress_data->>'reminder_sent')::boolean IS NOT TRUE
         LIMIT 5`
      );

      for (const task of (overdueR.rows || [])) {
        if (!task.assignee_username) continue;
        const fu = await _lookupFeishuUser?.(task.assignee_username);
        if (!fu?.open_id || !_sendLarkMessage) continue;

        await _sendLarkMessage(fu.open_id, `📚 培训提醒: "${task.title}" 已下发3天，请尽快完成学习并回复"培训完成"。`);
        await pool().query(
          `UPDATE training_tasks SET progress_data = COALESCE(progress_data, '{}'::jsonb) || '{"reminder_sent": true}'::jsonb WHERE id = $1`,
          [task.id]
        );
      }
    } catch (e) {}

    if (created > 0) {
      await pool().query(
        `INSERT INTO master_events (task_id, event_type, agent_name, data) VALUES ($1, 'training_closed_loop', 'auto_ops', $2::jsonb)`,
        [`TRAIN-${now.toISOString().slice(0, 10)}`, JSON.stringify({ created })]
      );
    }
    console.log(`[auto-ops] training closed loop: ${created} training tasks created`);
  } catch (e) {
    console.error('[auto-ops] training closed loop error:', e?.message);
  }

  return created;
}
