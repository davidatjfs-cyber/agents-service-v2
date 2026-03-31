#!/usr/bin/env node
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
  console.error('[apply-private-room-column] Missing DATABASE_URL');
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: url, max: 1 });
try {
  await pool.query(`ALTER TABLE daily_reports ADD COLUMN IF NOT EXISTS private_room_uses INTEGER DEFAULT 0`);
  console.log('[apply-private-room-column] OK');
} catch (e) {
  console.error('[apply-private-room-column]', e.message);
  process.exit(1);
} finally {
  await pool.end();
}
