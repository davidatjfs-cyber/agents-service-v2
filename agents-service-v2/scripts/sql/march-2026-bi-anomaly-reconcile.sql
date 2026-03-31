-- ═══════════════════════════════════════════════════════════════════════════
-- 2026年3月 BI 异常 (anomaly_triggers) 全量清单 + 与指定人员 agent_scores 核对
-- 在 psql 或 DBeaver 中执行；库与 agents / HRMS 共用库一致。
-- PostgreSQL：date_trunc('week', d)::date 为 ISO 周起始（周一）。
-- ═══════════════════════════════════════════════════════════════════════════

\set march_start '2026-03-01'
\set march_end   '2026-03-31'

-- ── 1) 三月全部异常触发（逐条）────────────────────────────────────────────
SELECT
  id,
  anomaly_key,
  store,
  brand,
  severity,
  trigger_date,
  date_trunc('week', trigger_date::timestamp)::date AS week_monday,
  assigned_role,
  notify_target_role,
  trigger_value::text AS trigger_value_text,
  created_at
FROM anomaly_triggers
WHERE trigger_date >= :'march_start'::date
  AND trigger_date <= :'march_end'::date
ORDER BY trigger_date, store, anomaly_key, id;

-- ── 2) 按门店×周×规则汇总（便于与周绩效对照）──────────────────────────────
SELECT
  store,
  date_trunc('week', trigger_date::timestamp)::date AS week_monday,
  anomaly_key,
  severity,
  COUNT(*) AS cnt
FROM anomaly_triggers
WHERE trigger_date >= :'march_start'::date
  AND trigger_date <= :'march_end'::date
GROUP BY 1, 2, 3, 4
ORDER BY week_monday, store, anomaly_key;

-- ── 3) 是否进入「周汇总扣分模型」（与 periodic-scoring.js 一致，供人工核对）──
SELECT
  anomaly_key,
  COUNT(*) AS march_rows,
  CASE
    WHEN anomaly_key IN (
      'revenue_achievement', 'labor_efficiency', 'table_visit_product', 'table_visit_ratio',
      'hongchao_jiuguang_private_room', 'gross_margin', 'dish_unit_product', 'cost_spike'
    ) THEN '计入周汇总(规则扣分)'
    WHEN anomaly_key = 'recharge_zero' THEN '计入周汇总(店长·充值累加)'
    WHEN anomaly_key = 'bad_review_product' THEN '计入周汇总(出品·差评)'
    WHEN anomaly_key = 'bad_review_service' THEN '计入周汇总(店长·差评)'
    WHEN anomaly_key IN ('food_safety', 'revenue_achievement_monthly') THEN '当前不进周汇总扣分'
    ELSE '未映射·当前不进周汇总'
  END AS weekly_model_note
FROM anomaly_triggers
WHERE trigger_date >= :'march_start'::date
  AND trigger_date <= :'march_end'::date
GROUP BY anomaly_key
ORDER BY march_rows DESC;

-- ── 4) 目标人员飞书绑定（姓名模糊匹配，请核对 username）────────────────────
SELECT username, name, store, role, registered, open_id IS NOT NULL AS has_open_id
FROM feishu_users
WHERE registered = true
  AND (
    name LIKE '%徐曼金%'
    OR name LIKE '%王世波%'
    OR name LIKE '%黎永荣%'
    OR name ~ '喻[峰烽]'
  )
ORDER BY store, role, username;

-- ── 5) 上述人员 2026-03 相关「周」agent_scores（anomaly_rollups_v2）──────────
WITH targets AS (
  SELECT username, name, store AS fu_store, role
  FROM feishu_users
  WHERE registered = true
    AND (
      name LIKE '%徐曼金%'
      OR name LIKE '%王世波%'
      OR name LIKE '%黎永荣%'
      OR name ~ '喻[峰烽]'
    )
)
SELECT
  a.username,
  a.name,
  a.store AS score_store,
  a.role,
  a.period,
  a.score_model,
  a.total_score,
  a.deductions,
  a.summary,
  a.updated_at
FROM agent_scores a
INNER JOIN targets t ON lower(a.username) = lower(t.username)
WHERE a.score_model = 'anomaly_rollups_v2'
  AND a.period ~ '^week_[0-9]{4}-[0-9]{2}-[0-9]{2}$'
  AND substring(a.period from 6 for 10)::date >= date_trunc('week', :'march_start'::timestamp)::date
  AND substring(a.period from 6 for 10)::date <= date_trunc('week', :'march_end'::timestamp)::date
ORDER BY substring(a.period from 6 for 10)::date, a.store, a.role, a.username;

-- ── 6) 缺口提示：某店某周有「应计入周汇总」的异常，但无 anomaly_rollups_v2 行 ─
WITH trig AS (
  SELECT
    store,
    date_trunc('week', trigger_date::timestamp)::date AS wm,
    COUNT(*) FILTER (
      WHERE anomaly_key IN (
        'revenue_achievement', 'labor_efficiency', 'table_visit_product', 'table_visit_ratio',
        'hongchao_jiuguang_private_room', 'gross_margin', 'dish_unit_product', 'cost_spike',
        'recharge_zero', 'bad_review_product', 'bad_review_service'
      )
    ) AS scored_trigger_rows
  FROM anomaly_triggers
  WHERE trigger_date >= :'march_start'::date
    AND trigger_date <= :'march_end'::date
  GROUP BY store, wm
),
scores AS (
  SELECT store, substring(period from 6 for 10)::date AS wm, COUNT(*) AS score_rows
  FROM agent_scores
  WHERE score_model = 'anomaly_rollups_v2'
    AND period LIKE 'week_%'
  GROUP BY store, substring(period from 6 for 10)::date
)
SELECT
  t.store,
  t.wm AS week_monday,
  t.scored_trigger_rows,
  COALESCE(s.score_rows, 0) AS agent_score_rows_that_week
FROM trig t
LEFT JOIN scores s ON s.store = t.store AND s.wm = t.wm
WHERE t.scored_trigger_rows > 0
  AND COALESCE(s.score_rows, 0) = 0
ORDER BY t.wm, t.store;
