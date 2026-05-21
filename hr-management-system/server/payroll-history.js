/**
 * payroll-history.js
 * ============================================================================
 * 薪资变更审计日志的写入封装。
 *
 * 三种 record_type，与 hrms_state 三个高风险 JSON 字段一一对应:
 *   - 'salary_change'      ←→ state.salaryChangeHistory(调薪/晋升/补差)
 *   - 'payroll_adjustment' ←→ state.payrollAdjustments(月度补贴/基薪覆盖)
 *   - 'payroll_audit'      ←→ state.payrollAudits(月度封账签字)
 *
 * 设计原则:
 *   1. 静默失败(.catch) — 审计日志写不进表不能阻塞业务路径。
 *      但失败时必须 console.error，让运维能看到。
 *   2. 不直接读 hrms_state — 调用方传完整的 before/after 进来,本模块只负责落表。
 *   3. 幂等键可选 — 业务正常写入路径传 null(让 BIGSERIAL 自增即可);
 *      回填脚本必须传 idempotency_key,防止重复跑生成重复行。
 * ============================================================================
 */

let _pool = null;
export function setPayrollHistoryPool(p) { _pool = p; }

function pickAmount(v) {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * 通用写入入口
 * @param {{
 *   recordType: 'salary_change'|'payroll_adjustment'|'payroll_audit',
 *   username?: string,
 *   month?: string,
 *   store?: string,
 *   beforeAmount?: number|null,
 *   afterAmount?: number|null,
 *   beforeValue?: object|null,
 *   afterValue?: object|null,
 *   reason?: string,
 *   source?: string,
 *   operatorUsername?: string,
 *   operatorRole?: string,
 *   idempotencyKey?: string|null
 * }} entry
 */
export async function appendPayrollHistory(entry) {
  if (!_pool) {
    console.error('[payroll-history] pool not set, skipping append');
    return;
  }
  const recordType = String(entry?.recordType || '').trim();
  if (!recordType) {
    console.error('[payroll-history] missing recordType, skipping');
    return;
  }
  try {
    await _pool.query(
      `INSERT INTO hrms_payroll_history
         (record_type, username, month, store,
          before_amount, after_amount,
          before_value, after_value,
          reason, source,
          operator_username, operator_role,
          idempotency_key)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, $10, $11, $12, $13)
       ON CONFLICT (idempotency_key) DO NOTHING`,
      [
        recordType,
        String(entry.username || '').trim() || null,
        String(entry.month || '').trim() || null,
        String(entry.store || '').trim() || null,
        pickAmount(entry.beforeAmount),
        pickAmount(entry.afterAmount),
        entry.beforeValue != null ? JSON.stringify(entry.beforeValue) : null,
        entry.afterValue != null ? JSON.stringify(entry.afterValue) : null,
        entry.reason ? String(entry.reason).slice(0, 2000) : null,
        entry.source ? String(entry.source).slice(0, 60) : null,
        entry.operatorUsername ? String(entry.operatorUsername).trim() : null,
        entry.operatorRole ? String(entry.operatorRole).trim() : null,
        entry.idempotencyKey ? String(entry.idempotencyKey).slice(0, 200) : null
      ]
    );
  } catch (e) {
    // 不抛错:审计日志失败绝不能阻塞用户提交薪资变更
    console.error('[payroll-history] append failed (non-fatal):', e?.message);
  }
}

/** 便捷封装:调薪事件 */
export function appendSalaryChange({ rec, operatorUsername, operatorRole, idempotencyKey }) {
  return appendPayrollHistory({
    recordType: 'salary_change',
    username: rec?.targetUsername,
    store: rec?.store,
    beforeAmount: rec?.oldSalary,
    afterAmount: rec?.newSalary,
    beforeValue: { salary: rec?.oldSalary },
    afterValue: rec,
    reason: rec?.reason,
    source: rec?.source || 'unknown',
    operatorUsername: operatorUsername || rec?.approvedBy,
    operatorRole,
    idempotencyKey: idempotencyKey || (rec?.id ? `salary_change|${rec.id}` : null)
  });
}

/** 便捷封装:月度补贴/基薪调整 */
export function appendPayrollAdjustment({ key, before, after, operatorUsername, operatorRole, reason, idempotencyKey }) {
  return appendPayrollHistory({
    recordType: 'payroll_adjustment',
    username: after?.username || before?.username,
    month: after?.month || before?.month,
    store: after?.store || before?.store,
    beforeAmount: before?.baseAmount ?? before?.subsidy,
    afterAmount: after?.baseAmount ?? after?.subsidy,
    beforeValue: before || null,
    afterValue: after,
    reason,
    source: 'manual_adjust',
    operatorUsername,
    operatorRole,
    idempotencyKey: idempotencyKey || (key ? `payroll_adjustment|${key}|${Date.now()}` : null)
  });
}

/** 便捷封装:月度封账签字 */
export function appendPayrollAudit({ audit, operatorUsername, operatorRole, idempotencyKey }) {
  return appendPayrollHistory({
    recordType: 'payroll_audit',
    month: audit?.month,
    store: audit?.store,
    afterValue: audit,
    source: 'audit_lock',
    operatorUsername: operatorUsername || audit?.auditedBy,
    operatorRole,
    idempotencyKey: idempotencyKey || (audit?.month ? `payroll_audit|${audit.month}|${audit.store || 'ALL'}|${audit.auditedAt || Date.now()}` : null)
  });
}
