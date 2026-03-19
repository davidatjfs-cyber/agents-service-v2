import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import pg from 'pg';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { Pool } = pg;

async function runMigrations() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  
  // Ensure migrations tracking table exists
  await pool.query(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id SERIAL PRIMARY KEY,
      filename TEXT NOT NULL UNIQUE,
      executed_at TIMESTAMPTZ DEFAULT now()
    )
  `);

  // Get already-run migrations
  const done = await pool.query(`SELECT filename FROM _migrations ORDER BY filename`);
  const doneSet = new Set(done.rows.map(r => r.filename));

  // Find .sql files
  const files = fs.readdirSync(__dirname)
    .filter(f => f.endsWith('.sql'))
    .sort();

  for (const file of files) {
    if (doneSet.has(file)) {
      console.log(`⏭  ${file} (already run)`);
      continue;
    }
    const sql = fs.readFileSync(path.join(__dirname, file), 'utf8');
    console.log(`▶  Running ${file}...`);
    try {
      await pool.query(sql);
      await pool.query(`INSERT INTO _migrations (filename) VALUES ($1)`, [file]);
      console.log(`✅ ${file} done`);
    } catch (e) {
      console.error(`❌ ${file} failed:`, e.message);
      process.exit(1);
    }
  }

  await pool.end();
  console.log('All migrations complete.');
}

runMigrations().catch(e => { console.error(e); process.exit(1); });
