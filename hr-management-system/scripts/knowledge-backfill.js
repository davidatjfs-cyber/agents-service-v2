#!/usr/bin/env node
/**
 * knowledge-backfill.js
 *
 * 扫描 knowledge_base 表中 content 为空的记录，重新尝试 pdftotext 文本提取。
 * 用法:
 *   node scripts/knowledge-backfill.js
 *   node scripts/knowledge-backfill.js --dry-run    # 仅列出，不改动
 *
 * 前置条件: pdftotext (poppler-utils) 已安装
 *   macOS: brew install poppler
 *   Ubuntu: apt install poppler-utils
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// ---- Config ----
const UPLOADS_DIR = path.resolve(__dirname, '../uploads');
const DB_TABLE = 'knowledge_base';

// ---- DB connection (reads .env from project root) ----
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const { Pool } = require('pg');
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 3,
  connectionTimeoutMillis: 5000
});

const DRY_RUN = process.argv.includes('--dry-run');
const VERBOSE = process.argv.includes('--verbose');

let fixedCount = 0;
let failCount = 0;

async function main() {
  console.log(`[knowledge-backfill] DRY_RUN=${DRY_RUN}\n`);

  // 1. 查找 content 为空的记录
  const { rows: empties } = await pool.query(`
    SELECT id, title, file_path, file_type, created_at
    FROM ${DB_TABLE}
    WHERE (content IS NULL OR content = '')
      AND file_path IS NOT NULL
      AND file_type IN ('pdf', 'application/pdf')
    ORDER BY created_at DESC
  `);

  if (empties.length === 0) {
    console.log('✓ 没有需要修复的空 content 知识条目');
    await pool.end();
    return;
  }

  console.log(`找到 ${empties.length} 条 content 为空的 PDF 条目：\n`);

  for (const row of empties) {
    const fullPath = path.resolve(UPLOADS_DIR, row.file_path.replace(/^\/?uploads\//, ''));
    console.log(`  [${row.id.slice(0, 8)}] ${row.title}`);
    console.log(`        文件: ${fullPath}`);

    if (!fs.existsSync(fullPath)) {
      // 尝试其他路径
      const altPath = path.resolve(__dirname, '..', row.file_path.replace(/^\//, ''));
      if (fs.existsSync(altPath)) {
        await attemptExtract(row, altPath);
      } else {
        console.log(`        ⚠ 文件不存在: ${fullPath}`);
        console.log(`        ⚠ 也尝试了: ${altPath}`);
        failCount++;
      }
    } else {
      await attemptExtract(row, fullPath);
    }
  }

  // Summary
  console.log(`\n======== 完成 ========`);
  console.log(`总计: ${empties.length} 条`);
  console.log(`成功: ${fixedCount}`);
  console.log(`失败: ${failCount}`);
  if (DRY_RUN) console.log(`(DRY RUN — 未实际修改数据库)`);

  await pool.end();
}

async function attemptExtract(row, filePath) {
  try {
    const text = execFileSync('pdftotext', [filePath, '-'], {
      encoding: 'utf-8',
      maxBuffer: 10 * 1024 * 1024,
      timeout: 30000
    }).trim();

    if (text) {
      console.log(`        ✓ pdftotext 成功提取 ${text.length} 字符`);
      if (!DRY_RUN) {
        await pool.query(
          `UPDATE ${DB_TABLE} SET content = $1, updated_at = now() WHERE id = $2`,
          [text, row.id]
        );
      }
      fixedCount++;
    } else {
      console.log(`        ⚠ pdftotext 返回空文本（可能是扫描件 PDF）`);
      failCount++;
    }
  } catch (err) {
    console.log(`        ✗ pdftotext 失败: ${err.message?.slice(0, 80)}`);
    failCount++;
  }
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
