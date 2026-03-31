-- 企业人力资源管理系统数据库结构
-- 版本: v2.0.3

-- 用户表
CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    username VARCHAR(50) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    real_name VARCHAR(100) NOT NULL,
    email VARCHAR(100),
    phone VARCHAR(20),
    role VARCHAR(20) NOT NULL CHECK (role IN ('admin', 'hq_manager', 'store_manager', 'hq_employee', 'store_employee')),
    department VARCHAR(50),
    position VARCHAR(50),
    is_active BOOLEAN DEFAULT false,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 门店表
CREATE TABLE stores (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(100) NOT NULL,
    address TEXT,
    contact_person VARCHAR(50),
    contact_phone VARCHAR(20),
    business_hours VARCHAR(50),
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 员工档案表
CREATE TABLE employees (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    store_id UUID REFERENCES stores(id),
    name VARCHAR(100) NOT NULL,
    gender VARCHAR(10) CHECK (gender IN ('male', 'female')),
    birth_date DATE,
    native_place VARCHAR(100),
    phone VARCHAR(20),
    position VARCHAR(50),
    level INTEGER DEFAULT 1,
    department VARCHAR(50),
    hire_date DATE,
    hire_channel VARCHAR(50),
    current_salary DECIMAL(10,2),
    work_specialties TEXT,
    work_achievements TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 知识库表
CREATE TABLE knowledge_base (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    title VARCHAR(200) NOT NULL,
    content TEXT NOT NULL,
    category VARCHAR(50),
    tags TEXT[],
    file_path VARCHAR(255),
    file_type VARCHAR(50),
    file_size INTEGER,
    access_roles TEXT[],
    access_departments TEXT[],
    created_by UUID REFERENCES users(id),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 培训记录表
CREATE TABLE training_records (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    employee_id UUID REFERENCES employees(id),
    knowledge_id UUID REFERENCES knowledge_base(id),
    start_time TIMESTAMP,
    end_time TIMESTAMP,
    duration_minutes INTEGER,
    progress INTEGER DEFAULT 0,
    status VARCHAR(20) DEFAULT 'in_progress' CHECK (status IN ('in_progress', 'completed', 'paused')),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 考试题目表
CREATE TABLE exam_questions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    title TEXT NOT NULL,
    question_type VARCHAR(20) NOT NULL CHECK (question_type IN ('single_choice', 'multiple_choice', 'true_false', 'essay')),
    options JSONB,
    correct_answer TEXT NOT NULL,
    difficulty VARCHAR(20) DEFAULT 'medium' CHECK (difficulty IN ('easy', 'medium', 'hard')),
    category VARCHAR(50),
    department VARCHAR(50),
    points INTEGER DEFAULT 1,
    created_by UUID REFERENCES users(id),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 考试分发表
CREATE TABLE exam_distributions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    exam_id UUID REFERENCES exam_questions(id),
    target_roles TEXT[],
    target_stores UUID[],
    target_positions TEXT[],
    target_employees UUID[],
    start_time TIMESTAMP,
    end_time TIMESTAMP,
    duration_minutes INTEGER,
    created_by UUID REFERENCES users(id),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 考试结果表
CREATE TABLE exam_results (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    employee_id UUID REFERENCES employees(id),
    exam_id UUID REFERENCES exam_questions(id),
    distribution_id UUID REFERENCES exam_distributions(id),
    answers JSONB,
    score INTEGER,
    total_points INTEGER,
    percentage DECIMAL(5,2),
    status VARCHAR(20) DEFAULT 'completed',
    start_time TIMESTAMP,
    end_time TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 晋升路径表
CREATE TABLE promotion_paths (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(100) NOT NULL,
    department VARCHAR(50) NOT NULL,
    path_type VARCHAR(20) NOT NULL CHECK (path_type IN ('same_position', 'cross_position')),
    description TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 晋升步骤表
CREATE TABLE promotion_steps (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    path_id UUID REFERENCES promotion_paths(id),
    step_order INTEGER NOT NULL,
    from_level INTEGER,
    to_level INTEGER,
    from_position VARCHAR(50),
    to_position VARCHAR(50),
    requirements TEXT,
    tasks TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 晋升记录表
CREATE TABLE promotion_records (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    employee_id UUID REFERENCES employees(id),
    path_id UUID REFERENCES promotion_paths(id),
    step_id UUID REFERENCES promotion_steps(id),
    application_date DATE,
    approval_date DATE,
    approver_id UUID REFERENCES users(id),
    status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'completed')),
    completion_date DATE,
    new_level INTEGER,
    new_position VARCHAR(50),
    new_salary DECIMAL(10,2),
    notes TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 奖惩模版表
CREATE TABLE reward_punishment_templates (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(100) NOT NULL,
    type VARCHAR(20) NOT NULL CHECK (type IN ('reward', 'punishment')),
    description TEXT,
    template_fields JSONB,
    created_by UUID REFERENCES users(id),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 奖惩记录表
CREATE TABLE reward_punishment_records (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    template_id UUID REFERENCES reward_punishment_templates(id),
    employee_id UUID REFERENCES employees(id),
    issuer_id UUID REFERENCES users(id),
    store_id UUID REFERENCES stores(id),
    reason TEXT NOT NULL,
    result TEXT,
    points INTEGER DEFAULT 0,
    type VARCHAR(20) NOT NULL CHECK (type IN ('reward', 'punishment')),
    status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
    issued_date DATE,
    approved_date DATE,
    approver_id UUID REFERENCES users(id),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 公告表
CREATE TABLE announcements (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    title VARCHAR(200) NOT NULL,
    content TEXT NOT NULL,
    type VARCHAR(20) DEFAULT 'general' CHECK (type IN ('general', 'urgent', 'policy', 'training')),
    target_roles TEXT[],
    target_stores UUID[],
    target_departments TEXT[],
    is_published BOOLEAN DEFAULT false,
    publish_date TIMESTAMP,
    expire_date TIMESTAMP,
    created_by UUID REFERENCES users(id),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 薪资调整记录表
CREATE TABLE salary_adjustments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    employee_id UUID REFERENCES employees(id),
    old_salary DECIMAL(10,2),
    new_salary DECIMAL(10,2),
    adjustment_type VARCHAR(20) CHECK (adjustment_type IN ('promotion', 'annual_review', 'special', 'correction')),
    reason TEXT,
    effective_date DATE,
    approved_by UUID REFERENCES users(id),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 员工反馈表
CREATE TABLE employee_feedback (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    employee_id UUID REFERENCES employees(id),
    feedback_type VARCHAR(50),
    content TEXT NOT NULL,
    status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'resolved', 'closed')),
    admin_notes TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 创建索引
CREATE INDEX idx_users_role ON users(role);
CREATE INDEX idx_users_username ON users(username);
CREATE INDEX idx_employees_store_id ON employees(store_id);
CREATE INDEX idx_employees_user_id ON employees(user_id);
CREATE INDEX idx_knowledge_base_category ON knowledge_base(category);
CREATE INDEX idx_training_records_employee_id ON training_records(employee_id);
CREATE INDEX idx_exam_questions_category ON exam_questions(category);
CREATE INDEX idx_exam_results_employee_id ON exam_results(employee_id);
CREATE INDEX idx_promotion_records_employee_id ON promotion_records(employee_id);
CREATE INDEX idx_reward_punishment_employee_id ON reward_punishment_records(employee_id);
CREATE INDEX idx_announcements_type ON announcements(type);

-- 插入初始数据

-- 插入默认管理员用户
INSERT INTO users (username, password_hash, real_name, email, role, is_active) VALUES
('admin', '$2b$12$LQv3c1yqBWVHxkd0LHAUO8xqY.Fd5dK8BqJ3zqJ3zqJ3zqJ3zq', '系统管理员', 'admin@company.com', 'admin', true);

-- 插入示例门店
INSERT INTO stores (name, address, contact_person, contact_phone, business_hours) VALUES
('总店', '北京市朝阳区建国路88号', '张经理', '010-88888888', '09:00-22:00'),
('分店A', '北京市海淀区中关村大街1号', '李店长', '010-99999999', '10:00-21:00'),
('分店B', '北京市东城区王府井大街100号', '王店长', '010-77777777', '09:30-21:30');

-- 插入前厅晋升路径
INSERT INTO promotion_paths (name, department, path_type, description) VALUES
('前厅晋升路径', '前厅', 'same_position', '前厅员工在当前岗位上的技能提升路径'),
('前厅跨岗位晋升', '前厅', 'cross_position', '前厅员工跨岗位发展路径'),
('后厨晋升路径', '后厨', 'same_position', '后厨员工在当前岗位上的技能提升路径'),
('后厨跨岗位晋升', '后厨', 'cross_position', '后厨员工跨岗位发展路径');

-- 插入前厅晋升步骤
INSERT INTO promotion_steps (path_id, step_order, from_position, to_position, requirements, tasks) VALUES
((SELECT id FROM promotion_paths WHERE name = '前厅晋升路径'), 1, '服务员', '水吧', '熟练掌握基础服务技能', '完成服务技能培训并通过考核'),
((SELECT id FROM promotion_paths WHERE name = '前厅晋升路径'), 2, '水吧', '主管', '具备管理能力', '完成管理培训并成功管理团队3个月'),
((SELECT id FROM promotion_paths WHERE name = '前厅晋升路径'), 3, '主管', '档口', '全面掌握前厅业务', '通过前厅综合技能评估'),
((SELECT id FROM promotion_paths WHERE name = '前厅晋升路径'), 4, '档口', '经理', '具备门店管理能力', '完成门店管理培训'),
((SELECT id FROM promotion_paths WHERE name = '前厅晋升路径'), 5, '经理', '店长', '具备全面管理能力', '通过店长资格认证');

-- 插入后厨晋升步骤
INSERT INTO promotion_steps (path_id, step_order, from_position, to_position, requirements, tasks) VALUES
((SELECT id FROM promotion_paths WHERE name = '后厨晋升路径'), 1, '打荷', '档口', '掌握基础厨艺', '完成基础厨艺培训'),
((SELECT id FROM promotion_paths WHERE name = '后厨晋升路径'), 2, '档口', '切配', '熟练掌握刀工', '通过刀工技能考核'),
((SELECT id FROM promotion_paths WHERE name = '后厨晋升路径'), 3, '切配', '烧味', '掌握烧味技术', '完成烧味专项培训'),
((SELECT id FROM promotion_paths WHERE name = '后厨晋升路径'), 4, '烧味', '炒锅', '掌握炒锅技术', '通过炒锅技能认证'),
((SELECT id FROM promotion_paths WHERE name = '后厨晋升路径'), 5, '炒锅', '厨师长', '具备厨房管理能力', '完成厨房管理培训');

-- 插入示例奖惩模版
INSERT INTO reward_punishment_templates (name, type, description, template_fields) VALUES
('优秀员工奖', 'reward', '表彰工作表现突出的员工', '{"fields": ["奖惩人", "门店", "岗位", "奖惩事由", "奖惩结果", "提报人"]}'),
('服务之星奖', 'reward', '表彰服务态度优秀的员工', '{"fields": ["奖惩人", "门店", "岗位", "奖惩事由", "奖惩结果", "提报人"]}'),
('工作失误警告', 'punishment', '对工作失误进行警告', '{"fields": ["奖惩人", "门店", "岗位", "奖惩事由", "奖惩结果", "提报人"]}'),
('迟到处罚', 'punishment', '对迟到行为进行处罚', '{"fields": ["奖惩人", "门店", "岗位", "奖惩事由", "奖惩结果", "提报人"]}');

-- 创建更新时间触发器
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ language 'plpgsql';

-- 为所有主要表添加更新时间触发器
CREATE TRIGGER update_users_updated_at BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_employees_updated_at BEFORE UPDATE ON employees FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_stores_updated_at BEFORE UPDATE ON stores FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_knowledge_base_updated_at BEFORE UPDATE ON knowledge_base FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_training_records_updated_at BEFORE UPDATE ON training_records FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_exam_questions_updated_at BEFORE UPDATE ON exam_questions FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_promotion_records_updated_at BEFORE UPDATE ON promotion_records FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_reward_punishment_records_updated_at BEFORE UPDATE ON reward_punishment_records FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_announcements_updated_at BEFORE UPDATE ON announcements FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_employee_feedback_updated_at BEFORE UPDATE ON employee_feedback FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- 创建视图用于简化查询
CREATE VIEW employee_details AS
SELECT 
    e.id,
    e.name,
    e.gender,
    e.birth_date,
    e.phone,
    e.position,
    e.level,
    e.department,
    e.hire_date,
    e.current_salary,
    e.work_specialties,
    e.work_achievements,
    s.name as store_name,
    u.username,
    u.email,
    u.role as user_role,
    e.created_at,
    e.updated_at
FROM employees e
LEFT JOIN stores s ON e.store_id = s.id
LEFT JOIN users u ON e.user_id = u.id;

-- 创建员工月度学习统计视图
CREATE VIEW monthly_training_stats AS
SELECT 
    e.id as employee_id,
    e.name as employee_name,
    EXTRACT(MONTH FROM tr.created_at) as month,
    EXTRACT(YEAR FROM tr.created_at) as year,
    SUM(tr.duration_minutes) as total_minutes,
    COUNT(tr.id) as session_count
FROM training_records tr
JOIN employees e ON tr.employee_id = e.id
WHERE tr.status = 'completed'
GROUP BY e.id, e.name, EXTRACT(MONTH FROM tr.created_at), EXTRACT(YEAR FROM tr.created_at);

-- 创建员工奖惩统计视图
CREATE VIEW employee_reward_punishment_stats AS
SELECT 
    e.id as employee_id,
    e.name as employee_name,
    COUNT(CASE WHEN rpr.type = 'reward' THEN 1 END) as reward_count,
    COUNT(CASE WHEN rpr.type = 'punishment' THEN 1 END) as punishment_count,
    SUM(CASE WHEN rpr.type = 'reward' THEN rpr.points ELSE 0 END) as reward_points,
    SUM(CASE WHEN rpr.type = 'punishment' THEN rpr.points ELSE 0 END) as punishment_points
FROM employees e
LEFT JOIN reward_punishment_records rpr ON e.id = rpr.employee_id
WHERE rpr.status = 'approved'
GROUP BY e.id, e.name;
