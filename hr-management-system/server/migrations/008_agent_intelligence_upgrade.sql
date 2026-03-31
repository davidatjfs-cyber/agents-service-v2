-- ============================================================
-- Migration 008: Agent Intelligence Upgrade
-- 创建时间: 2026-03-01
-- 说明: 新增三层记忆架构所需表
--   - metric_dictionary   : 系统级记忆（指标字典 + 依赖图）
--   - agent_metric_cache  : 数据级记忆（查询结果缓存）
--   - analysis_rules      : 规则引擎（问题→指标映射）
-- 不修改任何现有表，仅新增。
-- ============================================================

BEGIN;

-- ── 1. 指标字典（系统级记忆） ──────────────────────────────
CREATE TABLE IF NOT EXISTS metric_dictionary (
  metric_id        TEXT PRIMARY KEY,
  name             TEXT NOT NULL,
  description      TEXT,
  formula          TEXT,
  data_source      TEXT,               -- 数据来源表名或'computed'
  time_granularity TEXT DEFAULT 'daily', -- daily/weekly/monthly
  include_discount BOOLEAN DEFAULT TRUE,
  dependencies     JSONB DEFAULT '[]'::jsonb,  -- 依赖的其他 metric_id 列表
  version          INT DEFAULT 1,
  owner            TEXT,               -- 负责维护的角色
  enabled          BOOLEAN DEFAULT TRUE,
  metadata         JSONB DEFAULT '{}'::jsonb,
  created_at       TIMESTAMPTZ DEFAULT NOW(),
  updated_at       TIMESTAMPTZ DEFAULT NOW()
);

-- ── 2. 查询结果缓存（数据级记忆） ──────────────────────────
CREATE TABLE IF NOT EXISTS agent_metric_cache (
  id             SERIAL PRIMARY KEY,
  task_id        TEXT NOT NULL,
  metric_id      TEXT NOT NULL,
  time_range     TEXT NOT NULL,
  store          TEXT,
  result         JSONB NOT NULL,
  metric_version INT,
  hit_count      INT DEFAULT 0,
  created_at     TIMESTAMPTZ DEFAULT NOW(),
  expires_at     TIMESTAMPTZ DEFAULT NOW() + INTERVAL '2 hours',
  UNIQUE (task_id, metric_id, time_range, store)
);

CREATE INDEX IF NOT EXISTS idx_metric_cache_task   ON agent_metric_cache (task_id);
CREATE INDEX IF NOT EXISTS idx_metric_cache_metric ON agent_metric_cache (metric_id, time_range);
CREATE INDEX IF NOT EXISTS idx_metric_cache_expiry ON agent_metric_cache (expires_at);

-- ── 3. 分析规则（规则引擎：问题意图 → 指标映射） ───────────
CREATE TABLE IF NOT EXISTS analysis_rules (
  id               SERIAL PRIMARY KEY,
  intent           TEXT UNIQUE NOT NULL,     -- 分析意图标识
  intent_label     TEXT,                     -- 展示名
  required_metrics JSONB DEFAULT '[]'::jsonb, -- 必须查询的指标
  optional_metrics JSONB DEFAULT '[]'::jsonb, -- 可选指标（追问时补充）
  trigger_keywords JSONB DEFAULT '[]'::jsonb, -- 触发关键词列表
  route            TEXT DEFAULT 'data_auditor',
  enabled          BOOLEAN DEFAULT TRUE,
  priority         INT DEFAULT 0,            -- 数字越大越优先匹配
  metadata         JSONB DEFAULT '{}'::jsonb,
  created_at       TIMESTAMPTZ DEFAULT NOW()
);

-- ── 4. 初始化核心指标字典 ──────────────────────────────────
INSERT INTO metric_dictionary
  (metric_id, name, description, formula, data_source, time_granularity, include_discount, dependencies, version, owner)
VALUES
  -- 营收类
  ('OP_001', '实收营业额', '每日/周/月实际收入（菜品收入）',
   'SUM(revenue) FROM sales_raw',
   'sales_raw', 'daily', FALSE, '[]', 1, 'hq_manager'),

  ('OP_002', '折前营业额', '含优惠前的营业金额（销售金额）',
   'SUM(sales_amount) FROM sales_raw',
   'sales_raw', 'daily', TRUE, '[]', 1, 'hq_manager'),

  ('OP_003', '总折扣金额', '折前-实收 之差',
   'SUM(sales_amount - revenue) FROM sales_raw',
   'sales_raw', 'daily', TRUE, '[]', 1, 'hq_manager'),

  ('OP_010', '桌访客流', '桌访表中就餐人数合计',
   'SUM(COALESCE((record_data->>''就餐人数'')::int, (record_data->>''人数'')::int, 0)) FROM feishu_generic_records WHERE table_id=''tblpx5Efqc6eHo3L''',
   'feishu_generic_records', 'daily', TRUE, '[]', 1, 'hq_manager'),

  ('OP_011', '桌访桌数', '桌访表中桌次合计',
   'COUNT(*) FROM feishu_generic_records WHERE table_id=''tblpx5Efqc6eHo3L''',
   'feishu_generic_records', 'daily', TRUE, '[]', 1, 'hq_manager'),

  ('OP_012', '客单价', '实收营业额 / 桌访桌数',
   'OP_001 / OP_011',
   'computed', 'daily', FALSE, '["OP_001","OP_011"]', 1, 'hq_manager'),

  -- 毛利类
  ('OP_020', '毛利额', '实收营业额 - 原料成本',
   'OP_001 - COST_001',
   'computed', 'monthly', FALSE, '["OP_001","COST_001"]', 1, 'hq_manager'),

  ('OP_021', '毛利率', '毛利额 / 实收营业额 × 100%',
   'OP_020 / OP_001',
   'computed', 'monthly', FALSE, '["OP_020","OP_001"]', 1, 'hq_manager'),

  -- 人效类
  ('HR_001', '在岗人数', '当日实际排班出勤人数',
   'COUNT(DISTINCT employee_username) FROM schedules WHERE status=''present''',
   'schedules', 'daily', TRUE, '[]', 1, 'hr_manager'),

  ('HR_002', '人效', '实收营业额 / 在岗人数',
   'OP_001 / HR_001',
   'computed', 'daily', FALSE, '["OP_001","HR_001"]', 1, 'hq_manager'),

  -- 质检类
  ('QC_001', '收档平均得分', '收档报告档口平均得分',
   'AVG((record_data->>''档口收档平均得分'')::numeric) FROM feishu_generic_records WHERE table_id=''tblXYfSBRrgNGohN''',
   'feishu_generic_records', 'daily', TRUE, '[]', 1, 'hq_manager'),

  ('QC_002', '收档合格率', '合格次数 / 总次数',
   'COUNT(CASE WHEN record_data->>''是否合格''=''合格'' THEN 1 END)::float / NULLIF(COUNT(*),0) FROM feishu_generic_records WHERE table_id=''tblXYfSBRrgNGohN''',
   'feishu_generic_records', 'daily', TRUE, '[]', 1, 'hq_manager'),

  ('QC_010', '差评数', '差评报告条数',
   'COUNT(*) FROM feishu_generic_records WHERE table_id=''tblgReexNjWJOJB6''',
   'feishu_generic_records', 'daily', TRUE, '[]', 1, 'hq_manager'),

  -- 原料类
  ('MAT_001', '原料异常次数', '收货日报中有异常原料的记录数',
   'COUNT(*) FROM feishu_generic_records WHERE table_id IN (''tbllcV1evqTJyzlN'',''tblz4kW1cY22XRlL'') AND record_data->>''异常原料名称'' IS NOT NULL',
   'feishu_generic_records', 'daily', TRUE, '[]', 1, 'hq_manager')

ON CONFLICT (metric_id) DO NOTHING;

-- ── 5. 初始化分析规则 ──────────────────────────────────────
INSERT INTO analysis_rules
  (intent, intent_label, required_metrics, optional_metrics, trigger_keywords, priority)
VALUES
  ('revenue_analysis', '营收分析',
   '["OP_001","OP_002","OP_003"]',
   '["OP_010","OP_012"]',
   '["营业额","营收","实收","生意","收入","业绩","达成"]',
   90),

  ('labor_efficiency', '人效分析',
   '["HR_002","OP_001","HR_001"]',
   '["OP_010"]',
   '["人效","工效","效率","人均产值","坪效"]',
   95),

  ('customer_flow', '客流分析',
   '["OP_010","OP_011","OP_012"]',
   '["OP_001"]',
   '["客流","桌数","人数","客单","桌均","人均消费"]',
   85),

  ('gross_margin', '毛利分析',
   '["OP_021","OP_020","OP_001"]',
   '["OP_003"]',
   '["毛利","毛利率","利润","成本"]',
   90),

  ('quality_check', '质检分析',
   '["QC_001","QC_002"]',
   '[]',
   '["收档","开档","得分","合格","检查"]',
   85),

  ('bad_review', '差评分析',
   '["QC_010"]',
   '["OP_010"]',
   '["差评","投诉","评分","评价","点评","大众点评"]',
   85),

  ('material_exception', '原料异常分析',
   '["MAT_001"]',
   '[]',
   '["原料","收货","食材","进货","异常","原材料"]',
   80)

ON CONFLICT (intent) DO NOTHING;

COMMIT;
