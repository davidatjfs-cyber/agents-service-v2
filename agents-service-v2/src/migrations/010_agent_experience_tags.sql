-- ============================================================
-- Migration 010: agent_experience.tags（策略标签 JSONB，可空）
-- ============================================================

BEGIN;

ALTER TABLE agent_experience
  ADD COLUMN IF NOT EXISTS tags JSONB;

CREATE INDEX IF NOT EXISTS idx_agent_experience_tags_gin ON agent_experience USING GIN (tags);

COMMIT;
