import Fastify from 'fastify';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { Pool } from 'mysql2/promise';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerMarctlSessionRoutes } from '../../src/marctl-session-routes.js';
import { MarctlUserCredentials } from '../../src/marctl-user-credentials.js';
import type { ConversationAuditObserver } from '../../src/conversation-audit.js';
import type {
  MarAgentModelService,
  MarAgentRuntimeModelService
} from '../../src/session-run-contracts.js';
import type { UserNodeAuthorization } from '../../src/node-access-contracts.js';

const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});
async function fixture(
  scoped = true,
  scheduled = true,
  options: {
    session?: Record<string, unknown>;
    profiles?: Record<string, unknown>;
    authorizedNode?: boolean;
    ownsConnection?: boolean;
    executionSource?: string;
    channel?: boolean;
    marAgentRuntimeModels?: Pick<MarAgentRuntimeModelService, 'prepare'>;
    marAgentModels?: MarAgentModelService;
    audits?: ConversationAuditObserver;
  } = {}
) {
  const credentials = new MarctlUserCredentials({
    execute: async () => [[{ id: 7, username: 'owner' }]]
  } as unknown as Pool);
  const scope = { nodeId: 'node', workspaceId: 'workspace' };
  const token = credentials.issue(
    {
      userId: 7,
      ...(scheduled ? {} : { sessionHash: 'a'.repeat(43) }),
      ...(options.channel === true ? { channel: true } : {})
    },
    scoped ? scope : undefined,
    options.executionSource === undefined
      ? { type: 'terminal' }
      : { type: 'execution', sessionId: options.executionSource, executionId: 'execution-1' }
  );
  const requestNode = vi.fn(
    async (
      _node: string,
      operation: string,
      data: Record<string, unknown>,
      _user?: UserNodeAuthorization,
      _timeout?: number,
      _signal?: AbortSignal
    ): Promise<unknown> => {
      if (operation === 'session.cli.context')
        return { workspace: { id: 'workspace', path: '/fixture' }, session: null, run: null };
      if (operation === 'session.get')
        return {
          ...(data.view === 'marctl'
            ? { view: 'marctl', workspaceId: options.session?.workspaceId ?? 'workspace' }
            : {}),
          session: {
            id: data.sessionId,
            workspaceId: 'workspace',
            runner: 'codex',
            modelId: 'test-model',
            ...options.session
          }
        };
      if (operation === 'runner.profiles.list')
        return options.profiles ?? { profiles: [], defaults: [] };
      if (operation === 'session.list') return { view: 'marctl', sessions: [], nextCursor: null };
      if (operation === 'session.runs') return { runs: [] };
      if (operation === 'workspace.queue.get') return { queue: { items: [] } };
      if (operation === 'session.goal.get') return { goal: null };
      if (operation === 'session.start')
        return { session: { id: 'native-new' }, run: { id: 'new-run' } };
      if (operation === 'session.command.execute') return { accepted: true };
      return { accepted: true };
    }
  );
  const secrets = { resolve: vi.fn(async () => ({ FIXTURE_SECRET: 'not-public' })) };
  const instructions = { get: vi.fn(async () => ({ common: 'Account rule' })) };
  const authorizedNode = vi.fn(async () => options.authorizedNode ?? true);
  const ownsWorkbenchConnection = vi.fn(
    (_sessionHash: string, connectionId: string) =>
      options.ownsConnection === true && connectionId === 'connection-owned'
  );
  const app = Fastify();
  apps.push(app);
  registerMarctlSessionRoutes({
    app,
    credentials,
    publicOrigin: 'https://server.test',
    authorizedNode,
    requestNode,
    secrets,
    personalInstructions: instructions,
    ...(options.marAgentRuntimeModels === undefined
      ? {}
      : { marAgentRuntimeModels: options.marAgentRuntimeModels }),
    ...(options.marAgentModels === undefined ? {} : { marAgentModels: options.marAgentModels }),
    ...(options.audits === undefined ? {} : { audits: options.audits }),
    ownsWorkbenchConnection
  });
  const headers = { authorization: `Bearer ${token}` };
  return {
    app,
    credentials,
    headers,
    scope,
    requestNode,
    secrets,
    instructions,
    authorizedNode,
    ownsWorkbenchConnection
  };
}

describe('Workspace-bound marctl agents', () => {
  it('rejects removed Profile list queries before preparing models or contacting Node', async () => {
    const listForUser = vi.fn(async () => [
      {
        id: 'eligible',
        enabled: true,
        conversationModel: true,
        subagentModel: true,
        access: { private: 'not-for-node' }
      },
      { id: 'disabled', enabled: false, conversationModel: true, subagentModel: true },
      { id: 'no-subagent', enabled: true, conversationModel: true, subagentModel: false }
    ]);
    const prepare = vi.fn();
    const f = await fixture(true, false, {
      executionSource: 'parent',
      session: { runner: 'codex', modelId: 'parent-model' },
      marAgentModels: { listForUser } as unknown as MarAgentModelService,
      marAgentRuntimeModels: { prepare }
    });
    const response = await f.app.inject({
      method: 'POST',
      url: '/api/marctl/sessions',
      headers: f.headers,
      payload: {
        action: 'network',
        command: { operation: 'list', input: { scope: 'profile', runner: 'mar-agent' } }
      }
    });
    expect(response.statusCode).toBe(400);
    expect(listForUser).not.toHaveBeenCalled();
    expect(prepare).not.toHaveBeenCalled();
    expect(f.requestNode).not.toHaveBeenCalled();
    expect(response.body).not.toContain('not-for-node');
  });

  it.each([undefined, 'parent'])(
    'relays compact list input and output without model resources for caller %s',
    async (executionSource) => {
      const f = await fixture(true, false, executionSource ? { executionSource } : {});
      const result = { currentAgentId: executionSource ?? null, sessions: [], truncated: false };
      f.requestNode.mockResolvedValue(result);
      for (const input of [{}, { scope: 'tree' }, { scope: 'active', query: 'Task', limit: 100 }]) {
        const response = await f.app.inject({
          method: 'POST',
          url: '/api/marctl/sessions',
          headers: f.headers,
          payload: { action: 'network', command: { operation: 'list', input } }
        });
        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual(result);
        const call = f.requestNode.mock.calls.at(-1)!;
        expect(call[1]).toBe('agent.network');
        expect(call[2]).toEqual({ workspaceId: 'workspace', action: 'list', input });
        expect(call[3]).not.toHaveProperty('marctlExecutionResources');
      }
      expect(f.secrets.resolve).not.toHaveBeenCalled();
      for (const input of [
        { cursor: 'next' },
        { parent: 'p' },
        { agentId: 'p' },
        { runner: 'codex' },
        { scope: 'children' },
        { limit: 101 }
      ]) {
        f.requestNode.mockClear();
        const response = await f.app.inject({
          method: 'POST',
          url: '/api/marctl/sessions',
          headers: f.headers,
          payload: { action: 'network', command: { operation: 'list', input } }
        });
        expect(response.statusCode).toBe(400);
        expect(f.requestNode).not.toHaveBeenCalled();
      }
    }
  );

  it('supplies the authenticated safe model catalog for a MAR configuration update without issuing runtime credentials', async () => {
    const listForUser = vi.fn(async () => [
      {
        id: 'eligible',
        enabled: true,
        conversationModel: true,
        subagentModel: true,
        access: { private: 'not-for-node' }
      },
      { id: 'disabled', enabled: false, conversationModel: true, subagentModel: true }
    ]);
    const prepare = vi.fn();
    const f = await fixture(true, false, {
      executionSource: 'parent',
      session: { runner: 'mar-agent', parentSessionId: 'someone-else', modelId: 'old' },
      marAgentModels: { listForUser } as unknown as MarAgentModelService,
      marAgentRuntimeModels: { prepare }
    });
    const response = await f.app.inject({
      method: 'POST',
      url: '/api/marctl/sessions',
      headers: f.headers,
      payload: { action: 'config', sessionId: 'unrelated', modelId: 'eligible', effort: 'high' }
    });
    expect(response.statusCode).toBe(200);
    expect(listForUser).toHaveBeenCalledExactlyOnceWith(7);
    expect(prepare).not.toHaveBeenCalled();
    const configured = f.requestNode.mock.calls.find(
      (call) => call[1] === 'session.config.update'
    )!;
    expect(configured[2]).toMatchObject({
      sessionId: 'unrelated',
      modelId: 'eligible',
      effort: 'high',
      marAgentModels: [
        { id: 'eligible', enabled: true, conversationModel: true, subagentModel: true },
        { id: 'disabled', enabled: false }
      ]
    });
    expect(JSON.stringify(configured)).not.toContain('not-for-node');
    expect(configured[2]).not.toHaveProperty('marAgentModel');
  });

  it.each([
    { goal: { clear: true } },
    { approval: { approvalId: 'approval', decision: 'approve' } },
    { approval: { approvalId: 'approval', decision: 'reject' } }
  ])('does not prepare model execution resources for control-only send %j', async (control) => {
    const prepare = vi.fn(async () => {
      throw new Error('MODEL_CONFIGURATION_UNAVAILABLE');
    });
    const f = await fixture(true, false, {
      executionSource: 'parent',
      session: { runner: 'mar-agent', modelId: 'unavailable-model' },
      marAgentRuntimeModels: { prepare }
    });
    const response = await f.app.inject({
      method: 'POST',
      url: '/api/marctl/sessions',
      headers: f.headers,
      payload: {
        action: 'network',
        command: { operation: 'send', input: { agentId: 'unrelated', ...control } }
      }
    });
    expect(response.statusCode).toBe(200);
    expect(prepare).not.toHaveBeenCalled();
    const network = f.requestNode.mock.calls.find((call) => call[1] === 'agent.network')!;
    expect(network[2]).toMatchObject({
      action: 'send',
      input: { agentId: 'unrelated', ...control }
    });
    expect(network[2].input).not.toHaveProperty('clientMessageId');
    expect(network[3]).not.toHaveProperty('marctlExecutionResources');
  });

  it('rejects malformed network approval decisions before contacting Node', async () => {
    const { app, headers, requestNode, secrets } = await fixture();
    for (const approval of [
      { approvalId: '', decision: 'approve' },
      { approvalId: 'approval', decision: 'APPROVED' },
      { approvalId: 'approval' },
      { approvalId: 'approval', decision: 'approve', runId: 'untrusted' }
    ]) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/marctl/sessions',
        headers,
        payload: {
          action: 'network',
          command: { operation: 'send', input: { agentId: 'target', approval } }
        }
      });
      expect(response.statusCode).toBe(400);
    }
    expect(requestNode).not.toHaveBeenCalled();
    expect(secrets.resolve).not.toHaveBeenCalled();
  });

  it('prepares target MAR resources for the execution goal.set alias through the shared network path', async () => {
    const prepare = vi.fn(async () => ({
      runtimeScopeId: 'goal-scope',
      model: { id: 'goal-model' },
      models: [{ id: 'goal-model' }]
    }));
    const f = await fixture(true, false, {
      executionSource: 'parent',
      session: { runner: 'mar-agent', modelId: 'goal-model' },
      marAgentRuntimeModels: { prepare }
    });
    const response = await f.app.inject({
      method: 'POST',
      url: '/api/marctl/sessions',
      headers: f.headers,
      payload: { action: 'goal.set', sessionId: 'unrelated', content: 'Continue the work' }
    });
    expect(response.statusCode).toBe(200);
    expect(prepare).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ userId: 7, sessionId: 'unrelated', selectedModelId: 'goal-model' })
    );
    const network = f.requestNode.mock.calls.find((call) => call[1] === 'agent.network')!;
    expect(network[2]).toMatchObject({
      action: 'send',
      input: { agentId: 'unrelated', goal: { objective: 'Continue the work' } }
    });
    expect(network[3]).toMatchObject({
      marctlExecutionResources: { marAgentModel: { id: 'goal-model' } }
    });
  });

  it('uses the target MAR Runner default instead of the parent model for an Execution start', async () => {
    const prepare = vi.fn(async (input: { readonly selectedModelId: string }) => ({
      runtimeScopeId: 'scope',
      model: { id: input.selectedModelId },
      models: []
    }));
    const f = await fixture(true, false, {
      executionSource: 'parent',
      session: { runner: 'mar-agent', modelId: 'parent-non-default' },
      profiles: {
        profiles: [{ runner: 'mar-agent', models: [] }],
        defaults: [{ runner: 'mar-agent', modelId: 'runner-default' }]
      },
      marAgentRuntimeModels: { prepare }
    });
    const response = await f.app.inject({
      method: 'POST',
      url: '/api/marctl/sessions',
      headers: f.headers,
      payload: {
        action: 'network',
        command: {
          operation: 'start',
          input: { title: 'Child', content: 'Start work' }
        }
      }
    });
    expect(response.statusCode).toBe(200);
    expect(prepare).toHaveBeenCalledWith(
      expect.objectContaining({ selectedModelId: 'runner-default' })
    );
    const network = f.requestNode.mock.calls.find((call) => call[1] === 'agent.network')!;
    expect(network[2]).toMatchObject({ input: { modelId: 'runner-default' } });
  });

  it.each(['start', 'send'] as const)(
    'prepares MAR model resources for an authenticated non-MAR Execution %s',
    async (operation) => {
      const prepare = vi.fn(async () => ({
        runtimeScopeId: 'scope',
        model: { id: 'eligible' },
        models: [{ id: 'eligible' }]
      }));
      const f = await fixture(true, false, {
        executionSource: 'parent',
        session:
          operation === 'send'
            ? { runner: 'mar-agent', modelId: 'eligible', parentSessionId: 'parent' }
            : { runner: 'codex', modelId: 'codex-model' },
        marAgentRuntimeModels: { prepare } as unknown as Pick<
          MarAgentRuntimeModelService,
          'prepare'
        >
      });
      const input =
        operation === 'start'
          ? { content: 'Start work', runner: 'mar-agent', modelId: 'eligible' }
          : { agentId: 'child', content: 'Continue work' };
      const response = await f.app.inject({
        method: 'POST',
        url: '/api/marctl/sessions',
        headers: f.headers,
        payload: { action: 'network', command: { operation, input } }
      });
      expect(response.statusCode).toBe(200);
      expect(prepare).toHaveBeenCalledOnce();
      expect(prepare).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 7,
          selectedModelId: 'eligible',
          ...(operation === 'send' ? { sessionId: 'child' } : {})
        })
      );
      expect(f.requestNode.mock.calls.some((call) => call[1] === 'runner.profiles.list')).toBe(
        true
      );
      const network = f.requestNode.mock.calls.find((call) => call[1] === 'agent.network')!;
      expect(network[3]).toMatchObject({
        marctlExecutionResources: {
          marAgentRuntimeScopeId: 'scope',
          marAgentModel: { id: 'eligible' },
          marAgentModels: [{ id: 'eligible' }]
        }
      });
      expect(network[2]).not.toHaveProperty('marAgentModel');
      expect(response.body).not.toContain('marAgentModel');
    }
  );

  it('prepares authorized MAR resources for an unrelated target without a relationship grant', async () => {
    const prepare = vi.fn(async () => ({
      runtimeScopeId: 'peer-scope',
      model: { id: 'eligible' },
      models: [{ id: 'eligible' }]
    }));
    const f = await fixture(true, false, {
      executionSource: 'parent',
      session: { runner: 'mar-agent', modelId: 'eligible', parentSessionId: 'someone-else' },
      marAgentRuntimeModels: { prepare } as unknown as Pick<MarAgentRuntimeModelService, 'prepare'>
    });
    const response = await f.app.inject({
      method: 'POST',
      url: '/api/marctl/sessions',
      headers: f.headers,
      payload: {
        action: 'network',
        command: {
          operation: 'send',
          input: { agentId: 'unrelated', content: 'work', deliveryIntent: 'REPLACE_CURRENT' }
        }
      }
    });
    expect(response.statusCode).toBe(200);
    expect(prepare).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ userId: 7, sessionId: 'unrelated', selectedModelId: 'eligible' })
    );
    const network = f.requestNode.mock.calls.find((call) => call[1] === 'agent.network')!;
    expect(network[3]).toMatchObject({
      marctlExecutionResources: {
        marAgentRuntimeScopeId: 'peer-scope',
        marAgentModel: { id: 'eligible' }
      }
    });
    expect(response.body).not.toContain('marAgentModel');
  });

  it('does not prepare MAR resources for another Workspace or a claimed foreign parent', async () => {
    const prepare = vi.fn();
    const f = await fixture(true, false, {
      executionSource: 'parent',
      session: { runner: 'mar-agent', modelId: 'eligible', workspaceId: 'other-workspace' },
      marAgentRuntimeModels: { prepare } as unknown as Pick<MarAgentRuntimeModelService, 'prepare'>
    });
    for (const [operation, input] of [
      ['send', { agentId: 'unrelated', content: 'work' }],
      [
        'start',
        {
          parentSessionId: 'someone-else',
          runner: 'mar-agent',
          modelId: 'eligible',
          content: 'work'
        }
      ]
    ] as const) {
      const response = await f.app.inject({
        method: 'POST',
        url: '/api/marctl/sessions',
        headers: f.headers,
        payload: { action: 'network', command: { operation, input } }
      });
      expect(response.statusCode).toBe(operation === 'send' ? 403 : 200);
    }
    expect(prepare).not.toHaveBeenCalled();
    for (const call of f.requestNode.mock.calls.filter((entry) => entry[1] === 'agent.network'))
      expect(call[3]).not.toHaveProperty('marctlExecutionResources');
  });
  it.each(['goal.clear', 'goal.set'] as const)(
    'routes legacy %s through the Node network authorization',
    async (action) => {
      const f = await fixture(true, false, { executionSource: 'parent' });
      for (const target of ['child', 'sibling']) {
        const response = await f.app.inject({
          method: 'POST',
          url: '/api/marctl/sessions',
          headers: f.headers,
          payload: {
            action,
            sessionId: target,
            ...(action === 'goal.set' ? { content: 'Finish task' } : {})
          }
        });
        expect(response.statusCode).toBe(200);
        expect(f.requestNode).toHaveBeenLastCalledWith(
          'node',
          'agent.network',
          expect.objectContaining({
            action: 'send',
            input: {
              agentId: target,
              goal: action === 'goal.clear' ? { clear: true } : { objective: 'Finish task' }
            }
          }),
          expect.objectContaining({
            marctlCaller: expect.objectContaining({ sessionId: 'parent' })
          })
        );
      }
      expect(f.requestNode.mock.calls.some((call) => call[1] === 'session.command.execute')).toBe(
        false
      );
    }
  );

  it.each(['start', 'send', 'stop'] as const)(
    'rejects legacy execution %s without reaching a Node write',
    async (action) => {
      const f = await fixture(true, false, { executionSource: 'parent' });
      const payload =
        action === 'start'
          ? { action, runner: 'codex', content: 'work', clientMessageId: 'msg' }
          : action === 'send'
            ? {
                action,
                sessionId: 'sibling',
                content: 'work',
                clientMessageId: 'msg',
                deliveryIntent: 'SEND'
              }
            : { action, sessionId: 'sibling', runId: 'run' };
      const response = await f.app.inject({
        method: 'POST',
        url: '/api/marctl/sessions',
        headers: f.headers,
        payload
      });
      expect(response.statusCode).toBe(409);
      expect(f.requestNode).not.toHaveBeenCalled();
    }
  );

  it('relays unified Agent commands with the authenticated Execution and a bounded wait', async () => {
    const f = await fixture(true, false, { executionSource: 'source' });
    const original = f.requestNode.getMockImplementation()!;
    f.requestNode.mockImplementation(async (...args) =>
      args[1] === 'agent.network'
        ? { waitOutcome: 'snapshot', agentId: 'child' }
        : original(...args)
    );
    const response = await f.app.inject({
      method: 'POST',
      url: '/api/marctl/sessions',
      headers: f.headers,
      payload: {
        action: 'network',
        command: { operation: 'wait', input: { agentId: 'child', waitMs: 0 } }
      }
    });
    expect(response.statusCode).toBe(200);
    const network = f.requestNode.mock.calls.find((call) => call[1] === 'agent.network')!;
    expect(network[2]).toMatchObject({
      workspaceId: 'workspace',
      action: 'wait',
      input: { agentId: 'child', waitMs: 0 }
    });
    expect(network[3]).toMatchObject({
      marctlCaller: { type: 'execution', sessionId: 'source', executionId: 'execution-1' }
    });
    expect(network[4]).toBe(5_000);
    expect(network[5]).toBeInstanceOf(AbortSignal);
    const forged = await f.app.inject({
      method: 'POST',
      url: '/api/marctl/sessions',
      headers: f.headers,
      payload: {
        action: 'network',
        command: {
          operation: 'wait',
          input: { agentId: 'child', __marctlCaller: { type: 'terminal' } }
        }
      }
    });
    expect(forged.statusCode).toBe(400);
  });

  it.each([
    [undefined, 35_000],
    [0, 5_000],
    [1, 15_000],
    [10_000, 15_000],
    [300_000, 305_000]
  ])('budgets Node wait time using its effective duration (%s)', async (waitMs, expected) => {
    const { app, headers, requestNode } = await fixture(true, false, { executionSource: 'source' });
    const response = await app.inject({
      method: 'POST',
      url: '/api/marctl/sessions',
      headers,
      payload: {
        action: 'network',
        command: {
          operation: 'wait',
          input: { agentId: 'target', ...(waitMs === undefined ? {} : { waitMs }) }
        }
      }
    });
    expect(response.statusCode).toBe(200);
    const relay = requestNode.mock.calls.find((call) => call[1] === 'agent.network');
    expect(relay?.[4]).toBe(expected);
  });

  it('accepts real CLI subprocess requests over HTTP using the issued Workspace credential', async () => {
    const { app, headers, requestNode } = await fixture(true, false, { executionSource: 'source' });
    const request = requestNode.getMockImplementation()!;
    const listResult = {
      currentAgentId: 'source',
      sessions: [
        { id: 'source', parentSessionId: null, title: 'Review', runner: 'codex', status: 'RUNNING' }
      ],
      truncated: false
    };
    requestNode.mockImplementation(async (...args) => {
      if (args[1] === 'agent.network' && args[2].action === 'send') {
        const approval = (args[2].input as Record<string, unknown>).approval;
        return approval
          ? { agentId: 'target', approval: { status: 'applied' }, message: null }
          : {
              agentId: 'target',
              message: {
                status: 'accepted',
                result: {
                  run: { id: 'active-run' },
                  queueItemId: 'input',
                  delivery: 'ACCEPTED'
                }
              }
            };
      }
      return args[1] === 'agent.network' && args[2].action === 'list'
        ? listResult
        : request(...args);
    });
    const baseUrl = await app.listen({ host: '127.0.0.1', port: 0 });
    const cli = fileURLToPath(new URL('../../../../marctl/bin/marctl.mjs', import.meta.url));
    try {
      for (const args of [
        ['send', 'target', '--steer', '-m', 'Additional context', '--client-message-id', 'input'],
        ['send', 'target', '--approval', 'approval-1', '--decision', 'approve'],
        ['list', '--scope', 'active', '--query', 'Review', '--limit', '1'],
        ['rename', '--title', 'reviewer#42 Updated'],
        ['config', '--effort', 'high'],
        ['schedule', 'list'],
        ['schedule', 'get'],
        ['schedule', 'create', '--cron', '0 9 * * *', '-m', 'Check tests'],
        ['schedule', 'update', '--expected-revision', '3', '--cron', '0 8 * * *']
      ]) {
        const result = await promisify(execFile)(
          process.execPath,
          [cli, 'agents', ...args, '--json'],
          {
            timeout: 10_000,
            env: {
              ...process.env,
              MAR_CTL_CONTEXT_REQUIRED: '1',
              MAR_CTL_SERVER_URL: baseUrl,
              MAR_CTL_USER_TOKEN: headers.authorization.slice(7),
              MAR_CTL_SESSION_ID: 'source'
            }
          }
        );
        expect(result.stderr).toBe('');
        expect(JSON.parse(result.stdout)).toBeTypeOf('object');
        if (args[0] === 'list') expect(JSON.parse(result.stdout)).toEqual(listResult);
        if (args[0] === 'send' && args.includes('--approval'))
          expect(JSON.parse(result.stdout)).toMatchObject({
            agentId: 'target',
            approval: { status: 'applied' },
            message: null
          });
        else if (args[0] === 'send')
          expect(JSON.parse(result.stdout)).toMatchObject({
            clientMessageId: 'input',
            agentId: 'target',
            message: {
              status: 'accepted',
              result: {
                run: { id: 'active-run' },
                queueItemId: 'input',
                delivery: 'ACCEPTED'
              }
            }
          });
      }
      expect(requestNode).toHaveBeenCalledWith(
        'node',
        'agent.network',
        {
          workspaceId: 'workspace',
          action: 'send',
          input: {
            agentId: 'target',
            approval: { approvalId: 'approval-1', decision: 'approve' },
            clientMessageId: expect.any(String),
            deliveryIntent: 'SEND'
          }
        },
        expect.not.objectContaining({ marctlExecutionResources: expect.anything() })
      );
      expect(requestNode).toHaveBeenCalledWith(
        'node',
        'agent.network',
        {
          workspaceId: 'workspace',
          action: 'list',
          input: { scope: 'active', query: 'Review', limit: 1 }
        },
        expect.not.objectContaining({ marctlExecutionResources: expect.anything() })
      );
      expect(requestNode).toHaveBeenCalledWith(
        'node',
        'session.metadata.update',
        { sessionId: 'source', workspaceId: 'workspace', customTitle: 'reviewer#42 Updated' },
        expect.any(Object)
      );
      expect(requestNode).toHaveBeenCalledWith(
        'node',
        'session.schedule.agent.save',
        {
          sessionId: 'source',
          workspaceId: 'workspace',
          mode: 'update',
          expectedRevision: 3,
          cron: '0 8 * * *'
        },
        expect.any(Object)
      );
    } finally {
      await app.close();
    }
  });

  it('renames any authorized Session without using parent relationships or execution context', async () => {
    const { app, headers, requestNode, secrets } = await fixture();
    const result = await app.inject({
      method: 'POST',
      url: '/api/marctl/sessions',
      headers,
      payload: { action: 'rename', sessionId: 'other', title: '  reviewer#42 Review  ' }
    });
    expect(result.statusCode).toBe(200);
    expect(requestNode).toHaveBeenCalledWith(
      'node',
      'session.metadata.update',
      { sessionId: 'other', workspaceId: 'workspace', customTitle: 'reviewer#42 Review' },
      expect.any(Object)
    );
    expect(secrets.resolve).not.toHaveBeenCalled();
  });

  it('gets, sets and clears a capability-backed prompt with a minimal response', async () => {
    const { app, headers, requestNode } = await fixture(true, false);
    requestNode.mockImplementation(async (_node, operation, data) => {
      if (operation === 'session.get')
        return {
          session: {
            id: data.sessionId,
            workspaceId: 'workspace',
            runtime: { capabilities: ['session.prompt'] },
            sessionPrompt: 'Existing instructions',
            internalExecutionId: 'DO_NOT_RETURN'
          }
        };
      if (operation === 'session.metadata.update')
        return {
          session: {
            sessionPrompt: data.sessionPrompt,
            executionPayload: 'DO_NOT_RETURN'
          }
        };
      return {};
    });

    for (const [payload, expected] of [
      [
        { action: 'prompt.get', sessionId: 'target' },
        { sessionId: 'target', sessionPrompt: 'Existing instructions' }
      ],
      [
        { action: 'prompt.set', sessionId: 'target', content: 'Updated instructions' },
        { sessionId: 'target', sessionPrompt: 'Updated instructions' }
      ],
      [
        { action: 'prompt.clear', sessionId: 'target' },
        { sessionId: 'target', sessionPrompt: null }
      ]
    ] as const) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/marctl/sessions',
        headers,
        payload
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual(expected);
      expect(response.body).not.toContain('DO_NOT_RETURN');
    }
    expect(requestNode).toHaveBeenCalledWith(
      'node',
      'session.metadata.update',
      { sessionId: 'target', workspaceId: 'workspace', sessionPrompt: 'Updated instructions' },
      expect.any(Object)
    );
    expect(requestNode).toHaveBeenCalledWith(
      'node',
      'session.metadata.update',
      { sessionId: 'target', workspaceId: 'workspace', sessionPrompt: null },
      expect.any(Object)
    );
    expect(
      requestNode.mock.calls.filter(([, operation]) => operation === 'session.get')
    ).toHaveLength(3);
  });

  it('decides only approvals for a Run owned by the authorized Session', async () => {
    const { app, headers, requestNode } = await fixture(true, false, {
      session: { runtime: { capabilities: ['approval.respond'] } }
    });
    const fixtureRequest = requestNode.getMockImplementation()!;
    requestNode.mockImplementation(async (_node, operation, data) => {
      if (operation === 'session.runs')
        return {
          runs: [
            { id: 'foreign-run', sessionId: 'another-session' },
            { id: 'target-run', sessionId: 'target' }
          ]
        };
      if (operation === 'run.approval.decide')
        return {
          approval: {
            id: data.approvalId,
            status: data.decision,
            payload: 'DO_NOT_RETURN',
            internalExecutionId: 'DO_NOT_RETURN'
          }
        };
      return fixtureRequest(_node, operation, data);
    });

    const foreign = await app.inject({
      method: 'POST',
      url: '/api/marctl/sessions',
      headers,
      payload: {
        action: 'approval.decide',
        sessionId: 'target',
        runId: 'foreign-run',
        approvalId: 'approval-1',
        decision: 'APPROVED'
      }
    });
    expect(foreign.statusCode).toBe(404);
    expect(foreign.json().error.code).toBe('RUN_NOT_FOUND');
    expect(
      requestNode.mock.calls.some(([, operation]) => operation === 'run.approval.decide')
    ).toBe(false);

    for (const [decision, expected] of [
      ['APPROVED', 'APPROVED'],
      ['REJECTED', 'REJECTED']
    ] as const) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/marctl/sessions',
        headers,
        payload: {
          action: 'approval.decide',
          sessionId: 'target',
          runId: 'target-run',
          approvalId: 'approval-1',
          decision
        }
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        sessionId: 'target',
        runId: 'target-run',
        approvalId: 'approval-1',
        decision: expected
      });
      expect(response.body).not.toContain('DO_NOT_RETURN');
    }
    expect(requestNode).toHaveBeenCalledWith(
      'node',
      'session.runs',
      expect.objectContaining({ sessionId: 'target', workspaceId: 'workspace' }),
      expect.any(Object)
    );
    expect(requestNode).toHaveBeenCalledWith(
      'node',
      'run.approval.decide',
      {
        runId: 'target-run',
        approvalId: 'approval-1',
        decision: 'APPROVED',
        workspaceId: 'workspace'
      },
      expect.any(Object)
    );
  });

  it('rejects unsupported, unauthorized, foreign-Workspace and malformed prompt/approval commands', async () => {
    const unsupported = await fixture(true, false, { session: { runtime: { capabilities: [] } } });
    for (const payload of [
      { action: 'prompt.get', sessionId: 'target' },
      { action: 'prompt.set', sessionId: 'target', content: 'instructions' },
      { action: 'prompt.clear', sessionId: 'target' },
      {
        action: 'approval.decide',
        sessionId: 'target',
        runId: 'run',
        approvalId: 'approval',
        decision: 'APPROVED'
      }
    ]) {
      const response = await unsupported.app.inject({
        method: 'POST',
        url: '/api/marctl/sessions',
        headers: unsupported.headers,
        payload
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe('NODE_OPERATION_UNSUPPORTED');
    }
    expect(
      unsupported.requestNode.mock.calls.some(([, operation]) =>
        ['session.metadata.update', 'session.runs', 'run.approval.decide'].includes(operation)
      )
    ).toBe(false);

    const malformed = await fixture();
    for (const payload of [
      { action: 'prompt.set', sessionId: 'target', content: ' \t ' },
      { action: 'prompt.set', sessionId: 'target', content: 'x'.repeat(20_001) },
      { action: 'prompt.clear', sessionId: 'target', promptFile: 'role.txt' },
      {
        action: 'approval.decide',
        sessionId: 'target',
        runId: 'run',
        approvalId: 'approval',
        decision: 'approve'
      }
    ])
      expect(
        (
          await malformed.app.inject({
            method: 'POST',
            url: '/api/marctl/sessions',
            headers: malformed.headers,
            payload
          })
        ).statusCode
      ).toBe(400);
    expect(malformed.requestNode).not.toHaveBeenCalled();

    const denied = await fixture(true, false, { authorizedNode: false });
    for (const payload of [
      { action: 'prompt.get', sessionId: 'target' },
      {
        action: 'approval.decide',
        sessionId: 'target',
        runId: 'run',
        approvalId: 'approval',
        decision: 'APPROVED'
      }
    ])
      expect(
        (
          await denied.app.inject({
            method: 'POST',
            url: '/api/marctl/sessions',
            headers: denied.headers,
            payload
          })
        ).statusCode
      ).toBe(403);
    expect(denied.requestNode).not.toHaveBeenCalled();

    const foreign = await fixture(true, false, {
      session: {
        workspaceId: 'foreign',
        runtime: { capabilities: ['session.prompt', 'approval.respond'] }
      }
    });
    for (const payload of [
      { action: 'prompt.set', sessionId: 'target', content: 'instructions' },
      {
        action: 'approval.decide',
        sessionId: 'target',
        runId: 'run',
        approvalId: 'approval',
        decision: 'APPROVED'
      }
    ])
      expect(
        (
          await foreign.app.inject({
            method: 'POST',
            url: '/api/marctl/sessions',
            headers: foreign.headers,
            payload
          })
        ).statusCode
      ).toBe(403);
    expect(
      foreign.requestNode.mock.calls.filter(([, operation]) => operation === 'session.get')
    ).toHaveLength(2);
    expect(
      foreign.requestNode.mock.calls.some(([, operation]) =>
        ['session.metadata.update', 'session.runs', 'run.approval.decide'].includes(operation)
      )
    ).toBe(false);
  });

  it.each([false, true])(
    'forwards normal schedule reads and agent edits (scheduled=%s)',
    async (scheduled) => {
      const { app, headers, requestNode, secrets } = await fixture(true, scheduled);
      for (const payload of [
        { action: 'schedule.list', limit: 2 },
        { action: 'schedule.get', sessionId: 'other' },
        { action: 'schedule.create', sessionId: 'other', cron: '0 9 * * *', content: 'Check' },
        { action: 'schedule.update', sessionId: 'other', expectedRevision: 3, content: 'Review' }
      ]) {
        expect(
          (await app.inject({ method: 'POST', url: '/api/marctl/sessions', headers, payload }))
            .statusCode
        ).toBe(200);
      }
      expect(requestNode).toHaveBeenCalledWith(
        'node',
        'session.schedule.list',
        { workspaceId: 'workspace', limit: 2 },
        expect.any(Object)
      );
      expect(requestNode).toHaveBeenCalledWith(
        'node',
        'session.schedule.agent.save',
        {
          workspaceId: 'workspace',
          sessionId: 'other',
          mode: 'create',
          cron: '0 9 * * *',
          objective: 'Check'
        },
        expect.any(Object)
      );
      expect(requestNode).toHaveBeenCalledWith(
        'node',
        'session.schedule.agent.save',
        {
          workspaceId: 'workspace',
          sessionId: 'other',
          mode: 'update',
          expectedRevision: 3,
          objective: 'Review'
        },
        expect.any(Object)
      );
      expect(requestNode.mock.calls.some((call) => call[1] === 'session.schedule.save')).toBe(
        false
      );
      expect(secrets.resolve).not.toHaveBeenCalled();
    }
  );

  it.each([false, true])(
    'rejects forged schedule fields and foreign targets (scheduled=%s)',
    async (scheduled) => {
      const foreground = await fixture(true, scheduled);
      for (const extra of [{ ownerUserId: 99 }, { enabled: false }, { readonly: false }])
        expect(
          (
            await foreground.app.inject({
              method: 'POST',
              url: '/api/marctl/sessions',
              headers: foreground.headers,
              payload: {
                action: 'schedule.update',
                sessionId: 'other',
                expectedRevision: 1,
                content: 'Check',
                ...extra
              }
            })
          ).statusCode
        ).toBe(400);
      const foreign = await fixture(true, scheduled, { session: { workspaceId: 'foreign' } });
      expect(
        (
          await foreign.app.inject({
            method: 'POST',
            url: '/api/marctl/sessions',
            headers: foreign.headers,
            payload: { action: 'rename', sessionId: 'other', title: 'Changed' }
          })
        ).statusCode
      ).toBe(403);
      expect(
        (
          await foreign.app.inject({
            method: 'POST',
            url: '/api/marctl/sessions',
            headers: foreign.headers,
            payload: { action: 'schedule.get', sessionId: 'other' }
          })
        ).statusCode
      ).toBe(403);
    }
  );

  it.each(['send', 'start'] as const)(
    'relays %s with the authenticated Execution rather than a client origin',
    async (operation) => {
      const { app, headers, requestNode } = await fixture(true, true, {
        executionSource: 'source'
      });
      const input =
        operation === 'start'
          ? { content: 'task', clientMessageId: 'source-input', runner: 'codex' }
          : {
              agentId: 'target',
              content: 'task',
              clientMessageId: 'source-input',
              deliveryIntent: 'QUEUE'
            };
      const response = await app.inject({
        method: 'POST',
        url: '/api/marctl/sessions',
        headers,
        payload: { action: 'network', command: { operation, input } }
      });
      expect(response.statusCode).toBe(200);
      const network = requestNode.mock.calls.find((call) => call[1] === 'agent.network')!;
      expect(network[2]).toMatchObject({ action: operation, input });
      expect(network[2]).not.toHaveProperty('__marctlOrigin');
      expect(network[3]).toMatchObject({
        marctlCaller: { type: 'execution', sessionId: 'source', executionId: 'execution-1' }
      });
      expect(
        requestNode.mock.calls.some(
          (call) => call[1] === 'session.start' || call[1] === 'session.message'
        )
      ).toBe(false);
    }
  );

  it('marks terminal messages without inventing a Session and leaves Goal inputs unchanged', async () => {
    const { app, headers, requestNode } = await fixture();
    for (const payload of [
      {
        action: 'send',
        sessionId: 'target',
        content: 'task',
        clientMessageId: 'terminal',
        deliveryIntent: 'SEND'
      },
      { action: 'goal.set', sessionId: 'target', content: 'objective' }
    ])
      expect(
        (await app.inject({ method: 'POST', url: '/api/marctl/sessions', headers, payload }))
          .statusCode
      ).toBe(200);
    expect(requestNode.mock.calls.find(([, op]) => op === 'session.message')?.[2]).toMatchObject({
      __marctlOrigin: {}
    });
    expect(
      requestNode.mock.calls.find(([, op]) => op === 'session.command.execute')?.[2]
    ).not.toHaveProperty('__marctlOrigin');
  });

  it('routes stop by Session and rejects stale execution or run identifiers', async () => {
    const { app, headers, requestNode } = await fixture();
    const send = (input: Record<string, string>) =>
      app.inject({
        method: 'POST',
        url: '/api/marctl/sessions',
        headers,
        payload: { action: 'network', command: { operation: 'stop', input } }
      });
    expect((await send({ agentId: 'target' })).statusCode).toBe(200);
    expect(requestNode.mock.calls.filter((call) => call[1] === 'agent.network')).toHaveLength(1);
    expect(requestNode.mock.calls.find((call) => call[1] === 'agent.network')?.[2]).toMatchObject({
      action: 'stop',
      input: { agentId: 'target' }
    });
    expect((await send({ agentId: 'target', executionId: 'old' })).statusCode).toBe(400);
    expect((await send({ agentId: 'target', runId: 'old' })).statusCode).toBe(400);
    expect(requestNode.mock.calls.filter((call) => call[1] === 'agent.network')).toHaveLength(1);
  });

  it('rejects legacy writes with a claimed execution source or parent before Node dispatch', async () => {
    const { app, headers, requestNode } = await fixture(true, true, { executionSource: 'source' });
    for (const payload of [
      {
        action: 'send',
        sessionId: 'target',
        sourceSessionId: 'other',
        content: 'message',
        clientMessageId: 'one',
        deliveryIntent: 'QUEUE'
      },
      {
        action: 'start',
        runner: 'codex',
        parentSessionId: 'other',
        content: 'message',
        clientMessageId: 'two'
      }
    ]) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/marctl/sessions',
        headers,
        payload
      });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ error: { code: 'MARCTL_AGENT_NETWORK_REQUIRED' } });
    }
    expect(requestNode).not.toHaveBeenCalled();
  });

  it('does not derive a Session origin from a terminal caller’s environment claim', async () => {
    const { app, headers, requestNode } = await fixture();
    const response = await app.inject({
      method: 'POST',
      url: '/api/marctl/sessions',
      headers,
      payload: {
        action: 'send',
        sessionId: 'target',
        sourceSessionId: 'forged',
        content: 'message',
        clientMessageId: 'one',
        deliveryIntent: 'QUEUE'
      }
    });
    expect(response.statusCode).toBe(200);
    expect(
      requestNode.mock.calls.find(([, operation]) => operation === 'session.message')?.[2]
    ).toMatchObject({ __marctlOrigin: {} });
  });

  // Source title and ID projection are exercised through the Node network owner.

  it('rejects foreign or missing execution sources on the retired write route', async () => {
    const { app, credentials, scope, requestNode } = await fixture();
    requestNode.mockImplementation(async (_node, operation, data) => {
      if (operation === 'session.cli.context')
        return { workspace: { id: 'workspace', path: '/fixture' } };
      if (operation === 'session.get') {
        if (data.sessionId === 'missing') throw new Error('SESSION_NOT_FOUND');
        return {
          session: {
            id: data.sessionId,
            workspaceId: data.sessionId === 'foreign' ? 'other' : 'workspace',
            runner: 'codex'
          }
        };
      }
      return {};
    });
    for (const sourceSessionId of ['foreign', 'missing']) {
      const token = credentials.issue({ userId: 7 }, scope, {
        type: 'execution',
        sessionId: sourceSessionId,
        executionId: 'execution-1'
      });
      const response = await app.inject({
        method: 'POST',
        url: '/api/marctl/sessions',
        headers: { authorization: `Bearer ${token}` },
        payload: {
          action: 'send',
          sessionId: 'target',
          content: 'task',
          clientMessageId: 'blocked',
          deliveryIntent: 'QUEUE',
          sourceSessionId
        }
      });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ error: { code: 'MARCTL_AGENT_NETWORK_REQUIRED' } });
    }
    expect(requestNode.mock.calls.some(([, op]) => op === 'session.message')).toBe(false);
  });

  it('rejects send without an explicit delivery intent before contacting Node', async () => {
    const { app, headers, requestNode } = await fixture();
    const result = await app.inject({
      method: 'POST',
      url: '/api/marctl/sessions',
      headers,
      payload: { action: 'send', sessionId: 'target', content: 'notice', clientMessageId: 'input' }
    });
    expect(result.statusCode).toBe(400);
    expect(result.json().error.code).toBe('MARCTL_SESSION_INPUT_INVALID');
    expect(requestNode).not.toHaveBeenCalled();
  });
  it.each(['QUEUE', 'REPLACE_CURRENT', 'SEND'] as const)(
    'forwards explicit transport intents without a default (%s)',
    async (deliveryIntent) => {
      const { app, headers, requestNode } = await fixture();
      const result = await app.inject({
        method: 'POST',
        url: '/api/marctl/sessions',
        headers,
        payload: {
          action: 'send',
          sessionId: 'target',
          content: 'notice',
          clientMessageId: 'input',
          deliveryIntent
        }
      });
      expect(result.statusCode).toBe(200);
      expect(requestNode).toHaveBeenCalledWith(
        'node',
        'session.message',
        expect.objectContaining({
          sessionId: 'target',
          deliveryIntent
        }),
        expect.any(Object)
      );
    }
  );
  it.each([{ modelId: 'next-model' }, { effort: 'high' }, { modelId: 'next-model', effort: '' }])(
    'forwards partial configuration without changing omitted fields: %j',
    async (configuration) => {
      const { app, headers, requestNode, secrets, instructions } = await fixture();
      const response = await app.inject({
        method: 'POST',
        url: '/api/marctl/sessions',
        headers,
        payload: { action: 'config', sessionId: 'target', ...configuration }
      });
      expect(response.statusCode).toBe(200);
      expect(requestNode).toHaveBeenCalledWith(
        'node',
        'session.config.update',
        { workspaceId: 'workspace', sessionId: 'target', ...configuration },
        expect.any(Object)
      );
      expect(secrets.resolve).not.toHaveBeenCalled();
      expect(instructions.get).not.toHaveBeenCalled();
    }
  );

  it('rejects empty, oversized and permission-changing configuration and foreign targets', async () => {
    const local = await fixture();
    for (const extra of [
      {},
      { model: 'old' },
      { modelId: 'next', model: 'old' },
      { modelId: '' },
      { effort: 'x'.repeat(121) },
      { modelId: 'x'.repeat(121) },
      { modelId: 'next', access: 'full-access' }
    ]) {
      const response = await local.app.inject({
        method: 'POST',
        url: '/api/marctl/sessions',
        headers: local.headers,
        payload: { action: 'config', sessionId: 'target', ...extra }
      });
      expect(response.statusCode).toBe(400);
    }
    const foreign = await fixture(true, true, { session: { workspaceId: 'foreign' } });
    const response = await foreign.app.inject({
      method: 'POST',
      url: '/api/marctl/sessions',
      headers: foreign.headers,
      payload: { action: 'config', sessionId: 'target', modelId: 'next' }
    });
    expect(response.statusCode).toBe(403);
    expect(
      foreign.requestNode.mock.calls.some(([, operation]) => operation === 'session.config.update')
    ).toBe(false);
  });
  it.each(['start', 'send', 'goal.set'] as const)(
    'marks %s dispatches for automatic notification suppression',
    async (action) => {
      const { app, headers, requestNode } = await fixture();
      const result = await app.inject({
        method: 'POST',
        url: '/api/marctl/sessions',
        headers,
        payload: {
          action,
          content: 'delegated task',
          ...(action === 'start' ? { runner: 'codex' } : { sessionId: 'session-1' }),
          ...(action === 'goal.set' ? {} : { clientMessageId: 'marctl-input' }),
          ...(action === 'send' ? { deliveryIntent: 'QUEUE' } : {})
        }
      });
      expect(result.statusCode).toBe(200);
      expect(requestNode).toHaveBeenCalledWith(
        'node',
        action === 'start'
          ? 'session.start'
          : action === 'send'
            ? 'session.message'
            : 'session.command.execute',
        expect.objectContaining({ __suppressNotifications: true }),
        expect.any(Object)
      );
    }
  );

  it('relays only the compact response envelope without show fan-out or internal metadata', async () => {
    const { app, headers, requestNode } = await fixture();
    const session = {
      id: 's',
      title: 'Fixer',
      runner: 'codex',
      status: 'IDLE',
      runId: null,
      modelId: null,
      effort: null,
      queuedCount: 0,
      latestMessage: null,
      recentTools: []
    };
    requestNode.mockImplementation(async (_node, operation) => {
      if (operation === 'session.cli.context')
        return { workspace: { id: 'workspace', path: '/fixture' } };
      if (operation === 'session.get')
        return { view: 'marctl', workspaceId: 'workspace', session, secret: 'DO_NOT_INCLUDE' };
      if (operation === 'session.list')
        return { view: 'marctl', sessions: [], nextCursor: null, secret: 'DO_NOT_INCLUDE' };
      throw new Error('Unexpected fan-out: ' + operation);
    });
    for (const action of ['show', 'list']) {
      requestNode.mockClear();
      const result = await app.inject({
        method: 'POST',
        url: '/api/marctl/sessions',
        headers,
        payload: { action, ...(action === 'show' ? { sessionId: 's' } : {}) }
      });
      expect(result.statusCode).toBe(200);
      expect(result.json()).toEqual(
        action === 'show' ? { session } : { sessions: [], nextCursor: null }
      );
      expect(requestNode.mock.calls.map((call) => call[1])).toEqual([
        'session.cli.context',
        action === 'show' ? 'session.get' : 'session.list'
      ]);
      expect(requestNode.mock.calls[1]![2]).toMatchObject({
        view: 'marctl',
        workspaceId: 'workspace',
        registeredOnly: true
      });
    }
  });

  it.each(['show', 'list'])(
    'rejects an old Node that ignores the compact view for %s',
    async (action) => {
      const { app, headers, requestNode } = await fixture();
      requestNode.mockImplementation(async (_node, operation) =>
        operation === 'session.cli.context'
          ? { workspace: { id: 'workspace', path: '/fixture' } }
          : {
              session: { id: 's', workspaceId: 'workspace', control: 'DO_NOT_INCLUDE' },
              sessions: [],
              secret: 'DO_NOT_INCLUDE'
            }
      );
      const result = await app.inject({
        method: 'POST',
        url: '/api/marctl/sessions',
        headers,
        payload: { action, ...(action === 'show' ? { sessionId: 's' } : {}) }
      });
      expect(result.statusCode).toBe(409);
      expect(result.json().error.code).toBe('CAPABILITY_VERSION_UNSUPPORTED');
      expect(result.body).not.toContain('DO_NOT_INCLUDE');
    }
  );

  it.each([undefined, 'other'])(
    'checks only the compact show envelope workspace (%s)',
    async (workspaceId) => {
      const { app, headers, requestNode } = await fixture();
      requestNode.mockImplementation(async (_node, operation) =>
        operation === 'session.cli.context'
          ? { workspace: { id: 'workspace', path: '/fixture' } }
          : { view: 'marctl', workspaceId, session: { id: 's', workspaceId: 'workspace' } }
      );
      const result = await app.inject({
        method: 'POST',
        url: '/api/marctl/sessions',
        headers,
        payload: { action: 'show', sessionId: 's' }
      });
      expect(result.statusCode).toBe(403);
      expect(result.json().error.code).toBe('RESOURCE_ACCESS_DENIED');
    }
  );

  it('forces Node-local lookup for CLI lists, title searches and Session identity reads', async () => {
    const { app, headers, requestNode } = await fixture();
    for (const payload of [
      { action: 'list', query: 'fixer#42' },
      { action: 'show', sessionId: 'session-1' },
      { action: 'current' }
    ]) {
      const result = await app.inject({
        method: 'POST',
        url: '/api/marctl/sessions',
        headers,
        payload
      });
      expect(result.statusCode).toBe(200);
    }
    const reads = requestNode.mock.calls.filter((call) =>
      ['session.cli.context', 'session.get', 'session.list'].includes(call[1])
    );
    expect(reads.length).toBeGreaterThan(3);
    for (const call of reads)
      expect(call[2]).toMatchObject({ workspaceId: 'workspace', registeredOnly: true });
    expect(reads.find((call) => call[1] === 'session.list')?.[2]).toMatchObject({
      query: 'fixer#42'
    });
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/marctl/sessions',
          headers,
          payload: { action: 'list', registeredOnly: false }
        })
      ).statusCode
    ).toBe(400);
  });

  it('forwards creation parents and scoped local graph queries', async () => {
    const linked = await fixture();
    const invoke = (payload: object) =>
      linked.app.inject({
        method: 'POST',
        url: '/api/marctl/sessions',
        headers: linked.headers,
        payload
      });
    expect(
      (
        await invoke({
          action: 'start',
          runner: 'codex',
          content: 'task',
          clientMessageId: 'parent-input',
          parentSessionId: 'source'
        })
      ).statusCode
    ).toBe(200);
    expect(linked.requestNode).toHaveBeenCalledWith(
      'node',
      'session.start',
      expect.objectContaining({ workspaceId: 'workspace', parentSessionId: 'source' }),
      expect.objectContaining({ workspaceId: 'workspace' })
    );
    expect((await invoke({ action: 'list', parentSessionId: 'source', limit: 1 })).statusCode).toBe(
      200
    );
    expect(linked.requestNode).toHaveBeenCalledWith(
      'node',
      'session.list',
      expect.objectContaining({
        workspaceId: 'workspace',
        registeredOnly: true,
        parentSessionId: 'source',
        limit: 1
      }),
      expect.any(Object)
    );
    expect((await invoke({ action: 'graph', sessionId: 'source' })).statusCode).toBe(200);
    expect(linked.requestNode).toHaveBeenCalledWith(
      'node',
      'session.graph',
      { workspaceId: 'workspace', registeredOnly: true, sessionId: 'source', limit: 100 },
      expect.any(Object)
    );
    expect((await invoke({ action: 'graph', sessionId: 'source', limit: 101 })).statusCode).toBe(
      400
    );
    const foreign = await fixture(true, true, { session: { workspaceId: 'foreign' } });
    expect(
      (
        await foreign.app.inject({
          method: 'POST',
          url: '/api/marctl/sessions',
          headers: foreign.headers,
          payload: { action: 'graph', sessionId: 'source' }
        })
      ).statusCode
    ).toBe(403);
    expect(
      foreign.requestNode.mock.calls.some(([, operation]) => operation === 'session.graph')
    ).toBe(false);
  });

  it('rejects missing context and target overrides before forwarding', async () => {
    const { app, headers, requestNode } = await fixture(false);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/marctl/sessions',
          headers,
          payload: { action: 'list' }
        })
      ).statusCode
    ).toBe(403);
    expect(requestNode).not.toHaveBeenCalled();
    const deniedNode = await fixture(true, true, { authorizedNode: false });
    expect(
      (
        await deniedNode.app.inject({
          method: 'POST',
          url: '/api/marctl/sessions',
          headers: deniedNode.headers,
          payload: { action: 'current' }
        })
      ).statusCode
    ).toBe(403);
    expect(deniedNode.requestNode).not.toHaveBeenCalled();
    const scoped = await fixture();
    const invalidOverrides = [
      { action: 'current', nodeId: 'other' },
      { action: 'list', workspaceId: 'other' },
      { action: 'history', sessionId: 'session', cursor: 'opaque-cursor', workspaceId: 'other' },
      {
        action: 'send',
        sessionId: 'session',
        content: 'message',
        clientMessageId: 'message-1',
        deliveryIntent: 'QUEUE',
        nodeId: 'other'
      },
      {
        action: 'watch',
        sessionId: 'session',
        workbenchConnectionId: 'connection-owned',
        watchId: 'watch-12345678',
        mode: 'initial',
        operation: 'session.unwatch'
      }
    ];
    for (const payload of invalidOverrides) {
      expect(
        (
          await scoped.app.inject({
            method: 'POST',
            url: '/api/marctl/sessions',
            headers: scoped.headers,
            payload
          })
        ).statusCode
      ).toBe(400);
    }
    expect(scoped.requestNode).not.toHaveBeenCalled();
  });

  it('keeps current, list and history cursors inside the authenticated Node/Workspace scope', async () => {
    const { app, headers, requestNode } = await fixture();
    const cursorError = Object.assign(new Error('SESSION_CURSOR_INVALID'), {
      code: 'SESSION_CURSOR_INVALID'
    });
    requestNode.mockImplementation(async (_node, operation, data) => {
      if (operation === 'session.cli.context')
        return { workspace: { id: 'workspace', path: '/fixture' }, session: null, run: null };
      if (operation === 'session.get')
        return {
          session: {
            id: data.sessionId,
            workspaceId: 'workspace',
            runner: 'codex',
            modelId: 'test-model'
          }
        };
      if (
        (operation === 'session.list' || operation === 'session.turns.list') &&
        data.cursor === 'foreign-workspace-cursor'
      )
        throw cursorError;
      return { accepted: true };
    });

    const current = await app.inject({
      method: 'POST',
      url: '/api/marctl/sessions',
      headers,
      payload: { action: 'current' }
    });
    expect(current.statusCode).toBe(200);
    expect(current.json()).toMatchObject({
      nodeId: 'node',
      workspaceId: 'workspace',
      workspace: { id: 'workspace' }
    });
    const currentCall = requestNode.mock.calls.find((call) => call[1] === 'session.cli.context');
    expect(currentCall?.[0]).toBe('node');
    expect(currentCall?.[2]).toMatchObject({ workspaceId: 'workspace' });

    const listing = await app.inject({
      method: 'POST',
      url: '/api/marctl/sessions',
      headers,
      payload: { action: 'list', cursor: 'foreign-workspace-cursor' }
    });
    expect(listing.statusCode).not.toBe(200);
    const listCall = requestNode.mock.calls.find((call) => call[1] === 'session.list');
    expect(listCall?.[0]).toBe('node');
    expect(listCall?.[2]).toEqual({
      view: 'marctl',
      cursor: 'foreign-workspace-cursor',
      limit: 20,
      workspaceId: 'workspace',
      registeredOnly: true
    });

    const history = await app.inject({
      method: 'POST',
      url: '/api/marctl/sessions',
      headers,
      payload: { action: 'history', sessionId: 'session-1', cursor: 'foreign-workspace-cursor' }
    });
    expect(history.statusCode).not.toBe(200);
    const historyCall = requestNode.mock.calls.find((call) => call[1] === 'session.turns.list');
    expect(historyCall?.[0]).toBe('node');
    expect(historyCall?.[2]).toEqual({
      sessionId: 'session-1',
      unit: 'SEGMENT',
      cursor: 'foreign-workspace-cursor',
      limit: 10,
      workspaceId: 'workspace',
      registeredOnly: true
    });
  });

  it('creates a new same-Workspace Session with independent credentials and scheduled provenance', async () => {
    const { app, headers, credentials, requestNode, secrets, instructions } = await fixture(
      true,
      true,
      {
        profiles: {
          profiles: [
            { runner: 'codex', models: [{ id: 'codex-profile-default', isDefault: true }] },
            { runner: 'claude-code', models: [{ id: 'other-runner-default', isDefault: true }] }
          ],
          defaults: [
            { runner: 'codex', modelId: 'codex-workspace-default' },
            { runner: 'claude-code', modelId: 'claude-workspace-default' }
          ]
        }
      }
    );
    const titles = ['fixer#17 Add importer retries', 'reviewer#17 Review importer retries'];
    const responseBodies: string[] = [];
    for (const [index, title] of titles.entries()) {
      const result = await app.inject({
        method: 'POST',
        url: '/api/marctl/sessions',
        headers,
        payload: {
          action: 'start',
          runner: 'codex',
          content: 'Develop fixture',
          clientMessageId: `message-${index + 1}`,
          effort: 'high',
          title
        }
      });
      expect(result.statusCode).toBe(200);
      expect(result.json()).toMatchObject({
        session: { id: 'native-new' },
        run: { id: 'new-run' }
      });
      responseBodies.push(result.body);
    }
    const starts = requestNode.mock.calls.filter((call) => call[1] === 'session.start');
    expect(starts.map((call) => call[2].customTitle)).toEqual(titles);
    const start = starts[0]!;
    expect(start[0]).toBe('node');
    expect(start[2]).toMatchObject({
      workspaceId: 'workspace',
      cwd: '/fixture',
      runner: 'codex',
      content: 'Develop fixture',
      modelId: 'codex-workspace-default',
      effort: 'high',
      customTitle: 'fixer#17 Add importer retries',
      personalInstructions: { common: 'Account rule' }
    });
    const environment = start[2].secretEnvironment as Record<string, string>;
    expect(environment.MAR_CTL_USER_TOKEN).not.toBe(headers.authorization.slice(7));
    expect(
      await credentials.authenticateContext('Bearer ' + environment.MAR_CTL_USER_TOKEN)
    ).toMatchObject({ scheduled: true, scope: { nodeId: 'node', workspaceId: 'workspace' } });
    expect(secrets.resolve).toHaveBeenCalledWith(7, 'node', 'workspace');
    expect(instructions.get).toHaveBeenCalledWith(7);
    expect(responseBodies.join('\n')).not.toContain('not-public');
    expect(responseBodies.join('\n')).not.toContain(environment.MAR_CTL_USER_TOKEN);
  });

  it('preserves channel identity when preparing a marctl message credential', async () => {
    const { app, headers, credentials, requestNode } = await fixture(true, false, {
      channel: true
    });
    const response = await app.inject({
      method: 'POST',
      url: '/api/marctl/sessions',
      headers,
      payload: {
        action: 'send',
        sessionId: 'target',
        content: 'channel message',
        clientMessageId: 'channel-input',
        deliveryIntent: 'SEND'
      }
    });

    expect(response.statusCode).toBe(200);
    const message = requestNode.mock.calls.find(([, operation]) => operation === 'session.message');
    const environment = message?.[2].secretEnvironment as Record<string, string> | undefined;
    expect(environment?.MAR_CTL_USER_TOKEN).toBeDefined();
    expect(
      await credentials.authenticateContext('Bearer ' + environment?.MAR_CTL_USER_TOKEN)
    ).toMatchObject({
      scheduled: false,
      channel: true,
      scope: { nodeId: 'node', workspaceId: 'workspace' }
    });
  });

  it('prepares MAR Agent models with new or target Session scope for start, send and goal.set', async () => {
    const prepare = vi.fn(async (input: { readonly selectedModelId: string }) => ({
      runtimeScopeId: `runtime-${input.selectedModelId}`,
      models: []
    }));
    const { app, headers, requestNode } = await fixture(true, true, {
      session: { runner: 'mar-agent', modelId: 'target-session-model' },
      profiles: {
        profiles: [{ runner: 'mar-agent', models: [{ id: 'profile-model', isDefault: true }] }],
        defaults: [{ runner: 'mar-agent', modelId: 'workspace-default-model' }]
      },
      marAgentRuntimeModels: { prepare }
    });

    const start = await app.inject({
      method: 'POST',
      url: '/api/marctl/sessions',
      headers,
      payload: {
        action: 'start',
        runner: 'mar-agent',
        content: 'start task',
        clientMessageId: 'start-input'
      }
    });
    const send = await app.inject({
      method: 'POST',
      url: '/api/marctl/sessions',
      headers,
      payload: {
        action: 'send',
        sessionId: 'target',
        content: 'continue task',
        clientMessageId: 'send-input',
        deliveryIntent: 'QUEUE'
      }
    });
    const goal = await app.inject({
      method: 'POST',
      url: '/api/marctl/sessions',
      headers,
      payload: { action: 'goal.set', sessionId: 'target', content: 'new objective' }
    });

    expect([start.statusCode, send.statusCode, goal.statusCode]).toEqual([200, 200, 200]);
    expect(prepare).toHaveBeenNthCalledWith(1, {
      userId: 7,
      nodeId: 'node',
      workspaceId: 'workspace',
      selectedModelId: 'workspace-default-model'
    });
    for (const callNumber of [2, 3])
      expect(prepare).toHaveBeenNthCalledWith(callNumber, {
        userId: 7,
        nodeId: 'node',
        workspaceId: 'workspace',
        sessionId: 'target',
        selectedModelId: 'target-session-model'
      });

    expect(
      requestNode.mock.calls.find(([, operation]) => operation === 'session.start')?.[2]
    ).toMatchObject({
      modelId: 'workspace-default-model',
      marAgentRuntimeScopeId: 'runtime-workspace-default-model'
    });
    expect(
      requestNode.mock.calls.find(([, operation]) => operation === 'session.message')?.[2]
    ).toMatchObject({
      sessionId: 'target',
      deliveryIntent: 'QUEUE',
      marAgentRuntimeScopeId: 'runtime-target-session-model'
    });
    expect(
      requestNode.mock.calls.find(([, operation]) => operation === 'session.command.execute')?.[2]
    ).toMatchObject({
      sessionId: 'target',
      commandId: 'goal',
      input: '/goal new objective',
      marAgentRuntimeScopeId: 'runtime-target-session-model'
    });
  });

  it('does not prepare a MAR runtime model for a non-MAR Session continuation', async () => {
    const prepare = vi.fn(async () => ({ runtimeScopeId: 'unexpected-scope', models: [] }));
    const { app, headers, requestNode } = await fixture(true, true, {
      session: { runner: 'codex', modelId: 'codex-session-model' },
      marAgentRuntimeModels: { prepare }
    });
    const response = await app.inject({
      method: 'POST',
      url: '/api/marctl/sessions',
      headers,
      payload: {
        action: 'send',
        sessionId: 'target',
        content: 'continue task',
        clientMessageId: 'codex-input',
        deliveryIntent: 'SEND'
      }
    });

    expect(response.statusCode).toBe(200);
    expect(prepare).not.toHaveBeenCalled();
    const message = requestNode.mock.calls.find(
      ([, operation]) => operation === 'session.message'
    )?.[2];
    expect(message).not.toHaveProperty('marAgentRuntimeScopeId');
    expect(message).not.toHaveProperty('marAgentModel');
    expect(message).not.toHaveProperty('marAgentModels');
  });

  it('relays a terminal idempotent message receipt through marctl unchanged', async () => {
    const { app, headers, requestNode } = await fixture();
    const original = requestNode.getMockImplementation()!;
    const receipt = {
      session: { id: 'target' },
      run: { id: 'original-run', status: 'FAILED' },
      delivery: 'STARTED',
      idempotent: true
    };
    requestNode.mockImplementation(async (...args) =>
      args[1] === 'session.message' ? receipt : original(...args)
    );
    const response = await app.inject({
      method: 'POST',
      url: '/api/marctl/sessions',
      headers,
      payload: {
        action: 'send',
        sessionId: 'target',
        clientMessageId: 'original-message',
        content: 'Retry',
        deliveryIntent: 'SEND'
      }
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject(receipt);
  });

  it('forwards Node-issued accepted receipts through the marctl audit observer once', async () => {
    const recordSharedConversation = vi.fn().mockResolvedValue(undefined);
    const { app, headers, requestNode } = await fixture(true, true, {
      audits: { recordSharedConversation }
    });
    const originalRequestNode = requestNode.getMockImplementation()!;
    requestNode.mockImplementation(async (...args) => {
      const result = await originalRequestNode(...args);
      const receipt =
        args[1] === 'session.start'
          ? { sessionId: 'created-session', inputMode: 'NEW_SESSION' }
          : args[1] === 'session.message'
            ? { sessionId: 'target', inputMode: 'QUEUE' }
            : undefined;
      return receipt === undefined
        ? result
        : {
            ...(result !== null && typeof result === 'object' ? result : {}),
            auditReceipt: receipt
          };
    });

    const start = await app.inject({
      method: 'POST',
      url: '/api/marctl/sessions',
      headers,
      payload: {
        action: 'start',
        runner: 'codex',
        content: 'audited start',
        clientMessageId: 'audited-start'
      }
    });
    expect(start.statusCode).toBe(200);
    await vi.waitFor(() => expect(recordSharedConversation).toHaveBeenCalledTimes(1));
    const send = await app.inject({
      method: 'POST',
      url: '/api/marctl/sessions',
      headers,
      payload: {
        action: 'send',
        sessionId: 'target',
        content: 'audited send',
        clientMessageId: 'audited-send',
        deliveryIntent: 'QUEUE'
      }
    });
    expect(send.statusCode).toBe(200);
    await vi.waitFor(() => expect(recordSharedConversation).toHaveBeenCalledTimes(2));

    expect(recordSharedConversation.mock.calls.map(([event]) => event)).toMatchObject([
      {
        eventType: 'shared_conversation_input_accepted',
        actorUserId: 7,
        nodeId: 'node',
        workspaceId: 'workspace',
        clientMessageId: 'audited-start',
        userMessage: 'audited start',
        receipt: { sessionId: 'created-session', inputMode: 'NEW_SESSION' }
      },
      {
        eventType: 'shared_conversation_input_accepted',
        actorUserId: 7,
        nodeId: 'node',
        workspaceId: 'workspace',
        clientMessageId: 'audited-send',
        userMessage: 'audited send',
        receipt: { sessionId: 'target', inputMode: 'QUEUE' }
      }
    ]);
  });

  it('rejects attachment inputs on legacy and Agent Network routes before forwarding', async () => {
    const { app, headers, requestNode } = await fixture();
    for (const network of [false, true]) {
      for (const action of ['start', 'send']) {
        for (const attachment of [
          { attachments: [{ name: 'image.png', mime: 'image/png', dataBase64: 'aW1hZ2U=' }] },
          { attachments: [] },
          { attachments: [{ name: 42, mime: 'text/plain' }] },
          { attachmentIds: ['existing-image'] },
          { attachmentIds: [] }
        ]) {
          const input = {
            content: 'A valid text message does not make attachments acceptable',
            clientMessageId: 'invalid',
            ...(action === 'start'
              ? { runner: 'codex' }
              : network
                ? { agentId: 'target' }
                : { sessionId: 'target', deliveryIntent: 'QUEUE' }),
            ...attachment
          };
          const result = await app.inject({
            method: 'POST',
            url: '/api/marctl/sessions',
            headers,
            payload: network
              ? { action: 'network', command: { operation: action, input } }
              : { action, ...input }
          });
          expect(result.statusCode).toBe(400);
        }
      }
    }
    expect(requestNode).not.toHaveBeenCalled();
  });

  it('never interprets goal.set content as a destructive Goal command', async () => {
    const { app, headers, requestNode } = await fixture();
    for (const content of ['--clear', '  --clear  ']) {
      const result = await app.inject({
        method: 'POST',
        url: '/api/marctl/sessions',
        headers,
        payload: { action: 'goal.set', sessionId: 'target', content }
      });
      expect(result.statusCode).toBe(400);
      expect(result.json().error.code).toBe('MARCTL_SESSION_INPUT_INVALID');
    }
    expect(requestNode).not.toHaveBeenCalled();
  });

  it('refuses a known other-Workspace identity even if the current user could otherwise access it', async () => {
    const { app, headers, requestNode } = await fixture();
    requestNode.mockImplementation(async (_node, operation, data) =>
      operation === 'session.cli.context'
        ? { workspace: { id: 'workspace', path: '/fixture' } }
        : {
            ...(data.view === 'marctl' ? { view: 'marctl', workspaceId: 'other' } : {}),
            session: { id: 'foreign', workspaceId: 'other', runner: 'codex' }
          }
    );
    const actions = [
      { action: 'show' },
      { action: 'history', cursor: 'foreign-cursor' },
      {
        action: 'send',
        clientMessageId: 'message',
        content: 'Do not execute',
        deliveryIntent: 'QUEUE'
      },
      { action: 'stop', runId: 'foreign-run' },
      { action: 'goal.get' },
      { action: 'goal.set', content: 'Do not set a goal' },
      { action: 'goal.clear' },
      {
        action: 'watch',
        workbenchConnectionId: 'connection-owned',
        watchId: 'watch-12345678',
        mode: 'initial'
      }
    ];
    for (const action of actions) {
      const payload = { ...action, sessionId: 'foreign' };
      expect(
        (await app.inject({ method: 'POST', url: '/api/marctl/sessions', headers, payload }))
          .statusCode
      ).toBe(403);
    }
    expect(
      requestNode.mock.calls.every((call) =>
        ['session.cli.context', 'session.get'].includes(call[1])
      )
    ).toBe(true);
  });

  it('cancels only the requested Run when it belongs to the target Session', async () => {
    const { app, headers, requestNode } = await fixture();
    requestNode.mockImplementation(async (_node, operation, data) => {
      if (operation === 'session.cli.context')
        return { workspace: { id: 'workspace', path: '/fixture' }, session: null, run: null };
      if (operation === 'session.get')
        return {
          session: {
            id: data.sessionId,
            workspaceId: 'workspace',
            runner: 'codex',
            modelId: 'test-model'
          }
        };
      if (operation === 'session.runs')
        return {
          runs: [
            { id: 'foreign-run', sessionId: 'another-session', status: 'RUNNING' },
            { id: 'target-run', sessionId: 'target-session', status: 'RUNNING' }
          ]
        };
      if (operation === 'run.cancel') return { cancelled: true, runId: data.runId };
      return { accepted: true };
    });

    const foreign = await app.inject({
      method: 'POST',
      url: '/api/marctl/sessions',
      headers,
      payload: { action: 'stop', sessionId: 'target-session', runId: 'foreign-run' }
    });
    expect(foreign.statusCode).toBe(404);
    expect(foreign.json()).toMatchObject({ error: { code: 'RUN_NOT_FOUND' } });
    expect(requestNode.mock.calls.some((call) => call[1] === 'run.cancel')).toBe(false);

    const target = await app.inject({
      method: 'POST',
      url: '/api/marctl/sessions',
      headers,
      payload: { action: 'stop', sessionId: 'target-session', runId: 'target-run' }
    });
    expect(target.statusCode).toBe(200);
    const cancel = requestNode.mock.calls.find((call) => call[1] === 'run.cancel');
    expect(cancel?.[0]).toBe('node');
    expect(cancel?.[2]).toEqual({ runId: 'target-run', workspaceId: 'workspace' });
  });

  it('requires the authenticated user to own the Workbench connection and pins watch calls to its Workspace', async () => {
    const payload = {
      action: 'watch',
      sessionId: 'session-1',
      workbenchConnectionId: 'connection-owned',
      watchId: 'watch-12345678',
      mode: 'initial'
    };
    const denied = await fixture(true, false, { ownsConnection: false });
    const rejected = await denied.app.inject({
      method: 'POST',
      url: '/api/marctl/sessions',
      headers: denied.headers,
      payload
    });
    expect(rejected.statusCode).toBe(403);
    expect(denied.ownsWorkbenchConnection).toHaveBeenCalledWith('a'.repeat(43), 'connection-owned');
    expect(
      denied.requestNode.mock.calls.some((call) =>
        ['session.watch', 'session.unwatch'].includes(call[1])
      )
    ).toBe(false);

    const owned = await fixture(true, false, { ownsConnection: true });
    for (const mode of ['initial', 'renew', 'stop'] as const) {
      const response = await owned.app.inject({
        method: 'POST',
        url: '/api/marctl/sessions',
        headers: owned.headers,
        payload: { ...payload, mode }
      });
      expect(response.statusCode).toBe(200);
    }
    const watch = owned.requestNode.mock.calls.find((call) => call[1] === 'session.watch');
    expect(watch?.[0]).toBe('node');
    expect(watch?.[2]).toEqual({
      sessionId: 'session-1',
      workbenchConnectionId: 'connection-owned',
      watchId: 'watch-12345678',
      mode: 'initial',
      unit: 'SEGMENT',
      workspaceId: 'workspace'
    });
    const unwatch = owned.requestNode.mock.calls.find((call) => call[1] === 'session.unwatch');
    expect(unwatch?.[2]).toEqual({
      sessionId: 'session-1',
      workbenchConnectionId: 'connection-owned',
      watchId: 'watch-12345678',
      workspaceId: 'workspace'
    });
  });

  it('allows goal.clear on a Session without an effective model', async () => {
    const { app, headers, requestNode } = await fixture(true, true, {
      session: { id: 'model-less-agent', runner: 'mar-agent', modelId: null }
    });
    const response = await app.inject({
      method: 'POST',
      url: '/api/marctl/sessions',
      headers,
      payload: { action: 'goal.clear', sessionId: 'model-less-agent' }
    });

    expect(response.statusCode).toBe(200);
    const command = requestNode.mock.calls.find((call) => call[1] === 'session.command.execute');
    expect(command?.[2]).toMatchObject({
      sessionId: 'model-less-agent',
      commandId: 'goal',
      input: '/goal --clear',
      workspaceId: 'workspace'
    });
  });
});
