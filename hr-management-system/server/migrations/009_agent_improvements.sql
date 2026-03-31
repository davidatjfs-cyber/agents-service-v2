-- ============================================================
-- Migration 009: Agent System Improvements
-- 创建时间: 2026-03-02
-- 说明:
--   P1A: metric_dictionary 增加 cache_ttl_minutes 字段（TTL可配置化）
--   P1B: diagnosis_feedback 表（Diagnosis质量监控）
-- 不修改任何现有数据，仅新增字段和表。
-- ============================================================

BEGIN;

-- ── P1A: metric_dictionary 增加 cache_ttl_minutes 字段 ───────
ALTER TABLE metric_dictionary
  ADD COLUMN IF NOT EXISTS cache_ttl_minutes INT DEFAULT 120;

-- 实时性要求高的指标（当日营业额等）设为30分钟
UPDATE metric_dictionary
  SET cache_ttl_minutes = 30
  WHERE metric_id IN ('OP_001','OP_002','OP_003','OP_010','OP_011','OP_012','HR_001','HR_002','QC_001','QC_002');

-- 月度指标（毛利相关）可缓存更久
UPDATE metric_dictionary
  SET cache_ttl_minutes = 360
  WHERE metric_id IN ('OP_020','OP_021');

-- ── P1B: 诊断质量监控表 ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS diagnosis_feedback (
  id            SERIAL PRIMARY KEY,
  task_id       TEXT NOT NULL,
  user_key      TEXT NOT NULL,
  store         TEXT,
  time_range    TEXT,
  metrics_used  JSONB DEFAULT '[]'::jsonb,   -- 本次诊断使用的指标
  diagnosis     TEXT,                         -- LLM输出文本（截断至2000字）
  feedback      SMALLINT DEFAULT NULL,        -- 1=好评 0=差评 NULL=未反馈
  feedback_note TEXT,                         -- 用户备注
  char_count    INT,                          -- 诊断文本字数
  metric_count  INT,                          -- 引用指标数量
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_diagnosis_feedback_task  ON diagnosis_feedback (task_id);
CREATE INDEX IF NOT EXISTS idx_diagnosis_feedback_user  ON diagnosis_feedback (user_key);
CREATE INDEX IF NOT EXISTS idx_diagnosis_feedback_score ON diagnosis_feedback (feedback) WHERE feedback IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_diagnosis_feedback_ts    ON diagnosis_feedback (created_at DESC);

COMMIT;
