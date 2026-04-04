-- 员工考勤独立镜像表：与 checkin_records 双写，启动时互相同步缺口，防单表损坏
-- 员工薪资域独立表：payrollAdjustments / payrollAudits / salaryAdjustments / monthlyConfirmations 与 hrms_state 互备

CREATE TABLE IF NOT EXISTS employee_attendance_records (
  id uuid PRIMARY KEY,
  username varchar(100) NOT NULL,
  store varchar(200),
  type varchar(20) NOT NULL DEFAULT 'clock_in',
  check_time timestamptz NOT NULL,
  latitude double precision,
  longitude double precision,
  distance_meters double precision,
  face_match boolean DEFAULT false,
  face_score double precision,
  photo_url text,
  status varchar(20) NOT NULL DEFAULT 'normal',
  note text,
  confirmed_by varchar(100),
  confirmed_at timestamptz,
  created_at timestamptz DEFAULT CURRENT_TIMESTAMP,
  synced_at timestamptz DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_employee_attendance_username_time ON employee_attendance_records (username, check_time DESC);
CREATE INDEX IF NOT EXISTS idx_employee_attendance_store_time ON employee_attendance_records (store, check_time DESC);

CREATE TABLE IF NOT EXISTS hrms_payroll_domain (
  id text PRIMARY KEY DEFAULT 'default',
  payroll_adjustments jsonb NOT NULL DEFAULT '{}'::jsonb,
  payroll_audits jsonb NOT NULL DEFAULT '{}'::jsonb,
  salary_adjustments jsonb NOT NULL DEFAULT '[]'::jsonb,
  monthly_confirmations jsonb NOT NULL DEFAULT '[]'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT NOW()
);

INSERT INTO hrms_payroll_domain (id) VALUES ('default') ON CONFLICT (id) DO NOTHING;
