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
      max_memory_restart: '600M',
      env: {
        NODE_ENV: 'production',
        PORT: '3101',
        /** 与 src/utils/safety.js 一致：生产启动必须显式确认，否则进程 exit(2) */
        CONFIRM_PRODUCTION: 'true'
      }
    }
  ]
};
