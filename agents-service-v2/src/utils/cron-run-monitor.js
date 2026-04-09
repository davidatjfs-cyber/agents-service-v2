/**
 * 定时任务运行日志 + 按小时补偿重试（上海时区）。
 * - 主 cron 经 runWithCronLog 记成功/失败；
 * - sweepCronRetries 每小时 :22 扫描：已过计划点+宽限期仍无成功记录则补跑（每任务每日最多 maxAttempts 条记录含主任务）。
 */
import cron from 'node-cron';
import { query } from './db.js';
import { logger } from './logger.js';

const TABLE = 'agent_v2_cron_runs';

/** 兜底 sweep 仅在「计划点+宽限」之后的有限分钟内执行，避免进程全天每到 :22 反复补跑（用户体感「定时全乱」） */
const DEFAULT_SWEEP_WINDOW_MIN = 180;
const END_OF_SHANGHAI_DAY_MIN = 24 * 60 - 1;

export async function ensureCronRunTable() {
  try {
    await query(`
      CREATE TABLE IF NOT EXISTS ${TABLE} (
        id BIGSERIAL PRIMARY KEY,
        job_key TEXT NOT NULL,
        run_ymd TEXT NOT NULL,
        ok BOOLEAN NOT NULL,
        error TEXT,
        source TEXT NOT NULL DEFAULT 'cron',
        created_at TIMESTAMPTZ DEFAULT NOW()
      )`);
    await query(
      `CREATE INDEX IF NOT EXISTS idx_agent_v2_cron_runs_key_ymd ON ${TABLE} (job_key, run_ymd, created_at DESC)`
    );
  } catch (e) {
    logger.warn({ err: e?.message }, 'ensureCronRunTable');
  }
}

/** 上海当前：ymd、时、分、当天分钟数、weekday 0=日…1=一、dom */
export function getShanghaiNowClock() {
  const parts = new Intl.DateTimeFormat('en', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
    hour12: false
  }).formatToParts(new Date());
  const o = {};
  for (const p of parts) {
    if (p.type !== 'literal') o[p.type] = p.value;
  }
  const ymd = `${o.year}-${o.month}-${o.day}`;
  const hour = parseInt(o.hour, 10);
  const minute = parseInt(o.minute, 10);
  const mapDow = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const weekday = mapDow[o.weekday] ?? 0;
  const dom = parseInt(o.day, 10);
  return { ymd, hour, minute, minuteOfDay: hour * 60 + minute, weekday, dom };
}

async function insertRun(jobKey, runYmd, ok, error, source) {
  await ensureCronRunTable();
  await query(
    `INSERT INTO ${TABLE} (job_key, run_ymd, ok, error, source) VALUES ($1,$2,$3,$4,$5)`,
    [jobKey, runYmd, ok, error || null, source]
  );
}

async function hasSuccessToday(jobKey, runYmd) {
  await ensureCronRunTable();
  const r = await query(
    `SELECT 1 FROM ${TABLE} WHERE job_key = $1 AND run_ymd = $2 AND ok = true LIMIT 1`,
    [jobKey, runYmd]
  );
  return (r.rows || []).length > 0;
}

async function countRunsToday(jobKey, runYmd) {
  await ensureCronRunTable();
  const r = await query(
    `SELECT COUNT(*)::int AS c FROM ${TABLE} WHERE job_key = $1 AND run_ymd = $2`,
    [jobKey, runYmd]
  );
  return Number(r.rows?.[0]?.c || 0);
}

/**
 * 主定时任务包装：记录成功/失败（上海当日 ymd）
 */
export async function runWithCronLog(jobKey, fn, source = 'cron') {
  const { ymd } = getShanghaiNowClock();
  try {
    await fn();
    await insertRun(jobKey, ymd, true, null, source);
  } catch (e) {
    const msg = String(e?.message || e);
    await insertRun(jobKey, ymd, false, msg, source);
    throw e;
  }
}

async function fetchActiveStoresLikeIndex() {
  const r = await query(
    `SELECT DISTINCT store FROM daily_reports
     WHERE date >= CURRENT_DATE - 30 AND store IS NOT NULL`
  );
  return (r.rows || []).map((x) => x.store).filter(Boolean);
}

function buildRetryJobs(flags) {
  const auto = !!flags.automations;
  const weeklyScoring = flags.weeklyScoring !== false;

  return [
    {
      key: 'kpi_yesterday',
      slotMinuteOfDay: 1 * 60 + 3,
      graceMin: 45,
      sweepWindowMin: 240,
      maxAttempts: 4,
      match: () => auto,
      run: async () => {
        const m = await import('../services/kpi-calculator.js');
        await m.calculateAllStoresKPI('yesterday');
      }
    },
    {
      key: 'morning_briefing',
      slotMinuteOfDay: 7 * 60 + 30,
      graceMin: 45,
      /** 仅早间窗口内补偿：避免 7:30 主任务抛错后，小时级 sweep 在下午/晚上把晨报误发给仍未成功的接收人 */
      sweepEndMinuteOfDay: 10 * 60 + 30,
      maxAttempts: 4,
      match: () => true,
      run: async () => {
        const m = await import('../services/morning-briefing.js');
        await m.sendMorningBriefing();
      }
    },
    {
      key: 'daily_execution_rating',
      slotMinuteOfDay: 8 * 60 + 2,
      graceMin: 45,
      maxAttempts: 4,
      match: () => true,
      run: async () => {
        const m = await import('../services/daily-execution-rating.js');
        await m.runDailyExecutionRating();
      }
    },
    {
      key: 'food_safety_daily_scan',
      slotMinuteOfDay: 8 * 60 + 15,
      graceMin: 45,
      maxAttempts: 4,
      match: () => auto,
      run: async () => {
        const ae = await import('../services/anomaly-engine.js');
        const stores = await fetchActiveStoresLikeIndex();
        await ae.runFoodSafetyDailyScan(stores);
      }
    },
    {
      key: 'daily_task_completion_report',
      slotMinuteOfDay: 8 * 60 + 20,
      graceMin: 45,
      maxAttempts: 4,
      match: () => true,
      run: async () => {
        const m = await import('../services/daily-task-completion.js');
        await m.sendDailyTaskCompletionReport();
      }
    },
    {
      key: 'daily_bi_anomaly',
      slotMinuteOfDay: 5 * 60 + 8,
      graceMin: 60,
      sweepWindowMin: 240,
      maxAttempts: 4,
      match: () => auto,
      run: async () => {
        const re = await import('../services/rhythm-engine.js');
        await re.runAnomalyChecksForStores('daily');
      }
    },
    {
      key: 'bitable_actual_gross_margin',
      slotMinuteOfDay: 5 * 60 + 16,
      graceMin: 60,
      maxAttempts: 4,
      match: () => auto,
      run: async () => {
        const cfg = await import('../services/config-service.js');
        const featureFlags = (await cfg.getConfig('feature_flags').catch(() => null)) || {};
        if (featureFlags.bitable_polling === false) return;
        const bp = await import('../services/bitable-poller.js');
        await bp.pollBitableTable('actual_gross_margin');
      }
    },
    {
      key: 'weekly_bi_anomaly',
      slotMinuteOfDay: 5 * 60 + 0,
      graceMin: 120,
      sweepWindowMin: 360,
      maxAttempts: 4,
      weekdayOnly: 1,
      match: () => auto,
      run: async () => {
        const re = await import('../services/rhythm-engine.js');
        await re.runAnomalyChecksForStores('weekly');
      }
    },
    {
      key: 'weekly_store_scoring',
      slotMinuteOfDay: 8 * 60 + 25,
      graceMin: 120,
      sweepWindowMin: 360,
      maxAttempts: 4,
      weekdayOnly: 1,
      match: () => weeklyScoring,
      run: async () => {
        const ps = await import('../services/periodic-scoring.js');
        await ps.runWeeklyStoreScoring();
      }
    },
    {
      key: 'monthly_anomaly_item_bonus',
      slotMinuteOfDay: 0 * 60 + 30,
      graceMin: 90,
      sweepWindowMin: 720,
      maxAttempts: 4,
      dayOfMonthOnly: 10,
      match: () => true,
      run: async () => {
        const m = await import('../services/monthly-anomaly-bonus.js');
        await m.runMonthlyAnomalyItemBonuses();
      }
    },
    {
      key: 'monthly_gross_margin_check',
      slotMinuteOfDay: 0,
      graceMin: 90,
      sweepWindowMin: 720,
      maxAttempts: 4,
      dayOfMonthOnly: 10,
      match: () => auto,
      run: async () => {
        const cfg = await import('../services/config-service.js');
        const stores = await cfg.getActiveStores();
        for (const store of stores) {
          try {
            const ae = await import('../services/anomaly-engine.js');
            const result = await ae.checkGrossMargin(store);
            if (!result.triggered) continue;
            const brand = await cfg.getBrandForStore(store).catch(() => null);
            const db = await import('./db.js');
            const { shanghaiPrevCalendarMonthBounds } = await import('./anomaly-week-bounds.js');
            const triggerDate = shanghaiPrevCalendarMonthBounds().last;
            const dupFinal = await db.query(
              `SELECT 1 FROM anomaly_triggers
               WHERE anomaly_key = 'gross_margin' AND store = $1 AND trigger_date = $2::date
                 AND COALESCE(status, '') NOT IN ('pending_data', 'superseded')
               LIMIT 1`,
              [store, triggerDate]
            );
            if (dupFinal.rows?.length) continue;
            await db.query(
              `INSERT INTO anomaly_triggers
                 (anomaly_key, store, brand, severity, trigger_date, trigger_value, threshold_value, assigned_role, notify_target_role)
               VALUES ($1, $2, $3, $4, $5::date, $6, $7, $8, $9)`,
              [
                'gross_margin',
                store,
                brand || null,
                result.severity,
                triggerDate,
                JSON.stringify(result.value),
                JSON.stringify(result.threshold),
                'store_production_manager',
                'kitchen_manager'
              ]
            );
            const q = await import('../services/anomaly-queue.js');
            await q.enqueueNotifyJob({
              store,
              brand,
              ruleKey: 'gross_margin',
              severity: result.severity,
              detail: result.detail,
              value: result.value
            });
            await q.enqueueCollabJob({
              ruleKey: 'gross_margin',
              store,
              severity: result.severity,
              detail: result.detail,
              value: result.value
            });
          } catch (e) {
            logger.error({ err: e?.message, store }, 'cron-retry gross margin monthly check failed');
          }
        }
      }
    },
    {
      key: 'monthly_comprehensive_rating',
      slotMinuteOfDay: 1 * 60 + 18,
      graceMin: 120,
      sweepWindowMin: 720,
      maxAttempts: 4,
      dayOfMonthOnly: 10,
      match: () => true,
      run: async () => {
        const m = await import('../services/monthly-comprehensive-rating.js');
        await m.runMonthlyComprehensiveRating();
      }
    },
    {
      key: 'rhythm_weekly_report',
      slotMinuteOfDay: 10 * 60 + 6,
      graceMin: 90,
      sweepWindowMin: 360,
      maxAttempts: 3,
      weekdayOnly: 1,
      match: () => auto,
      run: async () => {
        const re = await import('../services/rhythm-engine.js');
        const cfg = await import('../services/config-service.js');
        const raw = await cfg.getRhythmSchedule().catch(() => null);
        const items = Array.isArray(raw?.rhythmItems) ? raw.rhythmItems : [];
        const wk = items.find((it) => it.key === 'weekly');
        if (wk && wk.enabled === false) return;
        await re.weeklyReport();
      }
    },
    {
      key: 'rhythm_monthly_evaluation',
      slotMinuteOfDay: 10 * 60 + 18,
      graceMin: 90,
      sweepWindowMin: 360,
      maxAttempts: 3,
      dayOfMonthOnly: 1,
      match: () => auto,
      run: async () => {
        const re = await import('../services/rhythm-engine.js');
        const cfg = await import('../services/config-service.js');
        const raw = await cfg.getRhythmSchedule().catch(() => null);
        const items = Array.isArray(raw?.rhythmItems) ? raw.rhythmItems : [];
        const mo = items.find((it) => it.key === 'monthly');
        if (mo && mo.enabled === false) return;
        await re.monthlyEvaluation();
      }
    },
    {
      key: 'monthly_revenue_anomaly',
      slotMinuteOfDay: 8 * 60 + 12,
      graceMin: 90,
      sweepWindowMin: 480,
      maxAttempts: 4,
      dayOfMonthOnly: 1,
      match: () => auto,
      run: async () => {
        const re = await import('../services/rhythm-engine.js');
        await re.runAnomalyChecksForStores('monthly');
      }
    },
    {
      key: 'daily_attendance_report',
      slotMinuteOfDay: 22 * 60 + 15,
      graceMin: 60,
      sweepWindowMin: 150,
      maxAttempts: 4,
      match: () => auto,
      run: async () => {
        const re = await import('../services/rhythm-engine.js');
        await re.dailyAttendanceReport();
      }
    }
  ];
}

/**
 * @param {() => { automations: boolean, weeklyScoring?: boolean }} getFlags
 */
export async function sweepCronRetries(getFlags) {
  const flags =
    typeof getFlags === 'function'
      ? getFlags()
      : { automations: false, weeklyScoring: true };
  const jobs = buildRetryJobs(flags);
  const { ymd, minuteOfDay, weekday, dom } = getShanghaiNowClock();

  for (const j of jobs) {
    try {
      if (!j.match()) continue;
      if (j.weekdayOnly != null && weekday !== j.weekdayOnly) continue;
      if (j.dayOfMonthOnly != null && dom !== j.dayOfMonthOnly) continue;
      const earliestMd = j.slotMinuteOfDay + j.graceMin;
      if (minuteOfDay < earliestMd) continue;
      const win = j.sweepWindowMin ?? DEFAULT_SWEEP_WINDOW_MIN;
      let latestMd = Math.min(earliestMd + win, END_OF_SHANGHAI_DAY_MIN);
      if (j.sweepEndMinuteOfDay != null) latestMd = Math.min(latestMd, j.sweepEndMinuteOfDay);
      if (minuteOfDay > latestMd) continue;
      if (await hasSuccessToday(j.key, ymd)) continue;
      const n = await countRunsToday(j.key, ymd);
      if (n >= j.maxAttempts) continue;

      logger.warn({ jobKey: j.key, ymd, runs: n }, 'cron-retry: attempting sweep run');
      await runWithCronLog(j.key, j.run, 'sweep');
    } catch (e) {
      logger.error({ err: e?.message, jobKey: j.key }, 'cron-retry: sweep run failed');
    }
  }
}

/**
 * @param {() => { automations: boolean, weeklyScoring?: boolean }} getFlags
 */
export function startCronRetrySweeper(getFlags) {
  cron.schedule(
    '22 * * * *',
    () => {
      sweepCronRetries(getFlags).catch((e) =>
        logger.error({ err: e?.message }, 'sweepCronRetries failed')
      );
    },
    { timezone: 'Asia/Shanghai' }
  );
  logger.info('Cron retry sweeper started (hourly :22 Asia/Shanghai, table agent_v2_cron_runs)');
}
