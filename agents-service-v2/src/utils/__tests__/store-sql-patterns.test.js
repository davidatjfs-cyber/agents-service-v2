import { normalizeStoreCompact, feishuStoreSearchPatterns } from '../store-sql-patterns.js';

describe('normalizeStoreCompact', () => {
  test('lowercases and removes spaces', () => {
    expect(normalizeStoreCompact('洪潮 大宁 久光 店')).toBe('洪潮大宁久光店');
  });

  test('handles empty string', () => {
    expect(normalizeStoreCompact('')).toBe('');
  });

  test('handles null/undefined', () => {
    expect(normalizeStoreCompact(null)).toBe('');
    expect(normalizeStoreCompact(undefined)).toBe('');
  });

  test('trims whitespace', () => {
    expect(normalizeStoreCompact('  马己仙  ')).toBe('马己仙');
  });
});

describe('feishuStoreSearchPatterns', () => {
  test('马己仙 store gets multiple patterns', () => {
    const patterns = feishuStoreSearchPatterns('马己仙上海音乐广场店');
    expect(patterns.length).toBeGreaterThanOrEqual(1);
    expect(patterns.some(p => p.includes('马己仙'))).toBe(true);
  });

  test('洪潮 store gets multiple patterns', () => {
    const patterns = feishuStoreSearchPatterns('洪潮大宁久光店');
    expect(patterns.some(p => p.includes('洪潮'))).toBe(true);
    expect(patterns.some(p => p.includes('大宁久光'))).toBe(true);
  });

  test('unknown store returns generic pattern', () => {
    const patterns = feishuStoreSearchPatterns('测试门店');
    expect(patterns.length).toBeGreaterThanOrEqual(1);
    expect(patterns[0]).toContain('测试门店');
  });

  test('empty input returns catch-all', () => {
    const patterns = feishuStoreSearchPatterns('');
    expect(patterns).toEqual(['%']);
  });
});
