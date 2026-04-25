import { addDaysYmdShanghai, shanghaiWeekMonSunContaining } from '../anomaly-week-bounds.js';

describe('addDaysYmdShanghai', () => {
  test('adds positive days', () => {
    expect(addDaysYmdShanghai('2026-04-13', 3)).toBe('2026-04-16');
  });

  test('subtracts days', () => {
    expect(addDaysYmdShanghai('2026-04-13', -1)).toBe('2026-04-12');
  });

  test('crosses month boundary', () => {
    expect(addDaysYmdShanghai('2026-04-30', 1)).toBe('2026-05-01');
  });

  test('crosses year boundary', () => {
    expect(addDaysYmdShanghai('2025-12-31', 1)).toBe('2026-01-01');
  });

  test('zero delta returns same day', () => {
    expect(addDaysYmdShanghai('2026-04-13', 0)).toBe('2026-04-13');
  });
});

describe('shanghaiWeekMonSunContaining', () => {
  test('Wednesday 2026-04-15 returns Mon 04-13 to Sun 04-19', () => {
    const { weekStart, weekEnd } = shanghaiWeekMonSunContaining('2026-04-15');
    expect(weekStart).toBe('2026-04-13');
    expect(weekEnd).toBe('2026-04-19');
  });

  test('Monday itself returns same day as start', () => {
    const { weekStart } = shanghaiWeekMonSunContaining('2026-04-13');
    expect(weekStart).toBe('2026-04-13');
  });

  test('Sunday returns previous Monday', () => {
    const { weekStart } = shanghaiWeekMonSunContaining('2026-04-19');
    expect(weekStart).toBe('2026-04-13');
  });

  test('early month date', () => {
    const { weekStart, weekEnd } = shanghaiWeekMonSunContaining('2026-04-01');
    expect(weekStart).toMatch(/2026-03-3\d/);
    expect(weekEnd).toMatch(/2026-04-0\d/);
  });
});
