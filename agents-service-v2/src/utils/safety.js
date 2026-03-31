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

export function enforceRuntimeSafetyOrExit({ serviceName }) {
  const appEnv = getAppEnv();
  const dbHost = process.env.DB_HOST || parseDbHostFromDatabaseUrl(process.env.DATABASE_URL) || '';
  const redisHost = process.env.REDIS_HOST || new URL(process.env.REDIS_URL || 'redis://localhost:6379').hostname;

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

  if (appEnv === 'production') {
    if (process.env.CONFIRM_PRODUCTION !== 'true') {
      console.error(`[safety] REFUSE_START: ${serviceName} APP_ENV=production without CONFIRM_PRODUCTION=true`);
      process.exit(2);
    }
  }
}

export function isAutomationsEnabled() {
  const appEnv = getAppEnv();
  // staging/production 默认关闭自动化（轮询/定时/外部同步）
  if (appEnv === 'production' || appEnv === 'staging') return process.env.ENABLE_AUTOMATIONS === 'true';
  // development 默认关闭，避免本地一启动就狂写；需要时再显式开启
  return process.env.ENABLE_AUTOMATIONS === 'true';
}

/**
 * 每日巡检 cron（控制台 daily_inspections）：默认跟随 ENABLE_AUTOMATIONS；
 * 可单独 ENABLE_DAILY_INSPECTION_CRON=true 在关闭其它自动化时仍执行巡检。
 */
export function isDailyInspectionCronEnabled() {
  const v = String(process.env.ENABLE_DAILY_INSPECTION_CRON || '').trim().toLowerCase();
  if (v === 'true') return true;
  if (v === 'false') return false;
  return isAutomationsEnabled();
}

/** 周度评分 cron：默认同 ENABLE_AUTOMATIONS；可单独 ENABLE_WEEKLY_SCORING_CRON */
export function isWeeklyScoringCronEnabled() {
  const v = String(process.env.ENABLE_WEEKLY_SCORING_CRON || '').trim().toLowerCase();
  if (v === 'true') return true;
  if (v === 'false') return false;
  return isAutomationsEnabled();
}

/** 任务卡 1h×3 催办 + HR 备案 */
export function isTaskReminderCronEnabled() {
  const v = String(process.env.ENABLE_TASK_REMINDER_CRON || '').trim().toLowerCase();
  if (v === 'true') return true;
  if (v === 'false') return false;
  return isAutomationsEnabled();
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

export function isLoginEnabled() {
  const appEnv = getAppEnv();
  // staging/production 默认禁用登录（避免弱认证），需要时再显式开启并配合更强策略
  if (appEnv === 'production' || appEnv === 'staging') return process.env.ENABLE_LOGIN === 'true';
  return process.env.ENABLE_LOGIN !== 'false';
}

export function isWeakAuthAllowed() {
  const appEnv = getAppEnv();
  // staging/production 强制禁止弱认证逻辑（用户名=密码、默认 admin fallback）
  if (appEnv === 'production' || appEnv === 'staging') return process.env.ENABLE_WEAK_AUTH === 'true';
  return process.env.ENABLE_WEAK_AUTH === 'true';
}

