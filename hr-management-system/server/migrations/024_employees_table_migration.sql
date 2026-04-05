-- 员工信息表迁移文件：从 startup 同步逻辑提取
-- 创建时间: 2026-04-05
-- 背景：employees 表只在代码里动态创建，无迁移文件

CREATE TABLE IF NOT EXISTS employees (
  id TEXT PRIMARY KEY,
  username VARCHAR(100) NOT NULL UNIQUE,
  name VARCHAR(200),
  role VARCHAR(60),
  store VARCHAR(200),
  department VARCHAR(100),
  position VARCHAR(100),
  status VARCHAR(30) DEFAULT 'active',
  gender VARCHAR(10),
  phone VARCHAR(30),
  email VARCHAR(100),
  join_date VARCHAR(20),
  birthday VARCHAR(20),
  salary VARCHAR(50),
  password_hash VARCHAR(255),
  manager_username VARCHAR(100),
  id_card_number VARCHAR(50),
  bank_card VARCHAR(50),
  extra_json JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_employees_store ON employees (store, status);
CREATE INDEX IF NOT EXISTS idx_employees_role ON employees (role);

COMMENT ON TABLE employees IS '员工信息表（hrms_state.employees 的独立镜像）';
