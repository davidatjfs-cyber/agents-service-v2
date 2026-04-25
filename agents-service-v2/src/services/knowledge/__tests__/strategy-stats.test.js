import { getTimeWeight, getTrend } from '../strategy-stats.js';

describe('getTimeWeight', () => {
  test('returns 1.5 for recent entries (within 3 days)', () => {
    const recent = Date.now() - 1000;
    expect(getTimeWeight(recent)).toBe(1.5);
  });

  test('returns 1.2 for entries within a week', () => {
    const fiveDaysAgo = Date.now() - 5 * 24 * 60 * 60 * 1000;
    expect(getTimeWeight(fiveDaysAgo)).toBe(1.2);
  });

  test('returns 1.0 for old entries (over a week)', () => {
    const tenDaysAgo = Date.now() - 10 * 24 * 60 * 60 * 1000;
    expect(getTimeWeight(tenDaysAgo)).toBe(1.0);
  });

  test('handles zero timestamp', () => {
    expect(getTimeWeight(0)).toBe(1.0);
  });

  test('handles null/undefined (returns 1.0 due to Number(null) = 0)', () => {
    expect(getTimeWeight(null)).toBe(1.0);
    expect(getTimeWeight(undefined)).toBe(1.0);
  });
});

describe('getTrend', () => {
  test('returns up for ascending scores', () => {
    expect(getTrend([1, 2, 3])).toBe('up');
    expect(getTrend([0.1, 0.5, 0.9])).toBe('up');
  });

  test('returns down for descending scores', () => {
    expect(getTrend([3, 2, 1])).toBe('down');
    expect(getTrend([0.9, 0.5, 0.1])).toBe('down');
  });

  test('returns stable for flat scores', () => {
    expect(getTrend([1, 1, 1])).toBe('stable');
    expect(getTrend([2, 2, 2])).toBe('stable');
  });

  test('returns stable for less than 3 data points', () => {
    expect(getTrend([])).toBe('stable');
    expect(getTrend([1])).toBe('stable');
    expect(getTrend([1, 2])).toBe('stable');
  });

  test('ignores NaN values in scores', () => {
    expect(getTrend([1, NaN, 2, NaN, 3])).toBe('up');
  });

  test('returns stable for non-monotonic sequences', () => {
    expect(getTrend([1, 3, 2])).toBe('stable');
    expect(getTrend([2, 1, 3])).toBe('stable');
  });

  test('checks only last 3 entries for trend direction', () => {
    expect(getTrend([0, 0, 0, 1, 2, 3])).toBe('up');
    expect(getTrend([5, 5, 5, 3, 2, 1])).toBe('down');
  });
});
