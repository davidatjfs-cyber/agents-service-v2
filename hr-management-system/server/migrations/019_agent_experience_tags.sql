-- ============================================================
-- Migration 019: agent_experience.tags（与 agents 010 一致）
-- ============================================================

BEGIN;

ALTER TABLE agent_experience
  ADD COLUMN IF NOT EXISTS tags JSONB;

CREATE INDEX IF NOT EXISTS idx_agent_experience_tags_gin ON agent_experience USING GIN (tags);

COMMIT;
