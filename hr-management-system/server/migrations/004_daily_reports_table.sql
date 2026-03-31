-- 创建daily_reports表并迁移数据
-- 创建时间: 2026-02-21

-- 1. 创建daily_reports表
CREATE TABLE IF NOT EXISTS daily_reports (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    store VARCHAR(200) NOT NULL,
    brand VARCHAR(120) NOT NULL,
    date DATE NOT NULL,
    
    -- 营业数据
    dine_orders INTEGER DEFAULT 0,
    actual_revenue DECIMAL(12,2) DEFAULT 0,
    target_revenue DECIMAL(12,2) DEFAULT 0,
    
    -- 毛利率数据
    actual_margin DECIMAL(5,2), -- 实际毛利率百分比
    target_margin DECIMAL(5,2), -- 目标毛利率百分比
    
    -- 大众点评数据
    dianping_rating DECIMAL(3,2), -- 大众点评星级
    
    -- 元数据
    submitted BOOLEAN DEFAULT FALSE,
    submitted_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    
    -- 唯一约束
    UNIQUE(store, date)
);

-- 2. 创建索引
CREATE INDEX IF NOT EXISTS idx_daily_reports_store_date ON daily_reports(store, date);
CREATE INDEX IF NOT EXISTS idx_daily_reports_brand ON daily_reports(brand);
CREATE INDEX IF NOT EXISTS idx_daily_reports_date ON daily_reports(date);

-- 3. 创建更新触发器
CREATE TRIGGER update_daily_reports_updated_at 
BEFORE UPDATE ON daily_reports 
FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- 4. 数据迁移：从hrms_state迁移到daily_reports表
INSERT INTO daily_reports (store, brand, date, dine_orders, actual_revenue, submitted, submitted_at)
SELECT 
    daily_report->>'store' as store,
    daily_report->>'brand' as brand,
    (daily_report->>'date')::DATE as date,
    (daily_report->'data'->'dine'->>'orders')::INTEGER as dine_orders,
    (daily_report->'data'->>'actual')::DECIMAL(12,2) as actual_revenue,
    true as submitted,
    CURRENT_TIMESTAMP as submitted_at
FROM hrms_state, 
     jsonb_array_elements(data->'dailyReports') as daily_report
WHERE NOT EXISTS (
    SELECT 1 FROM daily_reports dr 
    WHERE dr.store = daily_report->>'store' 
      AND dr.date = (daily_report->>'date')::DATE
);

-- 5. 添加注释
COMMENT ON TABLE daily_reports IS '营业日报数据表';
COMMENT ON COLUMN daily_reports.dine_orders IS '就餐订单数';
COMMENT ON COLUMN daily_reports.actual_revenue IS '实际营业额';
COMMENT ON COLUMN daily_reports.target_revenue IS '目标营业额';
COMMENT ON COLUMN daily_reports.actual_margin IS '实际毛利率(%)';
COMMENT ON COLUMN daily_reports.target_margin IS '目标毛利率(%)';
COMMENT ON COLUMN daily_reports.dianping_rating IS '大众点评星级';
