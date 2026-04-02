-- ============================================================
-- 002: 统一配置系统 + KPI Target 配置层
-- 解决问题：后端hardcode → 前端可配置、后端自动执行
-- ============================================================

-- ─── 1. 统一Agent配置表 ───
-- 所有规则/SLA/升级链/推送/节奏 全部存DB，前端CRUD，后端读取执行
CREATE TABLE IF NOT EXISTS agent_v2_configs (
  id          SERIAL PRIMARY KEY,
  config_key  TEXT NOT NULL UNIQUE,   -- 'anomaly_rules', 'sla_config', 'escalation_config', 'push_config', 'rhythm_schedule', 'auto_decision', 'store_mapping'
  config_value JSONB NOT NULL,
  description TEXT,
  version     INT DEFAULT 1,
  updated_by  TEXT,
  created_at  TIMESTAMPTZ DEFAULT now(),
  updated_at  TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_agent_v2_configs_key ON agent_v2_configs(config_key);

-- ─── 2. KPI目标配置表 ───
-- 每个门店/品牌/指标 的目标值，支持时间段覆盖
CREATE TABLE IF NOT EXISTS kpi_targets (
  id             SERIAL PRIMARY KEY,
  store          TEXT,              -- NULL = 品牌级默认
  brand          TEXT,              -- NULL = 公司级默认
  metric_key     TEXT NOT NULL,     -- 'ttfr_p90', 'ttc_p90', 'timeout_rate', 'evidence_coverage', 'first_pass_rate', 'escalation_rate', 'false_positive_rate', 'revenue_achievement', 'labor_efficiency', 'gross_margin'
  target_value   NUMERIC NOT NULL,
  warning_value  NUMERIC,           -- 预警阈值（接近目标时提示）
  unit           TEXT,              -- 'minutes', 'hours', '%', 'count', 'yuan'
  direction      TEXT DEFAULT 'lower_better', -- 'lower_better' 或 'higher_better'
  period         TEXT DEFAULT 'monthly', -- 'daily', 'weekly', 'monthly', 'quarterly'
  effective_from DATE NOT NULL DEFAULT CURRENT_DATE,
  effective_to   DATE,              -- NULL = 永久有效
  created_by     TEXT,
  created_at     TIMESTAMPTZ DEFAULT now(),
  updated_at     TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_kpi_targets_store ON kpi_targets(store, brand, metric_key);
CREATE INDEX IF NOT EXISTS idx_kpi_targets_metric ON kpi_targets(metric_key, effective_from);

-- 唯一约束：同一门店/品牌/指标/生效期不重复
CREATE UNIQUE INDEX IF NOT EXISTS idx_kpi_targets_unique
  ON kpi_targets(COALESCE(store,'__all__'), COALESCE(brand,'__all__'), metric_key, effective_from);

-- ─── 3. 配置变更审计表 ───
CREATE TABLE IF NOT EXISTS config_audit_log (
  id          SERIAL PRIMARY KEY,
  config_key  TEXT NOT NULL,
  action      TEXT NOT NULL,       -- 'create', 'update', 'delete'
  old_value   JSONB,
  new_value   JSONB,
  changed_by  TEXT,
  changed_at  TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_config_audit_key ON config_audit_log(config_key, changed_at DESC);

-- ============================================================
-- 初始化：将hardcoded配置写入DB
-- ============================================================

-- ─── 异常检测规则 ───
INSERT INTO agent_v2_configs (config_key, config_value, description, updated_by) VALUES
('anomaly_rules', '{
  "revenue_achievement": {
    "name": "实收营收异常",
    "enabled": true,
    "frequency": "weekly",
    "data_source": "daily_reports",
    "threshold": {
      "medium": {"achievement_gap_pct": 10},
      "high": {"achievement_gap_pct": 15}
    },
    "assign_to": "store_manager",
    "evidence": ["日报截图", "收银系统截图"],
    "auto_actions": ["生成差距分析", "推送店长"],
    "human_required": ["调整目标", "制定追赶方案"]
  },
  "labor_efficiency": {
    "name": "人效值异常",
    "enabled": true,
    "frequency": "weekly",
    "data_source": "daily_reports",
    "threshold": {
      "洪潮": {"medium": {"below": 1100}, "high": {"below": 1000}},
      "马己仙": {"medium": {"below": 1400}, "high": {"below": 1300}},
      "default": {"medium": {"below": 1200}, "high": {"below": 1000}}
    },
    "assign_to": "store_manager",
    "evidence": ["排班表截图", "营业额截图"],
    "auto_actions": ["人效趋势分析", "推送店长+区域经理"],
    "human_required": ["排班优化方案"]
  },
  "recharge_zero": {
    "name": "充值异常",
    "enabled": true,
    "frequency": "daily",
    "data_source": "daily_reports",
    "threshold": {
      "medium": {"zero_days": 1},
      "high": {"zero_days": 2}
    },
    "assign_to": "store_manager",
    "evidence": ["充值系统截图"],
    "auto_actions": ["推送提醒"],
    "human_required": ["说明原因", "制定充值活动"]
  },
  "table_visit_product": {
    "name": "桌访产品异常",
    "enabled": true,
    "frequency": "weekly",
    "data_source": "feishu_generic_records.table_visit",
    "threshold": {
      "medium": {"same_product_complaints": 2},
      "high": {"same_product_complaints": 4}
    },
    "assign_to": "kitchen_manager",
    "evidence": ["菜品照片", "整改方案"],
    "auto_actions": ["生成问题菜品报告", "推送厨师长"],
    "human_required": ["下架/改良决策"]
  },
  "table_visit_ratio": {
    "name": "桌访占比异常",
    "enabled": true,
    "frequency": "weekly",
    "data_source": "feishu_generic_records.table_visit + daily_reports",
    "threshold": {
      "medium": {"below_pct": 50},
      "high": {"below_pct": 40}
    },
    "assign_to": "front_manager",
    "evidence": ["桌访记录截图"],
    "auto_actions": ["计算桌访率", "推送前厅经理"],
    "human_required": ["制定桌访培训计划"]
  },
  "gross_margin": {
    "name": "毛利率异常",
    "enabled": true,
    "frequency": "weekly",
    "data_source": "daily_reports",
    "threshold": {
      "洪潮": {"medium": {"below_pct": 58}, "high": {"below_pct": 55}},
      "马己仙": {"medium": {"below_pct": 62}, "high": {"below_pct": 60}},
      "default": {"medium": {"below_pct": 60}, "high": {"below_pct": 55}}
    },
    "assign_to": "store_manager",
    "evidence": ["进销存截图", "成本分析"],
    "auto_actions": ["毛利趋势分析"],
    "human_required": ["成本优化方案"]
  },
  "bad_review_product": {
    "name": "差评报告产品异常",
    "enabled": true,
    "frequency": "weekly",
    "data_source": "feishu_generic_records.bad_reviews",
    "threshold": {
      "medium": {"weekly_count": 1},
      "high": {"weekly_count": 2}
    },
    "assign_to": "kitchen_manager",
    "evidence": ["差评截图", "整改方案"],
    "auto_actions": ["差评汇总报告"],
    "human_required": ["整改执行"]
  },
  "bad_review_service": {
    "name": "差评报告服务异常",
    "enabled": true,
    "frequency": "weekly",
    "data_source": "feishu_generic_records.bad_reviews",
    "threshold": {
      "medium": {"two_week_count": 2},
      "high": {"two_week_count": 3}
    },
    "assign_to": "front_manager",
    "evidence": ["差评截图", "培训方案"],
    "auto_actions": ["服务差评趋势分析"],
    "human_required": ["服务培训安排"]
  },
  "traffic_decline": {
    "name": "客流量/订单数异常",
    "enabled": true,
    "frequency": "weekly",
    "data_source": "daily_reports",
    "threshold": {
      "medium": {"wow_decline_pct": 15},
      "high": {"wow_decline_pct": 25}
    },
    "assign_to": "store_manager",
    "evidence": ["客流数据截图"],
    "auto_actions": ["客流趋势分析"],
    "human_required": ["引流方案"]
  },
  "food_safety": {
    "name": "食品安全隐患",
    "enabled": true,
    "frequency": "realtime",
    "data_source": "feishu_messages",
    "threshold": {
      "high": {"keywords": ["过期", "变质", "异物", "食物中毒", "腹泻", "呕吐"]}
    },
    "assign_to": "store_manager",
    "evidence": ["现场照片", "处理记录"],
    "auto_actions": ["立即推送红色警报"],
    "human_required": ["现场处置", "追溯排查"]
  }
}'::jsonb, '10类异常检测规则配置', 'system')
ON CONFLICT (config_key) DO NOTHING;

-- ─── SLA配置 ───
INSERT INTO agent_v2_configs (config_key, config_value, description, updated_by) VALUES
('sla_config', '{
  "high": {
    "first_response_minutes": 30,
    "close_hours": 24,
    "remind_interval_hours": 4,
    "max_reminds": 3,
    "auto_escalate_after_hours": 24
  },
  "medium": {
    "first_response_minutes": 120,
    "close_hours": 72,
    "remind_interval_hours": 12,
    "max_reminds": 2,
    "auto_escalate_after_hours": 72
  },
  "low": {
    "first_response_minutes": 480,
    "close_hours": 168,
    "remind_interval_hours": 24,
    "max_reminds": 1,
    "auto_escalate_after_hours": 168
  }
}'::jsonb, 'SLA时效配置（按严重度）', 'system')
ON CONFLICT (config_key) DO NOTHING;

-- ─── 升级链配置 ───
INSERT INTO agent_v2_configs (config_key, config_value, description, updated_by) VALUES
('escalation_config', '{
  "chains": {
    "洪潮": ["store_manager", "hq_manager", "admin"],
    "马己仙": ["store_manager", "hq_manager", "admin"],
    "default": ["store_manager", "hq_manager", "admin"]
  },
  "escalation_triggers": {
    "timeout": {"enabled": true, "description": "SLA超时自动升级"},
    "no_response_24h": {"enabled": true, "description": "高优先级24h无响应"},
    "consecutive_anomaly": {"enabled": true, "days": 3, "description": "连续3天同类异常"},
    "major_complaint": {"enabled": true, "description": "重大客诉立即升级"}
  }
}'::jsonb, '升级链配置', 'system')
ON CONFLICT (config_key) DO NOTHING;

-- ─── 推送配置 ───
INSERT INTO agent_v2_configs (config_key, config_value, description, updated_by) VALUES
('push_config', '{
  "daily_report": {
    "target": "hq_group",
    "time": "21:30",
    "enabled": true
  },
  "weekly_report": {
    "target": "hq_group",
    "time": "周一 10:00",
    "enabled": true
  },
  "monthly_report": {
    "target": "admin_group",
    "time": "每月1日 09:00",
    "enabled": true
  },
  "red_channel": {
    "target": ["hq_manager", "admin"],
    "enabled": true,
    "description": "红色通道告警推送"
  },
  "anomaly_alert": {
    "target": "store_group",
    "enabled": true,
    "description": "异常检测结果推送给门店群"
  }
}'::jsonb, '推送目标配置', 'system')
ON CONFLICT (config_key) DO NOTHING;

-- ─── 节奏时间表配置 ───
INSERT INTO agent_v2_configs (config_key, config_value, description, updated_by) VALUES
('rhythm_schedule', '{
  "morning_standup": {
    "enabled": true,
    "cron": "30 9 * * *",
    "timezone": "Asia/Shanghai",
    "description": "09:30 晨检：昨日异常/未闭环/阻塞"
  },
  "patrol_wave1": {
    "enabled": true,
    "cron": "30 11 * * *",
    "timezone": "Asia/Shanghai",
    "description": "11:30 午巡"
  },
  "patrol_wave2": {
    "enabled": true,
    "cron": "30 16 * * *",
    "timezone": "Asia/Shanghai",
    "description": "16:30 晚巡"
  },
  "end_of_day": {
    "enabled": true,
    "cron": "30 21 * * *",
    "timezone": "Asia/Shanghai",
    "description": "21:30 日终总结"
  },
  "weekly_report": {
    "enabled": true,
    "cron": "0 10 * * 1",
    "timezone": "Asia/Shanghai",
    "description": "周一10:00 周报"
  },
  "monthly_evaluation": {
    "enabled": true,
    "cron": "0 9 1 * *",
    "timezone": "Asia/Shanghai",
    "description": "每月1日 月评"
  },
  "kpi_calculation": {
    "enabled": true,
    "cron": "0 1 * * *",
    "timezone": "Asia/Shanghai",
    "description": "01:00 KPI每日计算"
  }
}'::jsonb, '节奏时间表配置', 'system')
ON CONFLICT (config_key) DO NOTHING;

-- ─── 自动化边界配置 ───
INSERT INTO agent_v2_configs (config_key, config_value, description, updated_by) VALUES
('auto_decision', '{
  "auto_allowed": [
    "异常检测触发",
    "SLA超时提醒",
    "逾期任务升级",
    "节奏报告生成",
    "KPI快照计算",
    "飞书消息推送",
    "证据链完整性检查",
    "数据趋势分析"
  ],
  "human_required": [
    "关闭/作废任务",
    "调整KPI目标",
    "修改异常阈值",
    "人员处罚/奖励",
    "菜品下架决策",
    "排班方案调整",
    "营销活动审批",
    "供应商更换"
  ]
}'::jsonb, '自动化边界配置', 'system')
ON CONFLICT (config_key) DO NOTHING;

-- ─── 门店名映射配置 ───
INSERT INTO agent_v2_configs (config_key, config_value, description, updated_by) VALUES
('store_mapping', '{
  "daily_reports_to_feishu": {
    "洪潮大宁久光店": "洪潮久光店",
    "马己仙上海音乐广场店": "马己仙大宁店"
  },
  "store_brands": {
    "洪潮大宁久光店": "洪潮",
    "马己仙上海音乐广场店": "马己仙"
  }
}'::jsonb, '门店名称映射配置', 'system')
ON CONFLICT (config_key) DO NOTHING;

-- ============================================================
-- 初始化 KPI 目标值（公司级默认）
-- ============================================================

INSERT INTO kpi_targets (brand, metric_key, target_value, warning_value, unit, direction, period, created_by) VALUES
-- 闭环效率
(NULL, 'ttfr_p90',          30,    45,    'minutes',  'lower_better',  'monthly', 'system'),
(NULL, 'ttc_p90',           24,    36,    'hours',    'lower_better',  'monthly', 'system'),
(NULL, 'timeout_rate',       5,    10,    '%',        'lower_better',  'monthly', 'system'),
-- 管理质量
(NULL, 'false_positive_rate', 10,  15,    '%',        'lower_better',  'monthly', 'system'),
(NULL, 'evidence_coverage',  90,   80,    '%',        'higher_better', 'monthly', 'system'),
-- 管理动作
(NULL, 'first_pass_rate',    80,   70,    '%',        'higher_better', 'monthly', 'system'),
(NULL, 'avg_remind_count',    1.5,  2.0,  'count',    'lower_better',  'monthly', 'system'),
(NULL, 'escalation_rate',    10,   15,    '%',        'lower_better',  'monthly', 'system')
ON CONFLICT DO NOTHING;

-- 品牌级目标（洪潮 人效门槛低于马己仙）
INSERT INTO kpi_targets (brand, metric_key, target_value, warning_value, unit, direction, period, created_by) VALUES
('洪潮',  'labor_efficiency',    1200, 1100, 'yuan', 'higher_better', 'monthly', 'system'),
('马己仙', 'labor_efficiency',   1500, 1400, 'yuan', 'higher_better', 'monthly', 'system'),
('洪潮',  'gross_margin',         60,   58,  '%',    'higher_better', 'monthly', 'system'),
('马己仙', 'gross_margin',        65,   62,  '%',    'higher_better', 'monthly', 'system'),
('洪潮',  'revenue_achievement',  95,   90,  '%',    'higher_better', 'monthly', 'system'),
('马己仙', 'revenue_achievement', 95,   90,  '%',    'higher_better', 'monthly', 'system')
ON CONFLICT DO NOTHING;
