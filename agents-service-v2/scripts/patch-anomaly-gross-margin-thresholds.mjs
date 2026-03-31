#!/usr/bin/env node
/**
 * 将 agent_v2_configs.anomaly_rules 中 gross_margin 阈值更新为业务约定：
 * 马己仙：medium <64%，high <63%
 * 洪潮：medium <69%，high <68%
 *
 * 在 ECS 上与 apply-* 脚本同机执行；无行则跳过。
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
  console.error('[patch-anomaly-gross-margin-thresholds] Missing DATABASE_URL');
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: url, max: 1 });

try {
  const r = await pool.query(
    `SELECT config_value FROM agent_v2_configs WHERE config_key = 'anomaly_rules' LIMIT 1`
  );
  if (!r.rows.length) {
    console.log('[patch-anomaly-gross-margin-thresholds] skip — no anomaly_rules row');
    process.exit(0);
  }
  let v = r.rows[0].config_value;
  if (typeof v === 'string') {
    try {
      v = JSON.parse(v);
    } catch {
      console.error('[patch-anomaly-gross-margin-thresholds] invalid JSON');
      process.exit(1);
    }
  }
  if (!v || typeof v !== 'object') {
    console.error('[patch-anomaly-gross-margin-thresholds] unexpected config shape');
    process.exit(1);
  }
  v.gross_margin = v.gross_margin || {};
  v.gross_margin.threshold = v.gross_margin.threshold || {};
  v.gross_margin.threshold['马己仙'] = { medium: { below_pct: 64 }, high: { below_pct: 63 } };
  v.gross_margin.threshold['洪潮'] = { medium: { below_pct: 69 }, high: { below_pct: 68 } };
  v.gross_margin.data_source = 'monthly_margins / feishu actual_gross_margin / daily_reports';
  await pool.query(
    `UPDATE agent_v2_configs SET config_value = $1::jsonb, updated_at = NOW() WHERE config_key = 'anomaly_rules'`,
    [JSON.stringify(v)]
  );
  console.log('[patch-anomaly-gross-margin-thresholds] OK');
} catch (e) {
  console.error('[patch-anomaly-gross-margin-thresholds]', e.message);
  process.exit(1);
} finally {
  await pool.end();
}
