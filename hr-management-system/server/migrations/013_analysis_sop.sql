-- ============================================================
-- Migration 013: analysis_sop — 分析路径（SOP）场景与步骤
-- 幂等：CREATE IF NOT EXISTS + ON CONFLICT UPSERT
-- ============================================================

BEGIN;

CREATE TABLE IF NOT EXISTS analysis_sop (
  id SERIAL PRIMARY KEY,
  scenario TEXT NOT NULL,
  name TEXT,
  steps JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMP WITHOUT TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITHOUT TIME ZONE DEFAULT NOW(),
  CONSTRAINT analysis_sop_scenario_key UNIQUE (scenario)
);

CREATE INDEX IF NOT EXISTS idx_analysis_sop_scenario ON analysis_sop (scenario);

INSERT INTO analysis_sop (scenario, name, steps) VALUES
(
  'revenue_drop',
  '营收下降分析',
  '["看 revenue 趋势","拆 orders 和 avg_order_value","orders ↓ → 拆 traffic 和 conversion_rate","traffic ↓ → 看 exposure 和 walk_in_rate","avg_order_value ↓ → 看 item_price 和 items_per_order","输出 root cause"]'::jsonb
),
(
  'traffic_drop',
  '客流下降分析',
  '["看 traffic 趋势","拆 new_customers 和 returning_customers","new ↓ → 看曝光和投放","returning ↓ → 看会员复购"]'::jsonb
),
(
  'aov_drop',
  '客单价下降分析',
  '["看 avg_order_value","拆 items_per_order 和 item_price","items ↓ → 搭配问题","price ↓ → 促销问题"]'::jsonb
),
(
  'bad_reviews_increase',
  '差评增加分析',
  '["看 bad_reviews","拆 food_quality 和 service_quality","food → 口味/温度","service → 等位/态度"]'::jsonb
),
(
  'delivery_drop',
  '外卖下降分析',
  '["看 delivery_orders","拆曝光和转化","曝光 ↓ → 排名/投放","转化 ↓ → 评分/菜品"]'::jsonb
),
(
  'efficiency_drop',
  '人效下降分析',
  '["看 orders_per_staff","看 staff_count","判断是否人多单少"]'::jsonb
),
(
  'profit_drop',
  '利润下降分析',
  '["看 profit","拆 revenue 和 cost","cost ↑ → food_cost / labor_cost"]'::jsonb
),
(
  'turnover_low',
  '翻台率低分析',
  '["看 table_turnover","看用餐时长","看排队情况"]'::jsonb
),
(
  'membership_low',
  '会员转化低分析',
  '["看会员数","看转化率","看活动吸引力"]'::jsonb
),
(
  'campaign_ineffective',
  '活动无效分析',
  '["看活动前后数据","看曝光和转化","判断问题在流量还是产品"]'::jsonb
)
ON CONFLICT (scenario) DO UPDATE SET
  name = EXCLUDED.name,
  steps = EXCLUDED.steps,
  updated_at = NOW();

COMMIT;
