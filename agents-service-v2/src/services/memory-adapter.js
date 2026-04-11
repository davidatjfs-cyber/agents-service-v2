/**
 * MemPalace HTTP adapter — strategy_agent only. Fail-soft: never throws to callers.
 * Configure: MEMPALACE_URL (e.g. http://localhost:3001). Optional: monorepo mempalace/.active-port
 */
import axios from 'axios';
import { existsSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { logger } from '../utils/logger.js';
import { rankKnowledgeCandidatesWithLlm, useKnowledgeLlmRanking } from './knowledge/deepseek-knowledge.js';

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
  const headers = {};
  const tok = String(process.env.MEMPALACE_HTTP_TOKEN || process.env.MEMPALACE_BEARER_TOKEN || '').trim();
  if (tok) headers.Authorization = `Bearer ${tok}`;
  return axios.create({
    baseURL: resolveBaseUrl(),
    timeout: Math.max(5000, parseInt(String(process.env.MEMPALACE_HTTP_TIMEOUT_MS || '12000'), 10) || 12000),
    validateStatus: () => true,
    headers
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
/** 运维/健康检查：MemPalace HTTP 是否可达（与 ENABLE_MEMPALACE 是否开启无关）；可选拉取 /inventory 明细 */
export async function probeMemPalaceHealth() {
  const enabled = process.env.ENABLE_MEMPALACE === 'true';
  const fromEnv = !!String(process.env.MEMPALACE_URL || '').trim();
  const baseUrl = resolveBaseUrl();
  try {
    const res = await http().get('/health');
    const body = res.data;
    const ok =
      res.status >= 200 &&
      res.status < 300 &&
      (body?.ok === true || body?.status === 'healthy');
    const out = {
      enabled,
      configured: fromEnv,
      baseUrl,
      reachable: ok,
      httpStatus: res.status,
      inventory: null,
      detailHint: null
    };
    if (ok) {
      try {
        const inv = await http().get('/inventory', { params: { limit: 80, preview: 360 } });
        if (inv.status >= 200 && inv.status < 300 && inv.data && Array.isArray(inv.data.items)) {
          out.inventory = {
            total: Number(inv.data.total) || 0,
            returned: Number(inv.data.returned) || inv.data.items.length,
            previewMaxChars: inv.data.previewMaxChars,
            items: inv.data.items
          };
          out.detailHint =
            out.inventory.total > 0
              ? `共 ${out.inventory.total} 条（下列展示最近 ${out.inventory.returned} 条摘要；MemPalace 已落盘 JSONL）`
              : '暂无记忆条目（尚未写入 /memory）';
        } else {
          out.detailHint = '已连通，但未识别 /inventory 响应（请升级 mempalace 服务）';
        }
      } catch (_e) {
        out.detailHint = '已连通，拉取 /inventory 失败（旧版 MemPalace 无此接口）';
      }
    }
    if (!out.detailHint && !ok) out.detailHint = '服务不可达';
    return out;
  } catch (e) {
    return {
      enabled,
      configured: fromEnv,
      baseUrl,
      reachable: false,
      error: String(e?.message || e),
      inventory: null,
      detailHint: '服务不可达'
    };
  }
}

export async function recallMemory(opts) {
  try {
    const wing = String(opts?.store ?? '');
    const room = String(opts?.agent ?? '');
    if (!wing || !room) return [];
    const limit = Number.isFinite(opts?.limit) ? Math.min(50, Math.max(1, opts.limit)) : 5;
    const q = String(opts?.query ?? '');
    const fetchLimit = useKnowledgeLlmRanking() && q.trim() ? Math.min(30, Math.max(limit, 15)) : limit;
    const res = await http().post('/search', {
      wing,
      room,
      query: q,
      limit: fetchLimit
    });
    if (res.status < 200 || res.status >= 300) {
      logger.warn({ status: res.status }, 'memory-adapter recallMemory non-2xx');
      return [];
    }
    const rows = Array.isArray(res.data) ? res.data : [];
    let ordered = rows;
    let usedLlmOrder = false;

    if (useKnowledgeLlmRanking() && q.trim() && rows.length) {
      const candidates = rows.map((row, i) => ({
        i,
        preview: String(row?.content || '').slice(0, 600)
      }));
      const { indices: idxs } = await rankKnowledgeCandidatesWithLlm({
        store: wing,
        query: q,
        candidates,
        limit: Math.min(15, rows.length)
      });
      if (idxs.length) {
        ordered = idxs.map((i) => rows[i]).filter(Boolean);
        usedLlmOrder = true;
      }
    }

    const minScore = usedLlmOrder ? 0.55 : 0.7;
    const out = [];
    for (const row of ordered) {
      let sc = Number(row?.metadata?.score);
      if (!Number.isFinite(sc)) sc = usedDeepseekOrder ? 0.72 : 0;
      if (sc < minScore) continue;
      const content = String(row?.content ?? '');
      if (!content) continue;
      out.push({ content, score: sc });
      if (out.length >= limit) break;
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
