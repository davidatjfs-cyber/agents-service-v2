#!/usr/bin/env node
/**
 * 直接在 ECS 上回填：2026-03 自然周 anomaly_rollups_v2 -> 写入 agent_scores
 * - sendFeishu 默认 false：避免一次性多周刷屏
 * 用法：
 *   node scripts/backfill-march-weekly.mjs
 */
import 'dotenv/config';
import { backfillWeeklyScoresForDateRange } from '../src/services/periodic-scoring.js';

const start = '2026-03-01';
const end = '2026-03-31';

const result = await backfillWeeklyScoresForDateRange(start, end, { sendFeishu: false });
console.log('backfillWeeklyScoresForDateRange result:', JSON.stringify(result));

