/**
 * Agent Autonomous Capabilities Enhancement
 * 增强Agent自主工作能力，实现自主任务调度、状态管理和自我优化
 */

import { pool } from './master-agent.js';
import AgentCommunicationSystem from './agent-communication-system.js';

// Agent 自主任务类型
export const AUTONOMOUS_TASK_TYPES = {
  // 数据质量自检
  DATA_QUALITY_CHECK: {
    id: 'data_quality_check',
    priority: 'high',
    schedule: '0 */2 * * *', // 每2小时
    description: '检查数据源的完整性和质量'
  },
  // 异常检测
  ANOMALY_DETECTION: {
    id: 'anomaly_detection',
    priority: 'high',
    schedule: '0 */4 * * *', // 每4小时
    description: '检测业务数据异常并生成报告'
  },
  // 知识库更新检查
  KNOWLEDGE_UPDATE: {
    id: 'knowledge_update',
    priority: 'medium',
    schedule: '0 0 * * *', // 每天
    description: '检查知识库内容是否需要更新'
  },
  // 评分规则优化
  SCORING_OPTIMIZATION: {
    id: 'scoring_optimization',
    priority: 'medium',
    schedule: '0 1 * * 1', // 每周一
    description: '分析评分规则执行效果并提出优化建议'
  },
  // 协作任务检查
  COLLABORATION_CHECK: {
    id: 'collaboration_check',
    priority: 'high',
    schedule: '*/30 * * * *', // 每30分钟
    description: '检查Agent间协作任务状态'
  },
  // 健康报告生成
  HEALTH_REPORT: {
    id: 'health_report',
    priority: 'low',
    schedule: '0 8 * * *', // 每天早上8点
    description: '生成系统健康报告'
  }
};

/**
 * Agent 自主任务调度器
 */
export class AgentAutonomousScheduler {
  constructor() {
    this.tasks = new Map();
    this.running = false;
    this.checkInterval = null;
  }

  /**
   * 启动调度器
   */
  start() {
    if (this.running) return;
    this.running = true;
    
    // 每分钟检查一次是否有任务需要执行
    this.checkInterval = setInterval(() => this.checkScheduledTasks(), 60000);
    
    console.log('[AgentAutonomousScheduler] Started');
  }

  /**
   * 停止调度器
   */
  stop() {
    this.running = false;
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
    console.log('[AgentAutonomousScheduler] Stopped');
  }

  /**
   * 注册自主任务
   */
  registerTask(taskType, executor) {
    this.tasks.set(taskType.id, {
      ...taskType,
      executor,
      lastRun: null,
      runCount: 0,
      errorCount: 0
    });
    console.log(`[AgentAutonomousScheduler] Registered task: ${taskType.id}`);
  }

  /**
   * 检查需要执行的任务
   */
  async checkScheduledTasks() {
    const now = new Date();
    
    for (const [taskId, task] of this.tasks) {
      try {
        if (this.shouldRunTask(task, now)) {
          console.log(`[AgentAutonomousScheduler] Executing task: ${taskId}`);
          await this.executeTask(taskId);
        }
      } catch (e) {
        console.error(`[AgentAutonomousScheduler] Error checking task ${taskId}:`, e);
      }
    }
  }

  /**
   * 判断任务是否应该执行
   * 支持标准5字段cron：minute hour dayOfMonth month dayOfWeek
   * 例：'*/30 * * * *'  '0 8 * * *'  '0 1 * * 1'
   */
  shouldRunTask(task, now) {
    if (!task.lastRun) return true;

    const parts = task.schedule.split(' ');
    const minuteField = parts[0] || '*';
    const hourField   = parts[1] || '*';
    const dowField    = parts[4] || '*'; // day-of-week

    // 每 N 分钟执行一次：*/N
    if (minuteField.startsWith('*/')) {
      const interval = parseInt(minuteField.slice(2), 10);
      if (!isNaN(interval) && interval > 0) {
        const minutesSinceLastRun = (now - task.lastRun) / 60000;
        return minutesSinceLastRun >= interval;
      }
    }

    // 每 N 小时执行一次：0 */N * * *
    if (minuteField === '0' && hourField.startsWith('*/')) {
      const interval = parseInt(hourField.slice(2), 10);
      if (!isNaN(interval) && interval > 0) {
        const hoursSinceLastRun = (now - task.lastRun) / 3600000;
        return hoursSinceLastRun >= interval;
      }
    }

    // 固定时间任务（今天还没跑过则检查时间窗口）
    if (task.lastRun.toDateString() !== now.toDateString()) {
      const taskMin  = parseInt(minuteField, 10);
      const taskHour = parseInt(hourField, 10);

      if (isNaN(taskMin) || isNaN(taskHour)) return false; // 无法解析，保守不执行

      const timeOk = now.getHours() > taskHour ||
                     (now.getHours() === taskHour && now.getMinutes() >= taskMin);
      if (!timeOk) return false;

      // 若指定了星期几（0=Sun … 6=Sat），还需匹配
      if (dowField !== '*') {
        const requiredDow = parseInt(dowField, 10);
        if (!isNaN(requiredDow) && now.getDay() !== requiredDow) return false;
      }

      return true;
    }

    return false;
  }

  /**
   * 执行任务
   */
  async executeTask(taskId) {
    const task = this.tasks.get(taskId);
    if (!task || !task.executor) return;

    try {
      const result = await task.executor();
      task.lastRun = new Date();
      task.runCount++;
      
      // 记录任务执行结果
      await this.logTaskExecution(taskId, 'success', result);
      
      console.log(`[AgentAutonomousScheduler] Task ${taskId} completed successfully`);
    } catch (e) {
      task.errorCount++;
      await this.logTaskExecution(taskId, 'error', { error: e?.message });
      console.error(`[AgentAutonomousScheduler] Task ${taskId} failed:`, e);
    }
  }

  /**
   * 记录任务执行日志
   */
  async logTaskExecution(taskId, status, result) {
    try {
      const db = pool();
      await db.query(
        `INSERT INTO agent_autonomous_logs (task_id, status, result, created_at) 
         VALUES ($1, $2, $3, NOW())`,
        [taskId, status, JSON.stringify(result)]
      );
    } catch (e) {
      console.error('[AgentAutonomousScheduler] Error logging task execution:', e);
    }
  }

  /**
   * 获取调度器状态
   */
  getStatus() {
    return {
      running: this.running,
      registeredTasks: Array.from(this.tasks.keys()),
      taskDetails: Array.from(this.tasks.entries()).map(([id, task]) => ({
        id,
        runCount: task.runCount,
        errorCount: task.errorCount,
        lastRun: task.lastRun?.toISOString()
      }))
    };
  }
}

/**
 * Agent 智能协作协调器
 */
export class AgentCollaborationOrchestrator {
  constructor() {
    this.activeCollaborations = new Map();
    this.messageQueue = [];
  }

  /**
   * 启动协作会话
   */
  async startCollaboration(topic, initiator, participants, context = {}) {
    const sessionId = `collab-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    
    const collaboration = {
      id: sessionId,
      topic,
      initiator,
      participants: new Set([initiator, ...participants]),
      status: 'active',
      context,
      messages: [],
      createdAt: new Date(),
      updatedAt: new Date()
    };
    
    this.activeCollaborations.set(sessionId, collaboration);
    
    // 广播协作启动消息
    await this.broadcastMessage(sessionId, {
      type: 'collaboration_started',
      from: 'master',
      content: `协作会话已启动：${topic}`,
      context
    });
    
    console.log(`[AgentCollaboration] Started session ${sessionId}: ${topic}`);
    return sessionId;
  }

  /**
   * 发送协作消息
   */
  async sendMessage(sessionId, from, to, content, metadata = {}) {
    const collaboration = this.activeCollaborations.get(sessionId);
    if (!collaboration) {
      throw new Error(`Collaboration session ${sessionId} not found`);
    }

    const message = {
      id: `msg-${Date.now()}`,
      from,
      to,
      content,
      metadata,
      timestamp: new Date(),
      status: 'delivered'
    };

    collaboration.messages.push(message);
    collaboration.updatedAt = new Date();

    // 如果目标Agent有消息处理器，调用它
    if (to !== 'broadcast' && to !== 'master') {
      await this.processAgentMessage(sessionId, message);
    }

    return message;
  }

  /**
   * 广播消息给所有参与者
   */
  async broadcastMessage(sessionId, message) {
    const collaboration = this.activeCollaborations.get(sessionId);
    if (!collaboration) return;

    for (const participant of collaboration.participants) {
      if (participant !== message.from) {
        await this.sendMessage(sessionId, message.from, participant, message.content, message);
      }
    }
  }

  /**
   * 处理Agent消息
   */
  async processAgentMessage(sessionId, message) {
    // 根据目标Agent类型路由处理
    const agentHandlers = {
      'data_auditor': this.handleDataAuditorMessage.bind(this),
      'ops_supervisor': this.handleOpsSupervisorMessage.bind(this),
      'chief_evaluator': this.handleChiefEvaluatorMessage.bind(this),
      'train_advisor': this.handleTrainAdvisorMessage.bind(this)
    };

    const handler = agentHandlers[message.to];
    if (handler) {
      await handler(sessionId, message);
    }
  }

  /**
   * Data Auditor 消息处理：检查指定数据源近期是否有新记录
   */
  async handleDataAuditorMessage(sessionId, message) {
    console.log(`[AgentCollaboration] Data Auditor processing message in ${sessionId}`);
    const dataSource = message?.metadata?.dataSource || message?.content;
    if (!dataSource) return;

    const ALLOWED = ['daily_reports','table_visit_records','sales_raw','master_tasks'];
    const table = ALLOWED.find(t => t === String(dataSource).trim());
    if (!table) return;

    try {
      const db = pool();
      const r = await db.query(
        `SELECT COUNT(*) AS cnt FROM ${table} WHERE created_at > NOW() - INTERVAL '24 hours'`
      );
      const count = parseInt(r.rows?.[0]?.cnt || 0);
      await this.sendMessage(sessionId, 'data_auditor', 'master',
        `[数据审计] ${table} 近24h记录数：${count}`,
        { dataSource: table, recordCount: count, checkedAt: new Date().toISOString() }
      );
    } catch (e) {
      console.error('[AgentCollaboration] Data Auditor query failed:', e?.message);
    }
  }

  /**
   * Ops Supervisor 消息处理：统计当前积压任务数
   */
  async handleOpsSupervisorMessage(sessionId, message) {
    console.log(`[AgentCollaboration] Ops Supervisor processing message in ${sessionId}`);
    try {
      const db = pool();
      const r = await db.query(
        `SELECT status, COUNT(*) AS cnt FROM master_tasks
         WHERE status IN ('pending','pending_response','dispatched','in_progress')
         GROUP BY status`
      );
      const summary = (r.rows || []).map(row => `${row.status}:${row.cnt}`).join(', ');
      await this.sendMessage(sessionId, 'ops_supervisor', 'master',
        `[运营监控] 当前积压任务：${summary || '无'}`,
        { taskSummary: r.rows, checkedAt: new Date().toISOString() }
      );
    } catch (e) {
      console.error('[AgentCollaboration] Ops Supervisor query failed:', e?.message);
    }
  }

  /**
   * Chief Evaluator 消息处理：统计近7天评分任务完成率
   */
  async handleChiefEvaluatorMessage(sessionId, message) {
    console.log(`[AgentCollaboration] Chief Evaluator processing message in ${sessionId}`);
    try {
      const db = pool();
      const r = await db.query(
        `SELECT COUNT(*) AS total,
                COUNT(CASE WHEN status IN ('settled','closed') THEN 1 END) AS done
         FROM master_tasks
         WHERE category = 'scoring' AND created_at > NOW() - INTERVAL '7 days'`
      );
      const row = r.rows?.[0];
      const total = parseInt(row?.total || 0);
      const done  = parseInt(row?.done  || 0);
      const rate  = total > 0 ? ((done / total) * 100).toFixed(1) : 'N/A';
      await this.sendMessage(sessionId, 'chief_evaluator', 'master',
        `[评分审计] 近7天评分完成率：${rate}%（${done}/${total}）`,
        { total, done, completionRate: rate, checkedAt: new Date().toISOString() }
      );
    } catch (e) {
      console.error('[AgentCollaboration] Chief Evaluator query failed:', e?.message);
    }
  }

  /**
   * Train Advisor 消息处理：返回知识库启用文章数
   */
  async handleTrainAdvisorMessage(sessionId, message) {
    console.log(`[AgentCollaboration] Train Advisor processing message in ${sessionId}`);
    try {
      const db = pool();
      const r = await db.query(
        `SELECT COUNT(*) AS total,
                COUNT(CASE WHEN enabled = TRUE THEN 1 END) AS enabled_cnt
         FROM knowledge_base`
      );
      const row = r.rows?.[0];
      await this.sendMessage(sessionId, 'train_advisor', 'master',
        `[培训顾问] 知识库文章：共${row?.total || 0}篇，已启用${row?.enabled_cnt || 0}篇`,
        { total: row?.total, enabled: row?.enabled_cnt, checkedAt: new Date().toISOString() }
      );
    } catch (e) {
      console.error('[AgentCollaboration] Train Advisor query failed:', e?.message);
    }
  }

  /**
   * 结束协作会话
   */
  async endCollaboration(sessionId, summary = '') {
    const collaboration = this.activeCollaborations.get(sessionId);
    if (!collaboration) return;

    collaboration.status = 'ended';
    collaboration.summary = summary;
    collaboration.endedAt = new Date();

    await this.broadcastMessage(sessionId, {
      type: 'collaboration_ended',
      from: 'master',
      content: summary || '协作会话已结束'
    });

    console.log(`[AgentCollaboration] Ended session ${sessionId}`);
    
    // 将会话归档到数据库
    await this.archiveCollaboration(sessionId);
  }

  /**
   * 归档协作会话
   */
  async archiveCollaboration(sessionId) {
    const collaboration = this.activeCollaborations.get(sessionId);
    if (!collaboration) return;

    try {
      const db = pool();
      await db.query(
        `INSERT INTO agent_collaboration_archives 
         (session_id, topic, initiator, participants, messages, summary, created_at, ended_at) 
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          sessionId,
          collaboration.topic,
          collaboration.initiator,
          JSON.stringify(Array.from(collaboration.participants)),
          JSON.stringify(collaboration.messages),
          collaboration.summary,
          collaboration.createdAt,
          collaboration.endedAt || new Date()
        ]
      );
      
      this.activeCollaborations.delete(sessionId);
    } catch (e) {
      console.error('[AgentCollaboration] Error archiving collaboration:', e);
    }
  }

  /**
   * 获取活跃的协作会话
   */
  getActiveCollaborations() {
    return Array.from(this.activeCollaborations.values()).map(c => ({
      id: c.id,
      topic: c.topic,
      initiator: c.initiator,
      participants: Array.from(c.participants),
      status: c.status,
      messageCount: c.messages.length,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt
    }));
  }
}

/**
 * Agent 自我反思与优化引擎
 */
export class AgentSelfOptimizationEngine {
  constructor() {
    this.insights = [];
    this.recommendations = [];
  }

  /**
   * 分析Agent表现
   */
  async analyzeAgentPerformance(agentId, timeRange = '7d') {
    try {
      const db = pool();
      
      // 查询Agent历史表现数据
      const result = await db.query(
        `SELECT 
          COUNT(*) as total_tasks,
          SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) as success_count,
          AVG(execution_time_ms) as avg_time,
          COUNT(DISTINCT DATE(created_at)) as active_days
         FROM agent_task_logs 
         WHERE agent_id = $1 AND created_at > NOW() - INTERVAL '${timeRange}'
         GROUP BY agent_id`,
        [agentId]
      );

      if (!result.rows?.length) {
        return { successRate: 0, avgExecutionTime: 0, activeDays: 0 };
      }

      const stats = result.rows[0];
      const total = parseInt(stats.total_tasks) || 0;
      const success = parseInt(stats.success_count) || 0;
      
      return {
        totalTasks: total,
        successRate: total > 0 ? success / total : 0,
        avgExecutionTime: parseFloat(stats.avg_time) || 0,
        activeDays: parseInt(stats.active_days) || 0
      };
    } catch (e) {
      console.error('[AgentSelfOptimization] Error analyzing performance:', e);
      return null;
    }
  }

  /**
   * 生成优化建议（每条附带唯一 id 供 applyRecommendation 查找）
   */
  async generateOptimizationRecommendations() {
    const recommendations = [];

    // 分析数据源质量
    try {
      const db = pool();
      const dataQualityResult = await db.query(
        `SELECT data_source,
          COUNT(*) as total_records,
          COUNT(CASE WHEN data_quality_score < 0.8 THEN 1 END) as low_quality_count
         FROM data_quality_logs
         WHERE created_at > NOW() - INTERVAL '7d'
         GROUP BY data_source`
      );

      for (const row of dataQualityResult.rows || []) {
        const total = parseInt(row.total_records);
        const lowQuality = parseInt(row.low_quality_count);
        const rate = total > 0 ? lowQuality / total : 0;

        if (rate > 0.1) {
          recommendations.push({
            id: `rec-dq-${row.data_source}-${Date.now()}`,  // ← 补充 id 字段
            type: 'data_quality',
            priority: rate > 0.3 ? 'high' : 'medium',
            target: row.data_source,
            description: `数据源 ${row.data_source} 的低质量记录占比 ${(rate * 100).toFixed(1)}%，建议检查数据同步流程`,
            suggestedActions: [
              '检查数据源同步配置',
              '验证数据清洗规则',
              '增加数据质量监控'
            ]
          });
        }
      }
    } catch (e) {
      console.error('[AgentSelfOptimization] Error analyzing data quality:', e);
    }

    this.recommendations = recommendations;
    return recommendations;
  }

  /**
   * 应用优化建议
   */
  async applyRecommendation(recommendationId) {
    const rec = this.recommendations.find(r => r.id === recommendationId);
    if (!rec) {
      return { success: false, error: 'Recommendation not found' };
    }

    try {
      // 根据建议类型执行不同的优化操作
      switch (rec.type) {
        case 'data_quality':
          await this.optimizeDataQuality(rec.target);
          break;
        case 'performance':
          await this.optimizePerformance(rec.target);
          break;
        case 'collaboration':
          await this.optimizeCollaboration(rec.target);
          break;
        default:
          return { success: false, error: 'Unknown recommendation type' };
      }

      return { success: true, message: `Applied optimization: ${rec.description}` };
    } catch (e) {
      return { success: false, error: e?.message };
    }
  }

  /**
   * 优化数据质量
   */
  async optimizeDataQuality(dataSource) {
    console.log(`[AgentSelfOptimization] Optimizing data quality for: ${dataSource}`);
    // 触发数据质量检查任务
    await AgentCommunicationSystem.reportDataSourceIssue(dataSource, 'quality_check', {
      triggeredBy: 'self_optimization'
    });
  }

  /**
   * 优化性能
   */
  async optimizePerformance(agentId) {
    console.log(`[AgentSelfOptimization] Optimizing performance for agent: ${agentId}`);
    // 实现性能优化逻辑
  }

  /**
   * 优化协作
   */
  async optimizeCollaboration(aspect) {
    console.log(`[AgentSelfOptimization] Optimizing collaboration: ${aspect}`);
    // 实现协作优化逻辑
  }
}

// 创建全局实例
export const autonomousScheduler = new AgentAutonomousScheduler();
export const collaborationOrchestrator = new AgentCollaborationOrchestrator();
export const selfOptimizationEngine = new AgentSelfOptimizationEngine();

// 初始化自主任务
export function initializeAutonomousTasks() {
  // 数据质量检查任务
  autonomousScheduler.registerTask(AUTONOMOUS_TASK_TYPES.DATA_QUALITY_CHECK, async () => {
    const db = pool();
    const sources = ['daily_reports', 'table_visit_records', 'sales_raw', 'master_tasks'];
    
    for (const source of sources) {
      try {
        const result = await db.query(`SELECT COUNT(*) as cnt FROM ${source} WHERE created_at > NOW() - INTERVAL '24h'`);
        const count = parseInt(result.rows?.[0]?.cnt || 0);
        
        if (count === 0) {
          await AgentCommunicationSystem.reportDataSourceIssue(source, 'no_recent_data', {
            severity: 'high',
            last24hRecords: 0
          });
        }
      } catch (e) {
        console.error(`[AutonomousTask] Error checking ${source}:`, e);
      }
    }
    
    return { checkedSources: sources.length };
  });

  // 异常检测任务
  autonomousScheduler.registerTask(AUTONOMOUS_TASK_TYPES.ANOMALY_DETECTION, async () => {
    // 检查master_tasks中的异常任务
    const db = pool();
    const result = await db.query(
      `SELECT * FROM master_tasks 
       WHERE status IN ('pending', 'pending_response') 
       AND created_at < NOW() - INTERVAL '2h'`
    );
    
    if (result.rows?.length > 10) {
      await AgentCommunicationSystem.reportTaskExecutionIssue('task_dispatch', 'bottleneck', {
        pendingCount: result.rows.length,
        severity: result.rows.length > 20 ? 'high' : 'medium'
      });
    }
    
    return { pendingTasks: result.rows?.length || 0 };
  });

  // 启动调度器
  autonomousScheduler.start();
  
  console.log('[AgentAutonomousSystem] Autonomous tasks initialized');
}

export default {
  AgentAutonomousScheduler,
  AgentCollaborationOrchestrator,
  AgentSelfOptimizationEngine,
  autonomousScheduler,
  collaborationOrchestrator,
  selfOptimizationEngine,
  initializeAutonomousTasks,
  AUTONOMOUS_TASK_TYPES
};
