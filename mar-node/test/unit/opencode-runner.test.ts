import { describe, expect, it, vi } from 'vitest';
import {
  NODE_PROTOCOL_VERSION,
  conversationItemSchema,
  serializeComposerTag,
  type NodeEnvelope,
  type RunnerCommandState
} from '../../../packages/protocol/src/index.js';
import type { NodeAgentSession } from '../../src/database.js';
import type { OpenCodeServerClient } from '../../src/opencode-server.js';
import { OpenCodeRunner } from '../../src/runner/opencode-runner.js';
import { homedir } from 'node:os';
import { openCodeConversationPage } from '../../src/runner/opencode/conversation-parser.js';
import { OpenCodeManagedRunController } from '../../src/runner/opencode/managed-run-controller.js';
import { normalizeOpenCodeTool } from '../../src/runner/opencode/tool-normalizer.js';
import { NodeRuntimeState } from '../../src/runtime-state.js';

describe('OpenCode Runner', () => {
  it('normalizes the shell tool to a command while keeping patch as a regular tool', () => {
    expect(
      normalizeOpenCodeTool('bash', {
        status: 'completed',
        input: { command: 'pwd' },
        output: '/workspace'
      })
    ).toMatchObject({
      kind: 'command_execution',
      payload: { command: 'pwd', outputPreview: '/workspace' }
    });
    expect(normalizeOpenCodeTool('patch', { status: 'completed' })).toMatchObject({
      kind: 'tool_call',
      payload: { toolName: 'patch' }
    });
    expect(normalizeOpenCodeTool('', { status: 'completed' })).toMatchObject({
      kind: 'tool_call',
      payload: { toolName: 'unknown', title: 'unknown' }
    });
  });

  it('preserves Agent messages with different stable Part IDs during consecutive updates', () => {
    const runtime = new NodeRuntimeState(
      () => 'node-opencode',
      (id) =>
        id === 'workspace-1'
          ? {
              id,
              path: '/workspace',
              kind: 'DIRECTORY',
              gitSummary: null,
              createdAt: 1,
              updatedAt: 1
            }
          : undefined
    );
    const session = runtime.createAgentSession({
      workspaceId: 'workspace-1',
      runner: 'opencode',
      cwd: '/workspace'
    });
    const run = runtime.createMessageRun({
      sessionId: session.id,
      clientMessageId: 'opencode-stable-parts',
      content: 'Continue'
    }).run;

    for (const [index, status] of ['IN_PROGRESS', 'COMPLETED'].entries())
      runtime.appendRunEvent({
        runId: run.id,
        sequence: index + 1,
        eventType: 'conversation.item',
        payload: {
          itemId: `opencode:part-${index + 1}`,
          kind: 'assistant_message',
          status,
          payload: { text: `Message ${index + 1}`, format: 'markdown', model: null }
        }
      });

    expect(
      runtime
        .listConversationTurns({ sessionId: session.id })
        .turns[0]?.items.filter((item) => item.kind === 'assistant_message')
        .map((item) => (item.payload as { text?: string }).text)
    ).toEqual(['Message 1', 'Message 2']);
  });

  it('session discovery excludes derived Sessions with a parentID', async () => {
    const runner = new OpenCodeRunner({
      sessions: vi.fn(async () => [
        {
          id: 'root-session',
          directory: '/workspace',
          title: 'Root session',
          time: { updated: 2 }
        },
        {
          id: 'child-session',
          parentID: 'root-session',
          directory: '/workspace',
          title: 'Derived session',
          time: { updated: 3 }
        }
      ])
    } as unknown as OpenCodeServerClient);
    const sessions = await runner.discoverSessions(
      {
        workspaces: [],
        createProjection: (input: { externalSessionId: string }) =>
          ({ id: input.externalSessionId }) as NodeAgentSession
      },
      { id: 'workspace-1', path: '/workspace', kind: 'DIRECTORY', gitSummary: null }
    );

    expect(sessions.map((session) => session.id)).toEqual(['root-session']);
  });

  it('allocates a separate OpenCode Server for each managed Run', async () => {
    const clients = [
      { configureEnvironment: vi.fn(), stop: vi.fn(async () => undefined) },
      { configureEnvironment: vi.fn(), stop: vi.fn(async () => undefined) }
    ] as unknown as OpenCodeServerClient[];
    const runner = new OpenCodeRunner(
      { stop: vi.fn(async () => undefined) } as unknown as OpenCodeServerClient,
      () => clients.shift()!
    );

    const first = runner.managedClient({}, 'run-1');
    const second = runner.managedClient({}, 'run-2');

    expect(first).not.toBe(second);
    runner.releaseManagedClient(first);
    runner.releaseManagedClient(second);
    await runner.stop();
  });

  it('discovers Node-wide providers through an isolated client using the current secret environment', async () => {
    const configureEnvironment = vi.fn();
    const stop = vi.fn(async () => undefined);
    const environmentClient = {
      configureEnvironment,
      providers: vi.fn(async () => ({
        connected: ['company'],
        all: [
          {
            id: 'company',
            name: 'Company',
            source: 'config',
            models: { coding: { id: 'coding', name: 'Coding', limit: { context: 200_000 } } }
          }
        ]
      })),
      stop
    } as unknown as OpenCodeServerClient;
    const runner = new OpenCodeRunner(
      { stop: vi.fn(async () => undefined) } as unknown as OpenCodeServerClient,
      () => environmentClient
    );

    const profile = await runner.refreshProfile(
      {
        platform: 'linux',
        architecture: 'x64',
        nodeAppVersion: '0.1.5',
        nodeVersion: process.version,
        codex: { available: false },
        claudeCode: { available: false },
        openCode: { available: true }
      },
      undefined,
      { ANTHROPIC_API_KEY: 'secret' }
    );

    expect(configureEnvironment).toHaveBeenCalledWith({ ANTHROPIC_API_KEY: 'secret' });
    expect(environmentClient.providers).toHaveBeenCalledWith(homedir());
    expect(profile.models).toEqual([
      expect.objectContaining({ id: 'company/coding', supportedEfforts: [] })
    ]);
    expect(stop).toHaveBeenCalledOnce();
    await runner.stop();
  });

  it('uses the Node-wide profile context limit across secret environments', async () => {
    const messages = vi.fn(async () => [
      {
        info: {
          role: 'assistant',
          providerID: 'company',
          modelID: 'coding',
          tokens: { input: 1_000 }
        }
      }
    ]);
    const runner = new OpenCodeRunner(
      { messages, stop: vi.fn(async () => undefined) } as unknown as OpenCodeServerClient,
      () => {
        return {
          configureEnvironment: vi.fn(),
          providers: vi.fn(async () => ({
            connected: ['company'],
            all: [
              {
                id: 'company',
                source: 'config',
                models: { coding: { id: 'coding', limit: { context: 10_000 } } }
              }
            ]
          })),
          stop: vi.fn(async () => undefined)
        } as unknown as OpenCodeServerClient;
      }
    );
    const capabilities = {
      platform: 'linux',
      architecture: 'x64',
      nodeAppVersion: '0.1.5',
      nodeVersion: process.version,
      codex: { available: false },
      claudeCode: { available: false },
      openCode: { available: true }
    } as const;
    const session = {
      externalSessionId: 'native',
      cwd: '/workspace',
      model: 'company/coding'
    } as NodeAgentSession;

    await runner.refreshProfile(capabilities, undefined, { API_KEY: 'first' });
    await expect(runner.readContextUsage(session)).resolves.toMatchObject({
      maxTokens: 10_000
    });
    await runner.refreshProfile(capabilities, undefined, { API_KEY: 'second' });
    await expect(runner.readContextUsage(session)).resolves.toMatchObject({
      maxTokens: 10_000
    });
    await runner.stop();
  });

  it('keeps one provider Profile across Workspaces and secret environments and coalesces concurrent refreshes', async () => {
    let finishProviders!: (value: unknown) => void;
    const providers = vi.fn(() => new Promise<unknown>((resolve) => (finishProviders = resolve)));
    const environmentClient = {
      configureEnvironment: vi.fn(),
      providers,
      stop: vi.fn(async () => undefined)
    } as unknown as OpenCodeServerClient;
    const runner = new OpenCodeRunner(
      { stop: vi.fn(async () => undefined) } as unknown as OpenCodeServerClient,
      () => environmentClient
    );
    const capabilities = {
      platform: 'linux',
      architecture: 'x64',
      nodeAppVersion: '0.1.5',
      nodeVersion: process.version,
      codex: { available: false },
      claudeCode: { available: false },
      openCode: { available: true }
    } as const;
    const workspace = {
      id: 'workspace-cache',
      path: '/workspace/cache',
      kind: 'DIRECTORY',
      gitSummary: null
    } as const;
    const otherWorkspace = { ...workspace, id: 'workspace-other', path: '/workspace/other' };
    const first = runner.refreshProfile(capabilities, workspace, { API_KEY: 'first' });
    const concurrent = runner.refreshProfile(capabilities, otherWorkspace, { API_KEY: 'first' });
    await vi.waitFor(() => expect(providers).toHaveBeenCalledOnce());
    finishProviders({
      connected: ['company'],
      all: [
        {
          id: 'company',
          name: 'Company',
          source: 'config',
          models: { coding: { id: 'coding', name: 'Coding' } }
        }
      ]
    });
    await expect(Promise.all([first, concurrent])).resolves.toHaveLength(2);
    await expect(
      runner.refreshProfile(capabilities, otherWorkspace, { API_KEY: 'first' })
    ).resolves.toMatchObject({ models: [expect.objectContaining({ id: 'company/coding' })] });
    expect(providers).toHaveBeenCalledOnce();
    const firstConfiguration = {
      runner: 'opencode',
      model: 'company/coding',
      effort: '',
      access: 'default'
    } as const;
    expect(runner.supportsConfiguration(firstConfiguration, workspace, { API_KEY: 'first' })).toBe(
      true
    );
    expect(
      runner.supportsConfiguration(firstConfiguration, otherWorkspace, { API_KEY: 'first' })
    ).toBe(true);
    expect(runner.supportsConfiguration(firstConfiguration, workspace, { API_KEY: 'second' })).toBe(
      true
    );

    await runner.refreshProfile(capabilities, workspace, { API_KEY: 'second' });
    expect(providers).toHaveBeenCalledOnce();
    expect(runner.defaultConfiguration(workspace, { API_KEY: 'first' }).model).toBe(
      'company/coding'
    );
    expect(runner.defaultConfiguration(workspace, { API_KEY: 'second' }).model).toBe(
      'company/coding'
    );
    await runner.stop();
  });

  it('keeps a stale Profile and backs off after an OpenCode provider refresh fails', async () => {
    vi.useFakeTimers();
    const providers = vi
      .fn()
      .mockResolvedValueOnce({
        connected: ['company'],
        all: [
          {
            id: 'company',
            name: 'Company',
            source: 'config',
            models: {
              coding: { id: 'coding', name: 'Coding', limit: { context: 200_000 } }
            }
          }
        ]
      })
      .mockRejectedValueOnce(new Error('temporary'))
      .mockResolvedValueOnce({
        connected: ['company'],
        all: [
          {
            id: 'company',
            name: 'Company',
            source: 'config',
            models: { next: { id: 'next', name: 'Next' } }
          }
        ]
      });
    const runner = new OpenCodeRunner(
      { stop: vi.fn(async () => undefined) } as unknown as OpenCodeServerClient,
      () =>
        ({
          configureEnvironment: vi.fn(),
          providers,
          stop: vi.fn(async () => undefined)
        }) as unknown as OpenCodeServerClient
    );
    const capabilities = {
      platform: 'linux',
      architecture: 'x64',
      nodeAppVersion: '0.1.5',
      nodeVersion: process.version,
      codex: { available: false },
      claudeCode: { available: false },
      openCode: { available: true }
    } as const;

    const environment = { API_KEY: 'first' };
    await runner.refreshProfile(capabilities, undefined, environment);
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(providers).toHaveBeenCalledTimes(2);
    expect(runner.cachedProfile(capabilities, environment).models).toEqual([
      expect.objectContaining({ id: 'company/coding' })
    ]);
    expect(runner.defaultConfiguration(undefined, environment).model).toBe('company/coding');

    await vi.advanceTimersByTimeAsync(30_000);
    expect(providers).toHaveBeenCalledTimes(3);
    expect(runner.cachedProfile(capabilities, environment).models).toEqual([
      expect.objectContaining({ id: 'company/next' })
    ]);
    expect(runner.defaultConfiguration(undefined, environment).model).toBe('company/next');

    await runner.stop();
    vi.useRealTimers();
  });

  it('backs off after a cold OpenCode provider refresh fails', async () => {
    const providers = vi.fn(async () => Promise.reject(new Error('temporary')));
    const runner = new OpenCodeRunner(
      { stop: vi.fn(async () => undefined) } as unknown as OpenCodeServerClient,
      () =>
        ({
          configureEnvironment: vi.fn(),
          providers,
          stop: vi.fn(async () => undefined)
        }) as unknown as OpenCodeServerClient
    );
    const capabilities = {
      platform: 'linux',
      architecture: 'x64',
      nodeAppVersion: '0.1.5',
      nodeVersion: process.version,
      codex: { available: false },
      claudeCode: { available: false },
      openCode: { available: true }
    } as const;
    const environment = { API_KEY: 'first' };

    await runner.refreshProfile(capabilities, undefined, environment);
    await runner.refreshProfile(capabilities, undefined, environment, true);

    expect(providers).toHaveBeenCalledOnce();
    await runner.stop();
  });

  it('bounds a stalled OpenCode Profile refresh', async () => {
    vi.useFakeTimers();
    const providers = vi.fn(() => new Promise<never>(() => undefined));
    const stop = vi.fn(async () => undefined);
    const runner = new OpenCodeRunner(
      { stop: vi.fn(async () => undefined) } as unknown as OpenCodeServerClient,
      () =>
        ({
          configureEnvironment: vi.fn(),
          providers,
          stop
        }) as unknown as OpenCodeServerClient
    );
    const capabilities = {
      platform: 'linux',
      architecture: 'x64',
      nodeAppVersion: '0.1.5',
      nodeVersion: process.version,
      codex: { available: false },
      claudeCode: { available: false },
      openCode: { available: true }
    } as const;

    const refreshing = runner.refreshProfile(capabilities, undefined, { API_KEY: 'first' });
    await vi.advanceTimersByTimeAsync(90_000);

    await expect(refreshing).resolves.toMatchObject({ models: [] });
    expect(providers).toHaveBeenCalledOnce();
    expect(stop).toHaveBeenCalledOnce();
    vi.useRealTimers();
    await runner.stop();
  });

  it.each(['resolve', 'reject'] as const)(
    'does not restore OpenCode Profile state after stop when providers %s late',
    async (settlement) => {
      let resolveProviders!: (value: unknown) => void;
      let rejectProviders!: (reason: Error) => void;
      const providers = vi.fn(
        () =>
          new Promise((resolve, reject) => {
            resolveProviders = resolve;
            rejectProviders = reject;
          })
      );
      const runner = new OpenCodeRunner(
        { stop: vi.fn(async () => undefined) } as unknown as OpenCodeServerClient,
        () =>
          ({
            configureEnvironment: vi.fn(),
            providers,
            stop: vi.fn(async () => undefined)
          }) as unknown as OpenCodeServerClient
      );
      const capabilities = {
        platform: 'linux',
        architecture: 'x64',
        nodeAppVersion: '0.1.5',
        nodeVersion: process.version,
        codex: { available: false },
        claudeCode: { available: false },
        openCode: { available: true }
      } as const;
      const refreshing = runner.refreshProfile(capabilities, undefined, { API_KEY: 'first' });
      await vi.waitFor(() => expect(providers).toHaveBeenCalledOnce());
      await runner.stop();
      if (settlement === 'resolve') resolveProviders({ connected: [], all: [] });
      else rejectProviders(new Error('stopped'));
      await refreshing;

      const internals = runner as unknown as {
        profileCache: unknown;
        profileRetryAt: number;
      };
      expect(internals.profileCache).toBeUndefined();
      expect(internals.profileRetryAt).toBe(0);
    }
  );

  it('projects official messages into a paginated conversation while preserving managed Turn identity', () => {
    const session = { id: 'session-1', externalSessionId: 'session-1' } as NodeAgentSession;
    const managed = {
      id: 'managed-turn',
      sessionId: session.id,
      runId: 'run-1',
      userItemId: 'local-user',
      status: 'RUNNING',
      model: 'company/coding',
      effort: null,
      access: 'default',
      startedAt: 10,
      completedAt: null,
      items: [
        {
          id: 'local-user',
          sessionId: session.id,
          turnId: 'managed-turn',
          runId: 'run-1',
          parentItemId: null,
          sourceSequence: 1,
          revision: 1,
          kind: 'user_message',
          status: 'COMPLETED',
          payload: { text: 'hello', attachments: [{ id: 'image-1' }] },
          startedAt: 10,
          completedAt: 10
        }
      ]
    } as const;
    const page = openCodeConversationPage(
      session,
      [
        {
          info: { id: 'user-1', sessionID: session.id, role: 'user', time: { created: 10 } },
          parts: [{ id: 'part-user', type: 'text', text: 'hello' }]
        },
        {
          info: {
            id: 'assistant-1',
            sessionID: session.id,
            role: 'assistant',
            parentID: 'user-1',
            modelID: 'coding',
            time: { created: 11, completed: 20 }
          },
          parts: [{ id: 'part-text', type: 'text', text: 'world' }]
        }
      ],
      { limit: 30 },
      (id) => (id === 'user-1' ? managed : undefined)
    );

    expect(page?.nextCursor).toBeNull();
    expect(page?.turns).toEqual([
      expect.objectContaining({
        id: 'managed-turn',
        runId: 'run-1',
        status: 'SUCCEEDED',
        rewind: { before: null, after: 'assistant-1' },
        items: [
          expect.objectContaining({ id: 'local-user', turnId: 'managed-turn' }),
          expect.objectContaining({
            kind: 'assistant_message',
            turnId: 'managed-turn',
            runId: 'run-1',
            payload: expect.objectContaining({ text: 'world' })
          })
        ]
      })
    ]);
  });

  it('preserves the final prompt for a non-image attachment from OpenCode history after Node restart', () => {
    const runnerInput =
      'Read the attachment\n\nAttachments available in the Workspace:\n- .mar/temp-files/run/notes.pdf';
    const session = {
      id: 'session-attachment-history',
      externalSessionId: 'session-attachment-history'
    } as NodeAgentSession;
    const page = openCodeConversationPage(
      session,
      [
        {
          info: { id: 'user-attachment', role: 'user', time: { created: 10 } },
          parts: [{ id: 'user-attachment-text', type: 'text', text: runnerInput }]
        },
        {
          info: {
            id: 'assistant-attachment',
            role: 'assistant',
            parentID: 'user-attachment',
            time: { created: 11, completed: 20 }
          },
          parts: [{ id: 'assistant-attachment-text', type: 'text', text: 'Read' }]
        }
      ],
      { limit: 30 },
      () => undefined
    );

    const user = page?.turns[0]?.items.find((item) => item.kind === 'user_message');
    expect(user?.payload).toMatchObject({ text: runnerInput });
  });

  it('projects OpenCode Plan Agent history text into a plan card', () => {
    const session = { id: 'session-plan', externalSessionId: 'session-plan' } as NodeAgentSession;
    const page = openCodeConversationPage(
      session,
      [
        {
          info: { id: 'user-plan', role: 'user', time: { created: 10 } },
          parts: [{ id: 'user-plan-text', type: 'text', text: 'Create a plan' }]
        },
        {
          info: {
            id: 'assistant-plan',
            role: 'assistant',
            parentID: 'user-plan',
            mode: 'plan',
            time: { created: 11, completed: 20 }
          },
          parts: [{ id: 'plan-text', type: 'text', text: 'First step' }]
        }
      ],
      { limit: 30 },
      () => undefined
    );

    expect(page?.turns[0]?.items).toContainEqual(
      expect.objectContaining({ kind: 'plan', payload: { explanation: 'First step', steps: [] } })
    );
  });

  it('restores a completed context-compaction card from a user-side compaction Part', () => {
    const session = {
      id: 'session-compaction',
      externalSessionId: 'session-compaction'
    } as NodeAgentSession;
    const page = openCodeConversationPage(
      session,
      [
        {
          info: { id: 'user-compaction', role: 'user', time: { created: 10 } },
          parts: [
            {
              id: 'compaction-part',
              messageID: 'user-compaction',
              type: 'compaction',
              auto: true
            }
          ]
        },
        {
          info: {
            id: 'assistant-summary',
            role: 'assistant',
            parentID: 'user-compaction',
            time: { created: 11, completed: 20 }
          },
          parts: [{ id: 'summary-text', type: 'text', text: 'internal compact summary' }]
        }
      ],
      { limit: 30 },
      () => undefined
    );

    const compaction = page?.turns[0]?.items.find((item) => item.kind === 'context_compaction');
    expect(compaction).toMatchObject({
      id: expect.stringContaining('compaction-part'),
      status: 'COMPLETED',
      payload: { phase: 'COMPLETED', summary: null }
    });
    expect(page?.turns[0]?.items).not.toContainEqual(
      expect.objectContaining({
        kind: 'assistant_message',
        payload: expect.objectContaining({ text: 'internal compact summary' })
      })
    );
  });

  it('preserves the remaining live messages from a managed Turn when official history backfills only some Agent Parts', () => {
    const session = {
      id: 'session-partial-history',
      externalSessionId: 'session-partial-history'
    } as NodeAgentSession;
    const managed = {
      id: 'managed-partial-turn',
      sessionId: session.id,
      runId: 'run-partial-history',
      userItemId: 'local-user',
      status: 'SUCCEEDED',
      model: null,
      effort: null,
      access: null,
      startedAt: 10,
      completedAt: 30,
      items: [
        {
          id: 'local-user',
          sessionId: session.id,
          turnId: 'managed-partial-turn',
          runId: 'run-partial-history',
          parentItemId: null,
          sourceSequence: 1,
          revision: 1,
          kind: 'user_message',
          status: 'COMPLETED',
          payload: { text: 'hello', clientMessageId: 'partial-history' },
          startedAt: 10,
          completedAt: 10
        },
        ...['First live message', 'Second live message', 'Third live message'].map(
          (text, index) => ({
            id: `run-partial-history:opencode:part-${index + 1}`,
            sessionId: session.id,
            turnId: 'managed-partial-turn',
            runId: 'run-partial-history',
            parentItemId: null,
            sourceSequence: index + 2,
            revision: 1,
            kind: 'assistant_message' as const,
            status: 'COMPLETED' as const,
            payload: { text, format: 'markdown', model: null },
            startedAt: 11 + index,
            completedAt: 11 + index
          })
        )
      ]
    } as const;

    const page = openCodeConversationPage(
      session,
      [
        {
          info: { id: 'user-1', role: 'user', time: { created: 10 } },
          parts: [{ id: 'user-part', type: 'text', text: 'hello' }]
        },
        {
          info: {
            id: 'assistant-1',
            role: 'assistant',
            parentID: 'user-1',
            time: { created: 11, completed: 12 }
          },
          parts: [{ id: 'part-1', type: 'text', text: 'First' }]
        }
      ],
      { limit: 30 },
      (id) => (id === 'user-1' ? (managed as never) : undefined)
    );

    expect(
      page?.turns[0]?.items
        .filter((item) => item.kind === 'assistant_message')
        .map((item) => (item.payload as { text?: string }).text)
    ).toEqual(['First live message', 'Second live message', 'Third live message']);
  });

  it('accepts a shorter official Agent Part when its native item ID matches the live Part', () => {
    const session = {
      id: 'session-final-part',
      externalSessionId: 'session-final-part'
    } as NodeAgentSession;
    const managed = {
      id: 'managed-final-part',
      sessionId: session.id,
      runId: 'run-final-part',
      status: 'SUCCEEDED',
      items: [
        {
          id: 'run-final-part:opencode:part-final',
          kind: 'assistant_message',
          payload: { text: 'Long streamed part' }
        }
      ]
    };
    const page = openCodeConversationPage(
      session,
      [
        {
          info: { id: 'user-final', role: 'user', time: { created: 10 } },
          parts: [{ id: 'user-part', type: 'text', text: 'Request' }]
        },
        {
          info: {
            id: 'assistant-final',
            role: 'assistant',
            parentID: 'user-final',
            time: { completed: 11 }
          },
          parts: [{ id: 'part-final', type: 'text', text: 'Final' }]
        }
      ],
      {},
      () => managed as never
    );
    expect(
      page?.turns[0]?.items.find((item) => item.kind === 'assistant_message')?.payload
    ).toMatchObject({ text: 'Final' });
  });

  it('converts question history, preserves the patch tool, and hides step boundary events', () => {
    const session = { id: 'session-items', externalSessionId: 'session-items' } as NodeAgentSession;
    const page = openCodeConversationPage(
      session,
      [
        {
          info: { id: 'user-items', role: 'user', time: { created: 10 } },
          parts: [{ id: 'user-items-text', type: 'text', text: 'Continue' }]
        },
        {
          info: {
            id: 'assistant-items',
            role: 'assistant',
            parentID: 'user-items',
            time: { created: 11, completed: 20 }
          },
          parts: [
            { id: 'step-start', type: 'step-start' },
            {
              id: 'question-part',
              type: 'tool',
              tool: 'question',
              callID: 'question-call',
              state: {
                status: 'completed',
                input: {
                  questions: [
                    {
                      question: 'Choose a sort order?',
                      options: [{ label: 'Directories first', description: 'VSCode style' }]
                    },
                    {
                      question: 'Second question?',
                      options: [
                        {
                          label: 'Continue',
                          description: 'Must not be dropped because of the count'
                        }
                      ]
                    },
                    {
                      question: 'Third question?',
                      options: [
                        {
                          label: 'Continue',
                          description: 'Must not be dropped because of the count'
                        }
                      ]
                    },
                    {
                      question: 'Fourth question?',
                      options: [
                        {
                          label: 'Continue',
                          description: 'Must not be dropped because of the count'
                        }
                      ]
                    },
                    {
                      question: 'Fifth question?',
                      options: [
                        {
                          label: 'Continue',
                          description: 'Must not be dropped because of the count'
                        }
                      ]
                    }
                  ]
                }
              }
            },
            {
              id: 'patch-part',
              type: 'patch',
              files: ['/workspace/src/a.ts', '/workspace/test/a.test.ts']
            },
            { id: 'future-part', type: 'future-part' },
            { id: 'step-finish', type: 'step-finish' }
          ]
        }
      ],
      {},
      () => undefined
    );

    expect(page?.turns[0]?.items.map((item) => item.kind)).toEqual([
      'user_message',
      'user_input_request',
      'tool_call',
      'unknown'
    ]);
    expect(page?.turns[0]?.items[1]).toMatchObject({
      status: 'COMPLETED',
      payload: {
        requestId: 'native:question-call',
        questions: [
          expect.objectContaining({ prompt: 'Choose a sort order?', allowOther: true }),
          expect.objectContaining({ prompt: 'Second question?', allowOther: true }),
          expect.objectContaining({ prompt: 'Third question?', allowOther: true }),
          expect.objectContaining({ prompt: 'Fourth question?', allowOther: true }),
          expect.objectContaining({ prompt: 'Fifth question?', allowOther: true })
        ]
      }
    });
    expect(page?.turns[0]?.items[2]).toMatchObject({
      kind: 'tool_call',
      payload: {
        namespace: 'opencode',
        toolName: 'patch',
        title: 'patch',
        inputSummary: null,
        outputSummary: 'OpenCode applied the patch'
      }
    });
    expect(page?.turns[0]?.items[3]).toMatchObject({
      status: 'COMPLETED',
      payload: { sourceEventType: 'opencode:future-part', label: 'OpenCode future-part' }
    });
  });

  it('updates a compaction Part in place from compacting to compacted using an explicit parent association', async () => {
    const items: Record<string, unknown>[] = [];
    let listener: ((value: unknown) => void) | undefined;
    const fakeClient = {
      configureEnvironment: vi.fn(),
      createSession: vi.fn(async () => ({ id: 'native-compaction' })),
      subscribe: vi.fn(
        async (
          _cwd: string,
          _signal: AbortSignal,
          event: (value: unknown) => void,
          ready: () => void
        ) => {
          listener = event;
          ready();
        }
      ),
      prompt: vi.fn(async () => undefined),
      abort: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined)
    } as unknown as OpenCodeServerClient;
    const runner = new OpenCodeRunner(fakeClient, () => fakeClient);
    const active = new Set<string>();
    const controller = new OpenCodeManagedRunController(runner, {
      ...commandHost(),
      intercepted: () => false,
      active,
      parseAttachments: () => [],
      persistAttachments: async () => [],
      emit: () => undefined,
      emitItem: (_runId, item) => items.push(item as unknown as Record<string, unknown>),
      adopt: () => undefined,
      promote: () => undefined,
      rememberNative: () => undefined,
      send: () => undefined,
      createApproval: () => undefined,
      publishApproval: () => undefined,
      expireApproval: () => undefined
    });

    controller.start(envelope());
    await vi.waitFor(() => expect(fakeClient.prompt).toHaveBeenCalledOnce());
    listener?.({
      type: 'message.updated',
      properties: {
        info: {
          id: 'user-compaction',
          sessionID: 'native-compaction',
          role: 'user'
        }
      }
    });
    listener?.({
      type: 'message.part.updated',
      properties: {
        part: {
          id: 'compaction-part',
          messageID: 'user-compaction',
          sessionID: 'native-compaction',
          type: 'compaction',
          auto: true
        }
      }
    });
    listener?.({
      type: 'message.updated',
      properties: {
        info: {
          id: 'assistant-summary',
          sessionID: 'native-compaction',
          role: 'assistant',
          parentID: 'user-compaction'
        }
      }
    });
    listener?.({
      type: 'message.part.updated',
      properties: {
        part: {
          id: 'summary-text',
          messageID: 'assistant-summary',
          sessionID: 'native-compaction',
          type: 'text',
          text: 'internal compact summary',
          time: { start: 10, end: 20 }
        }
      }
    });
    listener?.({
      type: 'message.updated',
      properties: {
        info: {
          id: 'assistant-summary',
          sessionID: 'native-compaction',
          role: 'assistant',
          parentID: 'user-compaction',
          time: { completed: 20 }
        }
      }
    });

    expect(items).toEqual([
      expect.objectContaining({
        itemId: 'opencode:compaction-part',
        kind: 'context_compaction',
        status: 'IN_PROGRESS',
        payload: { phase: 'STARTED', summary: null },
        merge: true
      }),
      expect.objectContaining({
        itemId: 'opencode:compaction-part',
        kind: 'context_compaction',
        status: 'COMPLETED',
        payload: { phase: 'COMPLETED', summary: null },
        merge: true
      })
    ]);
    for (const item of items)
      expect(
        conversationItemSchema.safeParse({
          id: item.itemId,
          sessionId: 'session',
          turnId: 'turn',
          runId: 'run-1',
          parentItemId: null,
          sourceSequence: 1,
          revision: 0,
          status: item.status,
          startedAt: 1,
          completedAt: item.status === 'IN_PROGRESS' ? null : 2,
          kind: item.kind,
          payload: item.payload
        }).success
      ).toBe(true);

    listener?.({ type: 'session.idle', properties: { sessionID: 'native-compaction' } });
    await vi.waitFor(() => expect(active).not.toContain('run-1'));
    await runner.stop();
  });

  it('ignores idle before subscription setup and completes the Run with official idle after the prompt', async () => {
    const events: { readonly type: string; readonly status?: string }[] = [];
    const items: unknown[] = [];
    const fakeClient = {
      configureEnvironment: vi.fn(),
      createSession: vi.fn(async () => ({ id: 'native-1' })),
      subscribe: vi.fn(
        async (
          _cwd: string,
          _signal: AbortSignal,
          event: (value: unknown) => void,
          ready: () => void
        ) => {
          event({ type: 'session.idle', properties: { sessionID: 'native-1' } });
          ready();
        }
      ),
      prompt: vi.fn(async () => undefined),
      abort: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined)
    } as unknown as OpenCodeServerClient;
    const runner = new OpenCodeRunner(fakeClient, () => fakeClient);
    const active = new Set<string>();
    const controller = new OpenCodeManagedRunController(runner, {
      ...commandHost(),
      intercepted: () => false,
      active,
      parseAttachments: () => [],
      persistAttachments: async () => [],
      emit: (_runId, type, _payload, status) =>
        events.push({ type, ...(status === undefined ? {} : { status }) }),
      emitItem: (_runId, item) => items.push(item),
      adopt: () => undefined,
      promote: () => undefined,
      rememberNative: () => undefined,
      send: () => undefined,
      createApproval: () => undefined,
      publishApproval: () => undefined,
      expireApproval: () => undefined
    });

    controller.start(envelope());
    await vi.waitFor(() => expect(fakeClient.prompt).toHaveBeenCalledOnce());
    expect(fakeClient.prompt).toHaveBeenCalledWith(expect.objectContaining({ agent: 'build' }));
    expect(events.some((event) => event.type === 'run.completed')).toBe(false);

    const listener = vi.mocked(fakeClient.subscribe).mock.calls[0]?.[2];
    listener?.({
      type: 'message.updated',
      properties: {
        info: { id: 'user-message-1', sessionID: 'native-1', role: 'user' }
      }
    });
    listener?.({
      type: 'message.part.updated',
      properties: {
        part: {
          id: 'user-part-1',
          messageID: 'user-message-1',
          sessionID: 'native-1',
          type: 'text',
          text: 'user input',
          time: { start: 1, end: 2 }
        }
      }
    });
    listener?.({
      type: 'message.updated',
      properties: {
        info: {
          id: 'assistant-message-1',
          sessionID: 'native-1',
          role: 'assistant',
          parentID: 'user-message-1'
        }
      }
    });
    listener?.({
      type: 'message.part.updated',
      properties: {
        part: {
          id: 'part-1',
          messageID: 'assistant-message-1',
          sessionID: 'native-1',
          type: 'text',
          text: 'OK',
          time: { start: 1, end: 2 }
        }
      }
    });
    listener?.({
      type: 'message.part.updated',
      properties: {
        part: {
          id: 'part-patch',
          messageID: 'assistant-message-1',
          sessionID: 'native-1',
          type: 'patch',
          files: ['/workspace/src/a.ts']
        }
      }
    });
    listener?.({
      type: 'message.part.updated',
      properties: {
        part: {
          id: 'part-future',
          messageID: 'assistant-message-1',
          sessionID: 'native-1',
          type: 'future-part',
          time: { start: 1, end: 2 }
        }
      }
    });
    listener?.({ type: 'session.idle', properties: { sessionID: 'native-1' } });
    await vi.waitFor(() =>
      expect(events).toContainEqual({ type: 'run.completed', status: 'SUCCEEDED' })
    );
    expect(items).toEqual([
      expect.objectContaining({ kind: 'assistant_message' }),
      expect.objectContaining({
        kind: 'tool_call',
        status: 'COMPLETED',
        payload: expect.objectContaining({ toolName: 'patch' })
      }),
      expect.objectContaining({
        kind: 'unknown',
        payload: { sourceEventType: 'opencode:future-part', label: 'OpenCode future-part' }
      })
    ]);
    expect(active).not.toContain('run-1');
    await runner.stop();
  });

  it.each(['standalone', 'uploaded', 'replacement'])(
    'preserves native images and reuses current files for media fallback: %s',
    async (mode) => {
      const reuseExisting = mode !== 'standalone';
      const attachment = {
        name: 'screen.png',
        mime: 'image/png' as const,
        dataBase64: 'aW1hZ2U='
      };
      const attachments = reuseExisting
        ? [attachment, { ...attachment, dataBase64: 'c2Vjb25k' }]
        : [attachment];
      const paths = ['.mar/temp-files/first/screen.png', '.mar/temp-files/second/screen.png'];
      const fakeClient = {
        configureEnvironment: vi.fn(),
        createSession: vi.fn(async () => ({ id: 'native-image' })),
        subscribe: vi.fn(
          async (
            _cwd: string,
            _signal: AbortSignal,
            _event: (value: unknown) => void,
            ready: () => void
          ) => ready()
        ),
        prompt: vi.fn(async () => undefined),
        stop: vi.fn(async () => undefined)
      } as unknown as OpenCodeServerClient;
      const runner = new OpenCodeRunner(fakeClient, () => fakeClient);
      const persistAttachments = vi.fn(async () => [
        '.mar/temp-files/run-1-opencode-images/screen.png'
      ]);
      const controller = new OpenCodeManagedRunController(runner, {
        ...host(new Set<string>(), []),
        parseAttachments: () => attachments,
        persistAttachments
      });

      const request = envelope();
      if (reuseExisting) {
        const previousTag =
          mode === 'replacement'
            ? serializeComposerTag('mar_attachments', {
                files: [
                  {
                    name: attachment.name,
                    mime: attachment.mime,
                    path: '.mar/temp-files/previous/screen.png'
                  }
                ]
              })
            : '';
        const currentTag = serializeComposerTag('mar_attachments', {
          files: [
            ...paths.map((path) => ({
              name: attachment.name,
              mime: attachment.mime,
              path: `../../${path}`,
              workspacePath: path
            })),
            {
              name: attachment.name,
              mime: 'application/pdf',
              path: '.mar/temp-files/document/screen.png'
            }
          ]
        });
        request.payload = {
          ...(request.payload as Record<string, unknown>),
          input: `hello\n${previousTag}\nReplacement message\n${currentTag}`
        };
      }
      controller.start(request);

      await vi.waitFor(() => expect(fakeClient.prompt).toHaveBeenCalledOnce());
      if (reuseExisting) expect(persistAttachments).not.toHaveBeenCalled();
      else expect(persistAttachments).toHaveBeenCalledWith('/workspace', 'run-1', attachments);
      expect(fakeClient.prompt).toHaveBeenCalledWith(
        expect.objectContaining({
          attachments,
          text: expect.stringContaining(
            reuseExisting ? `../../${paths[0]}` : '.mar/temp-files/run-1-opencode-images/screen.png'
          )
        })
      );
      if (reuseExisting) {
        const text = vi.mocked(fakeClient.prompt).mock.calls[0]?.[0].text;
        expect(
          text?.endsWith(paths.map((path) => `- ${JSON.stringify(`../../${path}`)}`).join('\n'))
        ).toBe(true);
      } else expect(vi.mocked(fakeClient.prompt).mock.calls[0]?.[0].text).toMatch(/^hello\n\n/);
      await runner.stop();
    }
  );

  it('projects the question tool into customizable questions and returns answers in the original order', async () => {
    let listener: ((value: unknown) => void) | undefined;
    const items: Array<Record<string, unknown>> = [];
    const fakeClient = {
      configureEnvironment: vi.fn(),
      createSession: vi.fn(async () => ({ id: 'native-question' })),
      subscribe: vi.fn(
        async (
          _cwd: string,
          _signal: AbortSignal,
          event: (value: unknown) => void,
          ready: () => void
        ) => {
          listener = event;
          ready();
        }
      ),
      prompt: vi.fn(async () => undefined),
      replyQuestion: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined)
    } as unknown as OpenCodeServerClient;
    const runner = new OpenCodeRunner(fakeClient, () => fakeClient);
    const active = new Set<string>();
    const controller = new OpenCodeManagedRunController(runner, {
      ...host(active, []),
      emitItem: (_runId, item) => items.push(item as Record<string, unknown>)
    });

    controller.start(envelope());
    await vi.waitFor(() => expect(fakeClient.prompt).toHaveBeenCalledOnce());
    listener?.({
      type: 'message.part.updated',
      properties: {
        part: {
          id: 'question-tool-part',
          sessionID: 'native-question',
          type: 'tool',
          tool: 'question',
          callID: 'question-tool-call',
          state: {
            status: 'running',
            input: {
              questions: [
                {
                  question: 'How should files and directories be ordered in the tree?',
                  options: []
                }
              ]
            }
          }
        }
      }
    });
    expect(items).toEqual([]);
    listener?.({
      type: 'question.asked',
      properties: {
        id: 'question-request-1',
        sessionID: 'native-question',
        questions: [
          {
            header: 'Sort order',
            question: 'How should files and directories be ordered in the tree?',
            options: [
              { label: 'Keep mixed alphabetical order by name', description: 'Minimal change' },
              { label: 'Directories first', description: 'VSCode style' }
            ]
          },
          {
            header: 'Upload target',
            question: 'Where should it be uploaded?',
            options: [{ label: 'Follow current tree selection', description: 'Recommended' }],
            multiple: true
          },
          {
            header: 'Third item',
            question: 'Third question?',
            options: [{ label: 'Third item option', description: 'Used for regression testing' }]
          },
          {
            header: 'Fourth item',
            question: 'Fourth question?',
            options: [{ label: 'Fourth item option', description: 'Used for regression testing' }]
          },
          {
            header: 'Fifth item',
            question: 'Fifth question?',
            options: [{ label: 'Fifth item option', description: 'Must not be silently dropped' }]
          }
        ]
      }
    });

    expect(items).toContainEqual(
      expect.objectContaining({
        kind: 'user_input_request',
        status: 'PENDING',
        payload: expect.objectContaining({
          requestId: 'question-request-1',
          questions: [
            expect.objectContaining({
              allowOther: true,
              prompt: 'How should files and directories be ordered in the tree?'
            }),
            expect.objectContaining({
              allowOther: true,
              input: 'MULTI_SELECT',
              multiSelect: true,
              prompt: 'Where should it be uploaded?'
            }),
            expect.objectContaining({ prompt: 'Third question?' }),
            expect.objectContaining({ prompt: 'Fourth question?' }),
            expect.objectContaining({ prompt: 'Fifth question?' })
          ]
        })
      })
    );
    expect(items.filter((item) => item.kind === 'user_input_request')).toHaveLength(1);
    expect(() =>
      controller.respondUserInput('run-1', 'question-request-1', {
        'question-1': ['Valid value', ''],
        'question-2': ['Follow current tree selection'],
        'question-3': ['Third item option'],
        'question-4': ['Fourth item option'],
        'question-5': ['Fifth item option']
      })
    ).toThrow('USER_INPUT_INVALID');
    expect(
      controller.respondUserInput('run-1', 'question-request-1', {
        'question-1': ['Custom sort'],
        'question-2': ['Follow current tree selection'],
        'question-3': ['Third item option'],
        'question-4': ['Fourth item option'],
        'question-5': ['Fifth item option']
      })
    ).toBe(true);
    expect(fakeClient.replyQuestion).toHaveBeenCalledWith('/workspace', 'question-request-1', [
      ['Custom sort'],
      ['Follow current tree selection'],
      ['Third item option'],
      ['Fourth item option'],
      ['Fifth item option']
    ]);
    await runner.stop();
  });

  it('sends the terminal state and clears the active marker even when native Session creation fails', async () => {
    const events: string[] = [];
    const items: Array<{ readonly kind: string; readonly payload: Record<string, unknown> }> = [];
    const fakeClient = {
      configureEnvironment: vi.fn(),
      createSession: vi.fn(async () => {
        throw Object.assign(new Error('Too many requests.'), { status: 429 });
      }),
      stop: vi.fn(async () => undefined)
    } as unknown as OpenCodeServerClient;
    const runner = new OpenCodeRunner(fakeClient, () => fakeClient);
    const active = new Set<string>();
    const controller = new OpenCodeManagedRunController(runner, {
      ...commandHost(),
      intercepted: () => false,
      active,
      parseAttachments: () => [],
      persistAttachments: async () => [],
      emit: (_runId, type) => events.push(type),
      emitItem: (_runId, item) => items.push(item),
      adopt: () => undefined,
      promote: () => undefined,
      rememberNative: () => undefined,
      send: () => undefined,
      createApproval: () => undefined,
      publishApproval: () => undefined,
      expireApproval: () => undefined
    });

    controller.start(envelope());
    await vi.waitFor(() => expect(events).toContain('run.failed'));
    expect(items).toContainEqual(
      expect.objectContaining({
        kind: 'error',
        payload: expect.objectContaining({
          code: 'HTTP_429',
          httpStatus: 429,
          message: 'Too many requests.'
        })
      })
    );
    expect(active).not.toContain('run-1');
    await runner.stop();
  });

  it('switches /plan state and sends subsequent messages to the native Plan Agent', async () => {
    let listener: ((value: unknown) => void) | undefined;
    const items: unknown[] = [];
    const fakeClient = {
      configureEnvironment: vi.fn(),
      createSession: vi.fn(async () => ({ id: 'native-plan' })),
      subscribe: vi.fn(
        async (
          _cwd: string,
          _signal: AbortSignal,
          event: (value: unknown) => void,
          ready: () => void
        ) => {
          listener = event;
          ready();
        }
      ),
      prompt: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined)
    } as unknown as OpenCodeServerClient;
    const runner = new OpenCodeRunner(fakeClient, () => fakeClient);
    const active = new Set<string>();
    const commandState = commandHost();
    const controller = new OpenCodeManagedRunController(runner, {
      ...host(active, []),
      ...commandState,
      emitItem: (_runId, item) => items.push(item)
    });
    const session = { id: 'session-plan' } as NodeAgentSession;
    const command = {
      id: 'plan',
      runner: 'opencode',
      interaction: 'TOGGLE'
    } as never;

    await expect(
      controller.executeCommand(session, command, { secretEnvironment: {} })
    ).resolves.toMatchObject({
      command: 'plan',
      states: [
        expect.objectContaining({
          commandId: 'plan',
          active: true,
          continuation: { label: 'Implement', prompt: 'Implement the plan above.' }
        })
      ]
    });
    controller.start(envelope('plan'));
    await vi.waitFor(() =>
      expect(fakeClient.prompt).toHaveBeenCalledWith(expect.objectContaining({ agent: 'plan' }))
    );
    listener?.({
      type: 'message.updated',
      properties: {
        info: {
          id: 'assistant-plan-message',
          sessionID: 'native-plan',
          role: 'assistant',
          parentID: 'user-plan-message'
        }
      }
    });
    listener?.({
      type: 'message.part.updated',
      properties: {
        part: {
          id: 'plan-part',
          messageID: 'assistant-plan-message',
          sessionID: 'native-plan',
          type: 'text',
          text: 'Implementation plan',
          time: { start: 1, end: 2 }
        }
      }
    });
    expect(items).toContainEqual(
      expect.objectContaining({
        kind: 'plan',
        payload: { explanation: 'Implementation plan', steps: [] }
      })
    );
    await expect(
      controller.executeCommand(session, command, { secretEnvironment: {} })
    ).resolves.toMatchObject({ states: [] });
    await runner.stop();
  });

  it('ends the Run on failure before subscription setup without leaving a permanently waiting startup task', async () => {
    const events: string[] = [];
    const fakeClient = {
      configureEnvironment: vi.fn(),
      createSession: vi.fn(async () => ({ id: 'native-1' })),
      subscribe: vi.fn(async () => {
        throw new Error('SUBSCRIBE_FAILED');
      }),
      stop: vi.fn(async () => undefined)
    } as unknown as OpenCodeServerClient;
    const runner = new OpenCodeRunner(fakeClient, () => fakeClient);
    const active = new Set<string>();
    const controller = new OpenCodeManagedRunController(runner, host(active, events));

    controller.start(envelope());
    await vi.waitFor(() => expect(events).toContain('run.failed'));
    expect(active).not.toContain('run-1');
    await runner.stop();
  });

  it('sends one terminal Run state when the cancellation response races the SSE terminal state', async () => {
    const events: string[] = [];
    let listener: ((value: unknown) => void) | undefined;
    const fakeClient = {
      configureEnvironment: vi.fn(),
      createSession: vi.fn(async () => ({ id: 'native-1' })),
      subscribe: vi.fn(
        async (
          _cwd: string,
          _signal: AbortSignal,
          event: (value: unknown) => void,
          ready: () => void
        ) => {
          listener = event;
          ready();
          await new Promise(() => undefined);
        }
      ),
      prompt: vi.fn(async () => undefined),
      abort: vi.fn(async () => {
        listener?.({ type: 'session.idle', properties: { sessionID: 'native-1' } });
      }),
      stop: vi.fn(async () => undefined)
    } as unknown as OpenCodeServerClient;
    const runner = new OpenCodeRunner(fakeClient, () => fakeClient);
    const active = new Set<string>();
    const controller = new OpenCodeManagedRunController(runner, host(active, events));

    controller.start(envelope());
    await vi.waitFor(() => expect(fakeClient.prompt).toHaveBeenCalledOnce());
    expect(controller.cancel('run-1', 'CANCEL')).toBe(true);
    await vi.waitFor(() => expect(active).not.toContain('run-1'));
    expect(events.filter((event) => event === 'run.completed')).toHaveLength(1);
    await runner.stop();
  });
});

function host(active: Set<string>, events: string[]) {
  return {
    ...commandHost(),
    intercepted: () => false,
    active,
    parseAttachments: () => [],
    persistAttachments: async () => [],
    emit: (_runId: string, type: string) => events.push(type),
    emitItem: () => undefined,
    adopt: () => undefined,
    promote: () => undefined,
    rememberNative: () => undefined,
    send: () => undefined,
    createApproval: () => undefined,
    publishApproval: () => undefined,
    expireApproval: () => undefined
  };
}

function commandHost() {
  const states = new Map<string, RunnerCommandState>();
  return {
    run: (runId: string) => ({ id: runId }),
    hasActiveSessionLease: () => false,
    commandState: (_sessionId: string, commandId: string) => states.get(commandId),
    setCommandState: (_sessionId: string, state: RunnerCommandState) =>
      states.set(state.commandId, state),
    clearCommandState: (_sessionId: string, commandId: string) => states.delete(commandId),
    commandStates: () => [...states.values()].filter((state) => state.active)
  };
}

function envelope(collaborationMode?: 'plan'): NodeEnvelope {
  return {
    version: NODE_PROTOCOL_VERSION,
    id: 'message-1',
    type: 'run.start',
    payload: {
      runner: 'opencode',
      runId: 'run-1',
      sessionId: 'bootstrap-1',
      input: 'hello',
      cwd: '/workspace',
      model: 'company/coding',
      effort: '',
      access: 'default',
      ...(collaborationMode === undefined ? {} : { collaborationMode })
    }
  } as NodeEnvelope;
}
