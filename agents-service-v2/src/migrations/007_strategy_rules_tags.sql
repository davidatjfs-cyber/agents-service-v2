-- ============================================================
-- Migration 007: strategy_rules.tags（与 HRMS 016 一致）
-- ============================================================

BEGIN;

ALTER TABLE strategy_rules
  ADD COLUMN IF NOT EXISTS tags JSONB;

UPDATE strategy_rules
SET tags = '["流量","投放"]'::jsonb
WHERE scenario = 'revenue_drop' AND root_cause = 'traffic';

UPDATE strategy_rules
SET tags = '["客单价"]'::jsonb
WHERE scenario = 'revenue_drop' AND root_cause = 'aov';

UPDATE strategy_rules
SET tags = '["品质"]'::jsonb
WHERE scenario = 'bad_reviews' AND root_cause = 'food';

UPDATE strategy_rules
SET tags = '["外卖","平台","投放","外卖专用"]'::jsonb
WHERE scenario = 'delivery_drop' AND root_cause = 'exposure';

COMMIT;
