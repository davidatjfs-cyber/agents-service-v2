#!/usr/bin/env node
/**
 * 在服务器或本地执行（需 DATABASE_URL）：
 *   cd agents-service-v2 && node scripts/report-march-reconcile.mjs
 *   node scripts/report-march-reconcile.mjs 2026-03-01 2026-03-31
 *
 * 输出 Markdown：三月 BI 异常全量 + 与 徐曼金/喻峰/喻烽/王世波/黎永荣 的 agent_scores 周行对照。
 */
import 'dotenv/config';
import pg from 'pg';

const { Pool } = pg;

const DEFAULT_START = '2026-03-01';
const DEFAULT_END = '2026-03-31';

const start = process.argv[2] || DEFAULT_START;
const end = process.argv[3] || DEFAULT_END;

if (!process.env.DATABASE_URL) {
  console.error('缺少 DATABASE_URL');
  process.exit(1);
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });

async function q(sql, params = []) {
  const r = await pool.query(sql, params);
  return r.rows;
}

function mdTable(rows, cols) {
  if (!rows.length) return '_（无行）_\n';
  const head = `| ${cols.map((c) => c.label).join(' | ')} |`;
  const sep = `| ${cols.map(() => '---').join(' | ')} |`;
  const body = rows
    .map((row) => `| ${cols.map((c) => String(row[c.key] ?? '').replace(/\|/g, '\\|').slice(0, 500)).join(' | ')} |`)
    .join('\n');
  return `${head}\n${sep}\n${body}\n`;
}

async function main() {
  const lines = [];
  lines.push(`# BI 异常 vs 绩效核对报告`);
  lines.push(`- 区间：**${start}** ~ **${end}**`);
  lines.push(`- 生成时间（UTC）：${new Date().toISOString()}`);
  lines.push('');

  const triggers = await q(
    `SELECT id, anomaly_key, store, brand, severity, trigger_date,
            date_trunc('week', trigger_date::timestamp)::date AS week_monday,
            assigned_role, notify_target_role, created_at
     FROM anomaly_triggers
     WHERE trigger_date >= $1::date AND trigger_date <= $2::date
     ORDER BY trigger_date, store, anomaly_key, id`,
    [start, end]
  );
  lines.push(`## 1. 异常触发全量（${triggers.length} 条）`);
  lines.push(
    mdTable(triggers, [
      { key: 'id', label: 'id' },
      { key: 'trigger_date', label: '日期' },
      { key: 'week_monday', label: '周一起' },
      { key: 'store', label: '门店' },
      { key: 'anomaly_key', label: '规则键' },
      { key: 'severity', label: '严重度' },
      { key: 'assigned_role', label: 'assigned_role' },
      { key: 'notify_target_role', label: 'notify_target_role' }
    ])
  );

  const byKey = await q(
    `SELECT anomaly_key,
            COUNT(*)::int AS march_rows,
            CASE
              WHEN anomaly_key IN (
                'revenue_achievement', 'labor_efficiency', 'table_visit_product', 'table_visit_ratio',
                'hongchao_jiuguang_private_room', 'gross_margin', 'dish_unit_product', 'cost_spike'
              ) THEN '计入周汇总(规则扣分)'
              WHEN anomaly_key = 'recharge_zero' THEN '计入周汇总(店长·充值)'
              WHEN anomaly_key = 'bad_review_product' THEN '计入周汇总(出品·差评)'
              WHEN anomaly_key = 'bad_review_service' THEN '计入周汇总(店长·差评)'
              WHEN anomaly_key IN ('food_safety', 'revenue_achievement_monthly') THEN '当前不进周汇总扣分'
              ELSE '未映射·当前不进周汇总'
            END AS weekly_model_note
     FROM anomaly_triggers
     WHERE trigger_date >= $1::date AND trigger_date <= $2::date
     GROUP BY anomaly_key
     ORDER BY march_rows DESC`,
    [start, end]
  );
  lines.push(`## 2. 按规则键汇总 + 是否进入周汇总模型`);
  lines.push(mdTable(byKey, [
    { key: 'anomaly_key', label: '规则键' },
    { key: 'march_rows', label: '条数' },
    { key: 'weekly_model_note', label: '周汇总说明' }
  ]));

  const targets = await q(
    `SELECT username, name, store, role, registered
     FROM feishu_users
     WHERE registered = true
       AND (
         name LIKE '%徐曼金%'
         OR name LIKE '%王世波%'
         OR name LIKE '%黎永荣%'
         OR name ~ '喻[峰烽]'
       )
     ORDER BY store, role, username`
  );
  lines.push(`## 3. 目标人员飞书绑定（${targets.length} 人）`);
  lines.push(mdTable(targets, [
    { key: 'username', label: 'username' },
    { key: 'name', label: '姓名' },
    { key: 'store', label: '门店' },
    { key: 'role', label: '岗位' }
  ]));

  const usernames = targets.map((t) => t.username).filter(Boolean);
  let scores = [];
  if (usernames.length) {
    scores = await q(
      `SELECT username, name, store, role, period, score_model, total_score,
              deductions::text AS deductions_json, summary, updated_at
       FROM agent_scores
       WHERE score_model = 'anomaly_rollups_v2'
         AND period ~ '^week_[0-9]{4}-[0-9]{2}-[0-9]{2}$'
         AND lower(username) = ANY($1::text[])
         AND substring(period from 6 for 10)::date >= date_trunc('week', $2::timestamp)::date
         AND substring(period from 6 for 10)::date <= date_trunc('week', $3::timestamp)::date
       ORDER BY substring(period from 6 for 10)::date, store, role, username`,
      [usernames.map((u) => u.toLowerCase()), start, end]
    );
  }
  lines.push(`## 4. 目标人员周度 anomaly_rollups_v2 绩效行（${scores.length} 条）`);
  lines.push(
    mdTable(scores, [
      { key: 'period', label: 'period' },
      { key: 'username', label: 'username' },
      { key: 'name', label: '姓名' },
      { key: 'store', label: '门店' },
      { key: 'role', label: '岗位' },
      { key: 'total_score', label: '总分' },
      { key: 'deductions_json', label: '扣分明细JSON' },
      { key: 'updated_at', label: '更新时间' }
    ])
  );

  const gaps = await q(
    `WITH trig AS (
       SELECT store,
              date_trunc('week', trigger_date::timestamp)::date AS wm,
              COUNT(*) FILTER (
                WHERE anomaly_key IN (
                  'revenue_achievement', 'labor_efficiency', 'table_visit_product', 'table_visit_ratio',
                  'hongchao_jiuguang_private_room', 'gross_margin', 'dish_unit_product', 'cost_spike',
                  'recharge_zero', 'bad_review_product', 'bad_review_service'
                )
              )::int AS scored_trigger_rows
       FROM anomaly_triggers
       WHERE trigger_date >= $1::date AND trigger_date <= $2::date
       GROUP BY store, wm
     ),
     sc AS (
       SELECT store, substring(period from 6 for 10)::date AS wm, COUNT(*)::int AS score_rows
       FROM agent_scores
       WHERE score_model = 'anomaly_rollups_v2' AND period LIKE 'week_%'
       GROUP BY store, substring(period from 6 for 10)::date
     )
     SELECT t.store, t.wm AS week_monday, t.scored_trigger_rows,
            COALESCE(s.score_rows, 0) AS agent_score_rows
     FROM trig t
     LEFT JOIN sc s ON s.store = t.store AND s.wm = t.wm
     WHERE t.scored_trigger_rows > 0 AND COALESCE(s.score_rows, 0) = 0
     ORDER BY t.wm, t.store`,
    [start, end]
  );
  lines.push(`## 5. 门店级缺口（有应计异常但当周无任何 agent_scores 行）`);
  lines.push(
    gaps.length
      ? mdTable(gaps, [
          { key: 'week_monday', label: '周一起' },
          { key: 'store', label: '门店' },
          { key: 'scored_trigger_rows', label: '应计异常条数' },
          { key: 'agent_score_rows', label: '当周score行数' }
        ])
      : '_无此类缺口（或当周已有 score 行）_\n'
  );

  lines.push('');
  lines.push('---');
  lines.push('回填三月周评分（部署新代码后，在管理端登录 agents-admin 调用）：');
  lines.push('`POST /api/scoring/backfill-range` body: `{ "start":"2026-03-01","end":"2026-03-31","sendFeishu":false }`');

  console.log(lines.join('\n'));
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
