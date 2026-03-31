#!/usr/bin/env node
/** 幂等：agent_experience 上下文列 + tags JSONB */
import fs from 'fs';
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
  console.error('[apply-agent-experience-context-sql] Missing DATABASE_URL');
  process.exit(1);
}

const migrationFiles = ['006_agent_experience_context.sql', '010_agent_experience_tags.sql'];
const pool = new pg.Pool({ connectionString: url, max: 1 });

try {
  for (const name of migrationFiles) {
    const sqlPath = path.join(root, 'src/migrations', name);
    const sql = fs.readFileSync(sqlPath, 'utf8');
    await pool.query(sql);
    console.log(`[apply-agent-experience-context-sql] OK ${name}`);
  }
} catch (e) {
  console.error('[apply-agent-experience-context-sql]', e.message);
  process.exit(1);
} finally {
  await pool.end();
}
