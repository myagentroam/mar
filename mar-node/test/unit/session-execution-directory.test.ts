import { mkdir, mkdtemp, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { safePublicError } from '@myagentroam/protocol';
import { resolveWorkspaceExecutionDirectory } from '../../src/workspace.js';
import { NodeDatabase } from '../../src/database.js';
import { NodeConnector } from '../../src/connector.js';
import type { NodeRuntimeState } from '../../src/runtime-state.js';
import { FakeRunner } from '../../src/fake-runner.js';
import type { RunnerRegistry } from '../../src/runner/runner-registry.js';
import type { ExternalSessionResumeService } from '../../src/service/external-session-resume-service.js';
import type { ConversationHistoryService } from '../../src/service/conversation-history-service.js';

const roots: string[] = [];
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'mar-session-directory-'));
  roots.push(root);
  const a = join(root, 'a'),
    b = join(root, 'b');
  await Promise.all([mkdir(a), mkdir(b), mkdir(join(root, 'a-sibling'))]);
  await mkdir(join(a, 'sub'));
  return { root, a, b };
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
describe('Workspace execution directory admission', () => {
  it('allows the registered root, normalized subdirectories and internal links', async () => {
    const { a } = await fixture();
    const link = join(a, 'internal');
    await symlink(join(a, 'sub'), link, process.platform === 'win32' ? 'junction' : 'dir');
    expect(await resolveWorkspaceExecutionDirectory(a, a)).toBe(a);
    expect(await resolveWorkspaceExecutionDirectory(a, join(a, 'sub', '..', 'sub'))).toBe(
      join(a, 'sub')
    );
    expect(await resolveWorkspaceExecutionDirectory(a, link)).toBe(join(a, 'sub'));
  });
  it('rejects sibling directories, relative paths and links escaping the Workspace', async () => {
    const { root, a, b } = await fixture();
    const link = join(a, 'external');
    await symlink(b, link, process.platform === 'win32' ? 'junction' : 'dir');
    for (const cwd of [b, join(root, 'a-sibling'), link, 'sub'])
      await expect(resolveWorkspaceExecutionDirectory(a, cwd)).rejects.toMatchObject({
        code: 'SESSION_EXECUTION_DIRECTORY_INVALID'
      });
  });
  it('rejects a replaced registered root and distinguishes unavailable paths without exposing them', async () => {
    const { a, b } = await fixture();
    await writeFile(join(a, 'file'), 'fixture');
    for (const cwd of [join(a, 'missing'), join(a, 'file')]) {
      try {
        await resolveWorkspaceExecutionDirectory(a, cwd);
        throw new Error('EXPECTED_REJECTION');
      } catch (error) {
        const result = safePublicError(error);
        expect(result.code).toBe('SESSION_EXECUTION_DIRECTORY_INVALID');
        expect(result.message).not.toContain(a);
        expect(result.details).not.toContain(a);
        expect(result.parameters?.reason).not.toBe('OUTSIDE_WORKSPACE');
      }
    }
    await rename(a, `${a}-old`);
    await symlink(b, a, process.platform === 'win32' ? 'junction' : 'dir');
    await expect(resolveWorkspaceExecutionDirectory(a, a)).rejects.toMatchObject({
      publicParameters: { reason: 'WORKSPACE_ROOT_CHANGED' }
    });
  });
  it.each(['mar-agent', 'codex', 'claude-code', 'opencode'] as const)(
    'rejects a mismatched directory before creating %s Session state',
    async (runner) => {
      const { a, b } = await fixture();
      const database = new NodeDatabase(':memory:', 'directory-admission');
      const workspace = database.saveWorkspace({ path: a, kind: 'DIRECTORY', gitSummary: null });
      database.saveWorkspace({ path: b, kind: 'DIRECTORY', gitSummary: null });
      const connector = new NodeConnector({ database, reconnect: false });
      const node = connector as unknown as {
        runtime: NodeRuntimeState;
        executeNodeOperation(operation: string, data: unknown): Promise<unknown>;
      };
      try {
        await expect(
          node.executeNodeOperation('session.create', { workspaceId: workspace.id, runner, cwd: b })
        ).rejects.toMatchObject({ code: 'SESSION_EXECUTION_DIRECTORY_INVALID' });
        expect(node.runtime.listAgentSessions()).toEqual([]);
        const result = (await node.executeNodeOperation('session.create', {
          workspaceId: workspace.id,
          runner,
          cwd: join(a, 'sub')
        })) as { session: { cwd: string; workspaceId: string } };
        expect(result.session).toMatchObject({ cwd: join(a, 'sub'), workspaceId: workspace.id });
      } finally {
        await connector.stop();
      }
    }
  );
  it.each(['mar-agent', 'codex', 'claude-code', 'opencode'] as const)(
    'settles accepted %s messages from an invalid legacy directory without starting a Runner',
    async (runner) => {
      const { a, b } = await fixture();
      const database = new NodeDatabase(':memory:', 'legacy-directory');
      const workspace = database.saveWorkspace({ path: a, kind: 'DIRECTORY', gitSummary: null });
      const script = vi.fn(() => [{ type: 'success' as const }]);
      const connector = new NodeConnector({
        database,
        reconnect: false,
        fakeRunner: new FakeRunner(),
        fakeScript: script
      });
      const node = connector as unknown as {
        runtime: NodeRuntimeState;
        executeNodeOperation(operation: string, data: unknown): Promise<unknown>;
      };
      const session = node.runtime.createAgentSession({
        workspaceId: workspace.id,
        runner,
        cwd: b,
        externalSessionId: 'legacy-native',
        nativeControl: 'MAR_MANAGED'
      });
      try {
        await expect(
          node.executeNodeOperation('session.message', {
            sessionId: session.id,
            clientMessageId: 'legacy-message',
            content: 'Do not execute outside A'
          })
        ).rejects.toMatchObject({ code: 'SESSION_EXECUTION_DIRECTORY_INVALID' });
        const runs = node.runtime.listRunsForSession(session.id, { includeTerminal: true });
        expect(runs).toHaveLength(1);
        expect(runs[0]).toMatchObject({ status: 'FAILED' });
        expect(node.runtime.activeSessionRun(session.id)).toBeUndefined();
        expect(script).not.toHaveBeenCalled();
      } finally {
        await connector.stop();
      }
    }
  );
  it('rejects external activation and rewind before native side effects for a foreign directory', async () => {
    const { a, b } = await fixture();
    const database = new NodeDatabase(':memory:', 'native-directory');
    const workspace = database.saveWorkspace({ path: a, kind: 'DIRECTORY', gitSummary: null });
    const connector = new NodeConnector({ database, reconnect: false });
    const node = connector as unknown as {
      runtime: NodeRuntimeState;
      runners: RunnerRegistry;
      externalSessionResumeService: ExternalSessionResumeService;
      conversationHistoryService: ConversationHistoryService;
      executeNodeOperation(operation: string, data: unknown): Promise<unknown>;
    };
    const session = node.runtime.createAgentSession({
      workspaceId: workspace.id,
      runner: 'codex',
      cwd: b,
      externalSessionId: 'native-foreign',
      nativeControl: 'EXTERNAL'
    });
    const runner = node.runners.require('codex');
    const resume = vi.spyOn(runner, 'resumeExternal');
    const fork = vi.spyOn(runner, 'forkNative');
    const history = vi.spyOn(node.conversationHistoryService, 'read').mockResolvedValue({
      turns: [
        {
          id: 'native-turn',
          sessionId: session.id,
          runId: null,
          userItemId: null,
          status: 'SUCCEEDED',
          model: null,
          effort: null,
          access: null,
          rewind: { before: null, after: 'checkpoint' },
          items: [],
          startedAt: 1,
          completedAt: 1
        }
      ],
      nextCursor: null,
      snapshotSequence: 1,
      source: 'native',
      readAt: 1,
      latestVisibleAt: 1
    });
    try {
      await expect(node.externalSessionResumeService.resume(session)).rejects.toMatchObject({
        code: 'SESSION_EXECUTION_DIRECTORY_INVALID'
      });
      expect(node.externalSessionResumeService.transitioning(session.id)).toBe(false);
      const release = node.runtime.beginSessionHistoryMutation(session.id);
      release();
      await expect(
        node.executeNodeOperation('session.rewind', {
          sessionId: session.id,
          turnId: 'native-turn',
          position: 'AFTER',
          boundary: 'checkpoint'
        })
      ).rejects.toMatchObject({ code: 'SESSION_EXECUTION_DIRECTORY_INVALID' });
      expect(resume).not.toHaveBeenCalled();
      expect(fork).not.toHaveBeenCalled();
      expect(node.runtime.listAgentSessions()).toHaveLength(1);
    } finally {
      resume.mockRestore();
      fork.mockRestore();
      history.mockRestore();
      await connector.stop();
    }
  });
});
