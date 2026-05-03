const CATEGORY_RULES = [
  { category: 'hygiene', pattern: /卫生|清洁|大扫除|脏|油污|消毒|后厨.*乱/ },
  { category: 'food_quality', pattern: /出品|菜品|口味|食安|食品安全|异物|变质|食材.*不新鲜|不新鲜/ },
  { category: 'service', pattern: /服务|态度|投诉|差评|客诉|桌访/ },
  { category: 'training', pattern: /培训|考试|带教|学习|SOP|标准/ },
  { category: 'marketing_action', pattern: /推广.*效果|执行.*营销|营销方案|落地|投放|执行.*活动|活动执行|效果不好.*营销/ },
  { category: 'marketing', pattern: /营销|活动|推广|引流|会员|充值|策划|促销/ },
  { category: 'daily_ops', pattern: /巡检|日检|巡店|日常检查/ },
  { category: 'rhythm_report', pattern: /晨检|日终|周报.*异常|月评|闭环率|运营周报|运营月报/ },
  { category: 'data_audit', pattern: /数据|报表|营收|毛利|人工|核对|异常|周报|月报|日报|审计|周度|月度/ }
];

function extractStore(text) {
  const s = String(text || '').trim();
  const knownStores = ['洪潮', '马己仙', '马己仙海鲜', '洪潮海鲜', '蜀香', '湘味', '御膳'];
  for (const name of knownStores) {
    if (s.includes(name)) return name;
  }
  const clean = (v) => String(v || '')
    .replace(/^(关于|针对)/, '')
    .replace(/的$/, '')
    .replace(/(卫生|清洁|服务|出品|菜品|数据|营销|培训|整改|情况|门店|店铺)$/, '');
  const direct = s.match(/(?:关于|针对)?\s*([\u4e00-\u9fa5]{2,4})(?:门店|店铺|店|的)?(?:的)?(?:卫生|清洁|服务|出品|菜品|数据|营销|培训|整改|情况|太差|很差|不好|异常)/);
  if (direct?.[1] && direct[1].length <= 4) return clean(direct[1]);
  const beforeToo = s.match(/([\u4e00-\u9fa5]{2,4})(?:的)?.{0,4}(?:太差|很差|不好|异常|整改|不新鲜)/);
  return beforeToo?.[1] && beforeToo[1].length <= 4 ? clean(beforeToo[1]) : null;
}

function extractDeadline(text) {
  const s = String(text || '');
  const week = s.match(/(\d+)\s*周内/);
  if (week) return { type: 'relative_days', days: Number(week[1]) * 7 };
  const day = s.match(/(\d+)\s*天内/);
  if (day) return { type: 'relative_days', days: Number(day[1]) };
  const date = s.match(/(20\d{2}[-/.年]\d{1,2}[-/.月]\d{1,2})/);
  if (date) return { type: 'date', value: date[1].replace(/[年月/.]/g, '-').replace(/-$/, '') };
  return null;
}

function addDays(days) {
  const d = new Date();
  d.setDate(d.getDate() + Number(days || 0));
  return d.toISOString();
}

export function parseTaskText(content, options = {}) {
  const text = String(content || '').trim();
  const matched = CATEGORY_RULES.find((r) => r.pattern.test(text));
  const category = matched?.category || 'general';
  const deadline = extractDeadline(text);
  const store = options.store || extractStore(text);
  const priority = options.priority || (/紧急|马上|立即|严重|太差|很差/.test(text) ? 'high' : 'medium');
  const title = options.title || text.slice(0, 48) || 'Agent任务';

  const acceptanceRules = [];
  const evidenceRequirements = [];
  if (category === 'hygiene') {
    acceptanceRules.push('明确整改范围并提交执行说明');
    acceptanceRules.push('整改完成后进入管理员验收');
    evidenceRequirements.push({ type: 'photo', minCount: 4, scenes: ['前厅', '后厨', '洗手间', '仓库或重点问题区域'] });
  } else {
    acceptanceRules.push('提交执行结果说明');
    evidenceRequirements.push({ type: 'text', required: true });
  }

  return {
    title,
    detail: text,
    category,
    store,
    priority,
    deadline,
    deadlineAt: deadline?.type === 'relative_days' ? addDays(deadline.days) : deadline?.value || null,
    acceptanceRules,
    evidenceRequirements,
    suggestedSubtasks: buildSuggestedSubtasks(category, deadline)
  };
}

function buildSuggestedSubtasks(category, deadline) {
  if (category !== 'hygiene') return ['确认执行负责人', '完成任务并提交结果', '管理员验收'];
  const tasks = ['通知门店负责人确认整改计划', '安排卫生整改/大扫除并提交照片'];
  if (deadline?.type === 'relative_days' && deadline.days >= 7) tasks.push('中期复查并补充证据');
  tasks.push('到期终验并反馈管理员');
  return tasks;
}

export function mapBoardStatus(status) {
  if (['pending_audit', 'auditing'].includes(status)) return '待解析';
  if (['pending_dispatch'].includes(status)) return '已领取';
  if (['dispatched', 'viewed'].includes(status)) return '已分配';
  if (['in_progress', 'waiting_evidence'].includes(status)) return '已执行';
  if (['pending_response'].includes(status)) return '已完成';
  if (['pending_review'].includes(status)) return '待验收';
  if (['resolved', 'pending_settlement', 'settled', 'closed'].includes(status)) return '已结案';
  if (['rejected'].includes(status)) return '已打回';
  if (['escalated'].includes(status)) return '已升级';
  if (['hr_filed'].includes(status)) return '已备案';
  return status || '未知';
}

export async function parseTaskTextWithLLM(content, options = {}) {
  const ruleBased = parseTaskText(content, options);
  try {
    const { callLLM } = await import('./llm-provider.js');
    const prompt = `分析以下任务文本，提取结构化信息。只返回JSON：
{"title":"简短标题","category":"hygiene|food_quality|service|training|marketing|data_audit|general","store":"门店名","priority":"high|medium|low","deadline_days":7,"acceptance_rules":["规则1","规则2"],"evidence_requirements":[{"type":"photo","minCount":4}],"subtasks":["子任务1","子任务2"]}

任务文本：${content}
${options.store ? '门店：' + options.store : ''}`;

    const resp = await callLLM(prompt, { max_tokens: 300, temperature: 0.1 });
    const parsed = JSON.parse((resp?.content || resp || '').replace(/```json\n?|```/g, '').trim());
    return {
      ...ruleBased,
      title: parsed.title || ruleBased.title,
      category: parsed.category || ruleBased.category,
      store: parsed.store || ruleBased.store,
      priority: parsed.priority || ruleBased.priority,
      deadlineAt: parsed.deadline_days ? addDays(parsed.deadline_days) : ruleBased.deadlineAt,
      deadline: parsed.deadline_days ? { type: 'relative_days', days: parsed.deadline_days } : ruleBased.deadline,
      acceptanceRules: parsed.acceptance_rules?.length ? parsed.acceptance_rules : ruleBased.acceptanceRules,
      evidenceRequirements: parsed.evidence_requirements?.length ? parsed.evidence_requirements : ruleBased.evidenceRequirements,
      suggestedSubtasks: parsed.subtasks?.length ? parsed.subtasks : ruleBased.suggestedSubtasks,
      llmEnhanced: true
    };
  } catch (e) {
    return { ...ruleBased, llmEnhanced: false, llmError: e?.message };
  }
}

export function generateSubtasks(parsedTask) {
  const { category, store, deadline } = parsedTask;
  const tasks = [];
  if (category === 'hygiene') {
    tasks.push({ title: `通知${store || '门店'}负责人确认整改计划`, auto: false });
    tasks.push({ title: '安排卫生整改/大扫除并提交照片', auto: false });
    if (deadline?.type === 'relative_days' && deadline.days >= 7) {
      tasks.push({ title: '中期复查并补充证据', auto: true, delayDays: Math.floor(deadline.days / 2) });
    }
    tasks.push({ title: '到期终验并反馈管理员', auto: true, delayDays: deadline?.days });
  } else if (category === 'food_quality') {
    tasks.push({ title: '确认出品问题并提交整改说明', auto: false });
    tasks.push({ title: '管理员验收出品整改', auto: true });
  } else {
    tasks.push({ title: '确认执行负责人', auto: false });
    tasks.push({ title: '完成任务并提交结果', auto: false });
    tasks.push({ title: '管理员验收', auto: true });
  }
  return tasks;
}
