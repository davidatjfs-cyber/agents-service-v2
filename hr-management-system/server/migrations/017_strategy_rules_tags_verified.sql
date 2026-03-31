-- ============================================================
-- Migration 017: strategy_rules.tags_verified（与 agents 008 一致）
-- ============================================================

BEGIN;

ALTER TABLE strategy_rules
  ADD COLUMN IF NOT EXISTS tags_verified BOOLEAN DEFAULT false;

UPDATE strategy_rules
SET tags_verified = true
WHERE tags IS NOT NULL
  AND jsonb_typeof(tags) = 'array'
  AND jsonb_array_length(tags) > 0;

COMMIT;
