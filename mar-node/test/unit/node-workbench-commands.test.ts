vi.mock('ws', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ws')>();
  const { mockedWebSocket } = await import('./support/control-socket.js');
  return { ...actual, default: mockedWebSocket(actual.default) };
});
import { connectTestSocket } from './support/control-socket.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { createEnvelope } from '@myagentroam/protocol';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { NodeConnector } from '../../src/connector.js';
import { NodeDatabase, type NodeAgentSession } from '../../src/database.js';
import type { CodexAppServerClient } from '../../src/runner/codex/codex-app-server.js';
import { SessionContextService } from '../../src/session/session-context-service.js';
import { RunWorkbenchService } from '../../src/service/run-workbench-service.js';
import { captureSocket } from './support/codex-connector.js';

describe('Node Workbench Manifest and command control', () => {
  it('reads only the explicit selector kind and never revives native indexes', async () => {
    const readImage = vi.fn(async () => ({ mime: 'image/png', dataBase64: 'aW1hZ2U=' }));
    const service = new RunWorkbenchService({ readImage } as never);
    const image = service.operations()['run.image.read']!;
    await expect(
      image({
        runId: 'native-history:session',
        imageRef: 'file:session%3Aimage.png',
        __requestUserId: 1
      })
    ).resolves.toHaveProperty('image');
    expect(readImage).toHaveBeenLastCalledWith(
      'native-history:session',
      'file:session%3Aimage.png'
    );
    await expect(image({ runId: 'run-1', imageIndex: 0 })).resolves.toHaveProperty('image');
    expect(readImage).toHaveBeenLastCalledWith('run-1', 0);
    readImage.mockClear();
    for (const invalid of [
      { runId: 'native-history:session', imageIndex: 0 },
      { runId: 'native-history:hosted:conversation', imageRef: 'file:image.png' },
      { runId: 'run-1', imageRef: 'file:image.png' },
      { runId: 'native-history:session', imageRef: '/arbitrary/path.png' },
      { runId: 'run-1', imageIndex: 0, imageRef: 'file:image.png' }
    ])
      await expect(image(invalid)).rejects.toThrow('RUN_IMAGE_INVALID');
    expect(readImage).not.toHaveBeenCalled();
    readImage.mockResolvedValueOnce(undefined as never);
    await expect(
      image({ runId: 'native-history:session', imageRef: 'file:missing.png' })
    ).rejects.toThrow('RUN_IMAGE_NOT_FOUND');
  });

  it('serves original Run image bytes unchanged and rechecks the resource before preview cache hits', async () => {
    const sourceBytes = await sharp({
      create: { width: 640, height: 480, channels: 3, background: { r: 70, g: 90, b: 110 } }
    })
      .png()
      .toBuffer();
    const source = { mime: 'image/png', dataBase64: sourceBytes.toString('base64') };
    const original = { ...source };
    const readImage = vi.fn(async () => source);
    const operation = new RunWorkbenchService({ readImage } as never).operations()[
      'run.image.read'
    ]!;
    const request = { runId: 'run-thumbnail-check', imageIndex: 0 };
    const preview = { maxWidth: 320, maxHeight: 240 };

    const detail = (await operation(request)) as { image: typeof source };
    expect(detail.image).toBe(source);
    expect(source).toEqual(original);

    const [first, second] = await Promise.all([
      operation({ ...request, preview }),
      operation({ ...request, preview })
    ]);
    expect(first).toEqual(second);
    const resized = first as { image: { mime: string; dataBase64: string; resized: boolean } };
    expect(resized.image.mime).toBe('image/webp');
    expect(resized.image.resized).toBe(true);
    expect(await sharp(Buffer.from(resized.image.dataBase64, 'base64')).metadata()).toMatchObject({
      format: 'webp',
      width: 320,
      height: 240
    });
    expect(readImage).toHaveBeenCalledTimes(3);
    expect(source).toEqual(original);

    readImage.mockResolvedValueOnce(undefined as never);
    await expect(operation({ ...request, preview })).rejects.toThrow('RUN_IMAGE_NOT_FOUND');
    expect(readImage).toHaveBeenCalledTimes(4);
  });

  it('invalidates Workspace session projections after lifecycle configuration changes', async () => {
    const database = new NodeDatabase(':memory:', 'session-lifecycle-events');
    const workspace = await saveTempWorkspace(database, 'mar-session-lifecycle-');
    const connector = new NodeConnector({ reconnect: false, database });
    const internals = connector as unknown as {
      workspaceSessionService: { markCacheStale(workspaceId: string): void };
      workspaceWorkbenchService: {
        invalidateTopic(workspaceId: string, topic: 'sessions'): Promise<void>;
      };
    };
    try {
      const created = (await operation(connector, 'session.create', {
        workspaceId: workspace.id,
        runner: 'codex',
        cwd: workspace.path,
        model: 'gpt-5.5',
        effort: 'medium',
        access: 'read-only',
        bootstrapOnly: true
      })) as { session: { id: string } };
      const markStale = vi.spyOn(internals.workspaceSessionService, 'markCacheStale');
      const invalidate = vi
        .spyOn(internals.workspaceWorkbenchService, 'invalidateTopic')
        .mockResolvedValue(undefined);
      await expect(
        operation(connector, 'session.config.update', {
          sessionId: created.session.id,
          model: 'gpt-5.6-sol',
          access: 'full-access'
        })
      ).resolves.toMatchObject({
        session: { model: 'gpt-5.6-sol', access: 'full-access' }
      });
      expect(markStale).toHaveBeenCalledWith(workspace.id);
      expect(invalidate).toHaveBeenCalledWith(workspace.id, 'sessions');
    } finally {
      await connector.stop();
    }
  });

  it('publishes metadata changes and invalidates Workspace projections without requiring a prompt update', async () => {
    const database = new NodeDatabase(':memory:', 'session-metadata-events');
    const workspace = database.saveWorkspace({
      path: '/workspace/session-metadata-events',
      kind: 'DIRECTORY',
      gitSummary: null
    });
    const connector = new NodeConnector({ reconnect: false, database });
    const internals = connector as unknown as {
      runtime: { createAgentSession(input: unknown): NodeAgentSession };
      workbenchEventService: { publish(event: unknown): void };
      workspaceSessionService: { markCacheStale(workspaceId: string): void };
      workspaceWorkbenchService: {
        invalidateTopic(workspaceId: string, topic: 'sessions'): Promise<void>;
      };
    };
    try {
      const session = internals.runtime.createAgentSession({
        workspaceId: workspace.id,
        runner: 'mar-agent',
        cwd: workspace.path,
        externalSessionId: 'metadata-native',
        model: 'model',
        access: 'full-access'
      });
      const publish = vi.spyOn(internals.workbenchEventService, 'publish');
      const markStale = vi.spyOn(internals.workspaceSessionService, 'markCacheStale');
      const invalidate = vi
        .spyOn(internals.workspaceWorkbenchService, 'invalidateTopic')
        .mockResolvedValue(undefined);
      const changes = [
        { input: { customTitle: 'Renamed task' }, expected: { customTitle: 'Renamed task' } },
        { input: { pinned: true }, expected: { pinnedAt: expect.any(Number) } },
        { input: { pinned: false }, expected: { pinnedAt: null, pinOrder: null } },
        {
          input: { sessionPrompt: 'Task instructions' },
          expected: { sessionPrompt: 'Task instructions' }
        },
        {
          input: {
            customTitle: 'Combined update',
            pinned: true,
            sessionPrompt: 'New instructions'
          },
          expected: {
            customTitle: 'Combined update',
            pinnedAt: expect.any(Number),
            sessionPrompt: 'New instructions'
          }
        }
      ];
      for (const change of changes) {
        publish.mockClear();
        markStale.mockClear();
        invalidate.mockClear();
        await expect(
          operation(connector, 'session.metadata.update', {
            sessionId: session.id,
            ...change.input
          })
        ).resolves.toMatchObject({ session: change.expected });
        expect(publish).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({
            category: 'session',
            payload: expect.objectContaining({
              session: expect.objectContaining({
                id: session.id,
                workspaceId: workspace.id,
                ...change.expected
              })
            })
          })
        );
        expect(markStale).toHaveBeenCalledExactlyOnceWith(workspace.id);
        expect(invalidate).toHaveBeenCalledExactlyOnceWith(workspace.id, 'sessions');
      }
      publish.mockClear();
      markStale.mockClear();
      invalidate.mockClear();
      await operation(connector, 'session.metadata.update', { sessionId: session.id });
      await expect(
        operation(connector, 'session.metadata.update', {
          sessionId: session.id,
          pinned: 'invalid'
        })
      ).rejects.toThrow('SESSION_INVALID');
      vi.spyOn(database, 'saveNativeSessionMetadata').mockImplementationOnce(() => {
        throw new Error('METADATA_WRITE_FAILED');
      });
      await expect(
        operation(connector, 'session.metadata.update', {
          sessionId: session.id,
          customTitle: 'Not saved'
        })
      ).rejects.toThrow('METADATA_WRITE_FAILED');
      expect(publish).not.toHaveBeenCalled();
      expect(markStale).not.toHaveBeenCalled();
      expect(invalidate).not.toHaveBeenCalled();
    } finally {
      await connector.stop();
    }
  });

  it('rejects parent detachment and reparenting without side effects', async () => {
    const database = new NodeDatabase(':memory:', 'session-parent-clear');
    const workspace = database.saveWorkspace({
      path: '/workspace/session-parent-clear',
      kind: 'DIRECTORY',
      gitSummary: null
    });
    const connector = new NodeConnector({ reconnect: false, database });
    const internals = connector as unknown as {
      runtime: {
        createAgentSession(input: unknown): NodeAgentSession;
        getAgentSession(sessionId: string): NodeAgentSession | undefined;
      };
      workbenchEventService: { publish(event: unknown): void };
      workspaceSessionService: { markCacheStale(workspaceId: string): void };
      workspaceWorkbenchService: {
        invalidateTopic(workspaceId: string, topic: 'sessions'): Promise<void>;
      };
      pendingSessionGroups: Map<string, unknown>;
      send(type: string, payload: unknown): void;
    };
    try {
      const session = internals.runtime.createAgentSession({
        workspaceId: workspace.id,
        runner: 'mar-agent',
        cwd: workspace.path,
        externalSessionId: 'child-native',
        parentSessionId: 'parent-session'
      });
      database.saveNativeSessionMetadata({
        runner: session.runner,
        externalSessionId: session.externalSessionId!,
        workspaceId: workspace.id,
        parentSessionId: 'parent-session'
      });
      const publish = vi.spyOn(internals.workbenchEventService, 'publish');
      const markStale = vi.spyOn(internals.workspaceSessionService, 'markCacheStale');
      const invalidate = vi
        .spyOn(internals.workspaceWorkbenchService, 'invalidateTopic')
        .mockResolvedValue(undefined);
      const send = vi.spyOn(internals, 'send');
      const clearParent = vi.spyOn(database, 'clearSessionParent');
      const saveMetadata = vi.spyOn(database, 'saveNativeSessionMetadata');

      await expect(
        operation(connector, 'session.metadata.update', {
          sessionId: session.id,
          clearParent: true
        })
      ).rejects.toThrow('SESSION_PARENT_IMMUTABLE');

      await expect(
        operation(connector, 'session.metadata.update', {
          sessionId: session.id,
          parentSessionId: 'another-parent'
        })
      ).rejects.toThrow('SESSION_INVALID');

      await expect(
        operation(connector, 'session.metadata.update', {
          sessionId: session.id,
          clearParent: true,
          customTitle: 'also rename'
        })
      ).rejects.toThrow('SESSION_INVALID');
      await expect(
        operation(connector, 'session.metadata.update', {
          sessionId: session.id,
          clearParent: true,
          pinned: true
        })
      ).rejects.toThrow('SESSION_INVALID');
      await expect(
        operation(connector, 'session.metadata.update', {
          sessionId: session.id,
          clearParent: true,
          sessionPrompt: 'also change the prompt'
        })
      ).rejects.toThrow('SESSION_INVALID');

      expect(
        database.getNativeSessionMetadata(session.runner, session.externalSessionId!, workspace.id)
      ).toMatchObject({ parentSessionId: 'parent-session' });
      expect(internals.runtime.getAgentSession(session.id)).toMatchObject({
        id: session.id,
        parentSessionId: 'parent-session'
      });
      expect(clearParent).not.toHaveBeenCalled();
      expect(saveMetadata).not.toHaveBeenCalled();
      expect(publish).not.toHaveBeenCalled();
      expect(markStale).not.toHaveBeenCalled();
      expect(invalidate).not.toHaveBeenCalled();
      expect(send).not.toHaveBeenCalled();
      expect(internals.pendingSessionGroups.size).toBe(0);
    } finally {
      await connector.stop();
    }
  });

  it('rejects clearing an immutable parent without interrupting an active run', async () => {
    const database = new NodeDatabase(':memory:', 'session-parent-null-authority');
    const workspace = database.saveWorkspace({
      path: '/workspace/session-parent-null-authority',
      kind: 'DIRECTORY',
      gitSummary: null
    });
    const connector = new NodeConnector({ reconnect: false, database });
    const internals = connector as unknown as {
      runtime: {
        createAgentSession(input: unknown): NodeAgentSession;
        getAgentSession(sessionId: string): NodeAgentSession | undefined;
        createMessageRun(input: unknown): { run: { id: string } };
        transitionRun(id: string, next: 'RUNNING'): { id: string; status: string };
        getRun(id: string): { id: string; sessionId: string; status: string } | undefined;
      };
      workbenchEventService: { publish(event: unknown): void };
      pendingSessionGroups: Map<string, unknown>;
      send(type: string, payload: unknown): void;
    };
    try {
      const session = internals.runtime.createAgentSession({
        workspaceId: workspace.id,
        runner: 'mar-agent',
        cwd: workspace.path,
        externalSessionId: 'stale-child-native',
        parentSessionId: 'parent-session'
      });
      database.saveNativeSessionMetadata({
        runner: session.runner,
        externalSessionId: session.externalSessionId!,
        workspaceId: workspace.id,
        parentSessionId: 'parent-session'
      });
      const activeRun = internals.runtime.createMessageRun({
        sessionId: session.id,
        clientMessageId: 'active-child-run',
        content: 'keep running'
      }).run;
      internals.runtime.transitionRun(activeRun.id, 'RUNNING');

      const clearParent = vi.spyOn(database, 'clearSessionParent');
      const publish = vi.spyOn(internals.workbenchEventService, 'publish');
      const send = vi.spyOn(internals, 'send');
      await expect(
        operation(connector, 'session.metadata.update', {
          sessionId: session.id,
          clearParent: true
        })
      ).rejects.toThrow('SESSION_PARENT_IMMUTABLE');

      expect(
        database.getNativeSessionMetadata(session.runner, session.externalSessionId!, workspace.id)
      ).toMatchObject({ parentSessionId: 'parent-session' });
      expect(internals.runtime.getAgentSession(session.id)?.parentSessionId).toBe('parent-session');
      expect(clearParent).not.toHaveBeenCalled();
      expect(publish).not.toHaveBeenCalled();
      expect(send.mock.calls.filter(([type]) => type === 'session.group.changed')).toEqual([]);
      expect(internals.pendingSessionGroups.size).toBe(0);
      expect(internals.runtime.getRun(activeRun.id)).toMatchObject({
        id: activeRun.id,
        sessionId: session.id,
        status: 'RUNNING'
      });
    } finally {
      await connector.stop();
    }
  });

  it('does not queue or replay a parent-group change for an immutable relation', async () => {
    const database = new NodeDatabase(':memory:', 'session-group-ack-reconnect');
    const workspace = database.saveWorkspace({
      path: '/workspace/session-group-ack-reconnect',
      kind: 'DIRECTORY',
      gitSummary: null
    });
    const connector = new NodeConnector({ reconnect: false, database });
    const internals = connector as unknown as {
      config: unknown;
      runtime: { createAgentSession(input: unknown): NodeAgentSession };
      controlMessages: { handle(raw: string): void };
      connectionLifecycle: { register(nodeId: string, credential: string): Promise<void> };
      pendingSessionGroups: Map<string, unknown>;
      send(type: string, payload: unknown): void;
    };
    try {
      internals.config = {};
      const session = internals.runtime.createAgentSession({
        workspaceId: workspace.id,
        runner: 'mar-agent',
        cwd: workspace.path,
        externalSessionId: 'child-native',
        parentSessionId: 'parent-session'
      });
      database.saveNativeSessionMetadata({
        runner: session.runner,
        externalSessionId: session.externalSessionId!,
        workspaceId: workspace.id,
        parentSessionId: 'parent-session'
      });
      const register = vi
        .spyOn(internals.connectionLifecycle, 'register')
        .mockResolvedValue(undefined);
      const send = vi.spyOn(internals, 'send');
      const sendControl = (type: string, payload: unknown) =>
        internals.controlMessages.handle(JSON.stringify(createEnvelope(type, payload)));

      await expect(
        operation(connector, 'session.metadata.update', {
          sessionId: session.id,
          clearParent: true
        })
      ).rejects.toThrow('SESSION_PARENT_IMMUTABLE');
      expect(internals.pendingSessionGroups.size).toBe(0);
      expect(send.mock.calls.filter(([type]) => type === 'session.group.changed')).toEqual([]);

      sendControl('registered', { nodeId: session.nodeId, credential: 'test-credential' });
      await vi.waitFor(() =>
        expect(register).toHaveBeenCalledWith(session.nodeId, 'test-credential')
      );
      sendControl('authenticated', {});
      sendControl('session.group.ack', {
        nodeId: session.nodeId,
        workspaceId: workspace.id,
        sessionId: session.id,
        sessionGroup: 'MAIN'
      });
      expect(internals.pendingSessionGroups.size).toBe(0);
      expect(send.mock.calls.filter(([type]) => type === 'session.group.changed')).toEqual([]);
      expect(
        database.getNativeSessionMetadata(session.runner, session.externalSessionId!, workspace.id)
      ).toMatchObject({ parentSessionId: 'parent-session' });
    } finally {
      await connector.stop();
    }
  });

  it.each(['up', 'down'] as const)(
    'invalidates only the owning Workspace after moving a persisted pin %s',
    async (direction) => {
      const database = new NodeDatabase(':memory:', 'session-pin-order-events');
      const workspace = database.saveWorkspace({
        path: '/workspace/session-pin-order-events',
        kind: 'DIRECTORY',
        gitSummary: null
      });
      const otherWorkspace = database.saveWorkspace({
        path: '/workspace/other-session-pin-order-events',
        kind: 'DIRECTORY',
        gitSummary: null
      });
      for (const id of ['last', 'moving', 'first'])
        database.saveNativeSessionMetadata({
          runner: 'mar-agent',
          externalSessionId: id,
          workspaceId: workspace.id,
          pinned: true
        });
      database.saveNativeSessionMetadata({
        runner: 'mar-agent',
        externalSessionId: 'other',
        workspaceId: otherWorkspace.id,
        pinned: true
      });
      database.saveNativeSessionMetadata({
        runner: 'mar-agent',
        externalSessionId: 'plain',
        workspaceId: workspace.id,
        customTitle: 'Not pinned'
      });
      const connector = new NodeConnector({ reconnect: false, database });
      const internals = connector as unknown as {
        runtime: { listAgentSessions(): readonly NodeAgentSession[] };
        workspaceWorkbenchService: {
          invalidateTopic(workspaceId: string, topic: 'sessions'): Promise<void>;
        };
      };
      const expectedOrder =
        direction === 'up' ? ['moving', 'first', 'last'] : ['first', 'last', 'moving'];
      const pinnedIds = () =>
        database
          .listSessionRecords(workspace.id)
          .filter((record) => record.pinOrder !== null)
          .map((record) => record.id);
      const invalidate = vi
        .spyOn(internals.workspaceWorkbenchService, 'invalidateTopic')
        .mockImplementation(async () => {
          expect(pinnedIds()).toEqual(expectedOrder);
        });
      try {
        await expect(
          operation(connector, 'session.pin.move', { sessionId: 'moving', direction })
        ).resolves.toEqual({ moved: true });
        expect(pinnedIds()).toEqual(expectedOrder);
        expect(invalidate).toHaveBeenCalledExactlyOnceWith(workspace.id, 'sessions');
        expect(database.listSessionRecords(otherWorkspace.id).map((record) => record.id)).toEqual([
          'other'
        ]);
        expect(internals.runtime.listAgentSessions()).toEqual([]);
        invalidate.mockClear();
        await expect(
          operation(connector, 'session.pin.move', { sessionId: 'moving', direction })
        ).resolves.toEqual({ moved: true });
        expect(pinnedIds()).toEqual(expectedOrder);
        expect(invalidate).toHaveBeenCalledExactlyOnceWith(workspace.id, 'sessions');
        const listed = (await operation(connector, 'session.list', {
          workspaceId: workspace.id,
          registeredOnly: true
        })) as { sessions: { id: string }[] };
        expect(listed.sessions.slice(0, 3).map((session) => session.id)).toEqual(expectedOrder);
        invalidate.mockClear();
        await expect(
          operation(connector, 'session.pin.move', { sessionId: 'plain', direction })
        ).rejects.toThrow('SESSION_NOT_PINNED');
        await expect(
          operation(connector, 'session.pin.move', { sessionId: 'missing', direction })
        ).rejects.toThrow('SESSION_NOT_PINNED');
        await expect(
          operation(connector, 'session.pin.move', { sessionId: 'moving', direction: 'invalid' })
        ).rejects.toThrow('SESSION_PIN_MOVE_INVALID');
        expect(invalidate).not.toHaveBeenCalled();
      } finally {
        await connector.stop();
      }
    }
  );

  it('provides versioned Manifest and Runner Profiles with restricted session metadata and history operations', async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), 'mar-workbench-defaults-'));
    onTestFinished(() => rm(workspacePath, { recursive: true, force: true }));
    const database = new NodeDatabase(':memory:', 'node-workbench');
    const workspace = database.saveWorkspace({
      path: workspacePath,
      kind: 'DIRECTORY',
      gitSummary: null
    });
    const connector = new NodeConnector({
      reconnect: false,
      database,
      capabilities: {
        platform: 'linux',
        architecture: 'x64',
        nodeVersion: process.version,
        codex: { available: true, version: 'codex-cli 0.147.0' },
        claudeCode: { available: false }
      },
      codexProfileClientFactory: () =>
        ({
          start: vi.fn(async () => undefined),
          stop: vi.fn(),
          listModels: vi.fn(async () => ({
            data: [
              {
                model: 'gpt-5.6-sol',
                displayName: 'GPT-5.6-Sol',
                hidden: false,
                isDefault: true,
                defaultReasoningEffort: 'low',
                supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'].map(
                  (reasoningEffort) => ({ reasoningEffort, description: '' })
                )
              },
              ...['gpt-5.6-terra', 'gpt-5.6-luna'].map((model) => ({
                model,
                displayName: model,
                hidden: false,
                isDefault: false,
                defaultReasoningEffort: 'medium',
                supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh'].map(
                  (reasoningEffort) => ({ reasoningEffort, description: '' })
                )
              }))
            ],
            nextCursor: null
          }))
        }) as unknown as CodexAppServerClient
    });

    const manifest = (await operation(connector, 'node.workbench.capabilities', {})) as {
      manifest: {
        revision: number;
        conversation: { available: boolean; supportsItemFinalSnapshots: boolean };
        runners: { runner: string; capabilities: string[] }[];
      };
    };
    expect(manifest.manifest).toMatchObject({
      manifestVersion: 1,
      platform: 'linux',
      conversation: { available: true, supportsItemFinalSnapshots: true }
    });
    expect(manifest.manifest.runners).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          runner: 'codex',
          capabilities: expect.arrayContaining(['turn.start'])
        })
      ])
    );
    const cachedProfiles = (await operation(connector, 'runner.profiles.list', {
      waitForRefresh: false
    })) as {
      profiles: { runner: string; models: { id: string }[] }[];
    };
    expect(cachedProfiles.profiles.find((profile) => profile.runner === 'codex')?.models).toEqual(
      []
    );
    const profiles = (await operation(connector, 'runner.profiles.list', {
      waitForRefresh: true
    })) as {
      profiles: {
        runner: string;
        models: { id: string; supportedEfforts: string[] }[];
        accessOptions: { id: string; label: string }[];
        commands: { id: string; interaction: string; description: string }[];
      }[];
      defaults: {
        runner: string;
        model: string;
        effort: string;
        access: string;
      }[];
    };
    expect(profiles.defaults).toEqual([]);
    expect(profiles.profiles.map((profile) => profile.runner)).toEqual([
      'opencode',
      'codex',
      'claude-code'
    ]);
    const codexProfile = profiles.profiles.find((profile) => profile.runner === 'codex');
    expect(codexProfile).toMatchObject({
      models: expect.arrayContaining([expect.objectContaining({ id: 'gpt-5.6-sol' })]),
      accessOptions: expect.arrayContaining([
        expect.objectContaining({ id: 'on-request', label: 'On-request' }),
        expect.objectContaining({ id: 'full-access' })
      ])
    });
    expect(codexProfile?.models).toEqual(
      expect.arrayContaining(
        ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'].map((id) =>
          expect.objectContaining({ id })
        )
      )
    );
    expect(profiles.profiles.find((profile) => profile.runner === 'claude-code')).toMatchObject({
      models: expect.arrayContaining([expect.objectContaining({ id: 'sonnet' })]),
      accessOptions: expect.arrayContaining([
        expect.objectContaining({ id: 'accept-edits' }),
        expect.objectContaining({ id: 'bypass', label: 'Bypass permissions' })
      ])
    });
    expect(profiles.profiles.find((profile) => profile.runner === 'codex')).toMatchObject({
      commands: expect.arrayContaining([
        expect.objectContaining({ id: 'compact', interaction: 'IMMEDIATE_ACTION' }),
        expect.objectContaining({ id: 'plan', interaction: 'TOGGLE' }),
        expect.objectContaining({ id: 'fast', interaction: 'TOGGLE' }),
        expect.objectContaining({
          id: 'goal',
          interaction: 'TOGGLE',
          source: 'MAR_RUNTIME',
          inputHint: '/goal'
        })
      ])
    });
    expect(
      profiles.profiles
        .find((profile) => profile.runner === 'codex')
        ?.commands.filter((command) => command.id === 'goal')
    ).toEqual([expect.objectContaining({ source: 'MAR_RUNTIME' })]);
    expect(profiles.profiles.find((profile) => profile.runner === 'claude-code')).toMatchObject({
      commands: [
        expect.objectContaining({ id: 'compact', interaction: 'IMMEDIATE_ACTION' }),
        expect.objectContaining({ id: 'plan', interaction: 'TOGGLE' }),
        expect.objectContaining({ id: 'goal', interaction: 'TOGGLE', source: 'MAR_RUNTIME' })
      ]
    });
    expect(profiles.profiles.find((profile) => profile.runner === 'opencode')).toMatchObject({
      commands: [
        expect.objectContaining({ id: 'compact', interaction: 'IMMEDIATE_ACTION' }),
        expect.objectContaining({ id: 'plan', interaction: 'TOGGLE' }),
        expect.objectContaining({ id: 'goal', interaction: 'TOGGLE', source: 'MAR_RUNTIME' })
      ]
    });
    const commonCommandDescriptions = profiles.profiles.map((profile) =>
      Object.fromEntries(
        profile.commands
          .filter(
            (command) => command.id === 'compact' || command.id === 'plan' || command.id === 'goal'
          )
          .map((command) => [command.id, command.description])
      )
    );
    expect(commonCommandDescriptions).toEqual([
      {
        compact: 'Compact the current session context.',
        plan: 'Toggle collaborative Plan Mode.',
        goal: 'Enter persistent Goal mode.'
      },
      {
        compact: 'Compact the current session context.',
        plan: 'Toggle collaborative Plan Mode.',
        goal: 'Enter persistent Goal mode.'
      },
      {
        compact: 'Compact the current session context.',
        plan: 'Toggle collaborative Plan Mode.',
        goal: 'Enter persistent Goal mode.'
      }
    ]);
    expect(
      profiles.profiles
        .flatMap((profile) => profile.models)
        .some((model) => model.id === 'runner-default')
    ).toBe(false);
    database.saveRunnerDefaults({
      runner: 'codex',
      model: 'removed-model',
      effort: 'medium',
      access: 'on-request'
    });
    expect(
      (
        (await operation(connector, 'runner.profiles.list', {})) as {
          defaults: unknown[];
        }
      ).defaults
    ).toEqual([
      {
        runner: 'codex',
        model: 'removed-model',
        effort: 'medium',
        access: 'on-request'
      }
    ]);
    const savedDefaults = (await operation(connector, 'runner.defaults.save', {
      runner: 'codex',
      model: 'gpt-5.6-terra',
      effort: 'high',
      access: 'workspace-write'
    })) as { defaults: { runner: string; model: string; effort: string; access: string } };
    expect(savedDefaults.defaults).toEqual({
      runner: 'codex',
      model: 'gpt-5.6-terra',
      effort: 'high',
      access: 'workspace-write'
    });
    const savedClaudeDefaults = (await operation(connector, 'runner.defaults.save', {
      runner: 'claude-code',
      model: 'sonnet',
      effort: 'medium',
      access: 'default'
    })) as { defaults: { runner: string; model: string; effort: string; access: string } };
    expect(savedClaudeDefaults.defaults).toMatchObject({ runner: 'claude-code' });
    expect(
      (
        (await operation(connector, 'runner.profiles.list', {})) as {
          defaults: { runner: string }[];
        }
      ).defaults.map((value) => value.runner)
    ).toEqual(['claude-code', 'codex']);
    await expect(
      operation(connector, 'runner.defaults.save', {
        runner: 'codex',
        model: 'model-selected-by-web',
        effort: 'custom-effort',
        access: 'workspace-write'
      })
    ).resolves.toMatchObject({
      defaults: {
        runner: 'codex',
        model: 'model-selected-by-web',
        effort: 'custom-effort',
        access: 'workspace-write'
      }
    });
    await expect(
      operation(connector, 'session.create', {
        workspaceId: workspace.id,
        runner: 'codex',
        cwd: workspace.path,
        model: 'model-selected-by-web',
        effort: 'custom-effort',
        access: 'custom-access',
        bootstrapOnly: true
      })
    ).resolves.toMatchObject({
      session: {
        runner: 'codex',
        model: 'model-selected-by-web',
        effort: 'custom-effort',
        access: 'custom-access'
      }
    });
    const created = (await operation(connector, 'session.create', {
      workspaceId: workspace.id,
      runner: 'codex',
      cwd: workspace.path,
      model: 'gpt-5.6-sol',
      effort: 'high',
      access: 'full-access',
      title: 'Read the current project structure first'
    })) as { session: { id: string; runnerTitle: string | null } };
    const session = created.session;
    expect(session.runnerTitle).toBe('Read the current project structure first');

    const configured = (await operation(connector, 'session.config.update', {
      sessionId: session.id,
      model: 'gpt-5.6-sol',
      effort: 'high',
      access: 'full-access'
    })) as { session: { model: string; effort: string; access: string } };
    expect(configured.session).toMatchObject({
      model: 'gpt-5.6-sol',
      effort: 'high',
      access: 'full-access'
    });
    expect(
      (
        (await operation(connector, 'runner.profiles.list', {})) as {
          defaults: { runner: string; model: string; effort: string; access: string }[];
        }
      ).defaults.find((value) => value.runner === 'codex')
    ).toEqual({
      runner: 'codex',
      model: 'gpt-5.6-sol',
      effort: 'high',
      access: 'full-access'
    });
    await expect(
      operation(connector, 'session.config.update', {
        sessionId: session.id,
        model: 'sonnet',
        effort: 'high',
        access: 'workspace-write'
      })
    ).resolves.toMatchObject({
      session: {
        model: 'sonnet',
        effort: 'high',
        access: 'workspace-write'
      }
    });
    await expect(
      operation(connector, 'session.config.update', {
        sessionId: session.id,
        model: '',
        effort: 'high',
        access: 'workspace-write'
      })
    ).rejects.toThrow('SESSION_INVALID');

    const updated = (await operation(connector, 'session.metadata.update', {
      sessionId: session.id,
      customTitle: 'current task',
      pinned: true
    })) as {
      session: { customTitle: string; pinnedAt: number | null; runtime: { level: string } };
    };
    expect(updated.session).toMatchObject({
      customTitle: 'current task',
      pinnedAt: expect.any(Number),
      runtime: { level: 'MANAGED' }
    });
    for (const customTitle of [null, '', '   ']) {
      await expect(
        operation(connector, 'session.metadata.update', { sessionId: session.id, customTitle })
      ).rejects.toThrow('SESSION_TITLE_REQUIRED');
    }
    await expect(
      operation(connector, 'session.metadata.update', {
        sessionId: session.id,
        customTitle: 123
      })
    ).rejects.toThrow('SESSION_INVALID');
    await expect(
      operation(connector, 'session.metadata.update', {
        sessionId: session.id,
        customTitle: 'Title'.repeat(81)
      })
    ).rejects.toThrow('SESSION_TITLE_INVALID');
    await expect(
      operation(connector, 'session.metadata.update', { sessionId: session.id, pinned: 'yes' })
    ).rejects.toThrow('SESSION_INVALID');
    await expect(
      operation(connector, 'session.turns.list', { sessionId: session.id, limit: 0 })
    ).rejects.toThrow('EVENT_CURSOR_INVALID');
    await expect(
      operation(connector, 'session.command.execute', {
        sessionId: session.id,
        commandId: 'not-declared',
        input: '/not-declared'
      })
    ).rejects.toThrow('RUNNER_COMMAND_UNAVAILABLE');
    database.close();
  });

  it('creates a distinct Manifest revision when the Runner capability snapshot changes', async () => {
    const firstDatabase = new NodeDatabase(':memory:', 'node-unavailable');
    const secondDatabase = new NodeDatabase(':memory:', 'node-available');
    const unavailable = new NodeConnector({
      reconnect: false,
      database: firstDatabase,
      capabilities: {
        platform: 'linux',
        architecture: 'x64',
        nodeVersion: process.version,
        codex: { available: false },
        claudeCode: { available: false }
      }
    });
    const available = new NodeConnector({
      reconnect: false,
      database: secondDatabase,
      capabilities: {
        platform: 'linux',
        architecture: 'x64',
        nodeVersion: process.version,
        codex: { available: true, version: 'codex-cli 0.147.0' },
        claudeCode: { available: false }
      }
    });
    const first = (await operation(unavailable, 'node.workbench.capabilities', {})) as {
      manifest: { revision: number };
    };
    const second = (await operation(available, 'node.workbench.capabilities', {})) as {
      manifest: { revision: number };
    };
    expect(first.manifest.revision).not.toBe(second.manifest.revision);
    firstDatabase.close();
    secondDatabase.close();
  });

  it('publishes a complete Turn for a command Run first Item with no user message and does not duplicate terminal state', () => {
    const database = new NodeDatabase(':memory:', 'node-command-item-turn');
    const workspace = database.saveWorkspace({
      path: '/workspace/command-item-turn',
      kind: 'DIRECTORY',
      gitSummary: null
    });
    const connector = new NodeConnector({ reconnect: false, database });
    const internals = connector as unknown as {
      runtime: {
        createAgentSession(input: Record<string, unknown>): NodeAgentSession;
        adoptRun(input: Record<string, unknown>): { id: string };
      };
      nativeSessionWatchService: {
        emitRealtime(sessionId: string, event: { category: string; payload: unknown }): boolean;
      };
      emitRunEvent(runId: string, eventType: string, payload: unknown, status?: 'SUCCEEDED'): void;
      emitConversationItem(runId: string, item: unknown): void;
    };
    const session = internals.runtime.createAgentSession({
      workspaceId: workspace.id,
      runner: 'mar-agent',
      cwd: workspace.path,
      externalSessionId: 'mar-command-session',
      nativeControl: 'MAR_MANAGED'
    });
    const run = internals.runtime.adoptRun({
      runId: 'mar-command-run',
      sessionId: session.id,
      runner: 'mar-agent',
      cwd: workspace.path,
      externalSessionId: 'mar-command-session'
    });
    const emitted: Array<{ category: string; payload: unknown }> = [];
    vi.spyOn(internals.nativeSessionWatchService, 'emitRealtime').mockImplementation(
      (_sessionId, event) => {
        emitted.push(event);
        return true;
      }
    );

    internals.emitConversationItem(run.id, {
      itemId: 'mar-agent-compact:compact-1',
      kind: 'context_compaction',
      status: 'IN_PROGRESS',
      payload: { phase: 'STARTED', summary: null },
      merge: true
    });

    expect(emitted).toContainEqual(
      expect.objectContaining({
        category: 'conversation',
        payload: expect.objectContaining({
          turn: expect.objectContaining({
            runId: run.id,
            userItemId: null,
            items: [
              expect.objectContaining({
                kind: 'context_compaction',
                status: 'IN_PROGRESS',
                payload: { phase: 'STARTED', summary: null }
              })
            ]
          })
        })
      })
    );

    const terminalSession = internals.runtime.createAgentSession({
      workspaceId: workspace.id,
      runner: 'mar-agent',
      cwd: workspace.path,
      externalSessionId: 'mar-terminal-command-session',
      nativeControl: 'MAR_MANAGED'
    });
    const terminalRun = internals.runtime.adoptRun({
      runId: 'mar-terminal-command-run',
      sessionId: terminalSession.id,
      runner: 'mar-agent',
      cwd: workspace.path,
      externalSessionId: 'mar-terminal-command-session'
    });
    emitted.length = 0;

    internals.emitRunEvent(
      terminalRun.id,
      'conversation.item',
      {
        itemId: 'mar-agent-compact:compact-terminal',
        kind: 'context_compaction',
        status: 'COMPLETED',
        payload: { phase: 'COMPLETED', summary: null },
        merge: true
      },
      'SUCCEEDED'
    );

    const terminalTurnFrames = emitted.filter(
      (event) =>
        event.category === 'conversation' &&
        typeof event.payload === 'object' &&
        event.payload !== null &&
        'turn' in event.payload
    );
    expect(terminalTurnFrames).toHaveLength(1);
    expect(terminalTurnFrames[0]?.payload).toEqual(
      expect.objectContaining({
        turn: expect.objectContaining({
          runId: terminalRun.id,
          status: 'SUCCEEDED',
          items: [
            expect.objectContaining({
              kind: 'context_compaction',
              status: 'COMPLETED',
              payload: { phase: 'COMPLETED', summary: null }
            })
          ]
        })
      })
    );
    connector.stop();
  });

  it('clears stale context and publishes null when a known value becomes unknown', async () => {
    vi.useFakeTimers();
    const session = {
      id: 'session-context-cleared',
      workspaceId: 'workspace-context-cleared',
      externalSessionId: 'native-context-cleared',
      model: 'model-context-cleared'
    } as NodeAgentSession;
    let usage:
      | { readonly model: string; readonly usedTokens: number; readonly maxTokens: number }
      | undefined = {
      model: 'provider-model',
      usedTokens: 125_836,
      maxTokens: 200_000
    };
    const publish = vi.fn();
    const service = new SessionContextService({
      runners: {
        product: () => ({
          readContextUsage: async () => usage
        })
      } as never,
      session: () => session,
      stopped: () => false,
      publish
    });
    try {
      await service.read(session);
      expect(service.snapshot(session.id)).toMatchObject({ usedTokens: 125_836 });

      usage = undefined;
      service.schedule(session);
      await vi.advanceTimersByTimeAsync(100);

      expect(service.snapshot(session.id)).toBeNull();
      expect(publish).toHaveBeenCalledWith({
        sessionId: session.id,
        workspaceId: session.workspaceId,
        context: null,
        pending: false
      });
    } finally {
      service.dispose();
      vi.useRealTimers();
    }
  });

  it('restores the existing Thread before returning the managed Codex compact Run and settles it after compaction', async () => {
    const database = new NodeDatabase(':memory:', 'node-compact');
    const workspace = await saveTempWorkspace(database, 'mar-compact-');
    let notify: ((notification: { method: string; params: unknown }) => void) | undefined;
    const configuredEnvironments: Readonly<Record<string, string>>[] = [];
    const resumeThread = vi.fn().mockResolvedValue({ thread: { id: 'thread-compact' } });
    const compactRequest = vi.fn().mockResolvedValue({});
    const createCodexClient = () => ({
      onNotification(listener: (notification: { method: string; params: unknown }) => void) {
        notify = listener;
        return () => undefined;
      },
      start: async () => undefined,
      resumeThread,
      request: compactRequest,
      configureEnvironment: (environment: Readonly<Record<string, string>>) =>
        configuredEnvironments.push(environment),
      clearEnvironment: () => undefined,
      stop: () => undefined
    });
    const codexClient = createCodexClient();
    const connector = new NodeConnector({
      reconnect: false,
      database,
      capabilities: {
        platform: 'linux',
        architecture: 'x64',
        nodeVersion: process.version,
        codex: { available: true, version: 'codex-cli 0.147.0' },
        claudeCode: { available: false }
      },
      codexClient: codexClient as never,
      codexRunClientFactory: () => createCodexClient() as never
    });
    const internals = connector as unknown as {
      runtime: {
        createAgentSession(input: Record<string, unknown>): { id: string };
        setNativeControl(id: string, control: 'MAR_MANAGED'): void;
        getRun(runId: string): { status: string } | undefined;
        pauseSessionQueue(sessionId: string): void;
        sessionQueue(sessionId: string): { paused: boolean };
      };
      sessionContextService: {
        read(session: unknown): Promise<{
          context: { model: string; usedTokens: number; maxTokens: number; percentage: number };
          pending: false;
        }>;
      };
      nativeSessionWatchService: {
        emitRealtime(sessionId: string, event: { category: string; payload: unknown }): void;
      };
    };
    const session = internals.runtime.createAgentSession({
      workspaceId: workspace.id,
      runner: 'codex',
      cwd: workspace.path,
      externalSessionId: 'thread-compact',
      nativeControl: 'MAR_MANAGED'
    });
    const sent: { type: string; payload: Record<string, unknown> }[] = [];
    connectTestSocket(connector, captureSocket(sent));
    const emitRealtime = vi.spyOn(internals.nativeSessionWatchService, 'emitRealtime');
    internals.runtime.pauseSessionQueue(session.id);
    const result = (await operation(connector, 'session.command.execute', {
      sessionId: session.id,
      commandId: 'compact',
      input: '/compact',
      secretEnvironment: { API_KEY: 'first' }
    })) as { run: { id: string } };
    expect(resumeThread).toHaveBeenCalledWith('thread-compact', workspace.path, undefined);
    expect(compactRequest).toHaveBeenCalledWith('thread/compact/start', {
      threadId: 'thread-compact'
    });
    expect(resumeThread.mock.invocationCallOrder[0]).toBeLessThan(
      compactRequest.mock.invocationCallOrder[0]!
    );
    await vi.waitFor(() => {
      expect(internals.runtime.sessionQueue(session.id).paused).toBe(false);
    });
    await expect(
      operation(connector, 'session.command.execute', {
        sessionId: session.id,
        commandId: 'compact',
        input: '/compact'
      })
    ).rejects.toThrow('RUNNER_COMMAND_UNAVAILABLE');
    const contextRead = vi.fn().mockResolvedValue({
      context: { model: 'gpt-5.6-sol', usedTokens: 20_000, maxTokens: 200_000, percentage: 10 },
      pending: false
    });
    internals.sessionContextService.read = contextRead;
    expect(internals.runtime.getRun(result.run.id)?.status).toBe('STARTING');
    notify?.({
      method: 'turn/started',
      params: { threadId: 'thread-compact', turn: { id: 'turn-compact' } }
    });
    expect(internals.runtime.getRun(result.run.id)?.status).toBe('RUNNING');
    notify?.({
      method: 'turn/completed',
      params: { threadId: 'thread-compact', turn: { id: 'turn-compact', status: 'completed' } }
    });
    expect(internals.runtime.getRun(result.run.id)).toBeUndefined();
    await operation(connector, 'session.command.execute', {
      sessionId: session.id,
      commandId: 'compact',
      input: '/compact',
      secretEnvironment: { API_KEY: 'second' }
    });
    expect(configuredEnvironments).toEqual([
      expect.objectContaining({
        API_KEY: 'first',
        MAR_CTL_CONTEXT_REQUIRED: '1',
        MAR_NODE_CONTEXT: '1',
        MAR_USERNAME: ''
      }),
      expect.objectContaining({
        API_KEY: 'second',
        MAR_CTL_CONTEXT_REQUIRED: '1',
        MAR_NODE_CONTEXT: '1',
        MAR_USERNAME: ''
      })
    ]);
    await new Promise((resolve) => setTimeout(resolve, 150));
    const compactRunEvent = emitRealtime.mock.calls.find(
      ([sessionId, event]) =>
        sessionId === 'thread-compact' &&
        event.category === 'run' &&
        ((event.payload as { run?: { id?: string } }).run?.id ?? '') === result.run.id
    );
    expect(
      (compactRunEvent?.[1].payload as { run?: { sessionId?: string } }).run?.sessionId ?? ''
    ).toBe('thread-compact');
    expect(contextRead).toHaveBeenCalled();
    expect(
      emitRealtime.mock.calls.some(
        ([sessionId, event]) =>
          sessionId === 'thread-compact' &&
          event.category === 'session' &&
          (event.payload as { context?: { usedTokens?: number } }).context?.usedTokens === 20_000
      )
    ).toBe(true);
    connector.stop();
  });

  it('allows only the initiating user to interrupt Codex compact and requests a real Runner stop', async () => {
    const database = new NodeDatabase(':memory:', 'node-owned-compact-interrupt');
    const workspace = database.saveWorkspace({
      path: '/workspace/owned-compact-interrupt',
      kind: 'DIRECTORY',
      gitSummary: null
    });
    let notify: ((notification: { method: string; params: unknown }) => void) | undefined;
    const interruptTurn = vi.fn(async () => undefined);
    const connector = new NodeConnector({
      reconnect: false,
      database,
      capabilities: {
        platform: 'linux',
        architecture: 'x64',
        nodeVersion: process.version,
        codex: { available: true, version: 'codex-cli 0.147.0' },
        claudeCode: { available: false }
      },
      codexClient: {
        onNotification(listener: (notification: { method: string; params: unknown }) => void) {
          notify = listener;
          return () => undefined;
        },
        start: async () => undefined,
        resumeThread: async () => ({ thread: { id: 'thread-owned-compact' } }),
        request: async () => ({}),
        configureEnvironment: vi.fn(),
        interruptTurn,
        stop: () => undefined
      } as never
    });
    const internals = connector as unknown as {
      runtime: {
        createAgentSession(input: Record<string, unknown>): { id: string };
        getRun(runId: string): { status: string; initiatedByUserId?: number } | undefined;
      };
    };
    const session = internals.runtime.createAgentSession({
      workspaceId: workspace.id,
      runner: 'codex',
      cwd: workspace.path,
      externalSessionId: 'thread-owned-compact',
      nativeControl: 'MAR_MANAGED'
    });

    try {
      const result = (await operation(connector, 'session.command.execute', {
        sessionId: session.id,
        commandId: 'compact',
        input: '/compact',
        __requestUserId: 7
      })) as { run: { id: string } };
      notify?.({
        method: 'turn/started',
        params: { threadId: 'thread-owned-compact', turn: { id: 'turn-owned-compact' } }
      });

      expect(internals.runtime.getRun(result.run.id)?.initiatedByUserId).toBe(7);
      await expect(
        operation(connector, 'run.interrupt', {
          runId: result.run.id,
          __requestUserId: 8
        })
      ).rejects.toThrow('RUN_OWNED_BY_ANOTHER_USER');
      await expect(
        operation(connector, 'run.interrupt', {
          runId: result.run.id,
          __requestUserId: 7
        })
      ).resolves.toMatchObject({ run: { id: result.run.id, status: 'CANCELLING' } });
      await vi.waitFor(() =>
        expect(interruptTurn).toHaveBeenCalledWith('thread-owned-compact', 'turn-owned-compact')
      );
    } finally {
      connector.stop();
    }
  });

  it('allows only one command Run to acquire the SessionLease when Codex compact starts concurrently', async () => {
    const database = new NodeDatabase(':memory:', 'node-compact-concurrent');
    const workspace = database.saveWorkspace({
      path: '/workspace/compact-concurrent',
      kind: 'DIRECTORY',
      gitSummary: null
    });
    let releaseStart: (() => void) | undefined;
    let firstStarted: (() => void) | undefined;
    const startBarrier = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    const firstStartedPromise = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });
    const connector = new NodeConnector({
      reconnect: false,
      database,
      capabilities: {
        platform: 'linux',
        architecture: 'x64',
        nodeVersion: process.version,
        codex: { available: true, version: 'codex-cli 0.147.0' },
        claudeCode: { available: false }
      },
      codexClient: {
        onNotification: () => () => undefined,
        start: async () => {
          firstStarted?.();
          await startBarrier;
        },
        resumeThread: async () => ({ thread: { id: 'thread-compact-concurrent' } }),
        request: async () => ({}),
        configureEnvironment: vi.fn(),
        stop: () => undefined
      } as never
    });
    const internals = connector as unknown as {
      runtime: {
        createAgentSession(input: Record<string, unknown>): { id: string };
        listRunsForSession(sessionId: string): readonly { status: string }[];
      };
    };
    const session = internals.runtime.createAgentSession({
      workspaceId: workspace.id,
      runner: 'codex',
      cwd: workspace.path,
      externalSessionId: 'thread-compact-concurrent',
      nativeControl: 'MAR_MANAGED'
    });

    const first = operation(connector, 'session.command.execute', {
      sessionId: session.id,
      commandId: 'compact',
      input: '/compact'
    });
    await firstStartedPromise;
    const second = operation(connector, 'session.command.execute', {
      sessionId: session.id,
      commandId: 'compact',
      input: '/compact'
    });
    await Promise.resolve();
    releaseStart?.();

    const results = await Promise.allSettled([first, second]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(results.find((result) => result.status === 'rejected')).toMatchObject({
      reason: new Error('RUNNER_COMMAND_UNAVAILABLE')
    });
    expect(internals.runtime.listRunsForSession(session.id)).toHaveLength(1);
    connector.stop();
  });

  it('runs Claude Code compact in a separate managed Run without writing a /compact user bubble', async () => {
    const database = new NodeDatabase(':memory:', 'node-claude-compact');
    const workspace = database.saveWorkspace({
      path: '/workspace/claude-compact',
      kind: 'DIRECTORY',
      gitSummary: null
    });
    let prompt: string | undefined;
    let complete!: () => void;
    const connector = new NodeConnector({
      reconnect: false,
      database,
      capabilities: {
        platform: 'linux',
        architecture: 'x64',
        nodeVersion: process.version,
        codex: { available: false },
        claudeCode: { available: true, version: '2.1.0' }
      },
      claudeClient: {
        startChannel(input: { prompt: string }) {
          prompt = input.prompt;
          return {
            completed: new Promise<void>((resolve) => {
              complete = resolve;
            }),
            deliver: async () => undefined,
            interrupt: async () => undefined,
            cancel: () => undefined,
            getContextUsage: async () => ({
              model: 'claude-sonnet',
              usedTokens: 1,
              maxTokens: 2,
              rawMaxTokens: 2,
              percentage: 50
            })
          };
        }
      } as never
    });
    const internals = connector as unknown as {
      runtime: {
        createAgentSession(input: Record<string, unknown>): { id: string };
        getRun(runId: string): { status: string; initiatedByUserId?: number } | undefined;
        listConversationTurns(input: { sessionId: string }): {
          turns: readonly {
            runId: string | null;
            items: readonly {
              id: string;
              kind: string;
              status: string;
              payload: Record<string, unknown>;
            }[];
          }[];
        };
      };
    };
    const session = internals.runtime.createAgentSession({
      workspaceId: workspace.id,
      runner: 'claude-code',
      cwd: workspace.path,
      externalSessionId: 'claude-compact',
      nativeControl: 'MAR_MANAGED'
    });
    const result = (await operation(connector, 'session.command.execute', {
      sessionId: session.id,
      commandId: 'compact',
      input: '/compact',
      __requestUserId: 7
    })) as { run: { id: string } };
    expect(prompt).toBe('/compact');
    expect(internals.runtime.getRun(result.run.id)?.status).toBe('RUNNING');
    expect(internals.runtime.getRun(result.run.id)?.initiatedByUserId).toBe(7);
    const started = internals.runtime
      .listConversationTurns({ sessionId: session.id })
      .turns.find((turn) => turn.runId === result.run.id)
      ?.items.find((item) => item.kind === 'context_compaction');
    expect(started).toMatchObject({
      status: 'IN_PROGRESS',
      payload: { phase: 'STARTED', summary: null }
    });
    complete();
    await vi.waitFor(() => expect(internals.runtime.getRun(result.run.id)).toBeUndefined());
    const completed = internals.runtime
      .listConversationTurns({ sessionId: session.id })
      .turns.find((turn) => turn.runId === result.run.id)
      ?.items.find((item) => item.kind === 'context_compaction');
    expect(completed).toMatchObject({
      id: started?.id,
      status: 'COMPLETED',
      payload: { phase: 'COMPLETED', summary: null }
    });
    connector.stop();
  });

  it('returns a separate managed Run immediately for OpenCode compact and settles it after asynchronous compaction', async () => {
    const database = new NodeDatabase(':memory:', 'node-opencode-compact');
    const workspace = database.saveWorkspace({
      path: '/workspace/opencode-compact',
      kind: 'DIRECTORY',
      gitSummary: null
    });
    let complete!: () => void;
    const summarize = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            complete = resolve;
          })
      )
      .mockRejectedValueOnce(new Error('COMPACT_FAILED'));
    const configureEnvironment = vi.fn();
    const connector = new NodeConnector({
      reconnect: false,
      database,
      capabilities: {
        platform: 'linux',
        architecture: 'x64',
        nodeVersion: process.version,
        codex: { available: false },
        claudeCode: { available: false },
        openCode: { available: true, version: '1.0.0' }
      },
      openCodeClient: {
        summarize,
        abort: vi.fn(async () => undefined),
        stop: vi.fn(async () => undefined)
      } as never
    });
    const internals = connector as unknown as {
      openCodeClient: { clientFactory(): unknown };
      runtime: {
        createAgentSession(input: Record<string, unknown>): { id: string };
        getRun(runId: string): { status: string; initiatedByUserId?: number } | undefined;
        listConversationTurns(input: { sessionId: string }): {
          turns: readonly {
            runId: string | null;
            items: readonly {
              id: string;
              kind: string;
              status: string;
              payload: Record<string, unknown>;
            }[];
          }[];
        };
      };
    };
    // Environment-scoped executions must use fixture clients rather than a real OpenCode server.
    vi.spyOn(internals.openCodeClient, 'clientFactory').mockImplementation(() => ({
      configureEnvironment,
      summarize,
      abort: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined)
    }));
    const session = internals.runtime.createAgentSession({
      workspaceId: workspace.id,
      runner: 'opencode',
      cwd: workspace.path,
      externalSessionId: 'opencode-compact',
      model: 'provider/model',
      nativeControl: 'MAR_MANAGED'
    });

    const result = (await operation(connector, 'session.command.execute', {
      sessionId: session.id,
      commandId: 'compact',
      input: '/compact',
      __requestUserId: 7
    })) as { run: { id: string } };

    expect(internals.runtime.getRun(result.run.id)?.status).toBe('RUNNING');
    expect(internals.runtime.getRun(result.run.id)?.initiatedByUserId).toBe(7);
    expect(configureEnvironment).toHaveBeenCalledWith(
      expect.objectContaining({
        MAR_CTL_CONTEXT_REQUIRED: '1',
        MAR_NODE_CONTEXT: '1',
        MAR_USERNAME: ''
      })
    );
    expect(summarize).toHaveBeenCalledWith(workspace.path, 'opencode-compact', 'provider/model');
    const started = internals.runtime
      .listConversationTurns({ sessionId: session.id })
      .turns.find((turn) => turn.runId === result.run.id)
      ?.items.find((item) => item.kind === 'context_compaction');
    expect(started).toMatchObject({
      status: 'IN_PROGRESS',
      payload: { phase: 'STARTED', summary: null }
    });
    complete();
    await vi.waitFor(() => expect(internals.runtime.getRun(result.run.id)).toBeUndefined());
    const completed = internals.runtime
      .listConversationTurns({ sessionId: session.id })
      .turns.find((turn) => turn.runId === result.run.id)
      ?.items.find((item) => item.kind === 'context_compaction');
    expect(completed).toMatchObject({
      id: started?.id,
      status: 'COMPLETED',
      payload: { phase: 'COMPLETED', summary: null }
    });
    const failed = (await operation(connector, 'session.command.execute', {
      sessionId: session.id,
      commandId: 'compact',
      input: '/compact'
    })) as { run: { id: string } };
    await vi.waitFor(() => expect(internals.runtime.getRun(failed.run.id)).toBeUndefined());
    const failedCompaction = internals.runtime
      .listConversationTurns({ sessionId: session.id })
      .turns.find((turn) => turn.runId === failed.run.id)
      ?.items.find((item) => item.kind === 'context_compaction');
    expect(failedCompaction).toMatchObject({
      status: 'FAILED',
      payload: { phase: 'STARTED', summary: null }
    });
    connector.stop();
  });

  it('switches Claude Code /plan into tag-based plan state and declares execution continuation', async () => {
    const database = new NodeDatabase(':memory:', 'node-claude-plan');
    const workspace = database.saveWorkspace({
      path: '/workspace/claude-plan',
      kind: 'DIRECTORY',
      gitSummary: null
    });
    const connector = new NodeConnector({
      reconnect: false,
      database,
      capabilities: {
        platform: 'linux',
        architecture: 'x64',
        nodeVersion: process.version,
        codex: { available: false },
        claudeCode: { available: true, version: '2.1.0' }
      }
    });
    const internals = connector as unknown as {
      runtime: {
        createAgentSession(input: Record<string, unknown>): { id: string };
        listConversationTurns(input: { sessionId: string }): { turns: readonly unknown[] };
      };
    };
    const session = internals.runtime.createAgentSession({
      workspaceId: workspace.id,
      runner: 'claude-code',
      cwd: workspace.path,
      externalSessionId: 'claude-plan',
      nativeControl: 'MAR_MANAGED'
    });

    const enabled = (await operation(connector, 'session.command.execute', {
      sessionId: session.id,
      commandId: 'plan',
      input: '/plan'
    })) as { states: readonly Record<string, unknown>[]; session: { commandStates: unknown[] } };
    expect(enabled.states).toEqual([
      expect.objectContaining({
        commandId: 'plan',
        active: true,
        closable: true,
        closeInput: '/plan',
        continuation: { label: 'Implement', prompt: 'Implement the plan above.' }
      })
    ]);
    expect(enabled.session.commandStates).toEqual(enabled.states);
    expect(internals.runtime.listConversationTurns({ sessionId: session.id }).turns).toEqual([]);

    const disabled = (await operation(connector, 'session.command.execute', {
      sessionId: session.id,
      commandId: 'plan',
      input: '/plan'
    })) as { states: readonly unknown[] };
    expect(disabled.states).toEqual([]);
    connector.stop();
  });

  it('rejects /plan when the Claude Code session already has plan access', async () => {
    const database = new NodeDatabase(':memory:', 'node-claude-plan-access');
    const workspace = database.saveWorkspace({
      path: '/workspace/claude-plan-access',
      kind: 'DIRECTORY',
      gitSummary: null
    });
    const connector = new NodeConnector({
      reconnect: false,
      database,
      capabilities: {
        platform: 'linux',
        architecture: 'x64',
        nodeVersion: process.version,
        codex: { available: false },
        claudeCode: { available: true, version: '2.1.0' }
      }
    });
    const internals = connector as unknown as {
      runtime: {
        createAgentSession(input: Record<string, unknown>): { id: string };
      };
    };
    const session = internals.runtime.createAgentSession({
      workspaceId: workspace.id,
      runner: 'claude-code',
      cwd: workspace.path,
      externalSessionId: 'claude-plan-access',
      nativeControl: 'MAR_MANAGED',
      access: 'plan'
    });
    await expect(
      operation(connector, 'session.command.execute', {
        sessionId: session.id,
        commandId: 'plan',
        input: '/plan'
      })
    ).rejects.toThrow('RUNNER_COMMAND_UNAVAILABLE');
    connector.stop();
  });

  it('wraps only the input sent to the Runner while Claude Code Plan Mode is active', async () => {
    const database = new NodeDatabase(':memory:', 'node-claude-plan-input');
    const workspace = await saveTempWorkspace(database, 'mar-claude-plan-input-');
    let prompt: string | undefined;
    const connector = new NodeConnector({
      reconnect: false,
      database,
      capabilities: {
        platform: 'linux',
        architecture: 'x64',
        nodeVersion: process.version,
        codex: { available: false },
        claudeCode: { available: true, version: '2.1.0' }
      },
      claudeClient: {
        startChannel(input: { prompt: string }) {
          prompt = input.prompt;
          return {
            completed: new Promise<void>(() => undefined),
            deliver: async () => undefined,
            interrupt: async () => undefined,
            cancel: () => undefined,
            getContextUsage: async () => ({
              model: 'claude-sonnet',
              usedTokens: 1,
              maxTokens: 2,
              rawMaxTokens: 2,
              percentage: 50
            })
          };
        }
      } as never
    });
    const internals = connector as unknown as {
      runtime: {
        createAgentSession(input: Record<string, unknown>): { id: string };
        listConversationTurns(input: { sessionId: string }): {
          turns: readonly { items: readonly { kind: string; payload: unknown }[] }[];
        };
      };
    };
    const session = internals.runtime.createAgentSession({
      workspaceId: workspace.id,
      runner: 'claude-code',
      cwd: workspace.path,
      nativeControl: 'MAR_MANAGED'
    });
    await operation(connector, 'session.command.execute', {
      sessionId: session.id,
      commandId: 'plan',
      input: '/plan'
    });
    await operation(connector, 'session.message', {
      sessionId: session.id,
      clientMessageId: 'msg-plan-1',
      content: 'Plan the home page refactor'
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(prompt).toContain('<plan_mode>');
    expect(prompt?.endsWith('Plan the home page refactor')).toBe(true);
    const turns = internals.runtime.listConversationTurns({ sessionId: session.id }).turns;
    const userItem = turns[0]?.items.find((item) => item.kind === 'user_message');
    expect(userItem?.payload).toMatchObject({ text: 'Plan the home page refactor' });
    connector.stop();
  });

  it('requires a normal first message before executing an external-session command', async () => {
    const database = new NodeDatabase(':memory:', 'node-command-resume');
    const workspace = database.saveWorkspace({
      path: '/workspace/command-resume',
      kind: 'DIRECTORY',
      gitSummary: null
    });
    const connector = new NodeConnector({
      reconnect: false,
      database,
      capabilities: {
        platform: 'linux',
        architecture: 'x64',
        nodeVersion: process.version,
        codex: { available: true, version: 'codex-cli 0.147.0' },
        claudeCode: { available: false }
      }
    });
    const internals = connector as unknown as {
      runtime: {
        createAgentSession(input: Record<string, unknown>): { id: string };
        listConversationTurns(input: { sessionId: string }): { turns: readonly unknown[] };
      };
    };
    const external = internals.runtime.createAgentSession({
      workspaceId: workspace.id,
      runner: 'codex',
      cwd: workspace.path,
      nativeControl: 'EXTERNAL',
      externalSessionId: 'thread-external'
    });
    await expect(
      operation(connector, 'session.command.execute', {
        sessionId: external.id,
        commandId: 'plan',
        input: '/plan'
      })
    ).rejects.toThrow('SESSION_ACTIVATION_REQUIRED');
    expect(internals.runtime.listConversationTurns({ sessionId: external.id }).turns).toEqual([]);
    database.close();
  });

  it('activates an existing MAR Agent session before running a runtime command', async () => {
    const database = new NodeDatabase(':memory:', 'node-mar-command-activation');
    const workspace = await saveTempWorkspace(database, 'mar-command-activation-');
    const connector = new NodeConnector({
      reconnect: false,
      database,
      capabilities: {
        platform: 'linux',
        architecture: 'x64',
        nodeVersion: process.version,
        codex: { available: false },
        claudeCode: { available: false },
        marAgent: { available: true, version: '0.9.63' }
      }
    });
    const internals = connector as unknown as {
      runtime: {
        createAgentSession(input: Record<string, unknown>): NodeAgentSession;
        getAgentSession(id: string): NodeAgentSession | undefined;
      };
      marAgentClient: {
        executeCommand: (...args: unknown[]) => Promise<unknown>;
      };
    };
    const external = internals.runtime.createAgentSession({
      workspaceId: workspace.id,
      runner: 'mar-agent',
      cwd: workspace.path,
      externalSessionId: crypto.randomUUID(),
      nativeControl: 'EXTERNAL'
    });
    const command = vi
      .spyOn(internals.marAgentClient, 'executeCommand')
      .mockResolvedValue({ command: 'compact' });
    const installations = [{ serverName: 'fixture', enabled: true }];
    const mcps = vi
      .spyOn(database, 'effectiveMcpInstallations')
      .mockReturnValue(installations as never);
    try {
      await expect(
        operation(connector, 'session.command.execute', {
          sessionId: external.id,
          commandId: 'compact',
          input: '/compact',
          mcpInstallations: [{ serverName: 'untrusted-client' }]
        })
      ).resolves.toMatchObject({
        command: 'compact',
        session: { id: external.id, nativeControl: 'MAR_MANAGED' }
      });
      expect(command).toHaveBeenCalledWith(
        expect.objectContaining({ id: external.id, nativeControl: 'MAR_MANAGED' }),
        expect.objectContaining({ id: 'compact' }),
        '/compact',
        expect.objectContaining({ mcpInstallations: installations })
      );
      expect(mcps).toHaveBeenCalledWith(workspace.id);
      mcps.mockReturnValue([]);
      await operation(connector, 'session.command.execute', {
        sessionId: external.id,
        commandId: 'compact',
        input: '/compact'
      });
      expect(command.mock.calls.at(-1)?.[3]).toMatchObject({ mcpInstallations: [] });
      expect(internals.runtime.getAgentSession(external.id)?.nativeControl).toBe('MAR_MANAGED');
    } finally {
      await connector.stop();
    }
  });

  it('clears an idle MAR Agent session through the destructive command and rejects active, queued, or racing history', async () => {
    const database = new NodeDatabase(':memory:', 'node-mar-agent-clear-command');
    const workspace = database.saveWorkspace({
      path: '/workspace/mar-agent-clear',
      kind: 'DIRECTORY',
      gitSummary: null
    });
    const connector = new NodeConnector({
      reconnect: false,
      database,
      capabilities: {
        platform: 'linux',
        architecture: 'x64',
        nodeVersion: process.version,
        codex: { available: false },
        claudeCode: { available: false },
        marAgent: { available: true, version: '0.9.63' }
      }
    });
    const internals = connector as unknown as {
      marAgentClient: { clearNative(session: NodeAgentSession): Promise<number> };
      nativeSessionWatchService: { invalidate(sessionId: string): void };
      workspaceSessionService: { invalidateCache(workspaceId: string): void };
      runtime: {
        createAgentSession(input: Record<string, unknown>): NodeAgentSession;
        createMessageRun(input: Record<string, unknown>): { readonly run: { readonly id: string } };
        createQueueItem(input: Record<string, unknown>): unknown;
        finishRun(runId: string, status: 'SUCCEEDED'): unknown;
        listConversationTurns(input: { sessionId: string }): { readonly turns: readonly unknown[] };
      };
    };
    const createSession = () =>
      internals.runtime.createAgentSession({
        workspaceId: workspace.id,
        runner: 'mar-agent',
        cwd: workspace.path,
        externalSessionId: crypto.randomUUID(),
        nativeControl: 'MAR_MANAGED'
      });
    const source = createSession();
    const active = createSession();
    const queued = createSession();
    const terminalRun = internals.runtime.createMessageRun({
      sessionId: source.id,
      clientMessageId: 'source-message',
      content: 'history to clear'
    }).run;
    internals.runtime.finishRun(terminalRun.id, 'SUCCEEDED');
    internals.runtime.createMessageRun({
      sessionId: active.id,
      clientMessageId: 'active-message',
      content: 'active'
    });
    internals.runtime.createQueueItem({
      sessionId: queued.id,
      clientMessageId: 'queued-message',
      content: 'queued'
    });
    let completeClear!: (lastActivityAt: number) => void;
    const clearNative = vi.spyOn(internals.marAgentClient, 'clearNative').mockImplementation(
      () =>
        new Promise<number>((resolve) => {
          completeClear = resolve;
        })
    );
    const invalidateHistory = vi.spyOn(internals.nativeSessionWatchService, 'invalidate');
    const invalidateWorkspace = vi.spyOn(internals.workspaceSessionService, 'invalidateCache');

    try {
      await expect(
        operation(connector, 'session.command.execute', {
          sessionId: source.id,
          commandId: 'clear',
          input: '/clear unexpected'
        })
      ).rejects.toThrow('RUNNER_COMMAND_ARGUMENT_INVALID');
      await expect(
        operation(connector, 'session.command.execute', {
          sessionId: active.id,
          commandId: 'clear',
          input: '/clear'
        })
      ).rejects.toThrow('RUNNER_COMMAND_UNAVAILABLE');
      await expect(
        operation(connector, 'session.command.execute', {
          sessionId: queued.id,
          commandId: 'clear',
          input: '/clear'
        })
      ).rejects.toThrow('SESSION_QUEUE_NOT_EMPTY');

      const pending = operation(connector, 'session.command.execute', {
        sessionId: source.id,
        commandId: 'clear',
        input: '/clear'
      });
      await vi.waitFor(() => expect(clearNative).toHaveBeenCalledOnce());
      expect(() =>
        internals.runtime.createMessageRun({
          sessionId: source.id,
          clientMessageId: 'racing-message',
          content: 'must be rejected'
        })
      ).toThrow('SESSION_ACTIVE');
      completeClear(1_789_000_000_000);

      await expect(pending).resolves.toMatchObject({
        command: 'clear',
        session: { id: source.id, lastActivityAt: 1_789_000_000_000 }
      });
      expect(internals.runtime.listConversationTurns({ sessionId: source.id }).turns).toEqual([]);
      expect(invalidateHistory).toHaveBeenCalledWith(source.id);
      expect(invalidateWorkspace).toHaveBeenCalledWith(workspace.id);
      expect(() =>
        internals.runtime.createMessageRun({
          sessionId: source.id,
          clientMessageId: 'after-clear',
          content: 'allowed'
        })
      ).not.toThrow();
    } finally {
      await connector.stop();
    }
  });
});

function operation(connector: NodeConnector, operation: string, data: unknown): Promise<unknown> {
  return (
    connector as unknown as {
      executeNodeOperation(operation: string, data: unknown): Promise<unknown>;
    }
  ).executeNodeOperation(operation, data);
}

async function saveTempWorkspace(database: NodeDatabase, prefix: string) {
  const path = await mkdtemp(join(tmpdir(), prefix));
  onTestFinished(() => rm(path, { recursive: true, force: true }));
  return database.saveWorkspace({ path, kind: 'DIRECTORY', gitSummary: null });
}
