import { anomalyRollupPeriodKey, hrmsLegacyWeekPeriodForYmd, weeklyAgentScorePeriodKeys } from '../week-period-keys.js';

describe('anomalyRollupPeriodKey', () => {
  test('same month returns week_Monday', () => {
    const result = anomalyRollupPeriodKey('2026-04-13', '2026-04-15');
    expect(result).toBe('week_2026-04-13');
  });

  test('cross-month week with anchor in first month', () => {
    const result = anomalyRollupPeriodKey('2026-03-30', '2026-03-31');
    expect(result).toBe('week_2026-03-30__202603');
  });

  test('cross-month week with anchor in second month', () => {
    const result = anomalyRollupPeriodKey('2026-03-30', '2026-04-01');
    expect(result).toBe('week_2026-03-30__202604');
  });

  test('anchor defaults to weekMonday when omitted', () => {
    const result = anomalyRollupPeriodKey('2026-03-30');
    expect(result).toBe('week_2026-03-30__202603');
  });

  test('year boundary cross-month', () => {
    const result = anomalyRollupPeriodKey('2025-12-29', '2026-01-01');
    expect(result).toBe('week_2025-12-29__202601');
  });
});

describe('hrmsLegacyWeekPeriodForYmd', () => {
  test('first week of April 2026', () => {
    const result = hrmsLegacyWeekPeriodForYmd('2026-04-06');
    expect(result).toMatch(/^2026-W\d{2}$/);
  });

  test('returns correct format: YYYY-Www', () => {
    const result = hrmsLegacyWeekPeriodForYmd('2026-04-15');
    expect(result).toMatch(/^\d{4}-W\d{2}$/);
  });
});

describe('weeklyAgentScorePeriodKeys', () => {
  test('returns array with weekTag and legacy keys', () => {
    const keys = weeklyAgentScorePeriodKeys('2026-04-13');
    expect(Array.isArray(keys)).toBe(true);
    expect(keys.length).toBeGreaterThanOrEqual(1);
    expect(keys[0]).toBe('week_2026-04-13');
  });

  test('deduplicates matching keys', () => {
    const keys = weeklyAgentScorePeriodKeys('2026-04-13');
    expect(new Set(keys).size).toBe(keys.length);
  });
});
