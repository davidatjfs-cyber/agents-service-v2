-- ============================================================
-- Migration 009: strategy_rules.tags_score（自动打标质量分，可空）
-- ============================================================

BEGIN;

ALTER TABLE strategy_rules
  ADD COLUMN IF NOT EXISTS tags_score DOUBLE PRECISION;

CREATE INDEX IF NOT EXISTS idx_strategy_rules_tags_score ON strategy_rules (tags_score NULLS LAST);

COMMIT;
