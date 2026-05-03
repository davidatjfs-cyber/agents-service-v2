import { resolveClaimAgent } from '../agent-task-board-api.js';

describe('resolveClaimAgent', () => {
  test('rejects non-admin attempts to claim as another agent', () => {
    const result = resolveClaimAgent({
      body: { agent: 'ops_supervisor' },
      user: { username: 'store_user', role: 'store_manager' }
    });

    expect(result).toEqual({ ok: false, status: 403, error: 'claim_agent_forbidden' });
  });

  test('uses the authenticated username for non-admin claims', () => {
    const result = resolveClaimAgent({
      body: {},
      user: { username: 'ops_supervisor', role: 'agent' }
    });

    expect(result).toEqual({ ok: true, agentKey: 'ops_supervisor' });
  });

  test('allows admins to claim on behalf of a specific agent', () => {
    const result = resolveClaimAgent({
      body: { agent: 'ops_supervisor' },
      user: { username: 'admin', role: 'admin' }
    });

    expect(result).toEqual({ ok: true, agentKey: 'ops_supervisor' });
  });
});
