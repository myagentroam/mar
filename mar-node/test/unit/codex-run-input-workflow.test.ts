import type { GoalContinuationCoordinator } from '../../src/service/goal-continuation-coordinator.js';
import { withNonImageAttachmentPrompt } from '../../src/util/node-operation-parsers.js';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { createEnvelope, steerComposerMessage } from '../../../packages/protocol/src/index.js';
import { CodexAppServerClient } from '../../src/codex-app-server.js';
import { NodeConnector } from '../../src/connector.js';
import { NodeDatabase } from '../../src/database.js';
import { capabilities, codexProfileClientFactory, eventually } from './support/codex-connector.js';
async function primeCodexProfile(connector: NodeConnector): Promise<void> {
  await (
    connector as unknown as {
      executeNodeOperation(operation: string, input: unknown): Promise<unknown>;
    }
  ).executeNodeOperation('runner.profiles.list', {});
}

async function createTestWorkspacePath(): Promise<string> {
  const workspacePath = await mkdtemp(join(tmpdir(), 'mar-codex-run-input-workflow-'));
  onTestFinished(() => rm(workspacePath, { recursive: true, force: true }));
  return workspacePath;
}

describe('Codex input, commands, and event projection', () => {
  it('completes only a current MAR Goal when the bound native Codex Goal completes in its managed Turn', async () => {
    const database = new NodeDatabase(':memory:', 'node-codex-native-goal');
    const workspacePath = await createTestWorkspacePath();
    const workspace = database.saveWorkspace({
      path: workspacePath,
      kind: 'DIRECTORY',
      gitSummary: null
    });
    const startTurn = vi.fn(async () => ({ turn: { id: 'turn-native-goal' } }));
    const connector = new NodeConnector({
      reconnect: false,
      capabilities: capabilities(),
      codexProfileClientFactory,
      database,
      codexClient: {
        onNotification: () => () => undefined,
        start: async () => undefined,
        configureEnvironment: () => undefined,
        resumeThread: async () => ({ thread: { id: 'thread-native-goal' } }),
        startTurn,
        stop: () => undefined
      } as unknown as CodexAppServerClient
    });
    await primeCodexProfile(connector);
    const internals = connector as unknown as {
      runtime: {
        createAgentSession(input: Record<string, unknown>): { id: string };
        activeSessionRun(sessionId: string): { id: string } | undefined;
        currentExecutionId(runId: string): string | undefined;
        sessionQueue(sessionId: string): { itemIds: readonly string[] };
      };
      goalRuntime: {
        get(
          sessionId: string
        ): { id: string; revision: number; revisionStartedAt: number; status: string } | undefined;
      };
      commandStates: { get(sessionId: string, commandId: string): unknown };
      codexRunController: {
        handleNotification(notification: { method: string; params: unknown }): void;
      };
      executeNodeOperation(operation: string, input: unknown): Promise<unknown>;
    };
    const session = internals.runtime.createAgentSession({
      workspaceId: workspace.id,
      runner: 'codex',
      cwd: workspace.path,
      externalSessionId: 'thread-native-goal',
      nativeControl: 'MAR_MANAGED'
    });

    try {
      await internals.executeNodeOperation('session.command.execute', {
        sessionId: session.id,
        commandId: 'goal',
        input: '/goal Implement and verify the feature'
      });
      await vi.waitFor(() => expect(startTurn).toHaveBeenCalledTimes(1));
      const marGoal = internals.goalRuntime.get(session.id)!;
      const run = internals.runtime.activeSessionRun(session.id)!;
      expect(internals.runtime.currentExecutionId(run.id)).toBeDefined();
      const nativeGoal = {
        threadId: 'thread-native-goal',
        objective: 'Implement and verify the feature',
        createdAt: Math.ceil(marGoal.revisionStartedAt / 1_000),
        tokensUsed: 0,
        timeUsedSeconds: 0
      };
      const notify = (turnId: string | null, goal: Record<string, unknown>) =>
        internals.codexRunController.handleNotification({
          method: 'thread/goal/updated',
          params: { threadId: nativeGoal.threadId, turnId, goal }
        });

      notify('turn-native-goal', { ...nativeGoal, status: 'complete' });
      notify('turn-native-goal', { ...nativeGoal, status: 'blocked' });
      notify('turn-native-goal', {
        ...nativeGoal,
        threadId: 'different-thread',
        status: 'active'
      });
      notify('another-turn', { ...nativeGoal, status: 'active' });
      notify('turn-native-goal', {
        ...nativeGoal,
        createdAt: nativeGoal.createdAt - 3_600,
        status: 'active'
      });
      notify(null, { ...nativeGoal, status: 'active' });
      notify('turn-native-goal', { ...nativeGoal, tokensUsed: 5, status: 'active' });
      expect(internals.goalRuntime.get(session.id)?.status).toBe('active');

      notify('turn-native-goal', { ...nativeGoal, status: 'active' });
      notify('turn-native-goal', {
        ...nativeGoal,
        createdAt: nativeGoal.createdAt + 1,
        status: 'complete'
      });
      expect(internals.goalRuntime.get(session.id)?.status).toBe('active');
      notify('turn-native-goal', { ...nativeGoal, tokensUsed: 500, status: 'complete' });

      expect(internals.goalRuntime.get(session.id)?.status).toBe('completed');
      expect(internals.commandStates.get(session.id, 'goal')).toBeUndefined();
      expect(internals.runtime.sessionQueue(session.id).itemIds).toEqual([]);
      internals.codexRunController.handleNotification({
        method: 'turn/completed',
        params: {
          threadId: nativeGoal.threadId,
          turn: { id: 'turn-native-goal', status: 'completed' }
        }
      });
      expect(internals.runtime.activeSessionRun(session.id)).toBeUndefined();
    } finally {
      await connector.stop();
    }
  });

  it('does not bind a previous revision native Goal to an edited MAR Goal', async () => {
    const database = new NodeDatabase(':memory:', 'node-codex-revised-native-goal');
    const workspace = database.saveWorkspace({
      path: '/workspace/revised-native-goal',
      kind: 'DIRECTORY',
      gitSummary: null
    });
    const connector = new NodeConnector({ reconnect: false, database });
    const internals = connector as unknown as {
      runtime: { createAgentSession(input: Record<string, unknown>): { id: string } };
      goalRuntime: {
        start(
          sessionId: string,
          objective: string
        ): {
          id: string;
          revision: number;
          revisionStartedAt: number;
          status: string;
        };
        get(sessionId: string): { status: string } | undefined;
      };
      goalCoordinator: GoalContinuationCoordinator;
      continuousRunCoordinator: {
        pending(runId: string): unknown;
      };
    };
    const session = internals.runtime.createAgentSession({
      workspaceId: workspace.id,
      runner: 'codex',
      cwd: workspace.path
    });
    const original = internals.goalRuntime.start(session.id, 'Original objective');
    const oldNative = {
      threadId: 'thread-revised-goal',
      createdAt: Math.ceil(original.revisionStartedAt / 1_000),
      objective: 'Original objective'
    };
    (
      internals.goalCoordinator as unknown as { nativeGoalBindings: Map<string, unknown> }
    ).nativeGoalBindings.set(original.id, { revision: original.revision, ...oldNative });
    const revised = internals.goalRuntime.start(session.id, 'Revised objective');
    vi.spyOn(internals.continuousRunCoordinator, 'pending').mockReturnValue({
      sessionId: session.id,
      goal: internals.goalCoordinator.reference(session.id)
    });

    try {
      internals.goalCoordinator.handleNativeGoalUpdate('execution', {
        ...oldNative,
        status: 'active'
      });
      internals.goalCoordinator.handleNativeGoalUpdate('execution', {
        ...oldNative,
        status: 'completed'
      });
      expect(internals.goalRuntime.get(session.id)?.status).toBe('active');
      const newNative = { ...oldNative, objective: 'Revised objective' };
      internals.goalCoordinator.handleNativeGoalUpdate('execution', {
        ...newNative,
        status: 'active'
      });
      internals.goalCoordinator.handleNativeGoalUpdate('execution', {
        ...newNative,
        status: 'completed'
      });
      expect(internals.goalRuntime.get(session.id)?.status).toBe('completed');
    } finally {
      await connector.stop();
    }
  });

  it('Plan mode changes only the collaboration mode, preserves Full access, and keeps Fast in the Node-wide service layer', async () => {
    const startThread = vi.fn(async () => ({ thread: { id: 'thread-plan-access' } }));
    const startTurn = vi.fn(async () => ({ turn: { id: 'turn-plan-access' } }));
    const steerTurn = vi.fn(async () => undefined);
    const interruptTurn = vi.fn(async () => undefined);
    const database = new NodeDatabase(':memory:', 'node-plan-access');
    const workspacePath = await createTestWorkspacePath();
    const workspace = database.saveWorkspace({
      id: 'workspace-plan-access',
      path: workspacePath,
      kind: 'DIRECTORY',
      gitSummary: null
    });
    const connector = new NodeConnector({
      reconnect: false,
      capabilities: capabilities(),
      codexProfileClientFactory,
      database,
      codexClient: {
        onNotification: () => () => undefined,
        start: async () => undefined,
        configureEnvironment: () => undefined,
        startThread,
        startTurn,
        steerTurn,
        interruptTurn,
        stop: () => undefined
      } as unknown as CodexAppServerClient
    });
    await primeCodexProfile(connector);
    const internals = connector as unknown as {
      runtime: {
        createAgentSession(input: Record<string, unknown>): { readonly id: string };
      };
      commandStates: {
        set(sessionId: string, state: Record<string, unknown>): unknown;
      };
      executeNodeOperation(operation: string, data: unknown): Promise<unknown>;
    };
    const session = internals.runtime.createAgentSession({
      workspaceId: workspace.id,
      runner: 'codex',
      cwd: workspace.path,
      access: 'full-access'
    });
    internals.commandStates.set(session.id, {
      commandId: 'plan',
      active: true,
      label: 'Plan Mode',
      detail: '',
      closable: true,
      closeInput: '/plan'
    });

    await expect(
      internals.executeNodeOperation('runner.command.execute', {
        runner: 'codex',
        commandId: 'fast',
        input: '/fast on'
      })
    ).resolves.toEqual({ command: 'fast', enabled: true });
    await expect(
      internals.executeNodeOperation('runner.command.execute', {
        runner: 'codex',
        commandId: 'fast',
        input: '/fast status'
      })
    ).resolves.toEqual({ command: 'fast', enabled: true });

    await internals.executeNodeOperation('session.message', {
      sessionId: session.id,
      clientMessageId: 'plan-access-message',
      content: 'Provide a plan first'
    });
    await eventually(() => startTurn.mock.calls.length === 1);

    expect(startThread).toHaveBeenCalledWith(
      workspace.path,
      expect.objectContaining({ access: 'full-access' })
    );
    expect(startTurn).toHaveBeenCalledWith(
      'thread-plan-access',
      'Provide a plan first',
      workspace.path,
      expect.objectContaining({
        access: 'full-access',
        collaborationMode: 'plan',
        serviceTier: 'fast'
      }),
      []
    );
    const replacement = await internals.executeNodeOperation('session.message', {
      sessionId: 'thread-plan-access',
      clientMessageId: 'plan-access-replacement',
      content: 'Expand this plan',
      deliveryIntent: 'REPLACE_CURRENT'
    });
    expect(replacement).toMatchObject({ delivery: 'ACCEPTED', idempotent: false });
    expect(steerTurn).not.toHaveBeenCalled();
    expect(interruptTurn).toHaveBeenCalledTimes(1);
    const queued = await internals.executeNodeOperation('session.message', {
      sessionId: 'thread-plan-access',
      clientMessageId: 'plan-access-queued',
      content: 'Execute the queued message now',
      deliveryIntent: 'QUEUE'
    });
    expect(queued).toMatchObject({ delivery: expect.stringMatching(/^(?:QUEUED|STARTED)$/) });
    if ((queued as { delivery: string }).delivery === 'QUEUED')
      await expect(
        internals.executeNodeOperation('workspace.queue.message.execute', {
          workspaceId: workspace.id,
          queueItemId: (queued as { queueItemId: string }).queueItemId
        })
      ).resolves.toMatchObject({ delivery: 'ACCEPTED', run: { id: expect.any(String) } });
    expect(steerTurn).not.toHaveBeenCalled();
    await expect(
      internals.executeNodeOperation('runner.command.execute', {
        runner: 'codex',
        commandId: 'fast',
        input: '/fast off'
      })
    ).resolves.toEqual({ command: 'fast', enabled: false });
    await expect(
      internals.executeNodeOperation('runner.command.execute', {
        runner: 'codex',
        commandId: 'fast',
        input: '/fast invalid'
      })
    ).rejects.toThrow('RUNNER_COMMAND_INVALID');
    connector.stop();
  });

  it('passes a Composer image as App Server localImage input to a managed Codex Turn', async () => {
    const startTurn = vi.fn<CodexAppServerClient['startTurn']>(async () => ({
      turn: { id: 'turn-image' }
    }));
    const database = new NodeDatabase(':memory:', 'node-image-forwarding');
    const workspace = database.saveWorkspace({
      id: 'workspace-image',
      path: '/workspace',
      kind: 'DIRECTORY',
      gitSummary: null
    });
    const connector = new NodeConnector({
      reconnect: false,
      capabilities: capabilities(),
      codexProfileClientFactory,
      database,
      codexClient: {
        onNotification: () => () => undefined,
        start: async () => undefined,
        configureEnvironment: () => undefined,
        startThread: async () => ({ thread: { id: 'thread-image' } }),
        startTurn,
        stop: () => undefined
      } as unknown as CodexAppServerClient
    });
    await primeCodexProfile(connector);
    const internals = connector as unknown as {
      runtime: {
        createAgentSession(input: { workspaceId: string; runner: 'codex'; cwd: string }): {
          readonly id: string;
        };
        createMessageRun(input: { sessionId: string; clientMessageId: string; content: string }): {
          readonly run: { readonly id: string };
        };
      };
      handleMessage(raw: string): void;
    };
    const session = internals.runtime.createAgentSession({
      workspaceId: workspace.id,
      runner: 'codex',
      cwd: '/workspace'
    });
    const run = internals.runtime.createMessageRun({
      sessionId: session.id,
      clientMessageId: 'image-message',
      content: 'Analyze this image'
    }).run;

    internals.handleMessage(
      JSON.stringify(
        createEnvelope('run.start', {
          runId: run.id,
          sessionId: session.id,
          runner: 'codex',
          input: 'Analyze this image',
          cwd: '/workspace',
          attachments: [{ name: 'diagram.png', mime: 'image/png', dataBase64: 'cG5n' }]
        })
      )
    );

    await eventually(() => startTurn.mock.calls.length === 1);
    expect(startTurn.mock.calls[0]?.[4]).toEqual([
      expect.objectContaining({ type: 'localImage', path: expect.stringMatching(/\.png$/) })
    ]);
    connector.stop();
  });

  it.each([
    { label: 'a document', name: 'notes.pdf', mime: 'application/pdf', contents: ['pdf'] },
    {
      label: 'same-name images',
      name: 'image.png',
      mime: 'image/png',
      contents: ['first', 'second']
    }
  ])(
    'retains $label at original upload paths for 30 Session idle minutes',
    async ({ name, mime, contents }) => {
      const root = await mkdtemp(join(tmpdir(), 'mar-composer-file-'));
      let notify: ((notification: { method: string; params: unknown }) => void) | undefined;
      let submittedInput = '';
      const startTurn = vi.fn<CodexAppServerClient['startTurn']>(async (_threadId, input) => {
        submittedInput = input;
        return { turn: { id: 'turn-file' } };
      });
      const database = new NodeDatabase(':memory:', 'node-file-forwarding');
      const workspace = database.saveWorkspace({
        id: 'workspace-file',
        path: root,
        kind: 'DIRECTORY',
        gitSummary: null
      });
      const connector = new NodeConnector({
        config: {
          serverUrl: 'http://localhost',
          allowedRoots: [root],
          dataDirectory: join(root, 'node-data')
        },
        reconnect: false,
        capabilities: capabilities(),
        codexProfileClientFactory,
        database,
        codexClient: {
          onNotification: (
            listener: (notification: { method: string; params: unknown }) => void
          ) => {
            notify = listener;
            return () => undefined;
          },
          start: async () => undefined,
          configureEnvironment: () => undefined,
          startThread: async () => ({ thread: { id: 'thread-file' } }),
          startTurn,
          readThread: async () => ({
            thread: {
              id: 'thread-file',
              turns: [
                {
                  id: 'turn-file',
                  items: [
                    {
                      id: 'native-user-file',
                      type: 'userMessage',
                      content: [
                        {
                          type: 'input_text',
                          text: submittedInput
                        }
                      ]
                    }
                  ]
                }
              ]
            }
          }),
          stop: () => undefined
        } as unknown as CodexAppServerClient
      });
      await primeCodexProfile(connector);
      const execute = connector as unknown as {
        executeNodeOperation(operation: string, input: unknown): Promise<unknown>;
      };
      try {
        const created = (await execute.executeNodeOperation('session.create', {
          workspaceId: workspace.id,
          runner: 'codex',
          cwd: root
        })) as { readonly session: { readonly id: string } };
        const attachmentId = '9e93ee84-61a1-413b-a8c3-df4cd70320b9';
        const uploaded = (await execute.executeNodeOperation('workspace.files.upload.create', {
          workspaceId: workspace.id,
          name,
          mime,
          size: Buffer.byteLength(contents[0]!),
          overwrite: false,
          composerAttachmentId: attachmentId
        })) as { readonly upload: { readonly uploadId: string } };
        await expect(
          execute.executeNodeOperation('session.message', {
            sessionId: created.session.id,
            clientMessageId: 'uploading-file',
            content: 'Must not send while upload is in progress',
            attachmentIds: [attachmentId]
          })
        ).rejects.toThrow('COMPOSER_ATTACHMENT_UNAVAILABLE');
        await execute.executeNodeOperation('workspace.files.upload.chunk', {
          workspaceId: workspace.id,
          uploadId: uploaded.upload.uploadId,
          offset: 0,
          dataBase64: Buffer.from(contents[0]!).toString('base64')
        });
        await execute.executeNodeOperation('workspace.files.upload.complete', {
          workspaceId: workspace.id,
          uploadId: uploaded.upload.uploadId
        });
        const attachmentIds = [attachmentId];
        for (const [index, content] of contents.entries()) {
          if (index === 0) continue;
          const id = '9e93ee84-61a1-413b-a8c3-df4cd70320ba';
          const next = (await execute.executeNodeOperation('workspace.files.upload.create', {
            workspaceId: workspace.id,
            name,
            mime,
            size: Buffer.byteLength(content),
            overwrite: false,
            composerAttachmentId: id
          })) as { readonly upload: { readonly uploadId: string } };
          await execute.executeNodeOperation('workspace.files.upload.chunk', {
            workspaceId: workspace.id,
            uploadId: next.upload.uploadId,
            offset: 0,
            dataBase64: Buffer.from(content).toString('base64')
          });
          await execute.executeNodeOperation('workspace.files.upload.complete', {
            workspaceId: workspace.id,
            uploadId: next.upload.uploadId
          });
          attachmentIds.push(id);
        }
        const message = (await execute.executeNodeOperation('session.message', {
          sessionId: created.session.id,
          clientMessageId: 'non-image-file',
          content: 'Read the attachment content',
          attachmentIds
        })) as { readonly run: { readonly id: string } };

        const paths = attachmentIds.map((id) => join(root, 'node-data', 'temp-files', id, name));
        const relativePath = paths[0]!;
        const runnerInput = withNonImageAttachmentPrompt(
          'Read the attachment content',
          paths,
          paths.map((path, index) => ({
            name,
            mime,
            path: relative(root, path),
            workspacePath: `mar-attachment://${attachmentIds[index]}/${name}`
          }))
        );
        await eventually(() => startTurn.mock.calls.length === 1);
        expect(startTurn.mock.calls[0]?.[1]).toBe(runnerInput);
        if (mime === 'image/png') {
          const images = startTurn.mock.calls[0]?.[4] ?? [];
          expect(images).toHaveLength(contents.length);
          for (const [index, image] of images.entries()) {
            expect(image.type).toBe('localImage');
            if (image.type === 'localImage')
              await expect(readFile(image.path, 'utf8')).resolves.toBe(contents[index]);
          }
        }
        for (const [index, path] of paths.entries()) {
          await expect(readFile(path)).resolves.toEqual(Buffer.from(contents[index]!));
        }
        await expect(readFile(join(root, '.mar', 'temp-files', name))).rejects.toMatchObject({
          code: 'ENOENT'
        });
        const turns = (await execute.executeNodeOperation('session.turns.list', {
          sessionId: 'thread-file',
          limit: 10
        })) as {
          readonly turns: readonly {
            readonly runId: string | null;
            readonly items: readonly unknown[];
          }[];
        };
        expect(turns.turns).toHaveLength(1);
        expect(turns.turns[0]?.runId).toBe(message.run.id);
        expect(turns.turns[0]?.items).toEqual([
          expect.objectContaining({
            kind: 'user_message',
            payload: expect.objectContaining({
              text: withNonImageAttachmentPrompt(
                'Read the attachment content',
                paths,
                paths.map((path, index) => ({
                  name,
                  mime,
                  path: `mar-attachment://${attachmentIds[index]}/${name}`
                }))
              ),
              attachments:
                mime === 'application/pdf'
                  ? []
                  : contents.map((content, imageIndex) =>
                      expect.objectContaining({
                        name,
                        mime,
                        byteSize: Buffer.byteLength(content),
                        imageIndex,
                        runId: expect.any(String)
                      })
                    )
            })
          })
        ]);
        await expect(
          execute.executeNodeOperation('session.message', {
            sessionId: created.session.id,
            clientMessageId: 'unsafe-file-name',
            content: 'Must not be written',
            attachments: [{ name: 'bad\nname.pdf', mime: 'application/pdf', dataBase64: 'cGRm' }]
          })
        ).rejects.toThrow('MESSAGE_ATTACHMENTS_INVALID');
        vi.useFakeTimers();
        notify?.({
          method: 'turn/completed',
          params: { threadId: 'thread-file', turn: { id: 'turn-file', status: 'completed' } }
        });
        await expect(readFile(relativePath)).resolves.toEqual(Buffer.from(contents[0]!));
        await vi.advanceTimersByTimeAsync(29 * 60_000);
        await expect(readFile(relativePath)).resolves.toEqual(Buffer.from(contents[0]!));
        await vi.advanceTimersByTimeAsync(60_000);
        await vi.waitFor(async () => {
          for (const path of paths)
            await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' });
        });
      } finally {
        vi.useRealTimers();
        connector.stop();
        await rm(root, { recursive: true, force: true });
      }
    }
  );

  it('sends a stopped attachment input to the front of the queue during Compact and starts it after the command completes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mar-compact-insert-'));
    let notify: ((notification: { method: string; params: unknown }) => void) | undefined;
    const startTurn = vi.fn<CodexAppServerClient['startTurn']>(async () => ({
      turn: { id: 'turn-after-compact' }
    }));
    const interruptTurn = vi.fn(async () => undefined);
    const database = new NodeDatabase(':memory:', 'node-compact-insert');
    const workspace = database.saveWorkspace({
      id: 'workspace-compact-insert',
      path: root,
      kind: 'DIRECTORY',
      gitSummary: null
    });
    const connector = new NodeConnector({
      config: {
        serverUrl: 'http://localhost',
        allowedRoots: [root],
        dataDirectory: join(root, 'node-data')
      },
      reconnect: false,
      capabilities: capabilities(),
      codexProfileClientFactory,
      database,
      codexClient: {
        onNotification(listener: (notification: { method: string; params: unknown }) => void) {
          notify = listener;
          return () => undefined;
        },
        start: async () => undefined,
        configureEnvironment: () => undefined,
        resumeThread: async () => ({ thread: { id: 'thread-compact-insert' } }),
        request: async () => ({}),
        startTurn,
        interruptTurn,
        stop: () => undefined
      } as unknown as CodexAppServerClient
    });
    await primeCodexProfile(connector);
    const internals = connector as unknown as {
      runtime: {
        createAgentSession(input: Record<string, unknown>): { readonly id: string };
        getRun(runId: string): { readonly status: string } | undefined;
        sessionQueue(sessionId: string): { readonly itemIds: readonly string[] };
      };
      executeNodeOperation(operation: string, input: unknown): Promise<unknown>;
    };
    const session = internals.runtime.createAgentSession({
      workspaceId: workspace.id,
      runner: 'codex',
      cwd: root,
      externalSessionId: 'thread-compact-insert',
      nativeControl: 'MAR_MANAGED'
    });
    try {
      const compact = (await internals.executeNodeOperation('session.command.execute', {
        sessionId: session.id,
        commandId: 'compact',
        input: '/compact'
      })) as { readonly run: { readonly id: string } };
      notify?.({
        method: 'turn/started',
        params: {
          threadId: 'thread-compact-insert',
          turn: { id: 'turn-compact-insert' }
        }
      });
      expect(internals.runtime.getRun(compact.run.id)?.status).toBe('RUNNING');

      const attachmentId = '00000000-0000-4000-8000-000000000002';
      const uploaded = (await internals.executeNodeOperation('workspace.files.upload.create', {
        workspaceId: workspace.id,
        name: 'notes.pdf',
        mime: 'application/pdf',
        size: 3,
        overwrite: false,
        composerAttachmentId: attachmentId
      })) as { readonly upload: { readonly uploadId: string } };
      await internals.executeNodeOperation('workspace.files.upload.chunk', {
        workspaceId: workspace.id,
        uploadId: uploaded.upload.uploadId,
        offset: 0,
        dataBase64: 'cGRm'
      });
      await internals.executeNodeOperation('workspace.files.upload.complete', {
        workspaceId: workspace.id,
        uploadId: uploaded.upload.uploadId
      });

      const queued = (await internals.executeNodeOperation('session.message', {
        sessionId: session.id,
        clientMessageId: 'message-after-compact',
        content: 'Read the attachment after compaction',
        deliveryIntent: 'REPLACE_CURRENT',
        attachmentIds: [attachmentId]
      })) as {
        readonly delivery: string;
        readonly queueItemId: string;
        readonly run: { readonly id: string };
      };

      expect(queued).toMatchObject({
        delivery: 'QUEUED',
        run: { id: compact.run.id },
        queueItemId: expect.any(String)
      });
      expect(internals.runtime.sessionQueue(session.id).itemIds).toEqual([queued.queueItemId]);
      expect(internals.runtime.getRun(compact.run.id)?.status).toBe('RUNNING');
      expect(interruptTurn).not.toHaveBeenCalled();
      expect(startTurn).not.toHaveBeenCalled();

      notify?.({
        method: 'turn/completed',
        params: {
          threadId: 'thread-compact-insert',
          turn: { id: 'turn-compact-insert', status: 'completed' }
        }
      });

      const attachmentPath = join(root, 'node-data', 'temp-files', attachmentId, 'notes.pdf');
      await eventually(() => startTurn.mock.calls.length === 1);
      expect(startTurn.mock.calls[0]?.[1]).toBe(
        withNonImageAttachmentPrompt(
          steerComposerMessage('Read the attachment after compaction'),
          [attachmentPath],
          [
            {
              name: 'notes.pdf',
              mime: 'application/pdf',
              path: relative(root, attachmentPath),
              workspacePath: `mar-attachment://${attachmentId}/notes.pdf`
            }
          ]
        )
      );
      expect(internals.runtime.sessionQueue(session.id).itemIds).toEqual([]);
      await expect(readFile(attachmentPath)).resolves.toEqual(Buffer.from('pdf'));
    } finally {
      connector.stop();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('projects Codex reasoning, tool output, and user-input requests into conversation items while limiting answer delivery', async () => {
    const database = new NodeDatabase(':memory:', 'node-codex-live-items');
    const workspace = database.saveWorkspace({
      id: 'workspace-live-items',
      path: '/workspace',
      kind: 'DIRECTORY',
      gitSummary: null
    });
    const connector = new NodeConnector({
      reconnect: false,
      capabilities: capabilities(),
      codexProfileClientFactory,
      database
    });
    await primeCodexProfile(connector);
    const internals = connector as unknown as {
      runtime: {
        createAgentSession(input: { workspaceId: string; runner: 'codex'; cwd: string }): {
          readonly id: string;
        };
        createMessageRun(input: { sessionId: string; clientMessageId: string; content: string }): {
          readonly run: { readonly id: string };
        };
        listConversationTurns(input: { sessionId: string }): {
          readonly turns: readonly {
            readonly items: readonly { kind: string; payload: unknown }[];
          }[];
        };
      };
      codexClient: { execution: { runs: Map<string, unknown> } };
      codexRunController: {
        handleNotification(input: {
          readonly method: string;
          readonly params: unknown;
          readonly requestId?: string | number;
        }): void;
      };
    };
    const session = internals.runtime.createAgentSession({
      workspaceId: workspace.id,
      runner: 'codex',
      cwd: workspace.path
    });
    const run = internals.runtime.createMessageRun({
      sessionId: session.id,
      clientMessageId: 'live-items',
      content: 'Run pwd'
    }).run;
    internals.codexClient.execution.runs.set(run.id, {
      sessionId: session.id,
      threadId: 'thread-live',
      turnId: 'turn-live',
      cwd: workspace.path,
      goalMcp: true
    });
    const notify = (method: string, params: unknown) =>
      internals.codexRunController.handleNotification({ method, params });
    notify('item/agentMessage/delta', {
      threadId: 'thread-live',
      turnId: 'turn-live',
      delta: 'Complete message without an itemId'
    });
    notify('item/completed', {
      threadId: 'thread-live',
      turnId: 'turn-live',
      item: {
        id: 'agent-message-4',
        type: 'agentMessage',
        text: 'Complete message without an itemId'
      }
    });
    notify('item/started', {
      threadId: 'thread-live',
      turnId: 'turn-live',
      item: { id: 'agent-message-1', type: 'agentMessage' }
    });
    notify('item/agentMessage/delta', {
      threadId: 'thread-live',
      turnId: 'turn-live',
      itemId: 'agent-message-1',
      delta: 'First'
    });
    notify('item/agentMessage/delta', {
      threadId: 'thread-live',
      turnId: 'turn-live',
      itemId: 'agent-message-1',
      delta: 'message'
    });
    notify('item/completed', {
      threadId: 'thread-live',
      turnId: 'turn-live',
      item: { id: 'agent-message-1', type: 'agentMessage', text: 'First message' }
    });
    notify('item/agentMessage/delta', {
      threadId: 'thread-live',
      turnId: 'turn-live',
      itemId: 'agent-message-2',
      delta: 'Second message'
    });
    notify('item/completed', {
      threadId: 'thread-live',
      turnId: 'turn-live',
      item: { id: 'agent-message-2', type: 'agentMessage', text: 'Second message' }
    });
    notify('item/agentMessage/delta', {
      threadId: 'thread-live',
      turnId: 'turn-live',
      itemId: 'agent-message-3',
      delta: 'Preserve the delta when the completion notice lacks a body'
    });
    notify('item/completed', {
      threadId: 'thread-live',
      turnId: 'turn-live',
      item: { id: 'agent-message-3', type: 'agentMessage' }
    });
    notify('item/started', {
      threadId: 'thread-live',
      turnId: 'turn-live',
      item: {
        id: 'command-live',
        type: 'commandExecution',
        command: 'pwd',
        cwd: '/workspace',
        status: 'inProgress',
        aggregatedOutput: null,
        exitCode: null,
        durationMs: null
      }
    });
    notify('item/commandExecution/outputDelta', {
      threadId: 'thread-live',
      turnId: 'turn-live',
      itemId: 'command-live',
      delta: '/workspace\\n'
    });
    notify('item/completed', {
      threadId: 'thread-live',
      turnId: 'turn-live',
      item: {
        id: 'command-live',
        type: 'commandExecution',
        command: 'pwd',
        cwd: '/workspace',
        status: 'completed',
        aggregatedOutput: '/workspace\\n',
        exitCode: 0,
        durationMs: 8
      }
    });
    notify('item/reasoning/summaryTextDelta', {
      threadId: 'thread-live',
      turnId: 'turn-live',
      itemId: 'reasoning-live',
      summaryIndex: 0,
      delta: 'Check the current directory first.'
    });
    notify('item/reasoning/textDelta', {
      threadId: 'thread-live',
      turnId: 'turn-live',
      itemId: 'reasoning-live',
      contentIndex: 0,
      delta: 'Hidden raw reasoning'
    });
    internals.codexRunController.handleNotification({
      method: 'item/started',
      params: {
        threadId: 'thread-live',
        turnId: 'turn-live',
        item: { id: 'web-search-live', type: 'webSearch', query: 'Codex App Server' }
      }
    });
    internals.codexRunController.handleNotification({
      method: 'item/completed',
      params: {
        threadId: 'thread-live',
        turnId: 'turn-live',
        item: { id: 'future-live', type: 'futureCodexAction' }
      }
    });
    internals.codexRunController.handleNotification({
      method: 'item/completed',
      params: {
        threadId: 'thread-live',
        turnId: 'turn-live',
        item: {
          id: 'file-change-live',
          type: 'fileChange',
          changes: [
            { path: 'src/new.ts', kind: 'add' },
            { path: 'src/live.ts', kind: 'update', additions: 2, deletions: 1 },
            { path: 'src/old.ts', kind: 'delete' }
          ]
        }
      }
    });
    internals.codexRunController.handleNotification({
      method: 'item/started',
      params: {
        threadId: 'thread-live',
        turnId: 'turn-live',
        item: {
          id: 'image-live',
          type: 'imageGeneration',
          revisedPrompt: 'Generate a diagram',
          status: 'inProgress'
        }
      }
    });
    internals.codexRunController.handleNotification({
      method: 'item/completed',
      params: {
        threadId: 'thread-live',
        turnId: 'turn-live',
        item: {
          id: 'plan-live',
          type: 'Plan',
          text: 'Confirm the current directory, then apply the changes.',
          status: 'completed'
        }
      }
    });
    internals.codexRunController.handleNotification({
      method: 'item/completed',
      params: {
        threadId: 'thread-live',
        turnId: 'turn-live',
        item: {
          id: 'agent-plan-live',
          type: 'agentMessage',
          text: '<proposed_plan>Read the configuration first, then generate a plan.</proposed_plan>',
          status: 'completed'
        }
      }
    });
    internals.codexRunController.handleNotification({
      method: 'item/started',
      params: {
        threadId: 'thread-live',
        turnId: 'turn-live',
        item: {
          id: 'ctc-tool-live',
          call_id: 'tool-live',
          type: 'custom_tool_call',
          name: 'exec_command',
          input: { cmd: 'pwd' },
          status: 'inProgress'
        }
      }
    });
    internals.codexRunController.handleNotification({
      method: 'item/completed',
      params: {
        threadId: 'thread-live',
        turnId: 'turn-live',
        item: {
          id: 'ctco-tool-live',
          call_id: 'tool-live',
          type: 'function_call_output',
          name: 'exec_command',
          output: [
            { type: 'input_text', text: '"/workspace\\n"' },
            { type: 'input_text', text: '{"image_url":"data:image/png;base64,aGVsbG8="}' }
          ],
          status: 'completed'
        }
      }
    });
    internals.codexRunController.handleNotification({
      method: 'item/tool/requestUserInput',
      requestId: 'input-live',
      params: {
        threadId: 'thread-live',
        turnId: 'turn-live',
        itemId: 'input-item',
        isBlocking: true,
        questions: [
          {
            id: 'direction',
            header: 'Direction',
            question: 'Choose a direction',
            options: [{ label: 'Upgrade everything', description: 'Refresh the visuals' }]
          }
        ]
      }
    });
    const responses: { requestId: string | number; result: unknown }[] = [];
    (
      connector as unknown as {
        codexClient: { respond(requestId: string | number, result: unknown): void };
      }
    ).codexClient.respond = (requestId, result) => responses.push({ requestId, result });
    internals.codexRunController.handleNotification({
      method: 'mcpServer/elicitation/request',
      requestId: 'goal-approval-live',
      params: {
        threadId: 'thread-live',
        turnId: 'turn-live',
        serverName: 'mar_goal',
        mode: 'form',
        _meta: { codex_approval_kind: 'mcp_tool_call' },
        message: 'Allow the Goal MCP tool?',
        requestedSchema: { type: 'object', properties: {} }
      }
    });
    internals.codexRunController.handleNotification({
      method: 'mcpServer/elicitation/request',
      requestId: 'external-mcp-approval-live',
      params: {
        threadId: 'thread-live',
        turnId: 'turn-live',
        serverName: 'external_mcp',
        mode: 'form',
        _meta: { codex_approval_kind: 'mcp_tool_call' },
        message: 'Allow an external MCP tool?',
        requestedSchema: { type: 'object', properties: {} }
      }
    });
    (
      connector as unknown as {
        runnerInteractionService: {
          respondUserInput(
            runId: string,
            requestId: string,
            answers: Record<string, unknown>
          ): void;
        };
      }
    ).runnerInteractionService.respondUserInput(run.id, 'input-live', {
      direction: ['Upgrade everything']
    });
    expect(responses).toEqual([
      {
        requestId: 'goal-approval-live',
        result: { action: 'accept', content: {}, _meta: null }
      },
      {
        requestId: 'input-live',
        result: { answers: { direction: { answers: ['Upgrade everything'] } } }
      }
    ]);

    const items = internals.runtime.listConversationTurns({ sessionId: session.id }).turns[0]
      ?.items;
    expect(items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'command_execution',
          payload: expect.objectContaining({
            command: 'pwd',
            outputPreview: '/workspace\\n',
            exitCode: 0
          })
        }),
        expect.objectContaining({
          kind: 'reasoning',
          payload: {
            representation: 'summary',
            sections: [{ index: 0, text: 'Check the current directory first.' }]
          }
        }),
        expect.objectContaining({
          kind: 'tool_call',
          status: 'IN_PROGRESS',
          payload: expect.objectContaining({
            title: 'Web Search',
            inputSummary: 'Codex App Server'
          })
        }),
        expect.objectContaining({
          kind: 'unknown',
          status: 'COMPLETED',
          payload: { sourceEventType: 'codex:futureCodexAction', label: 'Codex futureCodexAction' }
        }),
        expect.objectContaining({
          kind: 'file_change',
          status: 'COMPLETED',
          payload: {
            changes: [
              {
                path: 'src/new.ts',
                change: 'ADDED',
                additions: null,
                deletions: null,
                diffAvailable: false
              },
              {
                path: 'src/live.ts',
                change: 'MODIFIED',
                additions: 2,
                deletions: 1,
                diffAvailable: false
              },
              {
                path: 'src/old.ts',
                change: 'DELETED',
                additions: null,
                deletions: null,
                diffAvailable: false
              }
            ]
          }
        }),
        expect.objectContaining({
          kind: 'tool_call',
          status: 'IN_PROGRESS',
          payload: expect.objectContaining({
            toolName: 'imagegen',
            toolCategory: 'IMAGE_GENERATION',
            inputSummary: 'Generate a diagram'
          })
        }),
        expect.objectContaining({
          kind: 'plan',
          status: 'COMPLETED',
          payload: {
            explanation: 'Confirm the current directory, then apply the changes.',
            steps: []
          }
        }),
        expect.objectContaining({
          kind: 'plan',
          status: 'COMPLETED',
          payload: { explanation: 'Read the configuration first, then generate a plan.', steps: [] }
        }),
        expect.objectContaining({
          kind: 'command_execution',
          payload: expect.objectContaining({
            command: 'pwd',
            outputPreview: '"/workspace\\n"{"image_url":"[Image content extracted]"}',
            attachments: [
              expect.objectContaining({
                name: 'generated-image-1.png',
                mime: 'image/png',
                runId: run.id,
                imageIndex: 0
              })
            ]
          })
        }),
        expect.objectContaining({
          kind: 'user_input_request',
          status: 'COMPLETED',
          payload: expect.objectContaining({ requestId: 'input-live' })
        })
      ])
    );
    expect(
      items?.filter((item) => item.kind === 'assistant_message').map((item) => item.payload)
    ).toEqual([
      expect.objectContaining({ text: 'Complete message without an itemId' }),
      expect.objectContaining({ text: 'First message' }),
      expect.objectContaining({ text: 'Second message' }),
      expect.objectContaining({
        text: 'Preserve the delta when the completion notice lacks a body'
      })
    ]);
    const completedAgentMessage = items?.find(
      (item) => (item.payload as { text?: unknown }).text === 'Complete message without an itemId'
    );
    expect(completedAgentMessage).toMatchObject({ status: 'COMPLETED' });
    expect(JSON.stringify(items)).not.toContain('Hidden raw reasoning');
    await expect(
      (
        connector as unknown as {
          executeNodeOperation(operation: string, data: unknown): Promise<unknown>;
        }
      ).executeNodeOperation('run.image.read', { runId: run.id, imageIndex: 0 })
    ).resolves.toEqual({
      image: { name: 'generated-image-1.png', mime: 'image/png', dataBase64: 'aGVsbG8=' }
    });
    connector.stop();
  });
});
