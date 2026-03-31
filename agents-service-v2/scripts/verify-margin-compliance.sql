-- sales_raw 最新业务日期（全表）
SELECT MAX(date)::date AS sales_raw_latest_date FROM sales_raw;

-- 在可访问生产/预发 Postgres 的机器上执行（非必须本地；ECS、本机装了 psql 均可）
-- psql "$DATABASE_URL" -f scripts/verify-margin-compliance.sql
-- 或将下方 SQL 贴到 DBeaver / pgAdmin

-- 1) 绩效/BI 使用的月度实收毛利率（飞书「实际毛利率表」同步写入）
SELECT store,
       brand,
       period,
       actual_margin AS 实收毛利率_百分数,
       source,
       CASE
         WHEN brand = '马己仙' AND actual_margin < 63 THEN 'high'
         WHEN brand = '马己仙' AND actual_margin < 64 THEN 'medium'
         WHEN brand = '洪潮' AND actual_margin < 68 THEN 'high'
         WHEN brand = '洪潮' AND actual_margin < 69 THEN 'medium'
         ELSE 'ok'
       END AS 实收毛利率异常档位
FROM monthly_margins
WHERE period = '2026-02'
ORDER BY brand, store;

-- 2) 飞书原始行（核对门店名、月份是否与 monthly_margins 一致）
SELECT fields->>'门店' AS 门店,
       fields->>'毛利日期' AS 毛利日期,
       fields->>'实收毛利率' AS 实收毛利率_原始,
       updated_at
FROM feishu_generic_records
WHERE config_key = 'actual_gross_margin'
ORDER BY updated_at DESC
LIMIT 80;

-- 3) agent_v2_configs 里 BI 阈值（应与 patch-anomaly-gross-margin-thresholds 一致）
SELECT config_key,
       config_value->'gross_margin'->'threshold' AS gross_margin_thresholds
FROM agent_v2_configs
WHERE config_key = 'anomaly_rules';
