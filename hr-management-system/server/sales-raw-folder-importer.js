/**
 * 销售明细目录自动入库 → sales_raw
 *
 * 说明：生产环境（ECS）无法读取你 Mac 上的 /Users/.../Desktop/HRMS。
 * 用法：在服务器上建目录（如 /opt/hrms/incoming-sales），用 rsync/scp 把 Excel 拷过去，
 * 并设置环境变量 SALES_RAW_IMPORT_DIR。默认每 15 分钟扫描一次。
 *
 * 环境变量：
 * - SALES_RAW_IMPORT_DIR     绝对路径，未设置则本模块不启动
 * - SALES_RAW_IMPORT_INTERVAL_MS  扫描间隔（毫秒），默认 900000（15 分钟）
 * - SALES_RAW_IMPORT_FORCE=true   跳过成本覆盖率门槛（与后台 force 上传等价，慎用）
 * - SALES_RAW_IMPORT_DEFAULT_STORE  Excel 无「门店」列时用默认门店名
 * - SALES_RAW_IMPORT_RECURSIVE=true 递归子目录（跳过 imported/、failed/）
 */
import fs from 'fs';
import path from 'path';
import XLSX from 'xlsx';
import {
  parseSalesRawRows,
  insertSalesRawRows,
  evaluateSalesRawUploadQuality
} from './sales-raw-upload.js';

const LOCK = { running: false };

function inferDateFromFilename(input, now = new Date()) {
  const raw = String(input || '').trim();
  if (!raw) return '';
  const basename = raw.replace(/\.[^.]+$/, '');

  const full = basename.match(/(20\d{2})[-_.\/年](\d{1,2})[-_.\/月](\d{1,2})/);
  if (full) {
    const y = Number(full[1]);
    const m = Number(full[2]);
    const d = Number(full[3]);
    if (y >= 2000 && m >= 1 && m <= 12 && d >= 1 && d <= 31) {
      return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    }
  }

  const mdRange = basename.match(/(^|\D)(\d{1,2})[-_.\/](\d{1,2})[-_.\/](\d{1,2})(\D|$)/);
  if (mdRange) {
    const m = Number(mdRange[2]);
    const d1 = Number(mdRange[3]);
    const d2 = Number(mdRange[4]);
    if (m >= 1 && m <= 12 && d1 >= 1 && d1 <= 31 && d2 >= 1 && d2 <= 31) {
      const y = now.getFullYear();
      const day = Math.max(d1, d2);
      return `${y}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    }
  }

  const md = basename.match(/(^|\D)(\d{1,2})[-_.\/](\d{1,2})(\D|$)/);
  if (md) {
    const m = Number(md[2]);
    const d = Number(md[3]);
    if (m >= 1 && m <= 12 && d >= 1 && d <= 31) {
      const y = now.getFullYear();
      return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    }
  }

  return '';
}

async function moveUnder(destDir, filePath, tag) {
  const base = path.basename(filePath);
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  let dest = path.join(destDir, `${tag}_${ts}_${base}`);
  let n = 0;
  while (fs.existsSync(dest)) {
    n += 1;
    dest = path.join(destDir, `${tag}_${ts}_${n}_${base}`);
  }
  await fs.promises.rename(filePath, dest);
  return dest;
}

async function collectExcelFiles(baseDir, recursive) {
  const out = [];
  const entries = await fs.promises.readdir(baseDir, { withFileTypes: true });
  for (const ent of entries) {
    const full = path.join(baseDir, ent.name);
    if (ent.isDirectory()) {
      if (['imported', 'failed'].includes(ent.name)) continue;
      if (recursive) out.push(...(await collectExcelFiles(full, true)));
      continue;
    }
    if (!/\.(xlsx|xls)$/i.test(ent.name)) continue;
    if (ent.name.startsWith('~$')) continue;
    if (/\.imported\./i.test(ent.name)) continue;
    out.push(full);
  }
  return out;
}

export async function runSalesRawFolderImportOnce() {
  const dir = String(process.env.SALES_RAW_IMPORT_DIR || '').trim();
  if (!dir) return { skipped: true, reason: 'no_dir' };
  if (LOCK.running) return { skipped: true, reason: 'busy' };
  LOCK.running = true;
  try {
    const stat = await fs.promises.stat(dir).catch(() => null);
    if (!stat?.isDirectory()) return { ok: false, error: 'not_a_directory', dir };

    const force = String(process.env.SALES_RAW_IMPORT_FORCE || '').toLowerCase() === 'true';
    const defStore = String(process.env.SALES_RAW_IMPORT_DEFAULT_STORE || '').trim();
    const recursive = String(process.env.SALES_RAW_IMPORT_RECURSIVE || '').toLowerCase() === 'true';

    const importedDir = path.join(dir, 'imported');
    const failedDir = path.join(dir, 'failed');
    await fs.promises.mkdir(importedDir, { recursive: true });
    await fs.promises.mkdir(failedDir, { recursive: true });

    const files = await collectExcelFiles(dir, recursive);
    const results = [];

    for (const filePath of files) {
      const base = path.basename(filePath);
      const fallbackDate = inferDateFromFilename(base);
      try {
        const wb = XLSX.readFile(filePath, { raw: false });
        let parsed = [];
        for (const sn of wb.SheetNames || []) {
          const ws = wb.Sheets[sn];
          if (!ws) continue;
          const mx = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: '' });
          const out = parseSalesRawRows(mx, 'dinein', defStore, { fallbackDate });
          if (out.length) {
            parsed = out;
            break;
          }
        }

        if (!parsed.length) {
          await moveUnder(failedDir, filePath, 'novalid');
          results.push({ file: base, ok: false, error: 'no_valid_rows' });
          continue;
        }

        if (defStore) {
          for (const r of parsed) {
            if (!String(r.store || '').trim()) r.store = defStore;
          }
        }

        const missingStore = parsed.some((r) => !String(r.store || '').trim());
        if (missingStore) {
          await moveUnder(failedDir, filePath, 'nostore');
          results.push({
            file: base,
            ok: false,
            error: 'missing_store',
            hint: '请在表内提供「门店」列，或设置 SALES_RAW_IMPORT_DEFAULT_STORE'
          });
          continue;
        }

        const groups = new Map();
        for (const r of parsed) {
          const k = `${String(r.store).trim()}||${r.biz_type}`;
          if (!groups.has(k)) groups.set(k, []);
          groups.get(k).push(r);
        }

        let blocked = null;
        const details = [];
        for (const [k, rows] of groups) {
          const [store, biz] = k.split('||');
          const dates = [...new Set(rows.map((r) => r.date).filter(Boolean))].sort();
          if (!dates.length) continue;
          const quality = await evaluateSalesRawUploadQuality(rows, store, biz);
          if (!quality.pass && !force) {
            blocked = { store, biz, quality };
            break;
          }
          const ret = await insertSalesRawRows(rows, store, biz, dates[0], dates[dates.length - 1]);
          details.push({ store, biz, inserted: ret.inserted, deleted: ret.deleted, quality });
        }

        if (blocked) {
          await moveUnder(failedDir, filePath, 'lowcost');
          results.push({ file: base, ok: false, error: 'low_cost_coverage', blocked });
          continue;
        }

        await moveUnder(importedDir, filePath, 'ok');
        results.push({ file: base, ok: true, details });
      } catch (e) {
        try {
          await moveUnder(failedDir, filePath, 'err');
        } catch (_e2) {}
        results.push({ file: base, ok: false, error: String(e?.message || e) });
      }
    }

    const okN = results.filter((r) => r.ok).length;
    if (files.length) {
      console.log('[sales-raw-folder] scan', dir, 'files', files.length, 'imported_ok', okN);
    }
    return { ok: true, dir, processed: files.length, results };
  } finally {
    LOCK.running = false;
  }
}

export function startSalesRawFolderImporter() {
  const dir = String(process.env.SALES_RAW_IMPORT_DIR || '').trim();
  if (!dir) {
    console.log(
      '[sales-raw-folder] 未设置 SALES_RAW_IMPORT_DIR — 不从磁盘自动入库。Mac Desktop/HRMS 不会同步到 ECS，请后台上传或在服务器目录+rsync 并配置该变量。'
    );
    return;
  }
  const ms = Math.max(60_000, Number(process.env.SALES_RAW_IMPORT_INTERVAL_MS || 900_000));
  setInterval(() => {
    runSalesRawFolderImportOnce().catch((e) => console.error('[sales-raw-folder] tick error:', e?.message || e));
  }, ms);
  setTimeout(() => {
    runSalesRawFolderImportOnce().catch((e) => console.error('[sales-raw-folder] startup run:', e?.message || e));
  }, 30_000);
  console.log(
    `[sales-raw-folder] 已启用：每 ${Math.round(ms / 60000)} 分钟扫描 ${dir}；成功→imported/，失败→failed/；SALES_RAW_IMPORT_FORCE=true 可跳过成本门槛`
  );
}
