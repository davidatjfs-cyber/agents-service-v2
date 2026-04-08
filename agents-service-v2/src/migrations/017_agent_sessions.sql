-- Migration: Create agent_sessions table
-- Description: Store agent conversation sessions for multi-turn dialogue support
-- Created: 2026-04-09

CREATE TABLE IF NOT EXISTS agent_sessions (
  session_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  store TEXT,
  agent TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'active',
  context JSONB DEFAULT '{}',
  pending_question TEXT,
  question_round INTEGER DEFAULT 0,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_agent_sessions_user_id ON agent_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_agent_sessions_state ON agent_sessions(state);
CREATE INDEX IF NOT EXISTS idx_agent_sessions_agent ON agent_sessions(agent);
CREATE INDEX IF NOT EXISTS idx_agent_sessions_updated_at ON agent_sessions(updated_at);

-- Index for cleanup of expired sessions
CREATE INDEX IF NOT EXISTS idx_agent_sessions_updated_at_expire ON agent_sessions(updated_at) WHERE state = 'active';

-- Add comment
COMMENT ON TABLE agent_sessions IS 'Agent conversation sessions for multi-turn dialogue support';
COMMENT ON COLUMN agent_sessions.state IS 'Session state: active, closed, expired, replaced, max_rounds_exceeded';
COMMENT ON COLUMN agent_sessions.question_round IS 'Number of questions asked (max: 3)';
COMMENT ON COLUMN agent_sessions.context IS 'JSONB context accumulated during the session';
COMMENT ON COLUMN agent_sessions.pending_question IS 'The last question asked to the user';
