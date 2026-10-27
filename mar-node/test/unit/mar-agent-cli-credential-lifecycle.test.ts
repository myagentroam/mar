import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it, vi } from 'vitest';
import type { MarAgentRuntimeModelConfiguration } from '../../../packages/protocol/src/index.js';
import type { AgentHost, ToolExecutionContext } from '../../../mar-agent/src/host.js';
import {
  MarAgentManagedRunController,
  resolveRunModels
} from '../../src/runner/mar-agent/managed-run-controller.js';
import { MarAgentRunner } from '../../src/runner/mar-agent-runner.js';
import { GitExecutionService } from '../../src/service/git-execution-service.js';
import { GitOperationService } from '../../src/service/git-operation-service.js';
import * as operational from '../../src/operational.js';

type CreateAgent = NonNullable<
  NonNullable<ConstructorParameters<typeof MarAgentManagedRunController>[2]>['createAgent']
>;

const runCredentialLifecycle = async (usesGit: boolean, explicitLifecycle: boolean) => {
  const root = await mkdtemp(join(tmpdir(), 'mar-cli-warm-'));
  const log = vi.spyOn(operational, 'nodeLog').mockImplementation(() => undefined);
  const git = new GitExecutionService({ directory: join(root, 'git') });
  const gitOperations = new GitOperationService({
    git: () => git,
    workspace: async () => ({
      id: 'fixture',
      path: root,
      kind: 'DIRECTORY',
      gitSummary: null,
      preserveGitConfig: false
    }),
    runActive: () => false
  });
  const observed: Array<{ credential: string; oldCredential?: string; mcp?: string }> = [];
  const retained: string[] = [];
  const catalogSources: string[][] = [];
  const hosts: AgentHost[] = [];
  let execution = 0;
  const disposed = vi.fn();
  const createAgent: CreateAgent = vi.fn(async ({ host }) => {
    hosts.push(host);
    let processId: string | undefined;
    let previousContext: ToolExecutionContext | undefined;
    const probe = async (context: ToolExecutionContext) => {
      const command = `${JSON.stringify(process.execPath)} -e "process.stdout.write(process.env.MAR_CTL_USER_TOKEN || 'missing')"`;
      const result = await host.executeTool(
        { name: 'exec', arguments: { command, yieldMs: 1000 } },
        context
      );
      return (result.data as { stdout: string }).stdout;
    };
    const session = {
      id: 'native-session',
      run: vi.fn(() => {
        const executionId = `sdk-${++execution}`;
        return {
          executionId,
          async *[Symbol.asyncIterator]() {},
          result: async () => {
            const context = {
              sessionId: 'native-session',
              executionId,
              mode: 'run' as const,
              signal: new AbortController().signal
            };
            const visible = await host.listExecutionExtensions?.({
              ...context,
              claimExecutionScope: true
            });
            expect(visible).not.toHaveProperty('environment');
            const credential = await probe(context);
            const oldCredential = previousContext ? await probe(previousContext) : undefined;
            const tools =
              (await host.listMcpTools?.({ ...context, executionScopeId: executionId })) ?? [];
            const catalog = await host.listMcpToolCatalog?.({
              ...context,
              executionScopeId: executionId
            });
            catalogSources.push(
              catalog?.tools.map((entry: { sourceIdentity: string }) => entry.sourceIdentity) ?? []
            );
            expect(
              catalog?.tools.map((entry: { lifetime: string }) => entry.lifetime) ?? []
            ).toEqual(tools.map(() => 'execution'));
            if (previousContext && tools.length) {
              await expect(
                host.callMcpTool?.(
                  { name: tools[0]!.name, arguments: { value: 'old-execution' } },
                  previousContext.signal,
                  previousContext
                )
              ).rejects.toThrow();
            }
            const mcp = tools.length
              ? await host.callMcpTool?.(
                  { name: tools[0]!.name, arguments: { value: 'fixture' } },
                  context.signal,
                  context
                )
              : undefined;
            observed.push({
              credential,
              ...(oldCredential === undefined ? {} : { oldCredential }),
              ...(mcp ? { mcp: mcp.content } : {})
            });
            if (processId) {
              const result = await host.executeTool(
                { name: 'exec_wait', arguments: { processId, yieldMs: 0 } },
                context
              );
              expect(result.data).toMatchObject({ status: 'running', processId });
              retained.push(processId);
            } else {
              const command = `${JSON.stringify(process.execPath)} -e "setInterval(() => {}, 1000)"`;
              const started = await host.executeTool(
                { name: 'exec', arguments: { command, yieldMs: 0 } },
                context
              );
              processId = (started.data as { processId: string }).processId;
            }
            previousContext = context;
            return { executionId, status: 'completed' as const, finalAnswer: 'done' };
          },
          cancel: vi.fn()
        };
      }),
      steer: vi.fn(async () => ({ status: 'notAccepted' as const })),
      plan: vi.fn(),
      compact: vi.fn(),
      cancel: vi.fn()
    };
    return {
      createSession: vi.fn(async () => session),
      openSession: vi.fn(async () => session),
      listSessions: vi.fn(),
      getSession: vi.fn(async () => ({
        id: 'native-session',
        title: 'New session',
        workspace: '/workspace',
        createdAt: '2026-01-01T00:00:00.000Z',
        lastActivityAt: '2026-01-01T00:00:00.000Z',
        source: { type: 'user' as const },
        automaticTitlePending: false
      })),
      setSessionTitle: vi.fn(async () => true),
      deleteSession: vi.fn(),
      clearSession: vi.fn(),
      setSystemInstruction: vi.fn(),
      reconfigureModels: vi.fn(async () => undefined),
      extensionDiagnostics: () => [],
      dispose: async () => {
        disposed();
        await host.dispose?.();
      }
    };
  });
  const emit = vi.fn();
  const controller = new MarAgentManagedRunController(
    new MarAgentRunner(),
    {
      active: new Set<string>(),
      adopt: vi.fn(),
      promote: vi.fn(),
      syncTitle: vi.fn(),
      emit,
      emitItem: vi.fn(),
      run: vi.fn(),
      commandState: vi.fn(),
      setCommandState: vi.fn(),
      clearCommandState: vi.fn(),
      commandStates: vi.fn(() => []),
      webSearch: vi.fn()
    },
    { createAgent, retainEnvironment: (environment) => git.retain(environment) }
  );
  const configuration: MarAgentRuntimeModelConfiguration = {
    id: 'fixture',
    name: 'Fixture',
    protocol: 'ANTHROPIC_MESSAGES',
    baseUrl: 'https://fixture.invalid',
    apiKey: 'fixture-only',
    modelId: 'fixture',
    contextWindowTokens: 200000,
    maxOutputTokens: 4096,
    inputCapabilities: ['TEXT'],
    outputCapabilities: ['TEXT'],
    reasoningEfforts: [],
    hostedWebSearch: false,
    responsesPreviousResponseId: false,
    enabled: true
  };
  const model = resolveRunModels(configuration, [configuration])[0]!;
  const controllerRun = (controller as unknown as { run(input: unknown): Promise<void> }).run.bind(
    controller
  );
  const run = async (input: Record<string, unknown>) => {
    if (!usesGit) return controllerRun(input);
    const environment = input.secretEnvironment as Record<string, string>;
    await gitOperations.execute(
      'session.message',
      {
        ...input,
        __requestUserId: environment.MAR_USERNAME === 'other-user' ? 2 : 1,
        gitConfiguration: {
          credentials: [
            {
              id: 'fixture',
              name: 'Fixture',
              protocol: 'HTTPS',
              host: 'fixture.invalid',
              port: 443,
              pathPrefix: '',
              username: 'fixture',
              commitName: '',
              commitEmail: '',
              secret: 'fixture-only'
            }
          ]
        }
      },
      async (data) => controllerRun(data)
    );
  };
  const input = {
    sessionId: 'native-session',
    externalSessionId: 'native-session',
    cwd: root,
    input: 'continue',
    model,
    models: [model],
    effort: '',
    access: 'full-access',
    mode: 'run',
    images: []
  };
  const mcpServer = (token: string) => ({
    name: 'credential-fixture',
    transport: 'STDIO',
    ...(explicitLifecycle ? { lifecycle: 'EXECUTION' } : {}),
    command: process.execPath,
    authorizationIdentity: 'fixture-user',
    args: [fileURLToPath(new URL('../support/mar-agent-mcp-server.mjs', import.meta.url))],
    environment: explicitLifecycle
      ? { PRIVATE_EXECUTION_VALUE: token }
      : { MAR_CTL_USER_TOKEN: token, MAR_TEST_REPORT_CLI_TOKEN: '1' }
  });
  try {
    for (const [index, token] of ['fixture-first', 'fixture-second', undefined].entries()) {
      await run({
        ...input,
        runId: `run-${index}`,
        secretEnvironment: {
          MAR_USERNAME: 'fixture-user',
          MAR_CTL_SERVER_URL: 'https://fixture.invalid',
          ...(token ? { MAR_CTL_USER_TOKEN: token } : {})
        },
        mcpServers: token ? [mcpServer(token)] : []
      });
    }
    expect(emit.mock.calls.filter((call) => call[1] === 'run.failed')).toEqual([]);
    expect(createAgent).toHaveBeenCalledTimes(1);
    expect(disposed).not.toHaveBeenCalled();
    expect(observed.map((value) => value.credential)).toEqual([
      'fixture-first',
      'fixture-second',
      'missing'
    ]);
    expect(observed[1]?.oldCredential).toBe('missing');
    expect(observed[2]?.oldCredential).toBe('missing');
    expect(observed[0]?.mcp).toContain(explicitLifecycle ? 'fixture' : 'fixture-first');
    expect(observed[1]?.mcp).toContain(explicitLifecycle ? 'fixture' : 'fixture-second');
    expect(catalogSources[0]).toHaveLength(1);
    expect(catalogSources[1]).toEqual(catalogSources[0]);
    expect(retained).toHaveLength(2);
    expect(new Set(retained).size).toBe(1);
    expect(
      log.mock.calls.filter(([event]) => event === 'runner.mar-agent.runtime.releasing')
    ).toEqual([]);
    await run({
      ...input,
      runId: 'other-user',
      mcpServers: [],
      secretEnvironment: {
        MAR_USERNAME: 'other-user',
        MAR_CTL_SERVER_URL: 'https://fixture.invalid',
        MAR_CTL_USER_TOKEN: 'other-fixture'
      }
    });
    expect(createAgent).toHaveBeenCalledTimes(2);
    expect(disposed).toHaveBeenCalledTimes(1);
    await run({
      ...input,
      runId: 'other-origin',
      mcpServers: [],
      secretEnvironment: {
        MAR_USERNAME: 'other-user',
        MAR_CTL_SERVER_URL: 'https://other.invalid',
        MAR_CTL_USER_TOKEN: 'other-fixture'
      }
    });
    expect(createAgent).toHaveBeenCalledTimes(3);
    expect(disposed).toHaveBeenCalledTimes(2);
    expect(emit.mock.calls.filter((call) => call[1] === 'run.failed')).toEqual([]);
    const releases = log.mock.calls.filter(
      ([event]) => event === 'runner.mar-agent.runtime.releasing'
    );
    expect(releases).toHaveLength(2);
    for (const [, data] of releases)
      expect(data).toEqual({
        runtimeId: expect.stringMatching(/^[0-9a-f-]{36}$/u),
        sessionId: 'native-session',
        reason: 'host_configuration_changed',
        changedCategories: ['environment']
      });
  } finally {
    await controller.dispose();
    await Promise.all(hosts.map((host) => host.dispose?.()));
    gitOperations.clear();
    await git.close();
    log.mockRestore();
    await rm(root, { recursive: true, force: true });
  }
};

it.each([
  [false, false],
  [true, false],
  [false, true],
  [true, true]
])(
  'rotates CLI credentials without losing warm resources and isolates old executions and principals (Git: %s, explicit Execution MCP: %s)',
  runCredentialLifecycle
);
