import { afterEach, describe, expect, it, vi } from 'vitest';
import * as nativeHistory from '../../src/native-session-history.js';
import { ClaudeCodeRunner } from '../../src/runner/claude-code-runner.js';
import { CodexRunner } from '../../src/runner/codex-runner.js';
import { OpenCodeServerClient } from '../../src/runner/opencode/opencode-server.js';

const workspace = {
  id: 'workspace',
  path: '/workspace',
  kind: 'DIRECTORY' as const,
  gitSummary: null
};

afterEach(() => vi.restoreAllMocks());

describe('Runner discovery cancellation', () => {
  it.each(['resolve', 'reject'] as const)(
    'does not start Claude transcript discovery after an aborted SDK listing will %s',
    async (outcome) => {
      const controller = new AbortController();
      const failure = new Error('NODE_STOPPED');
      const pending =
        Promise.withResolvers<Awaited<ReturnType<ClaudeCodeRunner['listSessions']>>>();
      const runner = new ClaudeCodeRunner();
      vi.spyOn(runner, 'listSessions').mockReturnValue(pending.promise);
      const native = vi.spyOn(nativeHistory, 'discoverNativeSessions').mockResolvedValue([]);
      const createProjection = vi.fn();
      const discovery = runner
        .discoverSessions({
          workspaces: [workspace],
          createProjection,
          signal: controller.signal
        })
        .catch((error: unknown) => error);
      controller.abort(failure);
      if (outcome === 'reject') pending.reject(new Error('SDK_LIST_UNAVAILABLE'));
      else pending.resolve([]);
      expect(await discovery).toBe(failure);
      expect(native).not.toHaveBeenCalled();
      expect(createProjection).not.toHaveBeenCalled();
    }
  );

  it('does not request Codex threads after discovery is aborted during startup', async () => {
    const controller = new AbortController();
    const failure = new Error('NODE_STOPPED');
    const started = Promise.withResolvers<void>();
    const runner = new CodexRunner();
    vi.spyOn(runner, 'start').mockReturnValue(started.promise);
    const threads = vi.spyOn(runner, 'listThreads').mockResolvedValue({ data: [] });
    vi.spyOn(nativeHistory, 'discoverAllNativeSessions').mockResolvedValue([]);
    const discovery = runner
      .discoverSessions({
        workspaces: [workspace],
        createProjection: vi.fn(),
        signal: controller.signal
      })
      .catch((error: unknown) => error);
    controller.abort(failure);
    started.resolve();
    expect(await discovery).toBe(failure);
    expect(threads).not.toHaveBeenCalled();
  });

  it('passes discovery cancellation to the OpenCode HTTP request without issuing aborted requests', async () => {
    const controller = new AbortController();
    const failure = new Error('NODE_STOPPED');
    const list = vi.fn(async () => ({ data: [] }));
    const client = new OpenCodeServerClient();
    const api = vi
      .spyOn(
        client as unknown as {
          requireClient(): Promise<unknown>;
        },
        'requireClient'
      )
      .mockResolvedValue({ session: { list } });
    await expect(client.sessions(workspace.path, 100, controller.signal)).resolves.toEqual([]);
    expect(list).toHaveBeenCalledWith(
      { directory: workspace.path, limit: 100 },
      { signal: controller.signal }
    );
    controller.abort(failure);
    await expect(client.sessions(workspace.path, 100, controller.signal)).rejects.toBe(failure);
    expect(api).toHaveBeenCalledTimes(1);
    expect(list).toHaveBeenCalledTimes(1);
  });
});
