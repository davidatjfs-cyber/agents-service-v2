-- ============================================================
-- Migration 015: agent_experience 上下文维度（可空，兼容旧数据）
-- ============================================================

BEGIN;

ALTER TABLE agent_experience
  ADD COLUMN IF NOT EXISTS store_type TEXT,
  ADD COLUMN IF NOT EXISTS time_period TEXT,
  ADD COLUMN IF NOT EXISTS channel TEXT;

COMMIT;
