import { detectIntent } from '../intent-classifier.js';

describe('detectIntent', () => {
  test('detects analysis intent for 下降/下滑/异常', () => {
    expect(detectIntent('营收下降了')).toBe('analysis');
    expect(detectIntent('人效下滑严重')).toBe('analysis');
    expect(detectIntent('数据异常')).toBe('analysis');
    expect(detectIntent('有什么问题')).toBe('analysis');
    expect(detectIntent('最近变差了')).toBe('analysis');
    expect(detectIntent('哪里不好')).toBe('analysis');
  });

  test('detects query intent for 多少/数据/报表', () => {
    expect(detectIntent('昨天营收多少')).toBe('query');
    expect(detectIntent('多少单')).toBe('query');
    expect(detectIntent('给我数据')).toBe('query');
    expect(detectIntent('看看情况')).toBe('query');
    expect(detectIntent('报表出来了吗')).toBe('query');
  });

  test('detects strategy intent for 怎么做/优化/提升', () => {
    expect(detectIntent('怎么做')).toBe('strategy');
    expect(detectIntent('怎么办')).toBe('strategy');
    expect(detectIntent('如何优化')).toBe('strategy');
    expect(detectIntent('怎么提升营收')).toBe('strategy');
  });

  test('营销文案 overrides strategy keywords', () => {
    expect(detectIntent('营销文案\n提升营收')).toBe('unknown');
    expect(detectIntent('营销文案\n优化方案')).toBe('unknown');
  });

  test('returns unknown for unrelated text', () => {
    expect(detectIntent('你好')).toBe('unknown');
    expect(detectIntent('谢谢')).toBe('unknown');
    expect(detectIntent('')).toBe('unknown');
    expect(detectIntent(null)).toBe('unknown');
    expect(detectIntent(undefined)).toBe('unknown');
  });
});
