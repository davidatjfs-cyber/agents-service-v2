-- 核对「晨报月目标」与 daily_reports 门店名、period 格式是否一致（例：洪潮 2026-03 目标 850000）
-- 在 psql / 客户端中执行，按需改门店关键词。

-- 1) revenue_targets：当月所有行 + 是否像洪潮
SELECT store,
       period,
       target_revenue,
       updated_at
FROM revenue_targets
WHERE period IN ('2026-03', '202603', '2026/03')
ORDER BY store;

-- 2) daily_reports：本月有营业数据的门店（看 store 字段实际写法）
SELECT store,
       COUNT(*)::int AS days,
       SUM(actual_revenue)::numeric AS month_rev
FROM daily_reports
WHERE TO_CHAR(date, 'YYYY-MM') = '2026-03'
GROUP BY store
ORDER BY month_rev DESC NULLS LAST;

-- 3) 单行核对：某门店关键词在两张表中的出现情况（把 %洪潮% 换成你的关键词）
SELECT 'revenue_targets' AS src, store, period, target_revenue
FROM revenue_targets
WHERE store ILIKE '%洪潮%'
   OR store ILIKE '%hong%chao%'
UNION ALL
SELECT 'daily_reports' AS src, store, TO_CHAR(MAX(date), 'YYYY-MM') AS period, SUM(actual_revenue) AS target_revenue
FROM daily_reports
WHERE store ILIKE '%洪潮%'
  AND TO_CHAR(date, 'YYYY-MM') = '2026-03'
GROUP BY store;
