import {
  getAppEnv,
  isAutomationsEnabled,
  isDailyInspectionCronEnabled,
  isWeeklyScoringCronEnabled,
  isTaskReminderCronEnabled,
  isExternalEnabled,
  isWebhookEnabled,
  isLoginEnabled,
  isWeakAuthAllowed
} from '../safety.js';

const OLD_ENV = { ...process.env };

beforeEach(() => {
  // Clear all relevant env vars before each test
  delete process.env.APP_ENV;
  delete process.env.NODE_ENV;
  delete process.env.ENABLE_AUTOMATIONS;
  delete process.env.ENABLE_DAILY_INSPECTION_CRON;
  delete process.env.ENABLE_WEEKLY_SCORING_CRON;
  delete process.env.ENABLE_TASK_REMINDER_CRON;
  delete process.env.ENABLE_EXTERNAL;
  delete process.env.ENABLE_WEBHOOK;
  delete process.env.ENABLE_LOGIN;
  delete process.env.ENABLE_WEAK_AUTH;
});

afterAll(() => {
  Object.assign(process.env, OLD_ENV);
});

describe('getAppEnv', () => {
  test('returns production for APP_ENV=prod', () => {
    process.env.APP_ENV = 'prod';
    expect(getAppEnv()).toBe('production');
  });

  test('returns staging for APP_ENV=stage', () => {
    process.env.APP_ENV = 'stage';
    expect(getAppEnv()).toBe('staging');
  });

  test('returns development for APP_ENV=dev', () => {
    process.env.APP_ENV = 'dev';
    expect(getAppEnv()).toBe('development');
  });

  test('falls back to NODE_ENV when APP_ENV is not set', () => {
    process.env.NODE_ENV = 'production';
    expect(getAppEnv()).toBe('production');
  });

  test('defaults to development when neither env is set', () => {
    expect(getAppEnv()).toBe('development');
  });

  test('handles case insensitivity', () => {
    process.env.APP_ENV = 'PROD';
    expect(getAppEnv()).toBe('production');
  });

  test('passes through unknown values unchanged', () => {
    process.env.APP_ENV = 'test';
    expect(getAppEnv()).toBe('test');
  });
});

describe('isAutomationsEnabled', () => {
  test('returns false when ENABLE_AUTOMATIONS is not set', () => {
    expect(isAutomationsEnabled()).toBe(false);
  });

  test('returns true when ENABLE_AUTOMATIONS=true', () => {
    process.env.ENABLE_AUTOMATIONS = 'true';
    expect(isAutomationsEnabled()).toBe(true);
  });

  test('returns false when ENABLE_AUTOMATIONS=false', () => {
    process.env.ENABLE_AUTOMATIONS = 'false';
    expect(isAutomationsEnabled()).toBe(false);
  });

  test('returns false for any non-true value', () => {
    process.env.ENABLE_AUTOMATIONS = 'yes';
    expect(isAutomationsEnabled()).toBe(false);
  });
});

describe('isDailyInspectionCronEnabled', () => {
  test('returns true when ENABLE_DAILY_INSPECTION_CRON=true', () => {
    process.env.ENABLE_DAILY_INSPECTION_CRON = 'true';
    expect(isDailyInspectionCronEnabled()).toBe(true);
  });

  test('returns false when ENABLE_DAILY_INSPECTION_CRON=false', () => {
    process.env.ENABLE_DAILY_INSPECTION_CRON = 'false';
    expect(isDailyInspectionCronEnabled()).toBe(false);
  });

  test('falls back to isAutomationsEnabled when not explicitly set', () => {
    process.env.ENABLE_AUTOMATIONS = 'true';
    expect(isDailyInspectionCronEnabled()).toBe(true);
  });

  test('falls back when ENABLE_DAILY_INSPECTION_CRON is unset and automations off', () => {
    expect(isDailyInspectionCronEnabled()).toBe(false);
  });
});

describe('isWeeklyScoringCronEnabled', () => {
  test('returns true when ENABLE_WEEKLY_SCORING_CRON=true', () => {
    process.env.ENABLE_WEEKLY_SCORING_CRON = 'true';
    expect(isWeeklyScoringCronEnabled()).toBe(true);
  });

  test('returns false when ENABLE_WEEKLY_SCORING_CRON=false', () => {
    process.env.ENABLE_WEEKLY_SCORING_CRON = 'false';
    expect(isWeeklyScoringCronEnabled()).toBe(false);
  });

  test('falls back to isAutomationsEnabled', () => {
    process.env.ENABLE_AUTOMATIONS = 'true';
    expect(isWeeklyScoringCronEnabled()).toBe(true);
  });
});

describe('isTaskReminderCronEnabled', () => {
  test('returns true when ENABLE_TASK_REMINDER_CRON=true', () => {
    process.env.ENABLE_TASK_REMINDER_CRON = 'true';
    expect(isTaskReminderCronEnabled()).toBe(true);
  });

  test('returns false when ENABLE_TASK_REMINDER_CRON=false', () => {
    process.env.ENABLE_TASK_REMINDER_CRON = 'false';
    expect(isTaskReminderCronEnabled()).toBe(false);
  });

  test('falls back to isDailyInspectionCronEnabled', () => {
    process.env.ENABLE_DAILY_INSPECTION_CRON = 'true';
    expect(isTaskReminderCronEnabled()).toBe(true);
  });

  test('falls back through daily to automations', () => {
    process.env.ENABLE_AUTOMATIONS = 'true';
    expect(isTaskReminderCronEnabled()).toBe(true);
  });

  test('all false when nothing is enabled', () => {
    expect(isTaskReminderCronEnabled()).toBe(false);
  });
});

describe('isExternalEnabled', () => {
  test('returns false when ENABLE_EXTERNAL is not set', () => {
    expect(isExternalEnabled()).toBe(false);
  });

  test('returns true when ENABLE_EXTERNAL=true', () => {
    process.env.ENABLE_EXTERNAL = 'true';
    expect(isExternalEnabled()).toBe(true);
  });
});

describe('isWebhookEnabled', () => {
  test('returns false when ENABLE_WEBHOOK is not set', () => {
    expect(isWebhookEnabled()).toBe(false);
  });

  test('returns true when ENABLE_WEBHOOK=true', () => {
    process.env.ENABLE_WEBHOOK = 'true';
    expect(isWebhookEnabled()).toBe(true);
  });
});

describe('isLoginEnabled', () => {
  test('returns true in development by default', () => {
    expect(isLoginEnabled()).toBe(true);
  });

  test('returns false when ENABLE_LOGIN=false in development', () => {
    process.env.ENABLE_LOGIN = 'false';
    expect(isLoginEnabled()).toBe(false);
  });
});

describe('isWeakAuthAllowed', () => {
  test('returns false when ENABLE_WEAK_AUTH is not set', () => {
    expect(isWeakAuthAllowed()).toBe(false);
  });

  test('returns true when ENABLE_WEAK_AUTH=true', () => {
    process.env.ENABLE_WEAK_AUTH = 'true';
    expect(isWeakAuthAllowed()).toBe(true);
  });
});
