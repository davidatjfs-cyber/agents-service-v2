-- 营业日报：今日营运异常报备（自由文本，供晨报引用）
ALTER TABLE daily_reports ADD COLUMN IF NOT EXISTS operational_anomaly_note TEXT;
COMMENT ON COLUMN daily_reports.operational_anomaly_note IS '今日营运异常报备（设备故障、严重客诉等影响营运的重要事件）';
