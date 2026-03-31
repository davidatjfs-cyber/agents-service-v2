-- Migration 001: KPI数据层 — 扩展master_tasks + 新建配置表
-- 2026-03-05

-- 1. master_tasks 新增5个字段
ALTER TABLE master_tasks ADD COLUMN IF NOT EXISTS sla_due_at TIMESTAMPTZ;
ALTER TABLE master_tasks ADD COLUMN IF NOT EXISTS first_response_at TIMESTAMPTZ;
ALTER TABLE master_tasks ADD COLUMN IF NOT EXISTS remind_count INTEGER DEFAULT 0;
ALTER TABLE master_tasks ADD COLUMN IF NOT EXISTS evidence_refs JSONB DEFAULT '[]'::jsonb;
ALTER TABLE master_tasks ADD COLUMN IF NOT EXISTS resolution_code TEXT;
-- resolution_code values: resolved_ok | false_positive | need_more_data | escalated | pending

-- 2. kpi_snapshots — 每日KPI快照
CREATE TABLE IF NOT EXISTS kpi_snapshots (
  id SERIAL PRIMARY KEY,
  snapshot_date DATE NOT NULL,
  store TEXT NOT NULL,
  brand TEXT,
  -- KPI-A 闭环效率
  ttfr_p90_minutes NUMERIC(10,1),
  ttc_p90_hours NUMERIC(10,1),
  timeout_rate NUMERIC(5,2),
  -- KPI-B 管理质量
  false_positive_rate NUMERIC(5,2),
  evidence_coverage_rate NUMERIC(5,2),
  -- KPI-C 管理动作
  first_pass_rate NUMERIC(5,2),
  avg_remind_count NUMERIC(5,2),
  escalation_rate NUMERIC(5,2),
  escalation_resolve_rate NUMERIC(5,2),
  -- 任务计数
  total_tasks INTEGER DEFAULT 0,
  closed_tasks INTEGER DEFAULT 0,
  overdue_tasks INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(snapshot_date, store)
);

CREATE INDEX IF NOT EXISTS idx_kpi_snapshots_date ON kpi_snapshots(snapshot_date);
CREATE INDEX IF NOT EXISTS idx_kpi_snapshots_store ON kpi_snapshots(store, snapshot_date);

-- 3. anomaly_triggers — 异常触发记录
CREATE TABLE IF NOT EXISTS anomaly_triggers (
  id SERIAL PRIMARY KEY,
  anomaly_key TEXT NOT NULL,
  store TEXT NOT NULL,
  brand TEXT,
  severity TEXT NOT NULL DEFAULT 'medium',
  trigger_date DATE NOT NULL,
  trigger_value JSONB DEFAULT '{}'::jsonb,
  threshold_value JSONB DEFAULT '{}'::jsonb,
  task_id TEXT,
  status TEXT DEFAULT 'open',
  assigned_role TEXT,
  notify_target_role TEXT,
  evidence_submitted JSONB DEFAULT '[]'::jsonb,
  resolution_code TEXT,
  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_anomaly_triggers_key ON anomaly_triggers(anomaly_key, store, trigger_date);
CREATE INDEX IF NOT EXISTS idx_anomaly_triggers_status ON anomaly_triggers(status, severity);

-- 4. escalation_chains — 升级链配置（前台可管理）
CREATE TABLE IF NOT EXISTS escalation_chains (
  id SERIAL PRIMARY KEY,
  brand TEXT,
  store TEXT,
  anomaly_key TEXT,
  level INTEGER NOT NULL DEFAULT 1,
  target_role TEXT NOT NULL,
  timeout_hours INTEGER,
  auto_escalate BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- 5. acceptance_checklists — 验收标准模板（前台可管理）
CREATE TABLE IF NOT EXISTS acceptance_checklists (
  id SERIAL PRIMARY KEY,
  anomaly_key TEXT NOT NULL,
  checklist_items JSONB NOT NULL DEFAULT '[]'::jsonb,
  min_word_count INTEGER DEFAULT 0,
  require_photos BOOLEAN DEFAULT false,
  require_video BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(anomaly_key)
);

-- 6. rhythm_logs — 节奏执行日志
CREATE TABLE IF NOT EXISTS rhythm_logs (
  id SERIAL PRIMARY KEY,
  rhythm_type TEXT NOT NULL,
  execution_date DATE NOT NULL,
  execution_time TIME,
  status TEXT DEFAULT 'success',
  result_summary JSONB DEFAULT '{}'::jsonb,
  error_message TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_rhythm_logs_date ON rhythm_logs(execution_date, rhythm_type);

-- 7. 插入默认升级链配置
INSERT INTO escalation_chains (brand, store, anomaly_key, level, target_role, timeout_hours) VALUES
  (NULL, NULL, NULL, 1, 'ops', 24),
  (NULL, NULL, NULL, 2, 'hq_manager', 48),
  (NULL, NULL, NULL, 3, 'admin', NULL),
  (NULL, NULL, 'food_safety', 1, 'hq_manager', 1),
  (NULL, NULL, 'food_safety', 2, 'admin', 4)
ON CONFLICT DO NOTHING;

-- 8. 插入默认验收清单
INSERT INTO acceptance_checklists (anomaly_key, checklist_items, min_word_count, require_photos, require_video) VALUES
  ('revenue_achievement', '["营收提升方案"]', 100, false, false),
  ('labor_efficiency', '["每天每小时人效值明细","低人效时段优化行动方案"]', 100, false, false),
  ('recharge_zero', '["服务员推销视频分析"]', 0, false, true),
  ('table_visit_product', '["差评产品操作问题点","出错点分析","整改方案"]', 100, false, false),
  ('table_visit_ratio', '["每天桌访数量","责任人分配","未完成人员及原因"]', 50, false, false),
  ('gross_margin', '["盘点表","原料去向分析"]', 100, false, false),
  ('bad_review_product', '["差评产品操作问题点","出错点分析","整改方案"]', 100, false, false),
  ('bad_review_service', '["差评案例培训材料","员工培训照片"]', 50, true, false),
  ('food_safety', '["食品安全调查报告","情况确认","责任人确认","整改方案","整改照片"]', 200, true, false),
  ('traffic_decline', '["客流提升计划","店长沟通确认"]', 50, false, false)
ON CONFLICT (anomaly_key) DO NOTHING;
