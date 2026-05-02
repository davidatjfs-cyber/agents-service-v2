/**
 * 异常→培训联动规则 — 发现问题时自动触发对应培训
 *
 * 逻辑：异常触发 → 检查规则 → 自动创建培训任务
 * 不替代异常检测，是在异常触发后追加培训动作
 *
 * 【需你定义】每种异常对应的培训课程和考核方式
 */
import { query } from '../../utils/db.js';
import { logger } from '../../utils/logger.js';
import { createTask } from '../task-state-machine.js';
import { resolveSingleScoringUser } from '../../utils/scoring-assignee.js';

function buildTrainingNotice(task, payload) {
  return [
    `触发培训：${payload.course}`,
    `门店：${payload.store}`,
    `触发异常：${payload.anomalyKey}`,
    `触发频次：${payload.count}次/${payload.countWindowDays}天`,
    payload.content ? `培训内容：${payload.content}` : '',
    payload.examPass ? `考核标准：${payload.examPass}` : ''
  ].filter(Boolean).join('\n');
}

/**
 * 异常→培训映射规则
 *
 * 【需你定义】以下每条规则需要你确认或补充：
 * - course: 培训课程名称（需要在知识库中有对应内容）
 * - examPass: 考核标准
 * - cooldownDays: 同店同类培训冷却期（避免重复触发）
 */
const TRAINING_TRIGGER_RULES = [
  {
    anomalyKey: 'bad_review_service',
    minSeverity: 'medium',
    minCount: 2,
    countWindowDays: 7,
    training: {
      course: '服务流程SOP',
      /* [需你定义] 具体培训内容，对应知识库中的PDF名称 */
      content: '迎宾→入座→点餐→上菜→结账全流程',
      examPass: '考试≥90分',
      assignTo: 'store_manager',
    },
    cooldownDays: 14,
  },
  {
    anomalyKey: 'bad_review_product',
    minSeverity: 'medium',
    minCount: 2,
    countWindowDays: 7,
    training: {
      course: '出品标准复训',
      /* [需你定义] 每个品牌的具体出品标准 */
      content: '厨师长出品标准复检，重点菜出品一致性',
      examPass: '出品合格率≥95%',
      assignTo: 'store_production_manager',
    },
    cooldownDays: 14,
  },
  {
    anomalyKey: 'gross_margin',
    minSeverity: 'medium',
    minCount: 1,
    countWindowDays: 30,
    training: {
      course: '成本控制规范',
      /* [需你定义] 成本控制培训内容 */
      content: '食材损耗控制、采购验收标准、库存管理',
      examPass: '考试≥85分',
      assignTo: 'store_production_manager',
    },
    cooldownDays: 30,
  },
  {
    anomalyKey: 'food_safety',
    minSeverity: 'high',
    minCount: 1,
    countWindowDays: 1,
    training: {
      course: '食品安全紧急培训',
      content: '食品安全标准操作规程复训',
      examPass: '考试≥95分+现场检查通过',
      assignTo: 'store_manager',
    },
    cooldownDays: 7,
  },
];

/**
 * 检查并触发培训
 * 在异常触发后被调用
 * 支持从DB配置读取品牌差异化的培训映射
 */
export async function checkAndTriggerTraining(anomalyKey, store, severity) {
  // Try loading from DB config first (supports brand-differentiated config)
  let trainingConfig = null;
  let rule = TRAINING_TRIGGER_RULES.find(r => r.anomalyKey === anomalyKey);
  let chairmanCfg = null;

  try {
    const r = await query(
      `SELECT data FROM hrms_state WHERE key = 'chairman_config'`
    );
    const cfg = r.rows?.[0]?.data;
    chairmanCfg = typeof cfg === 'string' ? JSON.parse(cfg) : cfg;
    if (chairmanCfg?.training_map?.[anomalyKey]) {
      trainingConfig = chairmanCfg.training_map[anomalyKey];
      // If brand-differentiated, find the matching brand entry
      if (trainingConfig.brands && Array.isArray(trainingConfig.brands)) {
        const brandResult = await query(
          `SELECT brand FROM anomaly_triggers WHERE store ILIKE $1 AND anomaly_key = $2 ORDER BY trigger_date DESC LIMIT 1`,
          [`%${store}%`, anomalyKey]
        );
        const brand = brandResult.rows?.[0]?.brand || '';
        const brandEntry = trainingConfig.brands.find(b => b.brand === brand) || trainingConfig.brands[0];
        if (brandEntry) {
          trainingConfig = brandEntry;
        }
      }
    }
  } catch (e) {
    logger.warn({ err: e?.message }, 'Failed to load training config from DB');
  }

  // Master switch: training_map.enabled === false 则跳过所有培训触发
  if (chairmanCfg?.training_map?.enabled === false) {
    return { triggered: false, reason: 'disabled' };
  }

  // Use DB config if available, otherwise use hardcoded rule
  const effectiveRule = trainingConfig || rule;
  if (!effectiveRule) return { triggered: false };

  const minSeverity = effectiveRule.minSeverity || (rule?.minSeverity) || 'medium';
  const severityOrder = { low: 0, medium: 1, high: 2 };
  if ((severityOrder[severity] || 0) < (severityOrder[minSeverity] || 0)) {
    return { triggered: false, reason: 'severity_below_threshold' };
  }

  try {
    const brandResult2 = await query(
      `SELECT brand FROM anomaly_triggers WHERE store ILIKE $1 AND anomaly_key = $2 ORDER BY trigger_date DESC LIMIT 1`,
      [`%${store}%`, anomalyKey]
    );
    const brand = brandResult2.rows?.[0]?.brand || '';

    const cooldownDays = effectiveRule.cooldownDays || (rule?.cooldownDays) || 14;
    const cooldownCheck = await query(
      `SELECT 1 FROM master_tasks
       WHERE store ILIKE $1 AND source = 'training_trigger'
       AND title ILIKE $2
       AND created_at >= NOW() - INTERVAL '1 day' * $3
       LIMIT 1`,
      [`%${store}%`, `%${effectiveRule.course || effectiveRule.training?.course || ''}%`, cooldownDays]
    );
    if (cooldownCheck.rows?.length) {
      return { triggered: false, reason: 'cooldown' };
    }

    const countWindowDays = effectiveRule.countWindowDays || (rule?.countWindowDays) || 7;
    const minCount = effectiveRule.minCount || (rule?.minCount) || 2;
    const recentCount = await query(
      `SELECT COUNT(*) AS cnt FROM anomaly_triggers
       WHERE store ILIKE $1 AND anomaly_key = $2 AND trigger_date >= NOW() - INTERVAL '1 day' * $3`,
      [`%${store}%`, anomalyKey, countWindowDays]
    );
    const count = Number(recentCount.rows?.[0]?.cnt ?? 0);
    if (count < minCount) {
      return { triggered: false, reason: `count_${count}_below_${minCount}` };
    }

    const course = effectiveRule.course || effectiveRule.training?.course || '培训';
    const manualContent = effectiveRule.content || effectiveRule.training?.content || '';

    // Load knowledge entries if knowledge_ids is configured
    let knowledgeBlock = '';
    const knowledgeIds = effectiveRule.knowledge_ids || (effectiveRule.training?.knowledge_ids) || [];
    if (knowledgeIds.length > 0) {
      try {
        const kbResult = await query(
          'SELECT title, content FROM knowledge_base WHERE id = ANY($1::int[]) AND enabled = true',
          [knowledgeIds]
        );
        if (kbResult.rows?.length) {
          knowledgeBlock = '\n📚 关联知识：\n' + kbResult.rows.map(k =>
            `- ${k.title}\n${k.content}`
          ).join('\n');
        }
      } catch (e) {
        logger.warn({ err: e?.message }, 'Failed to load knowledge entries for training');
      }
    }
    const fullContent = manualContent + knowledgeBlock;

    const examPass = effectiveRule.examPass || effectiveRule.training?.examPass || '';

    // Task assignee for tracking (separate from audience notifications)
    const role = effectiveRule.assignTo || effectiveRule.training?.assignTo || 'store_manager';
    const taskAssignee = await resolveSingleScoringUser(store, role).catch(() => null);
    const assigneeUsername = String(taskAssignee?.username || '').trim();

    const taskResult = await createTask({
      source: 'training_trigger',
      category: 'training',
      severity: 'medium',
      store,
      brand,
      title: `培训任务: ${course}`,
      detail: `触发原因: ${anomalyKey}异常(${count}次/${countWindowDays}天)\n培训内容: ${fullContent}\n考核标准: ${examPass}`,
      sourceData: {
        anomalyKey,
        triggerCount: count,
        countWindowDays,
        course,
        content: fullContent,
        manualContent,
        knowledge_ids: knowledgeIds,
        examPass,
      },
      assigneeUsername,
      assigneeRole: role,
    });

    // Send training notification to all audience members via hrms_user_notifications
    if (taskResult?.taskId) {
      const noticeText = buildTrainingNotice({ task_id: taskResult.taskId, store },
        { anomalyKey, course, store, count, countWindowDays, content: fullContent, examPass });
      const targetUsernames = await resolveTrainingAudienceUsernames(effectiveRule);
      for (const username of targetUsernames) {
        if (!username) continue;
        const dup = await query(
          `SELECT 1 FROM hrms_user_notifications WHERE target_username = $1 AND meta->>'task_id' = $2 LIMIT 1`,
          [username, String(taskResult.taskId)]
        ).catch(() => ({ rows: [] }));
        if (dup.rows?.length) continue;
        await query(
          `INSERT INTO hrms_user_notifications (target_username, title, message, type, meta)
           VALUES ($1, $2, $3, $4, $5::jsonb)`,
          [username, '培训任务通知', noticeText, 'training_trigger_notice',
           JSON.stringify({ task_id: taskResult.taskId, store, source: 'training_trigger' })]
        ).catch((e) => logger.warn({ err: e?.message, username }, 'training: hrms notification failed'));
      }
    }

    logger.info({ anomalyKey, store, task: taskResult.taskId }, 'training triggered');
    return { triggered: true, taskId: taskResult.taskId, course };

  } catch (e) {
    logger.warn({ err: e?.message, anomalyKey, store }, 'training trigger failed');
    return { triggered: false, error: e?.message };
  }
}

/**
 * Resolve target usernames from the new audience format (positions / categories / stores).
 * Categories: 新入职员工=joined ≤7天, 新员工=joined ≤3个月, 核心员工=extra_json tag.
 * Falls back to empty array if no audience configured (legacy configs skip notifications).
 */
async function resolveTrainingAudienceUsernames(effectiveRule) {
  const audience = effectiveRule?.audience || {};
  const positions = audience.positions || [];
  const categories = audience.categories || [];
  const stores = audience.stores || [];

  if (!positions.length && !categories.length && !stores.length) {
    return [];
  }

  const clauses = ["status = 'active'"];
  const params = [];
  let idx = 1;

  if (positions.length) {
    clauses.push(`position = ANY($${idx}::text[])`);
    params.push(positions);
    idx++;
  }

  if (stores.length) {
    clauses.push(`store = ANY($${idx}::text[])`);
    params.push(stores);
    idx++;
  }

  const catClauses = [];
  if (categories.includes('新入职员工')) {
    catClauses.push(`join_date IS NOT NULL AND join_date != ''
      AND TO_DATE(join_date, 'YYYY-MM-DD') >= CURRENT_DATE - INTERVAL '7 days'`);
  }
  if (categories.includes('新员工')) {
    catClauses.push(`join_date IS NOT NULL AND join_date != ''
      AND TO_DATE(join_date, 'YYYY-MM-DD') >= CURRENT_DATE - INTERVAL '3 months'`);
  }
  if (categories.includes('核心员工')) {
    catClauses.push(`COALESCE(extra_json->>'tag', '') = 'core'
      OR COALESCE(extra_json->>'is_core', '') = 'true'`);
  }
  if (catClauses.length) {
    clauses.push(`(${catClauses.join(' OR ')})`);
  }

  try {
    const sql = `SELECT DISTINCT username FROM employees WHERE ${clauses.join(' AND ')}`;
    const result = await query(sql, params);
    return result.rows.map(r => r.username).filter(Boolean);
  } catch (e) {
    logger.warn({ err: e?.message, audience }, 'resolveTrainingAudienceUsernames failed');
    return [];
  }
}

/**
 * 导出规则列表（供管理界面使用）
 */
export function getTrainingTriggerRules() {
  return TRAINING_TRIGGER_RULES;
}
