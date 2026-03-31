import cron from 'node-cron';
import { logger } from '../utils/logger.js';
import { scanEscalations } from '../services/task-state-machine.js';
import { sendText } from '../services/feishu-client.js';
import { query } from '../utils/db.js';

export function startEscalationScheduler() {
  cron.schedule('*/30 * * * *', async () => {
    try {
      logger.info('Running escalation scan');
      const r = await scanEscalations();
      if (r.escalated > 0) {
        logger.info({ escalated: r.escalated }, 'Tasks escalated');
        await notifyEscalations(r.tasks || []);
      }
    } catch (e) {
      logger.error({ err: e?.message }, 'Escalation scan failed');
    }
  }, { timezone: 'Asia/Shanghai' });
  logger.info('Escalation scheduler started (every 30min)');
}

async function notifyEscalations(tasks) {
  for (const t of tasks) {
    try {
      const cfg = await query('SELECT config_value FROM agent_v2_configs WHERE config_key=$1', ['push_config']);
      const pushCfg = cfg.rows?.[0]?.config_value;
      if (pushCfg?.hq_group_chat_id) {
        await sendText(pushCfg.hq_group_chat_id, `[升级提醒] 任务${t.task_id}已超时,当前状态:${t.status}`);
      }
    } catch (e) { /* silent */ }
  }
}
