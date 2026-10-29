import Fastify from '../../ee/server/node_modules/fastify/fastify.js';
import type { FastifyReply } from '../../ee/server/node_modules/fastify/fastify.js';
import { hashOpaque } from '../../ee/server/src/database.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerPromptCompletionRoutes } from '../../packages/server-core/src/prompt-completion-routes.js';
import { PromptCompletionClientService } from '../../packages/web-core/src/service/prompt-completion-client-service.js';
import { PromptCompletionNodeService } from '../../mar-node/src/service/prompt-completion-node-service.js';
import { MarAgentRuntimeModelFactory } from '../../mar-node/src/runner/mar-agent/runtime-model-factory.js';
import type { PromptCompletionTarget, RunnerName } from '../../packages/protocol/src/index.js';

const csrfToken = 'prompt-completion-csrf';
const publicOrigin = 'http://localhost';
const csrfTokenHash = hashOpaque(csrfToken);
const activeApps: Array<ReturnType<typeof Fastify>> = [];

afterEach(async () => {
  await Promise.all(activeApps.splice(0).map((app) => app.close()));
});

describe('Server prompt completion routes', () => {
  it.each(
    (['mar-agent', 'codex', 'claude-code', 'opencode'] as const).flatMap((mode) =>
      (['MANUAL', 'AUTO'] as const).map((trigger) => ({ mode, trigger }))
    )
  )(
    'carries $mode $trigger editor input through the real client, HTTP relay and Node lifecycle',
    async ({ mode, trigger }) => {
      const draft = trigger === 'AUTO' ? '' : 'Check now';
      const cursor = trigger === 'AUTO' ? 0 : 5;
      const f = fixture();
      const release = vi.fn();
      const generate = vi.fn(async () => ({ suggestion: ' compatibility' }));
      const references = vi.fn(async () =>
        trigger === 'AUTO'
          ? [
              {
                sessionId: 'reference',
                id: 'user-message',
                revision: 1,
                text: 'Check the interface compatibility'
              }
            ]
          : []
      );
      const node = new PromptCompletionNodeService({
        generation: () => 'generation',
        observed: () => true,
        readPage: async () => [],
        references,
        generate,
        modelFactory: new MarAgentRuntimeModelFactory({ resolve: vi.fn() }),
        usage: { completion: vi.fn(() => ({ release })) }
      });
      const forward = async (_nodeId: string, operation: string, data: unknown) => {
        const handler = node.operations()[operation];
        if (!handler) throw new Error('Unexpected operation');
        return handler({
          ...(data as object),
          __requestUserId: 7,
          __workspaceWatchSessionHash: 'member-session-hash',
          __usageGrant: { scopeId: '11111111-1111-4111-8111-111111111111', token: 'fake-grant' }
        });
      };
      f.nodeControl.requestNode.mockImplementation(forward);
      const client = new PromptCompletionClientService({
        connectionId: () => 'connection-1',
        request: async <T>(path: string, init?: RequestInit) => {
          const result = await f.app.inject({
            method: 'POST',
            url: path,
            headers: memberHeaders(),
            payload: JSON.parse(init!.body as string)
          });
          expect(result.statusCode, result.body).toBe(200);
          expect(result.headers['cache-control']).toBe('private, no-store');
          return result.json<T>();
        }
      });
      const target: PromptCompletionTarget = { kind: 'WORKSPACE', workspaceId: 'workspace-1' };
      const binding = client.bind({
        enabled: () => true,
        target: () => ({
          nodeId: 'node-1',
          target,
          runner: mode as RunnerName,
          sessionId: null
        })
      });
      try {
        const result = await binding.value.request(
          { text: draft, cursor },
          new AbortController().signal,
          undefined,
          trigger
        );
        expect(result).toMatchObject({
          status: 'ready',
          suggestion: ' compatibility',
          cursorPosition: cursor
        });
        expect(generate).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({
            draft,
            cursorPosition: cursor,
            completionMode: trigger === 'AUTO' ? 'NEXT' : 'REWRITE',
            history: []
          })
        );
        expect(release).toHaveBeenCalledTimes(1);
      } finally {
        node.dispose();
      }
    }
  );

  it('does not forward automatic requests to Nodes that only advertise manual prediction', async () => {
    const f = fixture();
    const capabilities = JSON.parse(f.nodes[0]!.metadata);
    delete capabilities.promptCompletion.automaticTriggers;
    f.nodes[0]!.metadata = JSON.stringify(capabilities);
    const body = generateInput();
    const response = await f.app.inject({
      method: 'POST',
      url: '/api/nodes/node-1/prompt-completion/generate',
      headers: memberHeaders(),
      payload: {
        ...body,
        request: {
          ...body.request,
          trigger: 'AUTO',
          completionMode: 'NEXT',
          draft: '',
          cursorPosition: 0
        }
      }
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: { code: 'PROMPT_COMPLETION_UNAVAILABLE' } });
    expect(f.nodeControl.requestNode).not.toHaveBeenCalled();
    const manual = await f.app.inject({
      method: 'POST',
      url: '/api/nodes/node-1/prompt-completion/generate',
      headers: memberHeaders(),
      payload: generateInput({ request: { pageEpoch: 'manual-page' } })
    });
    expect(manual.statusCode).toBe(200);
  });

  it('requires an authenticated session, same-origin request and valid CSRF token', async () => {
    const f = fixture();
    const body = contextInput();

    const wrongOrigin = await f.app.inject({
      method: 'POST',
      url: '/api/nodes/node-1/prompt-completion/context',
      headers: { origin: 'https://attacker.invalid' },
      payload: body
    });
    const anonymous = await f.app.inject({
      method: 'POST',
      url: '/api/nodes/node-1/prompt-completion/context',
      headers: { origin: publicOrigin },
      payload: body
    });
    const missingCsrf = await f.app.inject({
      method: 'POST',
      url: '/api/nodes/node-1/prompt-completion/context',
      headers: { cookie: 'mar_user_session=member-session', origin: publicOrigin },
      payload: body
    });
    const invalidCsrf = await f.app.inject({
      method: 'POST',
      url: '/api/nodes/node-1/prompt-completion/context',
      headers: { ...memberHeaders(), 'x-csrf-token': 'wrong-fake-csrf' },
      payload: body
    });

    expect(wrongOrigin.statusCode).toBe(403);
    expect(anonymous.statusCode).toBe(401);
    expect(missingCsrf.statusCode).toBe(403);
    expect(invalidCsrf.statusCode).toBe(403);
    expect(f.nodeControl.requestNode).not.toHaveBeenCalled();
    expect(f.nodeControl.requestHostedConversationNode).not.toHaveBeenCalled();
  });

  it('rejects client-injected runtime and history fields before authorization or relay', async () => {
    const f = fixture();
    const valid = generateInput();
    const injectedRuntime = { ...valid, runtime: { workspaceId: 'forged-workspace' } };
    const injectedHistory = {
      ...valid,
      request: { ...valid.request, history: ['forged history'] }
    };
    const injectedTopLevelHistory = { ...valid, history: ['forged history'] };
    const contextWithHistory = { ...contextInput(), history: ['forged history'] };

    const responses = await Promise.all([
      f.app.inject({
        method: 'POST',
        url: '/api/nodes/node-1/prompt-completion/generate',
        headers: memberHeaders(),
        payload: injectedRuntime
      }),
      f.app.inject({
        method: 'POST',
        url: '/api/nodes/node-1/prompt-completion/generate',
        headers: memberHeaders(),
        payload: injectedHistory
      }),
      f.app.inject({
        method: 'POST',
        url: '/api/nodes/node-1/prompt-completion/generate',
        headers: memberHeaders(),
        payload: injectedTopLevelHistory
      }),
      f.app.inject({
        method: 'POST',
        url: '/api/nodes/node-1/prompt-completion/context',
        headers: memberHeaders(),
        payload: contextWithHistory
      })
    ]);

    expect(responses[0]!.statusCode).toBe(400);
    expect(responses[1]!.statusCode).toBe(400);
    expect(responses[2]!.statusCode).toBe(400);
    expect(responses[3]!.statusCode).toBe(400);
    expect(f.resources.assertCanUseWorkspace).not.toHaveBeenCalled();
    expect(f.runtimeModels.preparePromptCompletion).not.toHaveBeenCalled();
    expect(f.nodeControl.requestNode).not.toHaveBeenCalled();
    expect(f.nodeControl.requestHostedConversationNode).not.toHaveBeenCalled();
  });

  it('uses the capability rather than a historical per-feature version gate', async () => {
    const f = fixture();
    const url = '/api/nodes/node-1/prompt-completion/context';
    const request = await f.app.inject({
      method: 'POST',
      url,
      headers: memberHeaders(),
      payload: contextInput()
    });
    expect(request.statusCode).toBe(200);

    f.nodes[0]!.metadata = capabilityMetadata('unknown');
    const unknownVersion = await f.app.inject({
      method: 'POST',
      url,
      headers: memberHeaders(),
      payload: contextInput()
    });
    f.nodes[0]!.metadata = capabilityMetadata('0.10.21', false);
    const missingCapability = await f.app.inject({
      method: 'POST',
      url,
      headers: memberHeaders(),
      payload: contextInput()
    });

    expect(unknownVersion.statusCode).toBe(200);
    expect(missingCapability.statusCode).toBe(409);
    expect(missingCapability.json()).toMatchObject({
      error: { code: 'PROMPT_COMPLETION_UNAVAILABLE' }
    });
    expect(f.resources.assertCanUseWorkspace).toHaveBeenCalledTimes(2);
    expect(f.nodeControl.requestNode).toHaveBeenCalledTimes(2);
  });

  it('routes authorized Workspace requests and rejects hosted requests before forwarding', async () => {
    const f = fixture();
    const workspaceBody = generateInput();
    const workspaceResponse = await f.app.inject({
      method: 'POST',
      url: '/api/nodes/node-1/prompt-completion/generate',
      headers: memberHeaders(),
      payload: workspaceBody
    });
    const hostedBody = generateInput({
      target: { kind: 'HOSTED_CONVERSATION', conversationId: 'conversation-1' },
      request: { pageEpoch: 'hosted-page', requestId: 'hosted-request' }
    });
    const hostedResponse = await f.app.inject({
      method: 'POST',
      url: '/api/nodes/node-1/prompt-completion/generate',
      headers: memberHeaders(),
      payload: hostedBody
    });

    expect(workspaceResponse.statusCode).toBe(200);
    expect(workspaceResponse.json()).toMatchObject({ status: 'ready', requestId: 'request-1' });
    expect(f.resources.assertCanUseWorkspace).toHaveBeenCalledWith(7, 'node-1', 'workspace-1');
    expect(f.nodeControl.requestNode).toHaveBeenCalledWith(
      'node-1',
      'prompt-completion.generate',
      expect.objectContaining({
        target: { kind: 'WORKSPACE', workspaceId: 'workspace-1' },
        runtime: expect.objectContaining({ workspaceId: 'workspace-1' })
      }),
      expect.objectContaining({
        userId: 7,
        sessionHash: 'member-session-hash',
        workspaceId: 'workspace-1'
      }),
      12_000
    );

    expect(hostedResponse.statusCode).toBe(400);
    expect(hostedResponse.json()).toMatchObject({ error: { code: 'MESSAGE_INVALID' } });
    expect(f.nodeControl.requestHostedConversationNode).not.toHaveBeenCalled();
    expect(f.nodeControl.requestNode).toHaveBeenCalledTimes(1);
    expect(f.resources.assertCanUseWorkspace).toHaveBeenCalledTimes(3);
    expect(f.resources.assertCanUseWorkspace).toHaveBeenNthCalledWith(
      1,
      7,
      'node-1',
      'workspace-1'
    );
    expect(f.resources.assertCanUseWorkspace).toHaveBeenNthCalledWith(
      2,
      7,
      'node-1',
      'workspace-1'
    );
    expect(f.resources.assertCanUseWorkspace).toHaveBeenNthCalledWith(
      3,
      7,
      'node-1',
      'workspace-1'
    );
  });

  it('does not relay when Workspace authorization rejects', async () => {
    const deniedWorkspace = fixture();
    deniedWorkspace.resources.assertCanUseWorkspace.mockRejectedValueOnce(
      new Error('FAKE_WORKSPACE_ACCESS_DENIED')
    );
    const workspaceResponse = await deniedWorkspace.app.inject({
      method: 'POST',
      url: '/api/nodes/node-1/prompt-completion/generate',
      headers: memberHeaders(),
      payload: generateInput()
    });

    expect(workspaceResponse.statusCode).toBe(400);
    expect(deniedWorkspace.resources.assertCanUseWorkspace).toHaveBeenCalledWith(
      7,
      'node-1',
      'workspace-1'
    );
    expect(deniedWorkspace.nodeControl.requestNode).not.toHaveBeenCalled();
    expect(deniedWorkspace.runtimeModels.preparePromptCompletion).not.toHaveBeenCalled();
  });

  it('forwards cancellation for the authenticated page intent without reading Workspace or template resources', async () => {
    const f = fixture();
    const response = await f.app.inject({
      method: 'POST',
      url: '/api/nodes/node-1/prompt-completion/cancel',
      headers: memberHeaders(),
      payload: {
        target: { kind: 'WORKSPACE', workspaceId: 'workspace-revoked' },
        workbenchConnectionId: 'connection-1',
        request: { requestId: 'request-1', pageEpoch: 'page-1', intentSequence: 1 }
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ cancelled: true });
    expect(f.nodeControl.requestNode).toHaveBeenCalledExactlyOnceWith(
      'node-1',
      'prompt-completion.cancel',
      { requestId: 'request-1', pageEpoch: 'page-1', intentSequence: 1 },
      { userId: 7, sessionHash: 'member-session-hash' },
      12_000
    );
    expect(f.nodeControl.listNodes).not.toHaveBeenCalled();
    expect(f.resources.assertCanUseWorkspace).not.toHaveBeenCalled();
    expect(f.nodeControl.requestHostedConversationNode).not.toHaveBeenCalled();
  });
});

function fixture() {
  const nodes = [
    {
      id: 'node-1',
      metadata: capabilityMetadata(),
      connected: true,
      disabled: false
    }
  ];
  const model = {
    id: 'model-1',
    name: 'Fake Model',
    protocol: 'OPENAI_RESPONSES',
    modelId: 'fake-model',
    baseUrl: 'https://model.invalid/v1',
    credential: { type: 'INLINE_API_KEY', value: 'fake-fixture-key' },
    contextWindowTokens: 32_000,
    maxOutputTokens: 512,
    inputCapabilities: ['TEXT'],
    outputCapabilities: ['TEXT'],
    reasoningEfforts: ['low'],
    hostedWebSearch: false,
    responsesPreviousResponseId: false,
    enabled: true
  };
  const raw = {
    execute: vi.fn(async (sql: string) => {
      if (sql.includes('FROM system_settings'))
        return [
          [
            {
              setting_value: JSON.stringify({
                enabled: true,
                modelId: 'model-1',
                reasoningEffort: 'low'
              })
            }
          ],
          []
        ];
      return [[], []];
    })
  };
  const actor = {
    userId: 7,
    username: 'member',
    isAdmin: false,
    sessionHash: 'member-session-hash',
    mustChangePassword: false,
    csrfTokenHash
  };
  const database = {
    raw,
    findCurrentUserSession: vi.fn((sessionId: string) =>
      sessionId === 'member-session' ? actor : undefined
    )
  };
  const requestNode = vi.fn(
    async (_nodeId: string, operation: string, data: unknown): Promise<unknown> =>
      relayResult(operation, data)
  );
  const requestHostedConversationNode = vi.fn();
  const nodeControl = {
    listNodes: vi.fn(async () => nodes),
    ownsWorkbenchConnection: vi.fn(() => true),
    requestNode,
    requestHostedConversationNode
  };
  const resources = { assertCanUseWorkspace: vi.fn(async () => undefined) };
  const runtimeModels = {
    preparePromptCompletion: vi.fn(async () => ({ runtimeScopeId: 'fake-runtime-scope', model }))
  };
  const app = Fastify();
  activeApps.push(app);
  registerPromptCompletionRoutes({
    app,
    database: database as never,
    databaseError: (reply: FastifyReply, error: unknown) =>
      reply.code(400).send({ error: { code: error instanceof Error ? error.message : 'ERROR' } }),
    models: {
      storedConfigurationsForUser: vi.fn(async () => [{ id: 'model-1', enabled: true }])
    } as never,
    runtimeModels: runtimeModels as never,
    resources,
    nodeControl: nodeControl as never,
    publicOrigin
  });
  return { app, database, nodes, nodeControl, resources, runtimeModels };
}

function relayResult(operation: string, data: unknown) {
  if (operation.endsWith('.context'))
    return { contextVersion: 'context-v1', historyGeneration: 'history-v1', progressRevision: 1 };
  if (operation.endsWith('.generate')) {
    const request = (data as { request: ReturnType<typeof promptRequest> }).request;
    return {
      status: 'ready',
      requestId: request.requestId,
      contextVersion: request.contextVersion,
      historyGeneration: request.historyGeneration,
      draftRevision: request.draftRevision,
      cursorPosition: request.cursorPosition,
      suggestion: 'Fake completion',
      source: 'generated',
      expiresAt: 90_000
    };
  }
  return { cancelled: true };
}

function contextInput(target = { kind: 'WORKSPACE' as const, workspaceId: 'workspace-1' }) {
  return {
    target,
    runner: 'codex',
    sessionId: 'session-1',
    workbenchConnectionId: 'connection-1',
    pageEpoch: 'context-page'
  };
}

function promptRequest(overrides: { requestId?: string; pageEpoch?: string } = {}) {
  return {
    trigger: 'MANUAL',
    completionMode: 'COMPLETE',
    draft: 'Please ',
    cursorPosition: 7,
    draftRevision: 1,
    contextVersion: 'context-v1',
    historyGeneration: 'history-v1',
    requestId: overrides.requestId ?? 'request-1',
    pageEpoch: overrides.pageEpoch ?? 'page-1',
    intentSequence: 1,
    runner: 'codex',
    sessionId: 'session-1'
  };
}

function generateInput(
  overrides: {
    target?:
      | { kind: 'WORKSPACE'; workspaceId: string }
      | { kind: 'HOSTED_CONVERSATION'; conversationId: string };
    request?: { requestId?: string; pageEpoch?: string };
  } = {}
) {
  return {
    target: overrides.target ?? { kind: 'WORKSPACE' as const, workspaceId: 'workspace-1' },
    workbenchConnectionId: 'connection-1',
    request: promptRequest(overrides.request)
  };
}

function capabilityMetadata(version = '0.10.21', supportsPromptCompletion = true): string {
  return JSON.stringify({
    platform: 'linux',
    architecture: 'x64',
    nodeAppVersion: version,
    nodeVersion: 'v24.12.0',
    metadata: {},
    codex: { available: true },
    claudeCode: { available: true },
    ...(supportsPromptCompletion
      ? { promptCompletion: { apiVersion: 1, automaticTriggers: true } }
      : {})
  });
}

function memberHeaders() {
  return {
    cookie: 'mar_user_session=member-session',
    origin: publicOrigin,
    'x-csrf-token': csrfToken
  };
}
