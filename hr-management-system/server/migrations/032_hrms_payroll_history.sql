-- ============================================================================
-- 032_hrms_payroll_history.sql
-- Append-only 薪资审计日志（取代将 salaryChangeHistory/payrollAdjustments/payrollAudits
-- 整包塞在 hrms_state JSON 里的旧模式）
--
-- 设计原则:
--   1. 每次薪资相关的写入都 INSERT 一行,永不 UPDATE/DELETE → 法律证据级留存
--   2. record_type 区分三类来源(与 hrms_state 三个 JSON 字段一一对应)
--   3. before_value/after_value 完整快照,即便上游被覆盖也能从这里还原
--   4. 不影响现有 hrms_payroll_domain(那是用作"快照容器"),本表是"事件流水"
--
-- 风险声明:
--   - 这是新增表,不影响现有读路径
--   - 即便后续双写代码暂未上线,空表也无害
--   - 旧数据需要用 scripts/backfill-payroll-history.mjs 一次性回填
-- ============================================================================

CREATE TABLE IF NOT EXISTS hrms_payroll_history (
  id              BIGSERIAL PRIMARY KEY,

  -- 事件来源类型
  record_type     VARCHAR(40) NOT NULL,  -- 'salary_change' | 'payroll_adjustment' | 'payroll_audit'

  -- 业务键(谁、什么时间维度、什么门店)
  username        VARCHAR(100),          -- 目标员工(audit 类型可能为空)
  month           VARCHAR(7),            -- YYYY-MM(audit/adjustment 必填,change 可空)
  store           VARCHAR(100),

  -- 关键金额字段(便于 SQL 查询,不必每次解 JSON)
  before_amount   NUMERIC(12, 2),
  after_amount    NUMERIC(12, 2),
  delta_amount    NUMERIC(12, 2) GENERATED ALWAYS AS (
    COALESCE(after_amount, 0) - COALESCE(before_amount, 0)
  ) STORED,

  -- 完整 before/after 快照(JSON,用于法律/审计追溯)
  before_value    JSONB,
  after_value     JSONB,

  -- 变更原因/来源
  reason          TEXT,
  source          VARCHAR(60),           -- 'approval_flow' | 'manual_adjust' | 'audit_lock' | 'backfill' 等

  -- 操作者
  operator_username VARCHAR(100),
  operator_role     VARCHAR(60),

  -- 时间戳(写入即定,绝不更新)
  created_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),

  -- 幂等键(回填脚本用,防止重复 INSERT 同一条历史)
  -- 例: 'salary_change|emp01|2026-03-12T10:30:00Z'
  idempotency_key VARCHAR(200) UNIQUE
);

-- ── 索引 ───────────────────────────────────────────────────
-- 按员工+月份查薪资历史(最常用)
CREATE INDEX IF NOT EXISTS idx_payroll_history_user_month
  ON hrms_payroll_history (username, month, created_at DESC);

-- 按类型+时间范围查(审计/对账)
CREATE INDEX IF NOT EXISTS idx_payroll_history_type_created
  ON hrms_payroll_history (record_type, created_at DESC);

-- 按门店+月份(月度报表)
CREATE INDEX IF NOT EXISTS idx_payroll_history_store_month
  ON hrms_payroll_history (store, month) WHERE store IS NOT NULL;

-- 按操作者(谁改的谁负责)
CREATE INDEX IF NOT EXISTS idx_payroll_history_operator
  ON hrms_payroll_history (operator_username, created_at DESC) WHERE operator_username IS NOT NULL;

COMMENT ON TABLE hrms_payroll_history IS 'Append-only 薪资变更审计日志，保留所有调薪/补贴调整/月度封账事件，永不 UPDATE/DELETE';
COMMENT ON COLUMN hrms_payroll_history.record_type IS '事件类型: salary_change | payroll_adjustment | payroll_audit';
COMMENT ON COLUMN hrms_payroll_history.delta_amount IS '计算列: after_amount - before_amount，自动维护';
COMMENT ON COLUMN hrms_payroll_history.idempotency_key IS '回填脚本的去重键，正常写入路径可留空';

-- ── 安全护栏 ───────────────────────────────────────────────
-- 防止意外 UPDATE/DELETE(审计日志必须 append-only):
-- 注意: 如果业务上确实需要修改某条 history,应用层需绕过此触发器(用 SET LOCAL session_replication_role)。
CREATE OR REPLACE FUNCTION hrms_payroll_history_block_modify()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'hrms_payroll_history is append-only; UPDATE/DELETE not allowed';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_hrms_payroll_history_no_update ON hrms_payroll_history;
CREATE TRIGGER trg_hrms_payroll_history_no_update
  BEFORE UPDATE OR DELETE ON hrms_payroll_history
  FOR EACH ROW EXECUTE FUNCTION hrms_payroll_history_block_modify();
