-- 审批记录迁移文件：从 agents.js ensureApprovalTables() 提取
-- 创建时间: 2026-04-05
-- 背景：approval_requests 只在代码里动态创建，无迁移文件

CREATE TABLE IF NOT EXISTS approval_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type VARCHAR(50) NOT NULL,
  status VARCHAR(20) NOT NULL,
  applicant_username VARCHAR(100) NOT NULL,
  current_assignee_username VARCHAR(100),
  chain JSONB NOT NULL DEFAULT '[]'::jsonb,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  effective_date DATE,
  executed_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_approval_requests_assignee_status ON approval_requests (current_assignee_username, status);
CREATE INDEX IF NOT EXISTS idx_approval_requests_applicant_status ON approval_requests (applicant_username, status);
CREATE INDEX IF NOT EXISTS idx_approval_requests_type_effective_date ON approval_requests (type, effective_date);

COMMENT ON TABLE approval_requests IS '审批流程记录（入职/离职/请款/休假/奖惩/转正等）';
