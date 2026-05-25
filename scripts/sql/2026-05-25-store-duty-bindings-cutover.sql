BEGIN;

-- 1) 统一建立职责绑定表（即使迁移尚未跑，这份脚本也可单独执行）
CREATE TABLE IF NOT EXISTS store_duty_bindings (
  id BIGSERIAL PRIMARY KEY,
  username VARCHAR(120) NOT NULL,
  store VARCHAR(160) NOT NULL,
  access_level VARCHAR(40) NOT NULL DEFAULT 'support',
  is_primary_store BOOLEAN NOT NULL DEFAULT FALSE,
  can_receive_ops BOOLEAN NOT NULL DEFAULT FALSE,
  can_receive_performance BOOLEAN NOT NULL DEFAULT FALSE,
  can_receive_food_safety BOOLEAN NOT NULL DEFAULT FALSE,
  can_receive_approval BOOLEAN NOT NULL DEFAULT FALSE,
  can_handle_ops BOOLEAN NOT NULL DEFAULT FALSE,
  can_handle_food_safety BOOLEAN NOT NULL DEFAULT FALSE,
  can_approve_hrms BOOLEAN NOT NULL DEFAULT FALSE,
  can_view_employees BOOLEAN NOT NULL DEFAULT FALSE,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  effective_from TIMESTAMPTZ NULL,
  effective_to TIMESTAMPTZ NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (username, store)
);

CREATE INDEX IF NOT EXISTS idx_store_duty_bindings_lookup
  ON store_duty_bindings (LOWER(username), LOWER(store), enabled);

-- 2) 通过姓名自动解析 HRMS username，避免人工再查账号
WITH state_people AS (
  SELECT
    TRIM(rec.username) AS username,
    TRIM(rec.name) AS name,
    TRIM(rec.store) AS store
  FROM hrms_state s
  CROSS JOIN LATERAL jsonb_to_recordset(COALESCE(s.data->'employees', '[]'::jsonb))
    AS rec(username text, name text, store text)
  WHERE s.key = 'default'
  UNION
  SELECT
    TRIM(rec.username) AS username,
    TRIM(rec.name) AS name,
    TRIM(rec.store) AS store
  FROM hrms_state s
  CROSS JOIN LATERAL jsonb_to_recordset(COALESCE(s.data->'users', '[]'::jsonb))
    AS rec(username text, name text, store text)
  WHERE s.key = 'default'
),
resolved_people AS (
  SELECT DISTINCT ON (name)
    username,
    name,
    store
  FROM state_people
  WHERE name IN ('喻烽', '喻峰', '田海伶')
    AND username IS NOT NULL
    AND username <> ''
  ORDER BY name, username
)
SELECT * FROM resolved_people;

-- 3) 补齐田海伶飞书绑定；如果已存在则按 username / open_id 双向更新
WITH state_people AS (
  SELECT
    TRIM(rec.username) AS username,
    TRIM(rec.name) AS name,
    TRIM(rec.store) AS store
  FROM hrms_state s
  CROSS JOIN LATERAL jsonb_to_recordset(COALESCE(s.data->'employees', '[]'::jsonb))
    AS rec(username text, name text, store text)
  WHERE s.key = 'default'
  UNION
  SELECT
    TRIM(rec.username) AS username,
    TRIM(rec.name) AS name,
    TRIM(rec.store) AS store
  FROM hrms_state s
  CROSS JOIN LATERAL jsonb_to_recordset(COALESCE(s.data->'users', '[]'::jsonb))
    AS rec(username text, name text, store text)
  WHERE s.key = 'default'
),
thl AS (
  SELECT DISTINCT ON (name)
    username,
    name,
    store
  FROM state_people
  WHERE name = '田海伶'
    AND username IS NOT NULL
    AND username <> ''
)
INSERT INTO feishu_users (username, name, role, store, open_id, registered)
SELECT
  thl.username,
  '田海伶',
  'front_manager',
  COALESCE(NULLIF(thl.store, ''), '马己仙上海音乐广场店'),
  'ou_8b67c1e4ea17b0ffff914c92cfcc5fe6',
  TRUE
FROM thl
ON CONFLICT (open_id) DO UPDATE SET
  username = EXCLUDED.username,
  name = EXCLUDED.name,
  role = EXCLUDED.role,
  store = EXCLUDED.store,
  registered = TRUE;

UPDATE feishu_users
SET
  open_id = 'ou_8b67c1e4ea17b0ffff914c92cfcc5fe6',
  name = '田海伶',
  role = 'front_manager',
  store = '马己仙上海音乐广场店',
  registered = TRUE
WHERE LOWER(TRIM(username)) = LOWER(TRIM((
  SELECT username
  FROM (
    SELECT
      TRIM(rec.username) AS username,
      TRIM(rec.name) AS name
    FROM hrms_state s
    CROSS JOIN LATERAL jsonb_to_recordset(COALESCE(s.data->'employees', '[]'::jsonb))
      AS rec(username text, name text)
    WHERE s.key = 'default'
    UNION
    SELECT
      TRIM(rec.username) AS username,
      TRIM(rec.name) AS name
    FROM hrms_state s
    CROSS JOIN LATERAL jsonb_to_recordset(COALESCE(s.data->'users', '[]'::jsonb))
      AS rec(username text, name text)
    WHERE s.key = 'default'
  ) t
  WHERE t.name = '田海伶'
  LIMIT 1
)));

-- 4) 重置喻烽 / 田海伶职责绑定，再写入切换日配置
DELETE FROM store_duty_bindings
WHERE LOWER(TRIM(username)) IN (
  LOWER(TRIM((
    SELECT username
    FROM (
      SELECT TRIM(rec.username) AS username, TRIM(rec.name) AS name
      FROM hrms_state s
      CROSS JOIN LATERAL jsonb_to_recordset(COALESCE(s.data->'employees', '[]'::jsonb))
        AS rec(username text, name text)
      WHERE s.key = 'default'
      UNION
      SELECT TRIM(rec.username) AS username, TRIM(rec.name) AS name
      FROM hrms_state s
      CROSS JOIN LATERAL jsonb_to_recordset(COALESCE(s.data->'users', '[]'::jsonb))
        AS rec(username text, name text)
      WHERE s.key = 'default'
    ) t
    WHERE t.name IN ('喻烽', '喻峰')
    LIMIT 1
  ))),
  LOWER(TRIM((
    SELECT username
    FROM (
      SELECT TRIM(rec.username) AS username, TRIM(rec.name) AS name
      FROM hrms_state s
      CROSS JOIN LATERAL jsonb_to_recordset(COALESCE(s.data->'employees', '[]'::jsonb))
        AS rec(username text, name text)
      WHERE s.key = 'default'
      UNION
      SELECT TRIM(rec.username) AS username, TRIM(rec.name) AS name
      FROM hrms_state s
      CROSS JOIN LATERAL jsonb_to_recordset(COALESCE(s.data->'users', '[]'::jsonb))
        AS rec(username text, name text)
      WHERE s.key = 'default'
    ) t
    WHERE t.name = '田海伶'
    LIMIT 1
  )))
);

WITH people AS (
  SELECT DISTINCT ON (name)
    username,
    name
  FROM (
    SELECT TRIM(rec.username) AS username, TRIM(rec.name) AS name
    FROM hrms_state s
    CROSS JOIN LATERAL jsonb_to_recordset(COALESCE(s.data->'employees', '[]'::jsonb))
      AS rec(username text, name text)
    WHERE s.key = 'default'
    UNION
    SELECT TRIM(rec.username) AS username, TRIM(rec.name) AS name
    FROM hrms_state s
    CROSS JOIN LATERAL jsonb_to_recordset(COALESCE(s.data->'users', '[]'::jsonb))
      AS rec(username text, name text)
    WHERE s.key = 'default'
  ) t
  WHERE name IN ('喻烽', '喻峰', '田海伶')
    AND username IS NOT NULL
    AND username <> ''
  ORDER BY name, username
),
yufeng AS (
  SELECT username, COALESCE(NULLIF(name, ''), '喻烽') AS name
  FROM people
  WHERE name IN ('喻烽', '喻峰')
  LIMIT 1
),
tianhailing AS (
  SELECT username, name
  FROM people
  WHERE name = '田海伶'
  LIMIT 1
)
INSERT INTO store_duty_bindings (
  username, store, access_level, is_primary_store,
  can_receive_ops, can_receive_performance, can_receive_food_safety, can_receive_approval,
  can_handle_ops, can_handle_food_safety, can_approve_hrms, can_view_employees,
  enabled, effective_from, metadata
)
SELECT
  y.username, v.store, v.access_level, v.is_primary_store,
  v.can_receive_ops, v.can_receive_performance, v.can_receive_food_safety, v.can_receive_approval,
  v.can_handle_ops, v.can_handle_food_safety, v.can_approve_hrms, v.can_view_employees,
  TRUE, '2026-05-26 00:00:00+08',
  v.metadata::jsonb
FROM yufeng y
CROSS JOIN (
  VALUES
    ('洪潮大宁久光店', 'primary', TRUE,  TRUE, TRUE, TRUE, TRUE, TRUE, TRUE, TRUE, TRUE, '{"duty":"主负责"}'),
    ('马己仙上海音乐广场店', 'support', FALSE, TRUE, TRUE, TRUE, TRUE, TRUE, TRUE, TRUE, TRUE, '{"duty":"监管"}')
) AS v(
  store, access_level, is_primary_store,
  can_receive_ops, can_receive_performance, can_receive_food_safety, can_receive_approval,
  can_handle_ops, can_handle_food_safety, can_approve_hrms, can_view_employees,
  metadata
)
ON CONFLICT (username, store) DO UPDATE SET
  access_level = EXCLUDED.access_level,
  is_primary_store = EXCLUDED.is_primary_store,
  can_receive_ops = EXCLUDED.can_receive_ops,
  can_receive_performance = EXCLUDED.can_receive_performance,
  can_receive_food_safety = EXCLUDED.can_receive_food_safety,
  can_receive_approval = EXCLUDED.can_receive_approval,
  can_handle_ops = EXCLUDED.can_handle_ops,
  can_handle_food_safety = EXCLUDED.can_handle_food_safety,
  can_approve_hrms = EXCLUDED.can_approve_hrms,
  can_view_employees = EXCLUDED.can_view_employees,
  enabled = TRUE,
  effective_from = EXCLUDED.effective_from,
  metadata = EXCLUDED.metadata,
  updated_at = NOW();

WITH people AS (
  SELECT DISTINCT ON (name)
    username,
    name
  FROM (
    SELECT TRIM(rec.username) AS username, TRIM(rec.name) AS name
    FROM hrms_state s
    CROSS JOIN LATERAL jsonb_to_recordset(COALESCE(s.data->'employees', '[]'::jsonb))
      AS rec(username text, name text)
    WHERE s.key = 'default'
    UNION
    SELECT TRIM(rec.username) AS username, TRIM(rec.name) AS name
    FROM hrms_state s
    CROSS JOIN LATERAL jsonb_to_recordset(COALESCE(s.data->'users', '[]'::jsonb))
      AS rec(username text, name text)
    WHERE s.key = 'default'
  ) t
  WHERE name = '田海伶'
    AND username IS NOT NULL
    AND username <> ''
  ORDER BY name, username
)
INSERT INTO store_duty_bindings (
  username, store, access_level, is_primary_store,
  can_receive_ops, can_receive_performance, can_receive_food_safety, can_receive_approval,
  can_handle_ops, can_handle_food_safety, can_approve_hrms, can_view_employees,
  enabled, effective_from, metadata
)
SELECT
  p.username,
  '马己仙上海音乐广场店',
  'support',
  FALSE,
  TRUE, TRUE, TRUE, FALSE,
  TRUE, TRUE, FALSE, FALSE,
  TRUE,
  '2026-05-26 00:00:00+08',
  '{"duty":"非审批协同"}'::jsonb
FROM people p
ON CONFLICT (username, store) DO UPDATE SET
  access_level = EXCLUDED.access_level,
  is_primary_store = EXCLUDED.is_primary_store,
  can_receive_ops = EXCLUDED.can_receive_ops,
  can_receive_performance = EXCLUDED.can_receive_performance,
  can_receive_food_safety = EXCLUDED.can_receive_food_safety,
  can_receive_approval = EXCLUDED.can_receive_approval,
  can_handle_ops = EXCLUDED.can_handle_ops,
  can_handle_food_safety = EXCLUDED.can_handle_food_safety,
  can_approve_hrms = EXCLUDED.can_approve_hrms,
  can_view_employees = EXCLUDED.can_view_employees,
  enabled = TRUE,
  effective_from = EXCLUDED.effective_from,
  metadata = EXCLUDED.metadata,
  updated_at = NOW();

-- 5) 同一 username 只保留一条主门店标记
UPDATE store_duty_bindings b
SET is_primary_store = FALSE,
    updated_at = NOW()
WHERE is_primary_store = TRUE
  AND EXISTS (
    SELECT 1
    FROM store_duty_bindings newer
    WHERE LOWER(TRIM(newer.username)) = LOWER(TRIM(b.username))
      AND newer.is_primary_store = TRUE
      AND newer.id <> b.id
      AND LOWER(TRIM(newer.store)) <> LOWER(TRIM(b.store))
  )
  AND LOWER(TRIM(b.username)) IN (
    LOWER(TRIM((
      SELECT username
      FROM (
        SELECT TRIM(rec.username) AS username, TRIM(rec.name) AS name
        FROM hrms_state s
        CROSS JOIN LATERAL jsonb_to_recordset(COALESCE(s.data->'employees', '[]'::jsonb))
          AS rec(username text, name text)
        WHERE s.key = 'default'
        UNION
        SELECT TRIM(rec.username) AS username, TRIM(rec.name) AS name
        FROM hrms_state s
        CROSS JOIN LATERAL jsonb_to_recordset(COALESCE(s.data->'users', '[]'::jsonb))
          AS rec(username text, name text)
        WHERE s.key = 'default'
      ) t
      WHERE t.name IN ('喻烽', '喻峰')
      LIMIT 1
    ))),
    LOWER(TRIM((
      SELECT username
      FROM (
        SELECT TRIM(rec.username) AS username, TRIM(rec.name) AS name
        FROM hrms_state s
        CROSS JOIN LATERAL jsonb_to_recordset(COALESCE(s.data->'employees', '[]'::jsonb))
          AS rec(username text, name text)
        WHERE s.key = 'default'
        UNION
        SELECT TRIM(rec.username) AS username, TRIM(rec.name) AS name
        FROM hrms_state s
        CROSS JOIN LATERAL jsonb_to_recordset(COALESCE(s.data->'users', '[]'::jsonb))
          AS rec(username text, name text)
        WHERE s.key = 'default'
      ) t
      WHERE t.name = '田海伶'
      LIMIT 1
    )))
  );

COMMIT;
