import { computePllmSlots } from '../proactive-llm-actions.js';

describe('computePllmSlots', () => {
  test('按 open cap 和 batch cap 共同限流', () => {
    expect(computePllmSlots(0, 3, 2)).toBe(2);
    expect(computePllmSlots(2, 3, 2)).toBe(1);
    expect(computePllmSlots(3, 3, 2)).toBe(0);
  });
});
