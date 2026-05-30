import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildConfiguredApprovalAssignees,
  resolveStoreApprovalRoleUsername,
} from './approval-assignee-resolution.js';

test('resolveStoreApprovalRoleUsername prefers duty binding approver for store-manager approvals', async () => {
  const state = {
    employees: [
      { username: 'old-maji-manager', role: 'store_manager', store: '马己仙上海音乐广场店', status: 'active' },
      { username: 'yufeng', role: 'store_manager', store: '洪潮大宁久光店', status: 'active' },
    ],
  };

  const assignee = await resolveStoreApprovalRoleUsername(
    state,
    '马己仙上海音乐广场店',
    ['store_manager'],
    async (store) => (store === '马己仙上海音乐广场店' ? 'yufeng' : '')
  );

  assert.equal(assignee, 'yufeng');
});

test('buildConfiguredApprovalAssignees resolves store_manager against the applicant store', async () => {
  const state = {
    approvalFlows: {
      leave: {
        steps: ['store_manager', 'hr_manager'],
      },
    },
    employees: [
      { username: 'old-maji-manager', role: 'store_manager', store: '马己仙上海音乐广场店', status: 'active' },
      { username: 'hr-boss', role: 'hr_manager', store: '总部', status: 'active' },
      { username: 'yufeng', role: 'store_manager', store: '洪潮大宁久光店', status: 'active' },
    ],
  };

  const assignees = await buildConfiguredApprovalAssignees(
    state,
    'leave',
    {
      applicantStore: '马己仙上海音乐广场店',
      hrManagerUsername: 'hr-boss',
      state,
    },
    async (store) => (store === '马己仙上海音乐广场店' ? 'yufeng' : '')
  );

  assert.deepEqual(assignees, ['yufeng', 'hr-boss']);
});
