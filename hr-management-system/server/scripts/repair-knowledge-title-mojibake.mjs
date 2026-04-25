#!/usr/bin/env node
/**
 * 一次性修复 knowledge_base 历史乱码标题（常见 UTF-8/latin1 误解码）。
 *
 * 默认 dry-run，仅预览；加 --apply 才会写库。
 *
 * 用法：
 *   node scripts/repair-knowledge-title-mojibake.mjs
 *   node scripts/repair-knowledge-title-mojibake.mjs --apply
 *   node scripts/repair-knowledge-title-mojibake.mjs --apply --limit 200
 */
import 'dotenv/config';
import { Pool } from 'pg';

function argValue(name) {
  const i = process.argv.indexOf(name);
  if (i === -1 || i + 1 >= process.argv.length) return '';
  return String(process.argv[i + 1] || '').trim();
}

const APPLY = process.argv.includes('--apply');
const LIMIT = Math.max(0, Number(argValue('--limit') || 0) || 0);

function maybeFixMojibake(rawTitle) {
  const raw = String(rawTitle || '');
  if (!raw) return '';
  try {
    const recovered = Buffer.from(raw, 'latin1').toString('utf8');
    const hasCjk = /[\u4e00-\u9fff]/.test(recovered);
    const rawLooksMojibake = /[ÃÂæçéèêëåäöø]/.test(raw);
    if (!recovered || recovered.includes('\uFFFD')) return '';
    if (!hasCjk && !rawLooksMojibake) return '';
    if (recovered === raw) return '';
    return recovered;
  } catch (e) {
    return '';
  }
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('缺少 DATABASE_URL');
    process.exit(1);
  }

  const pgssl = process.env.PGSSL === 'disable' ? false : { rejectUnauthorized: false };
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: pgssl });
  const client = await pool.connect();

  try {
    const limitSql = LIMIT > 0 ? `LIMIT ${LIMIT}` : '';
    const rows = await client.query(
      `SELECT id, title
       FROM knowledge_base
       WHERE COALESCE(TRIM(title), '') <> ''
       ORDER BY created_at DESC
       ${limitSql}`
    );

    const candidates = [];
    for (const row of rows.rows || []) {
      const id = String(row.id || '').trim();
      const oldTitle = String(row.title || '');
      const fixedTitle = maybeFixMojibake(oldTitle);
      if (!id || !fixedTitle) continue;
      candidates.push({ id, oldTitle, fixedTitle });
    }

    console.log(
      JSON.stringify(
        {
          mode: APPLY ? 'apply' : 'dry-run',
          scanned: rows.rows?.length || 0,
          fixable: candidates.length,
          sample: candidates.slice(0, 10)
        },
        null,
        2
      )
    );

    if (!APPLY || !candidates.length) return;

    await client.query('BEGIN');
    for (const item of candidates) {
      await client.query(
        `UPDATE knowledge_base
         SET title = $2, updated_at = NOW()
         WHERE id = $1`,
        [item.id, item.fixedTitle]
      );
    }
    await client.query('COMMIT');
    console.log(`[done] 已回写 ${candidates.length} 条标题`);
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

