import {
  isOpenIdCrossAppFeishuError,
  normalizeMobileForFeishuBatchGet
} from '../feishu-open-id-helpers.js';

describe('feishu-open-id-helpers', () => {
  test('isOpenIdCrossAppFeishuError detects cross-app', () => {
    expect(isOpenIdCrossAppFeishuError(99992361, '')).toBe(true);
    expect(isOpenIdCrossAppFeishuError(0, 'open_id cross app')).toBe(true);
    expect(isOpenIdCrossAppFeishuError(0, 'Open_ID cross app')).toBe(true);
    expect(isOpenIdCrossAppFeishuError(0, 'something else')).toBe(false);
  });

  test('normalizeMobileForFeishuBatchGet', () => {
    expect(normalizeMobileForFeishuBatchGet(' 13800138000 ')).toBe('13800138000');
    expect(normalizeMobileForFeishuBatchGet('+8613800138000')).toBe('13800138000');
    expect(normalizeMobileForFeishuBatchGet('86-13800138000')).toBe('13800138000');
    expect(normalizeMobileForFeishuBatchGet('+441234567890')).toBe('+441234567890');
    expect(normalizeMobileForFeishuBatchGet('')).toBe(null);
  });
});
