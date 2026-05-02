/**
 * 出餐超时报表投递测试
 */
import { jest } from '@jest/globals';

const mockQuery = jest.fn();
const mockSendCard = jest.fn();
const mockSendReportToRecipient = jest.fn();
const mockAxiosPost = jest.fn();
const mockAxiosGet = jest.fn();

jest.unstable_mockModule('../../utils/db.js', () => ({
  query: (...args) => mockQuery(...args),
  __esModule: true,
}));

jest.unstable_mockModule('../../utils/logger.js', () => ({
  logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn() },
  __esModule: true,
}));

jest.unstable_mockModule('../feishu-client.js', () => ({
  sendCard: (...args) => mockSendCard(...args),
  __esModule: true,
}));

jest.unstable_mockModule('../report-delivery.js', () => ({
  getShanghaiYmd: () => '2026-05-02',
  sendReportToRecipient: (...args) => mockSendReportToRecipient(...args),
  __esModule: true,
}));

jest.unstable_mockModule('../../utils/anomaly-week-bounds.js', () => ({
  shanghaiLastCompletedWeekBounds: () => ({ weekStart: '2026-04-20', weekEnd: '2026-04-26' }),
  getShanghaiYmdParts: () => ({ y: 2026, m: 5, d: 2 }),
  addDaysYmdShanghai: () => '2026-04-30',
  __esModule: true,
}));

jest.unstable_mockModule('axios', () => ({
  default: {
    post: (...args) => mockAxiosPost(...args),
    get: (...args) => mockAxiosGet(...args),
  },
  __esModule: true,
}));

const { generateCookingTimeoutWeeklyReport } = await import('../cooking-timeout-report.js');

describe('generateCookingTimeoutWeeklyReport', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockSendCard.mockReset();
    mockSendReportToRecipient.mockReset();
    mockAxiosPost.mockReset();
    mockAxiosGet.mockReset();
  });

  test('飞书卡片发送失败时不把报表投递误记为成功', async () => {
    mockAxiosPost.mockResolvedValue({ data: { tenant_access_token: 'token' } });
    mockAxiosGet.mockResolvedValue({
      data: {
        code: 0,
        data: {
          items: [
            {
              fields: {
                营业日期: '2026-04-21',
                菜品名称: '招牌菜',
                出品次数: 10,
                菜品制作超时次数: 2,
              },
            },
          ],
          has_more: false,
        },
      },
    });
    mockQuery.mockResolvedValue({
      rows: [{ open_id: 'ou_fail', username: 'manager1' }],
    });
    mockSendCard.mockResolvedValue({ ok: false, error: 'external_disabled' });
    mockSendReportToRecipient.mockImplementation(async ({ sendFn }) => {
      const r = await sendFn();
      return { ok: !!r?.ok, error: r?.error || '' };
    });

    const result = await generateCookingTimeoutWeeklyReport();

    expect(mockSendReportToRecipient).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(false);
    expect(result.okCount).toBe(0);
    expect(result.errCount).toBe(1);
  });
});
