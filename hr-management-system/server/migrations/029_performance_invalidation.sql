-- 绩效记录失效机制：管理员标记扣分/备案记录失效后自动重算
-- agent_scores 加 is_invalidated 列（与 master_tasks.hr_performance_recorded 同模式）
-- 新增 performance_invalidation_records 审计表

BEGIN;

-- agent_scores 加失效标记
ALTER TABLE agent_scores ADD COLUMN IF NOT EXISTS is_invalidated BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE agent_scores ADD COLUMN IF NOT EXISTS invalidated_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_agent_scores_invalidated
  ON agent_scores (is_invalidated) WHERE is_invalidated = TRUE;

-- 失效审计表
CREATE TABLE IF NOT EXISTS performance_invalidation_records (
  id BIGSERIAL PRIMARY KEY,
  source_type VARCHAR(50) NOT NULL,
  source_id VARCHAR(200) NOT NULL,
  username VARCHAR(100) NOT NULL,
  store VARCHAR(200),
  period VARCHAR(20) NOT NULL,
  invalidated_by VARCHAR(100) NOT NULL,
  invalidated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_invalidation_source UNIQUE(source_type, source_id)
);

CREATE INDEX IF NOT EXISTS idx_invalidation_username_period
  ON performance_invalidation_records (username, period);
CREATE INDEX IF NOT EXISTS idx_invalidation_invalidated_by
  ON performance_invalidation_records (invalidated_by, invalidated_at DESC);

COMMIT;