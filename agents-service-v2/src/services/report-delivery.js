import { query } from '../utils/db.js';
import { logger } from '../utils/logger.js';

const TABLE = 'agent_v2_scheduled_report_sends';

export function getShanghaiYmd() {
  return new Date().toLocaleString('en-CA', { timeZone: 'Asia/Shanghai' }).slice(0, 10);
}

export async function ensureReportDeliveryTable() {
  try {
    await query(`
      CREATE TABLE IF NOT EXISTS ${TABLE} (
        id BIGSERIAL PRIMARY KEY,
        job_key TEXT NOT NULL,
        run_ymd TEXT NOT NULL,
        username TEXT NOT NULL,
        scope TEXT NOT NULL,
        ok BOOLEAN NOT NULL DEFAULT false,
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(job_key, run_ymd, username, scope)
      )`);
    await query(
      `CREATE INDEX IF NOT EXISTS idx_${TABLE}_job_ymd_ok ON ${TABLE} (job_key, run_ymd, ok, updated_at DESC)`
    );
  } catch (e) {
    logger.warn({ err: e?.message }, 'ensureReportDeliveryTable failed');
  }
}

async function hasSuccess(jobKey, runYmd, username, scope) {
  const r = await query(
    `SELECT 1 FROM ${TABLE}
     WHERE job_key = $1 AND run_ymd = $2 AND username = $3 AND scope = $4 AND ok = true
     LIMIT 1`,
    [String(jobKey || ''), String(runYmd || ''), String(username || ''), String(scope || '')]
  );
  return !!(r.rows || []).length;
}

async function recordAttempt(jobKey, runYmd, username, scope, ok, errMsg = '') {
  await query(
    `INSERT INTO ${TABLE} (job_key, run_ymd, username, scope, ok, attempts, last_error, updated_at)
     VALUES ($1, $2, $3, $4, $5, 1, $6, NOW())
     ON CONFLICT (job_key, run_ymd, username, scope)
     DO UPDATE SET
       ok = ${TABLE}.ok OR EXCLUDED.ok,
       attempts = ${TABLE}.attempts + 1,
       last_error = CASE WHEN EXCLUDED.ok THEN NULL ELSE EXCLUDED.last_error END,
       updated_at = NOW()`,
    [String(jobKey || ''), String(runYmd || ''), String(username || ''), String(scope || ''), !!ok, errMsg || null]
  );
}

/**
 * 单接收人“成功去重 + 失败重试 + 状态落库”
 * @param {Object} opts
 * @param {string} opts.jobKey
 * @param {string} opts.runYmd
 * @param {string} opts.username
 * @param {string} opts.scope
 * @param {() => Promise<{ok:boolean,error?:string}>} opts.sendFn
 * @param {number} opts.maxAttempts
 */
export async function sendReportToRecipient(opts) {
  const {
    jobKey,
    runYmd,
    username,
    scope,
    sendFn,
    maxAttempts = 3
  } = opts || {};
  await ensureReportDeliveryTable();
  if (await hasSuccess(jobKey, runYmd, username, scope)) {
    return { ok: true, skipped: true };
  }
  let lastErr = '';
  for (let i = 1; i <= maxAttempts; i++) {
    let ok = false;
    try {
      const r = await sendFn();
      ok = !!r?.ok;
      lastErr = r?.error || '';
    } catch (e) {
      ok = false;
      lastErr = String(e?.message || e);
    }
    await recordAttempt(jobKey, runYmd, username, scope, ok, lastErr).catch(() => {});
    if (ok) return { ok: true, skipped: false };
    if (i < maxAttempts) await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return { ok: false, skipped: false, error: lastErr || 'send_failed' };
}

