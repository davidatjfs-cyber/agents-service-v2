#!/usr/bin/env node
/**
 * 2026-03 BI 异常触发（anomaly_triggers）逐条核对：
 * - 找出目标人员（徐曼金、喻峰/喻烽、王世波、黎永荣）在 feishu_users 的绑定信息
 * - 找出这四人在 anomaly_rollups_v2 口径下的 agent_scores 周度扣分明细
 * - 对三月每一条异常触发（触发级别）判断：是否“应当计入”以及他们的 deductions 里是否包含该 anomaly_key
 *
 * 说明：
 * - agent_scores.deductions 记录的是“规则/异常键级别”的汇总（不是每条触发的证据行）。
 * - 因此本脚本按“该触发的 anomaly_key 是否出现在 deductions 中”来判定“记录了/没记录”。
 *
 * 用法：
 *   node scripts/report-march-reconcile-detailed.mjs 2026-03-01 2026-03-31
 */
import 'dotenv/config';
import pg from 'pg';
import fs from 'fs/promises';
import path from 'path';

const { Pool } = pg;

const start = process.argv[2] || '2026-03-01';
const end = process.argv[3] || '2026-03-31';

if (!process.env.DATABASE_URL) {
  console.error('缺少 DATABASE_URL');
  process.exit(1);
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 5 });

async function q(sql, params = []) {
  const r = await pool.query(sql, params);
  return r.rows || [];
}

function storeMatch(feishuStore, scoringStore) {
  const a = String(scoringStore || '').trim();
  const b = String(feishuStore || '').trim();
  if (!a || !b) return false;
  const al = a.toLowerCase();
  const bl = b.toLowerCase();
  return al === bl || al.includes(bl) || bl.includes(al);
}

// 周汇总模型中：哪些 anomaly_key 会被计算并写入 anomaly_rollups_v2
function expectedRolesForAnomalyKey(anomalyKey) {
  switch (String(anomalyKey || '')) {
    case 'revenue_achievement':
      return ['store_manager'];
    case 'labor_efficiency':
      return ['store_manager', 'store_production_manager'];
    case 'recharge_zero':
      return ['store_manager'];
    case 'table_visit_product':
      return ['store_production_manager'];
    case 'table_visit_ratio':
      // BI notifyTarget=店长，因此周度扣分也应落到 store_manager
      return ['store_manager'];
    case 'gross_margin':
    case 'dish_unit_product':
    case 'cost_spike':
      return ['store_production_manager'];
    case 'hongchao_jiuguang_private_room':
      return ['store_manager'];
    case 'bad_review_product':
      return ['store_production_manager'];
    case 'bad_review_service':
      return ['store_manager'];

    // 明确不进自然周扣分口径（在 periodic-scoring.js 的 SKIP 或单独闭环里）
    case 'food_safety':
    case 'revenue_achievement_monthly':
      return [];
    default:
      return [];
  }
}

function parsePeriodToWeekMonday(period) {
  // period = week_YYYY-MM-DD
  const s = String(period || '');
  if (!s.startsWith('week_')) return null;
  return s.slice('week_'.length, 'week_'.length + 10);
}

function parseDeductions(deductions) {
  let x = deductions;
  if (typeof x === 'string') {
    try {
      x = JSON.parse(x);
    } catch {
      x = [];
    }
  }
  if (!Array.isArray(x)) return new Set();
  const keys = new Set();
  for (const item of x) {
    if (!item) continue;
    const k = item.anomaly_key;
    if (k) keys.add(String(k));
  }
  return keys;
}

function uniqBy(arr, keyFn) {
  const m = new Map();
  for (const item of arr) {
    const k = keyFn(item);
    if (!m.has(k)) m.set(k, item);
  }
  return [...m.values()];
}

async function main() {
  const targets = await q(
    `SELECT username, name, store, role, registered, updated_at
     FROM feishu_users
     WHERE registered = true
       AND (
         name LIKE '%徐曼金%'
         OR name LIKE '%王世波%'
         OR name LIKE '%黎永荣%'
         OR name ~ '喻[峰烽]'
       )
     ORDER BY updated_at DESC NULLS LAST`
  );

  if (!targets.length) {
    console.error('未找到目标人员绑定（feishu_users）。请检查 feishu_users.name 是否包含这些中文名');
    process.exit(2);
  }

  // 可能存在重复绑定（同名多行），按 username+role+store 去重
  const targetsDedup = uniqBy(targets, (t) => `${t.username}|${t.role}|${t.store}`);

  const targetUsernames = targetsDedup.map((t) => String(t.username).toLowerCase());
  const targetByKey = new Map();
  for (const t of targetsDedup) {
    targetByKey.set(String(t.username).toLowerCase(), t);
  }

  const triggers = await q(
    `SELECT
       id,
       anomaly_key,
       store,
       severity,
       trigger_date::date AS trigger_date,
       to_char(date_trunc('week', trigger_date::timestamp)::date, 'YYYY-MM-DD') AS week_monday
     FROM anomaly_triggers
     WHERE trigger_date >= $1::date AND trigger_date <= $2::date
     ORDER BY trigger_date, store, anomaly_key, id`,
    [start, end]
  );

  const triggerStores = [...new Set(triggers.map((t) => t.store).filter(Boolean))];

  if (!triggerStores.length) {
    console.log('三月区间内 anomaly_triggers 无记录');
    await pool.end();
    return;
  }

  // 把三月涉及到的 store 都拉齐，再按 username/period 做精确判断
  // period 范围取：覆盖自然周起止即可
  const range = await q(
    `SELECT
       date_trunc('week', $1::timestamp)::date AS weekStart,
       date_trunc('week', $2::timestamp)::date AS weekEnd`,
    [start, end]
  );
  const weekStart = range[0]?.weekstart || range[0]?.weekstart;
  const weekEnd = range[0]?.weekend;

  // 上面 SQL alias 兼容写法：直接取行里的键
  const weekStart2 = range[0]?.weekstart || range[0]?.weekstart2 || Object.values(range[0] || {})[0];
  const weekEnd2 = range[0]?.weekend || Object.values(range[0] || {})[1];
  const ws = weekStart2 || start;
  const we = weekEnd2 || end;

  const scoreRows = await q(
    `SELECT
       username,
       name,
       store,
       role,
       period,
       total_score,
       deductions
     FROM agent_scores
     WHERE score_model = 'anomaly_rollups_v2'
       AND lower(username) = ANY($1::text[])
       AND store = ANY($2::text[])
       AND period LIKE 'week_%'
       AND substring(period from 6 for 10)::date >= $3::date
       AND substring(period from 6 for 10)::date <= $4::date`,
    [targetUsernames, triggerStores, ws, we]
  );

  // scoreMap: username|role|store|weekMonday -> { total_score, deductionKeys:Set }
  const scoreMap = new Map();
  for (const r of scoreRows) {
    const weekMonday = parsePeriodToWeekMonday(r.period);
    if (!weekMonday) continue;
    const key = `${String(r.username).toLowerCase()}|${r.role}|${r.store}|${weekMonday}`;
    scoreMap.set(key, {
      total_score: r.total_score,
      deductionKeys: parseDeductions(r.deductions)
    });
  }

  const personIndex = [];
  for (const t of targetsDedup) {
    personIndex.push({
      usernameLower: String(t.username).toLowerCase(),
      display: `${t.name || t.username}（${t.role}）`,
      feishuStore: t.store,
      role: t.role
    });
  }

  const mismatch = new Map(); // personDisplay -> { recorded, missRow, missAnomaly, details:[] }
  for (const p of personIndex) {
    mismatch.set(p.display, { recorded: 0, missRow: 0, missAnomaly: 0, details: [] });
  }

  // 用于生成完整报告
  const detailedLines = [];
  detailedLines.push(`# 三月 BI 异常逐条对照四人绩效`);
  detailedLines.push(`- 区间：${start} ~ ${end}`);
  detailedLines.push(`- 口径：periodic-scoring.js 写入的 \`score_model=anomaly_rollups_v2\`；判定规则为「该触发的 anomaly_key 是否出现在 deductions 里」`);
  detailedLines.push(``);

  // 逐条异常触发：为每位目标输出状态（RECORDED / MISSING_SCORE_ROW / SCORE_ROW_BUT_ANOMALY_MISSING / NOT_EXPECTED）
  for (const trig of triggers) {
    const weekMonday = String(trig.week_monday);
    const anomalyKey = String(trig.anomaly_key);
    const expectedRoles = expectedRolesForAnomalyKey(anomalyKey);

    const lineParts = [];
    lineParts.push(`- 触发 #${trig.id} | ${trig.trigger_date} | ${trig.store} | ${anomalyKey}(${trig.severity}) | week起始 ${weekMonday}`);

    for (const p of personIndex) {
      const pRole = p.role;
      const willBeExpected = expectedRoles.includes(pRole) && storeMatch(p.feishuStore, trig.store);
      if (!willBeExpected) {
        lineParts.push(`  - ${p.display}：NOT_EXPECTED`);
        continue;
      }

      const scoreKey = `${p.usernameLower}|${pRole}|${trig.store}|${weekMonday}`;
      const entry = scoreMap.get(scoreKey);
      if (!entry) {
        const bucket = mismatch.get(p.display);
        bucket.missRow++;
        bucket.details.push({ trigger_id: trig.id, trigger_date: trig.trigger_date, store: trig.store, anomaly_key: anomalyKey, severity: trig.severity, week_monday: weekMonday, expect: 'score_row' });
        lineParts.push(`  - ${p.display}：MISSING_SCORE_ROW`);
        continue;
      }

      if (!entry.deductionKeys.has(anomalyKey)) {
        const bucket = mismatch.get(p.display);
        bucket.missAnomaly++;
        bucket.details.push({ trigger_id: trig.id, trigger_date: trig.trigger_date, store: trig.store, anomaly_key: anomalyKey, severity: trig.severity, week_monday: weekMonday, expect: 'deductions_contains_anomaly_key' });
        lineParts.push(`  - ${p.display}：SCORE_ROW_BUT_ANOMALY_MISSING`);
        continue;
      }

      const bucket = mismatch.get(p.display);
      bucket.recorded++;
      lineParts.push(`  - ${p.display}：RECORDED`);
    }

    detailedLines.push(lineParts.join('\n'));
  }

  // 汇总输出
  detailedLines.push(``);
  detailedLines.push(`## 汇总缺口（按触发级判定）`);
  for (const p of personIndex) {
    const bucket = mismatch.get(p.display);
    detailedLines.push(`- ${p.display}：RECORDED=${bucket.recorded} / MISSING_SCORE_ROW=${bucket.missRow} / SCORE_ROW_BUT_ANOMALY_MISSING=${bucket.missAnomaly}`);
  }

  // 写文件（给你后续直接看）
  const outDir = path.join(process.cwd(), 'reports');
  await fs.mkdir(outDir, { recursive: true });
  const outPath = path.join(outDir, `march-2026-bi-reconcile-detailed_${start}_to_${end}.md`);
  await fs.writeFile(outPath, detailedLines.join('\n'), 'utf8');

  // 控制台只输出汇总
  console.log(detailedLines.filter((l) => l.startsWith('# ') || l.startsWith('- 区间') || l.startsWith('## 汇总') || l.startsWith('- ') && l.includes('：')).join('\n'));
  console.log(`\n已生成详细报告：${outPath}`);

  await pool.end();
}

main().catch(async (e) => {
  console.error(e);
  try {
    await pool.end();
  } catch {}
  process.exit(1);
});

