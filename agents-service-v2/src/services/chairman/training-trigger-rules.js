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
import { sendCompanyNoticeToAssignees } from '../feishu-client.js';

function buildDispatchConfig(effectiveRule, cfg) {
  const explicit = effectiveRule?.dispatchTo;
  const globalDispatch = cfg?.proactive_rules?.dispatchDefaults;
  return {
    assignee: explicit?.assignee !== false && globalDispatch?.assignee !== false,
    management: explicit?.management !== false && globalDispatch?.management !== false
  };
}

function buildTrainingNotice(task, payload) {
  return [
    `触发培训：${payload.course}`,
    `门店：${payload.store}`,
    `触发异常：${payload.anomalyKey}`,
    `触发频次：${payload.count}次/${payload.countWindowDays}天`,
    payload.content ? `培训内容：${payload.content}` : '',
    payload.examPass ? `考核标准：${payload.examPass}` : '',
    payload.targetAudience?.length ? `培训对象：${payload.targetAudience.join('、')}` : '',
    payload.roleLabel ? `责任岗位：${payload.roleLabel}` : ''
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
    const targetAudience = effectiveRule.targetAudience || [];
    const role = effectiveRule.assignTo || effectiveRule.training?.assignTo || 'store_manager';
    const roleLabel = role === 'store_production_manager' ? '厨师长' : '店长';
    const audienceLabel = targetAudience.length ? `培训对象: ${targetAudience.join('、')}\n` : '';
    const assignee = await resolveSingleScoringUser(store, role).catch(() => null);
    const assigneeUsername = String(assignee?.username || '').trim();
    const dispatchTo = buildDispatchConfig(effectiveRule, chairmanCfg);

    const taskResult = await createTask({
      source: 'training_trigger',
      category: 'training',
      severity: 'medium',
      store,
      brand,
      title: `培训任务: ${course}`,
      detail: `触发原因: ${anomalyKey}异常(${count}次/${countWindowDays}天)\n培训内容: ${fullContent}\n考核标准: ${examPass}\n${audienceLabel}负责人: ${roleLabel}`,
      sourceData: {
        anomalyKey,
        triggerCount: count,
        countWindowDays,
        course,
        content: fullContent,
        manualContent,
        knowledge_ids: knowledgeIds,
        examPass,
        targetAudience,
        dispatchTo,
        notifyRoles: chairmanCfg?.proactive_rules?.notifyRoles || ['admin', 'hq_manager']
      },
      assigneeUsername,
      assigneeRole: role,
    });

    if (taskResult?.taskId && (dispatchTo.assignee || dispatchTo.management)) {
      const task = {
        task_id: taskResult.taskId,
        source: 'training_trigger',
        store,
        title: `培训任务: ${course}`,
        assignee_username: assigneeUsername,
        assignee_role: role
      };
      const noticeText = buildTrainingNotice(task, { anomalyKey, course, store, count, countWindowDays, content, examPass, targetAudience, roleLabel });
      await sendCompanyNoticeToAssignees(task, noticeText, {
        title: '培训任务通知',
        type: 'training_trigger_notice',
        sendToAssignee: dispatchTo.assignee,
        sendToManagement: dispatchTo.management
      }).catch((e) => logger.warn({ err: e?.message, taskId: taskResult.taskId }, 'training trigger notice failed'));
    }

    logger.info({ anomalyKey, store, task: taskResult.taskId }, 'training triggered');
    return { triggered: true, taskId: taskResult.taskId, course };

  } catch (e) {
    logger.warn({ err: e?.message, anomalyKey, store }, 'training trigger failed');
    return { triggered: false, error: e?.message };
  }
}

/**
 * 导出规则列表（供管理界面使用）
 */
export function getTrainingTriggerRules() {
  return TRAINING_TRIGGER_RULES;
}
