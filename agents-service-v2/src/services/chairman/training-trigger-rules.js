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
 */
export async function checkAndTriggerTraining(anomalyKey, store, severity) {
  const rule = TRAINING_TRIGGER_RULES.find(r => r.anomalyKey === anomalyKey);
  if (!rule) return { triggered: false };

  const severityOrder = { low: 0, medium: 1, high: 2 };
  if ((severityOrder[severity] || 0) < (severityOrder[rule.minSeverity] || 0)) {
    return { triggered: false, reason: 'severity_below_threshold' };
  }

  try {
    const brandResult = await query(
      `SELECT brand FROM anomaly_triggers WHERE store ILIKE $1 AND anomaly_key = $2 ORDER BY trigger_date DESC LIMIT 1`,
      [`%${store}%`, anomalyKey]
    );
    const brand = brandResult.rows?.[0]?.brand || '';

    const cooldownKey = `training_trigger_${anomalyKey}`;
    const cooldownCheck = await query(
      `SELECT 1 FROM master_tasks
       WHERE store ILIKE $1 AND source = 'training_trigger'
       AND title ILIKE $2
       AND created_at >= NOW() - INTERVAL '1 day' * $3
       LIMIT 1`,
      [`%${store}%`, `%${rule.training.course}%`, rule.cooldownDays]
    );
    if (cooldownCheck.rows?.length) {
      return { triggered: false, reason: 'cooldown' };
    }

    const recentCount = await query(
      `SELECT COUNT(*) AS cnt FROM anomaly_triggers
       WHERE store ILIKE $1 AND anomaly_key = $2 AND trigger_date >= NOW() - INTERVAL '1 day' * $3`,
      [`%${store}%`, anomalyKey, rule.countWindowDays]
    );
    const count = Number(recentCount.rows?.[0]?.cnt ?? 0);
    if (count < rule.minCount) {
      return { triggered: false, reason: `count_${count}_below_${rule.minCount}` };
    }

    const role = rule.training.assignTo;
    const roleLabel = role === 'store_production_manager' ? '厨师长' : '店长';

    const taskResult = await createTask({
      source: 'training_trigger',
      category: 'training',
      severity: 'medium',
      store,
      brand,
      title: `培训任务: ${rule.training.course}`,
      detail: `触发原因: ${anomalyKey}异常(${count}次/${rule.countWindowDays}天)\n培训内容: ${rule.training.content}\n考核标准: ${rule.training.examPass}\n负责人: ${roleLabel}`,
      assigneeRole: role,
    });

    logger.info({ anomalyKey, store, task: taskResult.taskId }, 'training triggered');
    return { triggered: true, taskId: taskResult.taskId, course: rule.training.course };

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
