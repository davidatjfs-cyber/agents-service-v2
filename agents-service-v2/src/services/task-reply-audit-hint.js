/**
 * 任务卡「直接回复」后由 feishu-client.reviewTaskReply 审核；卡片上展示与审核逻辑一致的简要说明。
 * 规则摘要须与 feishu-client.js 中 LLM/规则预审口径对齐。
 */
export const TASK_REPLY_AUDIT_HINT_ZH =
  '**系统审核要求**\n' +
  '• 文字 **≥20 字**，或 **附现场照片**（满足其一可通过基础规则）\n' +
  '• 须说明 **现场情况**、**处理措施**；抽检/巡检类须写 **发现与处理结果**\n' +
  '• 勿仅用「收到」「无」「OK」等占位回复（易被退回；累计 3 次不合格将记工作态度未达标，不计绩效分）';

/**
 * @param {string} [extraFromConfig] 控制台可为单条任务配置的补充说明（如行业术语）
 */
export function formatTaskCardAuditSection(extraFromConfig) {
  const extra = String(extraFromConfig || '').trim();
  if (extra) return `${TASK_REPLY_AUDIT_HINT_ZH}\n\n**本任务补充**：${extra}`;
  return TASK_REPLY_AUDIT_HINT_ZH;
}
