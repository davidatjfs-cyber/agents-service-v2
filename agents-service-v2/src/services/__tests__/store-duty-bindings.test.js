import { jest } from '@jest/globals';

const queryMock = jest.fn();

jest.unstable_mockModule('../../utils/db.js', () => ({
  query: queryMock,
  __esModule: true,
}));

const {
  dutyCategoryToReceiveFlag,
  normalizeDutyStore,
  resolveDutyBoundRecipients,
} = await import('../store-duty-bindings.js');

describe('store-duty-bindings', () => {
  beforeEach(() => {
    queryMock.mockReset();
  });

  test('maps category to receive flag', () => {
    expect(dutyCategoryToReceiveFlag('ops')).toBe('can_receive_ops');
    expect(dutyCategoryToReceiveFlag('performance')).toBe('can_receive_performance');
    expect(dutyCategoryToReceiveFlag('food_safety')).toBe('can_receive_food_safety');
    expect(dutyCategoryToReceiveFlag('approval')).toBe('can_receive_approval');
  });

  test('normalizes store aliases for matching', () => {
    expect(normalizeDutyStore(' 马己仙 上海音乐广场店 ')).toBe('马己仙上海音乐广场店');
    expect(normalizeDutyStore('洪潮 大宁 久光店')).toBe('洪潮大宁久光店');
  });

  test('prefers active duty bindings over legacy role lookup', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          {
            username: 'NNYXYF26',
            open_id: 'ou_yf',
            role: 'store_manager',
            store: '马己仙上海音乐广场店',
            access_level: 'primary',
            can_receive_ops: true,
          },
          {
            username: 'THL001',
            open_id: 'ou_thl',
            role: 'front_manager',
            store: '马己仙上海音乐广场店',
            access_level: 'support',
            can_receive_ops: true,
          },
        ],
      });

    const rows = await resolveDutyBoundRecipients({
      store: '马己仙上海音乐广场店',
      category: 'ops',
      fallbackRoles: ['store_manager'],
    });

    expect(rows.map((row) => row.username)).toEqual(['NNYXYF26', 'THL001']);
    expect(queryMock).toHaveBeenCalledTimes(3);
  });

  test('falls back to feishu_users role lookup when no duty binding exists', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          {
            username: 'NNYXYF26',
            open_id: 'ou_yf',
            role: 'store_manager',
            store: '洪潮大宁久光店',
          },
        ],
      });

    const rows = await resolveDutyBoundRecipients({
      store: '洪潮大宁久光店',
      category: 'ops',
      fallbackRoles: ['store_manager'],
    });

    expect(rows).toHaveLength(1);
    expect(rows[0].username).toBe('NNYXYF26');
    expect(queryMock).toHaveBeenCalledTimes(2);
  });

  test('approval recipients exclude non-approval collaborators', async () => {
    queryMock.mockResolvedValueOnce({
      rows: [
        {
          username: 'NNYXYF26',
          open_id: 'ou_yf',
          role: 'store_manager',
          store: '马己仙上海音乐广场店',
          access_level: 'primary',
          can_receive_approval: true,
        },
      ],
    });

    const rows = await resolveDutyBoundRecipients({
      store: '马己仙上海音乐广场店',
      category: 'approval',
      fallbackRoles: ['store_manager'],
    });

    expect(rows.map((row) => row.username)).toEqual(['NNYXYF26']);
  });
});
