#!/usr/bin/env node
/**
 * 为 strategy_rules 中空 tags 的行调用 LLM 打标，并写入 tags、tags_verified=false、tags_score。
 * score < 0.6 时不写入（仅 warning），便于人工审核队列优先看低分（未写入行仍无 tags）。
 *
 * 用法：
 *   node scripts/auto-tag-strategies.mjs [--dry-run] [--limit=50]
 *
 * 环境：DATABASE_URL、ENABLE_EXTERNAL=true、LLM Key
 */
import 'dotenv/config';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import pg from 'pg';
import { generateStrategyTags } from '../src/services/strategy-tagging.js';
import { scoreTags } from '../src/services/tag-quality.js';
import { logger } from '../src/utils/logger.js';

process.env.ENABLE_EXTERNAL = process.env.ENABLE_EXTERNAL || 'true';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
dotenv.config({ path: path.join(root, '.env.production') });

const MIN_TAG_SCORE = 0.6;

const dryRun = process.argv.includes('--dry-run');
const limitArg = process.argv.find((a) => /^--limit=\d+$/i.test(a));
const limit = limitArg ? parseInt(limitArg.split('=')[1], 10) : 500;

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('[auto-tag-strategies] Missing DATABASE_URL');
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: url, max: 2 });

async function main() {
  const sel = await pool.query(
    `SELECT id, scenario, root_cause, action, tags
     FROM strategy_rules
     WHERE tags IS NULL
        OR jsonb_typeof(tags) <> 'array'
        OR jsonb_array_length(COALESCE(tags, '[]'::jsonb)) = 0
     ORDER BY id
     LIMIT $1`,
    [limit]
  );

  const rows = sel.rows || [];
  console.log(`[auto-tag-strategies] candidates: ${rows.length} (limit=${limit}, dry-run=${dryRun})`);

  let ok = 0;
  let fail = 0;
  let skippedLowScore = 0;

  for (const row of rows) {
    const action = String(row.action || '').trim();
    if (!action) {
      console.warn(`[skip] id=${row.id} empty action`);
      continue;
    }

    const tags = await generateStrategyTags(action);
    const tagJson = JSON.stringify(tags);
    const { score, issues, tag_bonus, tags_detail } = await scoreTags(tags, action);

    console.log(`id=${row.id} scenario=${row.scenario} root_cause=${row.root_cause}`);
    console.log(`  action: ${action.slice(0, 80)}${action.length > 80 ? '…' : ''}`);
    console.log(`  tags:   ${tagJson}`);
    console.log(`  score:  ${score} (tag_bonus=${tag_bonus})`);
    console.log(`  tags_detail: ${JSON.stringify(tags_detail)}`);

    if (score < MIN_TAG_SCORE) {
      skippedLowScore++;
      logger.warn(
        {
          id: row.id,
          scenario: row.scenario,
          root_cause: row.root_cause,
          score,
          issues,
          dryRun
        },
        '[auto-tag-strategies] tags_score < 0.6，跳过写入'
      );
      continue;
    }

    if (dryRun) {
      ok++;
      continue;
    }

    try {
      await pool.query(
        `UPDATE strategy_rules
         SET tags = $1::jsonb,
             tags_verified = false,
             tags_score = $3
         WHERE id = $2`,
        [tagJson, row.id, score]
      );
      ok++;
    } catch (e) {
      fail++;
      console.error(`  UPDATE failed: ${e.message}`);
    }
  }

  console.log(
    `[auto-tag-strategies] done written/dry-ok=${ok} skipped_low_score=${skippedLowScore} fail=${fail}`
  );
  await pool.end();
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('[auto-tag-strategies]', e);
  process.exit(1);
});
