-- 022: task_locks table + performance indexes for task board
-- Run: PGPASSWORD=xxx psql -h 127.0.0.1 -U postgres -d hrms -f src/migrations/022_task_locks_and_indexes.sql

BEGIN;

-- task_locks: prevent duplicate claims and concurrent conflicts
CREATE TABLE IF NOT EXISTS task_locks (
  id SERIAL PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES master_tasks(task_id) ON DELETE CASCADE,
  lock_type TEXT NOT NULL DEFAULT 'claim',
  locked_by TEXT NOT NULL,
  locked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ,
  metadata JSONB DEFAULT '{}'
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_task_locks_task_lock_type ON task_locks(task_id, lock_type);
CREATE INDEX IF NOT EXISTS idx_task_locks_expires ON task_locks(expires_at) WHERE expires_at IS NOT NULL;

-- Performance indexes for task board queries
CREATE INDEX IF NOT EXISTS idx_master_tasks_status ON master_tasks(status);
CREATE INDEX IF NOT EXISTS idx_master_tasks_assignee_agent ON master_tasks(assignee_agent);
CREATE INDEX IF NOT EXISTS idx_master_tasks_deadline ON master_tasks(timeout_at);
CREATE INDEX IF NOT EXISTS idx_master_tasks_parent ON master_tasks(parent_task_id);
CREATE INDEX IF NOT EXISTS idx_master_tasks_last_activity ON master_tasks(last_activity_at);
CREATE INDEX IF NOT EXISTS idx_master_tasks_source ON master_tasks(source);
CREATE INDEX IF NOT EXISTS idx_master_tasks_category ON master_tasks(category);
CREATE INDEX IF NOT EXISTS idx_master_tasks_created_from ON master_tasks(created_from);

-- experience_logs index for similar task retrieval
CREATE INDEX IF NOT EXISTS idx_task_experience_logs_category ON task_experience_logs(category);
CREATE INDEX IF NOT EXISTS idx_task_experience_logs_category_store ON task_experience_logs(category, store);

COMMIT;
