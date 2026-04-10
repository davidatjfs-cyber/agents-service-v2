/**
 * MemPalace HTTP adapter — strategy_agent only. Fail-soft: never throws to callers.
 * Configure: MEMPALACE_URL (e.g. http://localhost:3001). Optional: monorepo mempalace/.active-port
 */
import axios from 'axios';
import { existsSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { logger } from '../utils/logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

function resolveBaseUrl() {
  const env = String(process.env.MEMPALACE_URL || '').trim();
  if (env) return env.replace(/\/$/, '');
  try {
    const pf = join(__dirname, '../../../mempalace/.active-port');
    if (existsSync(pf)) {
      const p = readFileSync(pf, 'utf8').trim();
      if (/^\d+$/.test(p)) return `http://127.0.0.1:${p}`;
    }
  } catch {
    /* ignore */
  }
  return 'http://127.0.0.1:3001';
}

function http() {
  return axios.create({
    baseURL: resolveBaseUrl(),
    timeout: 4500,
    validateStatus: () => true
  });
}

/**
 * @param {{ agent: string, store: string, type?: string, content: string, metadata?: { score?: number } }} opts
 * @returns {Promise<boolean>} whether persisted (false on skip / error)
 */
export async function saveMemory(opts) {
  try {
    const score = Number(opts?.metadata?.score);
    if (!Number.isFinite(score) || score < 0.7) return false;
    const wing = String(opts?.store ?? '');
    const room = String(opts?.agent ?? '');
    const content = String(opts?.content ?? '');
    if (!wing || !room || !content) return false;
    const body = {
      wing,
      room,
      type: String(opts?.type ?? 'strategy'),
      content,
      metadata: { ...(opts.metadata && typeof opts.metadata === 'object' ? opts.metadata : {}), score },
      timestamp: Date.now()
    };
    const res = await http().post('/memory', body);
    if (res.status >= 200 && res.status < 300) return true;
    logger.warn({ status: res.status, data: res.data }, 'memory-adapter saveMemory non-2xx');
    return false;
  } catch (e) {
    logger.warn({ err: e?.message }, 'memory-adapter saveMemory failed');
    return false;
  }
}

/**
 * @param {{ agent: string, store: string, query?: string, limit?: number }} opts
 * @returns {Promise<Array<{ content: string, score: number }>>}
 */
export async function recallMemory(opts) {
  try {
    const wing = String(opts?.store ?? '');
    const room = String(opts?.agent ?? '');
    if (!wing || !room) return [];
    const limit = Number.isFinite(opts?.limit) ? Math.min(50, Math.max(1, opts.limit)) : 5;
    const res = await http().post('/search', {
      wing,
      room,
      query: String(opts?.query ?? ''),
      limit
    });
    if (res.status < 200 || res.status >= 300) {
      logger.warn({ status: res.status }, 'memory-adapter recallMemory non-2xx');
      return [];
    }
    const rows = Array.isArray(res.data) ? res.data : [];
    const out = [];
    for (const row of rows) {
      const sc = Number(row?.metadata?.score);
      if (!Number.isFinite(sc) || sc < 0.7) continue;
      const content = String(row?.content ?? '');
      if (!content) continue;
      out.push({ content, score: sc });
    }
    return out;
  } catch (e) {
    logger.warn(
      { err: e?.message, code: e?.code, status: e?.response?.status },
      'memory-adapter recallMemory failed'
    );
    return [];
  }
}
