/**
 * Feedback Handler 单元测试
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

jest.unstable_mockModule('../llm-provider.js', () => ({
  callDeepSeek: jest.fn().mockResolvedValue({ content: 'AI回答未基于实际数据，虚构了不存在的字段值。' }),
  __esModule: true,
}));

const { handleFeedback } = await import('../feedback-handler.js');

describe('handleFeedback', () => {
  beforeEach(() => {
    mockQuery.mockReset();
  });

  test('非负反馈消息返回handled=false', async () => {
    const r = await handleFeedback('今天的营收数据', 'user1');
    expect(r.handled).toBe(false);
  });

  test('空文本返回handled=false', async () => {
    const r = await handleFeedback('', 'user1');
    expect(r.handled).toBe(false);
  });

  test('空userId返回handled=false', async () => {
    const r = await handleFeedback('不对', '');
    expect(r.handled).toBe(false);
  });

  test('负反馈无历史回答时返回handled=false', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const r = await handleFeedback('不对', 'user1');
    expect(r.handled).toBe(false);
  });

  test('负反馈有历史回答时存档并返回确认', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{
        content: '销售目标设定为0，需要补录目标',
        agent_data: { agent: 'data_auditor', store: '门店A', query: '生意下滑怎么办' },
        created_at: '2026-05-02 10:00:00',
      }]
    });
    // Mock the INSERT for feedback save
    mockQuery.mockResolvedValueOnce({ rowCount: 1 });

    const r = await handleFeedback('你说的完全不对', 'user1');
    expect(r.handled).toBe(true);
    expect(r.reply).toContain('已记录您的反馈');
  });
});
