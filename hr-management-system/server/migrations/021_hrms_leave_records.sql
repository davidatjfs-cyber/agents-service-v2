-- 员工休假/欠休独立表：与 hrms_state.leaveRecords 双写，启动时互相同步缺口
-- 创建时间: 2026-04-05
-- 背景：休假记录只存在 hrms_state JSON 中，部署事故会丢失

CREATE TABLE IF NOT EXISTS hrms_leave_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username VARCHAR(100) NOT NULL,
  name VARCHAR(200),
  store VARCHAR(200),
  brand VARCHAR(120),
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  days NUMERIC(5,2) DEFAULT 0,
  type VARCHAR(30) DEFAULT 'leave', -- leave / annual / sick / personal / other
  reason TEXT,
  status VARCHAR(30) NOT NULL DEFAULT 'pending',
  approval_id UUID,
  approved_by VARCHAR(100),
  approved_at TIMESTAMPTZ,
  submitted_by VARCHAR(100),
  submitted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_leave_username ON hrms_leave_records (username, start_date DESC);
CREATE INDEX IF NOT EXISTS idx_leave_store_date ON hrms_leave_records (store, start_date DESC);
CREATE INDEX IF NOT EXISTS idx_leave_status ON hrms_leave_records (status, start_date DESC);

-- 休假余额调整/覆盖记录
CREATE TABLE IF NOT EXISTS hrms_leave_balance_overrides (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username VARCHAR(100) NOT NULL,
  month VARCHAR(7) NOT NULL, -- '2026-04'
  override_value NUMERIC(5,2) NOT NULL,
  reason TEXT,
  created_by VARCHAR(100),
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(username, month)
);

CREATE INDEX IF NOT EXISTS idx_leave_balance_month ON hrms_leave_balance_overrides (month, username);

COMMENT ON TABLE hrms_leave_records IS '员工休假/欠休记录';
COMMENT ON TABLE hrms_leave_balance_overrides IS '员工月度休假余额手动覆盖';
