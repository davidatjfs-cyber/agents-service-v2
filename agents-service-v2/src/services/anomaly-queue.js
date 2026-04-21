/**
 * 异常链路任务队列：
 * - notify：BI异常通知延迟到 09:05 统一发送（food_safety 仍即时发送）
 *   非食安类异常 → 存入 DB 队列 anomaly_pending_notifications → 09:05 cron 逐条间隔发送
 * - collab：onAnomalyTriggered（营销协作链，立即执行）
 */
import { Queue, Worker } from 'bullmq';
import { getRedisConnection } from '../utils/queue.js';
import { logger } from '../utils/logger.js';
import { enqueueDelayedNotify } from './anomaly-notify-queue.js';
import { onAnomalyTriggered } from './agent-collaboration.js';

const QUEUE_NAME = 'anomaly-pipeline';
let queueRef = null;
let workerRef = null;

function getQueue() {
  if (!queueRef) {
    queueRef = new Queue(QUEUE_NAME, { connection: getRedisConnection() });
  }
  return queueRef;
}

/**
 * 入队通知：非食安类 → DB延迟队列（09:05统一发送），食安类 → 即时走原有BullMQ pipeline
 */
export async function enqueueNotifyJob(payload) {
  const ruleKey = payload?.ruleKey;

  // 食安类仍即时发送（紧急，不走延迟队列）
  if (ruleKey === 'food_safety') {
    const { runBiAnomalyNotifyPipeline } = await import('./anomaly-notify-pipeline.js');
    const traceId = payload?.traceId || `anomaly-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    try {
      await runBiAnomalyNotifyPipeline(payload);
      logger.info({ traceId, store: payload?.store, ruleKey }, 'food_safety notify sent immediately');
      return { queued: false, immediate: true, traceId };
    } catch (e) {
      logger.error({ err: e?.message, traceId, store: payload?.store, ruleKey }, 'food_safety immediate notify failed');
      throw e;
    }
  }

  // 非食安类 → DB延迟队列，09:05统一发送
  const result = await enqueueDelayedNotify({
    store: payload?.store,
    brand: payload?.brand,
    ruleKey,
    severity: payload?.severity,
    detail: payload?.detail,
    value: payload?.value
  });
  return { queued: true, immediate: false, delayed: !result.immediate };
}

export async function enqueueCollabJob(payload) {
  const traceId = payload?.traceId || `collab-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const data = { ...payload, traceId };
  try {
    const q = getQueue();
    const job = await q.add('collab', data, {
      attempts: 3,
      backoff: { type: 'exponential', delay: 30_000 },
      removeOnComplete: 500,
      removeOnFail: 1000
    });
    logger.info({ traceId, jobId: job.id, store: payload?.store, anomalyKey: payload?.ruleKey }, 'anomaly collab job enqueued');
    return { queued: true, traceId, jobId: job.id };
  } catch (e) {
    logger.error(
      { err: e?.message, traceId, store: payload?.store, ruleKey: payload?.ruleKey },
      'anomaly collab enqueue failed (Redis/queue); running collab inline'
    );
    await onAnomalyTriggered(data.ruleKey, data.store, data.severity, data.detail, data.value);
    return { queued: false, inline: true, traceId };
  }
}

export function startAnomalyQueueWorker() {
  if (workerRef) return workerRef;
  workerRef = new Worker(
    QUEUE_NAME,
    async (job) => {
      const traceId = job?.data?.traceId;
      if (job.name === 'collab') {
        await onAnomalyTriggered(
          job.data.ruleKey,
          job.data.store,
          job.data.severity,
          job.data.detail,
          job.data.value
        );
        logger.info({ traceId, jobId: job.id }, 'collab job completed');
        return { ok: true };
      }
      throw new Error(`unknown anomaly queue job: ${job.name}`);
    },
    { connection: getRedisConnection(), concurrency: 4 }
  );

  workerRef.on('failed', (job, err) => {
    logger.error(
      { jobId: job?.id, name: job?.name, attemptsMade: job?.attemptsMade, err: err?.message, traceId: job?.data?.traceId },
      'anomaly queue job failed'
    );
  });
  workerRef.on('error', (err) => logger.error({ err: err?.message }, 'anomaly queue worker error'));
  logger.info('anomaly queue worker started');
  return workerRef;
}

export async function getAnomalyQueueStats() {
  const q = getQueue();
  const [waiting, active, delayed, failed, completed] = await Promise.all([
    q.getWaitingCount(),
    q.getActiveCount(),
    q.getDelayedCount(),
    q.getFailedCount(),
    q.getCompletedCount()
  ]);
  return { waiting, active, delayed, failed, completed };
}