-- ============================================================
-- Migration 006: agent_experience 上下文列（与 HRMS 015 一致）
-- ============================================================

BEGIN;

ALTER TABLE agent_experience
  ADD COLUMN IF NOT EXISTS store_type TEXT,
  ADD COLUMN IF NOT EXISTS time_period TEXT,
  ADD COLUMN IF NOT EXISTS channel TEXT;

COMMIT;
