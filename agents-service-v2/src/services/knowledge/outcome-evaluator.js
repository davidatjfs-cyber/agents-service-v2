/**
 * 根据「前后数据」或指标树快照，自动判定 outcome（供闭环学习）
 */

function num(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : NaN;
}

/**
 * @param {{ beforeData?: { revenue?: number }, afterData?: { revenue?: number }, metricAnalysis?: { tree?: Array<{ level?: number, value?: unknown, is_abnormal?: boolean }> } }} p
 * @returns {{ result: 'success'|'fail'|'unknown', score: number }}
 */
export function evaluateOutcome({ beforeData, afterData, metricAnalysis } = {}) {
  const beforeRev = num(beforeData?.revenue);
  const afterRev = num(afterData?.revenue);

  if (beforeData != null && afterData != null && Number.isFinite(beforeRev) && Number.isFinite(afterRev)) {
    if (beforeRev === 0) {
      return { result: 'unknown', score: 0.5 };
    }
    const change = (afterRev - beforeRev) / beforeRev;
    if (change > 0.1) {
      return { result: 'success', score: 0.9 };
    }
    if (change < -0.05) {
      return { result: 'fail', score: 0.1 };
    }
    return { result: 'unknown', score: 0.5 };
  }

  const tree = Array.isArray(metricAnalysis?.tree) ? metricAnalysis.tree : [];
  if (tree.length) {
    const root =
      tree.find((n) => Number(n?.level) === 0) || tree[0];
    const v = num(root?.value);
    if (Number.isFinite(v)) {
      if (root?.is_abnormal === true) {
        return { result: 'fail', score: 0.28 };
      }
      if (root?.is_abnormal === false && v > 0) {
        return { result: 'success', score: 0.72 };
      }
    }
  }

  if (!beforeData && !afterData && !tree.length) {
    return { result: 'unknown', score: 0.5 };
  }

  return { result: 'unknown', score: 0.5 };
}
