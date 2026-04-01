-- 奖惩「每月自动生成」模板表（由服务端 ensure 也会创建，此文件便于审计）
CREATE TABLE IF NOT EXISTS recurring_reward_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_by VARCHAR(100) NOT NULL,
  frequency VARCHAR(20) NOT NULL DEFAULT 'monthly',
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_generated_ym VARCHAR(7),
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_recurring_reward_templates_active ON recurring_reward_templates (active, frequency);
