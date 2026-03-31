BEGIN;

-- Unique partial index on agent_messages for ON CONFLICT dedup
-- Only applies to rows where record_id is non-null and non-empty
CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_messages_record_content_uniq
  ON agent_messages (record_id, content_type)
  WHERE record_id IS NOT NULL AND record_id != '';

-- feishu_generic_records already has: unique (app_token, table_id, record_id)
-- No additional index needed.

COMMIT;
