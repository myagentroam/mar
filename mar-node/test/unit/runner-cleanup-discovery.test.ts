import { afterEach, describe, expect, it, vi } from 'vitest';
import { MarAgentRunner } from '../../src/runner/mar-agent-runner.js';
import { OpenCodeRunner } from '../../src/runner/opencode-runner.js';
import { CodexRunner } from '../../src/runner/codex-runner.js';
import { ClaudeCodeRunner } from '../../src/runner/claude-code-runner.js';
import type { ClaudeAgentSdkAdapter } from '../../src/claude-agent-sdk.js';
import type { CodexAppServerClient } from '../../src/codex-app-server.js';
import { discoverAllNativeSessions } from '../../src/native-session-history.js';
import type { OpenCodeServerClient } from '../../src/opencode-server.js';
import type { RunnerDiscoveryContext } from '../../src/runner/abstract-runner.js';

const catalog = vi.hoisted(() => ({
  list: vi.fn(),
  executionConfiguration: vi.fn(),
  firstUserMessagePreview: vi.fn(),
  close: vi.fn(async () => {})
}));
vi.mock('@myagentroam/agent', async (original) => ({
  ...(await original<typeof import('@myagentroam/agent')>()),
  openMarAgentSessionCatalog: async () => catalog
}));
vi.mock('../../src/native-session-history.js', async (original) => ({
  ...(await original<typeof import('../../src/native-session-history.js')>()),
  discoverAllNativeSessions: vi.fn(),
  discoverNativeSessions: vi.fn(async () => [])
}));
afterEach(() => vi.resetAllMocks());

const workspace = {
  id: 'workspace',
  path: '/workspace',
  kind: 'DIRECTORY' as const,
  gitSummary: null
};
function summary(index: number, path = workspace.path) {
  return {
    id: `native-${index}`,
    title: 'New session',
    workspace: path,
    lastActivityAt: '2026-01-01T00:00:00.000Z'
  };
}
function context(): RunnerDiscoveryContext {
  return {
    cleanup: true,
    workspaces: [workspace],
    createProjection: (input) =>
      ({
        id: input.externalSessionId,
        workspaceId: input.workspace.id,
        lastActivityAt: input.lastActivityAt
      }) as never
  };
}

describe('Runner cleanup discovery', () => {
  it('preserves Claude SDK listing failures during cleanup rather than treating fallback as complete', async () => {
    const failure = new Error('CLAUDE_LIST_UNAVAILABLE');
    const runner = new ClaudeCodeRunner({
      listSessions: vi.fn(async () => {
        throw failure;
      })
    } as unknown as ClaudeAgentSdkAdapter);
    await expect(runner.discoverSessions(context(), workspace)).rejects.toBe(failure);
    await expect(
      runner.discoverSessions({ ...context(), cleanup: false }, workspace)
    ).resolves.toEqual([]);
  });

  it('reads every MAR Agent catalog page without loading title previews or execution configurations', async () => {
    catalog.list
      .mockResolvedValueOnce({
        sessions: Array.from({ length: 200 }, (_, index) => summary(index)),
        nextCursor: 'older'
      })
      .mockResolvedValueOnce({ sessions: [summary(200), summary(201, '/other')] });
    const result = await new MarAgentRunner('/home/fixture').discoverSessions(context(), workspace);
    expect(result).toHaveLength(201);
    expect(result.at(-1)).toMatchObject({
      id: 'native-200',
      lastActivityAt: Date.parse('2026-01-01T00:00:00.000Z')
    });
    expect(catalog.list).toHaveBeenNthCalledWith(2, { limit: 200, cursor: 'older' });
    expect(catalog.executionConfiguration).not.toHaveBeenCalled();
    expect(catalog.firstUserMessagePreview).not.toHaveBeenCalled();
    expect(catalog.close).toHaveBeenCalledOnce();
  });

  it('discovers OpenCode cleanup candidates without title message pages and preserves discovery failures', async () => {
    const sessions = vi.fn(async () => [
      { id: 'native', directory: '/workspace', title: 'New session', time: { updated: 2 } }
    ]);
    const messagePage = vi.fn();
    const runner = new OpenCodeRunner({ sessions, messagePage } as unknown as OpenCodeServerClient);
    await expect(runner.discoverSessions(context(), workspace)).resolves.toMatchObject([
      { id: 'native', lastActivityAt: 2 }
    ]);
    expect(messagePage).not.toHaveBeenCalled();
    const failure = new Error('DIRECTORY_UNAVAILABLE');
    sessions.mockRejectedValueOnce(failure);
    await expect(runner.discoverSessions(context(), workspace)).rejects.toBe(failure);
  });

  it('starts Codex discovery sources together without per-thread reads', async () => {
    const official = Promise.withResolvers<unknown>();
    const files = Promise.withResolvers<Awaited<ReturnType<typeof discoverAllNativeSessions>>>();
    const readThread = vi.fn();
    const listThreads = vi.fn(() => official.promise);
    vi.mocked(discoverAllNativeSessions).mockReturnValue(files.promise);
    const runner = new CodexRunner({
      start: async () => undefined,
      listThreads,
      readThread
    } as unknown as CodexAppServerClient);
    const result = runner.discoverSessions({ ...context(), cleanup: false }, workspace);
    await vi.waitFor(() => expect(listThreads).toHaveBeenCalledOnce());
    expect(discoverAllNativeSessions).toHaveBeenCalledOnce();
    official.resolve({ data: [{ id: 'official', cwd: workspace.path, source: 'cli' }] });
    files.resolve([]);
    expect(await result).toHaveLength(1);
    expect(readThread).not.toHaveBeenCalled();
  });

  it('uses fresh official Codex pages and activity timestamps without reading JSONL during cleanup', async () => {
    const listThreads = vi
      .fn()
      .mockResolvedValueOnce({
        data: [{ id: 'recent', cwd: workspace.path, source: 'cli', updatedAt: 1_793_000_000 }],
        nextCursor: 'older'
      })
      .mockResolvedValueOnce({
        data: [{ id: 'older', cwd: workspace.path, source: 'cli', updatedAt: 1_700_000_000 }],
        nextCursor: null
      });
    const readThread = vi.fn();
    const runner = new CodexRunner({
      start: async () => undefined,
      listThreads,
      readThread
    } as unknown as CodexAppServerClient);
    await expect(runner.discoverSessions(context(), workspace)).resolves.toMatchObject([
      { id: 'recent', lastActivityAt: 1_793_000_000_000 },
      { id: 'older', lastActivityAt: 1_700_000_000_000 }
    ]);
    expect(listThreads).toHaveBeenNthCalledWith(1, { limit: 200 });
    expect(listThreads).toHaveBeenNthCalledWith(2, { limit: 200, cursor: 'older' });
    expect(discoverAllNativeSessions).not.toHaveBeenCalled();
    expect(readThread).not.toHaveBeenCalled();
  });

  it.each(['failed', 'malformed', 'repeated-cursor'] as const)(
    'rejects incomplete official Codex cleanup discovery after a %s page',
    async (outcome) => {
      const listThreads = vi.fn().mockResolvedValueOnce({ data: [], nextCursor: 'older' });
      if (outcome === 'failed') listThreads.mockRejectedValueOnce(new Error('PAGE_FAILED'));
      else if (outcome === 'malformed') listThreads.mockResolvedValueOnce({});
      else listThreads.mockResolvedValueOnce({ data: [], nextCursor: 'older' });
      const runner = new CodexRunner({
        start: async () => undefined,
        listThreads
      } as unknown as CodexAppServerClient);
      await expect(runner.discoverSessions(context(), workspace)).rejects.toThrow();
      expect(discoverAllNativeSessions).not.toHaveBeenCalled();
    }
  );

  it.each([null, { cwd: workspace.path }, { id: 'missing-cwd' }])(
    'rejects a malformed Codex directory entry instead of treating discovery as complete: %j',
    async (entry) => {
      const runner = new CodexRunner({
        start: async () => undefined,
        listThreads: vi.fn(async () => ({ data: [entry], nextCursor: null }))
      } as unknown as CodexAppServerClient);
      await expect(runner.discoverSessions(context(), workspace)).rejects.toThrow();
      expect(discoverAllNativeSessions).not.toHaveBeenCalled();
    }
  );

  it('preserves Codex listing failures during cleanup while ordinary discovery can fall back', async () => {
    const failure = new Error('CODEX_LIST_UNAVAILABLE');
    const readThread = vi.fn();
    const runner = new CodexRunner({
      start: async () => undefined,
      listThreads: vi.fn(async () => {
        throw failure;
      }),
      readThread
    } as unknown as CodexAppServerClient);
    vi.mocked(discoverAllNativeSessions).mockResolvedValue([]);
    await expect(runner.discoverSessions(context(), workspace)).rejects.toBe(failure);
    await expect(
      runner.discoverSessions({ ...context(), cleanup: false }, workspace)
    ).resolves.toEqual([]);
    expect(readThread).not.toHaveBeenCalled();
  });

  it('does not turn a failed catalog page into a successful empty cleanup discovery', async () => {
    const failure = new Error('CATALOG_READ_FAILED');
    catalog.list
      .mockResolvedValueOnce({ sessions: [summary(0)], nextCursor: 'older' })
      .mockRejectedValueOnce(failure);
    await expect(
      new MarAgentRunner('/home/fixture').discoverSessions(context(), workspace)
    ).rejects.toBe(failure);
    expect(catalog.close).toHaveBeenCalledOnce();
  });
});
