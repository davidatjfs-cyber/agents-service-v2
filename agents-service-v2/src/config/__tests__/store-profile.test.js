import { getStoreProfile, getAllProfiles, buildStoreProfilePromptBlock } from '../store-profile.js';

describe('getStoreProfile', () => {
  test('returns profile for 马己仙 store', () => {
    const p = getStoreProfile('马己仙上海音乐广场店');
    expect(p).not.toBeNull();
    expect(p.brand).toBe('马己仙');
    expect(p.cuisine).toBe('粤菜');
  });

  test('returns profile for 洪潮 store', () => {
    const p = getStoreProfile('洪潮大宁久光店');
    expect(p).not.toBeNull();
    expect(p.brand).toBe('洪潮');
    expect(p.cuisine).toBe('潮汕菜');
  });

  test('resolves short name to canonical store', () => {
    const p = getStoreProfile('马己仙');
    expect(p).not.toBeNull();
    expect(p.brand).toBe('马己仙');
  });

  test('returns null for unknown store', () => {
    expect(getStoreProfile('未知门店')).toBeNull();
  });

  test('handles empty input', () => {
    expect(getStoreProfile('')).toBeNull();
    expect(getStoreProfile(null)).toBeNull();
  });
});

describe('getAllProfiles', () => {
  test('returns both store profiles', () => {
    const profiles = getAllProfiles();
    expect(Object.keys(profiles)).toContain('马己仙上海音乐广场店');
    expect(Object.keys(profiles)).toContain('洪潮大宁久光店');
  });

  test('each profile has required fields', () => {
    const profiles = getAllProfiles();
    for (const [name, p] of Object.entries(profiles)) {
      expect(p).toHaveProperty('brand');
      expect(p).toHaveProperty('cuisine');
      expect(p).toHaveProperty('positioning');
      expect(p).toHaveProperty('topDishes');
    }
  });
});

describe('buildStoreProfilePromptBlock', () => {
  test('returns formatted string for known store', () => {
    const block = buildStoreProfilePromptBlock('马己仙上海音乐广场店');
    expect(block).toContain('门店画像');
    expect(block).toContain('马己仙');
    expect(block).toContain('粤菜');
  });

  test('includes target revenue for 洪潮', () => {
    const block = buildStoreProfilePromptBlock('洪潮大宁久光店');
    expect(block).toContain('日均目标');
    expect(block).toContain('营收23000元');
  });

  test('includes top dishes', () => {
    const block = buildStoreProfilePromptBlock('马己仙上海音乐广场店');
    expect(block).toContain('高毛利招牌');
    expect(block).toContain('白切鸡');
  });

  test('returns empty string for unknown store', () => {
    expect(buildStoreProfilePromptBlock('未知门店')).toBe('');
  });

  test('handles empty input', () => {
    expect(buildStoreProfilePromptBlock('')).toBe('');
  });
});
