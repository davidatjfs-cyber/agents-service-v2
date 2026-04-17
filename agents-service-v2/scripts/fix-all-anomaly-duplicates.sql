-- ═══════════════════════════════════════════════════════════
-- Fix: ALL anomaly types duplicate triggers
-- Adds full table unique constraint and cleans existing duplicates
-- ═══════════════════════════════════════════════════════════

-- Step 1: Start transaction
BEGIN;

-- Step 2: Clean existing duplicates for ALL anomaly types
-- Keep the earliest record (MIN id) for each unique combination
DELETE FROM anomaly_triggers a
WHERE a.id NOT IN (
    SELECT MIN(id)
    FROM anomaly_triggers
    GROUP BY anomaly_key, store, trigger_date
);

-- Step 3: Drop old indexes
DROP INDEX IF EXISTS idx_anomaly_triggers_key;
DROP INDEX IF EXISTS idx_anomaly_triggers_key_unique;

-- Step 4: Create full table unique index for ALL anomaly types
CREATE UNIQUE INDEX idx_anomaly_triggers_key_unique
    ON anomaly_triggers(anomaly_key, store, trigger_date);

-- Step 5: Verify
SELECT
    'Duplicates remaining' as check_item,
    COUNT(*) as count
FROM (
    SELECT anomaly_key, store, trigger_date, COUNT(*) as cnt
    FROM anomaly_triggers
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
