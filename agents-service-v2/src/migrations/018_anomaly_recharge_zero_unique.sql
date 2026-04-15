-- 充值异常：同一门店 + 同一触发营业日仅保留一条，避免并发/重复调度产生双行
-- 1) 统一首尾空格
UPDATE anomaly_triggers
SET store = trim(store)
WHERE anomaly_key = 'recharge_zero' AND store IS NOT NULL AND store <> trim(store);

-- 2) 删除重复（保留最小 id）
DELETE FROM anomaly_triggers a
WHERE a.anomaly_key = 'recharge_zero'
  AND EXISTS (
    SELECT 1
    FROM anomaly_triggers b
    WHERE b.anomaly_key = 'recharge_zero'
      AND b.store = a.store
      AND b.trigger_date = a.trigger_date
      AND b.id < a.id
  );

-- 3) 部分唯一索引（仅 recharge_zero）
CREATE UNIQUE INDEX IF NOT EXISTS uq_anomaly_triggers_recharge_zero_store_day
ON anomaly_triggers (anomaly_key, store, trigger_date)
WHERE anomaly_key = 'recharge_zero';
