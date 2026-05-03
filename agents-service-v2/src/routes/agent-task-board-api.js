import express from 'express';
import { authRequired, requireRole } from '../middleware/auth.js';
import {
  addTaskEvidence,
  addTaskComment,
  createBoardTask,
  deriveBoardTask,
  getBoardSummary,
  getBoardTask,
  listBoardTasks,
  reassignTask,
  reviewBoardTask,
  runTaskBoardWatchdog,
  setTaskQualityScore,
  claimNextTask,
  getTaskMetrics
} from '../services/task-orchestrator.js';
import { getTaskBoardQueueStats } from '../services/task-board-queue.js';
import { getAgentWorkloads } from '../services/agent-workloads.js';

const router = express.Router();
const adminOnly = [authRequired, requireRole('admin', 'hq_manager')];
const CLAIM_AGENT_OVERRIDE_ROLES = new Set(['admin', 'hq_manager']);

export function resolveClaimAgent(req) {
  const requestedAgent = String(req.body?.agent || '').trim();
  const username = String(req.user?.username || '').trim();
  const role = String(req.user?.role || '').trim();
  const canOverrideAgent = CLAIM_AGENT_OVERRIDE_ROLES.has(role);

  if (requestedAgent && requestedAgent !== username && !canOverrideAgent) {
    return { ok: false, status: 403, error: 'claim_agent_forbidden' };
  }

  const agentKey = canOverrideAgent ? (requestedAgent || username) : username;
  if (!agentKey) return { ok: false, status: 400, error: 'agent_required' };

  return { ok: true, agentKey };
}

router.post('/tasks', ...adminOnly, async (req, res) => {
  try {
    const result = await createBoardTask({
      content: req.body?.content,
      priority: req.body?.priority,
      store: req.body?.store,
      deadline: req.body?.deadline,
      createdBy: req.user?.username,
      createdByRole: req.user?.role
    });
    if (!result.ok) return res.status(400).json(result);
    res.json(result);
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message });
  }
});

router.get('/tasks', ...adminOnly, async (req, res) => {
  try {
    res.json({ ok: true, tasks: await listBoardTasks({ status: req.query.status, limit: req.query.limit }) });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message });
  }
});

router.get('/summary', ...adminOnly, async (_req, res) => {
  try {
    res.json({ ok: true, summary: await getBoardSummary() });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message });
  }
});

router.get('/tasks/:taskId', ...adminOnly, async (req, res) => {
  try {
    const task = await getBoardTask(req.params.taskId);
    if (!task) return res.status(404).json({ ok: false, error: 'not_found' });
    res.json({ ok: true, task });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message });
  }
});

router.post('/tasks/:taskId/evidences', ...adminOnly, async (req, res) => {
  try {
    const result = await addTaskEvidence(req.params.taskId, {
      evidenceType: req.body?.evidenceType,
      content: req.body?.content,
      fileUrl: req.body?.fileUrl,
      metadata: req.body?.metadata,
      submittedBy: req.user?.username,
      submittedRole: req.user?.role
    });
    if (!result.ok) return res.status(400).json(result);
    res.json(result);
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message });
  }
});

router.post('/tasks/:taskId/review', ...adminOnly, async (req, res) => {
  try {
    const result = await reviewBoardTask(req.params.taskId, {
      decision: req.body?.decision,
      comment: req.body?.comment,
      createRevisionTask: req.body?.createRevisionTask === true,
      reviewer: req.user?.username,
      reviewerRole: req.user?.role
    });
    if (!result.ok) return res.status(400).json(result);
    res.json(result);
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message });
  }
});

router.post('/tasks/:taskId/derive', ...adminOnly, async (req, res) => {
  try {
    const result = await deriveBoardTask(req.params.taskId, {
      content: req.body?.content,
      priority: req.body?.priority,
      createdBy: req.user?.username,
      createdByRole: req.user?.role
    });
    if (!result.ok) return res.status(400).json(result);
    res.json(result);
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message });
  }
});

router.post('/tasks/:taskId/reassign', ...adminOnly, async (req, res) => {
  try {
    const result = await reassignTask(req.params.taskId, {
      newAgent: req.body?.newAgent,
      reason: req.body?.reason,
      reassignedBy: req.user?.username
    });
    if (!result.ok) return res.status(400).json(result);
    res.json(result);
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message });
  }
});

router.post('/tasks/:taskId/comment', ...adminOnly, async (req, res) => {
  try {
    const result = await addTaskComment(req.params.taskId, {
      content: req.body?.content,
      commentBy: req.user?.username,
      commentRole: req.user?.role,
      commentType: req.body?.commentType || 'note'
    });
    if (!result.ok) return res.status(400).json(result);
    res.json(result);
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message });
  }
});

router.post('/tasks/:taskId/quality-score', ...adminOnly, async (req, res) => {
  try {
    const result = await setTaskQualityScore(req.params.taskId, {
      score: req.body?.score,
      scoredBy: req.user?.username
    });
    if (!result.ok) return res.status(400).json(result);
    res.json(result);
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message });
  }
});

router.post('/claim', authRequired, async (req, res) => {
  try {
    const claimAgent = resolveClaimAgent(req);
    if (!claimAgent.ok) {
      return res.status(claimAgent.status).json({ ok: false, error: claimAgent.error });
    }
    const result = await claimNextTask(claimAgent.agentKey);
    res.json(result);
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message });
  }
});

router.get('/workloads', ...adminOnly, async (_req, res) => {
  try {
    res.json({ ok: true, workloads: await getAgentWorkloads() });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message });
  }
});

router.post('/watchdog/run', ...adminOnly, async (req, res) => {
  try {
    res.json(await runTaskBoardWatchdog({ staleHours: req.body?.staleHours }));
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message });
  }
});

router.get('/queue', ...adminOnly, async (_req, res) => {
  try {
    res.json({ ok: true, stats: await getTaskBoardQueueStats() });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message });
  }
});

router.get('/metrics', ...adminOnly, async (req, res) => {
  try {
    const metrics = await getTaskMetrics({ days: parseInt(req.query.days) || 7 });
    res.json({ ok: true, metrics });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message });
  }
});

export default router;
