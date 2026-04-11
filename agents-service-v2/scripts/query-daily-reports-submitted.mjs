#!/usr/bin/env node
/**
 * 查询营业日报在 PG 中的提交时间（submitted_at）与更新时间。
 * 用法（在 agents-service-v2 目录、已配置 DATABASE_URL）：
 *   node scripts/query-daily-reports-submitted.mjs [YYYY-MM-DD] [门店子串1] [门店子串2] ...
 * 未传日期：上海当日；未传门店：默认两个常用店名子串。
 */
import dotenv from 'dotenv';
import pg from 'pg';

dotenv.config({ path: new URL('../.env', import.meta.url) });

const ymd =
  process.argv[2] && /^\d{4}-\d{2}-\d{2}$/.test(process.argv[2])
    ? process.argv[2]
    : new Date().toLocaleString('en-CA', { timeZone: 'Asia/Shanghai' }).slice(0, 10);

const storeTokens =
  process.argv.length > 3
    ? process.argv.slice(3)
    : ['洪潮大宁久光', '马己仙', '音乐广场'];

if (!process.env.DATABASE_URL) {
  console.error('缺少 DATABASE_URL，无法查询。');
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
try {
  const cond = storeTokens
    .map((_, i) => `trim(store) ILIKE $${i + 2}`)
    .join(' OR ');
  const params = [ymd, ...storeTokens.map((t) => `%${String(t).trim()}%`)];
  const sql = `
    SELECT trim(store) AS store,
           date::text AS biz_date,
           submitted,
           (submitted_at AT TIME ZONE 'Asia/Shanghai')::text AS submitted_at_shanghai,
           (updated_at AT TIME ZONE 'Asia/Shanghai')::text AS updated_at_shanghai
    FROM daily_reports
    WHERE date = $1::date
      AND (${cond})
    ORDER BY store`;
  const r = await pool.query(sql, params);
  console.log(JSON.stringify({ date: ymd, rows: r.rows }, null, 2));
} finally {
  await pool.end();
}
