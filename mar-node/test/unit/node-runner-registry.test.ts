import { describe, expect, it, vi } from 'vitest';
import { createEnvelope, type NodeCapabilities } from '../../../packages/protocol/src/index.js';
import { ClaudeAgentSdkAdapter } from '../../src/runner/claude/claude-agent-sdk.js';
import { CodexAppServerClient } from '../../src/runner/codex/codex-app-server.js';
import { FakeRunner } from '../../src/fake-runner.js';
import { ClaudeCodeRunner } from '../../src/runner/claude-code-runner.js';
import { CodexRunner } from '../../src/runner/codex-runner.js';
import { FakeTestRunner } from '../../src/runner/fake-test-runner.js';
import { RunnerRegistry } from '../../src/runner/runner-registry.js';
import { OpenCodeRunner } from '../../src/runner/opencode-runner.js';
import { MarAgentRunner } from '../../src/runner/mar-agent-runner.js';
import type { ResolvedMcpServer } from '../../src/mcp/model.js';
import { OpenCodeServerClient } from '../../src/runner/opencode/opencode-server.js';

const capabilities: NodeCapabilities = {
  platform: 'linux',
  architecture: 'x64',
  nodeAppVersion: 'test',
  nodeVersion: process.version,
  codex: { available: true },
  claudeCode: { available: true },
  openCode: { available: true }
};

describe('Node Runner registry', () => {
  it('broadcasts identity migration to every registered Runner, including unavailable and test Runners', () => {
    const runners = [
      new CodexRunner(),
      new ClaudeCodeRunner(),
      new OpenCodeRunner(),
      new MarAgentRunner(),
      new FakeTestRunner(new FakeRunner())
    ];
    const migrations = runners.map((runner) => vi.spyOn(runner, 'migrateSessionIdentity'));
    const registry = new RunnerRegistry(runners);

    registry.migrateSessionIdentity('bootstrap', 'native');

    for (const migrate of migrations)
      expect(migrate).toHaveBeenCalledExactlyOnceWith('bootstrap', 'native');
    expect(new RunnerRegistry([]).migrateSessionIdentity('bootstrap', 'native')).toBeUndefined();
  });

  it('keeps the default identity migration a synchronous no-op for MAR Agent and Fake', () => {
    for (const runner of [new MarAgentRunner(), new FakeTestRunner(new FakeRunner())]) {
      expect(runner.migrateSessionIdentity('bootstrap', 'native')).toBeUndefined();
      expect(runner.migrateSessionIdentity('native', 'native')).toBeUndefined();
    }
  });

  it('propagates identity migration errors without rollback or continuing publication', () => {
    const first = new CodexRunner();
    const second = new ClaudeCodeRunner();
    const failure = new Error('MIGRATION_FAILED');
    vi.spyOn(first, 'migrateSessionIdentity').mockImplementation(() => {
      throw failure;
    });
    const later = vi.spyOn(second, 'migrateSessionIdentity');
    expect(() => new RunnerRegistry([first, second]).migrateSessionIdentity('old', 'new')).toThrow(
      failure
    );
    expect(later).not.toHaveBeenCalled();
  });

  it.each([
    { name: 'mar_goal', tools: ['get_goal', 'update_goal'] },
    {
      name: 'mar_schedule',
      tools: ['get_scheduled_task', 'create_scheduled_task', 'update_scheduled_task']
    },
    { name: 'mar_notification', tools: ['send_email_notification'] },
    { name: 'mar_notification', tools: ['send_email_notification', 'send_notification'] }
  ])(
    'preserves trusted direct/programmatic policy for $name ($tools) and Execution scope',
    ({ name, tools }) => {
      const server: ResolvedMcpServer = {
        name,
        origin: 'BUILTIN',
        lifecycle: 'EXECUTION',
        transport: 'STDIO',
        command: process.execPath,
        args: ['/fixture-mcp.js'],
        environment: { FIXTURE_TOKEN: 'fixture-secret' },
        allowedToolCallers: Object.fromEntries(
          tools.map((tool) => [tool, ['direct', 'programmatic'] as const])
        )
      };
      const configuration = new MarAgentRunner().mcpConfiguration([], {}, [
        server
      ]) as readonly ResolvedMcpServer[];
      expect(configuration).toEqual([
        expect.objectContaining({
          lifecycle: 'EXECUTION',
          origin: 'BUILTIN',
          allowedToolCallers: Object.fromEntries(
            tools.map((name) => [name, ['direct', 'programmatic']])
          )
        })
      ]);
    }
  );

  it('projects the scheduled task MCP into every Runner native configuration', () => {
    const server: ResolvedMcpServer = {
      name: 'mar_schedule',
      origin: 'BUILTIN',
      lifecycle: 'EXECUTION',
      transport: 'STDIO',
      command: process.execPath,
      args: ['/schedule-mcp.js'],
      environment: {
        MAR_SCHEDULE_MCP_ENDPOINT: '/schedule.sock',
        MAR_SCHEDULE_MCP_TOKEN: 'secret'
      }
    };
    for (const runner of [
      new MarAgentRunner(),
      new CodexRunner(),
      new ClaudeCodeRunner(),
      new OpenCodeRunner()
    ]) {
      const configuration = runner.mcpConfiguration([], {}, [server]);
      expect(JSON.stringify(configuration)).toContain('mar_schedule');
      expect(JSON.stringify(configuration)).toContain('MAR_SCHEDULE_MCP_ENDPOINT');
      expect(JSON.stringify(configuration)).toContain('secret');
    }
  });

  it('lets each Runner wrap its own history source without Codex falling back to native reads', async () => {
    const nativePage = { turns: [], nextCursor: 'native-cursor' };
    const officialPage = { turns: [], nextCursor: 'official-cursor' };
    const native = vi.fn(async () => nativePage);
    const official = vi.fn(async (): Promise<typeof officialPage | undefined> => officialPage);

    await expect(new CodexRunner().readConversationHistory({ native, official })).resolves.toEqual({
      ...officialPage,
      source: 'official'
    });
    expect(new CodexRunner().acceptsTruncatedNativeHistory()).toBe(true);
    expect(official).toHaveBeenCalledTimes(1);
    expect(native).not.toHaveBeenCalled();

    official.mockResolvedValueOnce(undefined);
    await expect(
      new CodexRunner().readConversationHistory({ native, official })
    ).resolves.toBeUndefined();
    expect(official).toHaveBeenCalledTimes(2);
    expect(native).not.toHaveBeenCalled();

    const failure = new Error('CODEX_HISTORY_READ_FAILED');
    official.mockRejectedValueOnce(failure);
    await expect(new CodexRunner().readConversationHistory({ native, official })).rejects.toBe(
      failure
    );
    expect(official).toHaveBeenCalledTimes(3);
    expect(native).not.toHaveBeenCalled();

    const readThread = vi.fn();
    const codex = new CodexRunner({ readThread } as unknown as CodexAppServerClient);
    await expect(codex.readExternalActivity({} as never)).resolves.toBeUndefined();
    expect(readThread).not.toHaveBeenCalled();

    const sessionStatus = vi.fn();
    const openCode = new OpenCodeRunner({ sessionStatus } as unknown as OpenCodeServerClient);
    await expect(openCode.readExternalActivity({} as never)).resolves.toBeUndefined();
    expect(sessionStatus).not.toHaveBeenCalled();

    native.mockClear();
    official.mockClear();
    await expect(
      new ClaudeCodeRunner().readConversationHistory({ native, official })
    ).resolves.toEqual({ ...nativePage, source: 'native' });
    expect(official).not.toHaveBeenCalled();

    native.mockClear();
    official.mockClear();
    await expect(
      new OpenCodeRunner().readConversationHistory({ native, official })
    ).resolves.toEqual({ ...officialPage, source: 'official' });
    expect(native).not.toHaveBeenCalled();
  });

  it('lets each Runner provide its Profile and defaults without restricting options submitted by Web', () => {
    const registry = new RunnerRegistry([
      new CodexRunner(new CodexAppServerClient()),
      new ClaudeCodeRunner(new ClaudeAgentSdkAdapter()),
      new OpenCodeRunner(new OpenCodeServerClient({ command: 'definitely-not-started-opencode' })),
      new FakeTestRunner(new FakeRunner())
    ]);

    expect(registry.profiles(capabilities).map((profile) => profile.runner)).toEqual([
      'codex',
      'claude-code',
      'opencode'
    ]);
    expect(registry.require('codex').defaultConfiguration()).toEqual({
      runner: 'codex',
      model: '',
      effort: '',
      access: 'on-request'
    });
    expect(registry.advertised().map((runner) => runner.name)).not.toContain('fake');
  });

  it('builds the Codex Profile from App Server model/list and caches dynamic default models', async () => {
    const listModels = vi
      .fn()
      .mockResolvedValueOnce({
        data: [
          {
            id: 'catalog-sol',
            model: 'gpt-dynamic-sol',
            displayName: 'Dynamic Sol',
            hidden: false,
            isDefault: true,
            defaultReasoningEffort: 'low',
            supportedReasoningEfforts: [
              { reasoningEffort: 'low', description: '' },
              { reasoningEffort: 'ultra', description: '' }
            ]
          }
        ],
        nextCursor: 'page-2'
      })
      .mockResolvedValueOnce({
        data: [
          {
            id: 'catalog-old',
            model: 'gpt-dynamic-old',
            displayName: 'Dynamic Old',
            hidden: false,
            isDefault: false,
            defaultReasoningEffort: 'medium',
            supportedReasoningEfforts: [{ reasoningEffort: 'medium', description: '' }]
          }
        ],
        nextCursor: null
      });
    const client = {
      configureEnvironment: vi.fn(),
      start: vi.fn(async () => undefined),
      listModels,
      stop: vi.fn()
    } as unknown as CodexAppServerClient;
    const runner = new CodexRunner(new CodexAppServerClient(), () => client);

    const profile = await runner.refreshProfile(capabilities, undefined, { OPENAI_API_KEY: 'x' });

    expect(listModels).toHaveBeenNthCalledWith(1, {
      cursor: null,
      limit: 100,
      includeHidden: false
    });
    expect(listModels).toHaveBeenNthCalledWith(2, {
      cursor: 'page-2',
      limit: 100,
      includeHidden: false
    });
    expect(profile.models).toEqual([
      {
        id: 'gpt-dynamic-sol',
        label: 'Dynamic Sol',
        supportedEfforts: ['low', 'ultra'],
        isDefault: true,
        defaultEffort: 'low'
      },
      {
        id: 'gpt-dynamic-old',
        label: 'Dynamic Old',
        supportedEfforts: ['medium'],
        isDefault: false,
        defaultEffort: 'medium'
      }
    ]);
    expect(runner.defaultConfiguration()).toEqual({
      runner: 'codex',
      model: 'gpt-dynamic-sol',
      effort: 'low',
      access: 'on-request'
    });
    expect(
      runner.supportsConfiguration({
        runner: 'codex',
        model: 'gpt-dynamic-sol',
        effort: 'ultra',
        access: 'on-request'
      })
    ).toBe(true);

    await runner.refreshProfile(capabilities, undefined, { OPENAI_API_KEY: 'different' });
    expect(listModels).toHaveBeenCalledTimes(2);
  });

  it('isolates a Runner Profile failure and returns the other cached Profiles', async () => {
    const codex = new CodexRunner();
    const openCode = new OpenCodeRunner();
    vi.spyOn(codex, 'refreshProfile').mockRejectedValue(new Error('CODEX_FAILED'));
    vi.spyOn(codex, 'cachedProfile').mockReturnValue({
      ...codex.profile(capabilities),
      models: []
    });
    vi.spyOn(openCode, 'refreshProfile').mockResolvedValue({
      ...openCode.profile(capabilities),
      models: [{ id: 'company/coding', label: 'Coding', supportedEfforts: [] }]
    });
    const registry = new RunnerRegistry([codex, openCode]);

    await expect(registry.refreshProfiles(capabilities)).resolves.toEqual([
      expect.objectContaining({ runner: 'codex', models: [] }),
      expect.objectContaining({
        runner: 'opencode',
        models: [expect.objectContaining({ id: 'company/coding' })]
      })
    ]);
  });

  it('stops Codex model pagination at the bounded Profile refresh limit', async () => {
    const listModels = vi.fn(async () => ({
      data: [],
      nextCursor: `page-${listModels.mock.calls.length + 1}`
    }));
    const client = {
      configureEnvironment: vi.fn(),
      start: vi.fn(async () => undefined),
      listModels,
      stop: vi.fn()
    } as unknown as CodexAppServerClient;
    const runner = new CodexRunner(new CodexAppServerClient(), () => client);

    await expect(runner.refreshProfile(capabilities)).resolves.toMatchObject({ models: [] });

    expect(listModels).toHaveBeenCalledTimes(6);
  });

  it('backs off for 30 seconds after the first Codex model-catalog failure and waits for recovery on the next request', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-23T00:00:00Z'));
    const clients = [
      {
        start: vi.fn(async () => undefined),
        listModels: vi.fn(async () => Promise.reject(new Error('temporary'))),
        stop: vi.fn()
      },
      {
        start: vi.fn(async () => undefined),
        listModels: vi.fn(async () => ({
          data: [
            {
              model: 'gpt-recovered',
              displayName: 'Recovered',
              hidden: false,
              isDefault: true,
              defaultReasoningEffort: 'medium',
              supportedReasoningEfforts: [{ reasoningEffort: 'medium', description: '' }]
            }
          ],
          nextCursor: null
        })),
        stop: vi.fn()
      }
    ] as unknown as CodexAppServerClient[];
    const runner = new CodexRunner(new CodexAppServerClient(), () => clients.shift()!);

    await expect(runner.refreshProfile(capabilities)).resolves.toMatchObject({ models: [] });
    await expect(runner.refreshProfile(capabilities)).resolves.toMatchObject({ models: [] });
    expect(clients).toHaveLength(1);

    vi.advanceTimersByTime(30_000);
    await expect(runner.refreshProfile(capabilities)).resolves.toMatchObject({
      models: [expect.objectContaining({ id: 'gpt-recovered' })]
    });
    expect(clients).toHaveLength(0);
    vi.useRealTimers();
  });

  it('reloads the model catalog when the Codex CLI version changes', async () => {
    const clients = ['gpt-version-1', 'gpt-version-2'].map((model) => ({
      start: vi.fn(async () => undefined),
      listModels: vi.fn(async () => ({
        data: [
          {
            model,
            displayName: model,
            hidden: false,
            isDefault: true,
            defaultReasoningEffort: 'medium',
            supportedReasoningEfforts: [{ reasoningEffort: 'medium', description: '' }]
          }
        ],
        nextCursor: null
      })),
      stop: vi.fn()
    }));
    const runner = new CodexRunner(
      new CodexAppServerClient(),
      () => clients.shift() as unknown as CodexAppServerClient
    );

    await expect(
      runner.refreshProfile({ ...capabilities, codex: { available: true, version: '1.0.0' } })
    ).resolves.toMatchObject({ models: [expect.objectContaining({ id: 'gpt-version-1' })] });
    await expect(
      runner.refreshProfile({ ...capabilities, codex: { available: true, version: '1.1.0' } })
    ).resolves.toMatchObject({ models: [expect.objectContaining({ id: 'gpt-version-2' })] });
  });

  it('refreshes an expired Codex Profile in the background and keeps stale models on failure', async () => {
    vi.useFakeTimers();
    const clients = [
      { model: 'gpt-old' },
      { error: new Error('temporary') },
      { model: 'gpt-new' }
    ].map((result) => ({
      start: vi.fn(async () => undefined),
      listModels: vi.fn(async () => {
        if ('error' in result) throw result.error;
        return {
          data: [
            {
              model: result.model,
              displayName: result.model,
              hidden: false,
              isDefault: true,
              defaultReasoningEffort: 'medium',
              supportedReasoningEfforts: [{ reasoningEffort: 'medium', description: '' }]
            }
          ],
          nextCursor: null
        };
      }),
      stop: vi.fn()
    }));
    const runner = new CodexRunner(
      new CodexAppServerClient(),
      () => clients.shift() as unknown as CodexAppServerClient
    );

    await runner.refreshProfile(capabilities);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(runner.cachedProfile(capabilities).models).toEqual([
      expect.objectContaining({ id: 'gpt-old' })
    ]);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(runner.cachedProfile(capabilities).models).toEqual([
      expect.objectContaining({ id: 'gpt-new' })
    ]);

    runner.stop();
    vi.useRealTimers();
  });

  it('keeps one Codex Profile across user key environments', async () => {
    const clients = ['gpt-user-a'].map((model) => ({
      configureEnvironment: vi.fn(),
      start: vi.fn(async () => undefined),
      listModels: vi.fn(async () => ({
        data: [
          {
            model,
            displayName: model,
            hidden: false,
            isDefault: true,
            defaultReasoningEffort: 'medium',
            supportedReasoningEfforts: [{ reasoningEffort: 'medium', description: '' }]
          }
        ],
        nextCursor: null
      })),
      stop: vi.fn()
    }));
    const runner = new CodexRunner(
      new CodexAppServerClient(),
      () => clients.shift() as unknown as CodexAppServerClient
    );
    const userA = { OPENAI_API_KEY: 'user-a' };
    const userB = { OPENAI_API_KEY: 'user-b' };

    await runner.refreshProfile(capabilities, undefined, userA);
    expect(runner.cachedProfile(capabilities, userA).models).toEqual([
      expect.objectContaining({ id: 'gpt-user-a' })
    ]);
    expect(runner.cachedProfile(capabilities, userB).models).toEqual([
      expect.objectContaining({ id: 'gpt-user-a' })
    ]);
    await runner.refreshProfile(capabilities, undefined, userB);
    expect(runner.cachedProfile(capabilities, userB).models).toEqual([
      expect.objectContaining({ id: 'gpt-user-a' })
    ]);

    expect(
      runner.supportsConfiguration(
        { runner: 'codex', model: 'gpt-user-a', effort: 'medium', access: 'on-request' },
        undefined,
        userA
      )
    ).toBe(true);
    expect(runner.defaultConfiguration(undefined, userA).model).toBe('gpt-user-a');
    expect(runner.defaultConfiguration(undefined, userB).model).toBe('gpt-user-a');
  });

  it('reclaims in-flight model-catalog clients when the Codex Runner stops', async () => {
    let rejectList!: (reason: Error) => void;
    const profileClient = {
      start: vi.fn(async () => undefined),
      listModels: vi.fn(
        () =>
          new Promise((_resolve, reject) => {
            rejectList = reject;
          })
      ),
      stop: vi.fn()
    } as unknown as CodexAppServerClient;
    const runner = new CodexRunner(new CodexAppServerClient(), () => profileClient);

    const refreshing = runner.refreshProfile(capabilities);
    await vi.waitFor(() => expect(profileClient.listModels).toHaveBeenCalledOnce());
    runner.stop();

    expect(profileClient.stop).toHaveBeenCalledOnce();
    rejectList(new Error('stopped'));
    await refreshing;
    const internals = runner as unknown as {
      profileCache: unknown;
      profileCacheTimer: unknown;
    };
    expect(internals.profileCache).toBeUndefined();
    expect(internals.profileCacheTimer).toBeUndefined();
  });

  it('uses environment variables for Claude Code model names and preserves default aliases for unset values', () => {
    const claude = new ClaudeCodeRunner(new ClaudeAgentSdkAdapter(), {
      ANTHROPIC_MODEL: 'company-sonnet-v2',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'company-opus-v1',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: '   '
    });
    const profile = claude.profile(capabilities);

    expect(profile.models).toEqual([
      expect.objectContaining({ id: 'company-opus-v1', label: 'company-opus-v1' }),
      expect.objectContaining({ id: 'company-sonnet-v2', label: 'company-sonnet-v2' }),
      expect.objectContaining({ id: 'haiku', label: 'Claude Haiku' })
    ]);
    expect(claude.defaultConfiguration()).toEqual({
      runner: 'claude-code',
      model: 'company-sonnet-v2',
      effort: 'medium',
      access: 'default'
    });
    expect(
      claude.supportsConfiguration({
        runner: 'claude-code',
        model: 'company-sonnet-v2',
        effort: 'high',
        access: 'default'
      })
    ).toBe(true);
    expect(
      claude.supportsConfiguration({
        runner: 'claude-code',
        model: 'sonnet',
        effort: 'high',
        access: 'default'
      })
    ).toBe(false);

    const duplicateModels = new ClaudeCodeRunner(new ClaudeAgentSdkAdapter(), {
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'company-shared',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'company-shared',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'company-shared'
    }).profile(capabilities).models;
    expect(duplicateModels.map((model) => model.id)).toEqual(['company-shared']);
  });

  it('uses environment variables for models with a third-party Base URL without retaining default aliases', () => {
    const thirdParty = new ClaudeCodeRunner(new ClaudeAgentSdkAdapter(), {
      ANTHROPIC_BASE_URL: 'https://gateway.example.com/anthropic',
      ANTHROPIC_MODEL: 'vendor-model-a',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'vendor-model-fast'
    });
    const profile = thirdParty.profile(capabilities);

    expect(profile.models).toEqual([
      expect.objectContaining({ id: 'vendor-model-a', label: 'vendor-model-a' }),
      expect.objectContaining({ id: 'vendor-model-fast', label: 'vendor-model-fast' })
    ]);
    expect(thirdParty.defaultConfiguration()).toEqual({
      runner: 'claude-code',
      model: 'vendor-model-a',
      effort: 'medium',
      access: 'default'
    });

    const opusOnly = new ClaudeCodeRunner(new ClaudeAgentSdkAdapter(), {
      ANTHROPIC_BASE_URL: 'https://gateway.example.com',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'vendor-model-b'
    });
    expect(opusOnly.profile(capabilities).models.map((model) => model.id)).toEqual([
      'vendor-model-b'
    ]);
    expect(opusOnly.defaultConfiguration().model).toBe('vendor-model-b');

    const haikuOnly = new ClaudeCodeRunner(new ClaudeAgentSdkAdapter(), {
      ANTHROPIC_BASE_URL: 'not a url',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'vendor-model-c'
    });
    expect(haikuOnly.profile(capabilities).models.map((model) => model.id)).toEqual([
      'vendor-model-c'
    ]);
    expect(haikuOnly.defaultConfiguration().model).toBe('vendor-model-c');

    const unconfigured = new ClaudeCodeRunner(new ClaudeAgentSdkAdapter(), {
      ANTHROPIC_BASE_URL: 'https://gateway.example.com'
    });
    expect(unconfigured.profile(capabilities).models).toEqual([]);
    expect(unconfigured.defaultConfiguration().model).toBe('sonnet');

    const official = new ClaudeCodeRunner(new ClaudeAgentSdkAdapter(), {
      ANTHROPIC_BASE_URL: 'https://api.anthropic.com',
      ANTHROPIC_MODEL: 'company-sonnet-v2'
    });
    expect(official.profile(capabilities).models.map((model) => model.id)).toEqual([
      'opus',
      'company-sonnet-v2',
      'haiku'
    ]);
  });

  it('rejects duplicate and unknown Runners and closes every implementation consistently', async () => {
    const codex = new CodexRunner(new CodexAppServerClient());
    const stop = vi.spyOn(codex, 'stop');
    const registry = new RunnerRegistry([codex]);

    expect(() => registry.register(new CodexRunner())).toThrow('RUNNER_ALREADY_REGISTERED:codex');
    expect(() => registry.require('claude-code')).toThrow('RUNNER_NOT_REGISTERED:claude-code');
    await registry.stop();
    expect(stop).toHaveBeenCalledOnce();
  });

  it('dispatches runs, cancellations, and approvals only through the registry while allowing a test Runner to intercept production Runners', () => {
    const codex = new CodexRunner();
    const fake = new FakeTestRunner(new FakeRunner());
    const codexStart = vi.fn();
    const fakeStart = vi.fn();
    const fakeCancel = vi.fn(() => true);
    const fakeApproval = vi.fn(() => true);
    codex.bindControl({ start: codexStart, cancel: () => false });
    fake.bindControl({
      start: fakeStart,
      cancel: fakeCancel,
      decideApproval: fakeApproval
    });
    const registry = new RunnerRegistry([codex, fake]);
    const envelope = createEnvelope('run.start', { runner: 'codex', runId: 'run-1' });

    expect(registry.startManagedRun(envelope)).toBe(true);
    expect(fakeStart).toHaveBeenCalledWith(envelope);
    expect(codexStart).not.toHaveBeenCalled();
    expect(registry.cancelManagedRun('run-1', 'INTERRUPT')).toBe(true);
    expect(fakeCancel).toHaveBeenCalledWith('run-1', 'INTERRUPT');
    expect(
      registry.decideApproval({
        runId: 'run-1',
        approvalId: 'approval-1',
        decision: 'APPROVED'
      })
    ).toBe(true);
    expect(fakeApproval).toHaveBeenCalledOnce();
  });
});
