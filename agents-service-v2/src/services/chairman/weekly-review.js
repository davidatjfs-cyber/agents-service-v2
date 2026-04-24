/**
 * 每周决策复盘 — 自动对比上周决策 vs 实际数据变化
 *
 * 每周一 08:00 运行：
 * 1. 查上周所有已关闭任务
 * 2. 对每个任务调用 outcome tracker 评分
 * 3. 汇总成周报复送给 HQ
 */
import { query } from '../../utils/db.js';
import { logger } from '../../utils/logger.js';
import { evaluateTaskOutcome } from './decision-outcome-tracker.js';
import { expandAgentStoreLabels } from '../../config/store-mapping.js';
import { sendText, sendCard } from '../feishu-client.js';

function shanghaiToday() {
  return new Date().toLocaleString('en-CA', { timeZone: 'Asia/Shanghai' }).slice(0, 10);
}

function addDays(ymd, n) {
  const d = new Date(`${ymd}T12:00:00+08:00`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toLocaleString('en-CA', { timeZone: 'Asia/Shanghai' }).slice(0, 10);
}

function storePats(store) {
  return expandAgentStoreLabels(store).map(l => `%${l.replace(/%/g, '')}%`);
}

/**
 * 生成每周复盘报告
 */
export async function generateWeeklyReview() {
  const today = shanghaiToday();

  const weekEnd = addDays(today, -1);
  const weekStart = addDays(today, -7);

  const stores = await getActiveStores();
  if (!stores.length) return null;

  const allResults = [];

  for (const store of stores) {
    const pats = storePats(store);

    const r = await query(
      `SELECT task_id, title, store, severity, source, source_data,
              dispatched_at, resolved_at
       FROM master_tasks
       WHERE store ILIKE ANY($1::text[])
         AND status IN ('closed', 'settled', 'resolved')
         AND COALESCE(resolved_at, closed_at) >= $2::date
         AND COALESCE(resolved_at, closed_at) < $3::date
       ORDER BY resolved_at ASC`,
      [pats, weekStart, today]
    );

    const tasks = r.rows || [];
    if (!tasks.length) continue;

    const storeResults = [];
    for (const task of tasks) {
      try {
        const outcome = await evaluateTaskOutcome(task.task_id);
        if (outcome.ok) {
          storeResults.push({
            title: (task.title || '').slice(0, 40),
            ...outcome.outcome,
          });
        }
      } catch (e) {
        logger.warn({ err: e?.message, taskId: task.task_id }, 'weekly review task eval failed');
      }
    }

    if (storeResults.length) {
      allResults.push({ store, tasks: storeResults });
    }
  }

  return { weekStart, weekEnd, stores: allResults };
}

/**
 * 格式化周报
 */
function formatWeeklyReview(review) {
  if (!review || !review.stores.length) return null;

  const lines = [
    `📊 **Brain 决策周报** (${review.weekStart} ~ ${review.weekEnd})`,
    '',
  ];

  let totalTasks = 0;
  let totalScore = 0;
  let effective = 0;

  for (const s of review.stores) {
    lines.push(`**【${s.store}】**`);
    for (const t of s.tasks) {
      const icon = t.score >= 2 ? '✅' : t.score >= 1 ? '⚠️' : '❌';
      lines.push(`${icon} ${t.title}`);
      lines.push(`   ${t.score_label}(${t.score}/3) | ${t.metric_label}: ${t.before_daily}→${t.after_daily}(${t.change_pct > 0 ? '+' : ''}${t.change_pct}%)`);
      totalTasks++;
      totalScore += t.score;
      if (t.score >= 2) effective++;
    }
    lines.push('');
  }

  if (totalTasks > 0) {
    const avgScore = (totalScore / totalTasks).toFixed(1);
    const effectiveRate = ((effective / totalTasks) * 100).toFixed(0);
    lines.push('---');
    lines.push(`📈 总结: ${totalTasks}个决策 | 平均分${avgScore}/3 | 有效率${effectiveRate}%`);
  }

  return lines.join('\n');
}

async function getActiveStores() {
  try {
    const r = await query(
      `SELECT DISTINCT store FROM daily_reports WHERE date >= CURRENT_DATE - 30 AND store IS NOT NULL`
    );
    return r.rows.map(r => r.store);
  } catch {
    return [];
  }
}

/**
 * 发送每周复盘到 HQ
 */
export async function sendWeeklyReview() {
  try {
    const review = await generateWeeklyReview();
    const text = formatWeeklyReview(review);
    if (!text) {
      logger.info('weekly review: no tasks to review');
      return { ok: true, skipped: true };
    }

    const hqUsers = await query(
      `SELECT open_id, username FROM feishu_users WHERE role IN ('admin', 'hq_manager') AND registered = true AND open_id IS NOT NULL AND open_id NOT LIKE '%probe%'`
    );

    for (const user of (hqUsers.rows || [])) {
      if (!user.open_id) continue;
      try {
        await sendText(user.open_id, text);
      } catch (e) {
        logger.warn({ err: e?.message, user: user.username }, 'weekly review send failed');
      }
    }

    logger.info({ recipientCount: (hqUsers.rows || []).length }, 'weekly review sent');
    return { ok: true };
  } catch (e) {
    logger.error({ err: e?.message }, 'weekly review failed');
    return { ok: false, error: e?.message };
  }
}
