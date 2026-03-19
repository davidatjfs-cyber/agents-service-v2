-- Migration 003: Campaign评估闭环 + Agent记忆增强
-- 2026-03-08

-- 1. marketing_campaigns 新增评估字段
ALTER TABLE marketing_campaigns ADD COLUMN IF NOT EXISTS evaluation_score NUMERIC(3,1);
ALTER TABLE marketing_campaigns ADD COLUMN IF NOT EXISTS evaluation_outcome TEXT;

-- 2. 确保 agent_memory 表存在（完整结构）
CREATE TABLE IF NOT EXISTS agent_memory (
  id SERIAL PRIMARY KEY,
  agent_id TEXT NOT NULL,
  store TEXT,
  memory_type TEXT DEFAULT 'interaction',  -- 'interaction', 'outcome', 'decision'
  content TEXT NOT NULL,
  context JSONB DEFAULT '{}'::jsonb,
  outcome TEXT,
  outcome_score NUMERIC(3,1),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_agent_memory_agent ON agent_memory(agent_id, store, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_memory_type ON agent_memory(memory_type, outcome_score);

-- 3. 确保 knowledge_base 有 enabled 字段
ALTER TABLE knowledge_base ADD COLUMN IF NOT EXISTS enabled BOOLEAN DEFAULT true;
