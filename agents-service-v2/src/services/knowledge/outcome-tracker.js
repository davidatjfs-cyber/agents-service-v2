import fs from 'fs';
import path from 'path';

function safeFilePart(s) {
  return String(s || 'unknown')
    .replace(/[/\\?%*:|"<>]/g, '_')
    .replace(/\s+/g, '_')
    .slice(0, 80);
}

function clampScore(score) {
  return Math.max(0, Math.min(1, Number(score) || 0));
}

/** 策略动作归一化，避免同义重复统计 */
export function normalizeAction(action = '') {
  const t = String(action || '').trim();
  if (!t) return '(未记录策略)';
  if (/炉位|加人|人手|备货/.test(t)) return '提升产能';
  if (/服务|态度/.test(t)) return '优化服务';
  if (/流程|效率/.test(t)) return '优化流程';
  return t;
}

/**
 * @param {object} p
 * @param {string} p.store
 * @param {string} [p.problem]
 * @param {string} [p.action]
 * @param {'success'|'fail'|'unknown'} [p.result='unknown']
 * @param {number} [p.score=0] 0~1
 */
export async function recordOutcome({
  store,
  problem,
  action,
  result = 'unknown',
  score = 0
}) {
  const dir = path.join(process.cwd(), 'knowledge', 'outcomes');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const file = `${safeFilePart(store)}_${Date.now()}.json`;

  const r = result === 'success' || result === 'fail' || result === 'unknown' ? result : 'unknown';
  const normalizedAction = normalizeAction(action);

  const data = {
    store,
    problem: problem || '',
    action: normalizedAction,
    result: r,
    score: clampScore(score),
    ts: Date.now()
  };

  fs.writeFileSync(path.join(dir, file), JSON.stringify(data, null, 2), 'utf-8');

  console.log('[OUTCOME WRITE]', file);
}
