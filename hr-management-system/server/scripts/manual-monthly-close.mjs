#!/usr/bin/env node
/**
 * 手动跑月度绩效闭环（只写库，不发飞书）
 * 用于验证 4月1日开始是否可用。
 *
 * 用法：
 *   node scripts/manual-monthly-close.mjs 2026-03
 */
import 'dotenv/config';
import { Pool } from 'pg';

import { setPool, inferBrandFromStoreName } from '../agents.js';
import { calculateStoreRating, calculateEmployeeScore } from '../new-scoring-model.js';
import {
  dailyReportIlikePatterns,
  feishuStoreSearchPatterns,
  resolveAgentCanonicalStore
} from '../v2-store-alignment.js';

function normalizeStoreKey(s) {
  return String(s || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '');
}

async function main() {
  const period = String(process.argv[2] || '').trim();
  if (!period || !/^[0-9]{4}-[0-9]{2}$/.test(period)) {
    console.error('period 需要形如 YYYY-MM，例如 2026-03');
    process.exit(1);
  }
  if (!process.env.DATABASE_URL) throw new Error('Missing DATABASE_URL');

  const pgssl = process.env.PGSSL === 'disable' ? false : { rejectUnauthorized: false };
  const pgPool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: pgssl });
  setPool(pgPool);

  const users = await pgPool.query(
    `SELECT username,
            COALESCE(NULLIF(TRIM(name), ''), username) AS name,
            TRIM(store) AS store,
            role
     FROM feishu_users
     WHERE registered = true
       AND role IN ('store_manager', 'store_production_manager')
       AND TRIM(COALESCE(store, '')) <> ''`
  );

  const seenStores = new Set();
  for (const u of users.rows || []) {
    const store = u.store;
    const k = normalizeStoreKey(store);
    if (seenStores.has(k)) continue;
    seenStores.add(k);
    const brand = inferBrandFromStoreName(store);
    await calculateStoreRating(store, brand, period);
  }

  let inserted = 0;
  for (const u of users.rows || []) {
    const store = u.store;
    const brand = inferBrandFromStoreName(store);
    const es = await calculateEmployeeScore(store, u.username, u.role, period);

    const canon = String(resolveAgentCanonicalStore(store) || store).trim();
    const pats = [...new Set([
      ...dailyReportIlikePatterns(store),
      ...feishuStoreSearchPatterns(store),
      ...dailyReportIlikePatterns(canon),
      ...feishuStoreSearchPatterns(canon)
    ])];
    let sr = { rows: [] };
    for (const key of [canon, store].filter((k, i, a) => k && a.indexOf(k) === i)) {
      sr = await pgPool.query(
        `SELECT rating FROM store_ratings WHERE store = $1 AND period = $2 LIMIT 1`,
        [key, period]
      );
      if (sr.rows?.length) break;
    }
    if (!sr.rows?.length) {
      sr = await pgPool.query(
        `SELECT rating FROM store_ratings
         WHERE period = $1 AND store ILIKE ANY($2::text[])
         ORDER BY (actual_revenue > 0) DESC,
           actual_revenue DESC NULLS LAST,
           LENGTH(store) DESC NULLS LAST
         LIMIT 1`,
        [period, pats]
      );
    }
    const storeRating = sr.rows?.[0]?.rating ?? null;

    const breakdown = {
      execution_rating: es.execution_rating,
      attitude_rating: es.attitude_rating,
      ability_rating: es.ability_rating,
      store_rating: storeRating
    };

    const deductions = [];
    const summary = `月度自动评分（${period}）：执行力 ${es.execution_rating || '—'}，态度 ${es.attitude_rating || '—'}，能力 ${es.ability_rating || '—'}，门店 ${storeRating || '—'}。`;

    await pgPool.query(
      `INSERT INTO agent_scores (
         brand, store, username, name, role, period, score_model, total_score, breakdown, deductions, summary
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11)
       ON CONFLICT (brand, store, username, period)
       DO UPDATE SET
         name = EXCLUDED.name,
         total_score = EXCLUDED.total_score,
         breakdown = EXCLUDED.breakdown,
         deductions = EXCLUDED.deductions,
         summary = EXCLUDED.summary,
         feishu_notified = FALSE,
         updated_at = NOW()`,
      [
        brand,
        store,
        u.username,
        u.name,
        u.role,
        period,
        'new_model_monthly',
        es.total_score,
        JSON.stringify(breakdown),
        JSON.stringify(deductions),
        summary
      ]
    );
    inserted++;
  }

  console.log(JSON.stringify({ period, users: users.rows?.length || 0, inserted, seenStores: seenStores.size }, null, 2));

  await pgPool.end();
}

main().catch(async (e) => {
  console.error(e);
  process.exit(1);
});

