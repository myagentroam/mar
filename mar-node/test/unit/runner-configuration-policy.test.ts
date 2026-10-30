import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEnvelope, type RunnerName } from '@myagentroam/protocol';
import { NodeConnector } from '../../src/connector.js';
import { NodeDatabase } from '../../src/database.js';
import type { NodeRuntimeState } from '../../src/runtime-state.js';
import type { RunnerRegistry } from '../../src/runner/runner-registry.js';
import type { NativeSessionProjectionService } from '../../src/session/native-session-projection-service.js';
import type { ContinuousRunCoordinator } from '../../src/service/continuous-run-coordinator.js';
import { NodeRequestService } from '../../src/service/node-request-service.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'runner-configuration-')));
  const database = new NodeDatabase(':memory:', 'node-configuration');
  const workspace = database.saveWorkspace({ path: root, kind: 'DIRECTORY', gitSummary: null });
  const connector = new NodeConnector({
    configPath: join(root, 'node.json'),
    config: { serverUrl: 'http://127.0.0.1:1', allowedRoots: [root] },
    reconnect: false,
    database,
    capabilities: {
      platform: 'linux',
      architecture: 'x64',
      nodeVersion: process.version,
      codex: { available: true },
      claudeCode: { available: true },
      openCode: { available: true },
      marAgent: { available: true }
    }
  });
  cleanup.push(async () => {
    await connector.stop();
    await rm(root, { recursive: true, force: true });
  });
  const internals = connector as unknown as {
    runtime: NodeRuntimeState;
    runners: RunnerRegistry;
    nativeSessionProjectionService: NativeSessionProjectionService;
    continuousRunCoordinator: ContinuousRunCoordinator<unknown>;
    executeNodeOperation(operation: string, data: unknown): Promise<unknown>;
  };
  const operation = (name: string, data: unknown) => internals.executeNodeOperation(name, data);
  const session = (
    runner: RunnerName,
    access: string | null,
    missing?: 'externalSessionId' | 'modelId' | 'effort'
  ) =>
    internals.runtime.createAgentSession({
      workspaceId: workspace.id,
      cwd: root,
      runner,
      ...(access === null ? {} : { access }),
      ...(missing === 'modelId' ? {} : { modelId: 'stored-model' }),
      ...(missing === 'effort' ? {} : { effort: 'high' }),
      ...(missing === 'externalSessionId' ? {} : { externalSessionId: `native-${runner}` }),
      nativeControl: 'MAR_MANAGED'
    });
  return { ...internals, database, workspace, root, operation, session };
}

describe('Runner configuration ownership through Connector', () => {
  it('saves defaults through the authorized request boundary while rejecting invalid fields', async () => {
    const f = await fixture();
    const send = vi.fn();
    const service = new NodeRequestService({
      nodeId: () => 'node-configuration',
      databaseAvailable: () => true,
      execute: f.operation,
      send
    });
    const configuration = {
      runner: 'mar-agent',
      modelId: 'selected-model',
      effort: 'high',
      access: 'auto'
    };
    const request = async (data: unknown, id: string) => {
      const now = Date.now();
      await service.handle(
        createEnvelope(
          'node.request',
          {
            operation: 'runner.defaults.save',
            data,
            userAuthorization: {
              userId: 1,
              sessionHash: 'a'.repeat(43),
              nodeId: 'node-configuration',
              operation: 'runner.defaults.save',
              requestId: id,
              issuedAt: now,
              expiresAt: now + 15_000
            }
          },
          { id }
        )
      );
    };

    await request(configuration, 'valid-request');
    expect(send).toHaveBeenLastCalledWith(
      'node.response',
      {
        result: { defaults: configuration }
      },
      'valid-request'
    );
    expect(f.database.getRunnerDefaults()).toEqual([configuration]);

    for (const [id, invalid] of [
      ['unknown-field', { ...configuration, unexpected: true }],
      ['invalid-access', { ...configuration, access: 'read-only' }]
    ] as const) {
      await request(invalid, id);
      expect(send).toHaveBeenLastCalledWith(
        'node.response',
        expect.objectContaining({ error: 'RUNNER_DEFAULT_INVALID' }),
        id
      );
      expect(f.database.getRunnerDefaults()).toEqual([configuration]);
    }
  });

  it.each(['auto', 'full-access', 'on-request', 'read-only', 'unknown'] as const)(
    'lists stored MAR defaults %j without redundant writes and rejects fresh invalid input',
    async (access) => {
      const f = await fixture();
      vi.spyOn(f.runners, 'refreshProfiles').mockResolvedValue([]);
      const runner = f.runners.require('mar-agent');
      const validate = vi.spyOn(runner, 'supportsConfiguration');
      const restore = vi.spyOn(runner, 'restoreStoredAccess');
      const configuration = {
        runner: 'mar-agent' as const,
        modelId: 'saved',
        effort: 'high',
        access
      };
      const foreign = {
        runner: 'codex' as const,
        modelId: 'foreign',
        effort: '',
        access: 'custom-mode'
      };
      f.database.saveRunnerDefaults(foreign);
      f.database.saveRunnerDefaults(configuration);
      const save = vi.spyOn(f.database, 'saveRunnerDefaults');
      const expected = {
        ...configuration,
        access: access === 'auto' || access === 'full-access' ? access : 'full-access'
      };
      for (const waitForRefresh of [true, false]) {
        await expect(
          f.operation('runner.profiles.list', { waitForRefresh })
        ).resolves.toMatchObject({ defaults: [foreign, expected] });
        expect(f.database.getRunnerDefaults()).toEqual([foreign, expected]);
      }
      expect(restore).toHaveBeenCalledTimes(2);
      expect(save).toHaveBeenCalledTimes(access === expected.access ? 0 : 1);
      const before = save.mock.calls.length;
      restore.mockClear();
      const session = f.session('mar-agent', 'auto');
      for (const invalid of ['on-request', 'read-only', 'unknown', '', ' \t ']) {
        await expect(
          f.operation('runner.defaults.save', { ...configuration, access: invalid })
        ).rejects.toThrow('RUNNER_DEFAULT_INVALID');
        await expect(
          f.operation('session.create', {
            workspaceId: f.workspace.id,
            cwd: f.root,
            ...configuration,
            access: invalid
          })
        ).rejects.toThrow('SESSION_INVALID');
        await expect(
          f.operation('session.config.update', { sessionId: session.id, access: invalid })
        ).rejects.toThrow('SESSION_INVALID');
      }
      expect(restore).not.toHaveBeenCalled();
      expect(validate).not.toHaveBeenCalled();
      expect(save).toHaveBeenCalledTimes(before);
      expect(f.runtime.getAgentSession(session.id)?.access).toBe('auto');
      await expect(
        f.operation('runner.defaults.save', { ...configuration, access: 'auto' })
      ).resolves.toEqual({ defaults: { ...configuration, access: 'auto' } });
      // Defaults retain their existing Schema trimming; Session inputs reject padded modes.
      await expect(
        f.operation('runner.defaults.save', { ...configuration, access: ' auto ' })
      ).resolves.toEqual({ defaults: { ...configuration, access: 'auto' } });
      await expect(
        f.operation('session.create', {
          workspaceId: f.workspace.id,
          cwd: f.root,
          ...configuration,
          access: ' auto '
        })
      ).rejects.toThrow('SESSION_INVALID');
      await expect(
        f.operation('session.config.update', { sessionId: session.id, access: ' auto ' })
      ).rejects.toThrow('SESSION_INVALID');
      expect(restore).not.toHaveBeenCalled();
    }
  );

  it.each([
    ['mar-agent', null, 'full-access', false],
    ['mar-agent', 'auto', 'auto', false],
    ['mar-agent', 'full-access', 'full-access', false],
    ['codex', null, 'full-access', true],
    ['codex', 'read-only', 'full-access', true],
    ['codex', 'full-access', 'full-access', false],
    ['claude-code', null, 'bypass', true],
    ['claude-code', 'default', 'bypass', true],
    ['claude-code', 'bypass', 'bypass', false],
    ['opencode', null, 'auto', true],
    ['opencode', 'ask', 'auto', true],
    ['opencode', 'auto', 'auto', false]
  ] as const)(
    'enters Goal for %s/%s with exact access %s and change report %s',
    async (name, current, access, changed) => {
      const f = await fixture();
      const runner = f.runners.require(name);
      const policy = vi.spyOn(runner, 'goalAccess');
      const update = vi.spyOn(f.runtime, 'updateAgentSessionAccess');
      const save = vi.spyOn(f.database, 'saveNativeSessionMetadata');
      const session = f.session(name, current);
      const result = await f.operation('session.command.execute', {
        sessionId: session.id,
        commandId: 'goal',
        input: '/goal'
      });
      expect(result).toMatchObject({
        goalAccessChanged: changed,
        session: {
          access,
          commandStates: [expect.objectContaining({ commandId: 'goal', active: true })]
        }
      });
      expect(policy).toHaveBeenCalledExactlyOnceWith(current);
      expect(policy.mock.results[0]?.value).toEqual({ access, accessChanged: changed });
      expect(update).toHaveBeenCalledTimes(current === access ? 0 : 1);
      if (current !== access) expect(update).toHaveBeenCalledWith(session.id, access);
      expect(save).toHaveBeenCalledTimes(changed ? 1 : 0);
      if (changed)
        expect(save).toHaveBeenCalledWith({
          runner: name,
          externalSessionId: session.externalSessionId,
          workspaceId: f.workspace.id,
          modelId: 'stored-model',
          effort: 'high',
          access
        });
      expect(f.runtime.getAgentSession(session.id)?.access).toBe(access);
      expect(
        f.database.getNativeSessionMetadata(name, session.externalSessionId!, f.workspace.id)
          ?.access
      ).toBe(changed ? access : undefined);
      await expect(
        f.operation('session.command.execute', {
          sessionId: session.id,
          commandId: 'goal',
          input: '/goal'
        })
      ).resolves.toMatchObject({ goalAlreadyActive: true });
      expect(policy).toHaveBeenCalledOnce();
      expect(update).toHaveBeenCalledTimes(current === access ? 0 : 1);
      expect(save).toHaveBeenCalledTimes(changed ? 1 : 0);
    }
  );

  it.each([
    ['mar-agent', 'auto', 'auto'],
    ['codex', 'read-only', 'full-access'],
    ['claude-code', 'default', 'bypass'],
    ['opencode', 'ask', 'auto']
  ] as const)(
    'prepares subsequent Goal executions with the selected %s access',
    async (name, current, access) => {
      const f = await fixture();
      // Stop at the actual Execution preparation boundary, without invoking an external model.
      vi.spyOn(f.continuousRunCoordinator, 'dispatch').mockResolvedValue();
      const prepare = vi.spyOn(f.continuousRunCoordinator, 'prepare');
      const session = f.session(name, current);
      for (const objective of ['Finish the feature', 'Finish the revised feature']) {
        await f.operation('session.command.execute', {
          sessionId: session.id,
          commandId: 'goal',
          input: `/goal ${objective}`
        });
        expect(prepare).toHaveBeenLastCalledWith(
          expect.any(String),
          expect.objectContaining({
            sessionId: session.id,
            access,
            modelId: 'stored-model',
            effort: 'high',
            executionContext: expect.objectContaining({ runner: name })
          })
        );
      }
      expect(prepare).toHaveBeenCalledTimes(2);
    }
  );

  it.each(['externalSessionId', 'modelId', 'effort'] as const)(
    'does not persist Goal metadata without %s',
    async (field) => {
      const f = await fixture();
      const session = f.session('codex', 'read-only', field);
      const save = vi.spyOn(f.database, 'saveNativeSessionMetadata');
      await expect(
        f.operation('session.command.execute', {
          sessionId: session.id,
          commandId: 'goal',
          input: '/goal'
        })
      ).resolves.toMatchObject({ goalAccessChanged: true, session: { access: 'full-access' } });
      expect(save).not.toHaveBeenCalled();
    }
  );

  it.each(['mar-agent', 'codex', 'claude-code', 'opencode'] as const)(
    'restores %s metadata with same-Runner fallbacks and one writeback',
    async (name) => {
      const f = await fixture();
      const runner = f.runners.require(name);
      const restore = vi.spyOn(runner, 'restoreStoredAccess');
      const saved = {
        runner: name,
        modelId: 'saved-model',
        effort: 'saved-effort',
        access: 'saved-access'
      };
      f.database.saveRunnerDefaults(saved);
      const session = f.session(name, null);
      const projection = f.nativeSessionProjectionService;
      for (const current of [
        null,
        '',
        ' \t ',
        'on-request',
        'auto',
        'full-access',
        ' custom-mode '
      ]) {
        const expected =
          name === 'mar-agent'
            ? current === 'auto' || current === 'full-access'
              ? current
              : 'full-access'
            : current === null || current.trim().length === 0
              ? saved.access
              : current;
        expect(
          projection.resumedConfiguration({
            ...session,
            modelId: null,
            effort: null,
            access: current
          })
        ).toEqual({
          ...saved,
          access: expected
        });
        expect(restore).toHaveBeenLastCalledWith(current, saved.access);
      }
      const update = vi.spyOn(f.runtime, 'updateAgentSessionConfiguration');
      const save = vi.spyOn(f.database, 'saveNativeSessionMetadata');
      const restored = projection.ensureResumedConfiguration(session);
      expect(restored.access).toBe(name === 'mar-agent' ? 'full-access' : saved.access);
      expect(update).toHaveBeenCalledOnce();
      // Restoring configuration writes Runtime only, not native metadata.
      expect(save).not.toHaveBeenCalled();
      expect(projection.ensureResumedConfiguration(restored)).toBe(restored);
      expect(update).toHaveBeenCalledOnce();
      expect(save).not.toHaveBeenCalled();
      f.database.saveRunnerDefaults({
        runner: name === 'codex' ? 'claude-code' : 'codex',
        modelId: 'foreign',
        effort: '',
        access: 'foreign'
      });
      const emptyDatabase = vi
        .spyOn(f.database, 'getRunnerDefaults')
        .mockReturnValue(f.database.getRunnerDefaults().filter((value) => value.runner !== name));
      expect(
        projection.resumedConfiguration({ ...session, modelId: null, effort: null }).access
      ).toBe(
        name === 'mar-agent' ? 'full-access' : runner.defaultConfiguration(f.workspace).access
      );
      emptyDatabase.mockRestore();
    }
  );
});
