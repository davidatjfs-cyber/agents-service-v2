import { extractStoreFromText } from '../src/utils/store-name-in-text.js';

describe('extractStoreFromText', () => {
  test('matches full store name', () => {
    expect(extractStoreFromText('洪潮旗舰店昨日', ['洪潮旗舰店', '马己仙店'])).toBe('洪潮旗舰店');
  });

  test('matches short prefix 洪潮', () => {
    expect(extractStoreFromText('洪潮 出品有问题', ['洪潮久光店', '马己仙店'])).toBe('洪潮久光店');
  });
});
