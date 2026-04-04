-- 只读诊断：入职审批已通过，但员工未出现在「员工信息」时排查用。
-- 员工主数据在 hrms_state.data->'employees'（JSON 数组），审批在 approval_requests。
--
-- 用法：把下面 :emp_name 换成姓名片段（如 余才东），或用 :approval_id 精确查。

-- ── 1) 按姓名查最近通过的入职审批（看 id、账号、门店、payload 摘要） ──
SELECT
  ar.id AS approval_id,
  ar.type,
  ar.status,
  ar.applicant_username,
  ar.updated_at,
  ar.created_at,
  ar.payload->'employee'->>'name'   AS emp_name,
  ar.payload->'employee'->>'username' AS emp_username,
  ar.payload->'employee'->>'store' AS emp_store,
  ar.payload->'employee'->>'joinDate' AS join_date,
  ar.payload->'employee'->>'position' AS position,
  ar.payload AS full_payload
FROM approval_requests ar
WHERE ar.type = 'onboarding'
  AND ar.status = 'approved'
  AND (ar.payload->'employee'->>'name') ILIKE '%' || '余才东' || '%'
ORDER BY ar.updated_at DESC
LIMIT 10;

-- ── 2) 已知审批 id 时（把 UUID 换成上一步查到的 approval_id） ──
-- SELECT id, status, type, payload, updated_at FROM approval_requests WHERE id = 'YOUR-UUID-HERE';

-- ── 3) 已知登录账号 emp_username 时：是否在 hrms_state.employees / users 里 ──
-- 把 :u 换成小写账号做比对（与业务里 lower(username) 一致）
WITH u AS (SELECT lower(trim('REPLACE_WITH_USERNAME')) AS login)
SELECT
  h.key,
  EXISTS (
    SELECT 1
    FROM jsonb_array_elements(h.data->'employees') e, u
    WHERE lower(trim(e->>'username')) = u.login
  ) AS in_employees,
  EXISTS (
    SELECT 1
    FROM jsonb_array_elements(
      CASE WHEN jsonb_typeof(h.data->'users') = 'array' THEN h.data->'users' ELSE '[]'::jsonb END
    ) x, u
    WHERE lower(trim(x->>'username')) = u.login
  ) AS in_users_json,
  (
    SELECT e->>'name'
    FROM jsonb_array_elements(h.data->'employees') e, u
    WHERE lower(trim(e->>'username')) = u.login
    LIMIT 1
  ) AS employee_matched_name
FROM hrms_state h
CROSS JOIN u
WHERE h.key = 'default';

-- ── 4) 可选：PostgreSQL 登录表 users（若你们用独立表做登录，与 hrms_state 可能不同步） ──
-- SELECT id, username, real_name, role, is_active FROM users WHERE lower(username) = lower('REPLACE_WITH_USERNAME') LIMIT 5;
