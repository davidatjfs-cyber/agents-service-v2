-- Agent 沟通系统数据库表结构
-- 创建时间: 2026-02-21

-- 1. Agent 问题报告表
CREATE TABLE IF NOT EXISTS agent_issues_reports (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    issue_id TEXT UNIQUE NOT NULL,
    agent_type TEXT NOT NULL,
    issue_type TEXT NOT NULL,
    details JSONB NOT NULL,
    context JSONB DEFAULT '{}',
    status TEXT DEFAULT 'pending',
    severity TEXT DEFAULT 'medium',
    priority TEXT DEFAULT 'normal',
    assigned_agent TEXT,
    deadline TIMESTAMP,
    optimization_plan JSONB,
    expected_impact TEXT,
    implementation_time TEXT,
    approved_by TEXT,
    approval_notes TEXT,
    approved_at TIMESTAMP,
    optimization_results JSONB,
    metrics JSONB,
    completed_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- 2. Agent 通知表
CREATE TABLE IF NOT EXISTS agent_notifications (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_type TEXT NOT NULL,
    notification_type TEXT NOT NULL,
    content JSONB NOT NULL,
    read_status BOOLEAN DEFAULT FALSE,
    read_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW()
);

-- 3. Agent 优化历史表
CREATE TABLE IF NOT EXISTS agent_optimization_history (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    issue_id TEXT NOT NULL,
    agent_type TEXT NOT NULL,
    optimization_type TEXT NOT NULL,
    before_state JSONB,
    after_state JSONB,
    improvement_metrics JSONB,
    implementation_time TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW()
);

-- 4. Agent 协作日志表
CREATE TABLE IF NOT EXISTS agent_collaboration_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    from_agent TEXT NOT NULL,
    to_agent TEXT NOT NULL,
    collaboration_type TEXT NOT NULL,
    message TEXT,
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMP DEFAULT NOW()
);

-- 创建索引
CREATE INDEX IF NOT EXISTS idx_agent_issues_reports_status ON agent_issues_reports(status);
CREATE INDEX IF NOT EXISTS idx_agent_issues_reports_agent_type ON agent_issues_reports(agent_type);
CREATE INDEX IF NOT EXISTS idx_agent_issues_reports_assigned_agent ON agent_issues_reports(assigned_agent);
CREATE INDEX IF NOT EXISTS idx_agent_issues_reports_created_at ON agent_issues_reports(created_at);
CREATE INDEX IF NOT EXISTS idx_agent_notifications_agent_type ON agent_notifications(agent_type);
CREATE INDEX IF NOT EXISTS idx_agent_notifications_read_status ON agent_notifications(read_status);
CREATE INDEX IF NOT EXISTS idx_agent_optimization_history_issue_id ON agent_optimization_history(issue_id);
CREATE INDEX IF NOT EXISTS idx_agent_collaboration_logs_from_agent ON agent_collaboration_logs(from_agent);
CREATE INDEX IF NOT EXISTS idx_agent_collaboration_logs_created_at ON agent_collaboration_logs(created_at);

-- 创建更新时间触发器
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER update_agent_issues_reports_updated_at 
    BEFORE UPDATE ON agent_issues_reports 
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- 插入一些示例数据
INSERT INTO agent_issues_reports (
    issue_id, agent_type, issue_type, details, context, severity
) VALUES 
(
    'ISSUE_1700000000000_demo1',
    'data_auditor',
    'DATA_SOURCE_INSUFFICIENT',
    '{"dataSourceType": "table_visit", "problem": "数据更新频率过低", "impact": "影响异常检测及时性", "suggestedFix": "增加轮询频率"}',
    '{"timestamp": "2026-02-21T09:00:00Z", "agent": "data_auditor"}',
    'medium'
),
(
    'ISSUE_1700000000000_demo2',
    'ops_supervisor',
    'TASK_EXECUTION_BOTTLENECK',
    '{"taskType": "图片审核", "bottleneck": "审核响应时间过长", "failureRate": 0.15, "suggestedImprovement": "优化审核算法"}',
    '{"timestamp": "2026-02-21T09:05:00Z", "agent": "ops_supervisor"}',
    'medium'
) ON CONFLICT (issue_id) DO NOTHING;

COMMENT ON TABLE agent_issues_reports IS 'Agent 问题报告表';
COMMENT ON TABLE agent_notifications IS 'Agent 通知表';
COMMENT ON TABLE agent_optimization_history IS 'Agent 优化历史表';
COMMENT ON TABLE agent_collaboration_logs IS 'Agent 协作日志表';
