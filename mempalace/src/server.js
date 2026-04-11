/**
 * Minimal MemPalace-compatible HTTP API for agents-service-v2.
 * (Upstream github.com/mempalace/mempalace is an unrelated skill manager;
 *  this service implements /health, GET /inventory, POST /memory, POST /search.)
 */
import express from 'express';
import { writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '..');
const portFile = join(rootDir, '.active-port');

/** @type {Array<{ wing: string, room: string, type: string, content: string, metadata: object, timestamp: number }>} */
const memories = [];

const app = express();
app.use(express.json({ limit: '2mb' }));

app.get('/health', (_req, res) => {
  res.status(200).json({ ok: true, status: 'healthy' });
});

app.post('/memory', (req, res) => {
  const b = req.body || {};
  const rec = {
    wing: String(b.wing ?? ''),
    room: String(b.room ?? ''),
    type: String(b.type ?? ''),
    content: String(b.content ?? ''),
    metadata: b.metadata && typeof b.metadata === 'object' ? b.metadata : {},
    timestamp: typeof b.timestamp === 'number' ? b.timestamp : Date.now()
  };
  memories.push(rec);
  res.status(200).json({ ok: true, id: memories.length });
});

app.post('/search', (req, res) => {
  const b = req.body || {};
  const wing = String(b.wing ?? '');
  const room = String(b.room ?? '');
  const q = String(b.query ?? '').trim().toLowerCase();
  const limit = Math.min(50, Math.max(1, parseInt(String(b.limit ?? '5'), 10) || 5));

  const pool = memories.filter((m) => m.wing === wing && m.room === room);
  let rows = pool;
  if (q) {
    const tokens = q.split(/\s+/).map((t) => t.trim()).filter(Boolean);
    const needles = tokens.length ? tokens : [q];
    const filtered = pool.filter((m) => {
      const c = String(m.content || '').toLowerCase();
      return needles.some((n) => c.includes(n));
    });
    // 中文整句无空格时关键词过滤常为空：回退为同 wing/room 的最近记忆，便于 strategy 稳定命中
    rows = filtered.length ? filtered : pool;
  }
  rows = rows.slice().sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0)).slice(0, limit);
  res.status(200).json(rows);
});

/** 运维/HRMS 数据中心：最近写入的记忆条目摘要（仅进程内存储；重启后清空） */
app.get('/inventory', (req, res) => {
  const rawLimit = parseInt(String(req.query?.limit ?? ''), 10);
  const limit = Math.min(300, Math.max(1, Number.isFinite(rawLimit) ? rawLimit : 80));
  const previewLen = Math.min(800, Math.max(80, parseInt(String(req.query?.preview ?? ''), 10) || 320));
  const sorted = memories.slice().sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
  const slice = sorted.slice(0, limit);
  const items = slice.map((m, idx) => {
    const content = String(m.content ?? '');
    return {
      seq: idx + 1,
      wing: m.wing,
      room: m.room,
      type: m.type || 'strategy',
      preview: content.slice(0, previewLen),
      contentLength: content.length,
      truncated: content.length > previewLen,
      timestamp: m.timestamp,
      score: m.metadata && typeof m.metadata.score === 'number' ? m.metadata.score : null
    };
  });
  res.status(200).json({
    ok: true,
    total: memories.length,
    returned: items.length,
    previewMaxChars: previewLen,
    items
  });
});

function tryListen(preferredPort, fallbackPort) {
  const server = app.listen(preferredPort, () => {
    try {
      writeFileSync(portFile, String(preferredPort), 'utf8');
    } catch {
      /* ignore */
    }
    console.log(`MemPalace HTTP listening on http://localhost:${preferredPort}`);
    console.log(`Health: http://localhost:${preferredPort}/health`);
  });
  server.on('error', (err) => {
    if (err && err.code === 'EADDRINUSE' && preferredPort !== fallbackPort) {
      tryListen(fallbackPort, fallbackPort);
      return;
    }
    console.error(err);
    process.exit(1);
  });
}

const P1 = parseInt(process.env.PORT || '3001', 10);
const P2 = P1 === 3001 ? 3002 : P1 + 1;
tryListen(P1, P2);
