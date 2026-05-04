-- 出勤表台账：营业日报「今日实际出勤」快照 + 与打卡、休假比对结果（供总部人事计薪留痕）

CREATE TABLE IF NOT EXISTS daily_report_attendance_register (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  store VARCHAR(200) NOT NULL,
  brand VARCHAR(120),
  report_date DATE NOT NULL,
  labor_total NUMERIC(12, 2),
  front_person_days NUMERIC(12, 2) NOT NULL DEFAULT 0,
  kitchen_person_days NUMERIC(12, 2) NOT NULL DEFAULT 0,
  rest_person_days NUMERIC(12, 2) NOT NULL DEFAULT 0,
  staff_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  line_details JSONB NOT NULL DEFAULT '[]'::jsonb,
  overall_status VARCHAR(20) NOT NULL DEFAULT 'pending',
  anomaly_count INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (store, report_date)
);

CREATE INDEX IF NOT EXISTS idx_dr_att_reg_date ON daily_report_attendance_register (report_date DESC);
CREATE INDEX IF NOT EXISTS idx_dr_att_reg_store_date ON daily_report_attendance_register (store, report_date DESC);
CREATE INDEX IF NOT EXISTS idx_dr_att_reg_status ON daily_report_attendance_register (overall_status, report_date DESC);

COMMENT ON TABLE daily_report_attendance_register IS '营业日报提交后的出勤台账：人员明细与打卡/休假核对状态';
