/**
 * Agent Collaboration Chain — 跨Agent协作编排
 * 
 * 核心流程:
 * 1. 异常引擎检测到营收/客流问题 → 自动触发 marketing_planner 生成方案
 * 2. marketing_planner 生成方案 → 自动存入 marketing_campaigns 表
 * 3. 同时创建 master_task 分派给门店负责人 → 飞书通知
 * 4. marketing_executor 定期检查活动进度 → 推送效果报告
 */
import { query } from '../utils/db.js';
import { logger } from '../utils/logger.js';
import { callLLM } from './llm-provider.js';
import { pushAnomalyAlert, sendText, lookupUserByUsername } from './feishu-client.js';

// ─── 营收类异常 → 自动触发营销策划 ───
const REVENUE_ANOMALIES = new Set([
  'revenue_achievement', 'traffic_decline', 'labor_efficiency'
]);

/**
 * 异常触发后的协作链入口
 */
export async function onAnomalyTriggered(anomalyKey, store, severity, detail, value) {
  try {
    // 只对营收类异常触发营销协作
    if (!REVENUE_ANOMALIES.has(anomalyKey)) return;
    if (severity === 'low') return;

    // 防重: 7天内同门店同异常不重复触发
    const dup = await query(
      `SELECT id FROM marketing_campaigns
       WHERE store = $1 AND notes LIKE $2 AND created_at > NOW() - INTERVAL '7 days'
       LIMIT 1`,
      [store, `%auto:${anomalyKey}%`]
    ).catch(() => ({ rows: [] }));
    if (dup.rows.length > 0) {
      logger.info({ store, anomalyKey }, 'collab: skip duplicate within 7d');
      return;
    }

    logger.info({ store, anomalyKey, severity }, '🔗 Collaboration chain triggered');

    // Step 1: 让 marketing_planner 生成方案
    const proposal = await generateMarketingProposal(store, anomalyKey, severity, detail, value);
    if (!proposal) return;

    // Step 2: 存入 marketing_campaigns 表
    const campaignId = await createCampaign(store, anomalyKey, proposal);

    // Step 3: 创建 master_task 分派给门店
    const taskId = await createTask(store, anomalyKey, proposal, campaignId);

    // Step 4: 飞书通知门店负责人
    await notifyStoreManager(store, anomalyKey, proposal, taskId);

    logger.info({ store, anomalyKey, campaignId, taskId }, '✅ Collaboration chain completed');
  } catch (e) {
    logger.error({ err: e?.message, store, anomalyKey }, 'Collaboration chain failed');
  }
}

/**
 * Step 1: LLM生成营销方案
 */
async function generateMarketingProposal(store, anomalyKey, severity, detail, value) {
  // 拉取匹配的营销模板
  let templateHint = '';
  try {
    const categoryMap = { revenue_achievement: '会员活动', traffic_decline: '私域运营', labor_efficiency: '外卖促销' };
    const cat = categoryMap[anomalyKey] || '';
    const tpls = await query(
      `SELECT name, category, description, actions, expected_roi, budget_range, duration_days, success_rate
       FROM marketing_templates ORDER BY success_rate DESC LIMIT 3`
    );
    if (tpls.rows?.length) {
      templateHint = '\n\n可参考的历史成功模板:\n' + tpls.rows.map(t =>
        `- ${t.name}(${t.category}): ${t.description} | ROI:${t.expected_roi} 成功率:${((t.success_rate||0)*100).toFixed(0)}% 预算:${t.budget_range}`
      ).join('\n');
    }
  } catch (e) { /* silent */ }

  // 拉取门店近期数据作为上下文
  let context = '';
  try {
    const rev = await query(
      `SELECT date, actual_revenue, budget_rate, dine_traffic, delivery_actual
       FROM daily_reports WHERE store ILIKE $1 AND date >= CURRENT_DATE - 14
       ORDER BY date DESC LIMIT 14`, [`%${store}%`]);
    if (rev.rows?.length) {
      const avg = rev.rows.reduce((s, r) => s + (parseFloat(r.actual_revenue) || 0), 0) / rev.rows.length;
      context += `近14天日均营收: ${Math.round(avg)}元\n`;
      context += rev.rows.slice(0, 7).map(r =>
        `${r.date?.toISOString?.().slice(5, 10) || ''}: 营收${r.actual_revenue || 0} 达成率${((parseFloat(r.budget_rate) || 0) * 100).toFixed(0)}% 堂食客流${r.dine_traffic || 0} 外卖${r.delivery_actual || 0}`
      ).join('\n');
    }
  } catch (e) { /* silent */ }

  const prompt = `你是餐饮连锁品牌的市场总监AI。门店"${store}"触发了${anomalyKey}异常(${severity}级):
${detail || ''}

门店数据:
${context || '暂无数据'}

请输出一个JSON格式的营销方案(不要markdown包裹):
{
  "title": "方案标题(20字内)",
  "description": "方案描述(50字内)",
  "actions": ["具体行动1","具体行动2","具体行动3"],
  "target_metric": "目标指标(如daily_revenue/traffic/delivery)",
  "target_value": 目标数值,
  "budget_amount": 预算金额,
  "duration_days": 执行天数
}

要求: 方案必须具体可执行、预算合理(500-5000元)、有明确目标${templateHint}`;

  try {
    const r = await callLLM([
      { role: 'system', content: '你是餐饮营销专家，只输出JSON，不要任何其他文字' },
      { role: 'user', content: prompt }
    ], { temperature: 0.4, max_tokens: 500, purpose: 'marketing_auto_proposal' });

    const raw = String(r.content || '').trim().replace(/^```json?\s*/i, '').replace(/```$/i, '').trim();
    const proposal = JSON.parse(raw);
    logger.info({ store, title: proposal.title }, 'Marketing proposal generated');
    return proposal;
  } catch (e) {
    logger.error({ err: e?.message }, 'Failed to generate marketing proposal');
    return null;
  }
}

/**
 * Step 2: 存入 marketing_campaigns 表
 */
async function createCampaign(store, anomalyKey, proposal) {
  const startDate = new Date();
  const endDate = new Date();
  endDate.setDate(endDate.getDate() + (proposal.duration_days || 7));

  const r = await query(
    `INSERT INTO marketing_campaigns (store, title, description, status, start_date, end_date,
     target_metric, target_value, budget_amount, notes, created_by)
     VALUES ($1, $2, $3, 'planned', $4, $5, $6, $7, $8, $9, 'agent_auto')
     RETURNING id`,
    [
      store, proposal.title, proposal.description,
      startDate.toISOString().slice(0, 10), endDate.toISOString().slice(0, 10),
      proposal.target_metric, proposal.target_value, proposal.budget_amount,
      `auto:${anomalyKey}\n` + (proposal.actions || []).join('\n')
    ]
  );
  return r.rows[0]?.id;
}

/**
 * Step 3: 创建 master_task
 */
async function createTask(store, anomalyKey, proposal, campaignId) {
  const r = await query(
    `INSERT INTO master_tasks (title, store, severity, status, source, evidence_refs)
     VALUES ($1, $2, $3, 'pending_response', 'auto_collab', $4)
     RETURNING task_id`,
    [
      `📢 ${proposal.title} (自动方案#${campaignId})`,
      store,
      'medium',
      JSON.stringify({ anomaly: anomalyKey, campaign_id: campaignId, actions: proposal.actions })
    ]
  );
  return r.rows[0]?.task_id;
}

/**
 * Step 4: 飞书通知门店负责人
 */
async function notifyStoreManager(store, anomalyKey, proposal, taskId) {
  const users = await query(
    `SELECT open_id, username FROM feishu_users
     WHERE store = $1 AND role IN ('store_manager','admin','hq_manager') AND registered = TRUE`,
    [store]
  ).catch(() => ({ rows: [] }));

  const text = `📢 【自动营销方案】${store}
触发: ${anomalyKey}异常
方案: ${proposal.title}
${proposal.description || ''}
行动:
${(proposal.actions || []).map((a, i) => `${i + 1}. ${a}`).join('\n')}
预算: ${proposal.budget_amount || 'N/A'}元
目标: ${proposal.target_metric} = ${proposal.target_value}
任务ID: #${taskId}

请确认并执行此方案，或在飞书回复"调整方案"修改。`;

  for (const u of users.rows) {
    await sendText(u.open_id, text).catch(() => {});
  }
}

/**
 * P1: 结果评估闭环 — 自动评估已完成的营销活动效果
 * 由 rhythm engine 每日调用
 * 对比活动前后数据 → 计算效果分 → 写入 agent_memory
 */
export async function evaluateCompletedCampaigns() {
  try {
    // 找出已完成但未评估的活动（结束后1-3天内）
    const completed = await query(
      `SELECT id, store, title, target_metric, target_value, actual_value,
              start_date, end_date, budget_amount, notes
       FROM marketing_campaigns
       WHERE status = 'completed'
         AND end_date >= CURRENT_DATE - 7
         AND end_date < CURRENT_DATE
         AND (evaluation_score IS NULL)`
    );
    if (!completed.rows?.length) return [];

    const results = [];
    for (const c of completed.rows) {
      // 获取活动前7天的基准数据
      const baselineStart = new Date(c.start_date);
      baselineStart.setDate(baselineStart.getDate() - 7);
      let baselineValue = null, actualValue = null;

      const metricCol = c.target_metric === 'traffic' ? 'dine_traffic' : 'actual_revenue';

      try {
        const baseR = await query(
          `SELECT AVG(${metricCol})::numeric(10,1) as avg_val FROM daily_reports
           WHERE store ILIKE $1 AND date >= $2 AND date < $3`,
          [`%${c.store}%`, baselineStart.toISOString().slice(0,10), c.start_date]
        );
        baselineValue = parseFloat(baseR.rows[0]?.avg_val || 0);

        const actR = await query(
          `SELECT AVG(${metricCol})::numeric(10,1) as avg_val FROM daily_reports
           WHERE store ILIKE $1 AND date >= $2 AND date <= $3`,
          [`%${c.store}%`, c.start_date, c.end_date]
        );
        actualValue = parseFloat(actR.rows[0]?.avg_val || 0);
      } catch (e) { /* silent */ }

      // 计算效果评分 (0-10)
      let score = 5; // 默认中等
      let outcome = 'neutral';
      if (baselineValue && actualValue) {
        const changeRate = ((actualValue - baselineValue) / baselineValue) * 100;
        if (changeRate >= 15) { score = 9; outcome = 'excellent'; }
        else if (changeRate >= 8) { score = 7; outcome = 'good'; }
        else if (changeRate >= 0) { score = 5; outcome = 'neutral'; }
        else if (changeRate >= -5) { score = 3; outcome = 'poor'; }
        else { score = 1; outcome = 'negative'; }

        // 目标达成加分
        if (c.target_value && actualValue >= parseFloat(c.target_value)) {
          score = Math.min(10, score + 1);
          outcome += '_target_met';
        }
      }

      // 写入评估结果
      await query(
        `UPDATE marketing_campaigns SET evaluation_score = $1, evaluation_outcome = $2, updated_at = NOW() WHERE id = $3`,
        [score, outcome, c.id]
      ).catch(() => {});

      // 写入 agent_memory（关键闭环！）
      const { saveOutcome } = await import('./agent-memory.js');
      const memContent = `营销活动"${c.title}" | 门店:${c.store} | 基准:${baselineValue||'N/A'} → 实际:${actualValue||'N/A'} | 预算:${c.budget_amount||'N/A'}`;
      await saveOutcome('marketing_planner', c.store, memContent, outcome, score).catch(() => {});

      results.push({ id: c.id, store: c.store, title: c.title, score, outcome, baselineValue, actualValue });
      logger.info({ campaign: c.id, store: c.store, score, outcome }, '📊 Campaign evaluated');
    }
    return results;
  } catch (e) {
    logger.error({ err: e?.message }, 'evaluateCompletedCampaigns failed');
    return [];
  }
}

/**
 * 定期检查活动进度 — 由 rhythm engine 调用
 */
export async function checkCampaignProgress() {
  try {
    const active = await query(
      `SELECT id, store, title, target_metric, target_value, start_date, end_date, budget_amount, spent_amount
       FROM marketing_campaigns WHERE status = 'active' AND end_date >= CURRENT_DATE`
    );
    if (!active.rows?.length) return [];

    const results = [];
    for (const c of active.rows) {
      // 获取活动期间的实际数据
      let actualValue = null;
      if (c.target_metric === 'daily_revenue' || c.target_metric === 'revenue') {
        const r = await query(
          `SELECT AVG(actual_revenue)::numeric(10,0) as avg_val FROM daily_reports
           WHERE store ILIKE $1 AND date >= $2 AND date <= CURRENT_DATE`,
          [`%${c.store}%`, c.start_date]
        );
        actualValue = parseFloat(r.rows[0]?.avg_val || 0);
      } else if (c.target_metric === 'traffic') {
        const r = await query(
          `SELECT AVG(dine_traffic)::numeric(10,0) as avg_val FROM daily_reports
           WHERE store ILIKE $1 AND date >= $2 AND date <= CURRENT_DATE`,
          [`%${c.store}%`, c.start_date]
        );
        actualValue = parseFloat(r.rows[0]?.avg_val || 0);
      }

      if (actualValue !== null) {
        await query(
          `UPDATE marketing_campaigns SET actual_value = $1, updated_at = NOW() WHERE id = $2`,
          [actualValue, c.id]
        );
      }

      const progress = actualValue && c.target_value
        ? ((actualValue / parseFloat(c.target_value)) * 100).toFixed(0) + '%'
        : 'N/A';

      results.push({ id: c.id, store: c.store, title: c.title, progress, actualValue, target: c.target_value });

      // 如果活动已到期，自动关闭
      if (new Date(c.end_date) < new Date()) {
        await query(`UPDATE marketing_campaigns SET status = 'completed', updated_at = NOW() WHERE id = $1`, [c.id]);
      }
    }
    return results;
  } catch (e) {
    logger.error({ err: e?.message }, 'checkCampaignProgress failed');
    return [];
  }
}
