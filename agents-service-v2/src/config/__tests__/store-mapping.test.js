import {
  normalizeStoreOcrTypos,
  resolveAgentCanonicalStore,
  expandAgentStoreLabels,
  toFeishuStoreName,
  toDrStoreName,
  getAllStoreMappings,
  normalizeAgentMaterialBrand
} from '../store-mapping.js';

describe('normalizeStoreOcrTypos', () => {
  test('replaces 马已仙 with 马己仙', () => {
    expect(normalizeStoreOcrTypos('马已仙上海店')).toBe('马己仙上海店');
  });

  test('passes through correct 马己仙', () => {
    expect(normalizeStoreOcrTypos('马己仙上海音乐广场店')).toBe('马己仙上海音乐广场店');
  });

  test('handles empty/ null input', () => {
    expect(normalizeStoreOcrTypos('')).toBe('');
    expect(normalizeStoreOcrTypos(null)).toBe('');
    expect(normalizeStoreOcrTypos(undefined)).toBe('');
  });
});

describe('resolveAgentCanonicalStore', () => {
  test('resolves 洪潮 variants to canonical', () => {
    expect(resolveAgentCanonicalStore('洪潮')).toBe('洪潮大宁久光店');
    expect(resolveAgentCanonicalStore('洪潮门店')).toBe('洪潮大宁久光店');
    expect(resolveAgentCanonicalStore('大宁久光')).toBe('洪潮大宁久光店');
  });

  test('resolves 马己仙 variants to canonical', () => {
    expect(resolveAgentCanonicalStore('马己仙')).toBe('马己仙上海音乐广场店');
    expect(resolveAgentCanonicalStore('马己仙门店')).toBe('马己仙上海音乐广场店');
    expect(resolveAgentCanonicalStore('音乐广场')).toBe('马己仙上海音乐广场店');
  });

  test('normalizes 马已仙 before resolving', () => {
    expect(resolveAgentCanonicalStore('马已仙')).toBe('马己仙上海音乐广场店');
  });

  test('maps through STORE_TO_FEISHU by full name', () => {
    expect(resolveAgentCanonicalStore('洪潮大宁久光店')).toBe('洪潮大宁久光店');
    expect(resolveAgentCanonicalStore('马己仙上海音乐广场店')).toBe('马己仙上海音乐广场店');
  });

  test('maps through STORE_TO_FEISHU by feishu short name', () => {
    expect(resolveAgentCanonicalStore('洪潮久光店')).toBe('洪潮大宁久光店');
    expect(resolveAgentCanonicalStore('马己仙大宁店')).toBe('马己仙上海音乐广场店');
  });

  test('returns unknown input as-is', () => {
    expect(resolveAgentCanonicalStore('未知门店')).toBe('未知门店');
  });

  test('handles empty input', () => {
    expect(resolveAgentCanonicalStore('')).toBe('');
    expect(resolveAgentCanonicalStore(null)).toBe('');
  });
});

describe('toFeishuStoreName', () => {
  test('maps canonical to feishu short name', () => {
    expect(toFeishuStoreName('洪潮大宁久光店')).toBe('洪潮久光店');
    expect(toFeishuStoreName('马己仙上海音乐广场店')).toBe('马己仙大宁店');
  });

  test('passes through unknown stores', () => {
    expect(toFeishuStoreName('未知门店')).toBe('未知门店');
  });
});

describe('toDrStoreName', () => {
  test('maps feishu short name to canonical', () => {
    expect(toDrStoreName('洪潮久光店')).toBe('洪潮大宁久光店');
    expect(toDrStoreName('马己仙大宁店')).toBe('马己仙上海音乐广场店');
  });

  test('passes through unknown stores', () => {
    expect(toDrStoreName('未知门店')).toBe('未知门店');
  });
});

describe('getAllStoreMappings', () => {
  test('returns the STORE_TO_FEISHU mapping object', () => {
    const m = getAllStoreMappings();
    expect(m['洪潮大宁久光店']).toBe('洪潮久光店');
    expect(m['马己仙上海音乐广场店']).toBe('马己仙大宁店');
  });
});

describe('expandAgentStoreLabels', () => {
  test('returns multiple label variants for known store', () => {
    const labels = expandAgentStoreLabels('洪潮');
    expect(labels.length).toBeGreaterThanOrEqual(2);
    expect(labels).toContain('洪潮大宁久光店');
    expect(labels).toContain('洪潮久光店');
  });

  test('handles unknown store', () => {
    const labels = expandAgentStoreLabels('未知门店');
    expect(labels).toContain('未知门店');
    expect(labels.length).toBe(1);
  });

  test('deduplicates labels', () => {
    const labels = expandAgentStoreLabels('马己仙上海音乐广场店');
    const unique = new Set(labels);
    expect(labels.length).toBe(unique.size);
  });
});

describe('normalizeAgentMaterialBrand', () => {
  test('normalizes majixian to 马己仙', () => {
    expect(normalizeAgentMaterialBrand('majixian')).toBe('马己仙');
    expect(normalizeAgentMaterialBrand('Majixian')).toBe('马己仙');
  });

  test('normalizes hongchao to 洪潮', () => {
    expect(normalizeAgentMaterialBrand('hongchao')).toBe('洪潮');
    expect(normalizeAgentMaterialBrand('Hongchao')).toBe('洪潮');
  });

  test('passes through 马己仙', () => {
    expect(normalizeAgentMaterialBrand('马己仙')).toBe('马己仙');
  });

  test('passes through 洪潮', () => {
    expect(normalizeAgentMaterialBrand('洪潮')).toBe('洪潮');
  });

  test('handles empty input', () => {
    expect(normalizeAgentMaterialBrand('')).toBe('');
    expect(normalizeAgentMaterialBrand(null)).toBe('');
  });

  test('returns unknown brand as-is', () => {
    expect(normalizeAgentMaterialBrand('其他品牌')).toBe('其他品牌');
  });
});
