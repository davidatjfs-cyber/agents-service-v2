import { dispatchTask } from '../master-agent-dispatcher.js';

describe('master-agent-dispatcher', () => {
  test('routes hygiene tasks to ops supervisor', () => {
    expect(dispatchTask({ category: 'hygiene' }).assigneeAgent).toBe('ops_supervisor');
  });

  test('routes marketing tasks to marketing planner', () => {
    expect(dispatchTask({ category: 'marketing' }).assigneeAgent).toBe('marketing_planner');
  });

  test('falls general tasks back to ops supervisor with lower confidence', () => {
    const result = dispatchTask({ category: 'general' });
    expect(result.assigneeAgent).toBe('ops_supervisor');
    expect(result.confidence).toBeLessThan(0.9);
  });
});
