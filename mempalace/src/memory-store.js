/**
 * MemPalace 记忆持久化 — 仅追加 JSONL + fsync，启动全量加载。
 * 安全：字段消毒、可选 Bearer、可选 HMAC 完整性、目录权限建议 0700。
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

const MAX_FIELD = 512;
const MAX_CONTENT = 512 * 1024;
const MAX_BOOT_LINES = 250000;

function getDataDir(rootDir) {
  const d = String(process.env.MEMPALACE_DATA_DIR || '').trim();
  if (d) return path.resolve(d);
  return path.join(rootDir, 'data', 'mempalace');
}

export function sanitizeWingRoom(s) {
  let t = String(s ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\.\./g, '_')
    .trim();
  if (t.length > MAX_FIELD) t = t.slice(0, MAX_FIELD);
  return t;
}

export function sanitizeContent(s) {
  let t = String(s ?? '');
  if (t.length > MAX_CONTENT) t = t.slice(0, MAX_CONTENT);
  return t;
}

function hmacLine(obj) {
  const secret = String(process.env.MEMPALACE_INTEGRITY_SECRET || '').trim();
  if (!secret) return null;
  const payload = `${obj.wing}\n${obj.room}\n${obj.type}\n${obj.timestamp}\n${obj.content}`;
  return crypto.createHmac('sha256', secret).update(payload, 'utf8').digest('hex');
}

function verifyHmac(obj) {
  const secret = String(process.env.MEMPALACE_INTEGRITY_SECRET || '').trim();
  if (!secret) return true;
  if (obj.v === 1 && !obj.hmac) return false;
  if (!obj.hmac) return true;
  const expect = hmacLine(obj);
  if (expect == null) return true;
  try {
    return crypto.timingSafeEqual(Buffer.from(String(obj.hmac), 'hex'), Buffer.from(String(expect), 'hex'));
  } catch {
    return false;
  }
}

export function ensureDataDir(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
}

export function loadMemoriesFromDisk(dataDir, memoriesArray) {
  const fp = path.join(dataDir, 'memory.jsonl');
  if (!fs.existsSync(fp)) return { loaded: 0, skipped: 0, path: fp, maxId: 0 };
  const raw = fs.readFileSync(fp, 'utf8');
  const lines = raw.split(/\r?\n/);
  let loaded = 0;
  let skipped = 0;
  let lineNo = 0;
  let syntheticId = 0;
  for (const line of lines) {
    lineNo++;
    if (!line.trim()) continue;
    if (loaded >= MAX_BOOT_LINES) {
      skipped++;
      continue;
    }
    try {
      const obj = JSON.parse(line);
      if (!obj) {
        skipped++;
        continue;
      }
      const legacy = !obj.v && obj.wing != null && obj.room != null && obj.content != null;
      if (obj.v === 1) {
        if (
          obj.hmac &&
          String(process.env.MEMPALACE_INTEGRITY_SECRET || '').trim() &&
          !verifyHmac(obj)
        ) {
          skipped++;
          continue;
        }
      } else if (!legacy) {
        skipped++;
        continue;
      }
      let id = Number(obj.id);
      if (!Number.isFinite(id) || id < 1) {
        syntheticId += 1;
        id = syntheticId;
      } else {
        syntheticId = Math.max(syntheticId, id);
      }
      memoriesArray.push({
        id,
        wing: String(obj.wing || ''),
        room: String(obj.room || ''),
        type: String(obj.type || ''),
        content: String(obj.content || ''),
        metadata: obj.metadata && typeof obj.metadata === 'object' ? obj.metadata : {},
        timestamp: typeof obj.timestamp === 'number' ? obj.timestamp : Date.now()
      });
      loaded++;
    } catch {
      skipped++;
    }
  }
  const maxId = memoriesArray.reduce((m, r) => Math.max(m, Number(r.id) || 0), 0);
  return { loaded, skipped, path: fp, lineNo, maxId };
}

export function appendMemoryRecord(dataDir, rec) {
  ensureDataDir(dataDir);
  const fp = path.join(dataDir, 'memory.jsonl');
  const id = rec.id;
  const row = {
    v: 1,
    id,
    wing: rec.wing,
    room: rec.room,
    type: rec.type,
    content: rec.content,
    metadata: rec.metadata,
    timestamp: rec.timestamp
  };
  row.hmac = hmacLine(row);
  const line = JSON.stringify(row);
  const fd = fs.openSync(fp, 'a', 0o600);
  try {
    fs.writeSync(fd, line + '\n', undefined, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  return fp;
}

export function rotateBackupIfNeeded(dataDir) {
  const every = Math.max(0, parseInt(String(process.env.MEMPALACE_BACKUP_EVERY_WRITES || '500'), 10) || 500);
  if (!every) return;
  const cntPath = path.join(dataDir, '.write_count');
  let n = 0;
  try {
    if (fs.existsSync(cntPath)) n = parseInt(fs.readFileSync(cntPath, 'utf8'), 10) || 0;
  } catch {
    n = 0;
  }
  n++;
  try {
    fs.writeFileSync(cntPath, String(n), 'utf8');
  } catch {
    /* ignore */
  }
  if (n % every !== 0) return;
  const src = path.join(dataDir, 'memory.jsonl');
  if (!fs.existsSync(src)) return;
  const bakDir = path.join(dataDir, 'backups');
  fs.mkdirSync(bakDir, { recursive: true, mode: 0o700 });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const dest = path.join(bakDir, `memory-${stamp}.jsonl`);
  try {
    fs.copyFileSync(src, dest);
  } catch {
    /* ignore */
  }
  pruneOldBackups(bakDir, Math.max(3, parseInt(String(process.env.MEMPALACE_BACKUP_KEEP || '14'), 10) || 14));
}

function pruneOldBackups(bakDir, keep) {
  try {
    const files = fs
      .readdirSync(bakDir)
      .filter((f) => f.startsWith('memory-') && f.endsWith('.jsonl'))
      .map((f) => ({ f, t: fs.statSync(path.join(bakDir, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    for (let i = keep; i < files.length; i++) {
      try {
        fs.unlinkSync(path.join(bakDir, files[i].f));
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* ignore */
  }
}

export { getDataDir };
