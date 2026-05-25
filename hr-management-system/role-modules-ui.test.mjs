import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('./role-modules-ui.js', import.meta.url), 'utf8');

function loadContext(checkedPairs, serverRoleModules = {}) {
  const boxes = checkedPairs.map(([role, page]) => ({
    checked: true,
    dataset: { role, page },
  }));
  const context = {
    _serverRoleModules: serverRoleModules,
    _defaultRoleModules: {},
    document: {
      getElementById() {
        return null;
      },
      querySelectorAll(selector) {
        if (selector === '#role-modules-grid input[type=checkbox]') return boxes;
        return [];
      },
    },
  };
  vm.createContext(context);
  vm.runInContext(source, context);
  return context;
}

test('collectRoleModulesFromUI preserves unedited role config while adding front_manager selections', () => {
  const ctx = loadContext(
    [
      ['front_manager', 'daily-report'],
      ['store_manager', 'approvals'],
    ],
    {
      admin: ['users', 'reports'],
    }
  );

  const collected = ctx.collectRoleModulesFromUI();
  assert.deepEqual(JSON.parse(JSON.stringify(collected.admin)), ['users', 'reports']);
  assert.deepEqual(JSON.parse(JSON.stringify(collected.front_manager)), ['daily-report']);
  assert.deepEqual(JSON.parse(JSON.stringify(collected.store_manager)), ['approvals']);
});
