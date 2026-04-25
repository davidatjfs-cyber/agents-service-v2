import { parseFeishuRatioOrPercentString, formatPercentDisplay } from '../feishu-percent.js';

describe('parseFeishuRatioOrPercentString', () => {
  test('decimal ratio under 1 → multiply by 100', () => {
    expect(parseFeishuRatioOrPercentString('0.6396')).toBeCloseTo(63.96);
    expect(parseFeishuRatioOrPercentString('0.95')).toBeCloseTo(95);
    expect(parseFeishuRatioOrPercentString('0.01')).toBeCloseTo(1);
  });

  test('percent string with % sign', () => {
    expect(parseFeishuRatioOrPercentString('63.96%')).toBeCloseTo(63.96);
    expect(parseFeishuRatioOrPercentString('95%')).toBe(95);
  });

  test('already a percent number (no % sign) > 1', () => {
    expect(parseFeishuRatioOrPercentString('85')).toBe(85);
    expect(parseFeishuRatioOrPercentString('100')).toBe(100);
    expect(parseFeishuRatioOrPercentString('150')).toBe(150);
  });

  test('handles comma separators', () => {
    expect(parseFeishuRatioOrPercentString('1,234.56')).toBe(1234.56);
  });

  test('null/empty returns null', () => {
    expect(parseFeishuRatioOrPercentString(null)).toBeNull();
    expect(parseFeishuRatioOrPercentString('')).toBeNull();
    expect(parseFeishuRatioOrPercentString('   ')).toBeNull();
  });

  test('non-numeric returns null', () => {
    expect(parseFeishuRatioOrPercentString('abc')).toBeNull();
    expect(parseFeishuRatioOrPercentString('--')).toBeNull();
  });

  test('value of exactly 1 is treated as 100% (n <= 1 multiply)', () => {
    expect(parseFeishuRatioOrPercentString('1')).toBe(100);
  });

  test('value of 0 returns 0', () => {
    expect(parseFeishuRatioOrPercentString('0%')).toBe(0);
    expect(parseFeishuRatioOrPercentString('0')).toBe(0);
  });
});

describe('formatPercentDisplay', () => {
  test('formats number with default 2 digits', () => {
    expect(formatPercentDisplay(63.956)).toBe('63.96%');
    expect(formatPercentDisplay(100)).toBe('100.00%');
  });

  test('formats with custom digits', () => {
    expect(formatPercentDisplay(63.956, 0)).toBe('64%');
    expect(formatPercentDisplay(63.956, 1)).toBe('64.0%');
  });

  test('handles null/NaN', () => {
    expect(formatPercentDisplay(null)).toBe('—');
    expect(formatPercentDisplay(undefined)).toBe('—');
    expect(formatPercentDisplay(NaN)).toBe('—');
  });

  test('handles zero', () => {
    expect(formatPercentDisplay(0)).toBe('0.00%');
  });

  test('handles negative values', () => {
    expect(formatPercentDisplay(-5)).toBe('-5.00%');
  });
});
