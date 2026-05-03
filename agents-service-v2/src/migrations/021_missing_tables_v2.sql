-- 021: Missing tables and columns for V2/V3

-- task_assignments: Agent and human assignment history
CREATE TABLE IF NOT EXISTS task_assignments (
  id SERIAL PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES master_tasks(task_id) ON DELETE CASCADE,
  assignee_type TEXT NOT NULL DEFAULT 'agent',  -- 'agent' or 'human'
  assignee_key TEXT NOT NULL,                     -- agent key or username
  assigned_by TEXT,
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  unassigned_at TIMESTAMPTZ,
  assignment_reason TEXT,
  metadata JSONB DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_task_assignments_task ON task_assignments(task_id);
CREATE INDEX IF NOT EXISTS idx_task_assignments_assignee ON task_assignments(assignee_key, assignee_type);

-- task_runs: Periodic task execution records
CREATE TABLE IF NOT EXISTS task_runs (
  id SERIAL PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES master_tasks(task_id) ON DELETE CASCADE,
  run_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  run_status TEXT NOT NULL DEFAULT 'started',  -- started, completed, failed, skipped
  run_result JSONB DEFAULT '{}',
  duration_ms INT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_task_runs_task ON task_runs(task_id);
CREATE INDEX IF NOT EXISTS idx_task_runs_status ON task_runs(run_status);

-- task_experience_logs: Task completion experience for future learning
CREATE TABLE IF NOT EXISTS task_experience_logs (
  id SERIAL PRIMARY KEY,
  category TEXT NOT NULL,
  store TEXT,
  title_pattern TEXT,
  assignee_agent TEXT,
  resolution_code TEXT,
  quality_score NUMERIC(3,2),
  time_to_close_hours NUMERIC(10,2),
  review_passed BOOLEAN,
  evidence_count INT DEFAULT 0,
  reminder_count INT DEFAULT 0,
  was_escalated BOOLEAN DEFAULT FALSE,
  lessons_learned TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_task_experience_category ON task_experience_logs(category);
CREATE INDEX IF NOT EXISTS idx_task_experience_agent ON task_experience_logs(assignee_agent);

-- Add quality_score column to master_tasks
ALTER TABLE master_tasks ADD COLUMN IF NOT EXISTS quality_score NUMERIC(3,2);
ALTER TABLE master_tasks ADD COLUMN IF NOT EXISTS assignee_human TEXT;

-- agent_capabilities config key stored in config_service (no separate table needed)
-- Added via: INSERT INTO config_service (key, value) VALUES ('agent_capabilities', '{"agents":[...]}')