import pg from 'pg';
import { logger } from './logger.js';

const { Pool } = pg;

let pool = null;

export function getPool() {
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000
    });
    pool.on('error', (err) => {
      logger.error({ err }, 'Unexpected DB pool error');
    });
  }
  return pool;
}

export async function query(text, params) {
  const start = Date.now();
  const result = await getPool().query(text, params);
  const duration = Date.now() - start;
  if (duration > 2000) {
    logger.warn({ duration, query: text.slice(0, 120) }, 'Slow query');
  }
  return result;
}

export async function checkDbHealth() {
  try {
    const r = await getPool().query('SELECT 1 AS ok');
    return r.rows[0]?.ok === 1;
  } catch (e) {
    logger.error({ err: e }, 'DB health check failed');
    return false;
  }
}
