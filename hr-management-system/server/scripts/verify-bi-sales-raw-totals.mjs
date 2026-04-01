#!/usr/bin/env node
/**
 * 校验 sales_raw 全量 SUM（与月报「执行摘要」折前/实收同一 SQL 口径）
 *
 * Usage:
 *   cd server && node scripts/verify-bi-sales-raw-totals.mjs "马己仙上海音乐广场店" 2026-03-01 2026-03-31 821961.35 691041.98
 */
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import pg from 'pg';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', '.env') });

const argv = process.argv.slice(2).filter((a) => a !== '--dinein');
const dineinOnly = process.argv.includes('--dinein');
const [store, start, end, expGross, expNet] = argv;
if (!store || !start || !end) {
  console.error(
    'Usage: node scripts/verify-bi-sales-raw-totals.mjs [--dinein] <store> <YYYY-MM-DD> <YYYY-MM-DD> [expectedGross] [expectedNet]'
  );
  process.exit(2);
}

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL missing in server/.env');
  process.exit(1);
}

const bizDinein = `
  CASE
    WHEN lower(regexp_replace(COALESCE(biz_type, ''), '\\s+', '', 'g')) IN ('takeaway','delivery','外卖','外送') THEN 'takeaway'
    WHEN lower(regexp_replace(COALESCE(biz_type, ''), '\\s+', '', 'g')) IN ('dinein','堂食','店内','堂食点餐') THEN 'dinein'
    ELSE lower(regexp_replace(COALESCE(biz_type, ''), '\\s+', '', 'g'))
  END
`;
const q = dineinOnly
  ? `
  SELECT
    ROUND(COALESCE(SUM(sales_amount), 0)::numeric, 2) AS gross,
    ROUND(COALESCE(SUM(revenue), 0)::numeric, 2) AS net,
    COUNT(*)::bigint AS row_count,
    COUNT(DISTINCT date)::int AS data_days
  FROM sales_raw
  WHERE TRIM(store) = TRIM($1) AND date BETWEEN $2 AND $3
    AND (${bizDinein}) = 'dinein'
`
  : `
  SELECT
    ROUND(COALESCE(SUM(sales_amount), 0)::numeric, 2) AS gross,
    ROUND(COALESCE(SUM(revenue), 0)::numeric, 2) AS net,
    COUNT(*)::bigint AS row_count,
    COUNT(DISTINCT date)::int AS data_days
  FROM sales_raw
  WHERE TRIM(store) = TRIM($1) AND date BETWEEN $2 AND $3
`;

async function main() {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    const r = await c.query(q, [store, start, end]);
    const row = r.rows[0];
    const out = {
      mode: dineinOnly ? 'dinein_only' : 'all_channels',
      store,
      range: `${start}..${end}`,
      gross: Number(row.gross),
      net: Number(row.net),
      row_count: String(row.row_count),
      data_days: row.data_days
    };
    console.log(JSON.stringify(out, null, 2));

    if (expGross != null && expNet != null) {
      const eg = Number(expGross);
      const en = Number(expNet);
      const tol = 0.02;
      const okG = Math.abs(out.gross - eg) <= tol;
      const okN = Math.abs(out.net - en) <= tol;
      if (okG && okN) {
        console.log(`RESULT: PASS (tolerance ±${tol})`);
        process.exit(0);
      }
      console.log(`RESULT: FAIL (tolerance ±${tol})`);
      if (!okG) console.log(`  折前: DB=${out.gross} expected=${eg} delta=${(out.gross - eg).toFixed(2)}`);
      if (!okN) console.log(`  实收: DB=${out.net} expected=${en} delta=${(out.net - en).toFixed(2)}`);
      process.exit(1);
    }
  } finally {
    await c.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
