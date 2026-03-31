#!/usr/bin/env node
/**
 * 2026-03 业务规则：营收周/月维度、人效双岗、充值扣分节奏、桌访自然周、毛利洪潮阈值、
 * 大众点评差评扣分、食安四角色、下线客流异常、洪潮久光包房、月频营收/毛利等。
 */
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import pg from 'pg';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
dotenv.config({ path: path.join(root, '.env') });
dotenv.config({ path: path.join(root, '.env.production') });

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('[apply-anomaly-rules-v2] Missing DATABASE_URL');
  process.exit(1);
}

const PATCH = {
  revenue_achievement: {
    name: '实收营收异常（周度）',
    enabled: true,
    frequency: 'weekly',
    data_source: 'daily_reports',
    threshold: {
      medium: { achievement_gap_pct: 10 },
      high: { achievement_gap_pct: 15 }
    },
    assign_to: 'store_manager',
    notify_target_role: 'store_manager',
    evidence: ['日报截图'],
    auto_actions: ['推送店长'],
    human_required: ['追赶方案']
  },
  revenue_achievement_monthly: {
    name: '实收营收异常（月度）',
    enabled: true,
    frequency: 'monthly',
    data_source: 'daily_reports',
    threshold: {
      medium: { achievement_gap_pct: 10 },
      high: { achievement_gap_pct: 15 }
    },
    assign_to: 'store_manager',
    notify_target_role: 'store_manager',
    evidence: ['月报截图'],
    auto_actions: ['推送店长'],
    human_required: ['整月复盘']
  },
  labor_efficiency: {
    name: '人效值异常',
    enabled: true,
    frequency: 'weekly',
    data_source: 'daily_reports',
    threshold: {
      洪潮: { medium: { below: 1100 }, high: { below: 1000 } },
      马己仙: { medium: { below: 1500 }, high: { below: 1400 } },
      default: { medium: { below: 1200 }, high: { below: 1000 } }
    },
    assign_to: 'store_manager',
    notify_target_role: 'store_manager,store_production_manager',
    evidence: ['排班与营收'],
    auto_actions: ['推送店长与出品'],
    human_required: ['排班优化']
  },
  recharge_zero: {
    name: '充值异常',
    enabled: true,
    frequency: 'daily',
    data_source: 'daily_reports',
    threshold: { medium: { penalty: 2 }, high: { penalty: 4 } },
    assign_to: 'store_manager',
    notify_target_role: 'store_manager',
    evidence: ['充值记录'],
    auto_actions: ['提醒'],
    human_required: ['说明原因']
  },
  table_visit_product: {
    name: '桌访产品异常',
    enabled: true,
    frequency: 'weekly',
    data_source: 'table_visit merged',
    threshold: { medium: { same_product_complaints: 2 }, high: { same_product_complaints: 4 } },
    assign_to: 'kitchen_manager',
    notify_target_role: 'store_production_manager',
    evidence: ['整改方案'],
    auto_actions: ['推送出品'],
    human_required: ['下架/改良']
  },
  table_visit_ratio: {
    name: '桌访占比异常',
    enabled: true,
    frequency: 'weekly',
    data_source: 'table_visit + daily_reports',
    threshold: { medium: { below_pct: 50 }, high: { below_pct: 40 } },
    assign_to: 'store_manager',
    notify_target_role: 'store_manager',
    evidence: ['桌访记录'],
    auto_actions: ['推送'],
    human_required: ['培训']
  },
  gross_margin: {
    name: '毛利率异常',
    enabled: true,
    frequency: 'monthly',
    data_source: 'monthly_margins / feishu actual_gross_margin / daily_reports',
    threshold: {
      洪潮: { medium: { below_pct: 68 }, high: { below_pct: 67 } },
      马己仙: { medium: { below_pct: 64 }, high: { below_pct: 63 } },
      default: { medium: { below_pct: 60 }, high: { below_pct: 55 } }
    },
    assign_to: 'kitchen_manager',
    notify_target_role: 'store_production_manager',
    evidence: ['成本分析'],
    auto_actions: ['推送出品'],
    human_required: ['成本优化']
  },
  bad_review_product: {
    name: '大众点评产品差评',
    enabled: true,
    frequency: 'weekly',
    data_source: 'feishu_generic_records.bad_review dianping only',
    threshold: {},
    assign_to: 'kitchen_manager',
    notify_target_role: 'store_production_manager',
    evidence: ['差评截图'],
    auto_actions: ['推送'],
    human_required: ['整改']
  },
  bad_review_service: {
    name: '大众点评服务差评',
    enabled: true,
    frequency: 'weekly',
    data_source: 'feishu_generic_records.bad_review dianping only',
    threshold: {},
    assign_to: 'store_manager',
    notify_target_role: 'store_manager',
    evidence: ['差评截图'],
    auto_actions: ['推送'],
    human_required: ['培训']
  },
  traffic_decline: {
    name: '客流量/订单数异常（已停用）',
    enabled: false,
    frequency: 'weekly',
    data_source: 'daily_reports',
    threshold: {},
    assign_to: 'store_manager',
    notify_target_role: 'store_manager'
  },
  hongchao_jiuguang_private_room: {
    name: '洪潮久光包房使用异常',
    enabled: true,
    frequency: 'weekly',
    data_source: 'daily_reports.private_room_uses',
    threshold: { target_uses: 28, medium_below: 22, high_below: 20 },
    assign_to: 'store_manager',
    notify_target_role: 'store_manager',
    evidence: ['营业日报包房字段'],
    auto_actions: ['推送'],
    human_required: ['提升包房使用']
  },
  food_safety: {
    name: '食品安全',
    enabled: true,
    frequency: 'realtime',
    data_source: 'messages + table_visit + bad_review scan',
    threshold: {},
    assign_to: 'hq_manager',
    notify_target_role: 'store_manager,store_production_manager,hq_manager,admin',
    evidence: ['调查与整改'],
    auto_actions: ['红色通道'],
    human_required: ['总部营运记录/不记录']
  }
};

const pool = new pg.Pool({ connectionString: url, max: 1 });
try {
  const r = await pool.query(`SELECT config_value FROM agent_v2_configs WHERE config_key = 'anomaly_rules' LIMIT 1`);
  if (!r.rows.length) {
    console.log('[apply-anomaly-rules-v2] skip — no anomaly_rules row');
    process.exit(0);
  }
  let v = r.rows[0].config_value;
  if (typeof v === 'string') v = JSON.parse(v);
  if (!v || typeof v !== 'object') {
    console.error('[apply-anomaly-rules-v2] bad config');
    process.exit(1);
  }
  for (const [k, patch] of Object.entries(PATCH)) {
    v[k] = { ...(typeof v[k] === 'object' && v[k] ? v[k] : {}), ...patch };
  }
  await pool.query(
    `UPDATE agent_v2_configs SET config_value = $1::jsonb, updated_at = NOW() WHERE config_key = 'anomaly_rules'`,
    [JSON.stringify(v)]
  );
  console.log('[apply-anomaly-rules-v2] OK');
} catch (e) {
  console.error('[apply-anomaly-rules-v2]', e.message);
  process.exit(1);
} finally {
  await pool.end();
}
