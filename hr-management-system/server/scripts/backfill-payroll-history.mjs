#!/usr/bin/env node
/**
 * backfill-payroll-history.mjs
 * ============================================================================
 * 一次性回填:把 hrms_state 中现有的
 *   - salaryChangeHistory (数组)
 *   - payrollAdjustments  (对象 map)
 *   - payrollAudits       (对象 map)
 * 全部追加到新表 hrms_payroll_history，使用 idempotency_key 防止重复跑生成重复行。
 *
 * 前置条件:
 *   1. 已执行 migrations/032_hrms_payroll_history.sql(或服务启动时已自动建表)
 *   2. 数据库可写(ENABLE_DB_WRITE=true 或未设置)
 *
 * 用法:
 *   DRY_RUN=true  node scripts/backfill-payroll-history.mjs   # 仅打印数量
 *   DRY_RUN=false node scripts/backfill-payroll-history.mjs   # 实际执行
 *
 * 幂等:可重复执行,已存在 idempotency_key 的行会被 ON CONFLICT DO NOTHING 跳过
 * ============================================================================
 */
import 'dotenv/config';
import pg from 'pg';

const { Pool } = pg;
const DATABASE_URL = process.env.DATABASE_URL;
const DRY_RUN = String(process.env.DRY_RUN || 'true').toLowerCase() !== 'false';

if (!DATABASE_URL) { console.error('❌ DATABASE_URL 未配置'); process.exit(1); }

const pool = new Pool({ connectionString: DATABASE_URL });

async function ensureTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS hrms_payroll_history (
      id              BIGSERIAL PRIMARY KEY,
      record_type     VARCHAR(40) NOT NULL,
      username        VARCHAR(100),
      month           VARCHAR(7),
      store           VARCHAR(100),
      before_amount   NUMERIC(12, 2),
      after_amount    NUMERIC(12, 2),
      delta_amount    NUMERIC(12, 2) GENERATED ALWAYS AS (
        COALESCE(after_amount, 0) - COALESCE(before_amount, 0)
      ) STORED,
      before_value    JSONB,
      after_value     JSONB,
      reason          TEXT,
      source          VARCHAR(60),
      operator_username VARCHAR(100),
      operator_role     VARCHAR(60),
      created_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
      idempotency_key VARCHAR(200) UNIQUE
    )
  `);
}

function num(v) {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

async function insertRow(row) {
  if (DRY_RUN) return { skipped: true };
  const r = await pool.query(
    `INSERT INTO hrms_payroll_history
       (record_type, username, month, store,
        before_amount, after_amount,
        before_value, after_value,
        reason, source,
        operator_username, operator_role,
        created_at, idempotency_key)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,$10,$11,$12,$13,$14)
     ON CONFLICT (idempotency_key) DO NOTHING
     RETURNING id`,
    [
      row.recordType, row.username, row.month, row.store,
      num(row.beforeAmount), num(row.afterAmount),
      row.beforeValue ? JSON.stringify(row.beforeValue) : null,
      row.afterValue ? JSON.stringify(row.afterValue) : null,
      row.reason, row.source,
      row.operatorUsername, row.operatorRole,
      row.createdAt || new Date().toISOString(),
      row.idempotencyKey
    ]
  );
  return { inserted: r.rowCount > 0 };
}

async function main() {
  console.log(`\n🔍 payroll-history backfill | DRY_RUN=${DRY_RUN}\n`);
  await ensureTable();

  const r = await pool.query("select data from hrms_state where key = 'default' limit 1");
  const data = r.rows[0]?.data;
  if (!data || typeof data !== 'object') {
    console.log('hrms_state 为空,无需回填');
    return;
  }

  let total = 0, inserted = 0, skipped = 0;

  // 1) salaryChangeHistory
  const sch = Array.isArray(data.salaryChangeHistory) ? data.salaryChangeHistory : [];
  console.log(`📋 salaryChangeHistory: ${sch.length} 条`);
  for (const rec of sch) {
    if (!rec || typeof rec !== 'object') continue;
    total++;
    const row = {
      recordType: 'salary_change',
      username: rec.targetUsername,
      store: rec.store,
      beforeAmount: rec.oldSalary,
      afterAmount: rec.newSalary,
      beforeValue: { salary: rec.oldSalary },
      afterValue: rec,
      reason: rec.reason,
      source: rec.source || 'unknown',
      operatorUsername: rec.approvedBy,
      operatorRole: null,
      createdAt: rec.approvedAt || null,
      idempotencyKey: rec.id ? `salary_change|${rec.id}` : `salary_change|backfill|${rec.targetUsername}|${rec.approvedAt}`
    };
    const out = await insertRow(row);
    if (out.inserted) inserted++; else skipped++;
  }

  // 2) payrollAdjustments
  const padj = data.payrollAdjustments && typeof data.payrollAdjustments === 'object' ? data.payrollAdjustments : {};
  const padjKeys = Object.keys(padj);
  console.log(`📋 payrollAdjustments: ${padjKeys.length} 条`);
  for (const key of padjKeys) {
    const item = padj[key];
    if (!item || typeof item !== 'object') continue;
    total++;
    const row = {
      recordType: 'payroll_adjustment',
      username: item.username,
      month: item.month,
      store: item.store,
      beforeAmount: null,                // 回填没有历史 before,只保 after 快照
      afterAmount: item.baseAmount ?? item.subsidy,
      beforeValue: null,
      afterValue: item,
      reason: '回填(原 hrms_state.payrollAdjustments)',
      source: 'backfill',
      operatorUsername: item.updatedBy,
      operatorRole: null,
      createdAt: item.updatedAt || null,
      idempotencyKey: `payroll_adjustment|backfill|${key}`
    };
    const out = await insertRow(row);
    if (out.inserted) inserted++; else skipped++;
  }

  // 3) payrollAudits
  const pau = data.payrollAudits && typeof data.payrollAudits === 'object' ? data.payrollAudits : {};
  const pauKeys = Object.keys(pau);
  console.log(`📋 payrollAudits: ${pauKeys.length} 条`);
  for (const key of pauKeys) {
    const item = pau[key];
    if (!item || typeof item !== 'object') continue;
    total++;
    const row = {
      recordType: 'payroll_audit',
      username: null,
      month: item.month,
      store: item.store,
      beforeAmount: null,
      afterAmount: null,
      beforeValue: null,
      afterValue: item,
      reason: item.audited ? '月度封账(回填)' : '月度解封(回填)',
      source: 'backfill',
      operatorUsername: item.auditedBy,
      operatorRole: null,
      createdAt: item.auditedAt || null,
      idempotencyKey: `payroll_audit|backfill|${key}`
    };
    const out = await insertRow(row);
    if (out.inserted) inserted++; else skipped++;
  }

  console.log('\n📊 汇总:');
  console.log(`  扫描总条数:   ${total}`);
  console.log(`  本次新增:     ${inserted}`);
  console.log(`  已存在跳过:   ${skipped}`);
  if (DRY_RUN) {
    console.log('\n⚠️  DRY RUN,未写入。复核数量无误后用 DRY_RUN=false 实际执行。');
  } else {
    console.log('\n✅ 回填完成。验证: SELECT record_type, COUNT(*) FROM hrms_payroll_history GROUP BY record_type;');
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => { console.error('❌ Backfill failed:', e); process.exit(1); });
