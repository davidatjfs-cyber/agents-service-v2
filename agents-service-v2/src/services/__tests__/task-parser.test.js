import { parseTaskText, mapBoardStatus } from '../task-parser.js';

describe('task-parser', () => {
  test('parses hygiene整改 task with store and deadline', () => {
    const parsed = parseTaskText('洪潮的卫生太差了，请督促门店2周内整改完成');
    expect(parsed.category).toBe('hygiene');
    expect(parsed.store).toBe('洪潮');
    expect(parsed.priority).toBe('high');
    expect(parsed.deadline).toEqual({ type: 'relative_days', days: 14 });
    expect(parsed.evidenceRequirements[0].type).toBe('photo');
  });

  test('maps internal statuses to board statuses', () => {
    expect(mapBoardStatus('pending_audit')).toBe('待解析');
    expect(mapBoardStatus('pending_dispatch')).toBe('待分配');
    expect(mapBoardStatus('dispatched')).toBe('执行中');
    expect(mapBoardStatus('pending_review')).toBe('待验收');
    expect(mapBoardStatus('closed')).toBe('已完成');
  });

  test('does not include category word in extracted store name', () => {
    const parsed = parseTaskText('洪潮卫生整改任务');
    expect(parsed.store).toBe('洪潮');
  });
});
