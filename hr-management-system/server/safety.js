import { URL } from 'url';

export function getAppEnv() {
  const v = String(process.env.APP_ENV || process.env.NODE_ENV || 'development').trim().toLowerCase();
  if (v === 'prod') return 'production';
  if (v === 'stage') return 'staging';
  if (v === 'dev') return 'development';
  return v;
}

function parseDbHostFromDatabaseUrl(databaseUrl) {
  if (!databaseUrl) return null;
  try {
    const u = new URL(databaseUrl);
    return (u.hostname || '').trim() || null;
  } catch {
    return null;
  }
}

function isLocalHost(host) {
  const h = String(host || '').trim().toLowerCase();
  return h === 'localhost' || h === '127.0.0.1' || h === '::1';
}

/**
 * HRMS 内置「多 Agent + Master + 飞书 Bot 大脑」V1 总开关（与 agents-service-v2 解耦）。
 * - 未设置或不为 `true`：**默认关闭** V1 路由、飞书非多维表事件的 Bot 处理、V1 调度器/轮询/Master/BI 定时周报月报等。
 * - `HRMS_AGENT_V1_ENABLED=true`：恢复 V1（仍受 `DISABLE_AGENT_SCHEDULING` 等变量约束）。
 * 说明：`agents.js` 仍会被加载（agent-config-manager 等依赖其中的 pool），仅关闭运行时行为以保稳定；彻底删文件需后续把 pool 抽到独立模块。
 */
export function isHrmsAgentV1Enabled() {
  return String(process.env.HRMS_AGENT_V1_ENABLED || '').trim().toLowerCase() === 'true';
}

export function enforceRuntimeSafetyOrExit({ serviceName }) {
  const appEnv = getAppEnv();
  const dbHost = process.env.DB_HOST || parseDbHostFromDatabaseUrl(process.env.DATABASE_URL) || '';
  const redisHost = process.env.REDIS_HOST || '';

  // 1) 防误连生产：development 必须只连本机
  if (appEnv === 'development') {
    if (dbHost && !isLocalHost(dbHost)) {
      console.error(`[safety] REFUSE_START: ${serviceName} in development with non-local DB host: ${dbHost}`);
      process.exit(2);
    }
    if (redisHost && !isLocalHost(redisHost)) {
      console.error(`[safety] REFUSE_START: ${serviceName} in development with non-local Redis host: ${redisHost}`);
      process.exit(2);
    }
  }

  // 2) 防误上线：production 必须显式确认才允许运行（避免把本地直接指到生产）
  if (appEnv === 'production') {
    if (process.env.CONFIRM_PRODUCTION !== 'true') {
      console.error(`[safety] REFUSE_START: ${serviceName} APP_ENV=production without CONFIRM_PRODUCTION=true`);
      process.exit(2);
    }
  }
}

export function configureDbSessionSafety(pool, { serviceName }) {
  const enableDbWrite = process.env.ENABLE_DB_WRITE === 'true';
  const appEnv = getAppEnv();

  pool.on('connect', async (client) => {
    try {
      // 防误操作：默认全局只读（DDL/DML都会被阻止）
      if (!enableDbWrite) {
        await client.query('SET default_transaction_read_only = on');
        console.warn(`[safety] ${serviceName} DB is READ-ONLY (ENABLE_DB_WRITE!=true, APP_ENV=${appEnv})`);
      }
    } catch (e) {
      console.error(`[safety] Failed to set DB safety mode: ${e?.message || e}`);
      // 安全起见：无法确保只读时，直接拒绝启动
      if (!enableDbWrite) process.exit(2);
    }
  });
}

export function isSchemaChangeAllowed() {
  const appEnv = getAppEnv();
  // 默认：staging/production 禁止自动建表/补列/运行时 migration
  if (appEnv === 'production' || appEnv === 'staging') {
    return process.env.ALLOW_SCHEMA_CHANGES === 'true';
  }
  // development 允许，但也可以显式关闭
  return process.env.ALLOW_SCHEMA_CHANGES !== 'false';
}

export function isExternalEnabled() {
  const appEnv = getAppEnv();
  // 所有环境默认关闭外部调用，必须显式开启
  if (appEnv === 'production' || appEnv === 'staging') return process.env.ENABLE_EXTERNAL === 'true';
  return process.env.ENABLE_EXTERNAL === 'true';
}

export function isWebhookEnabled() {
  const appEnv = getAppEnv();
  // 默认关闭 webhook，必须显式开启
  if (appEnv === 'production' || appEnv === 'staging') return process.env.ENABLE_WEBHOOK === 'true';
  return process.env.ENABLE_WEBHOOK === 'true';
}

