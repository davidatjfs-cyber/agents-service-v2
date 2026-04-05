-- 营业日报：补齐所有缺失字段，确保全量数据落库
-- 创建时间: 2026-04-05
-- 背景：4/3 事故 + 4/4 前大量数据缺失，需将所有前端字段写入 DB

-- 基础字段
ALTER TABLE daily_reports ADD COLUMN IF NOT EXISTS weather TEXT;
COMMENT ON COLUMN daily_reports.weather IS '天气（晴/多云/阴/雨/雪）';

-- 时段拆分（JSONB）
ALTER TABLE daily_reports ADD COLUMN IF NOT EXISTS segments JSONB DEFAULT '{"noon":0,"afternoon":0,"night":0}';
COMMENT ON COLUMN daily_reports.segments IS '时段营业额拆分 {noon, afternoon, night}';

-- 包房使用
ALTER TABLE daily_reports ADD COLUMN IF NOT EXISTS private_room_uses INTEGER DEFAULT 0;
COMMENT ON COLUMN daily_reports.private_room_uses IS '今日包房使用次数（仅洪潮品牌）';

-- 折扣明细
ALTER TABLE daily_reports ADD COLUMN IF NOT EXISTS discount_dine DECIMAL(12,2) DEFAULT 0;
ALTER TABLE daily_reports ADD COLUMN IF NOT EXISTS discount_delivery DECIMAL(12,2) DEFAULT 0;
COMMENT ON COLUMN daily_reports.discount_dine IS '堂食折扣金额';
COMMENT ON COLUMN daily_reports.discount_delivery IS '外卖折扣金额';

-- 品类销售（JSONB）
ALTER TABLE daily_reports ADD COLUMN IF NOT EXISTS categories JSONB DEFAULT '{"water":{"amt":0,"qty":0},"soup":{"amt":0,"qty":0},"roast":{"amt":0,"qty":0},"wok":{"amt":0,"qty":0},"sashimi":{"amt":0,"qty":0}}';
COMMENT ON COLUMN daily_reports.categories IS '各品类销售金额和数量 {water,soup,roast,wok,sashimi: {amt,qty}}';

-- 外卖平台明细（JSONB）
ALTER TABLE daily_reports ADD COLUMN IF NOT EXISTS delivery_detail JSONB;
COMMENT ON COLUMN daily_reports.delivery_detail IS '外卖平台明细 {eleme:{orders,revenue,actual,targetRevenue}, meituan:{orders,revenue,actual,targetRevenue}}';

-- 差评明细
ALTER TABLE daily_reports ADD COLUMN IF NOT EXISTS bad_reviews_dianping INTEGER DEFAULT 0;
COMMENT ON COLUMN daily_reports.bad_reviews_dianping IS '大众点评差评数量';

-- 员工信息（JSONB）
ALTER TABLE daily_reports ADD COLUMN IF NOT EXISTS staff JSONB;
COMMENT ON COLUMN daily_reports.staff IS '员工信息 {front:[], kitchen:[], restStaff:[], frontSupport, kitchenSupport}';

-- 次日排班（JSONB）
ALTER TABLE daily_reports ADD COLUMN IF NOT EXISTS schedule_next_day JSONB;
COMMENT ON COLUMN daily_reports.schedule_next_day IS '次日排班 {staff, frontStaff, kitchenStaff, tomorrowGrossEstimate, remark}';

-- 照片（JSONB）
ALTER TABLE daily_reports ADD COLUMN IF NOT EXISTS photos JSONB DEFAULT '[]';
COMMENT ON COLUMN daily_reports.photos IS '日结单照片URL数组';

-- 充值字段（确保存在，之前可能漏了迁移）
ALTER TABLE daily_reports ADD COLUMN IF NOT EXISTS recharge_count INTEGER DEFAULT 0;
ALTER TABLE daily_reports ADD COLUMN IF NOT EXISTS recharge_amount DECIMAL(12,2) DEFAULT 0;
COMMENT ON COLUMN daily_reports.recharge_count IS '今日充值笔数';
COMMENT ON COLUMN daily_reports.recharge_amount IS '今日充值金额';
