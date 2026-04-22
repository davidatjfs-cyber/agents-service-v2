#!/usr/bin/env node
/**
 * 补发差评异常检测 + 通知
 * 用法: node scripts/rerun-bad-review-anomaly.mjs
 */
import 'dotenv/config';
import { query } from '../src/utils/db.js';
import { runAnomalyChecks } from '../src/services/anomaly-engine.js';
import { flushPendingNotifications } from '../src/services/anomaly-notify-queue.js';
import { logger } from '../src/utils/logger.js';

async function main() {
  logger.info('=== 补发差评异常检测 ===');

  const storesR = await query(
    `SELECT DISTINCT store FROM daily_reports WHERE date >= CURRENT_DATE - 30 AND store IS NOT NULL`
  );
  const stores = (storesR.rows || []).map((x) => x.store).filter(Boolean);
  logger.info({ stores }, 'Active stores');

  const results = await runAnomalyChecks('daily', stores);

  const badReviewTriggers = results.filter(
    (r) =>
      r.rule === 'bad_review_product' || r.rule === 'bad_review_service'
  );

  for (const r of badReviewTriggers) {
    logger.info(
      { store: r.store, rule: r.rule, triggered: r.triggered, detail: r.detail, skipped: r.skipped },
      'Result'
    );
  }

  if (badReviewTriggers.some((r) => r.triggered && !r.skipped)) {
    logger.info('Triggered anomalies found, flushing pending notifications...');
    await flushPendingNotifications();
    logger.info('Notifications flushed.');
  } else {
    logger.info('No new bad review triggers. Checking if data exists...');
    for (const store of stores.filter(s => /洪潮|马己仙/.test(s))) {
      const feishuName = process.env.TEST_FEISHU_NAME || '';
      logger.info({ store, feishuName }, 'Store to feishu name check');
      const r = await query(
        `SELECT DISTINCT fields->>'差评门店' AS bad_review_store, fields->>'所属门店' AS owner_store
         FROM feishu_generic_records
         WHERE config_key = 'bad_review'
           AND (fields->>'差评门店' ILIKE $1 OR fields->>'所属门店' ILIKE $1)
         LIMIT 5`,
        [`%${store.replace(/大宁久光店|上海音乐广场店/, '').substring(0, 2)}%`]
      );
      logger.info({ store, records: r.rows }, 'Feishu bad_review records with store match');
    }
  }

  logger.info('=== 补发完成 ===');
  process.exit(0);
}

main().catch((e) => {
  logger.fatal({ err: e }, 'Script failed');
  process.exit(1);
});