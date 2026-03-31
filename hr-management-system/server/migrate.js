import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { Pool } from 'pg';
import bcrypt from 'bcryptjs';
import { getAppEnv } from './safety.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const APP_ENV = getAppEnv();
if (APP_ENV === 'production') {
  console.error('[safety] REFUSE_MIGRATE: APP_ENV=production. Run migrations manually in controlled pipeline only.');
  process.exit(2);
}

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('Missing DATABASE_URL');
  process.exit(1);
}

const pool = new Pool({ connectionString: DATABASE_URL });

async function seedAdmin() {
  const username = String(process.env.ADMIN_USERNAME || 'admin').trim();
  const password = String(process.env.ADMIN_PASSWORD || '').trim();
  const realName = String(process.env.ADMIN_REAL_NAME || '系统管理员').trim();

  if (!password) {
    console.log('Skip admin seed: missing ADMIN_PASSWORD');
    return;
  }

  const existing = await pool.query('select id from users where username = $1 limit 1', [username]);
  if ((existing.rows || []).length) {
    console.log('Admin already exists:', username);
    return;
  }

  const passwordHash = await bcrypt.hash(password, 10);
  await pool.query(
    'insert into users (username, password_hash, real_name, role, is_active) values ($1,$2,$3,$4,$5)',
    [username, passwordHash, realName, 'admin', true]
  );
  console.log('Admin seeded:', username);
}

async function run() {
  const migrationsDir = path.join(__dirname, 'migrations');
  const files = fs
    .readdirSync(migrationsDir)
    .filter(f => f.endsWith('.sql'))
    .sort((a, b) => a.localeCompare(b));

  for (const f of files) {
    const full = path.join(migrationsDir, f);
    const sql = fs.readFileSync(full, 'utf-8');
    console.log('Running migration', f);
    await pool.query(sql);
  }

  await seedAdmin();

  await pool.end();
}

run().catch(e => {
  console.error(e);
  process.exit(1);
});
