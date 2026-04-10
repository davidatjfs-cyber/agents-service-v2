-- 与 005 设计对齐：历史环境若先建了无 base_score 的 agent_scores，补列避免旧 SQL/工具报错
ALTER TABLE agent_scores ADD COLUMN IF NOT EXISTS base_score NUMERIC(5, 1) DEFAULT 100;
