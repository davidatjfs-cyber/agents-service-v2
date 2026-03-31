-- 飞书表格同步相关表
-- 创建时间: 2026-02-21

-- 1. 厨房申报报表统一表
CREATE TABLE IF NOT EXISTS kitchen_reports (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    store VARCHAR(200) NOT NULL,
    brand VARCHAR(120) NOT NULL,
    report_date DATE NOT NULL,
    report_type VARCHAR(20) NOT NULL, -- 'opening' 或 'closing'
    station VARCHAR(100) NOT NULL, -- 档口名称
    reporter VARCHAR(100) NOT NULL, -- 申报人
    report_data JSONB NOT NULL, -- 申报内容（动态字段）
    feishu_record_id VARCHAR(100), -- 飞书记录ID
    submitted BOOLEAN DEFAULT FALSE,
    submit_time TIMESTAMP,
    sync_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(store, report_date, report_type, station)
);

-- 2. 原料收货日报表
CREATE TABLE IF NOT EXISTS material_receiving_reports (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    store VARCHAR(200) NOT NULL,
    brand VARCHAR(120) NOT NULL,
    report_date DATE NOT NULL,
    receiver VARCHAR(100) NOT NULL, -- 收货人
    report_data JSONB NOT NULL, -- 收货日报内容（动态字段）
    feishu_record_id VARCHAR(100), -- 飞书记录ID
    submitted BOOLEAN DEFAULT FALSE,
    submit_time TIMESTAMP,
    sync_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(store, brand, report_date)
);

-- 3. 门店例会报告表
CREATE TABLE IF NOT EXISTS store_meeting_reports (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    store VARCHAR(200) NOT NULL,
    brand VARCHAR(120) NOT NULL,
    meeting_date DATE NOT NULL,
    reporter VARCHAR(100) NOT NULL, -- 汇报人
    meeting_content TEXT, -- 会议内容
    meeting_score INTEGER, -- 会议得分
    report_data JSONB NOT NULL, -- 其他报告内容（动态字段）
    feishu_record_id VARCHAR(100), -- 飞书记录ID
    submitted BOOLEAN DEFAULT FALSE,
    submit_time TIMESTAMP,
    sync_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(store, meeting_date)
);

-- 4. 门店评级表
CREATE TABLE IF NOT EXISTS store_ratings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    store VARCHAR(200) NOT NULL,
    brand VARCHAR(120) NOT NULL,
    period VARCHAR(20) NOT NULL, -- '2024-01'格式
    actual_revenue DECIMAL(12,2) NOT NULL,
    target_revenue DECIMAL(12,2) NOT NULL,
    achievement_rate DECIMAL(5,2) NOT NULL, -- 达成率百分比
    rating VARCHAR(1) NOT NULL, -- 'A', 'B', 'C'
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(store, brand, period)
);

-- 5. 员工评分表（新评分模型）
CREATE TABLE IF NOT EXISTS employee_scores (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    store VARCHAR(200) NOT NULL,
    brand VARCHAR(120) NOT NULL,
    username VARCHAR(100) NOT NULL,
    name VARCHAR(200),
    role VARCHAR(60) NOT NULL, -- 'store_manager', 'production_manager'
    period VARCHAR(20) NOT NULL,
    
    -- 基础得分
    base_score INTEGER DEFAULT 100,
    exception_bonus INTEGER DEFAULT 0,
    exception_deduction INTEGER DEFAULT 0,
    total_score INTEGER DEFAULT 100,
    
    -- 评级
    execution_rating VARCHAR(1), -- 'A', 'B', 'C', 'D'
    attitude_rating VARCHAR(1), -- 'A', 'B', 'C'
    ability_rating VARCHAR(1), -- 'A', 'B', 'C', 'D'
    
    -- 详细数据
    execution_data JSONB DEFAULT '{}',
    attitude_data JSONB DEFAULT '{}',
    ability_data JSONB DEFAULT '{}',
    
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(store, username, role, period)
);

-- 6. 营业目标表
CREATE TABLE IF NOT EXISTS revenue_targets (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    store VARCHAR(200) NOT NULL,
    brand VARCHAR(120) NOT NULL,
    period VARCHAR(20) NOT NULL, -- '2024-01'按月
    target_revenue DECIMAL(12,2) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(store, brand, period)
);

-- 7. 毛利率目标表
CREATE TABLE IF NOT EXISTS margin_targets (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    store VARCHAR(200) NOT NULL,
    brand VARCHAR(120) NOT NULL,
    period VARCHAR(20) NOT NULL,
    target_margin DECIMAL(5,2) NOT NULL, -- 目标毛利率百分比
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(store, brand, period)
);

-- 8. 毛利率数据表
CREATE TABLE IF NOT EXISTS monthly_margins (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    store VARCHAR(200) NOT NULL,
    brand VARCHAR(120) NOT NULL,
    period VARCHAR(7) NOT NULL, -- '2024-01'格式
    actual_margin DECIMAL(5,2) NOT NULL, -- 实际毛利率
    source VARCHAR(50) DEFAULT 'feishu', -- 数据来源
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(store, brand, period)
);

-- 创建索引
CREATE INDEX IF NOT EXISTS idx_kitchen_reports_store_date ON kitchen_reports(store, report_date);
CREATE INDEX IF NOT EXISTS idx_kitchen_reports_type_date ON kitchen_reports(report_type, report_date);
CREATE INDEX IF NOT EXISTS idx_material_reports_store_date ON material_receiving_reports(store, report_date);
CREATE INDEX IF NOT EXISTS idx_meeting_reports_store_date ON store_meeting_reports(store, meeting_date);
CREATE INDEX IF NOT EXISTS idx_store_ratings_period ON store_ratings(period);
CREATE INDEX IF NOT EXISTS idx_employee_scores_period ON employee_scores(period);
CREATE INDEX IF NOT EXISTS idx_employee_scores_role ON employee_scores(role);

-- 创建更新时间触发器
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER update_kitchen_reports_updated_at BEFORE UPDATE ON kitchen_reports FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_material_receiving_reports_updated_at BEFORE UPDATE ON material_receiving_reports FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_store_meeting_reports_updated_at BEFORE UPDATE ON store_meeting_reports FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_employee_scores_updated_at BEFORE UPDATE ON employee_scores FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- 添加注释
COMMENT ON TABLE kitchen_reports IS '厨房申报报表（开档/收档报告）';
COMMENT ON TABLE material_receiving_reports IS '原料收货日报';
COMMENT ON TABLE store_meeting_reports IS '门店例会报告';
COMMENT ON TABLE store_ratings IS '门店评级（A/B/C）';
COMMENT ON TABLE employee_scores IS '员工评分（新评分模型）';
COMMENT ON TABLE revenue_targets IS '营业目标';
COMMENT ON TABLE margin_targets IS '毛利率目标';
COMMENT ON TABLE monthly_margins IS '实际毛利率数据';
