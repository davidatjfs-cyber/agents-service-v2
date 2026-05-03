-- V0: Agent task-board orchestration metadata.
ALTER TABLE master_tasks ADD COLUMN IF NOT EXISTS parent_task_id TEXT;
ALTER TABLE master_tasks ADD COLUMN IF NOT EXISTS related_task_ids JSONB DEFAULT '[]'::jsonb;
ALTER TABLE master_tasks ADD COLUMN IF NOT EXISTS created_from TEXT;
ALTER TABLE master_tasks ADD COLUMN IF NOT EXISTS assignee_agent TEXT;
ALTER TABLE master_tasks ADD COLUMN IF NOT EXISTS task_intent JSONB DEFAULT '{}'::jsonb;
ALTER TABLE master_tasks ADD COLUMN IF NOT EXISTS acceptance_rules JSONB DEFAULT '[]'::jsonb;
ALTER TABLE master_tasks ADD COLUMN IF NOT EXISTS evidence_requirements JSONB DEFAULT '[]'::jsonb;
ALTER TABLE master_tasks ADD COLUMN IF NOT EXISTS schedule_rule JSONB;
ALTER TABLE master_tasks ADD COLUMN IF NOT EXISTS next_run_at TIMESTAMPTZ;
ALTER TABLE master_tasks ADD COLUMN IF NOT EXISTS priority TEXT;
ALTER TABLE master_tasks ADD COLUMN IF NOT EXISTS last_activity_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_master_tasks_source_status ON master_tasks(source, status);
CREATE INDEX IF NOT EXISTS idx_master_tasks_assignee_agent ON master_tasks(assignee_agent);
CREATE INDEX IF NOT EXISTS idx_master_tasks_parent_task_id ON master_tasks(parent_task_id);
CREATE INDEX IF NOT EXISTS idx_master_tasks_last_activity_at ON master_tasks(last_activity_at DESC);

CREATE TABLE IF NOT EXISTS task_evidences (
  id BIGSERIAL PRIMARY KEY,
  task_id TEXT NOT NULL,
  evidence_type TEXT NOT NULL DEFAULT 'text',
  content TEXT,
  file_url TEXT,
  submitted_by TEXT,
  submitted_role TEXT,
  review_status TEXT DEFAULT 'pending',
  metadata JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS task_reviews (
  id BIGSERIAL PRIMARY KEY,
  task_id TEXT NOT NULL,
  decision TEXT NOT NULL,
  comment TEXT,
  reviewed_by TEXT,
  reviewed_role TEXT,
  metadata JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_task_evidences_task_id ON task_evidences(task_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_task_reviews_task_id ON task_reviews(task_id, created_at DESC);
