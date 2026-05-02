/**
 * Agent Helper 单元测试
 */
import { jest } from '@jest/globals';

const mockDispatchToAgent = jest.fn();

jest.unstable_mockModule('../agent-handlers.js', () => ({
  dispatchToAgent: (...args) => mockDispatchToAgent(...args),
  __esModule: true,
}));

const { requestAgent, resetCircularGuard } = await import('../agent-helper.js');

describe('requestAgent', () => {
  beforeEach(() => {
    mockDispatchToAgent.mockReset();
    resetCircularGuard();
  });

  test('缺少必要参数返回error', async () => {
    const r1 = await requestAgent('', 'train_advisor', '问', { store: '店A' });
    expect(r1.ok).toBe(false);
    expect(r1.error).toContain('missing');

    const r2 = await requestAgent('ops', '', '问', { store: '店A' });
    expect(r2.ok).toBe(false);
    expect(r2.error).toContain('missing');

    const r3 = await requestAgent('ops', 'train_advisor', '问', { store: '' });
    expect(r3.ok).toBe(false);
    expect(r3.error).toContain('missing');
  });

  test('正常请求返回agent结果', async () => {
    mockDispatchToAgent.mockResolvedValue({ response: 'SOP标准：开档需检查温度', data: 'some data' });

    const r = await requestAgent('ops_supervisor', 'train_advisor', '开档SOP是什么', { store: '洪潮大宁久光店' });
    expect(r.ok).toBe(true);
    expect(r.response).toContain('SOP标准');
  });

  test('循环检测阻止重复请求', async () => {
    mockDispatchToAgent.mockResolvedValue({ response: 'ok' });

    const r1 = await requestAgent('ops_supervisor', 'train_advisor', '问', { store: '店A' });
    expect(r1.ok).toBe(true);

    const r2 = await requestAgent('ops_supervisor', 'train_advisor', '问', { store: '店A' });
    expect(r2.ok).toBe(false);
    expect(r2.error).toBe('circular_request');
  });

  test('不同store的相同链路不被循环阻止', async () => {
    mockDispatchToAgent.mockResolvedValue({ response: 'ok' });

    const r1 = await requestAgent('ops', 'train_advisor', '问', { store: '店A' });
    expect(r1.ok).toBe(true);

    const r2 = await requestAgent('ops', 'train_advisor', '问', { store: '店B' });
    expect(r2.ok).toBe(true);
  });

  test('dispatchToAgent失败时返回error', async () => {
    mockDispatchToAgent.mockRejectedValue(new Error('LLM调用失败'));

    const r = await requestAgent('ops_supervisor', 'train_advisor', '问', { store: '店A' });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('LLM调用失败');
  });

  test('超时返回error', async () => {
    mockDispatchToAgent.mockImplementation(() => new Promise(res => setTimeout(res, 200)));

    const r = await requestAgent('ops', 'train_advisor', '问', { store: '店A' }, 50);
    expect(r.ok).toBe(false);
    expect(r.error).toBe('timeout');
  });
});
