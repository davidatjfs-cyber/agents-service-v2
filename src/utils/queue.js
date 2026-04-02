import { Queue, Worker } from 'bullmq';
import IORedis from 'ioredis';
import { logger } from './logger.js';

let connection = null;

export function getRedisConnection() {
  if (!connection) {
    connection = new IORedis(process.env.REDIS_URL || 'redis://localhost:6379', {
      maxRetriesPerRequest: null,
      enableReadyCheck: false
    });
    connection.on('error', (err) => {
      logger.error({ err }, 'Redis connection error');
    });
  }
  return connection;
}

// Message processing queue (feishu webhooks)
export function createMessageQueue() {
  return new Queue('agent-messages', { connection: getRedisConnection() });
}

// Anomaly detection queue
export function createAnomalyQueue() {
  return new Queue('anomaly-checks', { connection: getRedisConnection() });
}

// Rhythm tick queue (daily standup, patrol, end-of-day)
export function createRhythmQueue() {
  return new Queue('rhythm-ticks', { connection: getRedisConnection() });
}

export function createWorker(queueName, processor, opts = {}) {
  const worker = new Worker(queueName, processor, {
    connection: getRedisConnection(),
    concurrency: opts.concurrency || 3,
    ...opts
  });
  worker.on('completed', (job) => {
    logger.info({ jobId: job.id, queue: queueName }, 'Job completed');
  });
  worker.on('failed', (job, err) => {
    logger.error({ jobId: job?.id, queue: queueName, err: err?.message }, 'Job failed');
  });
  return worker;
}

export async function checkRedisHealth() {
  try {
    const r = getRedisConnection();
    const pong = await r.ping();
    return pong === 'PONG';
  } catch (e) {
    return false;
  }
}
