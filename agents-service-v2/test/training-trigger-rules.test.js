import { jest } from '@jest/globals';

const queryMock = jest.fn();
const createTaskMock = jest.fn();
const resolveSingleScoringUserMock = jest.fn();
const sendCompanyNoticeToAssigneesMock = jest.fn();

jest.unstable_mockModule('../src/utils/db.js', () => ({
  query: queryMock
}));

jest.unstable_mockModule('../src/services/task-state-machine.js', () => ({
  createTask: createTaskMock
}));

jest.unstable_mockModule('../src/utils/scoring-assignee.js', () => ({
  resolveSingleScoringUser: resolveSingleScoringUserMock
}));

jest.unstable_mockModule('../src/services/feishu-client.js', () => ({
  sendCompanyNoticeToAssignees: sendCompanyNoticeToAssigneesMock
}));

jest.unstable_mockModule('../src/utils/logger.js', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn()
  }
}));

const { checkAndTriggerTraining } = await import('../src/services/chairman/training-trigger-rules.js');

describe('checkAndTriggerTraining', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('sends a notice after creating a triggered training task', async () => {
    queryMock
      .mockResolvedValueOnce({
        rows: [{
          data: {
            training_map: { enabled: true },
            proactive_rules: { dispatchDefaults: { assignee: true, management: false } }
          }
        }]
      })
      .mockResolvedValueOnce({ rows: [{ brand: '测试品牌' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ cnt: '2' }] });
    resolveSingleScoringUserMock.mockResolvedValue({ username: 'store_manager_1' });
    createTaskMock.mockResolvedValue({ ok: true, taskId: 'MT-test-1' });
    sendCompanyNoticeToAssigneesMock.mockResolvedValue({ targets: 1, sentCards: 1 });

    const result = await checkAndTriggerTraining('bad_review_service', '测试门店', 'medium');

    expect(result).toEqual({ triggered: true, taskId: 'MT-test-1', course: '服务流程SOP' });
    expect(createTaskMock).toHaveBeenCalledWith(expect.objectContaining({
      source: 'training_trigger',
      store: '测试门店',
      title: '培训任务: 服务流程SOP',
      sourceData: expect.objectContaining({
        content: '迎宾→入座→点餐→上菜→结账全流程'
      })
    }));
    expect(sendCompanyNoticeToAssigneesMock).toHaveBeenCalledWith(
      expect.objectContaining({ task_id: 'MT-test-1' }),
      expect.stringContaining('培训内容：迎宾→入座→点餐→上菜→结账全流程'),
      expect.objectContaining({ type: 'training_trigger_notice' })
    );
  });
});
