/**
 * 按 PG daily_reports 重算 daily_report_attendance_register（含已有行）。
 * 用法（在 server 目录）：node scripts/refresh-att-register-once.mjs
 */
import pg from 'pg';
import { config } from 'dotenv';
import { fileURLToPath } from 'url';
import path from 'path';
import { backfillDailyAttendanceRegisterMissing } from '../daily-attendance-register.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
config({ path: path.join(__dirname, '..', '.env') });

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
try {
  const r = await backfillDailyAttendanceRegisterMissing(pool, {
    maxRows: 5000,
    refreshExisting: true
  });
  console.log(JSON.stringify(r, null, 2));
} finally {
  await pool.end();
}
