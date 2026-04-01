/**
 * 异常链路任务队列：
 * - notify：runBiAnomalyNotifyPipeline（通知+建任务+Planner）
 * - collab：onAnomalyTriggered（营销协作链）
 */
import { Queue, Worker } from 'bullmq';
import { getRedisConnection } from '../utils/queue.js';
import { logger } from '../utils/logger.js';
import { runBiAnomalyNotifyPipeline } from './anomaly-notify-pipeline.js';
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

export async function enqueueNotifyJob(payload) {
  const q = getQueue();
  const traceId = payload?.traceId || `anomaly-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const job = await q.add(
    'notify',
    { ...payload, traceId },
    {
      attempts: 3,
      backoff: { type: 'exponential', delay: 60_000 },
      removeOnComplete: 500,
      removeOnFail: 1000
    }
  );
  logger.info({ traceId, jobId: job.id, store: payload?.store, ruleKey: payload?.ruleKey }, 'anomaly notify job enqueued');
  return { queued: true, traceId, jobId: job.id };
}

export async function enqueueCollabJob(payload) {
  const q = getQueue();
  const traceId = payload?.traceId || `collab-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const job = await q.add(
    'collab',
    { ...payload, traceId },
    {
      attempts: 3,
      backoff: { type: 'exponential', delay: 30_000 },
      removeOnComplete: 500,
      removeOnFail: 1000
    }
  );
  logger.info({ traceId, jobId: job.id, store: payload?.store, anomalyKey: payload?.ruleKey }, 'anomaly collab job enqueued');
  return { queued: true, traceId, jobId: job.id };
}

export function startAnomalyQueueWorker() {
  if (workerRef) return workerRef;
  workerRef = new Worker(
    QUEUE_NAME,
    async (job) => {
      const traceId = job?.data?.traceId;
      if (job.name === 'notify') {
        await runBiAnomalyNotifyPipeline(job.data);
        logger.info({ traceId, jobId: job.id }, 'notify job completed');
        return { ok: true };
      }
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
