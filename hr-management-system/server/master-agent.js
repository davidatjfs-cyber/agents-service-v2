/**
 * Master Agent — Event-Driven Orchestration Hub
 *
 * Architecture: 事件驱动（Event-Driven）+ 异步编排（Asynchronous Orchestration）
 * Master = 中转站，发送和接收信号；维护"任务状态表"，Agent 监听状态变化。
 *
 * 6 Agents:
 *   Master       (调度中枢)   — 消息路由、任务状态流转、全局上下文管理
 *   Data Auditor (数据审计)   — BI  — 核对来源数据，对异常情况触发预警
 *   Ops Agent    (营运督导)   — OP  — 飞书任务分派、到点提醒、Vision审核照片
 *   Train Agent  (培训与标准) — Train — RAG知识检索、SOP咨询、培训体系管理
 *   Chief Evaluator (绩效考核) — OKR — 自动计算奖金、评分、评级
 *   Appeal Agent (申诉处理)   — REF — 处理员工反馈，核实证据，人工介入仲裁
 *
 * 协作流程:
 *   1. 报警: Data Auditor 发现异常 → master_tasks(pending_dispatch)
 *   2. 执行: Master 调度 → Ops Agent 在飞书找责任人
 *   3. 反馈: 责任人在飞书回复文字/照片
 *   4. 判定: Ops Agent 审核反馈
 *   5. 结算: Chief Evaluator 计算绩效影响
 *   6. 推送: Master 发送最终通知
 *
 * Status Flow:
 *   pending_audit → auditing → pending_dispatch → dispatched →
 *   pending_response → pending_review → resolved/rejected →
 *   pending_settlement → settled → closed
 */

import { AGENT_ISSUE_TYPES } from './agent-communication-system.js';
import {
  sendLarkMessage,
  sendLarkCard,
  lookupFeishuUserByUsername,
  getSharedState,
  getStoresFromState,
  inferBrandFromStoreName,
  findStoreManager,
  callLLM,
  callVisionLLM,
  queryKnowledgeBase,
  prefixWithAgentName,
  runDataAuditor,
  writeTaskToBitable,
  getTaskResponseFormUrl,
  buildTaskDispatchCard,
  pollTaskResponseBitable
} from './agents.js';
import { AgentCommunicationSystem } from './agent-communication-system.js';
import { pool as masterPool, setPool as setUnifiedMasterPool } from './utils/database.js';
import { extractAnomalyRelations, refreshEntityHealthSnapshots, ensureKnowledgeGraphTables, setKGPool } from './knowledge-graph.js';
import { registerHqPlannerRoutes, setHqPlannerPool, setHqPlannerLLM } from './hq-planner-agent.js';
import {
  setAutoOpsPool, setAutoOpsDeps,
  inspectionClosedLoopTick, biProactivePushTick,
  laborEfficiencyTick, trainingClosedLoopTick
} from './auto-ops-engine.js';
import { safeExecute, safeErrorLog } from './utils/error-handler.js';

function normalizeStoreKey(v) {
  return String(v || '').trim().toLowerCase().replace(/\s+/g, '');
}

// ─────────────────────────────────────────────
// 0. Pool & Config
// ─────────────────────────────────────────────

let _pool = null;
export function setMasterPool(p) { 
  _pool = p; 
  setUnifiedMasterPool(p); // 同时设置统一数据库连接
  setKGPool(p);            // 知识图谱
  setHqPlannerPool(p);     // HQ决策大脑
  setHqPlannerLLM(callLLM); // 注入LLM调用能力
  setAutoOpsPool(p);       // 自动化营运引擎
  setAutoOpsDeps({
    sendLarkMessage,
    sendLarkCard,
    lookupFeishuUserByUsername,
    findStoreManager,
    callLLM,
    prefixWithAgentName,
    inferBrandFromStoreName
  });
}
export function pool() { 
  if (!_pool) throw new Error('master-agent: pool not set'); 
  return _pool; 
}

// 责任人角色映射已移至 agent-config-manager.js 动态读取
import { getCategoryAssigneeRoleMap } from './agent-config-manager.js';

// 状态机定义
const STATUS_FLOW = {
  pending_audit:      { next: ['auditing', 'pending_dispatch'],           agent: 'data_auditor' },
  auditing:           { next: ['pending_dispatch', 'closed'], agent: 'data_auditor' },
  pending_dispatch:   { next: ['dispatched'],         agent: 'master' },
  dispatched:         { next: ['pending_response'],   agent: 'ops_supervisor' },
  pending_response:   { next: ['pending_review'],     agent: 'master' },
  pending_review:     { next: ['resolved', 'rejected'], agent: 'ops_supervisor' },
  resolved:           { next: ['pending_settlement'], agent: 'master' },
  rejected:           { next: ['pending_dispatch'],   agent: 'master' },
  pending_settlement: { next: ['settled'],            agent: 'chief_evaluator' },
  settled:            { next: ['closed'],             agent: 'master' },
  closed:             { next: [],                     agent: null },
  
  // 新增：Agent沟通状态
  agent_issue_reported: { next: ['pending_review'], agent: 'master' },
  issue_assigned:      { next: ['optimization_proposed'], agent: 'data_auditor' },
  optimization_proposed: { next: ['optimization_approved', 'optimization_rejected'], agent: 'master' },
  optimization_approved: { next: ['optimization_implemented'], agent: 'data_auditor' },
  optimization_implemented: { next: ['completed'], agent: 'master' },
  optimization_completed: { next: ['closed'], agent: 'master' }
};

// ─────────────────────────────────────────────
// 1. Table Creation
// ─────────────────────────────────────────────

export async function ensureMasterTables() {
  const client = await pool().connect();
  try {
    await client.query('BEGIN');

    // 核心任务表：每一条异常/工单的全生命周期
    await client.query(`
      CREATE TABLE IF NOT EXISTS master_tasks (
        id SERIAL PRIMARY KEY,
        task_id TEXT UNIQUE NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending_audit',
        source TEXT DEFAULT 'scheduled_audit',
        source_ref TEXT,
        current_agent TEXT,
        category TEXT,
        severity TEXT DEFAULT 'medium',
        store TEXT,
        brand TEXT,
        assignee_username TEXT,
        assignee_role TEXT,
        title TEXT,
        detail TEXT,
        source_data JSONB DEFAULT '{}'::jsonb,
        audit_result JSONB DEFAULT '{}'::jsonb,
        dispatch_data JSONB DEFAULT '{}'::jsonb,
        response_text TEXT,
        response_images JSONB DEFAULT '[]'::jsonb,
        review_result JSONB DEFAULT '{}'::jsonb,
        settlement_data JSONB DEFAULT '{}'::jsonb,
        score_impact NUMERIC(5,1) DEFAULT 0,
        feishu_msg_ids JSONB DEFAULT '[]'::jsonb,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        dispatched_at TIMESTAMPTZ,
        responded_at TIMESTAMPTZ,
        resolved_at TIMESTAMPTZ,
        settled_at TIMESTAMPTZ,
        closed_at TIMESTAMPTZ
      )
    `);

    // 事件日志表：所有状态流转的审计轨迹
    await client.query(`
      CREATE TABLE IF NOT EXISTS master_events (
        id SERIAL PRIMARY KEY,
        task_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        from_agent TEXT,
        to_agent TEXT,
        status_before TEXT,
        status_after TEXT,
        payload JSONB DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query(`CREATE INDEX IF NOT EXISTS idx_master_tasks_status ON master_tasks (status)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_master_tasks_store ON master_tasks (store, status)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_master_tasks_assignee ON master_tasks (assignee_username, status)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_master_tasks_task_id ON master_tasks (task_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_master_events_task ON master_events (task_id, created_at)`);

    // SOP案例分析表
    await client.query(`
      CREATE TABLE IF NOT EXISTS sop_cases (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        case_id TEXT UNIQUE NOT NULL,
        status TEXT NOT NULL DEFAULT 'draft',  -- draft/pending_confirm/confirmed/published
        source_review_id UUID,                 -- 关联的差评记录
        store TEXT NOT NULL,
        brand TEXT,
        event_detail TEXT NOT NULL,            -- 事件详细过程
        analysis TEXT,                         -- SOP分析内容
        improvement_actions TEXT,              -- 改进措施
        created_by TEXT,                       -- 创建者（Train Agent）
        confirmed_by TEXT,                     -- 确认者（店长）
        confirmed_at TIMESTAMPTZ,
        published_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_sop_cases_store ON sop_cases (store)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_sop_cases_status ON sop_cases (status)`);

    // 培训任务跟踪表
    await client.query(`
      CREATE TABLE IF NOT EXISTS training_tasks (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        task_id TEXT UNIQUE NOT NULL,
        type TEXT NOT NULL,                    -- onboarding/skill_upgrade/management/culture
        title TEXT NOT NULL,                   -- 培训标题
        target_role TEXT NOT NULL,             -- 目标岗位 (e.g., store_manager, cashier)
        assignee_username TEXT NOT NULL,       -- 参训人员
        store TEXT NOT NULL,
        brand TEXT,
        status TEXT NOT NULL DEFAULT 'pending',-- pending/in_progress/completed/failed
        progress_data JSONB DEFAULT '{}',      -- 培训进度、考试成绩、反馈等
        due_date DATE,                         -- 截止日期
        completed_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_training_tasks_assignee ON training_tasks (assignee_username, status)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_training_tasks_role ON training_tasks (target_role)`);

    // Agent自主任务日志表
    await client.query(`
      CREATE TABLE IF NOT EXISTS agent_autonomous_logs (
        id SERIAL PRIMARY KEY,
        task_id TEXT NOT NULL,
        status TEXT NOT NULL,
        result JSONB,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_autonomous_logs_task ON agent_autonomous_logs (task_id, created_at)`);

    // Agent协作会话归档表
    await client.query(`
      CREATE TABLE IF NOT EXISTS agent_collaboration_archives (
        id SERIAL PRIMARY KEY,
        session_id TEXT UNIQUE NOT NULL,
        topic TEXT NOT NULL,
        initiator TEXT NOT NULL,
        participants JSONB NOT NULL,
        messages JSONB DEFAULT '[]',
        summary TEXT,
        created_at TIMESTAMPTZ,
        ended_at TIMESTAMPTZ
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_collaboration_session ON agent_collaboration_archives (session_id, created_at)`);

    // 回归检查结果表
    await client.query(`
      CREATE TABLE IF NOT EXISTS regression_check_results (
        id SERIAL PRIMARY KEY,
        check_data JSONB NOT NULL,
        passed BOOLEAN NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_regression_check_time ON regression_check_results (created_at)`);

    // 自动化测试结果表
    await client.query(`
      CREATE TABLE IF NOT EXISTS automated_test_results (
        id SERIAL PRIMARY KEY,
        test_data JSONB NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_automated_test_time ON automated_test_results (created_at)`);

    // Agent任务日志表（用于性能监控）
    await client.query(`
      CREATE TABLE IF NOT EXISTS agent_task_logs (
        id SERIAL PRIMARY KEY,
        agent_id TEXT NOT NULL,
        task_type TEXT NOT NULL,
        status TEXT NOT NULL,
        execution_time_ms INTEGER,
        error_message TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_agent_task_logs_agent ON agent_task_logs (agent_id, created_at)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_agent_task_logs_type ON agent_task_logs (task_type, status)`);

    // 数据质量日志表
    await client.query(`
      CREATE TABLE IF NOT EXISTS data_quality_logs (
        id SERIAL PRIMARY KEY,
        data_source TEXT NOT NULL,
        record_count INTEGER DEFAULT 0,
        data_quality_score NUMERIC(3,2) DEFAULT 1.0,
        issues JSONB DEFAULT '[]',
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_data_quality_source ON data_quality_logs (data_source, created_at)`);

    await client.query('COMMIT');
    console.log('[master] Tables ensured (including autonomous, regression, LLM monitoring)');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    if (String(e?.code || '') === '23505') return;
    console.error('[master] ensureMasterTables failed:', e?.message);
  } finally {
    client.release();
  }
  // 知识图谱 & 行动计划表
  try { await ensureKnowledgeGraphTables(); } catch (e) { console.error('[master] ensureKGTables failed:', e?.message); }
}

// ─────────────────────────────────────────────
// 2. Event System
// ─────────────────────────────────────────────

let _taskSeq = 0;

function generateTaskId() {
  const now = new Date();
  const ds = now.toISOString().slice(0, 10).replace(/-/g, '');
  _taskSeq++;
  return `MT-${ds}-${String(_taskSeq).padStart(4, '0')}`;
}

// 记录事件日志
async function emitEvent(taskId, eventType, fromAgent, toAgent, statusBefore, statusAfter, payload = {}) {
  try {
    await pool().query(
      `INSERT INTO master_events (task_id, event_type, from_agent, to_agent, status_before, status_after, payload)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
      [taskId, eventType, fromAgent, toAgent, statusBefore, statusAfter, JSON.stringify(payload)]
    );
  } catch (e) {
    console.error('[master] emitEvent failed:', e?.message);
  }
}

// 状态转换：验证合法性 + 更新任务 + 记录事件
async function transitionTask(taskId, newStatus, agentName, data = {}) {
  try {
    const r = await pool().query(`SELECT * FROM master_tasks WHERE task_id = $1`, [taskId]);
    const task = r.rows?.[0];
    if (!task) { console.error('[master] task not found:', taskId); return null; }

    const currentStatus = task.status;
    const flow = STATUS_FLOW[currentStatus];
    if (!flow || !flow.next.includes(newStatus)) {
      console.error(`[master] invalid transition: ${currentStatus} → ${newStatus} for task ${taskId}`);
      return null;
    }

    // 动态构建 UPDATE 语句
    const sets = ['status = $2', 'current_agent = $3', 'updated_at = NOW()'];
    const params = [taskId, newStatus, agentName];
    let idx = 4;

    if (data.audit_result)    { sets.push(`audit_result = $${idx}::jsonb`);    params.push(JSON.stringify(data.audit_result)); idx++; }
    if (data.dispatch_data)   { sets.push(`dispatch_data = $${idx}::jsonb`);   params.push(JSON.stringify(data.dispatch_data)); idx++; }
    if (data.response_text !== undefined) { sets.push(`response_text = $${idx}`); params.push(data.response_text); idx++; }
    if (data.response_images) { sets.push(`response_images = $${idx}::jsonb`); params.push(JSON.stringify(data.response_images)); idx++; }
    if (data.review_result)   { sets.push(`review_result = $${idx}::jsonb`);   params.push(JSON.stringify(data.review_result)); idx++; }
    if (data.settlement_data) { sets.push(`settlement_data = $${idx}::jsonb`); params.push(JSON.stringify(data.settlement_data)); idx++; }
    if (data.score_impact !== undefined) { sets.push(`score_impact = $${idx}`); params.push(data.score_impact); idx++; }
    if (data.assignee_username) { sets.push(`assignee_username = $${idx}`); params.push(data.assignee_username); idx++; }
    if (data.assignee_role)   { sets.push(`assignee_role = $${idx}`);     params.push(data.assignee_role); idx++; }
    if (data.title)           { sets.push(`title = $${idx}`);             params.push(data.title); idx++; }
    if (data.detail)          { sets.push(`detail = $${idx}`);            params.push(data.detail); idx++; }
    if (data.severity)        { sets.push(`severity = $${idx}`);          params.push(data.severity); idx++; }
    if (data.feishu_msg_id)   { sets.push(`feishu_msg_ids = feishu_msg_ids || $${idx}::jsonb`); params.push(JSON.stringify([data.feishu_msg_id])); idx++; }

    // 时间戳
    if (newStatus === 'dispatched')   sets.push(`dispatched_at = NOW()`);
    if (newStatus === 'pending_review') sets.push(`responded_at = NOW()`);
    if (newStatus === 'resolved' || newStatus === 'rejected') sets.push(`resolved_at = NOW()`);
    if (newStatus === 'settled')      sets.push(`settled_at = NOW()`);
    if (newStatus === 'closed')       sets.push(`closed_at = NOW()`);

    await pool().query(`UPDATE master_tasks SET ${sets.join(', ')} WHERE task_id = $1`, params);

    // 记录事件
    await emitEvent(taskId, `status_${newStatus}`, agentName, STATUS_FLOW[newStatus]?.agent || null, currentStatus, newStatus, data);

    console.log(`[master] ${taskId}: ${currentStatus} → ${newStatus} (by ${agentName})`);
    return { ...task, status: newStatus };
  } catch (e) {
    console.error('[master] transitionTask failed:', e?.message);
    return null;
  }
}

// ─────────────────────────────────────────────
// 3. Task Creation
// ─────────────────────────────────────────────

// 创建新任务（由 Data Auditor 发现异常时调用）
async function createTask({ source, sourceRef, category, severity, store, brand, title, detail, sourceData }) {
  const taskId = generateTaskId();
  try {
    await pool().query(
      `INSERT INTO master_tasks (task_id, status, source, source_ref, current_agent, category, severity, store, brand, title, detail, source_data)
       VALUES ($1, 'pending_dispatch', $2, $3, 'master', $4, $5, $6, $7, $8, $9, $10::jsonb)`,
      [taskId, source || 'scheduled_audit', sourceRef || '', category, severity || 'medium',
       store, brand, title, detail, JSON.stringify(sourceData || {})]
    );
    await emitEvent(taskId, 'task_created', 'data_auditor', 'master', null, 'pending_dispatch', { category, severity, store });
    // 知识图谱: 写入异常→门店关系
    try { await extractAnomalyRelations({ task_id: taskId, category, severity, store, brand, title, detail, created_at: new Date() }); } catch (e) {}
    console.log(`[master] Task created: ${taskId} [${category}] ${store}`);
    return taskId;
  } catch (e) {
    console.error('[master] createTask failed:', e?.message);
    return null;
  }
}

// ─────────────────────────────────────────────
// 4. Responsibility Resolver
// ─────────────────────────────────────────────

// 根据异常类型和门店找到责任人
async function resolveAssignee(category, store, existingAssignee) {
  const state = await getSharedState();
  const normalizedStore = normalizeStoreKey(store);
  
  const all = [
    ...(Array.isArray(state?.employees) ? state.employees : []),
    ...(Array.isArray(state?.users) ? state.users : [])
  ];

  // 如果有指定责任人，验证其是否属于目标门店
  if (existingAssignee) {
    const user = all.find(u => String(u?.username || '').trim() === String(existingAssignee).trim());
    
    // 验证门店匹配
    if (user && normalizeStoreKey(user.store) === normalizedStore) {
      return { 
        username: String(user.username || '').trim(),
        name: String(user.name || '').trim(),
        role: String(user.role || '').trim(),
        store 
      };
    } else if (user) {
      console.warn(`[resolveAssignee] ⚠️ 跨门店分派告警: 用户 ${existingAssignee}(${user.name}) 属于 ${user.store}，不属于目标门店 ${store}。自动重新匹配...`);
      // 继续按门店自动匹配
    } else {
      console.warn(`[resolveAssignee] ⚠️ 用户 ${existingAssignee} 不存在，自动重新匹配...`);
    }
  }

  const roleMap = await getCategoryAssigneeRoleMap();
  const targetRole = roleMap[category] || 'store_manager';
  const storeMembers = all.filter(u => normalizeStoreKey(u?.store) === normalizedStore);

  // 先按目标角色找
  let assignee = storeMembers.find(u => String(u?.role || '').trim() === targetRole);

  // 降级顺序: store_production_manager → store_manager → 任何门店成员
  if (!assignee && targetRole === 'store_production_manager') {
    assignee = storeMembers.find(u => String(u?.role || '').trim() === 'store_manager');
  }
  if (!assignee && targetRole === 'store_manager') {
    assignee = storeMembers.find(u => String(u?.role || '').trim() === 'store_production_manager');
  }
  if (!assignee) {
    assignee = storeMembers.find(u => ['store_manager', 'store_production_manager'].includes(String(u?.role || '').trim()));
  }

  if (!assignee) {
    console.error(`[resolveAssignee] ❌ 未找到门店 ${store} 的责任人（目标角色: ${targetRole}）`);
    return null;
  }
  
  console.log(`[resolveAssignee] ✅ 已匹配责任人: ${assignee.name}(${assignee.username}) - ${assignee.role} @ ${store}`);
  return {
    username: String(assignee.username || '').trim(),
    name: String(assignee.name || '').trim(),
    role: String(assignee.role || '').trim(),
    store
  };
}

// ─────────────────────────────────────────────
// 5. Agent Listeners - 扩展支持Agent沟通
// ─────────────────────────────────────────────

// ── 5a. Data Auditor Listener ──
// 扫描 pending_audit 任务 → 执行审计 → 创建异常任务
async function dataAuditorListener() {
  try {
    // Data Auditor 主动扫描：运行审计引擎，将发现的异常直接创建为 master_tasks
    const result = await runDataAuditor();
    if (!result.newIssueIds?.length) return 0;

    // 将 agent_issues 中的新异常同步到 master_tasks
    let created = 0;
    for (const issueId of result.newIssueIds) {
      try {
        const ir = await pool().query(
          `SELECT * FROM agent_issues WHERE id = $1 LIMIT 1`,
          [String(issueId)]
        );
        const issue = ir.rows?.[0];
        if (!issue) continue;

        // 检查去重：同一个 agent_issues.id 是否已在 master_tasks
        const dup = await pool().query(
          `SELECT id FROM master_tasks WHERE source_ref = $1 AND source = 'data_auditor' LIMIT 1`,
          [String(issueId)]
        );
        if (dup.rows?.length) continue;

        const taskId = await createTask({
          source: 'data_auditor',
          sourceRef: String(issueId),
          category: issue.category,
          severity: issue.severity,
          store: issue.store,
          brand: issue.brand,
          title: issue.title,
          detail: issue.detail,
          sourceData: issue.data
        });
        created++;
      } catch (e) {
        console.error('[master:data_auditor] Failed to sync issue to master_tasks:', e?.message);
      }
    }
    if (created > 0) console.log(`[master:data_auditor] Created ${created} new tasks`);
    return created;
  } catch (e) {
    console.error('[master:data_auditor] listener error:', e?.message);
    return 0;
  }
}

// ── 5b. Master Agent Issues Listener ──
// 处理Agent报告的问题
async function masterIssuesListener() {
  try {
    // 扫描 agent_issues_reports 表中的新问题
    const r = await pool().query(
      `SELECT * FROM agent_issues_reports WHERE status = 'pending' ORDER BY created_at ASC LIMIT 10`
    );
    
    for (const issue of r.rows) {
      // 分配给责任Agent
      const responsibleAgent = getResponsibleAgent(issue.issue_type);
      await AgentCommunicationSystem.assignIssue(
        issue.issue_id,
        responsibleAgent,
        'normal',
        null
      );
    }
    
    console.log(`[master:issues] Processed ${r.rows.length} agent issues`);
    return r.rows.length;
  } catch (e) {
    console.error('[master:issues] listener error:', e?.message);
    return 0;
  }
}

// ── 5c. Master Optimization Coordinator ──
// 协调Agent优化方案
async function masterOptimizationCoordinator() {
  try {
    // 扫描待审核的优化方案
    const r = await pool().query(
      `SELECT * FROM agent_issues_reports WHERE status = 'optimization_proposed' ORDER BY created_at ASC LIMIT 5`
    );
    
    for (const issue of r.rows) {
      // 自动审核低优先级方案
      if (issue.priority === 'low' && !issue.requires_manual_review) {
        await AgentCommunicationSystem.approveOptimization(
          issue.issue_id,
          'master',
          '自动批准低优先级方案'
        );
      }
    }
    
    console.log(`[master:optimization] Processed ${r.rows.length} optimization proposals`);
    return r.rows.length;
  } catch (e) {
    console.error('[master:optimization] coordinator error:', e?.message);
    return 0;
  }
}

// 获取责任Agent
function getResponsibleAgent(issueType) {
  const issueConfig = AGENT_ISSUE_TYPES[issueType];
  return issueConfig?.responsibleAgent || 'master';
}

// ── 5b. Master Dispatcher ──
// 扫描 pending_dispatch 任务 → 解析责任人 → 分派给 Ops
async function masterDispatcher() {
  try {
    const r = await pool().query(
      `SELECT * FROM master_tasks WHERE status = 'pending_dispatch' ORDER BY created_at ASC LIMIT 10`
    );
    if (!r.rows?.length) return 0;

    let dispatched = 0;
    for (const task of r.rows) {
      // 解析责任人 (优先使用已有的 assignee_username)
      const assignee = await resolveAssignee(task.category, task.store, task.assignee_username);
      if (!assignee) {
        console.warn(`[master] No assignee found for ${task.task_id} (${task.category}, ${task.store})`);
        continue;
      }

      // 转换到 dispatched，让 Ops 接管
      const updated = await transitionTask(task.task_id, 'dispatched', 'master', {
        assignee_username: assignee.username,
        assignee_role: assignee.role,
        dispatch_data: { assignee, dispatchedBy: 'master', reason: task.category }
      });
      if (updated) dispatched++;
    }
    return dispatched;
  } catch (e) {
    console.error('[master] dispatcher error:', e?.message);
    return 0;
  }
}

// ── 5c. Ops Agent Listener ──
// 1) 扫描 dispatched 任务 → 在飞书通知责任人
// 2) 扫描 pending_review 任务 → 审核反馈
const _bitableWrittenTaskIds = new Set();
const _dispatchRetryCount = new Map(); // task_id → retry count

async function opsAgentListener() {
  let actions = 0;

  // ── Part 1: 发送飞书通知 ──
  try {
    const r = await pool().query(
      `SELECT * FROM master_tasks WHERE status = 'dispatched' ORDER BY created_at ASC LIMIT 10`
    );
    for (const task of (r.rows || [])) {
      // Write task to Bitable only once (prevent duplicate writes every cycle)
      if (!_bitableWrittenTaskIds.has(task.task_id)) {
        const bitableRecord = await writeTaskToBitable(task);
        if (bitableRecord?.record_id) {
          try {
            await pool().query(
              `UPDATE master_tasks
               SET source_data = COALESCE(source_data, '{}'::jsonb) || $1::jsonb,
                   updated_at = NOW()
               WHERE task_id = $2`,
              [JSON.stringify({ task_response_record_id: bitableRecord.record_id }), task.task_id]
            );
          } catch (e) {
            console.error('[master:ops] persist task_response_record_id failed:', e?.message);
          }
        }
        _bitableWrittenTaskIds.add(task.task_id);
      }

      if (!task.assignee_username) continue;

      const fu = await lookupFeishuUserByUsername(task.assignee_username);
      if (!fu?.open_id) {
        const retries = (_dispatchRetryCount.get(task.task_id) || 0) + 1;
        _dispatchRetryCount.set(task.task_id, retries);
        if (retries <= 1) {
          console.warn(`[master:ops] No Feishu user for ${task.assignee_username} (task ${task.task_id}), will auto-transition after 3 retries`);
        }
        // After 3 retries, force transition to pending_response so the task doesn't loop forever
        if (retries >= 3) {
          console.warn(`[master:ops] Forcing ${task.task_id} to pending_response (no Feishu user after ${retries} retries)`);
          await transitionTask(task.task_id, 'pending_response', 'ops_supervisor', {
            note: `Auto-transitioned: no Feishu user found for ${task.assignee_username}`
          });
          _dispatchRetryCount.delete(task.task_id);
          actions++;
        }
        continue;
      }

      // Build form URL with pre-filled task details
      const formUrl = getTaskResponseFormUrl(task);

      // 判断是否首次派发 (vs 驳回后重新派发)
      let isFirstDispatch = true;
      try {
        const evR = await pool().query(
          `SELECT COUNT(*) as cnt FROM master_events WHERE task_id = $1 AND event_type = 'status_change' AND status_after = 'dispatched'`,
          [task.task_id]
        );
        isFirstDispatch = (parseInt(evR.rows[0]?.cnt || '0') === 0);
      } catch (e) {}

      let sendResult;
      // 直接发送交互卡片（不再使用表单链接）
      const card = buildTaskDispatchCard(task, formUrl, { isFirstDispatch });
      sendResult = await sendLarkCard(fu.open_id, card);

      if (sendResult?.ok) {
        // 调试日志：记录飞书返回的完整结构
        console.log('[master:ops] sendLarkCard result:', JSON.stringify(sendResult.data));
        const msgId = sendResult.data?.data?.message_id || sendResult.data?.message_id || '';
        console.log('[master:ops] extracted message_id:', msgId);
        await transitionTask(task.task_id, 'pending_response', 'ops_supervisor', {
          feishu_msg_id: msgId
        });

        // 记录 outbound 消息
        try {
          await pool().query(
            `INSERT INTO agent_messages (direction, channel, feishu_open_id, sender_username, sender_name, routed_to, content_type, content)
             VALUES ('out','feishu',$1,'system','Master Agent','ops_supervisor','card',$2)`,
            [fu.open_id, `异常通知卡片 [${task.task_id}] - 回复表单已发送`]
          );
        } catch (e) {}
        actions++;
      }
    }
  } catch (e) {
    console.error('[master:ops] dispatch notify error:', e?.message);
  }

  // ── Part 2: 审核反馈 ──
  try {
    const r = await pool().query(
      `SELECT * FROM master_tasks WHERE status = 'pending_review' ORDER BY responded_at ASC LIMIT 5`
    );
    for (const task of (r.rows || [])) {
      const responseText = task.response_text || '';
      const responseImages = Array.isArray(task.response_images) ? task.response_images : [];

      if (!responseText && !responseImages.length) continue;

      // 构建审核 prompt
      let reviewDecision = 'resolved';
      let reviewNotes = '';

      // 图片审核（如有图片）
      let imageReviewOk = true;
      if (responseImages.length) {
        for (const imgUrl of responseImages) {
          const vr = await callVisionLLM(imgUrl,
            `你是小年，年年有喜餐饮集团AI助理，正在审核员工提交的整改照片。
任务：${task.title || '整改'}
要求：判断照片是否为真实有效的整改证据。
判断标准：1)照片内容与任务相关 2)能看到实际整改结果 3)非模糊/黑屏/无关图片
请回复JSON：{"valid":true/false,"reason":"具体判断理由，说明照片中看到了什么"}`
          );
          try {
            const parsed = JSON.parse(vr.content.replace(/```json?\n?/g, '').replace(/```/g, '').trim());
            if (!parsed.valid) { imageReviewOk = false; reviewNotes += `图片不合格: ${parsed.reason}; `; }
          } catch (e) {
            // LLM 返回非 JSON，尝试文本解析
            if (vr.content?.includes('不合格') || vr.content?.includes('无效') || vr.content?.includes('false')) {
              imageReviewOk = false;
              reviewNotes += `图片审核: ${vr.content?.slice(0, 100)}; `;
            }
          }
        }
      }

      // 文字审核
      let textReviewOk = true;
      if (responseText) {
        // 查询SOP知识库获取判罚依据
        let sopContext = '';
        try {
          const sopResults = await queryKnowledgeBase(['sop', '整改', '标准'], task.category || '', 2);
          if (sopResults.length) {
            sopContext = '\n\n参考SOP标准：\n' + sopResults.map(r => `【${r.title}】${String(r.content || '').slice(0, 200)}`).join('\n');
          }
        } catch (e) {}

        const llm = await callLLM([
          { role: 'system', content: `你是小年，年年有喜餐饮集团AI助理。请审核员工对异常问题的回复，仅判断回复是否包含了有效的事实描述和整改措施。

审核标准：
1. 回复是否包含对问题的具体调查结果（不能只说"不知道"或"好的"等无实质内容的回复）
2. 回复是否包含具体的整改措施或解决方案
3. 如有照片，是否与问题相关

重要规则：
- 你只负责判断回复是否有效，不要自己编造任何具体的调查建议或产品操作建议
- 不要在reason或suggestion中提及具体产品名称、原料名称、制作流程等你无法确认的信息
- suggestion只能是通用的格式要求，如"请提供具体的调查结果和整改措施"

异常问题：${task.title}
问题详情：${task.detail || ''}${sopContext}

请回复JSON：{"valid":true/false,"reason":"判断理由（不要编造具体建议）","suggestion":"通用改进要求（如有）"}` },
          { role: 'user', content: `员工回复：${responseText}` }
        ], { skipCache: true, temperature: 0.05 });

        try {
          const parsed = JSON.parse(llm.content.replace(/```json?\n?/g, '').replace(/```/g, '').trim());
          if (!parsed.valid) { textReviewOk = false; reviewNotes += `回复不足: ${parsed.reason}; `; }
          if (parsed.suggestion) reviewNotes += `建议: ${parsed.suggestion}; `;
        } catch (e) {
          if (llm.content?.includes('无效') || llm.content?.includes('不够') || llm.content?.includes('false')) {
            textReviewOk = false;
            reviewNotes += `文字审核: ${llm.content?.slice(0, 100)}; `;
          }
        }
      }

      // 最终判定
      reviewDecision = (imageReviewOk && textReviewOk) ? 'resolved' : 'rejected';

      const result = await transitionTask(task.task_id, reviewDecision, 'ops_supervisor', {
        review_result: {
          decision: reviewDecision,
          imageReviewOk,
          textReviewOk,
          notes: reviewNotes.trim(),
          reviewedAt: new Date().toISOString()
        }
      });

      if (result) {
        // 通知责任人审核结果（专业格式，含判断依据）
        if (task.assignee_username) {
          const fu = await lookupFeishuUserByUsername(task.assignee_username);
          if (fu?.open_id) {
            const lines = [];
            if (reviewDecision === 'resolved') {
              lines.push(`📋 任务审核结果\n`);
              lines.push(`任务编号：${task.task_id}`);
              lines.push(`审核结论：✅ 通过`);
              if (responseImages.length) lines.push(`照片审核：合格（${responseImages.length}张）`);
              if (responseText) lines.push(`文字回复：已确认有效`);
              lines.push(`\n${reviewNotes || '整改措施已确认，感谢配合。'}`);
            } else {
              lines.push(`📋 任务审核结果\n`);
              lines.push(`任务编号：${task.task_id}`);
              lines.push(`审核结论：❌ 未通过`);
              lines.push(`\n未通过原因：`);
              if (!imageReviewOk) lines.push(`· 照片不符合要求`);
              if (!textReviewOk) lines.push(`· 文字回复不满足整改标准`);
              if (reviewNotes) lines.push(`\n详细说明：${reviewNotes}`);
              lines.push(`\n请根据以上反馈重新提交整改结果。`);
            }
            await sendLarkMessage(fu.open_id, prefixWithAgentName('ops_supervisor', lines.join('\n')));
          }
        }
        actions++;
      }
    }
  } catch (e) {
    console.error('[master:ops] review error:', e?.message);
  }

  return actions;
}

// ── 5d. Master Post-Resolution Handler ──
// 扫描 resolved 任务 → 推给 Chief Evaluator 结算
async function masterPostResolution() {
  try {
    const r = await pool().query(
      `SELECT * FROM master_tasks WHERE status = 'resolved' ORDER BY resolved_at ASC LIMIT 10`
    );
    if (!r.rows?.length) return 0;

    let count = 0;
    for (const task of r.rows) {
      const updated = await transitionTask(task.task_id, 'pending_settlement', 'master', {});
      if (updated) count++;
    }
    return count;
  } catch (e) {
    console.error('[master] post-resolution error:', e?.message);
    return 0;
  }
}

// ── 5e. Master Handle Rejected ──
// 扫描 rejected 任务 → 重新分派
async function masterHandleRejected() {
  try {
    const r = await pool().query(
      `SELECT * FROM master_tasks WHERE status = 'rejected' ORDER BY resolved_at ASC LIMIT 10`
    );
    if (!r.rows?.length) return 0;

    let count = 0;
    for (const task of r.rows) {
      // 重新分派
      const updated = await transitionTask(task.task_id, 'pending_dispatch', 'master', {});
      if (updated) count++;
    }
    return count;
  } catch (e) {
    console.error('[master] handle-rejected error:', e?.message);
    return 0;
  }
}

// ── 5f. Chief Evaluator Listener ──
// 扫描 pending_settlement 任务 → 仅做结算归档（不再执行旧OP周积分扣分与培训触发）→ settled
async function chiefEvaluatorListener() {
  try {
    const r = await pool().query(
      `SELECT * FROM master_tasks WHERE status = 'pending_settlement' ORDER BY resolved_at ASC LIMIT 10`
    );
    if (!r.rows?.length) return 0;

    let count = 0;
    for (const task of r.rows) {
      const responseHours = (task.dispatched_at && task.responded_at)
        ? ((new Date(task.responded_at) - new Date(task.dispatched_at)) / 3600000)
        : null;

      const updated = await transitionTask(task.task_id, 'settled', 'chief_evaluator', {
        settlement_data: {
          scoreImpact: 0,
          reason: '旧OP周绩效扣分体系已停用；该任务仅完成闭环归档，不做积分扣减。',
          category: task.category,
          severity: task.severity,
          responseTime: responseHours == null ? 'N/A' : `${responseHours.toFixed(1)}h`,
          settledAt: new Date().toISOString()
        },
        score_impact: 0
      });

      if (updated) {
        count++;
      }
    }
    return count;
  } catch (e) {
    console.error('[master:evaluator] settlement error:', e?.message);
    return 0;
  }
}

// ── 5g. Train Agent Listener ──
// 处理详细差评→SOP案例分析流程 & 自动备课流程
async function trainAgentListener() {
  let actions = 0;

  try {
    // 1. 处理待备课的培训需求 (draft_need -> pending_approval)
    const draftNeeds = await pool().query(
      `SELECT * FROM training_tasks WHERE status = 'draft_need' ORDER BY created_at ASC LIMIT 5`
    );

    for (const task of (draftNeeds.rows || [])) {
      // Train Agent 自动备课：搜索知识库
      let trainingOutline = `培训主题：${task.title}\n培训目标：改善近期绩效扣分项，提升标准执行力\n\n`;
      let kbResults = [];
      try {
        const queryTerm = task.title.replace('专项提升：', '').replace('改善', '');
        kbResults = await queryKnowledgeBase(['sop', '标准', queryTerm], queryTerm, 3, { brandTag: task.brand });
        if (kbResults.length > 0) {
          trainingOutline += `【推荐学习资料】\n` + kbResults.map((r, i) => `${i+1}. 《${r.title}》`).join('\n');
        } else {
          trainingOutline += `【需补充资料】未在知识库中找到关于"${queryTerm}"的详细资料，请管理员补充。`;
        }
      } catch (e) {
        console.error('[master:train] auto-preparation failed:', e?.message);
      }

      // 组装进度数据，包括备课大纲
      const progressData = {
        ...(task.progress_data || {}),
        outline: trainingOutline,
        prepared_at: new Date().toISOString()
      };

      // 更新任务状态为 pending_approval，等待管理员审批/补充
      await pool().query(
        `UPDATE training_tasks SET status = 'pending_approval', progress_data = $1::jsonb, updated_at = NOW() WHERE id = $2`,
        [JSON.stringify(progressData), task.id]
      );

      // 通知 HR 管理员审核培训大纲
      const hrAdminUsername = 'admin'; // 默认通知admin，可扩展为查找具体的HR管理员
      const fu = await lookupFeishuUserByUsername(hrAdminUsername);
      if (fu?.open_id) {
        const msg = prefixWithAgentName('train_advisor',
          `📝 自动培训备课需审核 [${task.task_id}]\n\n` +
          `由于 ${task.assignee_username} 近期绩效扣分触发阈值，我已为其生成专属培训计划：\n` +
          `课程：${task.title}\n\n` +
          `【备课大纲】\n${trainingOutline}\n\n` +
          `请确认该计划是否合理，是否需要补充外部资料。确认后请回复“审核通过，准许下发”，我将推送给员工。`
        );
        await sendLarkMessage(fu.open_id, msg);
      }
      actions++;
      console.log(`[master:train] Auto-prepared training ${task.task_id} for ${task.assignee_username}`);
    }

    // 2. 检测有详细事件过程的差评
    const detailedReviews = await pool().query(
      `SELECT * FROM bad_reviews 
       WHERE has_detailed_event = TRUE AND sop_case_id IS NULL AND status = 'open'
       ORDER BY created_at ASC LIMIT 5`
    );

    for (const review of (detailedReviews.rows || [])) {
      // 2. 创建SOP案例分析草稿
      const caseId = `SOP-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      const r = await pool().query(
        `INSERT INTO sop_cases (case_id, source_review_id, store, brand, event_detail, status, created_by)
         VALUES ($1, $2, $3, $4, $5, 'draft', 'train_agent')
         RETURNING id`,
        [caseId, review.id, review.store, review.brand, review.event_detail || review.content]
      );
      const sopCaseId = r.rows?.[0]?.id;

      if (sopCaseId) {
        // 3. 标记差评为processing
        await pool().query(
          `UPDATE bad_reviews SET status = 'processing', sop_case_id = $1 WHERE id = $2`,
          [sopCaseId, review.id]
        );

        // 4. 通知店长了解详细过程（通过飞书）
        const assignee = await resolveAssignee(
          review.review_type === 'product' ? '产品差评异常' : '服务差评异常',
          review.store
        );
        if (assignee?.username) {
          const fu = await lookupFeishuUserByUsername(assignee.username);
          if (fu?.open_id) {
            const msg = prefixWithAgentName('train_advisor',
              `📚 SOP案例分析请求 [${caseId}]\n\n` +
              `门店：${review.store}\n` +
              `类型：${review.review_type === 'product' ? '产品差评' : '服务差评'}\n\n` +
              `事件详情：\n${review.event_detail || review.content}\n\n` +
              `请回复您了解到的具体事件详细过程，以及改进建议。`
            );
            await sendLarkMessage(fu.open_id, msg);
          }
        }
        actions++;
        console.log(`[master:sop] Created SOP case ${caseId} for review ${review.id}`);
      }
    }

    // 5. 处理待确认的案例分析
    const pendingCases = await pool().query(
      `SELECT * FROM sop_cases WHERE status = 'pending_confirm' ORDER BY created_at ASC LIMIT 5`
    );

    for (const sopCase of (pendingCases.rows || [])) {
      // 通知店长确认
      const assignee = await resolveAssignee('产品差评异常', sopCase.store);
      if (assignee?.username) {
        const fu = await lookupFeishuUserByUsername(assignee.username);
        if (fu?.open_id) {
          const msg = prefixWithAgentName('train_advisor',
            `✅ SOP案例分析待确认 [${sopCase.case_id}]\n\n` +
            `门店：${sopCase.store}\n\n` +
            `分析内容：\n${sopCase.analysis || ''}\n\n` +
            `改进措施：\n${sopCase.improvement_actions || ''}\n\n` +
            `请确认是否可以执行。回复"确认"通过，或回复修改意见。`
          );
          await sendLarkMessage(fu.open_id, msg);
        }
      }
      actions++;
    }

    // 6. 处理已确认的案例分析 → 发布培训
    const confirmedCases = await pool().query(
      `SELECT * FROM sop_cases WHERE status = 'confirmed' ORDER BY confirmed_at ASC LIMIT 5`
    );

    for (const sopCase of (confirmedCases.rows || [])) {
      // 发布到事件门店的店长和总部营运
      // TODO: 需要获取总部营运的飞书账号
      await pool().query(
        `UPDATE sop_cases SET status = 'published', published_at = NOW() WHERE id = $1`,
        [sopCase.id]
      );

      // 更新知识库
      try {
        const state = await getSharedState();
        if (state?.knowledgeBase) {
          // 添加到SOP库
          const entry = {
            id: sopCase.case_id,
            type: 'case_study',
            store: sopCase.store,
            brand: sopCase.brand,
            title: `案例分析：${sopCase.store}`,
            content: sopCase.analysis,
            actions: sopCase.improvement_actions,
            createdAt: new Date().toISOString()
          };
          // 这里可以调用queryKnowledgeBase的写入接口
          console.log(`[master:sop] Case ${sopCase.case_id} published to SOP library`);
        }
      } catch (e) {}

      actions++;
    }

  } catch (e) {
    console.error('[master:sop] listener error:', e?.message);
  }

  return actions;
}

// ── 5g. Master Final Notification ──
// 扫描 settled 任务 → 发送最终通知 → closed
async function masterFinalNotification() {
  try {
    const r = await pool().query(
      `SELECT * FROM master_tasks WHERE status = 'settled' ORDER BY settled_at ASC LIMIT 10`
    );
    if (!r.rows?.length) return 0;

    let count = 0;
    for (const task of r.rows) {
      if (task.assignee_username) {
        const fu = await lookupFeishuUserByUsername(task.assignee_username);
        if (fu?.open_id) {
          const msgText = `📋 任务完成通知 [${task.task_id}]\n\n✅ ${task.title}\n\n该任务已完成闭环并归档。\n（旧OP周绩效积分已停用，本任务不做周积分扣减）\n\n感谢配合处理！`;
          await sendLarkMessage(fu.open_id, prefixWithAgentName('master', msgText));
        }
      }

      await transitionTask(task.task_id, 'closed', 'master', {});
      count++;
    }
    return count;
  } catch (e) {
    console.error('[master] final notification error:', e?.message);
    return 0;
  }
}

// ─────────────────────────────────────────────
// 6. Feishu Response Handler
// ─────────────────────────────────────────────

// 当用户在飞书回复消息时，检查是否有待回复的任务
export async function handleTaskResponse(username, text, imageUrls, parentMessageId = null) {
  try {
    let task = null;
    
    // 优先通过 parentMessageId 精确匹配任务
    if (parentMessageId) {
      const r = await pool().query(
        `SELECT * FROM master_tasks
         WHERE assignee_username = $1 AND status = 'pending_response'
         AND feishu_msg_ids ? $2
         ORDER BY dispatched_at ASC LIMIT 1`,
        [username, parentMessageId]
      );
      task = r.rows?.[0];
      console.log(`[master] Task lookup by parent_message_id: ${parentMessageId}, found: ${task?.task_id || 'none'}`);
    }
    
    // 降级1：通过 parentMessageId 查找但忽略 feishu_msg_ids 检查（处理空数组情况）
    if (!task && parentMessageId) {
      const r = await pool().query(
        `SELECT * FROM master_tasks
         WHERE assignee_username = $1 AND status = 'pending_response'
         ORDER BY dispatched_at DESC LIMIT 1`,
        [username]
      );
      task = r.rows?.[0];
      console.log(`[master] Task lookup fallback (has parent_id): found: ${task?.task_id || 'none'}`);
    }
    
    // 降级2：无 parentMessageId 时，只处理明确的回复关键词
    if (!task && !parentMessageId) {
      const hasReplyKeyword = /(已处理|已完成|已整改|已解决|处理完|整改完毕|情况说明|原因如下|马上处理|正在处理|立即处理)/.test(String(text || '').trim());
      if (hasReplyKeyword || imageUrls.length > 0) {
        const r = await pool().query(
          `SELECT * FROM master_tasks
           WHERE assignee_username = $1 AND status = 'pending_response'
           ORDER BY dispatched_at DESC LIMIT 1`,
          [username]
        );
        task = r.rows?.[0];
        console.log(`[master] Task lookup by keyword/image: found: ${task?.task_id || 'none'}`);
      }
    }
    
    if (!task) return null; // 不是任务回复，走正常agent路由

    // 记录反馈并推进状态
    const updated = await transitionTask(task.task_id, 'pending_review', 'master', {
      response_text: text || '',
      response_images: Array.isArray(imageUrls) ? imageUrls : [],
      parent_message_id: parentMessageId // 记录关联关系
    });

    if (updated) {
      console.log(`[master] Task ${task.task_id} response received from ${username} via reply`);
      return {
        handled: true,
        taskId: task.task_id,
        response: `✅ 已收到您对任务 [${task.task_id}] 的回复，正在审核中...\n\n📋 任务：${task.title}\n💬 您的回复：${String(text || '').slice(0, 100)}${text.length > 100 ? '...' : ''}\n📸 附件照片：${imageUrls.length}张\n\n请等待审核结果通知。`
      };
    }
    return null;
  } catch (e) {
    console.error('[master] handleTaskResponse error:', e?.message);
    return null;
  }
}

// ── 5h. Train Task Dispatcher ──
// 主动推送培训任务给相关岗位的员工
async function trainTaskDispatcher() {
  let dispatched = 0;
  try {
    const pendingTasks = await pool().query(
      `SELECT * FROM training_tasks WHERE status = 'pending' ORDER BY created_at ASC LIMIT 10`
    );
    for (const task of (pendingTasks.rows || [])) {
      const fu = await lookupFeishuUserByUsername(task.assignee_username);
      if (fu?.open_id) {
        const typeLabel = {
          onboarding: '入职培训',
          skill_upgrade: '技能提升',
          management: '管理培训',
          culture: '企业文化'
        }[task.type] || task.type;
        
        const dueDateStr = task.due_date ? new Date(task.due_date).toLocaleDateString() : '无';
        const msg = prefixWithAgentName('train_advisor',
          `🎯 培训任务下发 [${task.task_id}]\n\n` +
          `课程标题：${task.title}\n` +
          `培训类型：${typeLabel}\n` +
          `要求岗位：${task.target_role}\n` +
          `截止日期：${dueDateStr}\n\n` +
          `请及时学习相关资料。学习完成后，可直接回复我“开始考核”或随时向我提问关于本课程的疑惑。`
        );
        await sendLarkMessage(fu.open_id, msg);
      }
      // 标记为进行中
      await pool().query(`UPDATE training_tasks SET status = 'in_progress', updated_at = NOW() WHERE id = $1`, [task.id]);
      dispatched++;
      console.log(`[master:train] Dispatched training task ${task.task_id} to ${task.assignee_username}`);
    }
  } catch (e) {
    console.error('[master:train] task dispatcher error:', e?.message);
  }
  return dispatched;
}

// ─────────────────────────────────────────────
// 7. Weekly Score Calculator
// ─────────────────────────────────────────────

async function calculateWeeklyScore(username) {
  try {
    // 基础分 100，减去本周所有任务的绩效影响
    const r = await pool().query(
      `SELECT COALESCE(SUM(score_impact), 0) as total_impact
       FROM master_tasks
       WHERE assignee_username = $1
         AND status IN ('settled', 'closed')
         AND created_at > NOW() - INTERVAL '7 days'`,
      [username]
    );
    const totalImpact = Number(r.rows?.[0]?.total_impact || 0);
    return Math.max(0, Math.min(100, 100 + totalImpact));
  } catch (e) {
    return 100;
  }
}

// ─────────────────────────────────────────────
// 8. Master Orchestration Loop
// ─────────────────────────────────────────────

let _masterStarted = false;

export function startMasterAgent() {
  if (_masterStarted) return;
  _masterStarted = true;
  console.log('[master] Starting event-driven orchestration...');

  // 初始化任务序号
  (async () => {
    try {
      const r = await pool().query(`SELECT MAX(id) as maxid FROM master_tasks`);
      _taskSeq = Number(r.rows?.[0]?.maxid || 0);
    } catch (e) {}
  })();

  // ── Tick 1: Data Auditor (每30分钟扫描一次) ──
  const auditTick = async () => {
    try {
      const created = await dataAuditorListener();
      if (created > 0) console.log(`[master:tick] Data Auditor created ${created} tasks`);
      
      // 新增：处理手动创建的 pending_audit 任务（如营销活动）
      const manualTasks = await pool().query(
        `SELECT * FROM master_tasks 
         WHERE status = 'pending_audit' 
         AND source IN ('manual_campaign', 'manual', 'hq_planning')
         ORDER BY created_at ASC LIMIT 5`
      );
      
      for (const task of (manualTasks.rows || [])) {
        // 自动推进到 pending_dispatch 状态
        await transitionTask(task.task_id, 'pending_dispatch', 'data_auditor', {
          audit_result: {
            approved: true,
            reason: '手动创建任务自动通过审计',
            timestamp: new Date().toISOString()
          }
        });
        console.log(`[master:audit] Auto-approved manual task ${task.task_id}`);
      }
    } catch (e) {
      console.error('[master:tick] audit error:', e?.message);
    }
  };

  // ── Tick 2: Master Dispatcher (每15秒扫描一次) ──
  const dispatchTick = async () => {
    try {
      // 新增：动态调整任务优先级（超时任务自动升级）
      await pool().query(`
        UPDATE master_tasks 
        SET severity = CASE 
          WHEN severity = 'low' THEN 'medium'
          WHEN severity = 'medium' THEN 'high'
          ELSE severity
        END,
        escalation_level = escalation_level + 1,
        escalation_history = COALESCE(escalation_history, '[]'::jsonb) || 
          jsonb_build_object(
            'timestamp', NOW()::text,
            'from', severity,
            'to', CASE WHEN severity = 'low' THEN 'medium' WHEN severity = 'medium' THEN 'high' ELSE severity END,
            'reason', '任务超时自动升级'
          )::jsonb
        WHERE status IN ('pending_dispatch', 'dispatched', 'pending_response')
        AND timeout_at IS NOT NULL 
        AND timeout_at < NOW()
        AND escalation_level < 3
      `);
      
      const d = await masterDispatcher();
      if (d > 0) console.log(`[master:tick] Dispatched ${d} tasks`);
    } catch (e) {
      console.error('[master:tick] dispatch error:', e?.message);
    }
  };

  // ── Tick 3: Ops Agent (每20秒扫描一次) ──
  const opsTick = async () => {
    try {
      const a = await opsAgentListener();
      if (a > 0) console.log(`[master:tick] Ops processed ${a} tasks`);
    } catch (e) {
      console.error('[master:tick] ops error:', e?.message);
    }
  };

  // ── Tick 4: Master Post-Resolution + Rejected (每20秒) ──
  const postResTick = async () => {
    try {
      const resolved = await masterPostResolution();
      const rejected = await masterHandleRejected();
      if (resolved > 0) console.log(`[master:tick] Post-resolution: ${resolved}`);
      if (rejected > 0) console.log(`[master:tick] Re-dispatched rejected: ${rejected}`);
    } catch (e) {
      console.error('[master:tick] post-res error:', e?.message);
    }
  };

  // ── Tick 5: Chief Evaluator (每30秒) ──
  const evalTick = async () => {
    try {
      const s = await chiefEvaluatorListener();
      if (s > 0) console.log(`[master:tick] Evaluator settled ${s} tasks`);
    } catch (e) {
      console.error('[master:tick] eval error:', e?.message);
    }
  };

  // ── Tick 6: Master Final Notification (每30秒) ──
  const finalTick = async () => {
    try {
      const c = await masterFinalNotification();
      if (c > 0) console.log(`[master:tick] Closed ${c} tasks`);
    } catch (e) {
      console.error('[master:tick] final error:', e?.message);
    }
  };

  // ── Tick 7: Train Agent (每60秒扫描详细差评) ──
  const trainTick = async () => {
    try {
      const a = await trainAgentListener();
      if (a > 0) console.log(`[master:tick] Train processed ${a} cases`);
    } catch (e) { console.error('trainTick:', e); }
  };

  // ── Tick 8: 部门问题/知识库纠错分配 (每30秒) ──
  const issuesTick = async () => {
    try {
      const i = await masterIssuesListener();
      if (i > 0) console.log(`[master:tick] Issues coordinator processed ${i} issues`);
    } catch (e) {
      console.error('[master:tick] issues error:', e?.message);
    }
  };

  // ── Tick 9: Master Optimization Coordinator (每60秒) ──
  const optimizationTick = async () => {
    try {
      const o = await masterOptimizationCoordinator();
      if (o > 0) console.log(`[master:tick] Optimization coordinator processed ${o} proposals`);
    } catch (e) {
      console.error('[master:tick] optimization error:', e?.message);
    }
  };

  // ── Tick 10: Train Task Dispatcher (每10分钟) ──
  const trainDispatchTick = async () => {
    try {
      const d = await trainTaskDispatcher();
      if (d > 0) console.log(`[master:tick] Train task dispatcher sent ${d} tasks`);
    } catch (e) {
      console.error('[master:tick] train dispatch error:', e?.message);
    }
  };

  // ── Tick 11: Task Response Bitable Polling (每60秒) ──
  const taskResponseTick = async () => {
    try {
      await pollTaskResponseBitable();
    } catch (e) {
      console.error('[master:tick] task response poll error:', e?.message);
    }
  };

  // ── Tick 12: Knowledge Graph Health Snapshot (每6小时刷新) ──
  const kgHealthTick = async () => {
    try {
      const updated = await refreshEntityHealthSnapshots();
      if (updated > 0) console.log(`[master:tick] KG health snapshots refreshed for ${updated} stores`);
    } catch (e) {
      console.error('[master:tick] KG health error:', e?.message);
    }
  };

  // ── Tick 13: 巡检闭环自动化 (每15分钟: 催办 + 升级) ──
  const inspectionLoopTick = async () => {
    try {
      const a = await inspectionClosedLoopTick();
      if (a > 0) console.log(`[master:tick] Inspection closed loop: ${a} actions`);
    } catch (e) {
      console.error('[master:tick] inspection loop error:', e?.message);
    }
  };

  // ── Tick 14: BI主动推送 (每15分钟检查, 仅CST 10:00执行) ──
  const biPushTick = async () => {
    try {
      const p = await biProactivePushTick();
      if (p > 0) console.log(`[master:tick] BI proactive push: ${p} alerts`);
    } catch (e) {
      console.error('[master:tick] BI push error:', e?.message);
    }
  };

  // ── Tick 15: 排班人效建议 (每15分钟检查, 仅周一CST 09:00执行) ──
  const laborTick = async () => {
    try {
      const p = await laborEfficiencyTick();
      if (p > 0) console.log(`[master:tick] Labor efficiency: ${p} suggestions`);
    } catch (e) {
      console.error('[master:tick] labor efficiency error:', e?.message);
    }
  };

  // ── Tick 16: 培训闭环 (每15分钟检查, 仅CST 11:00执行) ──
  const trainingLoopTick = async () => {
    try {
      const c = await trainingClosedLoopTick();
      if (c > 0) console.log(`[master:tick] Training closed loop: ${c} tasks created`);
    } catch (e) {
      console.error('[master:tick] training loop error:', e?.message);
    }
  };

  // 启动定时器
  setInterval(auditTick, 15 * 1000);        // 15s (优化：从30min改为15s，快速处理手动创建的任务)
  setInterval(dispatchTick, 15 * 1000);     // 15s
  setInterval(opsTick, 20 * 1000);          // 20s
  setInterval(postResTick, 20 * 1000);      // 20s
  setInterval(evalTick, 30 * 1000);         // 30s
  setInterval(finalTick, 30 * 1000);        // 30s
  setInterval(trainTick, 60 * 1000);        // 60s
  setInterval(issuesTick, 30 * 1000);       // 30s
  setInterval(trainDispatchTick, 10 * 60 * 1000); // 10min
  setInterval(optimizationTick, 60 * 1000);   // 60s
  setInterval(taskResponseTick, 60 * 1000);  // 60s
  setInterval(kgHealthTick, 6 * 60 * 60 * 1000); // 6h
  setInterval(inspectionLoopTick, 15 * 60 * 1000); // 15min
  setInterval(biPushTick, 15 * 60 * 1000);         // 15min (内部仅CST 10:00执行)
  setInterval(laborTick, 15 * 60 * 1000);           // 15min (内部仅周一CST 09:00执行)
  setInterval(trainingLoopTick, 15 * 60 * 1000);    // 15min (内部仅CST 11:00执行)

  // 首次启动延迟执行
  setTimeout(auditTick, 10 * 1000);
  setTimeout(dispatchTick, 15 * 1000);
  setTimeout(opsTick, 20 * 1000);
  setTimeout(postResTick, 25 * 1000);
  setTimeout(evalTick, 30 * 1000);
  setTimeout(finalTick, 35 * 1000);
  setTimeout(trainTick, 40 * 1000);
  setTimeout(issuesTick, 45 * 1000);
  setTimeout(trainDispatchTick, 50 * 1000);
  setTimeout(optimizationTick, 55 * 1000);
  setTimeout(taskResponseTick, 60 * 1000);
  setTimeout(kgHealthTick, 90 * 1000);      // 启动后90秒首次刷新
  setTimeout(inspectionLoopTick, 120 * 1000); // 启动后2分钟首次巡检闭环
  setTimeout(biPushTick, 150 * 1000);         // 启动后2.5分钟检查BI推送
  setTimeout(laborTick, 180 * 1000);          // 启动后3分钟检查排班建议
  setTimeout(trainingLoopTick, 210 * 1000);   // 启动后3.5分钟检查培训闭环

  console.log('[master] All agent listeners started (including KG health tick + auto-ops engine)');
}

// ─────────────────────────────────────────────
// 9. API Routes
// ─────────────────────────────────────────────

export function registerMasterRoutes(app, authRequired) {

  const _exportCsv = (rows = [], columns = []) => {
    const esc = (v) => {
      const s = v == null ? '' : String(v);
      if (!/[",\n]/.test(s)) return s;
      return `"${s.replace(/"/g, '""')}"`;
    };
    const header = columns.join(',');
    const body = rows.map((r) => columns.map((c) => esc(r?.[c])).join(',')).join('\n');
    return `${header}\n${body}`;
  };

  // ── Master Dashboard ──
  app.get('/api/master/dashboard', authRequired, async (req, res) => {
    const role = String(req.user?.role || '').trim();
    if (!['admin', 'hq_manager', 'hr_manager'].includes(role)) return res.status(403).json({ error: 'forbidden' });
    try {
      const [tasksR, eventsR] = await Promise.all([
        pool().query(`
          SELECT status, COUNT(*) as cnt, 
                 COUNT(*) FILTER (WHERE severity='high') as high_cnt
          FROM master_tasks 
          WHERE created_at > NOW() - INTERVAL '30 days'
          GROUP BY status ORDER BY status
        `),
        pool().query(`SELECT COUNT(*) as total FROM master_events WHERE created_at > NOW() - INTERVAL '7 days'`)
      ]);

      const statusCounts = {};
      for (const row of (tasksR.rows || [])) {
        statusCounts[row.status] = { total: Number(row.cnt), high: Number(row.high_cnt) };
      }

      return res.json({
        tasks: statusCounts,
        events_7d: Number(eventsR.rows?.[0]?.total || 0),
        stateMachine: STATUS_FLOW
      });
    } catch (e) {
      return res.status(500).json({ error: String(e?.message || e) });
    }
  });

  // ── Task List ──
  app.get('/api/master/tasks', authRequired, async (req, res) => {
    const role = String(req.user?.role || '').trim();
    const username = String(req.user?.username || '').trim();
    const status = String(req.query?.status || '').trim();
    const limit = Math.max(1, Math.min(200, Number(req.query?.limit) || 50));
    try {
      let where = ['1=1'], params = [];
      const push = v => { params.push(v); return `$${params.length}`; };

      if (['store_manager', 'store_production_manager'].includes(role)) {
        where.push(`assignee_username = ${push(username)}`);
      }
      if (status && status !== 'all') where.push(`status = ${push(status)}`);

      const r = await pool().query(
        `SELECT * FROM master_tasks WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT ${push(limit)}`,
        params
      );
      return res.json({ items: r.rows || [] });
    } catch (e) { return res.status(500).json({ error: String(e?.message || e) }); }
  });

  // ── Data Source Health Snapshot ──
  app.get('/api/master/data-source-health', authRequired, async (req, res) => {
    const role = String(req.user?.role || '').trim();
    if (!['admin', 'hq_manager', 'hr_manager'].includes(role)) return res.status(403).json({ error: 'forbidden' });
    const hours = Math.max(1, Math.min(24 * 30, Number(req.query?.hours) || 24));
    const tables = ['daily_reports', 'sales_raw', 'table_visit_records', 'master_tasks'];
    try {
      const tableCounts = [];
      for (const table of tables) {
        const r = await pool().query(
          `SELECT COUNT(*)::int AS cnt, MAX(created_at) AS latest
             FROM ${table}
            WHERE created_at >= NOW() - ($1::text || ' hours')::interval`,
          [String(hours)]
        );
        tableCounts.push({
          table,
          rows: Number(r.rows?.[0]?.cnt || 0),
          latest: r.rows?.[0]?.latest || null,
          ok: Number(r.rows?.[0]?.cnt || 0) > 0
        });
      }

      const issueR = await pool().query(
        `SELECT
           COALESCE(details::jsonb->>'dataSourceType', 'unknown') AS data_source,
           COALESCE(context->>'store', '') AS store,
           COUNT(*)::int AS issue_count,
           MAX(created_at) AS latest
         FROM agent_issues_reports
         WHERE issue_type = 'DATA_SOURCE_INSUFFICIENT'
           AND created_at >= NOW() - ($1::text || ' hours')::interval
         GROUP BY COALESCE(details::jsonb->>'dataSourceType', 'unknown'), COALESCE(context->>'store', '')
         ORDER BY issue_count DESC, data_source ASC, store ASC
         LIMIT 200`,
        [String(hours)]
      );

      return res.json({
        windowHours: hours,
        generatedAt: new Date().toISOString(),
        tables: tableCounts,
        insufficientIssues: issueR.rows || []
      });
    } catch (e) {
      return res.status(500).json({ error: String(e?.message || e) });
    }
  });

  // ── One-click Evidence Export (tasks + events) ──
  app.get('/api/master/evidence/export', authRequired, async (req, res) => {
    const role = String(req.user?.role || '').trim();
    if (!['admin', 'hq_manager', 'hr_manager'].includes(role)) return res.status(403).json({ error: 'forbidden' });
    const taskLimit = Math.max(1, Math.min(20000, Number(req.query?.taskLimit) || 5000));
    const eventLimit = Math.max(1, Math.min(50000, Number(req.query?.eventLimit) || 10000));
    const format = String(req.query?.format || 'json').trim().toLowerCase();
    try {
      const [tasksR, eventsR] = await Promise.all([
        pool().query(`SELECT * FROM master_tasks ORDER BY created_at DESC LIMIT $1`, [taskLimit]),
        pool().query(`SELECT * FROM master_events ORDER BY created_at DESC LIMIT $1`, [eventLimit])
      ]);

      const tasks = tasksR.rows || [];
      const events = eventsR.rows || [];
      const byStatus = {};
      for (const t of tasks) {
        const k = String(t?.status || 'unknown');
        byStatus[k] = (byStatus[k] || 0) + 1;
      }
      const byEventType = {};
      for (const e of events) {
        const k = String(e?.event_type || 'unknown');
        byEventType[k] = (byEventType[k] || 0) + 1;
      }

      if (format === 'csv') {
        const taskColumns = ['task_id', 'source', 'category', 'severity', 'store', 'brand', 'title', 'status', 'assignee_role', 'assignee_username', 'created_at', 'updated_at'];
        const eventColumns = ['task_id', 'event_type', 'from_agent', 'to_agent', 'status_before', 'status_after', 'created_at'];
        const taskCsv = _exportCsv(tasks, taskColumns);
        const eventCsv = _exportCsv(events, eventColumns);
        const csv = [
          '# master_tasks',
          taskCsv,
          '',
          '# master_events',
          eventCsv
        ].join('\n');
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="master-evidence-${Date.now()}.csv"`);
        return res.send(csv);
      }

      return res.json({
        generatedAt: new Date().toISOString(),
        limits: { taskLimit, eventLimit },
        summary: {
          taskCount: tasks.length,
          eventCount: events.length,
          byStatus,
          byEventType
        },
        tasks,
        events
      });
    } catch (e) {
      return res.status(500).json({ error: String(e?.message || e) });
    }
  });

  // ── Task Detail with Events ──
  app.get('/api/master/tasks/:taskId', authRequired, async (req, res) => {
    const taskId = String(req.params?.taskId || '').trim();
    if (!taskId) return res.status(400).json({ error: 'missing_task_id' });
    try {
      const [taskR, eventsR] = await Promise.all([
        pool().query(`SELECT * FROM master_tasks WHERE task_id = $1`, [taskId]),
        pool().query(`SELECT * FROM master_events WHERE task_id = $1 ORDER BY created_at ASC`, [taskId])
      ]);
      if (!taskR.rows?.length) return res.status(404).json({ error: 'not_found' });
      return res.json({ task: taskR.rows[0], events: eventsR.rows || [] });
    } catch (e) { return res.status(500).json({ error: String(e?.message || e) }); }
  });

  // ── Event Log ──
  app.get('/api/master/events', authRequired, async (req, res) => {
    const role = String(req.user?.role || '').trim();
    if (!['admin', 'hq_manager', 'hr_manager'].includes(role)) return res.status(403).json({ error: 'forbidden' });
    const limit = Math.max(1, Math.min(200, Number(req.query?.limit) || 50));
    try {
      const r = await pool().query(
        `SELECT * FROM master_events ORDER BY created_at DESC LIMIT $1`, [limit]
      );
      return res.json({ items: r.rows || [] });
    } catch (e) { return res.status(500).json({ error: String(e?.message || e) }); }
  });

  // ── Manual Task Creation (admin) ──
  app.post('/api/master/tasks', authRequired, async (req, res) => {
    const role = String(req.user?.role || '').trim();
    if (!['admin', 'hq_manager'].includes(role)) return res.status(403).json({ error: 'forbidden' });
    try {
      const { category, severity, store, brand, title, detail } = req.body || {};
      if (!store || !title) return res.status(400).json({ error: 'missing store or title' });
      const taskId = await createTask({
        source: 'manual',
        sourceRef: `manual-${req.user?.username}`,
        category: category || '手动创建',
        severity: severity || 'medium',
        store, brand: brand || inferBrandFromStoreName(store),
        title, detail: detail || '',
        sourceData: { createdBy: req.user?.username }
      });
      return res.json({ ok: true, taskId });
    } catch (e) { return res.status(500).json({ error: String(e?.message || e) }); }
  });

  // 注册 HQ Planner 路由 (行动计划/门店健康/因果链/算力统计)
  registerHqPlannerRoutes(app, authRequired);
}
