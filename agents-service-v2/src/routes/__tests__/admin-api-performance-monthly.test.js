import { getRealtimeMonthlyScoreFromWeeklyRows } from '../admin-api.js';

describe('getRealtimeMonthlyScoreFromWeeklyRows', () => {
  test('returns latest cumulative weekly score instead of averaging', () => {
    const rows = [
      { period: 'week_2026-03-30__202604', total_score: 100 },
      { period: 'week_2026-04-06', total_score: 90 },
      { period: 'week_2026-04-13', total_score: 10 },
      { period: 'week_2026-04-20', total_score: -65 }
    ];

    expect(getRealtimeMonthlyScoreFromWeeklyRows(rows)).toBe(-65);
  });

  test('falls back to 100 when no weekly rows exist', () => {
    expect(getRealtimeMonthlyScoreFromWeeklyRows([])).toBe(100);
  });
});
