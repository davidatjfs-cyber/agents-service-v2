-- ============================================================
-- Migration 014: strategy_rules — 场景 × 根因 → 系统推荐策略（可扩展）
-- ============================================================

BEGIN;

CREATE TABLE IF NOT EXISTS strategy_rules (
  id SERIAL PRIMARY KEY,
  scenario TEXT NOT NULL,
  root_cause TEXT NOT NULL,
  action TEXT NOT NULL,
  priority INT DEFAULT 1,
  created_at TIMESTAMP WITHOUT TIME ZONE DEFAULT NOW(),
  CONSTRAINT strategy_rules_scenario_root_unique UNIQUE (scenario, root_cause)
);

CREATE INDEX IF NOT EXISTS idx_strategy_rules_scenario ON strategy_rules (scenario);
CREATE INDEX IF NOT EXISTS idx_strategy_rules_scenario_root ON strategy_rules (scenario, root_cause);

INSERT INTO strategy_rules (scenario, root_cause, action, priority) VALUES
  ('revenue_drop', 'traffic', '增加曝光（抖音/点评投放）', 1),
  ('revenue_drop', 'aov', '优化套餐组合，提高客单价', 1),
  ('bad_reviews', 'food', '优化出品质量，检查口味与温度', 1),
  ('delivery_drop', 'exposure', '提升平台排名与投放', 1)
ON CONFLICT (scenario, root_cause) DO UPDATE SET
  action = EXCLUDED.action,
  priority = EXCLUDED.priority;

COMMIT;
