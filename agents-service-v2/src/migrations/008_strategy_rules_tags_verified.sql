-- ============================================================
-- Migration 008: strategy_rules.tags_verified（自动生成未审 / 人工已审）
-- ============================================================

BEGIN;

ALTER TABLE strategy_rules
  ADD COLUMN IF NOT EXISTS tags_verified BOOLEAN DEFAULT false;

-- 迁移前已由 007 写入的非空 tags 视为已人工确认过的种子数据
UPDATE strategy_rules
SET tags_verified = true
WHERE tags IS NOT NULL
  AND jsonb_typeof(tags) = 'array'
  AND jsonb_array_length(tags) > 0;

COMMIT;
