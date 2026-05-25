import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildStoreAccessContext,
  canAccessApprovalCenter,
  canViewEmployeesForRole,
  pickEffectiveStore,
} from './store-duty-bindings.js';

test('buildStoreAccessContext keeps primary store first and exposes allowed stores', () => {
  const ctx = buildStoreAccessContext({
    role: 'store_manager',
    stateStore: '洪潮大宁久光店',
    dutyRows: [
      { store: '马己仙上海音乐广场店', is_primary_store: false },
      { store: '洪潮大宁久光店', is_primary_store: true },
    ],
  });

  assert.equal(ctx.primaryStore, '洪潮大宁久光店');
  assert.deepEqual(ctx.allowedStores, ['洪潮大宁久光店', '马己仙上海音乐广场店']);
  assert.equal(ctx.currentStore, '洪潮大宁久光店');
});

test('front_manager stays out of approvals and employee visibility', () => {
  const ctx = buildStoreAccessContext({
    role: 'front_manager',
    stateStore: '马己仙上海音乐广场店',
    dutyRows: [
      {
        store: '马己仙上海音乐广场店',
        is_primary_store: true,
        can_approve_hrms: false,
        can_view_employees: false,
      },
    ],
  });

  assert.equal(canAccessApprovalCenter('front_manager', ctx), false);
  assert.equal(canViewEmployeesForRole('front_manager', ctx), false);
});

test('pickEffectiveStore only accepts allowed stores', () => {
  const ctx = buildStoreAccessContext({
    role: 'store_manager',
    stateStore: '洪潮大宁久光店',
    dutyRows: [
      { store: '洪潮大宁久光店', is_primary_store: true },
      { store: '马己仙上海音乐广场店', is_primary_store: false },
    ],
  });

  assert.equal(pickEffectiveStore(ctx, '马己仙上海音乐广场店'), '马己仙上海音乐广场店');
  assert.equal(pickEffectiveStore(ctx, '不存在的门店'), '洪潮大宁久光店');
});
