-- 新员工培训计划
-- 表：training_plans / training_plan_phases

CREATE TABLE IF NOT EXISTS training_plans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id TEXT NOT NULL,
  employee_name TEXT NOT NULL,
  store TEXT,
  start_date DATE NOT NULL,
  status TEXT DEFAULT 'active',
  current_week INT DEFAULT 1,
  created_by TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS training_plan_phases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id UUID REFERENCES training_plans(id) ON DELETE CASCADE,
  week INT NOT NULL,
  phase_name TEXT NOT NULL,
  sop_ids UUID[],
  exam_count INT DEFAULT 20,
  pass_score NUMERIC(5,2) DEFAULT 90,
  status TEXT DEFAULT 'pending',
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_training_plans_employee ON training_plans(employee_id);
CREATE INDEX IF NOT EXISTS idx_training_plans_status ON training_plans(status);
