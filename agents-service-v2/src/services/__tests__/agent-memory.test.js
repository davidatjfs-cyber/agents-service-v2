/**
 * Agent Memory 单元测试 — buildMemoryContextBlock
 */
import { jest } from '@jest/globals';

const mockQuery = jest.fn();

jest.unstable_mockModule('../../utils/db.js', () => ({
  query: (...args) => mockQuery(...args),
  __esModule: true,
}));

jest.unstable_mockModule('../../utils/logger.js', () => ({
  logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn() },
  __esModule: true,
}));

const { buildMemoryContextBlock } = await import('../agent-memory.js');

describe('buildMemoryContextBlock', () => {
  beforeEach(() => {
    mockQuery.mockReset();
  });

  test('store为空返回空字符串', async () => {
    const r = await buildMemoryContextBlock('test_agent', '', '');
    expect(r).toBe('');
  });

  test('无历史记录返回空字符串', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ total: 0, avg_score: null, success_count: 0 }] });
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const r = await buildMemoryContextBlock('test_agent', '门店A', '');
    expect(r).toBe('');
  });

  test('有成功率时输出统计文本', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ total: 10, avg_score: '7.5', success_count: 7 }] });
    mockQuery.mockResolvedValueOnce({ rows: [{ content: '上周建议增加午市套餐' }] });

    const r = await buildMemoryContextBlock('test_agent', '门店A', '');
    expect(r).toContain('历史执行统计');
    expect(r).toContain('共10条建议');
    expect(r).toContain('成功率70%');
    expect(r).toContain('近期记录');
    expect(r).toContain('上周建议增加午市套餐');
  });

  test('有记忆但无outcome时只出近期记录', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ total: 0, avg_score: null, success_count: 0 }] });
    mockQuery.mockResolvedValueOnce({ rows: [{ content: '历史记录1' }, { content: '历史记录2' }] });

    const r = await buildMemoryContextBlock('test_agent', '门店A', '');
    expect(r).not.toContain('历史执行统计');
    expect(r).toContain('近期记录');
    expect(r).toContain('历史记录1');
  });

  test('数据库错误返回空字符串不抛出', async () => {
    mockQuery.mockRejectedValueOnce(new Error('DB error'));
    mockQuery.mockRejectedValueOnce(new Error('DB error'));

    const r = await buildMemoryContextBlock('test_agent', '门店A', '');
    expect(r).toBe('');
  });

  test('不同limit控制记忆返回数量', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ total: 1, avg_score: '8.0', success_count: 1 }] });
    mockQuery.mockResolvedValueOnce({ rows: [{ content: '结果1' }, { content: '结果2' }, { content: '结果3' }] });

    const r = await buildMemoryContextBlock('test_agent', '门店A', '分析', 5);
    expect(r).toContain('历史执行统计');
    expect(r).toContain('近期记录');
  });
});
