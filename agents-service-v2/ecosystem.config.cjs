/**
 * PM2 单一配置：生产固定 PORT=3101，与 HRMS(3000) 分离，避免端口混用导致 EADDRINUSE / 频繁重启。
 * 部署：cd /opt/agents-service-v2 && pm2 delete agents-service-v2 2>/dev/null; pm2 start ecosystem.config.cjs --update-env
 */
module.exports = {
  apps: [
    {
      name: 'agents-service-v2',
      script: 'src/index.js',
      cwd: __dirname,
      instances: 1,
      exec_mode: 'fork',
      watch: false,
      /** 原 600M 与每日 ~07:30 内存尖峰叠加 PM2 重启，易错过 07:40 晨报；提高到 1.5G 并配合 bitable 流式轮询降峰值 */
      max_memory_restart: '1536M',
      env: {
        NODE_ENV: 'production',
        PORT: '3101',
        /** 与 src/utils/safety.js 一致：生产启动必须显式确认，否则进程 exit(2) */
        CONFIRM_PRODUCTION: 'true',
        /** 飞书事件/卡片回调默认关闭；生产须开启否则机器人与交互卡全无响应（index.js isWebhookEnabled） */
        ENABLE_WEBHOOK: 'true'
      }
    }
  ]
};
