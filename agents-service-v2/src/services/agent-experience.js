/**
 * 与 agent_memory 独立：按场景沉淀高评分行动，供提示词可选引用。
 */
import { query } from '../utils/db.js';
import { logger } from '../utils/logger.js';

/**
 * @param {string} scenario 如 revenue_drop、ops_quality
 * @returns {Promise<{ action: string|null, score: number|null, root_cause: string|null }|null>}
 */
export async function getBestStrategy(scenario) {
  const s = String(scenario || '').trim();
  if (!s) return null;
  try {
    const r = await query(
      `SELECT action, score, root_cause
       FROM agent_experience
       WHERE scenario = $1 AND score IS NOT NULL
       ORDER BY score DESC NULLS LAST, created_at DESC
       LIMIT 1`,
      [s]
    );
    const row = r.rows?.[0];
    if (!row) return null;
    return {
      action: row.action ? String(row.action) : null,
      score: row.score != null ? Number(row.score) : null,
      root_cause: row.root_cause ? String(row.root_cause) : null
    };
  } catch (e) {
    logger.warn({ err: e?.message, scenario: s }, 'getBestStrategy failed');
    return null;
  }
}

export function formatExperiencePromptBlock(scenario, best) {
  try {
    if (!best?.action) return '';
    const sc = String(scenario || '').trim();
    const scoreText = best.score != null && !Number.isNaN(best.score) ? String(best.score) : '—';
    return `\n【经验参考】场景「${sc}」历史高评分方案（score=${scoreText}）：${best.action}。若与当前数据一致可优先参考。\n`;
  } catch {
    return '';
  }
}

/**
 * 写入经验（saveOutcome 内可选调用）
 * @param {string[]|null|undefined} tags 策略标签，可选；旧调用不传则 tags 为 NULL
 */
export async function recordAgentExperience(scenario, rootCause, action, score, tags = null) {
  const s = String(scenario || '').trim();
  if (!s) return;
  try {
    const tagsJson =
      Array.isArray(tags) && tags.length > 0 ? JSON.stringify(tags) : null;
    await query(
      `INSERT INTO agent_experience (scenario, root_cause, action, score, tags)
       VALUES ($1, $2, $3, $4, $5::jsonb)`,
      [
        s,
        rootCause != null ? String(rootCause).slice(0, 2000) : null,
        action != null ? String(action).slice(0, 2000) : null,
        Number(score) || 0,
        tagsJson
      ]
    );
  } catch (e) {
    logger.warn({ err: e?.message }, 'recordAgentExperience failed');
  }
}
