import { describe, expect, it } from 'vitest';
import {
  newestWorkspaceQueueSnapshot,
  reconcileWorkspaceQueueSnapshot
} from '../../src/service/WorkspaceQueueProjectionService.js';

describe('Public Queue Snapshot Convergence', () => {
  it('The Watch initial state and real-time events of the queue are unified by version, and the old source cannot overwrite the new state', () => {
    const current = { version: 3, paused: false, items: [] };
    const stale = { version: 2, paused: true, items: [] };
    const duplicate = { version: 3, paused: true, items: [] };
    const latest = { version: 4, paused: true, items: [] };

    expect(newestWorkspaceQueueSnapshot(current, stale)).toBe(current);
    expect(newestWorkspaceQueueSnapshot(current, duplicate)).toBe(current);
    expect(newestWorkspaceQueueSnapshot(current, latest)).toBe(latest);
  });

  it('initial queue snapshot matching Session Watch unconditionally overwrites local legacy', () => {
    const staleLocal = {
      version: 8,
      paused: true,
      items: [{ queueItemId: 'stale-item', clientMessageId: 'stale-message' }]
    };
    const authoritativeInitial = { version: 0, paused: false, items: [] };

    expect(
      reconcileWorkspaceQueueSnapshot(staleLocal as never, authoritativeInitial, 'initial')
    ).toBe(authoritativeInitial);
    expect(
      reconcileWorkspaceQueueSnapshot(staleLocal as never, authoritativeInitial, 'event')
    ).toBe(staleLocal);
  });
});
