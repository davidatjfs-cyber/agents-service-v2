#!/usr/bin/env node
/**
 * 将 2026-03 月度绩效四人定稿结果写入 employee_scores + agent_scores（new_model_monthly），
 * 与业务确认表一致；「我的档案」读 employee_scores 优先。
 *
 *   node scripts/apply-march-2026-locked-ratings.mjs
 */
import 'dotenv/config';
import { Pool } from 'pg';

const PERIOD = '2026-03';

function inferBrandFromStoreName(store) {
  const s = String(store || '');
  if (s.includes('洪潮')) return '洪潮';
  if (s.includes('马己仙')) return '马己仙';
  return '未知';
}

/** 定稿行：total_score、执行力、态度、能力（与业务表一致） */
const LOCKS = [
  { username: 'NNYXXMJ06', store: '洪潮大宁久光店', total_score: 85, execution_rating: 'A', attitude_rating: 'D', ability_rating: 'C', role: 'store_manager' },
  { username: 'NNYXWSB39', store: '洪潮大宁久光店', total_score: 98, execution_rating: 'D', attitude_rating: 'D', ability_rating: 'A', role: 'store_production_manager' },
  { username: 'NNYXYF26', store: '马己仙上海音乐广场店', total_score: 85, execution_rating: 'D', attitude_rating: 'D', ability_rating: 'B', role: 'store_manager' },
  { username: 'NNYXLYR04', store: '马己仙上海音乐广场店', total_score: 96, execution_rating: 'D', attitude_rating: 'D', ability_rating: 'A', role: 'store_production_manager' }
];

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('Missing DATABASE_URL');
  const pgssl = process.env.PGSSL === 'disable' ? false : { rejectUnauthorized: false };
  const pgPool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: pgssl });

  for (const row of LOCKS) {
    const brand = inferBrandFromStoreName(row.store);
    const fu = await pgPool.query(
      `SELECT COALESCE(NULLIF(TRIM(name), ''), username) AS name FROM feishu_users WHERE LOWER(TRIM(username)) = LOWER(TRIM($1)) LIMIT 1`,
      [row.username]
    );
    const name = String(fu.rows?.[0]?.name || row.username);

    let storeRating = null;
    const sr = await pgPool.query(
      `SELECT rating FROM store_ratings WHERE period = $1 AND store = $2 LIMIT 1`,
      [PERIOD, row.store]
    );
    if (sr.rows?.[0]?.rating) storeRating = sr.rows[0].rating;
    else {
      const sr2 = await pgPool.query(
        `SELECT rating FROM store_ratings WHERE period = $1 AND store ILIKE $2 LIMIT 1`,
        [PERIOD, `%${String(row.store).replace(/%/g, '')}%`]
      );
      storeRating = sr2.rows?.[0]?.rating ?? null;
    }

    const breakdown = {
      execution_rating: row.execution_rating,
      attitude_rating: row.attitude_rating,
      ability_rating: row.ability_rating,
      store_rating: storeRating
    };
    const summary = `月度自动评分（${PERIOD}·定稿）：执行力 ${row.execution_rating}，态度 ${row.attitude_rating}，能力 ${row.ability_rating}，门店 ${storeRating || '—'}。`;

    await pgPool.query(
      `INSERT INTO employee_scores (
         store, brand, username, name, role, period,
         base_score, exception_bonus, exception_deduction, total_score,
         execution_rating, attitude_rating, ability_rating,
         execution_data, attitude_data, ability_data
       ) VALUES ($1,$2,$3,$4,$5,$6,100,0,0,$7,$8,$9,$10,'{}','{}','{}')
       ON CONFLICT (store, username, role, period)
       DO UPDATE SET
         name = EXCLUDED.name,
         total_score = EXCLUDED.total_score,
         execution_rating = EXCLUDED.execution_rating,
         attitude_rating = EXCLUDED.attitude_rating,
         ability_rating = EXCLUDED.ability_rating,
         base_score = EXCLUDED.base_score,
         exception_bonus = EXCLUDED.exception_bonus,
         exception_deduction = EXCLUDED.exception_deduction,
         updated_at = NOW()`,
      [
        row.store,
        brand,
        row.username,
        name,
        row.role,
        PERIOD,
        row.total_score,
        row.execution_rating,
        row.attitude_rating,
        row.ability_rating
      ]
    );

    await pgPool.query(
      `INSERT INTO agent_scores (
         brand, store, username, name, role, period, score_model, total_score, breakdown, deductions, summary
       ) VALUES ($1,$2,$3,$4,$5,$6,'new_model_monthly',$7,$8::jsonb,'[]'::jsonb,$9)
       ON CONFLICT (brand, store, username, period)
       DO UPDATE SET
         name = EXCLUDED.name,
         role = EXCLUDED.role,
         total_score = EXCLUDED.total_score,
         breakdown = EXCLUDED.breakdown,
         summary = EXCLUDED.summary,
         feishu_notified = FALSE,
         updated_at = NOW()`,
      [brand, row.store, row.username, name, row.role, PERIOD, row.total_score, JSON.stringify(breakdown), summary]
    );

    console.log('locked', row.username, row.store, row.total_score, breakdown);
  }

  await pgPool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
