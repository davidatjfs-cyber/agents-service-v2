#!/usr/bin/env node
/**
 * 从本地备份合并「缺失」的积分记录到当前 hrms_state.pointRecords。
 *
 * 为什么「有备份」不等于自动恢复？
 * - 备份是某一时刻的快照；当前库在备份之后还有审批、日报等写入，不能把整库回滚覆盖。
 * - 丢失通常是「旧客户端整包 PUT 覆盖」导致数组变短；正确做法是只把备份里有、当前没有的 id 补回。
 *
 * 数据源（与 backup.sh 一致）：
 *   - hrms_pointRecords_*.jsonl.gz  （推荐，一行一条）
 *   - hrms_state_*.json.gz         （整包 state，取 data.pointRecords）
 *
 * 用法（在 server 目录、已配置 DATABASE_URL）：
 *   node scripts/merge-point-records-from-backup.mjs --from /opt/hrms/backups/hrms_pointRecords_20260403_030001.jsonl.gz --dry-run
 *   node scripts/merge-point-records-from-backup.mjs --from-state /opt/hrms/backups/hrms_state_20260402_030015.json.gz --dry-run
 */
import 'dotenv/config';
import { createReadStream } from 'fs';
import { statSync } from 'fs';
import { createGunzip, gunzipSync } from 'zlib';
import { createInterface } from 'readline';
import { readFile } from 'fs/promises';
import { basename } from 'path';
import { Pool } from 'pg';

function argValue(name) {
  const i = process.argv.indexOf(name);
  if (i === -1 || i + 1 >= process.argv.length) return '';
  return String(process.argv[i + 1] || '').trim();
}

const DRY = process.argv.includes('--dry-run');

function recordKey(item) {
  const id = item?.id;
  if (id == null || id === '') return '';
  return String(id);
}

/** 与 index.js mergeSharedStateFields 中 pointRecords 合并顺序一致：patch 在前，保留未命中 id 的原有项 */
function mergePointRecords(existing, patchItems) {
  const getKey = recordKey;
  const existingArr = Array.isArray(existing) ? existing : [];
  const patch = patchItems.filter((p) => getKey(p));
  if (!patch.length) return existingArr;
  const patchKeys = new Set(patch.map(getKey));
  const retained = existingArr.filter((e) => !patchKeys.has(getKey(e)));
  return [...patch, ...retained];
}

async function readJsonlMaybeGz(path) {
  const records = [];
  const isGz = path.endsWith('.gz');
  const input = createReadStream(path);
  const stream = isGz ? input.pipe(createGunzip()) : input;
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of rl) {
    const t = line.trim();
    if (!t) continue;
    try {
      records.push(JSON.parse(t));
    } catch (e) {
      console.warn('[skip] invalid JSON line:', e.message);
    }
  }
  return records;
}

async function readStateSnapshotGz(path) {
  const buf = await readFile(path);
  const text = gunzipSync(buf).toString('utf8').trim();
  const data = JSON.parse(text);
  const pr = data?.pointRecords;
  if (!Array.isArray(pr)) {
    throw new Error('快照中无 data.pointRecords 数组（确认是否为 psql SELECT data 导出的整包 JSON）');
  }
  return pr;
}

async function main() {
  const from = argValue('--from');
  const fromState = argValue('--from-state');
  if ((!from && !fromState) || (from && fromState)) {
    console.error('请指定其一：--from <hrms_pointRecords_*.jsonl.gz> 或 --from-state <hrms_state_*.json.gz>');
    process.exit(1);
  }
  if (!process.env.DATABASE_URL) {
    console.error('缺少 DATABASE_URL');
    process.exit(1);
  }

  let backupRecords;
  const srcPath = from || fromState;
  try {
    statSync(srcPath);
  } catch {
    console.error('文件不存在:', srcPath);
    process.exit(1);
  }

  if (fromState) {
    if (!fromState.endsWith('.gz')) {
      console.error('--from-state 目前仅支持 .json.gz（与 backup.sh 导出一致）');
      process.exit(1);
    }
    console.log('读取 state 快照:', basename(fromState));
    backupRecords = await readStateSnapshotGz(fromState);
  } else {
    console.log('读取 JSONL:', basename(from));
    backupRecords = await readJsonlMaybeGz(from);
  }

  const withId = backupRecords.filter((r) => recordKey(r));
  const skippedNoId = backupRecords.length - withId.length;
  if (skippedNoId) console.warn('备份中无 id 的条数（已忽略）:', skippedNoId);

  const pgssl = process.env.PGSSL === 'disable' ? false : { rejectUnauthorized: false };
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: pgssl });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await client.query(
      `SELECT data FROM hrms_state WHERE key = 'default' FOR UPDATE`
    );
    const row = r.rows?.[0];
    const current = row?.data && typeof row.data === 'object' ? row.data : {};
    const existing = Array.isArray(current.pointRecords) ? current.pointRecords : [];
    const existingIds = new Set(existing.map((e) => recordKey(e)).filter(Boolean));

    const missingOnly = withId.filter((b) => !existingIds.has(recordKey(b)));
    console.log('当前库 pointRecords 条数:', existing.length);
    console.log('备份中有 id 的条数:', withId.length);
    console.log('将补回（当前缺失的 id）条数:', missingOnly.length);

    if (missingOnly.length) {
      const sample = missingOnly.slice(0, 5).map((x) => ({ id: x.id, username: x.username, points: x.points }));
      console.log('示例（最多 5 条）:', JSON.stringify(sample, null, 0));
    }

    if (DRY) {
      await client.query('ROLLBACK');
      console.log('[dry-run] 未写入数据库');
      return;
    }

    if (!missingOnly.length) {
      await client.query('ROLLBACK');
      console.log('无缺失记录，退出');
      return;
    }

    const nextPointRecords = mergePointRecords(existing, missingOnly);
    const nextData = { ...current, pointRecords: nextPointRecords };
    await client.query(`UPDATE hrms_state SET data = $2::jsonb, updated_at = NOW() WHERE key = $1`, [
      'default',
      JSON.stringify(nextData)
    ]);
    await client.query('COMMIT');
    console.log('已写入。合并后 pointRecords 条数:', nextPointRecords.length);
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(e);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

main();
