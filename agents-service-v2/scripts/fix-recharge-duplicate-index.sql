-- ═══════════════════════════════════════════════════════════
-- Fix: recharge_zero duplicate triggers
-- Adds partial unique index and cleans existing duplicates
-- ═══════════════════════════════════════════════════════════

-- Step 1: Start transaction
BEGIN;

-- Step 2: Clean existing duplicates for recharge_zero
-- Keep the earliest record (MIN id) for each unique combination
DELETE FROM anomaly_triggers a
WHERE a.id NOT IN (
    SELECT MIN(id)
    FROM anomaly_triggers
    WHERE anomaly_key = 'recharge_zero'
    GROUP BY anomaly_key, store, trigger_date
)
AND a.anomaly_key = 'recharge_zero';

-- Step 3: Drop old non-unique index if exists
DROP INDEX IF EXISTS idx_anomaly_triggers_key;

-- Step 4: Create partial unique index for recharge_zero
-- This matches the ON CONFLICT clause in code
CREATE UNIQUE INDEX idx_anomaly_triggers_key_unique
    ON anomaly_triggers(anomaly_key, store, trigger_date)
    WHERE anomaly_key = 'recharge_zero';

-- Step 5: Verify
SELECT
    'Duplicates remaining' as check_item,
    COUNT(*) as count
FROM (
    SELECT anomaly_key, store, trigger_date, COUNT(*) as cnt
    FROM anomaly_triggers
    WHERE anomaly_key = 'recharge_zero'
    GROUP BY anomaly_key, store, trigger_date
    HAVING COUNT(*) > 1
) t
UNION ALL
SELECT
    'Index exists' as check_item,
    COUNT(*) as count
FROM pg_indexes
WHERE indexname = 'idx_anomaly_triggers_key_unique';

-- Step 6: Commit
COMMIT;
