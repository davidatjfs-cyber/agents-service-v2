/**
 * 管理端 / 报表展示用：将 master_tasks / ops_tasks 等英文状态码转为中文，
 * 不改变数据库内英文枚举（避免破坏状态机与现有 SQL 条件）。
 */

/** master_tasks.status → 中文（全量常用值） */
const MASTER_TASK_STATUS_ZH = {
  pending_audit: '待数据审核',
  auditing: '审核中',
  pending_dispatch: '待派发',
  dispatched: '已派发',
  pending_response: '待回复',
  pending_review: '待督导审核',
  awaiting_approval: '待审批',
  resolved: '已处理',
  pending_settlement: '待定级结算',
  settled: '已定级',
  closed: '已结束',
  rejected: '已驳回',
  escalated: '已升级',
  hr_filed: '已备案',
  completed: '已完成',
  cancelled: '已取消'
};

/** 工作态度备案来源 source → 中文 */
const ATTITUDE_SOURCE_ZH = {
  random_inspection: '随机抽检',
  scheduled_inspection: '定时巡检',
  bi_anomaly: 'BI异常任务',
  auto_collab: '自动协作',
  data_auditor: '数据审计',
  anomaly_engine: '异常引擎'
};

/**
 * 月度绩效查询「工作态度备案」行：在已 HR 备案列表中优先表达「已备案 / 已结束」。
 * @param {string} status
 */
export function zhMasterTaskStatusForAttitudeFiling(status) {
  const s = String(status || '').trim();
  if (!s) return '—';
  if (s === 'closed' || s === 'settled') return '已结束';
  if (s === 'hr_filed') return '已备案';
  return MASTER_TASK_STATUS_ZH[s] || s;
}

/** 任意 master_tasks 状态展示 */
export function zhMasterTaskStatus(status) {
  const s = String(status || '').trim();
  if (!s) return '—';
  return MASTER_TASK_STATUS_ZH[s] || s;
}

export function zhAttitudeFilingSource(source) {
  const k = String(source || '').trim();
  if (!k) return '—';
  return ATTITUDE_SOURCE_ZH[k] || k;
}

/**
 * 执行力日评备案（ops_tasks）：写入侧已用「已备案」；历史 pending_review 仍映射为已备案。
 */
export function zhExecutionFilingStatus(status) {
  const s = String(status || '').trim();
  if (!s) return '已备案';
  if (s === 'pending_review') return '已备案';
  if (s === '已备案') return '已备案';
  if (s === '已结束') return '已结束';
  return s;
}

/** 异常扣分严重度（月度查询扣分明细） */
export function zhSeverity(sev) {
  const s = String(sev || '').trim().toLowerCase();
  if (s === 'medium') return '中';
  if (s === 'high') return '高';
  if (s === 'low') return '低';
  if (!s) return '—';
  return String(sev || '').trim() || '—';
}
