/**
 * MemPalace HTTP — 长期记忆服务（磁盘持久化 + 可选完整性校验与访问控制）
 * 契约：GET /health、GET /inventory、POST /memory、POST /search
 */
import express from 'express';
import { writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { mempalaceAuthMiddleware } from './auth-middleware.js';
import {
  getDataDir,
  ensureDataDir,
  loadMemoriesFromDisk,
  appendMemoryRecord,
  sanitizeWingRoom,
  sanitizeContent,
  rotateBackupIfNeeded
} from './memory-store.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '..');
const portFile = join(rootDir, '.active-port');
const dataDir = getDataDir(rootDir);

/** @type {Array<{ id: number, wing: string, room: string, type: string, content: string, metadata: object, timestamp: number }>} */
const memories = [];

ensureDataDir(dataDir);
const boot = loadMemoriesFromDisk(dataDir, memories);
let nextId = (Number(boot.maxId) || 0) + 1;
if (nextId < 1) nextId = 1;

console.log(
  `[MemPalace] dataDir=${dataDir} diskLoaded=${boot.loaded} skipped=${boot.skipped} memCount=${memories.length} nextId=${nextId}`
);

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(mempalaceAuthMiddleware);

app.get('/health', (_req, res) => {
  res.status(200).json({
    ok: true,
    status: 'healthy',
    persistence: 'disk',
    dataDir,
    memoryCount: memories.length,
    diskBoot: boot
  });
});

app.post('/memory', (req, res) => {
  const b = req.body || {};
  const wing = sanitizeWingRoom(b.wing);
  const room = sanitizeWingRoom(b.room);
  if (!wing || !room) {
    return res.status(400).json({ ok: false, error: 'wing_and_room_required' });
  }
  const id = nextId++;
  const rec = {
    id,
    wing,
    room,
    type: sanitizeWingRoom(b.type || 'strategy').slice(0, 64) || 'strategy',
    content: sanitizeContent(b.content),
    metadata: b.metadata && typeof b.metadata === 'object' ? b.metadata : {},
    timestamp: typeof b.timestamp === 'number' && Number.isFinite(b.timestamp) ? b.timestamp : Date.now()
  };
  memories.push(rec);
  try {
    appendMemoryRecord(dataDir, rec);
    rotateBackupIfNeeded(dataDir);
  } catch (e) {
    console.error('[MemPalace] persist failed', e);
    return res.status(500).json({ ok: false, error: 'persist_failed' });
  }
  res.status(200).json({ ok: true, id });
});

app.post('/search', (req, res) => {
  const b = req.body || {};
  const wing = sanitizeWingRoom(b.wing);
  const room = sanitizeWingRoom(b.room);
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
    rows = filtered.length ? filtered : pool;
  }
  rows = rows.slice().sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0)).slice(0, limit);
  res.status(200).json(rows);
});

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
      id: m.id,
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
    dataDir,
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
    console.log(`Health: http://localhost:${preferredPort}/health  dataDir=${dataDir}`);
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
