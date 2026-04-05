-- 员工奖惩独立表：与 hrms_state.rewardPunishmentRecords 双写，启动时互相同步缺口
-- 创建时间: 2026-04-05

CREATE TABLE IF NOT EXISTS hrms_reward_punishment_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username VARCHAR(100) NOT NULL,
  name VARCHAR(200),
  store VARCHAR(200),
  brand VARCHAR(120),
  type VARCHAR(30) NOT NULL, -- 'reward' or 'punishment'
  category VARCHAR(120),
  points NUMERIC(6,1) NOT NULL DEFAULT 0,
  amount NUMERIC(10,2) DEFAULT 0,
  reason TEXT NOT NULL,
  source VARCHAR(60), -- 'manual', 'agent', 'approval', 'rule'
  approval_id UUID,
  status VARCHAR(30) NOT NULL DEFAULT 'active', -- active / cancelled
  created_by VARCHAR(100),
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_rp_username ON hrms_reward_punishment_records (username, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_rp_store_date ON hrms_reward_punishment_records (store, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_rp_type ON hrms_reward_punishment_records (type, created_at DESC);

COMMENT ON TABLE hrms_reward_punishment_records IS '员工奖惩记录';
