import { ref } from 'vue';
import { workspaceTargetRef } from './support/workspace-fixture.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createWorkbenchSelectionPersistenceService } from '../../src/service/workbench-selection-persistence-service.js';
import { ApiError } from '../../src/util/api-error.js';

function setup(sessionId: string | undefined = 'saved') {
  const values = new Map<string, string>();
  const stored = { nodeId: 'n', workspaceId: 'w', ...(sessionId ? { sessionId } : {}) };
  values.set('mar.workbench.selection.v1', JSON.stringify(stored));
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key)
  });
  vi.stubGlobal('window', {
    location: { search: '', href: 'http://localhost/console' },
    history: { replaceState: vi.fn() }
  });
  const selectedNodeId = ref<string>();
  const selectedWorkspaceId = ref<string>();
  const selectedSessionId = { value: undefined as string | undefined };
  const sessions = { value: [{ id: 'first', workspaceId: 'w', externalSessionId: 'first' }] };
  const lookupSession = vi.fn(async () => ({
    id: 'saved',
    workspaceId: 'w',
    externalSessionId: 'saved'
  }));
  const openSession = vi.fn(async (id: string) => {
    selectedSessionId.value = id;
  });
  const openDraft = vi.fn();
  const synchronizeSessions = vi.fn(async () => sessions.value);
  const notice = vi.fn();
  let revision = 0;
  const activateWorkspace = vi.fn(async () => {
    selectedNodeId.value = 'n';
    selectedWorkspaceId.value = 'w';
    return true;
  });
  const service = createWorkbenchSelectionPersistenceService({
    nodes: { value: [{ id: 'n' }] } as never,
    sessions: sessions as never,
    workspaceTarget: workspaceTargetRef(selectedNodeId, selectedWorkspaceId),
    selectedSessionId: selectedSessionId as never,
    isWorkbenchActive: () => true,
    activateWorkspace,
    synchronizeSessions: synchronizeSessions as never,
    openSession,
    lookupSession: lookupSession as never,
    openDraft,
    notice,
    currentSelectionRevision: () => revision
  });
  return {
    service,
    values,
    stored,
    sessions,
    selectedSessionId,
    selectedWorkspaceId,
    lookupSession,
    openSession,
    openDraft,
    synchronizeSessions,
    notice,
    activateWorkspace,
    nextRevision: () => {
      revision += 1;
    }
  };
}

describe('Workbench Selection Restoration', () => {
  it('discards a legacy host-only record instead of restoring a foreground Node', async () => {
    const f = setup();
    f.values.set('mar.workbench.selection.v1', JSON.stringify({ nodeId: 'n' }));
    await f.service.restore();
    expect(f.values.has('mar.workbench.selection.v1')).toBe(false);
    expect(f.activateWorkspace).not.toHaveBeenCalled();
  });

  afterEach(() => vi.unstubAllGlobals());

  it('Restores saved sessions beyond the first page by looking them up by identity', async () => {
    const f = setup();
    await f.service.restore();
    expect(f.lookupSession).toHaveBeenCalledWith('n', 'saved');
    expect(f.openSession).toHaveBeenCalledWith('saved');
    expect(f.openDraft).not.toHaveBeenCalled();
  });

  it.each(['SESSION_NOT_FOUND', 'FORBIDDEN'])(
    'Fallback to first session after confirming %s',
    async (code) => {
      const f = setup();
      f.lookupSession.mockRejectedValue(new ApiError(code, 'Unavailable'));
      await f.service.restore();
      expect(f.openSession).toHaveBeenCalledWith('first');
    }
  );

  it('Resume the first session when the session is not saved', async () => {
    const f = setup('');
    await f.service.restore();
    expect(f.openSession).toHaveBeenCalledWith('first');
  });

  it('Falls back to the first session when the target belongs to another Workspace', async () => {
    const f = setup();
    f.lookupSession.mockResolvedValue({
      id: 'saved',
      workspaceId: 'other',
      externalSessionId: 'saved'
    });
    await f.service.restore();
    expect(f.openSession).toHaveBeenCalledWith('first');
  });

  it('Opens a new session only after confirming the target is invalid and the list is empty', async () => {
    const f = setup();
    f.sessions.value = [];
    f.lookupSession.mockRejectedValue(new ApiError('SESSION_NOT_FOUND', 'Missing'));
    await f.service.restore();
    expect(f.openSession).not.toHaveBeenCalled();
    expect(f.openDraft).toHaveBeenCalledOnce();
  });

  it('Falls back to the first item from the current authoritative list, not the stale cached first item', async () => {
    const f = setup();
    f.lookupSession.mockRejectedValue(new ApiError('SESSION_NOT_FOUND', 'Missing'));
    f.synchronizeSessions.mockResolvedValue([
      { id: 'authoritative-first', workspaceId: 'w', externalSessionId: 'native-first' }
    ]);
    await f.service.restore();
    expect(f.openSession).toHaveBeenCalledWith('authoritative-first');
  });

  it('Does not restore a stale cached session when the authoritative list is empty', async () => {
    const f = setup();
    f.lookupSession.mockRejectedValue(new ApiError('SESSION_NOT_FOUND', 'Missing'));
    f.synchronizeSessions.mockResolvedValue([]);
    await f.service.restore();
    expect(f.openSession).not.toHaveBeenCalled();
    expect(f.openDraft).toHaveBeenCalledOnce();
  });

  it('persists a new session selection immediately while an older restoration is still pending', async () => {
    const f = setup();
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.lookupSession.mockImplementation(async () => {
      await pending;
      return { id: 'saved', workspaceId: 'w', externalSessionId: 'saved' };
    });
    const restoring = f.service.restore();
    try {
      await vi.waitFor(() => expect(f.lookupSession).toHaveBeenCalledOnce());
      f.selectedSessionId.value = 'user-choice';
      f.nextRevision();
      f.service.persist();
      expect(JSON.parse(f.values.get('mar.workbench.selection.v1') ?? '{}').sessionId).toBe(
        'user-choice'
      );
    } finally {
      release();
      await restoring;
    }
    expect(f.openSession).not.toHaveBeenCalled();
  });

  it('Preserves the persistent target after a network failure instead of treating the list as empty', async () => {
    const f = setup();
    f.lookupSession.mockRejectedValue(new TypeError('Network unavailable'));
    await f.service.restore();
    expect(f.openDraft).not.toHaveBeenCalled();
    expect(f.openSession).not.toHaveBeenCalled();
    expect(JSON.parse(f.values.get('mar.workbench.selection.v1')!)).toEqual({
      workspace: { nodeId: 'n', workspaceId: 'w' },
      sessionId: 'saved'
    });
    expect(f.notice).toHaveBeenCalledOnce();
  });

  it('Syncing menu state before restoration does not clear the saved selection', async () => {
    const f = setup();
    f.service.persist();
    expect(f.values.get('mar.workbench.selection.v1')).toBe(JSON.stringify(f.stored));
    await f.service.restore();
    expect(f.openSession).toHaveBeenCalledWith('saved');
  });

  it('Does not overwrite a new selection after the user switches sessions during identity lookup', async () => {
    const f = setup();
    f.lookupSession.mockImplementation(async () => {
      f.selectedSessionId.value = 'user-choice';
      return { id: 'saved', workspaceId: 'w', externalSessionId: 'saved' };
    });
    await f.service.restore();
    expect(f.openSession).not.toHaveBeenCalled();
    expect(f.selectedSessionId.value).toBe('user-choice');
  });

  it('Does not reclaim the selection after the user explicitly creates a new session during identity lookup', async () => {
    const f = setup();
    f.lookupSession.mockImplementation(async () => {
      f.nextRevision();
      return { id: 'saved', workspaceId: 'w', externalSessionId: 'saved' };
    });
    await f.service.restore();
    expect(f.openSession).not.toHaveBeenCalled();
    expect(f.openDraft).not.toHaveBeenCalled();
  });

  it('A list-read failure after an invalid session does not incorrectly fall back to a new draft', async () => {
    const f = setup();
    f.lookupSession.mockRejectedValue(new ApiError('SESSION_NOT_FOUND', 'Missing'));
    f.synchronizeSessions.mockRejectedValue(new TypeError('Network unavailable'));
    await f.service.restore();
    f.service.persist();
    expect(f.openDraft).not.toHaveBeenCalled();
    expect(JSON.parse(f.values.get('mar.workbench.selection.v1')!)).toEqual({
      workspace: { nodeId: 'n', workspaceId: 'w' },
      sessionId: 'saved'
    });
  });

  it('Preserves the previous selection when Node has not loaded the Workspace successfully', async () => {
    const f = setup();
    f.activateWorkspace.mockImplementation(async () => false);
    await f.service.restore();
    f.service.persist();
    expect(f.values.get('mar.workbench.selection.v1')).toBe(JSON.stringify(f.stored));
    expect(f.openDraft).not.toHaveBeenCalled();
  });

  it.each(['draft:local', 'bootstrap'])('Does not persist temporary session %s', (id) => {
    const f = setup();
    f.selectedWorkspaceId.value = 'w';
    f.sessions.value = [{ id, workspaceId: 'w', externalSessionId: '' }];
    // Activate the workspace through the same restore entry before testing selection persistence.
    return f.service.restore().then(() => {
      f.selectedSessionId.value = id;
      f.service.persist();
      expect(JSON.parse(f.values.get('mar.workbench.selection.v1') ?? '{}')).not.toHaveProperty(
        'sessionId'
      );
    });
  });
});
