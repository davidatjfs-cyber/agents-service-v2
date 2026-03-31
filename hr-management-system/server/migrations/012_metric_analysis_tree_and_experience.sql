-- ============================================================
-- Migration 012: metric_dictionary 分析拆解字段 + 核心指标种子 + agent_experience
-- 说明:
--   - 仅 ADD COLUMN / CREATE TABLE / INSERT，不修改已有列定义与已有行数据
--   - 不 UPDATE 任何现有 metric_dictionary 行的 dependencies
--   - 新指标与 agents-service-v2 data-executor 口径兼容（daily_reports / computed）
-- ============================================================

BEGIN;

-- ── 1) metric_dictionary 新增字段（全部可空，兼容 SELECT *） ─────────
ALTER TABLE metric_dictionary
  ADD COLUMN IF NOT EXISTS analysis_children JSONB,
  ADD COLUMN IF NOT EXISTS analysis_level INT,
  ADD COLUMN IF NOT EXISTS analysis_desc TEXT;

-- 新行默认 analysis_level=1；已存在行保持 NULL（向后兼容）
ALTER TABLE metric_dictionary
  ALTER COLUMN analysis_level SET DEFAULT 1;

-- ── 2) 核心分析指标（已存在则跳过；不覆盖已有行的 dependencies） ─────
INSERT INTO metric_dictionary
  (metric_id, name, description, formula, data_source, time_granularity, include_discount, dependencies, version, owner, enabled,
   analysis_children, analysis_level, analysis_desc)
VALUES
  ('revenue', '实收营业额', '分析树根：日报实收合计', 'SUM(actual_revenue)', 'daily_reports', 'daily', FALSE, '[]'::jsonb, 1, 'hq_manager', TRUE,
   '["orders","avg_order_value"]'::jsonb, 0, '拆解为订单量与客单价'),

  ('orders', '堂食订单数', '日报堂食订单/桌数合计', 'SUM(dine_orders)', 'daily_reports', 'daily', FALSE, '[]'::jsonb, 1, 'hq_manager', TRUE,
   '["traffic","conversion_rate"]'::jsonb, 1, '拆解为客流与转化率'),

  ('traffic', '堂食客流', '日报堂食客流人次合计', 'SUM(dine_traffic)', 'daily_reports', 'daily', FALSE, '[]'::jsonb, 1, 'hq_manager', TRUE,
   '["exposure","walk_in_rate"]'::jsonb, 2, '拆解为曝光与到店率（子指标可后续补字典）'),

  ('avg_order_value', '客单价', '实收/订单（计算型）', 'revenue / orders', 'computed', 'daily', FALSE, '["revenue","orders"]'::jsonb, 1, 'hq_manager', TRUE,
   '[]'::jsonb, 1, '叶子'),

  ('conversion_rate', '订单转化率', '订单/客流（计算型）', 'orders / traffic', 'computed', 'daily', FALSE, '["orders","traffic"]'::jsonb, 1, 'hq_manager', TRUE,
   '[]'::jsonb, 1, '叶子')
ON CONFLICT (metric_id) DO NOTHING;

-- ── 3) agent_experience（与 agent_memory 独立） ───────────────────────
CREATE TABLE IF NOT EXISTS agent_experience (
  id          SERIAL PRIMARY KEY,
  scenario    TEXT NOT NULL,
  root_cause  TEXT,
  action      TEXT,
  score       DOUBLE PRECISION,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_agent_experience_scenario ON agent_experience (scenario);
CREATE INDEX IF NOT EXISTS idx_agent_experience_scenario_score ON agent_experience (scenario, score DESC NULLS LAST);

COMMIT;
