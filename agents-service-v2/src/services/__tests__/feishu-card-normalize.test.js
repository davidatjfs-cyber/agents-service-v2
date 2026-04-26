import { normalizeCardActionBody } from '../feishu-client.js';

describe('normalizeCardActionBody', () => {
  test('兼容 schema 2.0 operator.operator_id.open_id', () => {
    const payload = {
      schema: '2.0',
      event: {
        operator: { operator_id: { open_id: 'ou_test_1' } },
        action: { value: { action: 'pllm_execute', taskId: 'PLLM-1' } }
      }
    };
    const r = normalizeCardActionBody(payload);
    expect(r.open_id).toBe('ou_test_1');
    expect(r.action?.value?.action).toBe('pllm_execute');
  });
});
