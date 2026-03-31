-- P0-P2 Agent 新增表 & 索引迁移
-- 创建时间: 2026-02-26
-- 说明: 从 agents.js ensureAgentTables() 中提取的显式迁移脚本
--       包含: agent_issues, agent_messages, agent_scores, agent_appeals,
--             agent_long_memory, agent_autonomous_tasks, agent_quality_audits,
--             agent_eval_runs, agent_visual_audits, bad_reviews, feishu_users

BEGIN;

-- ── 核心 Agent 表 ──

CREATE TABLE IF NOT EXISTS agent_issues (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent VARCHAR(60) NOT NULL,
  brand VARCHAR(120),
  store VARCHAR(200),
  category VARCHAR(120),
  severity VARCHAR(20) NOT NULL DEFAULT 'medium',
  title VARCHAR(500) NOT NULL,
  detail TEXT,
  data JSONB NOT NULL DEFAULT '{}'::jsonb,
  status VARCHAR(30) NOT NULL DEFAULT 'open',
  assignee_username VARCHAR(100),
  resolved_at TIMESTAMP,
  resolution TEXT,
  feishu_notified BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS agent_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  direction VARCHAR(10) NOT NULL DEFAULT 'in',
  channel VARCHAR(30) NOT NULL DEFAULT 'feishu',
  feishu_open_id VARCHAR(200),
  sender_username VARCHAR(200),
  sender_name VARCHAR(200),
  sender_role VARCHAR(60),
  routed_to VARCHAR(60),
  content_type VARCHAR(30) NOT NULL DEFAULT 'text',
  content TEXT,
  image_urls JSONB DEFAULT '[]'::jsonb,
  agent_response TEXT,
  agent_data JSONB DEFAULT '{}'::jsonb,
  feishu_message_id VARCHAR(200),
  record_id VARCHAR(200),
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS agent_scores (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  brand VARCHAR(120) NOT NULL,
  store VARCHAR(200) NOT NULL,
  username VARCHAR(100) NOT NULL,
  name VARCHAR(200),
  role VARCHAR(60),
  period VARCHAR(20) NOT NULL,
  score_model VARCHAR(60),
  base_score NUMERIC(5,1) NOT NULL DEFAULT 100,
  total_score NUMERIC(5,1) NOT NULL DEFAULT 100,
  additions JSONB NOT NULL DEFAULT '[]'::jsonb,
  deductions JSONB NOT NULL DEFAULT '[]'::jsonb,
  breakdown JSONB NOT NULL DEFAULT '{}'::jsonb,
  summary TEXT,
  feishu_notified BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_agent_scores_period UNIQUE (brand, store, username, period)
);

CREATE TABLE IF NOT EXISTS agent_appeals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  issue_id UUID,
  score_id UUID,
  username VARCHAR(100) NOT NULL,
  reason TEXT NOT NULL,
  status VARCHAR(30) NOT NULL DEFAULT 'pending',
  agent_verdict TEXT,
  agent_data JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  resolved_at TIMESTAMP
);

-- ── P1 新增表 ──

CREATE TABLE IF NOT EXISTS agent_long_memory (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_key VARCHAR(120) NOT NULL,
  memory_key VARCHAR(120) NOT NULL,
  memory_value JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_agent_long_memory UNIQUE (user_key, memory_key)
);

CREATE TABLE IF NOT EXISTS agent_autonomous_tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  fingerprint VARCHAR(64) NOT NULL UNIQUE,
  task_type VARCHAR(80) NOT NULL,
  status VARCHAR(30) NOT NULL DEFAULT 'open',
  store VARCHAR(200),
  brand VARCHAR(120),
  requester_username VARCHAR(100),
  route VARCHAR(60),
  query_text TEXT,
  reason TEXT,
  evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  action_plan JSONB NOT NULL DEFAULT '{}'::jsonb,
  owner_username VARCHAR(100),
  notify_count INT NOT NULL DEFAULT 0,
  due_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ── P2 新增表 ──

CREATE TABLE IF NOT EXISTS agent_quality_audits (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  route VARCHAR(60),
  username VARCHAR(100),
  query_text TEXT,
  response_text TEXT,
  audit_result JSONB NOT NULL DEFAULT '{}'::jsonb,
  passed BOOLEAN,
  rewrite_count INT NOT NULL DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS agent_eval_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  suite_name VARCHAR(80) NOT NULL DEFAULT 'default',
  summary JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by VARCHAR(100),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS agent_visual_audits (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  store VARCHAR(200),
  brand VARCHAR(120),
  username VARCHAR(100) NOT NULL,
  image_url TEXT NOT NULL,
  audit_type VARCHAR(60),
  result VARCHAR(30) NOT NULL DEFAULT 'pending',
  confidence NUMERIC(4,2),
  findings TEXT,
  exif_time TIMESTAMP,
  exif_gps TEXT,
  image_hash VARCHAR(64),
  duplicate_of UUID,
  agent_raw JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ── 差评报告 ──

CREATE TABLE IF NOT EXISTS bad_reviews (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  date DATE NOT NULL,
  store VARCHAR(200) NOT NULL,
  brand VARCHAR(120),
  review_type VARCHAR(30) NOT NULL,
  content TEXT NOT NULL,
  product_name VARCHAR(200),
  service_item VARCHAR(200),
  rating INT,
  platform VARCHAR(60),
  order_id VARCHAR(100),
  customer_name VARCHAR(100),
  has_detailed_event BOOLEAN DEFAULT FALSE,
  event_detail TEXT,
  sop_case_id UUID,
  status VARCHAR(30) DEFAULT 'open',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ── Feishu 用户映射 ──

CREATE TABLE IF NOT EXISTS feishu_users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  open_id VARCHAR(200) NOT NULL UNIQUE,
  username VARCHAR(100),
  name VARCHAR(200),
  mobile VARCHAR(30),
  store VARCHAR(200),
  role VARCHAR(60),
  registered BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ── 索引 ──

CREATE INDEX IF NOT EXISTS idx_agent_issues_store ON agent_issues (store, status);
CREATE INDEX IF NOT EXISTS idx_agent_issues_assignee ON agent_issues (assignee_username, status);
CREATE INDEX IF NOT EXISTS idx_agent_messages_sender ON agent_messages (feishu_open_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_messages_record_id ON agent_messages (record_id) WHERE record_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_agent_scores_user ON agent_scores (username, period);
CREATE INDEX IF NOT EXISTS idx_agent_visual_store ON agent_visual_audits (store, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_feishu_users_openid ON feishu_users (open_id);
CREATE INDEX IF NOT EXISTS idx_feishu_users_username ON feishu_users (username);
CREATE INDEX IF NOT EXISTS idx_agent_long_memory_user ON agent_long_memory (user_key, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_autonomous_tasks_status ON agent_autonomous_tasks (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_autonomous_tasks_store ON agent_autonomous_tasks (store, status);
CREATE INDEX IF NOT EXISTS idx_agent_quality_audits_route ON agent_quality_audits (route, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_eval_runs_created ON agent_eval_runs (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_bad_reviews_store_date ON bad_reviews (store, date);
CREATE INDEX IF NOT EXISTS idx_bad_reviews_type ON bad_reviews (review_type, product_name, service_item);
CREATE INDEX IF NOT EXISTS idx_bad_reviews_detailed ON bad_reviews (has_detailed_event) WHERE has_detailed_event = TRUE;

-- ── 兼容性列迁移 ──

ALTER TABLE agent_issues ADD COLUMN IF NOT EXISTS feishu_notified BOOLEAN DEFAULT FALSE;
ALTER TABLE agent_scores ADD COLUMN IF NOT EXISTS feishu_notified BOOLEAN DEFAULT FALSE;
ALTER TABLE agent_scores ADD COLUMN IF NOT EXISTS name VARCHAR(200);
ALTER TABLE agent_messages ADD COLUMN IF NOT EXISTS record_id VARCHAR(200);
ALTER TABLE agent_messages ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;

COMMIT;
