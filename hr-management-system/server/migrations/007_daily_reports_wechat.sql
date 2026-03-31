-- 添加企微会员字段到daily_reports表
-- new_wechat_members: 今日企微新增
-- wechat_month_total: 本月企微累计

ALTER TABLE daily_reports ADD COLUMN IF NOT EXISTS new_wechat_members INTEGER DEFAULT 0;
ALTER TABLE daily_reports ADD COLUMN IF NOT EXISTS wechat_month_total INTEGER DEFAULT 0;
