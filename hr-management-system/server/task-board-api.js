import { pool as getPool } from './utils/database.js';
function pool() { return getPool(); }

export async function ensureTaskBoardSchema() {
  const p = pool();
  try {
    await p.query(`DO $$ BEGIN ALTER TABLE master_tasks ADD COLUMN IF NOT EXISTS timeout_at TIMESTAMPTZ; EXCEPTION WHEN others THEN NULL; END $$;`);
    await p.query(`DO $$ BEGIN ALTER TABLE master_tasks ADD COLUMN IF NOT EXISTS escalation_level INT DEFAULT 0; EXCEPTION WHEN others THEN NULL; END $$;`);
    await p.query(`DO $$ BEGIN ALTER TABLE master_tasks ADD COLUMN IF NOT EXISTS escalated_to TEXT; EXCEPTION WHEN others THEN NULL; END $$;`);
    await p.query(`DO $$ BEGIN ALTER TABLE master_tasks ADD COLUMN IF NOT EXISTS escalation_history JSONB DEFAULT '[]'::jsonb; EXCEPTION WHEN others THEN NULL; END $$;`);
    await p.query(`CREATE INDEX IF NOT EXISTS idx_mt_timeout ON master_tasks (timeout_at) WHERE timeout_at IS NOT NULL AND status NOT IN ('resolved','closed','settled');`);
    console.log('[TaskBoard] Schema ensured');
  } catch (e) { console.error('[TaskBoard] schema error:', e?.message); }
}