import pg from 'pg';
import { logger } from './logger.js';
import { getAppEnv } from './safety.js';

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
    // 默认可写：管理端配置、任务、异常落库为刚需。仅当显式 ENABLE_DB_READ_ONLY=true 或 ENABLE_DB_WRITE=false 时只读。
    const readOnly =
      String(process.env.ENABLE_DB_READ_ONLY || '').toLowerCase() === 'true' ||
      process.env.ENABLE_DB_WRITE === 'false';
    const appEnv = getAppEnv();
    pool.on('connect', async (client) => {
      try {
        if (readOnly) {
          await client.query('SET default_transaction_read_only = on');
          logger.warn({ appEnv }, 'DB is READ-ONLY (ENABLE_DB_READ_ONLY=true or ENABLE_DB_WRITE=false)');
        }
      } catch (e) {
        logger.error({ err: e?.message || e }, 'Failed to set DB safety mode');
        if (readOnly) process.exit(2);
      }
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
