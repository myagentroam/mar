import { describe, expect, it, vi } from 'vitest';
import type { NodeAgentSession } from '../../src/database.js';
import { PromptCompletionWorkspaceSource } from '../../src/service/prompt-completion-workspace-source.js';

function fixture() {
  const session = {
    id: 'session',
    workspaceId: 'workspace',
    runner: 'codex',
    lastActivityAt: 1
  } as NodeAgentSession;
  const observed = vi.fn(() => true);
  const resolveSession = vi.fn(async () => session);
  const cachedSessions = vi.fn(() => [session]);
  const readHistory = vi.fn(async (_session: NodeAgentSession, _limit: number) => ({
    turns: [],
    nextCursor: null,
    source: 'runtime' as const,
    snapshotSequence: 1,
    readAt: 1,
    latestVisibleAt: 0
  }));
  const source = new PromptCompletionWorkspaceSource({
    requireWorkspace: vi.fn(),
    observesWorkspace: observed,
    observesSession: observed,
    resolveSession,
    cachedSessions,
    readHistory
  });
  const input = {
    target: { kind: 'WORKSPACE' as const, workspaceId: 'workspace' },
    runner: 'codex' as const,
    sessionId: 'session',
    workbenchConnectionId: 'connection',
    pageEpoch: 'page'
  };
  const actor = { userId: 7, sessionHash: 'owner' };
  return { source, input, actor, session, observed, resolveSession, cachedSessions, readHistory };
}

describe('PromptCompletionWorkspaceSource', () => {
  it('uses the selected Workspace and Runner and does not create a Session for an empty Composer', async () => {
    const f = fixture();
    const signal = new AbortController().signal;
    expect(await f.source.readPage({ ...f.input, sessionId: null }, f.actor, signal)).toEqual([]);
    expect(f.resolveSession).not.toHaveBeenCalled();
    expect(f.readHistory).not.toHaveBeenCalled();
    f.resolveSession.mockResolvedValue({ ...f.session, workspaceId: 'other' });
    await expect(f.source.readPage(f.input, f.actor, signal)).rejects.toThrow(
      'PROMPT_COMPLETION_CONTEXT_UNAVAILABLE'
    );
    f.resolveSession.mockResolvedValue({ ...f.session, runner: 'opencode' });
    await expect(f.source.readPage(f.input, f.actor, signal)).rejects.toThrow(
      'PROMPT_COMPLETION_CONTEXT_UNAVAILABLE'
    );
    expect(f.readHistory).not.toHaveBeenCalled();
  });

  it('rechecks the observation after asynchronous reads', async () => {
    const f = fixture();
    f.readHistory.mockImplementationOnce(async () => {
      f.observed.mockReturnValue(false);
      return {
        turns: [],
        nextCursor: null,
        source: 'runtime',
        snapshotSequence: 1,
        readAt: 1,
        latestVisibleAt: 0
      };
    });
    await expect(f.source.readPage(f.input, f.actor, new AbortController().signal)).rejects.toThrow(
      'PROMPT_COMPLETION_CONTEXT_UNAVAILABLE'
    );
    expect(f.readHistory).toHaveBeenCalledExactlyOnceWith(f.session, 20);
  });

  it('reads five recent catalog entries to reserve an exclusion slot without scanning another workspace', async () => {
    const f = fixture();
    f.cachedSessions.mockReturnValue([
      { ...f.session, id: 'wrong-workspace', workspaceId: 'other', lastActivityAt: 100 },
      { ...f.session, id: 'deleted', externalDiscovered: false, lastActivityAt: 99 },
      ...Array.from({ length: 8 }, (_, index) => ({
        ...f.session,
        id: `session-${index}`,
        lastActivityAt: index
      }))
    ]);
    await f.source.references('workspace', new AbortController().signal);
    expect(f.readHistory.mock.calls.map(([session]) => session.id)).toEqual([
      'session-7',
      'session-6',
      'session-5',
      'session-4',
      'session-3'
    ]);
    expect(f.resolveSession).not.toHaveBeenCalled();
  });

  it('does no optional history I/O for a cold catalog or an aborted request', async () => {
    const f = fixture();
    f.cachedSessions.mockReturnValue([]);
    expect(await f.source.references('workspace', new AbortController().signal)).toEqual([]);
    await expect(f.source.references('workspace', AbortSignal.abort())).rejects.toThrow();
    expect(f.readHistory).not.toHaveBeenCalled();
  });
});
