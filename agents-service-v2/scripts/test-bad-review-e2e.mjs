#!/usr/bin/env node
import 'dotenv/config';
import { query } from '../src/utils/db.js';
import { runAnomalyChecks } from '../src/services/anomaly-engine.js';
import { flushPendingNotifications } from '../src/services/anomaly-notify-queue.js';

console.log('=== STEP 1: Trigger ===');
const results = await runAnomalyChecks('daily', ['洪潮大宁久光店','马己仙上海音乐广场店'], { skipProactiveBridge: true });
const bad = results.filter(r => r.rule && r.rule.includes('bad_review'));
for (const r of bad) console.log(r.rule, r.store, 'triggered=' + r.triggered, r.detail, r.value ? JSON.stringify(r.value) : '');

console.log('=== STEP 2: Flush ===');
await flushPendingNotifications();
console.log('Flush done');

console.log('=== STEP 3: Verify DB ===');
const triggers = await query(
  `SELECT anomaly_key, severity, status, trigger_date FROM anomaly_triggers
   WHERE anomaly_key IN ('bad_review_product','bad_review_service') AND trigger_date = '2026-04-22'::date`
);
console.log('Triggers:', JSON.stringify(triggers.rows));

const notifs = await query(
  `SELECT rule_key, severity, status, sent_at FROM anomaly_pending_notifications
   WHERE rule_key IN ('bad_review_product','bad_review_service') AND created_at >= '2026-04-22'::date`
);
console.log('Notifications:', JSON.stringify(notifs.rows));

const scores = await query(
  `SELECT username, role, total_score, deductions FROM agent_scores
   WHERE score_model = 'anomaly_rollups_v2' AND period = 'week_2026-04-20' AND store ILIKE '%洪潮%'`
);
for (const s of scores.rows) {
  const deds = s.deductions.map(d => d.anomaly_key + ':' + d.points).join(', ');
  console.log('Score:', s.username, s.role, 'total=' + s.total_score, deds);
}

process.exit(0);