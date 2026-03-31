#!/usr/bin/env node
/**
 * 验证 BI 异常触发 -> master_tasks 责任人 -> agent_scores 扣分责任人 是否一致
 *
 * 当前验证重点（按你问的 2 个 key）：
 * - table_visit_ratio：BI notifyTarget=店长 -> agent_scores.role=store_manager
 * - hongchao_jiuguang_private_room：BI notifyTarget/周度汇总 -> agent_scores.role=store_manager
 *
 * 输出缺口数量与证据：
 * - master_tasks 中该 category 的 assignee_role 统计
 * - agent_scores 中该 anomaly_key 的 deductions 是否只落在期望 role
 */
import 'dotenv/config';
import pg from 'pg';

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 5 });
const q = async (sql, params = []) => (await pool.query(sql, params)).rows;

const start = process.argv[2] || '2026-03-01';
const end = process.argv[3] || '2026-03-31';

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('Missing DATABASE_URL');

  const keys = ['table_visit_ratio', 'hongchao_jiuguang_private_room'];

  const taskStats = await q(
    `SELECT category, assignee_role, COUNT(*)::int AS cnt
     FROM master_tasks
     WHERE source='bi_anomaly'
       AND category = ANY($1::text[])
       AND (created_at::date >= $2::date AND created_at::date <= $3::date)
     GROUP BY category, assignee_role
     ORDER BY category, assignee_role`,
    [keys, start, end]
  );

  // 期望 agent_scores role 映射：在 periodic-scoring/scoring-model 已把 table_visit_ratio 映射到 store_manager
  // hongchao_jiuguang_private_room（private_room_anomaly）在 periodic-scoring 中也应落到 store_manager
  const expectedRole = {
    table_visit_ratio: 'store_manager',
    hongchao_jiuguang_private_room: 'store_manager'
  };

  const scoreCheck = [];
  for (const k of keys) {
    const expRole = expectedRole[k];
    const rows = await q(
      `WITH anom AS (
         SELECT id, store, trigger_date::date AS trigger_date,
                date_trunc('week', trigger_date::timestamp)::date AS week_monday
         FROM anomaly_triggers
         WHERE anomaly_key = $1
           AND trigger_date::date >= $2::date AND trigger_date::date <= $3::date
       ),
       scored AS (
         SELECT DISTINCT a.id
         FROM anom a
         JOIN agent_scores s
           ON s.score_model='anomaly_rollups_v2'
          AND s.store = a.store
          AND s.role = $4
          AND s.period = 'week_' || to_char(a.week_monday, 'YYYY-MM-DD')
         WHERE EXISTS (
           SELECT 1 FROM jsonb_array_elements(s.deductions) el
           WHERE el->>'anomaly_key' = $1
         )
       )
       SELECT
         (SELECT COUNT(*) FROM anom)::int AS trigger_cnt,
         (SELECT COUNT(*) FROM scored)::int AS matched_score_cnt;`,
      [k, start, end, expRole]
    );
    scoreCheck.push({ anomaly_key: k, expectedRole: expRole, ...rows[0] });
  }

  // 反向校验：期望角色之外，是否还存在该 anomaly_key 的扣分落点
  const unexpected = await q(
    `SELECT
       el->>'anomaly_key' AS anomaly_key,
       s.role,
       COUNT(*)::int AS deduction_rows
     FROM agent_scores s
     JOIN LATERAL jsonb_array_elements(s.deductions) el ON true
     WHERE s.score_model='anomaly_rollups_v2'
       AND s.period LIKE 'week_%'
       AND substring(s.period from 6 for 10)::date >= $1::date
       AND substring(s.period from 6 for 10)::date <= $2::date
       AND el->>'anomaly_key' = ANY($3::text[])
       AND NOT (
         (el->>'anomaly_key'='table_visit_ratio' AND s.role='store_manager') OR
         (el->>'anomaly_key'='hongchao_jiuguang_private_room' AND s.role='store_manager')
       )
     GROUP BY 1,2
     ORDER BY 1,2`,
    [start, end, keys]
  );

  console.log(JSON.stringify({ start, end, taskStats, scoreCheck, unexpected }, null, 2));

  await pool.end();
}

main().catch(async (e) => {
  console.error(e);
  try { await pool.end(); } catch {}
  process.exit(1);
});

