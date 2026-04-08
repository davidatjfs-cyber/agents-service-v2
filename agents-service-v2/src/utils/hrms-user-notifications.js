/**
 * HRMS 档案「公司通知」表：与 hr-management-system 共用 hrms_user_notifications
 */
import { query } from './db.js';
import { logger } from './logger.js';

export async function ensureHrmsUserNotificationsTable() {
  try {
    await query(`
      CREATE TABLE IF NOT EXISTS hrms_user_notifications (
        id BIGSERIAL PRIMARY KEY,
        target_username TEXT NOT NULL,
        title TEXT NOT NULL,
        message TEXT NOT NULL,
        type TEXT NOT NULL DEFAULT 'performance_deduction',
        meta JSONB DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )`);
    await query(
      `CREATE INDEX IF NOT EXISTS idx_hrms_notif_user_created ON hrms_user_notifications (target_username, created_at DESC)`
    );
  } catch (e) {
    logger.warn({ err: e?.message }, 'ensureHrmsUserNotificationsTable');
  }
}
