import fs from 'fs';
import path from 'path';
import { normalizeAction } from './outcome-tracker.js';

const OUTDIR = () => path.join(process.cwd(), 'knowledge', 'outcomes');

function normalizeResult(r) {
  if (r === 'success' || r === 'fail' || r === 'unknown') return r;
  if (r === 'pending') return 'unknown';
  return 'unknown';
}

function problemMatches(rowProblem, filterProblem) {
  const a = String(rowProblem || '').trim();
  const b = String(filterProblem || '').trim();
  if (!b) return true;
  if (!a) return true;
  if (a.includes(b) || b.includes(a)) return true;
  const shortA = a.slice(0, 24);
  const shortB = b.slice(0, 24);
  return shortA === shortB;
}

export function getTimeWeight(ts) {
  const now = Date.now();
  const diff = now - Number(ts || 0);
  const day = 24 * 60 * 60 * 1000;
  if (diff < 3 * day) return 1.5;
  if (diff < 7 * day) return 1.2;
  return 1.0;
}

/**
 * @param {number[]} scores 按时间升序的 score 序列
 * @returns {'up'|'down'|'stable'}
 */
export function getTrend(scores) {
  const arr = (scores || []).filter((x) => typeof x === 'number' && !Number.isNaN(x));
  if (arr.length < 3) return 'stable';
  const last = arr.slice(-3);
  if (last[2] > last[1] && last[1] > last[0]) return 'up';
  if (last[2] < last[1] && last[1] < last[0]) return 'down';
  return 'stable';
}

/** 趋势参与决策：上升小幅加分、下降减分，避免「历史高分但走弱」压过「改善中」策略 */
function trendPolicyBonus(trend) {
  if (trend === 'up') return 0.08;
  if (trend === 'down') return -0.08;
  return 0;
}

/**
 * @param {{ store: string, problem?: string }} p
 * @returns {Promise<Array<{ action: string, count: number, successRate: number, avgScore: number, weightedScore: number, trend: string, policyScore: number }>>}
 */
export async function getStrategyStats({ store, problem = '' }) {
  const dir = OUTDIR();
  if (!fs.existsSync(dir)) return [];

  const storeKey = String(store || '').trim();
  const problemKey = String(problem || '').trim();

  /**
   * @type {Map<string, { rows: Array<{ ts: number, score: number, result: string }>, success: number, fail: number, unknown: number, n: number }>}
   */
  const byAction = new Map();

  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    let row;
    try {
      row = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8'));
    } catch {
      continue;
    }
    if (storeKey && String(row.store || '') !== storeKey) continue;
    if (!problemMatches(row.problem, problemKey)) continue;

    const action = normalizeAction(row.action);
    const res = normalizeResult(row.result);
    const sc = typeof row.score === 'number' && !Number.isNaN(row.score) ? clamp01(row.score) : 0;
    const ts = Number(row.ts) || Date.now();

    if (!byAction.has(action)) {
      byAction.set(action, { rows: [], success: 0, fail: 0, unknown: 0, n: 0 });
    }
    const agg = byAction.get(action);
    agg.rows.push({ ts, score: sc, result: res });
    agg.n += 1;
    if (res === 'success') agg.success += 1;
    else if (res === 'fail') agg.fail += 1;
    else agg.unknown += 1;
  }

  const out = [];
  for (const [action, agg] of byAction) {
    agg.rows.sort((a, b) => a.ts - b.ts);
    const scoreSeries = agg.rows.map((r) => r.score);

    let totalScore = 0;
    let totalWeight = 0;
    for (const row of agg.rows) {
      const w = getTimeWeight(row.ts);
      totalScore += (row.score || 0) * w;
      totalWeight += w;
    }
    const weightedScore = totalWeight
      ? Math.round((totalScore / totalWeight) * 1000) / 1000
      : 0;

    const decided = agg.success + agg.fail;
    let successRate = 0;
    if (decided > 0) {
      successRate = agg.success / decided;
    } else if (agg.n > 0) {
      successRate = agg.success / agg.n;
    }
    successRate = Math.round(successRate * 1000) / 1000;

    const avgScore =
      scoreSeries.length > 0
        ? Math.round((scoreSeries.reduce((s, x) => s + x, 0) / scoreSeries.length) * 1000) / 1000
        : 0;

    const trend = getTrend(scoreSeries);
    const rawPolicy = weightedScore + trendPolicyBonus(trend);
    const policyScore = Math.round(Math.min(1, Math.max(0, rawPolicy)) * 1000) / 1000;

    out.push({
      action,
      count: agg.n,
      successRate,
      avgScore,
      weightedScore,
      trend,
      policyScore
    });
  }

  out.sort(
    (a, b) =>
      b.policyScore - a.policyScore ||
      b.weightedScore - a.weightedScore ||
      b.avgScore - a.avgScore ||
      b.successRate - a.successRate ||
      b.count - a.count
  );

  return out;
}

function clamp01(x) {
  return Math.min(1, Math.max(0, Number(x) || 0));
}
