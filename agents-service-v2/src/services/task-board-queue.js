import { Queue, Worker } from 'bullmq';
import { getRedisConnection } from '../utils/queue.js';
import { logger } from '../utils/logger.js';
import { parseAndDispatchTask, sendTaskReminders, summarizeTaskOnClose } from './task-orchestrator.js';

const QUEUES = {
  parse: { name: 'agent-task-parse', concurrency: 3 },
  dispatch: { name: 'agent-task-dispatch', concurrency: 5 },
  notify: { name: 'agent-task-notify', concurrency: 10 },
  review: { name: 'agent-task-review', concurrency: 3 },
  execution: { name: 'agent-task-execution', concurrency: 5 },
  reminder: { name: 'agent-task-reminder', concurrency: 5 },
  summary: { name: 'agent-task-summary', concurrency: 2 }
};

const queueRefs = {};
const workerRefs = {};

function getQueue(key) {
  if (!queueRefs[key]) {
    queueRefs[key] = new Queue(QUEUES[key].name, { connection: getRedisConnection() });
  }
  return queueRefs[key];
}

export async function enqueueTaskParse(taskId) {
  try {
    const job = await getQueue('parse').add('parse_dispatch', { taskId }, {
      jobId: `parse_dispatch-${taskId}`,
      attempts: 3,
      backoff: { type: 'exponential', delay: 10_000 },
      removeOnComplete: 500,
      removeOnFail: 1000
    });
    return { queued: true, jobId: job.id };
  } catch (e) {
    logger.warn({ err: e?.message, taskId }, 'task-board enqueue failed; running inline');
    await parseAndDispatchTask(taskId);
    return { queued: false, inline: true };
  }
}

export async function enqueueTaskNotify(taskId, payload) {
  try {
    const job = await getQueue('notify').add('send_notification', { taskId, ...payload }, {
      jobId: `notify-${taskId}-${Date.now()}`,
      attempts: 3,
      backoff: { type: 'exponential', delay: 5_000 },
      removeOnComplete: 500,
      removeOnFail: 500
    });
    return { queued: true, jobId: job.id };
  } catch (e) {
    logger.warn({ err: e?.message, taskId }, 'notify enqueue failed');
    return { queued: false, error: e?.message };
  }
}

export async function enqueueTaskExecution(taskId, payload = {}) {
  try {
    const job = await getQueue('execution').add('execute_task', { taskId, ...payload }, {
      jobId: `exec-${taskId}`,
      attempts: 3,
      backoff: { type: 'exponential', delay: 15_000 },
      removeOnComplete: 500,
      removeOnFail: 500
    });
    return { queued: true, jobId: job.id };
  } catch (e) {
    logger.warn({ err: e?.message, taskId }, 'execution enqueue failed');
    return { queued: false, error: e?.message };
  }
}

export async function enqueueTaskReminder(taskId, payload = {}) {
  try {
    const job = await getQueue('reminder').add('send_reminder', { taskId, ...payload }, {
      jobId: `reminder-${taskId}-${Date.now()}`,
      attempts: 3,
      backoff: { type: 'exponential', delay: 5_000 },
      removeOnComplete: 500,
      removeOnFail: 500
    });
    return { queued: true, jobId: job.id };
  } catch (e) {
    logger.warn({ err: e?.message, taskId }, 'reminder enqueue failed');
    return { queued: false, error: e?.message };
  }
}

export async function enqueueTaskSummary(taskId) {
  try {
    const job = await getQueue('summary').add('summarize_task', { taskId }, {
      jobId: `summary-${taskId}`,
      attempts: 2,
      backoff: { type: 'exponential', delay: 10_000 },
      removeOnComplete: 500,
      removeOnFail: 500
    });
    return { queued: true, jobId: job.id };
  } catch (e) {
    logger.warn({ err: e?.message, taskId }, 'summary enqueue failed');
    return { queued: false, error: e?.message };
  }
}

function startWorker(key, processor) {
  if (workerRefs[key]) return workerRefs[key];
  const q = QUEUES[key];
  workerRefs[key] = new Worker(q.name, processor, {
    connection: getRedisConnection(),
    concurrency: q.concurrency
  });
  workerRefs[key].on('failed', (job, err) => logger.error({ jobId: job?.id, taskId: job?.data?.taskId, err: err?.message }, `${key} job failed`));
  workerRefs[key].on('error', (err) => logger.error({ err: err?.message }, `${key} worker error`));
  return workerRefs[key];
}

export function startTaskBoardQueueWorker() {
  startWorker('parse', async (job) => {
    if (job.name !== 'parse_dispatch') throw new Error(`unknown parse job: ${job.name}`);
    return parseAndDispatchTask(job.data.taskId);
  });
  startWorker('dispatch', async (job) => {
    if (job.name !== 'dispatch_task') throw new Error(`unknown dispatch job: ${job.name}`);
    return { ok: true, taskId: job.data.taskId };
  });
  startWorker('notify', async (job) => {
    if (job.name !== 'send_notification') throw new Error(`unknown notify job: ${job.name}`);
    return { ok: true, taskId: job.data.taskId };
  });
  startWorker('execution', async (job) => {
    if (job.name !== 'execute_task') throw new Error(`unknown execution job: ${job.name}`);
    return { ok: true, taskId: job.data.taskId };
  });
  startWorker('reminder', async (job) => {
    if (job.name !== 'send_reminder') throw new Error(`unknown reminder job: ${job.name}`);
    const { taskId, agent } = job.data;
    if (typeof sendTaskReminders === 'function') {
      await sendTaskReminders(taskId, agent);
    }
    return { ok: true, taskId };
  });
  startWorker('summary', async (job) => {
    if (job.name !== 'summarize_task') throw new Error(`unknown summary job: ${job.name}`);
    if (typeof summarizeTaskOnClose === 'function') {
      await summarizeTaskOnClose(job.data.taskId);
    }
    return { ok: true, taskId: job.data.taskId };
  });
  logger.info('task-board multi-queue workers started (7 queues: parse/dispatch/notify/review/execution/reminder/summary)');
}

export async function getTaskBoardQueueStats() {
  const stats = {};
  for (const [key, q] of Object.entries(QUEUES)) {
    try {
      const queue = getQueue(key);
      const [waiting, active, delayed, failed, completed] = await Promise.all([
        queue.getWaitingCount(), queue.getActiveCount(), queue.getDelayedCount(), queue.getFailedCount(), queue.getCompletedCount()
      ]);
      stats[key] = { waiting, active, delayed, failed, completed };
    } catch {
      stats[key] = { waiting: 0, active: 0, delayed: 0, failed: 0, completed: 0 };
    }
  }
  return stats;
}