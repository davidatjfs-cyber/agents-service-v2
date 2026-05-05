-- SOP 执行保障系统
-- 表：sop_definitions / sop_steps / sop_questions

CREATE TABLE IF NOT EXISTS sop_definitions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  dish_name TEXT NOT NULL,
  station TEXT NOT NULL,
  store TEXT,
  title TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'product',
  version INT DEFAULT 1,
  status TEXT DEFAULT 'active',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS sop_steps (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sop_id UUID REFERENCES sop_definitions(id) ON DELETE CASCADE,
  seq INT NOT NULL,
  action TEXT NOT NULL,
  responsible_role TEXT,
  time_limit_seconds INT,
  quality_standard TEXT,
  common_failure TEXT,
  failure_action TEXT,
  evidence_required TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS sop_questions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sop_id UUID REFERENCES sop_definitions(id) ON DELETE CASCADE,
  step_id UUID REFERENCES sop_steps(id) ON DELETE SET NULL,
  question TEXT NOT NULL,
  options JSONB,
  correct_answer TEXT NOT NULL,
  explanation TEXT,
  difficulty TEXT DEFAULT 'medium',
  status TEXT DEFAULT 'active',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS employee_training_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id TEXT NOT NULL,
  employee_name TEXT NOT NULL,
  store TEXT,
  training_type TEXT NOT NULL,
  sop_id UUID REFERENCES sop_definitions(id),
  sop_title TEXT,
  trigger_source TEXT,
  problem_description TEXT,
  exam_score NUMERIC(5,2),
  total_questions INT,
  correct_count INT,
  attempts INT DEFAULT 1,
  passed BOOLEAN DEFAULT false,
  deadline DATE,
  passed_at TIMESTAMPTZ,
  escalated BOOLEAN DEFAULT false,
  escalated_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sop_definitions_dish ON sop_definitions(dish_name, station);
CREATE INDEX IF NOT EXISTS idx_sop_steps_sop ON sop_steps(sop_id, seq);
CREATE INDEX IF NOT EXISTS idx_sop_questions_sop ON sop_questions(sop_id);
CREATE INDEX IF NOT EXISTS idx_employee_training_records_employee ON employee_training_records(employee_id, created_at DESC);
