import { vi } from 'vitest';
import type { StoredSessionShare } from '../../../src/session-shares.js';

export function sessionShareStore() {
  const rows = new Map<string, StoredSessionShare>();
  const store = {
    insert: vi.fn(async (share: StoredSessionShare) => {
      rows.set(share.id, share);
    }),
    get: vi.fn(async (id: string) => rows.get(id)),
    list: vi.fn(async (target: { nodeId: string; workspaceId: string; sessionId: string }) =>
      [...rows.values()].filter(
        (row) =>
          row.nodeId === target.nodeId &&
          row.workspaceId === target.workspaceId &&
          row.sessionId === target.sessionId
      )
    ),
    delete: vi.fn(async (id: string) => rows.delete(id)),
    savePassword: vi.fn(async (id: string, password: string) => {
      const row = rows.get(id);
      if (row === undefined) return false;
      rows.set(id, { ...row, password });
      return true;
    }),
    executionUser: vi.fn(async () => ({ username: 'owner', displayName: 'Owner' })),
    workspaceName: vi.fn(
      async (_nodeId: string, _workspaceId: string): Promise<string | undefined> => 'Project Alpha'
    )
  };
  return { rows, store };
}
