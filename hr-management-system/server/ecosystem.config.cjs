/**
 * PM2 单一配置：生产固定 PORT=3000，与 agents-service-v2(3101) 分离。
 * 部署：cd /opt/hrms/server && pm2 delete hrms-service 2>/dev/null; pm2 start ecosystem.config.cjs --update-env
 */
module.exports = {
  apps: [
    {
      name: 'hrms-service',
      script: 'index.js',
      cwd: __dirname,
      instances: 1,
      exec_mode: 'fork',
      watch: false,
      max_memory_restart: '800M',
      env: {
        NODE_ENV: 'production',
        PORT: '3000',
        // 与 server/safety.js 一致：会话 nonce / 登录日志等必须写入 DB；未开启会导致 storeSessionNonce 失败 → 无法登录
        ENABLE_DB_WRITE: 'true'
      }
    }
  ]
};
