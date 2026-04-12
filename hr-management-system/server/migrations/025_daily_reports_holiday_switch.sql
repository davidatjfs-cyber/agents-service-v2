-- 营业日报：节假日/周末手工标记（与天气同屏维护，双写到 daily_reports）
ALTER TABLE daily_reports ADD COLUMN IF NOT EXISTS holiday_switch BOOLEAN DEFAULT false;
COMMENT ON COLUMN daily_reports.holiday_switch IS '节假日或周末营业标记（店长手工勾选，供报表/绩效口径区分）';
