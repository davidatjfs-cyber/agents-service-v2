import { pool } from './agents.js';
import { isHrmsAgentV1Enabled } from './safety.js';

// ─── Feature Flags（降级开关）────────────────────────────────
// 通过环境变量覆盖，例如 FEATURE_DISABLE_METRIC_DICTIONARY=true
export const AGENT_FEATURE_FLAGS = {
  // 阶段1：指标字典 & 分析规则是否启用
  enable_metric_dictionary: process.env.FEATURE_DISABLE_METRIC_DICTIONARY !== 'true',
  // 阶段1：session state 跨轮记忆
  enable_session_state: process.env.FEATURE_DISABLE_SESSION_STATE !== 'true',
  // 阶段2：Data Executor 确定性查询层
  enable_data_executor: process.env.FEATURE_DISABLE_DATA_EXECUTOR !== 'true',
  // 阶段2：Business Diagnosis Agent（LLM 约束分析层）
  enable_business_diagnosis: process.env.FEATURE_ENABLE_DIAGNOSIS === 'true',
  // 阶段3：规则引擎强路由（替代 LLM 路由）
  enable_rule_engine: process.env.FEATURE_DISABLE_RULE_ENGINE !== 'true',
};

const ALLOWED_MODEL_PREFIXES = ['qwen', 'deepseek', 'doubao'];
const FALLBACK_MODEL = 'qwen-max';

function normalizeModelName(v, fallback = FALLBACK_MODEL) {
  const model = String(v || '').trim();
  if (!model) return fallback;
  return ALLOWED_MODEL_PREFIXES.some((x) => model.startsWith(`${x}-`)) ? model : fallback;
}

function normalizeFrequency(v) {
  const x = String(v || '').trim();
  return ['daily', 'weekly', 'biweekly', 'monthly', 'custom'].includes(x) ? x : 'daily';
}

function normalizeOpsType(v) {
  const raw = String(v || '').trim();
  if (!raw) return 'opening';
  return raw;
}

function normalizeOpsStore(v) {
  return String(v || '').trim();
}

const DEFAULT_AGENTS = [
  {
    agent_id: 'master',
    name: 'Master Agent (调度中枢)',
    description: '作为唯一的飞书 API 入口，负责消息路由、任务状态流转和全局上下文管理',
    system_prompt: '你是 HRMS 系统的 Master Agent，负责调度和任务流转。',
    model_name: 'qwen-max',
    temperature: 0.1,
    enabled: true,
    schedule_interval: 1
  },
  {
    agent_id: 'data_auditor',
    name: 'Data Auditor Agent (数据审计)',
    description: '核对来源数据，对异常情况触发预警',
    system_prompt: '你是数据审计 Agent，负责从业务报表和客诉数据中发现异常。',
    model_name: 'qwen-max',
    temperature: 0.1,
    enabled: true,
    schedule_interval: 30
  },
  {
    agent_id: 'ops_supervisor',
    name: 'Ops Agent (营运督导)',
    description: '负责飞书端的任务分派、到点提醒、以及利用 Vision 能力审核员工上传的照片',
    system_prompt: '你是营运督导 Agent，负责跟进异常任务的整改并审核照片。',
    model_name: 'qwen-max',
    temperature: 0.2,
    enabled: true,
    schedule_interval: 1
  },
  {
    agent_id: 'sop_advisor',
    name: 'SOP Agent (标准库)',
    description: '管理所有运营标准，提供 RAG 知识检索，支撑其他 Agent 的判罚依据',
    system_prompt: '你是 SOP 顾问 Agent，负责解答运营标准相关问题。',
    model_name: 'qwen-max',
    temperature: 0.1,
    enabled: true,
    schedule_interval: 0
  },
  {
    agent_id: 'chief_evaluator',
    name: 'Chief Evaluator (绩效考核)',
    description: '根据行为和数据结果，自动计算奖金，评分，评级的功能',
    system_prompt: '你是绩效考核 Agent，负责根据任务解决情况进行扣分和结算。',
    model_name: 'qwen-max',
    temperature: 0.1,
    enabled: true,
    schedule_interval: 60
  },
  {
    agent_id: 'appeal_handler',
    name: 'Appeal Agent (申诉处理)',
    description: '处理员工反馈，核实证据，并具备人工介入仲裁的逻辑',
    system_prompt: '你是申诉处理 Agent，负责处理员工对扣分或处罚的异议。',
    model_name: 'qwen-max',
    temperature: 0.2,
    enabled: true,
    schedule_interval: 0
  }
];

const DEFAULT_RULES = [
  { category: '桌访占比异常', assignee_role: 'store_manager', normal_deduction: 2, major_deduction: 5 },
  { category: '实收营收异常', assignee_role: 'store_manager', normal_deduction: 2, major_deduction: 5 },
  { category: '人效值异常', assignee_role: 'store_manager', normal_deduction: 2, major_deduction: 5 },
  { category: '充值异常', assignee_role: 'store_manager', normal_deduction: 2, major_deduction: 5 },
  { category: '总实收毛利率异常', assignee_role: 'store_production_manager', normal_deduction: 5, major_deduction: 10 },
  { category: '产品差评异常', assignee_role: 'store_production_manager', normal_deduction: 10, major_deduction: 15 },
  { category: '服务差评异常', assignee_role: 'store_manager', normal_deduction: 10, major_deduction: 15 },
  { category: '桌访产品异常', assignee_role: 'store_production_manager', normal_deduction: 5, major_deduction: 10 }
];

// 部署时需要从DB删除已移除的规则类别
const REMOVED_RULE_CATEGORIES = ['图片审核不合格', '原料收货异常', '原料不满意', '桌访异常', '桌访连续投诉'];

const DEFAULT_PROMPT_TEMPLATES = [
  { template_key: 'master_default_v1', agent_id: 'master', name: 'Master 默认模板', content: '你是 HRMS 系统的 Master Agent，负责调度和任务流转。', enabled: true, is_builtin: true },
  { template_key: 'data_auditor_default_v1', agent_id: 'data_auditor', name: 'BI 默认模板', content: '你是数据审计 Agent，负责从业务报表和客诉数据中发现异常。', enabled: true, is_builtin: true },
  { template_key: 'ops_supervisor_default_v1', agent_id: 'ops_supervisor', name: 'OP 默认模板', content: '你是营运督导 Agent，负责跟进异常任务的整改并审核照片。', enabled: true, is_builtin: true },
  { template_key: 'sop_advisor_default_v1', agent_id: 'sop_advisor', name: 'SOP 默认模板', content: '你是 SOP 顾问 Agent，负责解答运营标准相关问题。', enabled: true, is_builtin: true },
  { template_key: 'appeal_handler_default_v1', agent_id: 'appeal_handler', name: '申诉 默认模板', content: '你是申诉处理 Agent，负责处理员工对扣分或处罚的异议。', enabled: true, is_builtin: true }
];

const DEFAULT_REPLY_TEMPLATES = [
  { template_key: 'reply_master_default_v1', agent_id: 'master', name: 'Master 标准回复', content: '收到，我会立即按优先级分派并跟进处理进度。', enabled: true, is_builtin: true },
  { template_key: 'reply_data_auditor_default_v1', agent_id: 'data_auditor', name: 'BI 异常回复', content: '检测到异常，已生成问题卡片并推送责任人，请在规定时限内整改。', enabled: true, is_builtin: true },
  { template_key: 'reply_ops_supervisor_default_v1', agent_id: 'ops_supervisor', name: 'OP 巡检回复', content: '巡检任务已下发，请按清单逐项完成并回传证明材料。', enabled: true, is_builtin: true },
  { template_key: 'reply_chief_evaluator_default_v1', agent_id: 'chief_evaluator', name: '考核结果回复', content: '本期考核已完成，分数与扣分项已同步，可在绩效页面查看详情。', enabled: true, is_builtin: true }
];

function normalizeBiAnomalyDictionary(v) {
  const list = Array.isArray(v) ? v : [];
  const out = [];
  const seen = new Set();
  for (const item of list) {
    const key = String(item?.key || '').trim();
    const category = String(item?.category || item?.label || '').trim();
    if (!key || !category || seen.has(key)) continue;
    seen.add(key);
    out.push({
      key,
      category,
      label: String(item?.label || category).trim() || category,
      enabled: item?.enabled !== false
    });
  }
  if (out.length) return out;
  return DEFAULT_RULES.map((r) => ({
    key: `rule_${String(r.category).replace(/[^a-zA-Z0-9\u4e00-\u9fa5]+/g, '_')}`,
    category: r.category,
    label: r.category,
    enabled: true
  }));
}

const DEFAULT_EMPLOYEE_RATING_CONFIG = {
  levelLabels: { A: 'A', B: 'B', C: 'C', D: 'D' },
  execution: {
    store_production_manager: {
      hongchao: {
        dataSources: ['收档报告DB', '开档报告', '洪潮原料收货日报'],
        A_max_missing: 6, B_max_missing: 13, C_max_missing: 20, D_min_missing: 22
      },
      majixian: {
        dataSources: ['收档报告DB', '开档报告', '马己仙原料收货日报'],
        A_max_missing: 6, B_max_missing: 13, C_max_missing: 20, D_min_missing: 22
      }
    },
    store_manager: {
      hongchao: { A_min_new_members: 300, B_min_new_members: 249, C_min_new_members: 200, D_max_new_members: 199 },
      majixian: { low_score_threshold: 7, A_max_missing: 2, A_max_low_score: 2, B_max_missing: 4, B_max_low_score: 4, C_max_missing: 6, C_max_low_score: 6, D_min_missing: 7, D_min_low_score: 7 }
    }
  },
  attitude: { A_max_incomplete: 2, B_max_incomplete: 4, C_max_incomplete: 8, D_min_incomplete: 9 },
  ability: {
    store_production_manager: { A_min_diff: 1.01, B_min_diff: -1, B_max_diff: 1, C_min_diff: -2, C_max_diff: -1.01, D_max_diff: -2 },
    store_manager: {
      hongchao: { A_min_rating: 4.6, B_min_rating: 4.5, C_min_rating: 4.3, D_max_rating: 4.2 },
      majixian: { A_min_rating: 4.5, B_min_rating: 4.4, C_min_rating: 4.0, D_max_rating: 3.9 }
    }
  }
};

function normalizeOpsAgentConfig(cfg) {
  const c = cfg && typeof cfg === 'object' ? cfg : {};
  const normalizedDaily = (Array.isArray(c?.scheduledTasks?.dailyInspections)
    ? c.scheduledTasks.dailyInspections
    : []
  ).map((x) => ({
    store: normalizeOpsStore(x?.store),
    brand: String(x?.brand || '').trim(),
    type: normalizeOpsType(x?.type),
    time: String(x?.time || '').trim() || '10:00',
    frequency: normalizeFrequency(x?.frequency),
    customIntervalDays: Math.max(1, Math.floor(Number(x?.customIntervalDays) || 1)),
    timeWindow: Math.max(5, Math.floor(Number(x?.timeWindow) || 60)),
    formUrl: String(x?.formUrl || '').trim(),
    checklist: Array.isArray(x?.checklist) ? x.checklist.map((v) => String(v || '').trim()).filter(Boolean) : []
  }));
  const normalizedRandom = (Array.isArray(c?.scheduledTasks?.randomInspections)
    ? c.scheduledTasks.randomInspections
    : []
  ).map((x) => {
    const store = normalizeOpsStore(x?.store);
    const brand = String(x?.brand || '').trim();
    const minH = Math.max(1, Math.floor(Number(x?.intervalMinHours) || Number(x?.interval?.[0]) || 2));
    const maxH = Math.max(minH, Math.floor(Number(x?.intervalMaxHours) || Number(x?.interval?.[1]) || 4));
    const roles = Array.isArray(x?.assigneeRoles)
      ? x.assigneeRoles.map((r) => String(r || '').trim()).filter(Boolean)
      : [];
    return {
      type: String(x?.type || '').trim() || '食安抽检',
      description: String(x?.description || '').trim() || '食安抽检',
      timeWindow: Math.max(1, Math.floor(Number(x?.timeWindow) || 15)),
      store,
      brand,
      assigneeRoles: roles.length ? roles : ['store_manager', 'store_production_manager'],
      intervalMinHours: minH,
      intervalMaxHours: maxH
    };
  });

  const dtDefault = DEFAULT_OPS_AGENT_CONFIG.scheduledTasks?.dataTriggers || {};
  const dtUser = c?.scheduledTasks?.dataTriggers && typeof c.scheduledTasks.dataTriggers === 'object'
    ? c.scheduledTasks.dataTriggers
    : {};

  return {
    ...DEFAULT_OPS_AGENT_CONFIG,
    ...c,
    llmModels: {
      reasoningModel: normalizeModelName(c?.llmModels?.reasoningModel, DEFAULT_OPS_AGENT_CONFIG.llmModels.reasoningModel),
      visionModel: String(c?.llmModels?.visionModel || '').startsWith('doubao-') || String(c?.llmModels?.visionModel || '').startsWith('ep-')
        ? String(c.llmModels.visionModel)
        : DEFAULT_OPS_AGENT_CONFIG.llmModels.visionModel
    },
    // 每日定时巡检 / 随机抽检仅以库内显式配置为准，不再从默认种子合并进「有效任务」
    scheduledTasks: {
      dataTriggers: { ...dtDefault, ...dtUser },
      dailyInspections: normalizedDaily,
      randomInspections: normalizedRandom
    }
  };
}

function normalizeBiAnomalyTriggers(raw) {
  const defaults = DEFAULT_BI_AGENT_CONFIG.anomalyTriggers;
  if (!raw || typeof raw !== 'object') return { ...defaults };
  // 兼容旧的flat格式：如果没有global key，整个对象就是global
  if (!raw.global && !raw.storeOverrides) {
    return { global: { ...defaults.global, ...raw }, storeOverrides: { ...(defaults.storeOverrides || {}) } };
  }
  const global = { ...defaults.global, ...(raw.global || {}) };
  const storeOverrides = {};
  const rawOverrides = raw.storeOverrides && typeof raw.storeOverrides === 'object' ? raw.storeOverrides : {};
  for (const [store, overrides] of Object.entries(rawOverrides)) {
    if (overrides && typeof overrides === 'object') {
      storeOverrides[store] = { ...overrides };
    }
  }
  return { global, storeOverrides };
}

function normalizeBiAgentConfig(cfg) {
  const c = cfg && typeof cfg === 'object' ? cfg : {};
  const sourceMap = new Map((Array.isArray(c?.dataSources) ? c.dataSources : []).map((x) => [String(x?.key || '').trim(), x]));
  return {
    ...DEFAULT_BI_AGENT_CONFIG,
    ...c,
    dataSources: DEFAULT_BI_AGENT_CONFIG.dataSources.map((base) => {
      const hit = sourceMap.get(base.key) || {};
      return {
        ...base,
        ...hit,
        key: base.key,
        label: String(hit.label || base.label),
        sourceType: String(hit.sourceType || base.sourceType),
        enabled: hit.enabled === undefined ? base.enabled : !!hit.enabled
      };
    }),
    anomalyTriggers: normalizeBiAnomalyTriggers(c?.anomalyTriggers),
    anomalyDictionary: normalizeBiAnomalyDictionary(c?.anomalyDictionary)
  };
}

export const DEFAULT_BI_AGENT_CONFIG = {
  dataSources: [
    { key: 'daily_reports', label: '营业日报（系统）', sourceType: 'system', enabled: true },
    { key: 'table_visit_records', label: '桌访记录（系统入库）', sourceType: 'system', enabled: true },
    { key: 'table_visit_bitable', label: '桌访表（飞书）', sourceType: 'bitable', enabled: true },
    { key: 'opening_reports_bitable', label: '开档报告（飞书）', sourceType: 'bitable', enabled: true },
    { key: 'closing_reports_bitable', label: '收档报告DB（飞书）', sourceType: 'bitable', enabled: true },
    { key: 'meeting_reports_bitable', label: '例会报告（飞书）', sourceType: 'bitable', enabled: true },
    { key: 'bad_reviews', label: '差评报告（飞书）', sourceType: 'bitable', enabled: true },
    { key: 'material_majixian_bitable', label: '马己仙原料收货日报（飞书）', sourceType: 'bitable', enabled: true },
    { key: 'material_hongchao_bitable', label: '洪潮原料收货日报（飞书）', sourceType: 'bitable', enabled: true },
    { key: 'ops_checklist_bitable', label: '开-收档检查表（飞书）', sourceType: 'bitable', enabled: true }
  ],
  anomalyTriggers: {
    global: {
      revenueGapMedium: 0.10,
      revenueGapHigh: 0.20,
      efficiencyMedium: 1100,
      efficiencyHigh: 1000,
      marginMedium: 0.69,
      marginHigh: 0.68,
      tableVisitProductMedium: 2,
      tableVisitProductHigh: 4,
      tableVisitRatioMedium: 0.5,
      tableVisitRatioHigh: 0.4,
      badReviewMedium: 1,
      badReviewHigh: 2,
      rechargeStreakHighDays: 2
    },
    storeOverrides: {
      '马己仙上海音乐广场店': {
        efficiencyMedium: 1400,
        efficiencyHigh: 1300,
        marginMedium: 0.64,
        marginHigh: 0.63
      }
    }
  },
  anomalyDictionary: DEFAULT_RULES.map((r) => ({
    key: `rule_${String(r.category).replace(/[^a-zA-Z0-9\u4e00-\u9fa5]+/g, '_')}`,
    category: r.category,
    label: r.category,
    enabled: true
  }))
};

export const DEFAULT_OPS_AGENT_CONFIG = {
  dispatchers: ['store_manager', 'store_production_manager'], // 派单人员角色
  llmModels: {
    reasoningModel: 'qwen-max',
    visionModel: 'ep-20260424183833-7lr9g'
  },
  scheduledTasks: {
    dailyInspections: [],
    randomInspections: [],
    dataTriggers: {
      productComplaintThreshold: 2, 
      marginDeviationThreshold: 0.01,
      tableVisitRatioThreshold: 0.50  
    }
  }
};

function toJson(v, fallback = {}) {
  try { return typeof v === 'string' ? JSON.parse(v) : (v || fallback); } catch (_) { return fallback; }
}

function toFinite(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeEmployeeRatingConfig(cfg) {
  const c = cfg && typeof cfg === 'object' ? cfg : {};
  const labels = c?.levelLabels && typeof c.levelLabels === 'object' ? c.levelLabels : {};
  const ex = c.execution || {};
  const at = c.attitude || {};
  const ab = c.ability || {};
  const ePm = ex.store_production_manager || {};
  const eMgrHz = ex.store_manager?.hongchao || {};
  const eMgrMjx = ex.store_manager?.majixian || {};
  const bPm = ab.store_production_manager || {};
  const bMgrHz = ab.store_manager?.hongchao || {};
  const bMgrMjx = ab.store_manager?.majixian || {};

  return {
    levelLabels: {
      A: String(labels.A || DEFAULT_EMPLOYEE_RATING_CONFIG.levelLabels.A || 'A').trim() || 'A',
      B: String(labels.B || DEFAULT_EMPLOYEE_RATING_CONFIG.levelLabels.B || 'B').trim() || 'B',
      C: String(labels.C || DEFAULT_EMPLOYEE_RATING_CONFIG.levelLabels.C || 'C').trim() || 'C',
      D: String(labels.D || DEFAULT_EMPLOYEE_RATING_CONFIG.levelLabels.D || 'D').trim() || 'D'
    },
    execution: {
      store_production_manager: {
        A_max_missing: toFinite(ePm.A_max_missing ?? ePm.threshold_A, 6),
        B_max_missing: toFinite(ePm.B_max_missing ?? ePm.threshold_B, 13),
        C_max_missing: toFinite(ePm.C_max_missing ?? ePm.threshold_C, 20),
        D_min_missing: toFinite(ePm.D_min_missing ?? ePm.threshold_D, 21)
      },
      store_manager: {
        hongchao: {
          A_min_new_members: toFinite(eMgrHz.A_min_new_members ?? eMgrHz.min_A, 300),
          B_min_new_members: toFinite(eMgrHz.B_min_new_members ?? eMgrHz.min_B, 249),
          C_min_new_members: toFinite(eMgrHz.C_min_new_members ?? eMgrHz.min_C, 200),
          D_max_new_members: toFinite(eMgrHz.D_max_new_members ?? eMgrHz.max_D, 199)
        },
        majixian: {
          low_score_threshold: toFinite(eMgrMjx.low_score_threshold, 7),
          A_max_missing: toFinite(eMgrMjx.A_max_missing ?? eMgrMjx.max_missing_A, 2),
          A_max_low_score: toFinite(eMgrMjx.A_max_low_score ?? eMgrMjx.max_low_A, 2),
          B_max_missing: toFinite(eMgrMjx.B_max_missing ?? eMgrMjx.max_missing_B, 4),
          B_max_low_score: toFinite(eMgrMjx.B_max_low_score ?? eMgrMjx.max_low_B, 4),
          C_max_missing: toFinite(eMgrMjx.C_max_missing ?? eMgrMjx.max_missing_C, 6),
          C_max_low_score: toFinite(eMgrMjx.C_max_low_score ?? eMgrMjx.max_low_C, 6),
          D_min_missing: toFinite(eMgrMjx.D_min_missing ?? eMgrMjx.min_missing_D, 7),
          D_min_low_score: toFinite(eMgrMjx.D_min_low_score ?? eMgrMjx.min_low_D, 7)
        }
      }
    },
    attitude: {
      A_max_incomplete: toFinite(at.A_max_incomplete ?? at.threshold_A, 2),
      B_max_incomplete: toFinite(at.B_max_incomplete ?? at.threshold_B, 4),
      C_max_incomplete: toFinite(at.C_max_incomplete ?? at.threshold_C, 8),
      D_min_incomplete: toFinite(at.D_min_incomplete ?? at.threshold_D, 9)
    },
    ability: {
      store_production_manager: {
        A_min_diff: toFinite(bPm.A_min_diff ?? bPm.min_A, 1.01),
        B_min_diff: toFinite(bPm.B_min_diff ?? bPm.min_B, -1),
        B_max_diff: toFinite(bPm.B_max_diff ?? bPm.max_B, 1),
        C_min_diff: toFinite(bPm.C_min_diff ?? bPm.min_C, -2),
        C_max_diff: toFinite(bPm.C_max_diff ?? bPm.max_C, -1.01),
        D_max_diff: toFinite(bPm.D_max_diff ?? bPm.max_D, -2)
      },
      store_manager: {
        hongchao: {
          A_min_rating: toFinite(bMgrHz.A_min_rating ?? bMgrHz.min_A, 4.6),
          B_min_rating: toFinite(bMgrHz.B_min_rating ?? bMgrHz.min_B, 4.5),
          C_min_rating: toFinite(bMgrHz.C_min_rating ?? bMgrHz.min_C, 4.3),
          D_max_rating: toFinite(bMgrHz.D_max_rating ?? bMgrHz.max_D, 4.2)
        },
        majixian: {
          A_min_rating: toFinite(bMgrMjx.A_min_rating ?? bMgrMjx.min_A, 4.5),
          B_min_rating: toFinite(bMgrMjx.B_min_rating ?? bMgrMjx.min_B, 4.4),
          C_min_rating: toFinite(bMgrMjx.C_min_rating ?? bMgrMjx.min_C, 4.0),
          D_max_rating: toFinite(bMgrMjx.D_max_rating ?? bMgrMjx.max_D, 3.9)
        }
      }
    }
  };
}

function validateEmployeeRatingConfig(cfg) {
  if (!cfg || typeof cfg !== 'object') return false;
  const normalized = normalizeEmployeeRatingConfig(cfg);
  const ex = normalized.execution || {};
  const at = normalized.attitude || {};
  const ab = normalized.ability || {};
  const ePm = ex.store_production_manager || {};
  const eMgrHz = ex.store_manager?.hongchao || {};
  const eMgrMjx = ex.store_manager?.majixian || {};
  const a = at || {};
  const bPm = ab.store_production_manager || {};
  const bMgrHz = ab.store_manager?.hongchao || {};
  const bMgrMjx = ab.store_manager?.majixian || {};
  const checks = [
    ePm.A_max_missing, ePm.B_max_missing, ePm.C_max_missing, ePm.D_min_missing,
    eMgrHz.A_min_new_members, eMgrHz.B_min_new_members, eMgrHz.C_min_new_members, eMgrHz.D_max_new_members,
    eMgrMjx.low_score_threshold, eMgrMjx.A_max_missing, eMgrMjx.A_max_low_score,
    eMgrMjx.B_max_missing, eMgrMjx.B_max_low_score, eMgrMjx.C_max_missing, eMgrMjx.C_max_low_score, eMgrMjx.D_min_missing, eMgrMjx.D_min_low_score,
    a.A_max_incomplete, a.B_max_incomplete, a.C_max_incomplete, a.D_min_incomplete,
    bPm.A_min_diff, bPm.B_min_diff, bPm.B_max_diff, bPm.C_min_diff, bPm.C_max_diff, bPm.D_max_diff,
    bMgrHz.A_min_rating, bMgrHz.B_min_rating, bMgrHz.C_min_rating, bMgrHz.D_max_rating,
    bMgrMjx.A_min_rating, bMgrMjx.B_min_rating, bMgrMjx.C_min_rating, bMgrMjx.D_max_rating
  ];
  return checks.every((v) => Number.isFinite(Number(v)));
}

export async function ensureAgentConfigTables() {
  try {
    await pool().query('create extension if not exists pgcrypto');
    
    // 1. Agent 基础配置表
    await pool().query(`
      create table if not exists agent_configs (
        id uuid primary key default gen_random_uuid(),
        agent_id varchar(50) unique not null,
        name varchar(100) not null,
        description text,
        system_prompt text,
        model_name varchar(50) default 'qwen-plus',
        temperature decimal(3,2) default 0.1,
        enabled boolean default true,
        schedule_interval int default 30,
        updated_at timestamp default current_timestamp
      )
    `);

    await pool().query(`
      create table if not exists agent_reply_templates (
        id uuid primary key default gen_random_uuid(),
        template_key varchar(120) unique not null,
        agent_id varchar(50) not null,
        name varchar(120) not null,
        content text not null,
        enabled boolean default true,
        is_builtin boolean default false,
        created_at timestamp default current_timestamp,
        updated_at timestamp default current_timestamp
      )
    `);

    await pool().query(`
      alter table agent_configs
      add column if not exists prompt_template_id uuid
    `);

    await pool().query(`
      alter table agent_configs
      add column if not exists reply_template_id uuid
    `);

    // 2. 异常扣分与责任人路由规则表
    await pool().query(`
      create table if not exists agent_rules (
        id uuid primary key default gen_random_uuid(),
        category varchar(100) unique not null,
        assignee_role varchar(100) not null,
        normal_deduction int default 10,
        major_deduction int default 20,
        enabled boolean default true,
        updated_at timestamp default current_timestamp
      )
    `);

    await pool().query(`
      create table if not exists agent_prompt_templates (
        id uuid primary key default gen_random_uuid(),
        template_key varchar(120) unique not null,
        agent_id varchar(50) not null,
        name varchar(120) not null,
        content text not null,
        enabled boolean default true,
        is_builtin boolean default false,
        created_at timestamp default current_timestamp,
        updated_at timestamp default current_timestamp
      )
    `);

    await pool().query(`
      create table if not exists hr_rating_configs (
        id uuid primary key default gen_random_uuid(),
        config_key varchar(80) unique not null,
        config jsonb not null,
        enabled boolean default true,
        updated_at timestamp default current_timestamp
      )
    `);

    await pool().query(`
      alter table agent_configs
      add constraint fk_agent_prompt_template
      foreign key (prompt_template_id) references agent_prompt_templates(id)
      on delete set null
    `).catch(() => null);

    await pool().query(`
      alter table agent_configs
      add constraint fk_agent_reply_template
      foreign key (reply_template_id) references agent_reply_templates(id)
      on delete set null
    `).catch(() => null);

    const templateIdMap = {};
    for (const tpl of DEFAULT_PROMPT_TEMPLATES) {
      const tr = await pool().query(
        `insert into agent_prompt_templates (template_key, agent_id, name, content, enabled, is_builtin)
         values ($1, $2, $3, $4, $5, $6)
         on conflict (template_key)
         do update set name = excluded.name, content = excluded.content, enabled = excluded.enabled, updated_at = now()
         returning id, template_key`,
        [tpl.template_key, tpl.agent_id, tpl.name, tpl.content, tpl.enabled !== false, tpl.is_builtin === true]
      );
      const row = tr.rows?.[0];
      if (row?.template_key && row?.id) templateIdMap[row.template_key] = row.id;
    }

    const replyTemplateIdMap = {};
    for (const tpl of DEFAULT_REPLY_TEMPLATES) {
      const tr = await pool().query(
        `insert into agent_reply_templates (template_key, agent_id, name, content, enabled, is_builtin)
         values ($1, $2, $3, $4, $5, $6)
         on conflict (template_key)
         do update set name = excluded.name, content = excluded.content, enabled = excluded.enabled, updated_at = now()
         returning id, template_key`,
        [tpl.template_key, tpl.agent_id, tpl.name, tpl.content, tpl.enabled !== false, tpl.is_builtin === true]
      );
      const row = tr.rows?.[0];
      if (row?.template_key && row?.id) replyTemplateIdMap[row.template_key] = row.id;
    }

    // 初始化默认 Agent 数据
    for (const agent of DEFAULT_AGENTS) {
      const defaultTpl = DEFAULT_PROMPT_TEMPLATES.find((x) => x.agent_id === agent.agent_id);
      const promptTemplateId = defaultTpl ? (templateIdMap[defaultTpl.template_key] || null) : null;
      const defaultReplyTpl = DEFAULT_REPLY_TEMPLATES.find((x) => x.agent_id === agent.agent_id);
      const replyTemplateId = defaultReplyTpl ? (replyTemplateIdMap[defaultReplyTpl.template_key] || null) : null;
      await pool().query(`
        insert into agent_configs (agent_id, name, description, system_prompt, model_name, temperature, enabled, schedule_interval, prompt_template_id, reply_template_id)
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        on conflict (agent_id) do nothing
      `, [agent.agent_id, agent.name, agent.description, agent.system_prompt, agent.model_name, agent.temperature, agent.enabled, agent.schedule_interval, promptTemplateId, replyTemplateId]);

      if (promptTemplateId) {
        await pool().query(
          `update agent_configs set prompt_template_id = coalesce(prompt_template_id, $1) where agent_id = $2`,
          [promptTemplateId, agent.agent_id]
        );
      }
      if (replyTemplateId) {
        await pool().query(
          `update agent_configs set reply_template_id = coalesce(reply_template_id, $1) where agent_id = $2`,
          [replyTemplateId, agent.agent_id]
        );
      }
    }

    // 删除已移除的规则类别
    if (REMOVED_RULE_CATEGORIES.length) {
      await pool().query(`DELETE FROM agent_rules WHERE category = ANY($1)`, [REMOVED_RULE_CATEGORIES]);
      console.log('[AgentConfig] Removed deprecated rule categories:', REMOVED_RULE_CATEGORIES.join(', '));
    }

    // 初始化默认 Rule 数据
    for (const rule of DEFAULT_RULES) {
      await pool().query(`
        insert into agent_rules (category, assignee_role, normal_deduction, major_deduction)
        values ($1, $2, $3, $4)
        on conflict (category) do nothing
      `, [rule.category, rule.assignee_role, rule.normal_deduction, rule.major_deduction]);
    }

    await pool().query(
      `insert into hr_rating_configs (config_key, config, enabled)
       values ('employee_rating', $1::jsonb, true)
       on conflict (config_key) do nothing`,
      [JSON.stringify(DEFAULT_EMPLOYEE_RATING_CONFIG)]
    );

    await pool().query(
      `insert into hr_rating_configs (config_key, config, enabled)
       values ('ops_agent', $1::jsonb, true)
       on conflict (config_key) do nothing`,
      [JSON.stringify(DEFAULT_OPS_AGENT_CONFIG)]
    );

    await pool().query(
      `insert into hr_rating_configs (config_key, config, enabled)
       values ('bi_agent', $1::jsonb, true)
       on conflict (config_key) do nothing`,
      [JSON.stringify(DEFAULT_BI_AGENT_CONFIG)]
    );
    
    console.log('[AgentConfig] Tables ensured and default data seeded.');
  } catch (e) {
    console.error('[AgentConfig] Init error:', e);
  }
}

export function registerAgentConfigRoutes(app, authRequired) {
  const assertAdmin = (req, res) => {
    const role = String(req.user?.role || '').trim();
    if (!['admin', 'hq_manager', 'hr_manager'].includes(role) && !role.startsWith('custom_')) {
      res.status(403).json({ error: 'forbidden' });
      return false;
    }
    return true;
  };

  // === Agent Configs ===
  app.get('/api/admin/agents/configs', authRequired, async (req, res) => {
    if (!assertAdmin(req, res)) return;
    try {
      const r = await pool().query(`
        select c.*, t.name as prompt_template_name, rt.name as reply_template_name
        from agent_configs c
        left join agent_prompt_templates t on c.prompt_template_id = t.id
        left join agent_reply_templates rt on c.reply_template_id = rt.id
        order by c.agent_id
      `);
      res.json({ configs: r.rows });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // === Reply Templates ===
  app.get('/api/admin/agents/reply-templates', authRequired, async (req, res) => {
    if (!assertAdmin(req, res)) return;
    const agentId = String(req.query?.agent_id || '').trim();
    try {
      if (agentId) {
        const r = await pool().query(
          `select * from agent_reply_templates where agent_id = $1 order by is_builtin desc, updated_at desc`,
          [agentId]
        );
        return res.json({ templates: r.rows });
      }
      const r = await pool().query('select * from agent_reply_templates order by agent_id, is_builtin desc, updated_at desc');
      return res.json({ templates: r.rows });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/admin/agents/reply-templates', authRequired, async (req, res) => {
    if (!assertAdmin(req, res)) return;
    const agentId = String(req.body?.agent_id || '').trim();
    const name = String(req.body?.name || '').trim();
    const content = String(req.body?.content || '').trim();
    const enabled = req.body?.enabled !== false;
    if (!agentId || !name || !content) return res.status(400).json({ error: 'missing_params' });
    try {
      const key = `custom_reply_${agentId}_${Date.now()}`;
      const r = await pool().query(
        `insert into agent_reply_templates (template_key, agent_id, name, content, enabled, is_builtin)
         values ($1, $2, $3, $4, $5, false)
         returning *`,
        [key, agentId, name, content, enabled]
      );
      return res.json({ template: r.rows[0] });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  });

  app.put('/api/admin/agents/reply-templates/:id', authRequired, async (req, res) => {
    if (!assertAdmin(req, res)) return;
    const id = String(req.params?.id || '').trim();
    if (!id) return res.status(400).json({ error: 'missing_id' });
    try {
      const old = await pool().query('select * from agent_reply_templates where id = $1 limit 1', [id]);
      if (!old.rows?.length) return res.status(404).json({ error: 'not_found' });
      const row = old.rows[0];
      if (row.is_builtin) {
        const enabled2 = req.body?.enabled === undefined ? row.enabled : !!req.body.enabled;
        const name2 = String(req.body?.name || row.name).trim() || row.name;
        const r = await pool().query(
          `update agent_reply_templates set name = $1, enabled = $2, updated_at = now() where id = $3 returning *`,
          [name2, enabled2, id]
        );
        return res.json({ template: r.rows[0], locked_content: true });
      }
      const name2 = String(req.body?.name || row.name).trim() || row.name;
      const content2 = String(req.body?.content || row.content).trim() || row.content;
      const enabled2 = req.body?.enabled === undefined ? row.enabled : !!req.body.enabled;
      const r = await pool().query(
        `update agent_reply_templates set name = $1, content = $2, enabled = $3, updated_at = now() where id = $4 returning *`,
        [name2, content2, enabled2, id]
      );
      return res.json({ template: r.rows[0] });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  });

  app.delete('/api/admin/agents/reply-templates/:id', authRequired, async (req, res) => {
    if (!assertAdmin(req, res)) return;
    const id = String(req.params?.id || '').trim();
    if (!id) return res.status(400).json({ error: 'missing_id' });
    try {
      const old = await pool().query('select * from agent_reply_templates where id = $1 limit 1', [id]);
      if (!old.rows?.length) return res.status(404).json({ error: 'not_found' });
      if (old.rows[0].is_builtin) return res.status(400).json({ error: 'builtin_template_cannot_delete' });
      const used = await pool().query('select count(*)::int as c from agent_configs where reply_template_id = $1', [id]);
      if (Number(used.rows?.[0]?.c || 0) > 0) return res.status(400).json({ error: 'template_in_use' });
      await pool().query('delete from agent_reply_templates where id = $1', [id]);
      return res.json({ ok: true });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  });

  app.put('/api/admin/agents/configs/:agent_id', authRequired, async (req, res) => {
    if (!assertAdmin(req, res)) return;
    const agentId = req.params.agent_id;
    const body = req.body || {};
    const { system_prompt, model_name, temperature, enabled, schedule_interval } = body;
    const hasTemplateField = Object.prototype.hasOwnProperty.call(body, 'prompt_template_id');
    const promptTemplateId = hasTemplateField ? String(body.prompt_template_id || '').trim() : null;
    const hasReplyTemplateField = Object.prototype.hasOwnProperty.call(body, 'reply_template_id');
    const replyTemplateId = hasReplyTemplateField ? String(body.reply_template_id || '').trim() : null;
    try {
      let nextPrompt = String(system_prompt || '').trim();
      if (hasTemplateField && promptTemplateId) {
        const t = await pool().query(
          `select id, content from agent_prompt_templates where id = $1 and enabled = true limit 1`,
          [promptTemplateId]
        );
        if (!t.rows?.length) return res.status(400).json({ error: 'invalid_prompt_template_id' });
        nextPrompt = String(t.rows[0].content || '').trim();
      }

      if (hasReplyTemplateField && replyTemplateId) {
        const rt = await pool().query(
          `select id from agent_reply_templates where id = $1 and enabled = true limit 1`,
          [replyTemplateId]
        );
        if (!rt.rows?.length) return res.status(400).json({ error: 'invalid_reply_template_id' });
      }
      const nextModelName = normalizeModelName(model_name, FALLBACK_MODEL);
      const r = await pool().query(`
        update agent_configs
        set system_prompt = $1,
            model_name = $2,
            temperature = $3,
            enabled = $4,
            schedule_interval = $5,
            prompt_template_id = case when $6 then nullif($7, '')::uuid else prompt_template_id end,
            reply_template_id = case when $8 then nullif($9, '')::uuid else reply_template_id end,
            updated_at = now()
        where agent_id = $10 returning *
      `, [nextPrompt, nextModelName, temperature, enabled, schedule_interval, hasTemplateField, promptTemplateId, hasReplyTemplateField, replyTemplateId, agentId]);
      clearAgentConfigCache();
      res.json({ config: r.rows[0] });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // === Prompt Templates ===
  app.get('/api/admin/agents/templates', authRequired, async (req, res) => {
    if (!assertAdmin(req, res)) return;
    const agentId = String(req.query?.agent_id || '').trim();
    try {
      if (agentId) {
        const r = await pool().query(
          `select * from agent_prompt_templates where agent_id = $1 order by is_builtin desc, updated_at desc`,
          [agentId]
        );
        return res.json({ templates: r.rows });
      }
      const r = await pool().query('select * from agent_prompt_templates order by agent_id, is_builtin desc, updated_at desc');
      return res.json({ templates: r.rows });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/admin/agents/templates', authRequired, async (req, res) => {
    if (!assertAdmin(req, res)) return;
    const agentId = String(req.body?.agent_id || '').trim();
    const name = String(req.body?.name || '').trim();
    const content = String(req.body?.content || '').trim();
    const enabled = req.body?.enabled !== false;
    if (!agentId || !name || !content) return res.status(400).json({ error: 'missing_params' });
    try {
      const key = `custom_${agentId}_${Date.now()}`;
      const r = await pool().query(
        `insert into agent_prompt_templates (template_key, agent_id, name, content, enabled, is_builtin)
         values ($1, $2, $3, $4, $5, false)
         returning *`,
        [key, agentId, name, content, enabled]
      );
      return res.json({ template: r.rows[0] });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  });

  app.put('/api/admin/agents/templates/:id', authRequired, async (req, res) => {
    if (!assertAdmin(req, res)) return;
    const id = String(req.params?.id || '').trim();
    if (!id) return res.status(400).json({ error: 'missing_id' });
    try {
      const old = await pool().query('select * from agent_prompt_templates where id = $1 limit 1', [id]);
      if (!old.rows?.length) return res.status(404).json({ error: 'not_found' });
      const row = old.rows[0];

      if (row.is_builtin) {
        const enabled2 = req.body?.enabled === undefined ? row.enabled : !!req.body.enabled;
        const name2 = String(req.body?.name || row.name).trim() || row.name;
        const r = await pool().query(
          `update agent_prompt_templates set name = $1, enabled = $2, updated_at = now() where id = $3 returning *`,
          [name2, enabled2, id]
        );
        return res.json({ template: r.rows[0], locked_content: true });
      }

      const name2 = String(req.body?.name || row.name).trim() || row.name;
      const content2 = String(req.body?.content || row.content).trim() || row.content;
      const enabled2 = req.body?.enabled === undefined ? row.enabled : !!req.body.enabled;
      const r = await pool().query(
        `update agent_prompt_templates set name = $1, content = $2, enabled = $3, updated_at = now() where id = $4 returning *`,
        [name2, content2, enabled2, id]
      );
      return res.json({ template: r.rows[0] });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  });

  app.delete('/api/admin/agents/templates/:id', authRequired, async (req, res) => {
    if (!assertAdmin(req, res)) return;
    const id = String(req.params?.id || '').trim();
    if (!id) return res.status(400).json({ error: 'missing_id' });
    try {
      const old = await pool().query('select * from agent_prompt_templates where id = $1 limit 1', [id]);
      if (!old.rows?.length) return res.status(404).json({ error: 'not_found' });
      if (old.rows[0].is_builtin) return res.status(400).json({ error: 'builtin_template_cannot_delete' });

      const used = await pool().query('select count(*)::int as c from agent_configs where prompt_template_id = $1', [id]);
      if (Number(used.rows?.[0]?.c || 0) > 0) return res.status(400).json({ error: 'template_in_use' });

      await pool().query('delete from agent_prompt_templates where id = $1', [id]);
      return res.json({ ok: true });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  });

  // === HR 员工评级模型配置 ===
  app.get('/api/admin/hr/employee-rating-config', authRequired, async (req, res) => {
    if (!assertAdmin(req, res)) return;
    try {
      const r = await pool().query(`
        select config, enabled, updated_at
        from hr_rating_configs
        where config_key = 'employee_rating'
        limit 1
      `);
      const row = r.rows?.[0];
      const config = row?.config ? toJson(row.config, DEFAULT_EMPLOYEE_RATING_CONFIG) : DEFAULT_EMPLOYEE_RATING_CONFIG;
      return res.json({ config, enabled: row?.enabled !== false, updated_at: row?.updated_at || null });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  });

  app.put('/api/admin/hr/employee-rating-config', authRequired, async (req, res) => {
    if (!assertAdmin(req, res)) return;
    const config = req.body?.config;
    const enabled2 = req.body?.enabled !== false;
    if (!validateEmployeeRatingConfig(config)) return res.status(400).json({ error: 'invalid_config' });
    const normalizedConfig = normalizeEmployeeRatingConfig(config);
    try {
      const r = await pool().query(
        `insert into hr_rating_configs (config_key, config, enabled, updated_at)
         values ('employee_rating', $1::jsonb, $2, now())
         on conflict (config_key)
         do update set config = excluded.config, enabled = excluded.enabled, updated_at = now()
         returning config, enabled, updated_at`,
        [JSON.stringify(normalizedConfig), enabled2]
      );
      clearEmployeeRatingConfigCache();
      return res.json({ ok: true, config: toJson(r.rows?.[0]?.config, normalizedConfig), enabled: r.rows?.[0]?.enabled !== false });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  });

  // === BI Agent 配置（数据源 + 异常触发阈值） ===
  app.get('/api/admin/agents/bi-config', authRequired, async (req, res) => {
    if (!assertAdmin(req, res)) return;
    try {
      const r = await pool().query(`
        select config, enabled, updated_at
        from hr_rating_configs
        where config_key = 'bi_agent'
        limit 1
      `);
      const row = r.rows?.[0];
      const config = normalizeBiAgentConfig(row?.config ? toJson(row.config, DEFAULT_BI_AGENT_CONFIG) : DEFAULT_BI_AGENT_CONFIG);
      return res.json({ config, enabled: row?.enabled !== false, updated_at: row?.updated_at || null });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  });

  app.put('/api/admin/agents/bi-config', authRequired, async (req, res) => {
    if (!assertAdmin(req, res)) return;
    const config = normalizeBiAgentConfig(req.body?.config);
    const enabled2 = req.body?.enabled !== false;
    if (!config || typeof config !== 'object') return res.status(400).json({ error: 'invalid_config' });
    try {
      const r = await pool().query(
        `insert into hr_rating_configs (config_key, config, enabled, updated_at)
         values ('bi_agent', $1::jsonb, $2, now())
         on conflict (config_key)
         do update set config = excluded.config, enabled = excluded.enabled, updated_at = now()
         returning config, enabled, updated_at`,
        [JSON.stringify(config), enabled2]
      );
      clearBiAgentConfigCache();
      return res.json({ config: r.rows[0].config, enabled: r.rows[0].enabled, updated_at: r.rows[0].updated_at });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  });

  // === OP Agent 配置 ===
  app.get('/api/admin/agents/ops-config', authRequired, async (req, res) => {
    if (!assertAdmin(req, res)) return;
    try {
      const r = await pool().query(`
        select config, enabled, updated_at
        from hr_rating_configs
        where config_key = 'ops_agent'
        limit 1
      `);
      const row = r.rows?.[0];
      const config = normalizeOpsAgentConfig(row?.config ? toJson(row.config, DEFAULT_OPS_AGENT_CONFIG) : DEFAULT_OPS_AGENT_CONFIG);
      return res.json({ config, enabled: row?.enabled !== false, updated_at: row?.updated_at || null });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  });

  app.put('/api/admin/agents/ops-config', authRequired, async (req, res) => {
    if (!assertAdmin(req, res)) return;
    const config = normalizeOpsAgentConfig(req.body?.config);
    const enabled2 = req.body?.enabled !== false;
    if (!config || typeof config !== 'object') return res.status(400).json({ error: 'invalid_config' });
    try {
      const r = await pool().query(
        `insert into hr_rating_configs (config_key, config, enabled, updated_at)
         values ('ops_agent', $1::jsonb, $2, now())
         on conflict (config_key)
         do update set config = excluded.config, enabled = excluded.enabled, updated_at = now()
         returning config, enabled, updated_at`,
        [JSON.stringify(config), enabled2]
      );
      clearOpsAgentConfigCache();
      if (isHrmsAgentV1Enabled()) {
        try {
          const agentsRuntime = await import('./agents.js');
          if (typeof agentsRuntime?.startScheduledTasks === 'function') {
            await agentsRuntime.startScheduledTasks();
          }
        } catch (runtimeErr) {
          console.error('[ops-config] scheduler reload failed:', runtimeErr?.message || runtimeErr);
        }
      } else {
        console.log('[ops-config] HRMS_AGENT_V1_ENABLED≠true — 已跳过 startScheduledTasks 热重载');
      }
      return res.json({ config: r.rows[0].config, enabled: r.rows[0].enabled, updated_at: r.rows[0].updated_at });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  });

  app.get('/api/admin/agents/rules', authRequired, async (req, res) => {
    if (!assertAdmin(req, res)) return;
    try {
      const r = await pool().query('select * from agent_rules order by enabled desc, updated_at desc');
      res.json({ rules: r.rows });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.put('/api/admin/agents/rules/:id', authRequired, async (req, res) => {
    if (!assertAdmin(req, res)) return;
    const id = req.params.id;
    const { category, assignee_role, normal_deduction, major_deduction, enabled } = req.body;
    try {
      const r = await pool().query(`
        update agent_rules
        set category = $1, assignee_role = $2, normal_deduction = $3, major_deduction = $4, enabled = $5, updated_at = now()
        where id = $6 returning *
      `, [category, assignee_role, normal_deduction, major_deduction, enabled, id]);
      clearAgentRuleCache();
      res.json({ rule: r.rows[0] });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/admin/agents/rules', authRequired, async (req, res) => {
    if (!assertAdmin(req, res)) return;
    const { category, assignee_role, normal_deduction, major_deduction, enabled } = req.body;
    try {
      const r = await pool().query(`
        insert into agent_rules (category, assignee_role, normal_deduction, major_deduction, enabled)
        values ($1, $2, $3, $4, $5) returning *
      `, [category, assignee_role, normal_deduction, major_deduction, enabled !== false]);
      clearAgentRuleCache();
      res.json({ rule: r.rows[0] });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.delete('/api/admin/agents/rules/:id', authRequired, async (req, res) => {
    if (!assertAdmin(req, res)) return;
    const id = req.params.id;
    try {
      await pool().query('delete from agent_rules where id = $1', [id]);
      clearAgentRuleCache();
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // === 角色模块权限配置 ===
  const DEFAULT_ROLE_MODULES = {
    store_employee: ['profile', 'attendance', 'points', 'exam'],
    store_manager: ['profile', 'attendance', 'employees', 'daily-report', 'approvals', 'payment', 'rewards', 'points', 'reports', 'knowledge', 'exam', 'agents'],
    store_production_manager: ['profile', 'attendance', 'reports', 'points', 'knowledge', 'rewards', 'exam', 'agents'],
    hq_manager: ['profile', 'attendance', 'daily-report', 'approvals', 'employees', 'payment', 'exam', 'rewards', 'points', 'knowledge', 'reports', 'agents'],
    hr_manager: ['profile', 'attendance', 'employees', 'approvals', 'payment', 'reports', 'exam'],
    cashier: ['profile', 'attendance', 'payment', 'exam'],
    front_manager: ['profile', 'attendance', 'exam', 'points', 'daily-report', 'approvals', 'knowledge']
  };

  // 所有用户可调用（登录后加载自己角色的可用模块）
  app.get('/api/role-modules', authRequired, async (req, res) => {
    try {
      const r = await pool().query(`SELECT config FROM hr_rating_configs WHERE config_key='role_module_config' AND enabled=true LIMIT 1`);
      const cfg = r.rows?.[0]?.config;
      const parsed = cfg && typeof cfg === 'object' ? cfg : (typeof cfg === 'string' ? JSON.parse(cfg) : null);
      return res.json({ config: parsed || DEFAULT_ROLE_MODULES });
    } catch (e) {
      return res.json({ config: DEFAULT_ROLE_MODULES });
    }
  });

  // 管理员保存角色模块配置
  app.put('/api/admin/role-modules', authRequired, async (req, res) => {
    if (!assertAdmin(req, res)) return;
    const config = req.body?.config;
    if (!config || typeof config !== 'object') return res.status(400).json({ error: 'invalid_config' });
    try {
      const r = await pool().query(
        `INSERT INTO hr_rating_configs (config_key, config, enabled, updated_at)
         VALUES ('role_module_config', $1::jsonb, true, now())
         ON CONFLICT (config_key)
         DO UPDATE SET config = excluded.config, enabled = true, updated_at = now()
         RETURNING config, updated_at`,
        [JSON.stringify(config)]
      );
      return res.json({ config: r.rows[0].config, updated_at: r.rows[0].updated_at });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  });
}

// 缓存相关的辅助函数
let cachedRules = null;
let rulesLastFetched = 0;
const CACHE_TTL = 60 * 1000; // 1 分钟缓存

export function clearAgentRuleCache() {
  cachedRules = null;
  rulesLastFetched = 0;
}

export async function getAgentRules() {
  const now = Date.now();
  if (cachedRules && (now - rulesLastFetched < CACHE_TTL)) {
    return cachedRules;
  }
  try {
    const r = await pool().query('select * from agent_rules where enabled = true');
    cachedRules = r.rows;
    rulesLastFetched = now;
    return cachedRules;
  } catch (e) {
    console.error('[getAgentRules] Error:', e);
    return [];
  }
}

export async function getCategoryAssigneeRoleMap() {
  const rules = await getAgentRules();
  const map = {};
  for (const rule of rules) {
    map[rule.category] = rule.assignee_role;
  }
  return map;
}

export async function getIssueScoreRulesMap() {
  const rules = await getAgentRules();
  const map = {};
  for (const rule of rules) {
    map[rule.category] = {
      normal: rule.normal_deduction,
      major: rule.major_deduction
    };
  }
  return map;
}

let cachedConfigs = null;
let configsLastFetched = 0;

export function clearAgentConfigCache() {
  cachedConfigs = null;
  configsLastFetched = 0;
}

let opsAgentConfigCache = null;
let opsAgentConfigLastFetch = 0;
let biAgentConfigCache = null;
let biAgentConfigLastFetch = 0;

export async function getOpsAgentConfig() {
  const now = Date.now();
  if (opsAgentConfigCache && (now - opsAgentConfigLastFetch < 60000)) {
    return opsAgentConfigCache;
  }
  try {
    const r = await pool().query(`select config from hr_rating_configs where config_key = 'ops_agent' and enabled = true limit 1`);
    if (r.rows?.length > 0 && r.rows[0].config) {
      opsAgentConfigCache = normalizeOpsAgentConfig(toJson(r.rows[0].config, DEFAULT_OPS_AGENT_CONFIG));
    } else {
      opsAgentConfigCache = normalizeOpsAgentConfig(DEFAULT_OPS_AGENT_CONFIG);
    }
  } catch (e) {
    console.error('[AgentConfig] getOpsAgentConfig error:', e);
    opsAgentConfigCache = normalizeOpsAgentConfig(DEFAULT_OPS_AGENT_CONFIG);
  }
  opsAgentConfigLastFetch = now;
  return opsAgentConfigCache;
}

export function clearOpsAgentConfigCache() {
  opsAgentConfigCache = null;
  opsAgentConfigLastFetch = 0;
}

export async function getBiAgentConfig() {
  const now = Date.now();
  if (biAgentConfigCache && (now - biAgentConfigLastFetch < 60000)) {
    return biAgentConfigCache;
  }
  try {
    const r = await pool().query(`select config from hr_rating_configs where config_key = 'bi_agent' and enabled = true limit 1`);
    if (r.rows?.length > 0 && r.rows[0].config) {
      biAgentConfigCache = normalizeBiAgentConfig(toJson(r.rows[0].config, DEFAULT_BI_AGENT_CONFIG));
    } else {
      biAgentConfigCache = normalizeBiAgentConfig(DEFAULT_BI_AGENT_CONFIG);
    }
  } catch (e) {
    console.error('[AgentConfig] getBiAgentConfig error:', e);
    biAgentConfigCache = normalizeBiAgentConfig(DEFAULT_BI_AGENT_CONFIG);
  }
  biAgentConfigLastFetch = now;
  return biAgentConfigCache;
}

export function clearBiAgentConfigCache() {
  biAgentConfigCache = null;
  biAgentConfigLastFetch = 0;
}

export async function getAgentConfigs() {
  const now = Date.now();
  if (cachedConfigs && (now - configsLastFetched < CACHE_TTL)) {
    return cachedConfigs;
  }
  try {
    const r = await pool().query('select * from agent_configs');
    const map = {};
    for (const row of r.rows) {
      map[row.agent_id] = row;
    }
    cachedConfigs = map;
    configsLastFetched = now;
    return cachedConfigs;
  } catch (e) {
    console.error('[getAgentConfigs] Error:', e);
    return {};
  }
}

export async function getAgentConfig(agentId) {
  const configs = await getAgentConfigs();
  return configs[agentId] || null;
}

let cachedEmployeeRatingConfig = null;
let employeeRatingLastFetched = 0;

export function clearEmployeeRatingConfigCache() {
  cachedEmployeeRatingConfig = null;
  employeeRatingLastFetched = 0;
}

export async function getEmployeeRatingConfig() {
  const now = Date.now();
  if (cachedEmployeeRatingConfig && (now - employeeRatingLastFetched < CACHE_TTL)) {
    return cachedEmployeeRatingConfig;
  }
  try {
    const r = await pool().query(`
      select config
      from hr_rating_configs
      where config_key = 'employee_rating' and enabled = true
      limit 1
    `);
    cachedEmployeeRatingConfig = r.rows?.[0]?.config
      ? normalizeEmployeeRatingConfig(toJson(r.rows[0].config, DEFAULT_EMPLOYEE_RATING_CONFIG))
      : DEFAULT_EMPLOYEE_RATING_CONFIG;
    employeeRatingLastFetched = now;
    return cachedEmployeeRatingConfig;
  } catch (e) {
    console.error('[getEmployeeRatingConfig] Error:', e);
    return DEFAULT_EMPLOYEE_RATING_CONFIG;
  }
}
