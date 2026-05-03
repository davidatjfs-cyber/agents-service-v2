export const TASK_TEMPLATES = [
  {
    id: 'hygiene_inspection',
    title: '门店卫生整改',
    category: 'hygiene',
    priority: 'high',
    acceptanceRules: ['明确整改范围并提交执行说明', '整改完成后进入管理员验收', '整改后各区域需有对比照片'],
    evidenceRequirements: [{ type: 'photo', minCount: 4, scenes: ['前厅', '后厨', '洗手间', '仓库'] }],
    subtasks: [
      { title: '通知门店负责人确认整改计划', auto: false },
      { title: '安排卫生整改/大扫除并提交照片', auto: false },
      { title: '到期终验并反馈管理员', auto: true }
    ]
  },
  {
    id: 'food_safety_review',
    title: '食品安全复查',
    category: 'food_quality',
    priority: 'high',
    acceptanceRules: ['出具检测报告', '整改后提供对比证据'],
    evidenceRequirements: [{ type: 'photo', minCount: 3 }, { type: 'text', required: true }],
    subtasks: [
      { title: '确认出品问题并提交整改说明', auto: false },
      { title: '管理员验收出品整改', auto: true }
    ]
  },
  {
    id: 'service_improvement',
    title: '服务质量提升',
    category: 'service',
    priority: 'medium',
    acceptanceRules: ['提交服务改进方案', '培训后提交执行记录'],
    evidenceRequirements: [{ type: 'text', required: true }],
    subtasks: [
      { title: '确认服务问题并提交改进方案', auto: false },
      { title: '培训执行并提交记录', auto: false },
      { title: '管理员验收', auto: true }
    ]
  },
  {
    id: 'data_audit_check',
    title: '数据核对检查',
    category: 'data_audit',
    priority: 'medium',
    acceptanceRules: ['提交核对报告', '标注差异项及原因'],
    evidenceRequirements: [{ type: 'text', required: true }],
    subtasks: [
      { title: '完成数据核对并提交报告', auto: false },
      { title: '管理员确认', auto: true }
    ]
  }
];

export function findTemplate(category) {
  return TASK_TEMPLATES.find((t) => t.category === category) || TASK_TEMPLATES[0];
}

export function enrichFromTemplate(parsedTask) {
  const template = findTemplate(parsedTask.category);
  if (!template) return parsedTask;
  return {
    ...parsedTask,
    acceptanceRules: parsedTask.acceptanceRules?.length ? parsedTask.acceptanceRules : template.acceptanceRules,
    evidenceRequirements: parsedTask.evidenceRequirements?.length ? parsedTask.evidenceRequirements : template.evidenceRequirements,
    suggestedSubtasks: parsedTask.suggestedSubtasks?.length ? parsedTask.suggestedSubtasks : template.subtasks.map((s) => s.title),
    templateId: template.id
  };
}