#!/usr/bin/env node
/**
 * 4月1日绩效正式执行前的 DB 级验收：
 * - new_model_monthly (员工能力/态度/执行力 + 门店评级) 是否已入库、是否仍有未推送行
 * - anomaly_rollups_v2 是否已正常生成最近一两周扣分行
 * - employee_scores / store_ratings / agent_scores 的 period 基本存在
 */
import 'dotenv/config';
import pg from 'pg';

const { Pool } = pg;
if (!process.env.DATABASE_URL) throw new Error('Missing DATABASE_URL');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 5 });
const q = async (sql, params = []) => (await pool.query(sql, params)).rows;

const month = process.argv[2] || '2026-03';
const weekMonday = process.argv[3] || '2026-03-23';
const sampleUsername = process.argv[4] || 'NNYXYF26';

function countFeishuNotified(table, whereClause, params) {
  return q(
    `SELECT
       COUNT(*)::int AS total,
       SUM(CASE WHEN feishu_notified THEN 1 ELSE 0 END)::int AS notified,
       SUM(CASE WHEN feishu_notified=false THEN 1 ELSE 0 END)::int AS pending
     FROM ${table}
     WHERE ${whereClause}`,
    params
  );
}

async function main() {
  const a1 = await countFeishuNotified(
    'agent_scores',
    `score_model='new_model_monthly' AND period=$1`,
    [month]
  ).then(r => r[0]);

  const sr = await q(
    `SELECT COUNT(*)::int AS total,
            SUM(CASE WHEN rating IS NULL THEN 1 ELSE 0 END)::int AS null_rating
     FROM store_ratings
     WHERE period=$1`,
    [month]
  ).then(r => r[0]);

  const es = await q(
    `SELECT COUNT(*)::int AS total,
            SUM(CASE WHEN execution_rating IS NULL THEN 1 ELSE 0 END)::int AS null_execution,
            SUM(CASE WHEN attitude_rating IS NULL THEN 1 ELSE 0 END)::int AS null_attitude,
            SUM(CASE WHEN ability_rating IS NULL THEN 1 ELSE 0 END)::int AS null_ability
     FROM employee_scores
     WHERE period=$1`,
    [month]
  ).then(r => r[0]);

  const myEmp = await q(
    `SELECT total_score, execution_rating, attitude_rating, ability_rating, period, store
     FROM employee_scores
     WHERE lower(username)=lower($1)
     ORDER BY period DESC NULLS LAST
     LIMIT 1`,
    [sampleUsername]
  );

  const myMonthly = await q(
    `SELECT total_score, breakdown, summary, period, store, role, feishu_notified
     FROM agent_scores
     WHERE lower(username)=lower($1) AND score_model='new_model_monthly'
     ORDER BY period DESC NULLS LAST
     LIMIT 1`,
    [sampleUsername]
  );

  const weekly = await countFeishuNotified(
    'agent_scores',
    `score_model='anomaly_rollups_v2' AND substring(period from 6 for 10)::date=$1::date`,
    [weekMonday]
  ).then(r => r[0]);

  console.log(
    JSON.stringify(
      { month, weekMonday, a1, weekly, sr, es, sampleUsername, myEmp: myEmp[0] || null, myMonthly: myMonthly[0] || null },
      null,
      2
    )
  );

  await pool.end();
}

main().catch(async (e) => {
  console.error(e);
  try { await pool.end(); } catch {}
  process.exit(1);
});

