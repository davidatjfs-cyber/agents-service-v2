#!/usr/bin/env node
/**
 * 验收：sales_raw 是否已有「大类」写入（需先执行迁移 + 重新上传/目录导入带大类列的 Excel）
 * 用法：在 agents-service-v2 目录下 node scripts/check-sales-raw-categories.mjs
 * 依赖：环境变量 DATABASE_URL 或 PG*（与正式库相同）
 */
import 'dotenv/config';
import pg from 'pg';

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('缺少 DATABASE_URL');
    process.exit(1);
  }
  const pool = new pg.Pool({ connectionString: url, max: 1 });
  try {
    const col = await pool.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'sales_raw'
        AND column_name IN ('category', 'category_code')
    `);
    const names = (col.rows || []).map((r) => r.column_name);
    console.log('sales_raw 列检查 category / category_code:', names.length ? names.join(', ') : '（无 — 请在库中执行迁移 019）');

    let total;
    try {
      total = await pool.query(`SELECT COUNT(*)::bigint AS n FROM sales_raw`);
    } catch (e) {
      if (String(e?.code || '') === '42P01') {
        console.error('表 public.sales_raw 不存在（可能连到了空库或非 HRMS 库）。请用与 HRMS/agents 相同的 DATABASE_URL。');
        process.exit(2);
      }
      throw e;
    }
    const n = Number(total.rows[0]?.n || 0);
    console.log('sales_raw 总行数:', n);
    if (!n) {
      console.log('无数据，无需再查大类填充率。');
      return;
    }
    if (!names.includes('category')) {
      console.log('未找到 category 列，无法统计大类名称填充率。');
      return;
    }
    const filled = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE NULLIF(TRIM(COALESCE(category::text, '')), '') IS NOT NULL)::bigint AS with_cat,
        COUNT(*) FILTER (WHERE NULLIF(TRIM(COALESCE(category_code::text, '')), '') IS NOT NULL)::bigint AS with_code
      FROM sales_raw
    `);
    const w = filled.rows[0] || {};
    const withCat = Number(w.with_cat || 0);
    const withCode = Number(w.with_code || 0);
    console.log('有大类名称的行数:', withCat, `(${(withCat / n * 100).toFixed(1)}%)`);
    if (names.includes('category_code')) {
      console.log('有大类编码的行数:', withCode, `(${(withCode / n * 100).toFixed(1)}%)`);
    }
    if (withCat < n * 0.1) {
      console.log('\n⚠️ 大部份行缺少 category。请确认：');
      console.log('  1) Excel 表头是否含「大类名称」等列（见 sales-raw-upload.js parseSalesRawRows）');
      console.log('  2) 修改上传逻辑后需重新上传或跑目录导入，旧行不会自动补全。');
    }
  } finally {
    await pool.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
