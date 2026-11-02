import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalAgentHost } from '@myagentroam/agent/host';
import type { AgentModelConfiguration } from '@myagentroam/agent';
import { createAgentWithAdapter } from '../../../mar-agent/dist/sdk/agent.js';
import { NODE_PROTOCOL_VERSION } from '../../../packages/protocol/src/index.js';
import type {
  NodeEnvelope,
  RuntimeCredentialResolveResponse,
  RuntimeCredentialTicket
} from '../../../packages/protocol/src/index.js';
import { NodeRuntimeState } from '../../src/runtime-state.js';
import {
  MarAgentRuntimeModelFactory,
  sdkModelConfigurations
} from '../../src/runner/mar-agent/runtime-model-factory.js';
import { MarAgentRunner } from '../../src/runner/mar-agent-runner.js';
import { RUNNER_EXECUTION_CONTEXT } from '../../src/runner/execution-context.js';
import { ContinuousRunCoordinator } from '../../src/service/continuous-run-coordinator.js';
import { RuntimeCredentialControlService } from '../../src/service/runtime-credential-control-service.js';
import { SessionLifecycleService } from '../../src/session/session-lifecycle-service.js';
import { SessionMessageService } from '../../src/session/session-message-service.js';

describe('Node MAR Agent runtime credentials', () => {
  it('relays unknown nested model options safely through the SDK', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mar-node-model-options-'));
    const control = new RuntimeCredentialControlService({ send: () => {}, timeoutMs: 1_000 });
    let provider: AgentModelConfiguration['credentialProvider'];
    try {
      const [model] = new MarAgentRuntimeModelFactory(control, () => 1_000).create(
        [
          {
            ...runtimeModel(ticket('options', 1_000)),
            gcEnabled: false,
            responsesTransport: { transport: 'HTTP', httpVersion: '2', future: 'transport-secret' },
            responsesOptionalParameters: {
              reasoningEffort: true,
              reasoningSummary: false,
              textVerbosity: true,
              promptCacheKey: false,
              future: 'parameter-secret'
            }
          } as never
        ],
        { runtimeScopeId: 'scope-1', executionId: 'execution-1' }
      );
      provider = model!.credentialProvider;
      expect(provider).toBeDefined();
      let received: AgentModelConfiguration | undefined;
      const agent = await createAgentWithAdapter(
        {
          mode: 'node',
          host: new LocalAgentHost({ mode: 'node', homeDirectory: home, workspace: home }),
          models: sdkModelConfigurations([model!])
        },
        (configuration) => {
          received = configuration;
          return {
            configuration,
            async *start() {
              yield { type: 'text.completed' as const, itemId: 'answer', text: 'done' };
              yield { type: 'completed' as const, reason: 'completed' as const };
            }
          };
        }
      );
      try {
        const session = await agent.createSession({ workspace: home });
        expect(await session.run({ prompt: 'Answer.' }).result()).toMatchObject({
          status: 'completed'
        });
        expect(received?.credentialProvider).toBe(provider);
        expect(received?.gcEnabled).toBe(false);
        expect(received?.responsesTransport).toEqual({ transport: 'HTTP', httpVersion: '2' });
        expect(received?.responsesOptionalParameters).toEqual({
          reasoningEffort: true,
          reasoningSummary: false,
          textVerbosity: true,
          promptCacheKey: false
        });
        expect(
          JSON.stringify({
            responsesTransport: received?.responsesTransport,
            responsesOptionalParameters: received?.responsesOptionalParameters
          })
        ).not.toMatch(/transport-secret|parameter-secret/);
      } finally {
        await agent.dispose();
        provider = undefined;
      }
    } finally {
      await provider?.close();
      await rm(home, { recursive: true, force: true });
    }
  });

  it('rejects invalid known nested model options at the Node relay', () => {
    const control = new RuntimeCredentialControlService({ send: () => {}, timeoutMs: 1_000 });
    const factory = new MarAgentRuntimeModelFactory(control, () => 1_000);
    for (const overrides of [
      { responsesTransport: { transport: 'INVALID' } },
      { responsesTransport: { transport: 'HTTP', httpVersion: '3' } },
      {
        responsesOptionalParameters: {
          reasoningEffort: 'yes',
          reasoningSummary: false,
          textVerbosity: true,
          promptCacheKey: false
        }
      }
    ]) {
      expect(() =>
        factory.create([{ ...runtimeModel(ticket('invalid', 1_000)), ...overrides } as never], {
          runtimeScopeId: 'scope-1',
          executionId: 'execution-1'
        })
      ).toThrow();
    }
  });
  it.each(['1.1', '2'] as const)(
    'relays HTTP/%s continuation to SDK without adding storage configuration',
    async (httpVersion) => {
      const control = new RuntimeCredentialControlService({ send: () => {}, timeoutMs: 1000 });
      const [model] = new MarAgentRuntimeModelFactory(control, () => 1000).create(
        [
          {
            ...runtimeModel(ticket('http', 1000)),
            responsesTransport: { transport: 'HTTP', httpVersion },
            responsesPreviousResponseId: true,
            conversationModel: false
          }
        ],
        { runtimeScopeId: 'scope-1', executionId: 'execution-1' }
      );
      expect(model).toMatchObject({
        responsesTransport: { transport: 'HTTP', httpVersion },
        responsesPreviousResponseId: true,
        conversationModel: false
      });
      await model?.credentialProvider?.close();
    }
  );
  it('passes optional Responses parameters without inferring provider behavior', async () => {
    const control = new RuntimeCredentialControlService({ send: () => {}, timeoutMs: 1000 });
    const optional = {
      reasoningEffort: false,
      reasoningSummary: false,
      textVerbosity: false,
      promptCacheKey: false
    };
    const [model] = new MarAgentRuntimeModelFactory(control, () => 1000).create(
      [{ ...runtimeModel(ticket('grok', 1000)), responsesOptionalParameters: optional }],
      { runtimeScopeId: 'scope-1', executionId: 'execution-1' }
    );
    expect(model?.responsesOptionalParameters).toEqual(optional);
    await model?.credentialProvider?.close();
  });
  it.each(['LITE', 'STANDARD'] as const)(
    'discards legacy %s encoding before creating SDK models',
    async (responsesEncoding) => {
      const control = new RuntimeCredentialControlService({ send: () => {}, timeoutMs: 1_000 });
      const [model] = new MarAgentRuntimeModelFactory(control, () => 1_000).create(
        [{ ...runtimeModel(ticket('encoding', 1_000)), responsesEncoding } as never],
        { runtimeScopeId: 'scope-1', executionId: 'execution-1' }
      );
      expect(model).not.toHaveProperty('responsesEncoding');
      await model?.credentialProvider?.close();
    }
  );

  it('passes the explicit configuration-update capability to the SDK model', async () => {
    const control = new RuntimeCredentialControlService({ send: () => {}, timeoutMs: 1_000 });
    const sharedTicket = ticket('shared', 1_000, ['model-1', 'model-2']);
    const { credential: _credential, ...staticModel } = runtimeModel(sharedTicket);
    const [supported, unsupported, staticSupported, staticUnsupported] =
      new MarAgentRuntimeModelFactory(control, () => 1_000).create(
        [
          { ...runtimeModel(sharedTicket), responsesConfigurationUpdates: true },
          {
            ...runtimeModel(sharedTicket),
            id: 'model-2',
            responsesConfigurationUpdates: false
          },
          {
            ...staticModel,
            id: 'static-key',
            credential: { type: 'INLINE_API_KEY', value: 'fixture-only' },
            responsesConfigurationUpdates: true
          },
          {
            ...staticModel,
            id: 'inline-key',
            credential: { type: 'INLINE_API_KEY', value: 'fixture-only' },
            responsesConfigurationUpdates: false
          }
        ],
        { runtimeScopeId: 'scope-1', executionId: 'execution-1' }
      );
    expect(supported?.responsesConfigurationUpdates).toBe(true);
    expect(unsupported?.responsesConfigurationUpdates).toBe(false);
    expect(staticSupported?.responsesConfigurationUpdates).toBe(true);
    expect(staticUnsupported?.responsesConfigurationUpdates).toBe(false);
    await Promise.all([
      supported?.credentialProvider?.close(),
      unsupported?.credentialProvider?.close()
    ]);
  });

  it('reuses a resolved credential and refreshes with the newest ticket after invalidation', async () => {
    const sent: NodeEnvelope[] = [];
    const control = new RuntimeCredentialControlService({
      send: (envelope) => sent.push(envelope),
      timeoutMs: 1_000
    });
    control.connected();
    const [model] = new MarAgentRuntimeModelFactory(control, () => 1_000).create(
      [runtimeModel(ticket('ticket-1', 1_000))],
      { runtimeScopeId: 'scope-1', executionId: 'execution-1' }
    );
    const provider = model!.credentialProvider!;
    expect(model).not.toHaveProperty('responsesEncoding');
    expect(model?.imageGeneration).toMatchObject({
      generateEndpoint: 'https://models.example.test/v1/images/generations',
      editEndpoint: 'https://models.example.test/v1/images/edits',
      imageModelId: 'gpt-image-2',
      httpVersion: '1.1'
    });
    expect(model?.imageGeneration?.credentialProvider).toBe(provider);

    const first = provider.acquire('REQUEST');
    expect(sent[0]).toMatchObject({
      type: 'credential.resolve',
      payload: {
        ticket: expect.objectContaining({ nonce: 'ticket-1' }),
        modelId: 'model-1',
        runtimeScopeId: 'scope-1',
        executionId: 'execution-1',
        reason: 'REQUEST'
      }
    });
    control.handle(
      response(sent[0]!.id, {
        credential: resolvedCredential(1),
        nextTicket: ticket('ticket-2', 2_000)
      })
    );
    await expect(first).resolves.toMatchObject({ revision: 1 });

    const second = provider.acquire('RECONNECT');
    if (sent[1] !== undefined)
      control.handle(
        response(sent[1].id, {
          credential: resolvedCredential(99),
          nextTicket: ticket('unexpected-ticket', 3_000)
        })
      );
    expect(sent).toHaveLength(1);
    await expect(second).resolves.toMatchObject({ revision: 1 });

    provider.invalidate(1);
    const refreshed = provider.acquire('UNAUTHORIZED');
    expect(sent[1]).toMatchObject({
      payload: {
        ticket: expect.objectContaining({ nonce: 'ticket-2' }),
        reason: 'UNAUTHORIZED'
      }
    });
    control.handle(
      response(sent[1]!.id, {
        credential: resolvedCredential(2),
        nextTicket: ticket('ticket-3', 3_000)
      })
    );
    const credential = await refreshed;
    expect(credential.bearer.reveal()).toBe('bearer-2');
    expect(credential.headers['chatgpt-account-id']).toBeDefined();

    provider.invalidate(2);
    const next = provider.acquire('UNAUTHORIZED');
    expect(sent[2]).toMatchObject({
      payload: {
        ticket: expect.objectContaining({ nonce: 'ticket-3' }),
        reason: 'UNAUTHORIZED'
      }
    });
    control.handle(
      response(sent[2]!.id, {
        credential: resolvedCredential(3),
        nextTicket: ticket('ticket-4', 4_000)
      })
    );
    await expect(next).resolves.toMatchObject({ revision: 3 });
    await provider.close();
  });

  it('reuses one unauthorized refresh across WebSocket handshake and response.create', async () => {
    const sent: NodeEnvelope[] = [];
    const control = new RuntimeCredentialControlService({
      send: (envelope) => sent.push(envelope),
      timeoutMs: 1_000
    });
    control.connected();
    const provider = new MarAgentRuntimeModelFactory(control, () => 1_000).create(
      [runtimeModel(ticket('ticket-1', 1_000))],
      { runtimeScopeId: 'scope-1', executionId: 'execution-1' }
    )[0]!.credentialProvider!;

    const initial = provider.acquire('REQUEST');
    control.handle(
      response(sent[0]!.id, {
        credential: resolvedCredential(1),
        nextTicket: ticket('ticket-2', 2_000)
      })
    );
    await initial;

    provider.invalidate(1);
    const handshake = provider.acquire('UNAUTHORIZED');
    control.handle(
      response(sent[1]!.id, {
        credential: resolvedCredential(2),
        nextTicket: ticket('ticket-3', 3_000)
      })
    );
    await expect(handshake).resolves.toMatchObject({ revision: 2 });

    const responseCreate = provider.acquire('UNAUTHORIZED');
    if (sent[2] !== undefined)
      control.handle(
        response(sent[2].id, {
          credential: resolvedCredential(3),
          nextTicket: ticket('unexpected-ticket', 4_000)
        })
      );

    expect(sent).toHaveLength(2);
    await expect(responseCreate).resolves.toMatchObject({ revision: 2 });
  });

  it('coalesces concurrent first use across models sharing one Execution credential', async () => {
    const sent: NodeEnvelope[] = [];
    const control = new RuntimeCredentialControlService({
      send: (envelope) => sent.push(envelope),
      timeoutMs: 1_000
    });
    control.connected();
    const sharedTicket = ticket('ticket-1', 1_000, ['model-1', 'model-2']);
    const firstModel = runtimeModel(sharedTicket);
    const secondModel = {
      ...runtimeModel(sharedTicket),
      id: 'model-2',
      name: 'Model Two',
      modelId: 'upstream-model-2'
    };
    const [firstProvider, secondProvider] = new MarAgentRuntimeModelFactory(control, () => 1_000)
      .create([firstModel, secondModel], {
        runtimeScopeId: 'scope-1',
        executionId: 'execution-1'
      })
      .map((model) => model.credentialProvider!);

    const first = firstProvider!.acquire('REQUEST');
    const second = secondProvider!.acquire('REQUEST');
    for (const [index, envelope] of sent.entries())
      control.handle(
        response(envelope.id, {
          credential: resolvedCredential(index + 1),
          nextTicket: ticket(`ticket-${index + 2}`, 2_000 + index)
        })
      );

    expect(sent).toHaveLength(1);
    await expect(Promise.all([first, second])).resolves.toMatchObject([
      { revision: 1 },
      { revision: 1 }
    ]);
  });

  it('upgrades an in-flight runtime refresh when an unauthorized caller joins', async () => {
    let now = 1_000;
    const runtimeRefresh = deferred<{
      credential: ReturnType<typeof resolvedCredential>;
      nextTicket: RuntimeCredentialTicket;
    }>();
    const resolve = vi
      .fn()
      .mockResolvedValueOnce({
        credential: resolvedCredential(1, 62_000),
        nextTicket: ticket('ticket-2', 2_000)
      })
      .mockImplementationOnce(() => runtimeRefresh.promise)
      .mockResolvedValueOnce({
        credential: resolvedCredential(2),
        nextTicket: ticket('ticket-4', 4_000)
      });
    const provider = new MarAgentRuntimeModelFactory({ resolve }, () => now).create(
      [runtimeModel(ticket('ticket-1', 1_000))],
      { runtimeScopeId: 'scope-1', executionId: 'execution-1' }
    )[0]!.credentialProvider!;

    await expect(provider.acquire('REQUEST')).resolves.toMatchObject({ revision: 1 });
    now = 2_001;
    const expiring = provider.acquire('REQUEST');
    provider.invalidate(1);
    const unauthorized = provider.acquire('UNAUTHORIZED');
    runtimeRefresh.resolve({
      credential: resolvedCredential(1),
      nextTicket: ticket('ticket-3', 3_000)
    });

    await vi.waitFor(() => expect(resolve).toHaveBeenCalledTimes(3));
    expect(resolve).toHaveBeenLastCalledWith(
      expect.objectContaining({
        ticket: expect.objectContaining({ nonce: 'ticket-3' }),
        reason: 'UNAUTHORIZED'
      }),
      expect.any(AbortSignal)
    );
    await expect(Promise.all([expiring, unauthorized])).resolves.toMatchObject([
      { revision: 2 },
      { revision: 2 }
    ]);
  });

  it('rejects a dynamic model that is not allowed by its Execution ticket', () => {
    const control = new RuntimeCredentialControlService({
      send: vi.fn(),
      timeoutMs: 1_000
    });
    control.connected();
    const disallowedModel = {
      ...runtimeModel(ticket('ticket-1', 1_000)),
      id: 'model-2',
      name: 'Model Two',
      modelId: 'upstream-model-2'
    };

    expect(() =>
      new MarAgentRuntimeModelFactory(control).create([disallowedModel], {
        runtimeScopeId: 'scope-1',
        executionId: 'execution-1'
      })
    ).toThrow('MAR_AGENT_RUNTIME_CREDENTIAL_SCOPE_INVALID');
  });

  it('rejects a model not allowed by the shared Execution credential ticket', () => {
    const control = new RuntimeCredentialControlService({
      send: vi.fn(),
      timeoutMs: 1_000
    });
    control.connected();
    const firstModel = runtimeModel(ticket('ticket-1', 1_000, ['model-1']));
    const secondModel = {
      ...runtimeModel(ticket('ticket-2', 1_000, ['model-2'])),
      id: 'model-2',
      name: 'Model Two',
      modelId: 'upstream-model-2'
    };

    expect(() =>
      new MarAgentRuntimeModelFactory(control).create([firstModel, secondModel], {
        runtimeScopeId: 'scope-1',
        executionId: 'execution-1'
      })
    ).toThrow('MAR_AGENT_RUNTIME_CREDENTIAL_SCOPE_INVALID');
  });

  it('rejects inconsistent tickets for models sharing one Execution credential', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const firstTicket = ticket('ticket-1', 1_000, ['model-1', 'model-2']);
    const secondTicket = {
      ...firstTicket,
      workspaceId: 'workspace-2',
      nonce: 'ticket-2',
      signature: 'b'.repeat(64)
    };

    expect(() =>
      new MarAgentRuntimeModelFactory({ resolve: vi.fn() }).create(
        [
          runtimeModel(firstTicket),
          {
            ...runtimeModel(secondTicket),
            id: 'model-2',
            name: 'Model Two',
            modelId: 'upstream-model-2'
          }
        ],
        { runtimeScopeId: 'scope-1', executionId: 'execution-1' }
      )
    ).toThrow('MAR_AGENT_RUNTIME_CREDENTIAL_SCOPE_INVALID');
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });

  it('does not share resolved credentials across Executions', async () => {
    const sent: NodeEnvelope[] = [];
    const control = new RuntimeCredentialControlService({
      send: (envelope) => sent.push(envelope),
      timeoutMs: 1_000
    });
    control.connected();
    const factory = new MarAgentRuntimeModelFactory(control, () => 1_000);
    const firstProvider = factory.create([runtimeModel(ticket('ticket-1', 1_000))], {
      runtimeScopeId: 'scope-1',
      executionId: 'execution-1'
    })[0]!.credentialProvider!;
    const secondProvider = factory.create([runtimeModel(ticket('ticket-2', 2_000))], {
      runtimeScopeId: 'scope-1',
      executionId: 'execution-2'
    })[0]!.credentialProvider!;

    const first = firstProvider.acquire('REQUEST');
    const second = secondProvider.acquire('REQUEST');
    expect(sent).toHaveLength(2);
    control.handle(
      response(sent[0]!.id, {
        credential: resolvedCredential(1),
        nextTicket: ticket('ticket-3', 3_000)
      })
    );
    control.handle(
      response(sent[1]!.id, {
        credential: resolvedCredential(2),
        nextTicket: ticket('ticket-4', 4_000)
      })
    );

    await expect(Promise.all([first, second])).resolves.toMatchObject([
      { revision: 1 },
      { revision: 2 }
    ]);
  });

  it('continues using an already resolved Execution credential after control disconnects', async () => {
    const sent: NodeEnvelope[] = [];
    const control = new RuntimeCredentialControlService({
      send: (envelope) => sent.push(envelope),
      timeoutMs: 1_000
    });
    control.connected();
    const provider = new MarAgentRuntimeModelFactory(control, () => 1_000).create(
      [runtimeModel(ticket('ticket-1', 1_000))],
      { runtimeScopeId: 'scope-1', executionId: 'execution-1' }
    )[0]!.credentialProvider!;

    const first = provider.acquire('REQUEST');
    control.handle(
      response(sent[0]!.id, {
        credential: resolvedCredential(1),
        nextTicket: ticket('ticket-2', 2_000)
      })
    );
    await first;
    control.disconnected();

    await expect(provider.acquire('RECONNECT')).resolves.toMatchObject({ revision: 1 });
    expect(sent).toHaveLength(1);
  });

  it('refreshes a cached credential when it enters the expiry window', async () => {
    let now = 1_000;
    const sent: NodeEnvelope[] = [];
    const control = new RuntimeCredentialControlService({
      send: (envelope) => sent.push(envelope),
      timeoutMs: 1_000
    });
    control.connected();
    const provider = new MarAgentRuntimeModelFactory(control, () => now).create(
      [runtimeModel(ticket('ticket-1', 1_000))],
      { runtimeScopeId: 'scope-1', executionId: 'execution-1' }
    )[0]!.credentialProvider!;

    const first = provider.acquire('REQUEST');
    control.handle(
      response(sent[0]!.id, {
        credential: resolvedCredential(1, 62_000),
        nextTicket: ticket('ticket-2', 2_000)
      })
    );
    await first;
    now = 2_001;

    const refreshed = provider.acquire('REQUEST');
    expect(sent).toHaveLength(2);
    control.handle(
      response(sent[1]!.id, {
        credential: resolvedCredential(2),
        nextTicket: ticket('ticket-3', 3_000)
      })
    );
    await expect(refreshed).resolves.toMatchObject({ revision: 2 });
  });

  it('resolves automatically when an Execution ticket enters the expiry window', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const sent: NodeEnvelope[] = [];
    const control = new RuntimeCredentialControlService({
      send: (envelope) => sent.push(envelope),
      timeoutMs: 1_000
    });
    control.connected();
    const provider = new MarAgentRuntimeModelFactory(control).create(
      [runtimeModel(ticket('ticket-1', 1_000))],
      { runtimeScopeId: 'scope-1', executionId: 'execution-1' }
    )[0]!.credentialProvider!;

    try {
      await vi.advanceTimersByTimeAsync(3_540_000);
      expect(sent[0]).toMatchObject({
        type: 'credential.resolve',
        payload: {
          ticket: expect.objectContaining({ nonce: 'ticket-1' }),
          modelId: 'model-1',
          runtimeScopeId: 'scope-1',
          executionId: 'execution-1',
          reason: 'REQUEST'
        }
      });
      control.handle(
        response(sent[0]!.id, {
          credential: resolvedCredential(1, 7_200_000),
          nextTicket: ticket('ticket-2', 3_541_000)
        })
      );

      await vi.advanceTimersByTimeAsync(60_001);
      await expect(provider.acquire('REQUEST')).resolves.toMatchObject({ revision: 1 });
      expect(sent.filter((envelope) => envelope.type === 'credential.resolve')).toHaveLength(1);
    } finally {
      await provider.close();
      control.close();
      vi.useRealTimers();
    }
  });

  it('resolves automatically when a cached credential enters the expiry window', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const resolve = vi
      .fn()
      .mockResolvedValueOnce({
        credential: resolvedCredential(1, 121_000),
        nextTicket: ticket('ticket-2', 1_000)
      })
      .mockResolvedValueOnce({
        credential: resolvedCredential(2, 7_200_000),
        nextTicket: ticket('ticket-3', 61_000)
      });
    const provider = new MarAgentRuntimeModelFactory({ resolve }).create(
      [runtimeModel(ticket('ticket-1', 1_000))],
      { runtimeScopeId: 'scope-1', executionId: 'execution-1' }
    )[0]!.credentialProvider!;

    try {
      await expect(provider.acquire('REQUEST')).resolves.toMatchObject({ revision: 1 });
      await vi.advanceTimersByTimeAsync(60_000);

      expect(resolve).toHaveBeenCalledTimes(2);
      expect(resolve).toHaveBeenLastCalledWith(
        expect.objectContaining({
          ticket: expect.objectContaining({ nonce: 'ticket-2' }),
          reason: 'REQUEST'
        }),
        expect.any(AbortSignal)
      );
      await expect(provider.acquire('REQUEST')).resolves.toMatchObject({ revision: 2 });
    } finally {
      await provider.close();
      vi.useRealTimers();
    }
  });

  it('backs off when automatic renewal returns an unchanged near-expiry credential', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const resolve = vi
      .fn()
      .mockResolvedValueOnce({
        credential: resolvedCredential(1, 121_000),
        nextTicket: ticket('ticket-2', 1_000)
      })
      .mockResolvedValueOnce({
        credential: resolvedCredential(1, 121_000),
        nextTicket: ticket('ticket-3', 61_000)
      })
      .mockResolvedValue({
        credential: resolvedCredential(2, 7_200_000),
        nextTicket: ticket('ticket-4', 91_000)
      });
    const provider = new MarAgentRuntimeModelFactory({ resolve }).create(
      [runtimeModel(ticket('ticket-1', 1_000))],
      { runtimeScopeId: 'scope-1', executionId: 'execution-1' }
    )[0]!.credentialProvider!;

    try {
      await provider.acquire('REQUEST');
      await vi.advanceTimersByTimeAsync(60_001);
      expect(resolve).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(29_999);
      expect(resolve).toHaveBeenCalledTimes(3);
      await expect(provider.acquire('REQUEST')).resolves.toMatchObject({ revision: 2 });
    } finally {
      await provider.close();
      vi.useRealTimers();
    }
  });

  it('retries automatic renewal after a temporary failure without a new model request', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const resolve = vi
      .fn()
      .mockRejectedValueOnce(new Error('MAR_AGENT_RUNTIME_CREDENTIAL_CONNECTION_INVALID'))
      .mockResolvedValue({
        credential: resolvedCredential(1, 7_200_000),
        nextTicket: ticket('ticket-2', 3_571_000)
      });
    const provider = new MarAgentRuntimeModelFactory({ resolve }).create(
      [runtimeModel(ticket('ticket-1', 1_000))],
      { runtimeScopeId: 'scope-1', executionId: 'execution-1' }
    )[0]!.credentialProvider!;

    try {
      await vi.advanceTimersByTimeAsync(3_540_000);
      expect(resolve).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(30_000);
      expect(resolve).toHaveBeenCalledTimes(2);
      await expect(provider.acquire('REQUEST')).resolves.toMatchObject({ revision: 1 });
      expect(resolve).toHaveBeenCalledTimes(2);
    } finally {
      await provider.close();
      vi.useRealTimers();
    }
  });

  it('stops background renewal retries after the signed ticket expires', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const resolve = vi
      .fn()
      .mockRejectedValue(new Error('MAR_AGENT_RUNTIME_CREDENTIAL_CONNECTION_INVALID'));
    const provider = new MarAgentRuntimeModelFactory({ resolve }).create(
      [runtimeModel(ticket('ticket-1', 1_000))],
      { runtimeScopeId: 'scope-1', executionId: 'execution-1' }
    )[0]!.credentialProvider!;

    try {
      await vi.advanceTimersByTimeAsync(3_600_000);
      expect(resolve).toHaveBeenCalledTimes(3);
      await vi.advanceTimersByTimeAsync(3_600_000);
      expect(resolve).toHaveBeenCalledTimes(3);
    } finally {
      await provider.close();
      vi.useRealTimers();
    }
  });

  it('contains an automatic refresh failure and retries on the next acquisition', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const resolve = vi
      .fn()
      .mockRejectedValueOnce(new Error('MAR_AGENT_RUNTIME_CREDENTIAL_CONNECTION_INVALID'))
      .mockResolvedValueOnce({
        credential: resolvedCredential(1, 7_200_000),
        nextTicket: ticket('ticket-2', 3_541_000)
      });
    const provider = new MarAgentRuntimeModelFactory({ resolve }).create(
      [runtimeModel(ticket('ticket-1', 1_000))],
      { runtimeScopeId: 'scope-1', executionId: 'execution-1' }
    )[0]!.credentialProvider!;

    try {
      await vi.advanceTimersByTimeAsync(3_540_000);
      expect(resolve).toHaveBeenCalledOnce();
      await expect(provider.acquire('REQUEST')).resolves.toMatchObject({ revision: 1 });
      expect(resolve).toHaveBeenCalledTimes(2);
    } finally {
      await provider.close();
      vi.useRealTimers();
    }
  });

  it('uses a remaining allowed model for automatic refresh after another provider closes', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const sent: NodeEnvelope[] = [];
    const control = new RuntimeCredentialControlService({
      send: (envelope) => sent.push(envelope),
      timeoutMs: 1_000
    });
    control.connected();
    const sharedTicket = ticket('ticket-1', 1_000, ['model-1', 'model-2']);
    const [firstProvider, secondProvider] = new MarAgentRuntimeModelFactory(control)
      .create(
        [
          runtimeModel(sharedTicket),
          {
            ...runtimeModel(sharedTicket),
            id: 'model-2',
            name: 'Model Two',
            modelId: 'upstream-model-2'
          }
        ],
        { runtimeScopeId: 'scope-1', executionId: 'execution-1' }
      )
      .map((model) => model.credentialProvider!);

    try {
      await firstProvider!.close();
      await vi.advanceTimersByTimeAsync(3_540_000);
      expect(sent[0]).toMatchObject({
        type: 'credential.resolve',
        payload: { modelId: 'model-2', reason: 'REQUEST' }
      });
      control.handle(
        response(sent[0]!.id, {
          credential: resolvedCredential(1, 7_200_000),
          nextTicket: ticket('ticket-2', 3_541_000, ['model-1', 'model-2'])
        })
      );
      await vi.advanceTimersByTimeAsync(0);
    } finally {
      await secondProvider!.close();
      control.close();
      vi.useRealTimers();
    }
  });

  it('cancels automatic refresh after the last provider closes', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const resolve = vi.fn();
    const provider = new MarAgentRuntimeModelFactory({ resolve }).create(
      [runtimeModel(ticket('ticket-1', 1_000))],
      { runtimeScopeId: 'scope-1', executionId: 'execution-1' }
    )[0]!.credentialProvider!;

    await provider.close();
    await vi.advanceTimersByTimeAsync(3_540_000);
    expect(resolve).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('rejects timeout, disconnect, generation changes and ignores late responses', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    try {
      const sent: NodeEnvelope[] = [];
      const control = new RuntimeCredentialControlService({
        send: (envelope) => sent.push(envelope),
        timeoutMs: 50
      });
      control.connected();
      const provider = new MarAgentRuntimeModelFactory(control, () => 1_000).create(
        [runtimeModel(ticket('ticket-1', 1_000))],
        { runtimeScopeId: 'scope-1', executionId: 'execution-1' }
      )[0]!.credentialProvider!;

      const timedOut = provider.acquire('REQUEST');
      const timedOutExpectation = expect(timedOut).rejects.toThrow(
        'MAR_AGENT_RUNTIME_CREDENTIAL_REQUEST_TIMEOUT'
      );
      await vi.advanceTimersByTimeAsync(50);
      await timedOutExpectation;
      control.handle(
        response(sent[0]!.id, {
          credential: resolvedCredential(1),
          nextTicket: ticket('late-ticket', 2_000)
        })
      );

      const disconnected = provider.acquire('REQUEST');
      control.disconnected();
      await expect(disconnected).rejects.toThrow('MAR_AGENT_RUNTIME_CREDENTIAL_CONNECTION_INVALID');

      control.connected();
      const replaced = provider.acquire('REQUEST');
      control.connected();
      await expect(replaced).rejects.toThrow('MAR_AGENT_RUNTIME_CREDENTIAL_CONNECTION_INVALID');
    } finally {
      vi.useRealTimers();
    }
  });

  it('aborts pending resolution and refuses acquisition after provider close', async () => {
    const sent: NodeEnvelope[] = [];
    const control = new RuntimeCredentialControlService({
      send: (envelope) => sent.push(envelope),
      timeoutMs: 1_000
    });
    control.connected();
    const provider = new MarAgentRuntimeModelFactory(control).create(
      [runtimeModel(ticket('ticket-1', 1_000))],
      { runtimeScopeId: 'scope-1', executionId: 'execution-1' }
    )[0]!.credentialProvider!;

    const pending = provider.acquire('REQUEST');
    await provider.close();
    await expect(pending).rejects.toThrow('MAR_AGENT_RUNTIME_CREDENTIAL_PROVIDER_CLOSED');
    await expect(provider.acquire('REQUEST')).rejects.toThrow(
      'MAR_AGENT_RUNTIME_CREDENTIAL_PROVIDER_CLOSED'
    );
    await expect(provider.acquire('REQUEST')).rejects.toMatchObject({
      code: 'MAR_AGENT_RUNTIME_CREDENTIAL_PROVIDER_CLOSED',
      publicMessage: 'The runtime credential provider is closed.'
    });
    control.handle(
      response(sent[0]!.id, {
        credential: resolvedCredential(1),
        nextTicket: ticket('late-ticket', 2_000)
      })
    );
  });

  it('cancels a shared pending resolution only after every provider closes', async () => {
    let sharedSignal: AbortSignal | undefined;
    const resolve = vi.fn(
      (_request: unknown, signal?: AbortSignal) =>
        new Promise<never>((_resolve, reject) => {
          sharedSignal = signal;
          signal?.addEventListener(
            'abort',
            () => reject(new Error('MAR_AGENT_RUNTIME_CREDENTIAL_PROVIDER_CLOSED')),
            { once: true }
          );
        })
    );
    const sharedTicket = ticket('ticket-1', 1_000, ['model-1', 'model-2']);
    const [firstProvider, secondProvider] = new MarAgentRuntimeModelFactory(
      { resolve },
      () => 1_000
    )
      .create(
        [
          runtimeModel(sharedTicket),
          {
            ...runtimeModel(sharedTicket),
            id: 'model-2',
            name: 'Model Two',
            modelId: 'upstream-model-2'
          }
        ],
        { runtimeScopeId: 'scope-1', executionId: 'execution-1' }
      )
      .map((model) => model.credentialProvider!);

    const first = firstProvider!.acquire('REQUEST');
    const second = secondProvider!.acquire('REQUEST');
    const firstResult = first.catch((error: unknown) => error);
    const secondResult = second.catch((error: unknown) => error);
    expect(resolve).toHaveBeenCalledTimes(1);

    await firstProvider!.close();
    try {
      expect(sharedSignal).toBeDefined();
      expect(sharedSignal!.aborted).toBe(false);
    } finally {
      await secondProvider!.close();
    }
    const [firstError, secondError] = await Promise.all([firstResult, secondResult]);
    expect(firstError).toMatchObject({ code: 'MAR_AGENT_RUNTIME_CREDENTIAL_PROVIDER_CLOSED' });
    expect(secondError).toMatchObject({ code: 'MAR_AGENT_RUNTIME_CREDENTIAL_PROVIDER_CLOSED' });
    expect(sharedSignal?.aborted).toBe(true);
  });

  it('cleans up pending state when sending a credential request throws synchronously', async () => {
    vi.useFakeTimers();
    try {
      const control = new RuntimeCredentialControlService({
        send: () => {
          throw new Error('CONTROL_SEND_FAILED');
        },
        timeoutMs: 1_000
      });
      control.connected();
      const provider = new MarAgentRuntimeModelFactory(control, () => 1_000).create(
        [runtimeModel(ticket('ticket-1', 1_000))],
        { runtimeScopeId: 'scope-1', executionId: 'execution-1' }
      )[0]!.credentialProvider!;

      await expect(provider.acquire('REQUEST')).rejects.toMatchObject({
        code: 'MAR_AGENT_RUNTIME_CREDENTIAL_REQUEST_SEND_FAILED',
        cause: expect.objectContaining({ message: 'CONTROL_SEND_FAILED' })
      });
      expect(vi.getTimerCount()).toBe(1);
      await provider.close();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('forwards the runtime credential scope from session start into the first message', async () => {
    const execute = vi.fn(async (operation: string) => {
      if (operation === 'session.create') return { session: { id: 'bootstrap-session' } };
      if (operation === 'session.message')
        return { run: { id: 'run-1' }, delivery: 'STARTED', idempotent: false };
      throw new Error('UNEXPECTED_OPERATION');
    });
    const service = new SessionLifecycleService({
      database: () => ({}) as never,
      runtime: {
        getAgentSession: () => ({ id: 'native-session' }),
        getRun: () => ({ id: 'run-1' }),
        conversationTurnForRun: () => ({ id: 'turn-1' }),
        removeAgentSession: vi.fn()
      } as never,
      runners: { require: () => new MarAgentRunner() } as never,
      projection: {} as never,
      identity: {
        markBootstrap: vi.fn(),
        wait: vi.fn(async () => 'native-session'),
        promote: vi.fn(),
        reject: vi.fn()
      } as never,
      present: (session) => session,
      emitSession: vi.fn(),
      invalidateWorkspaceSessions: vi.fn(),
      execute,
      interceptedSessionId: () => undefined
    });

    await service.operations()['session.start']?.({
      workspaceId: 'workspace-1',
      runner: 'mar-agent',
      cwd: '/workspace',
      clientMessageId: 'message-1',
      content: 'hello',
      marAgentRuntimeScopeId: 'scope-1',
      marAgentModel: runtimeModel(ticket('ticket-1', 1_000)),
      marAgentModels: [runtimeModel(ticket('ticket-1', 1_000))]
    });

    expect(execute).toHaveBeenCalledWith(
      'session.message',
      expect.objectContaining({
        [RUNNER_EXECUTION_CONTEXT]: expect.objectContaining({
          runner: 'mar-agent',
          runnerInput: expect.objectContaining({ runtimeScopeId: 'scope-1' })
        })
      })
    );
  });

  it('keeps the runtime credential scope in the prepared message input', async () => {
    const runtime = runtimeState();
    const session = runtime.createAgentSession({
      workspaceId: 'workspace-1',
      runner: 'mar-agent',
      cwd: '/workspace',
      modelId: 'model-1'
    });
    const prepare = vi.fn();
    const releasePreparation = vi.fn();
    const service = new SessionMessageService({
      runtime,
      uploads: {
        resolve: vi.fn(async () => []),
        consume: vi.fn(async () => undefined)
      } as never,
      attachments: {
        protectSession: vi.fn(() => releasePreparation),
        retainSessionFiles: vi.fn(),
        acceptSessionInput: vi.fn(),
        discardFiles: vi.fn(async () => undefined),
        persistFiles: vi.fn(async () => []),
        cache: vi.fn(),
        clear: vi.fn(),
        cleanup: vi.fn()
      } as never,
      commands: { list: () => [] } as never,
      coordinator: {
        accept: (input: {
          runId: string;
          sessionId: string;
          clientMessageId: string;
          content: string;
        }) => runtime.createMessageRun(input),
        prepare,
        settle: vi.fn(() => 'STARTED'),
        failPreparation: vi.fn(),
        publishCurrentTurn: vi.fn()
      } as never,
      runners: {
        require: () => ({
          prepareExecutionContext: (input: Readonly<Record<string, unknown>>) =>
            new MarAgentRunner().prepareExecutionContext(input),
          prepareMessageInput: (input: string) => input,
          serviceTier: () => undefined
        })
      } as never,
      resolve: async () => ({
        session
      }),
      present: (value) => value,
      emitSession: vi.fn(),
      channelToken: () => undefined,
      goalMessage: () => undefined,
      prepareGoalInsertion: vi.fn(),
      goalPreparationFailed: vi.fn()
    });

    await service.operations()['session.message']?.({
      sessionId: session.id,
      clientMessageId: 'message-1',
      content: 'hello',
      marAgentRuntimeScopeId: 'scope-1',
      marAgentModel: runtimeModel(ticket('ticket-1', 1_000)),
      marAgentModels: [runtimeModel(ticket('ticket-1', 1_000))]
    });

    expect(releasePreparation).toHaveBeenCalledOnce();
    expect(prepare).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        executionContext: expect.objectContaining({
          runner: 'mar-agent',
          runnerInput: expect.objectContaining({ runtimeScopeId: 'scope-1' })
        })
      })
    );
  });

  it('forwards the prepared runtime credential scope to run.start', async () => {
    const runtime = runtimeState();
    const session = runtime.createAgentSession({
      workspaceId: 'workspace-1',
      runner: 'mar-agent',
      cwd: '/workspace',
      modelId: 'model-1'
    });
    const control = vi.fn();
    const coordinator = new ContinuousRunCoordinator({
      executionTerminating: () => undefined,
      keepRunActive: () => false,
      runtime,
      emitQueue: vi.fn(),
      emitConversation: vi.fn(),
      clearImages: vi.fn(),
      cleanupAttachments: vi.fn(),
      migrateAssets: vi.fn(),
      emitRun: vi.fn(),
      control,
      stopped: () => false,
      markInterrupted: vi.fn(),
      mcps: () => []
    });
    const accepted = coordinator.accept({
      runId: 'run-1',
      sessionId: session.id,
      clientMessageId: 'message-1',
      content: 'hello'
    });
    coordinator.prepare(accepted.run.id, {
      runId: accepted.run.id,
      sessionId: session.id,
      workspaceId: 'workspace-1',
      runner: 'mar-agent',
      input: 'hello',
      attachments: [],
      attachmentPaths: [],
      cwd: '/workspace',
      externalSessionId: null,
      modelId: 'model-1',
      effort: 'high',
      access: 'full-access',
      collaborationMode: 'default',
      secretEnvironment: {},
      executionContext: new MarAgentRunner().prepareExecutionContext({
        marAgentRuntimeScopeId: 'scope-1'
      })
    } as never);

    await coordinator.dispatch(session.id);

    expect(control).toHaveBeenCalledWith(
      'run.start',
      expect.objectContaining({
        runner: 'mar-agent',
        runnerInput: expect.objectContaining({ runtimeScopeId: 'scope-1' })
      })
    );
  });
});

function runtimeState(): NodeRuntimeState {
  return new NodeRuntimeState(
    () => 'node-1',
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
        : undefined,
    () => 1_000
  );
}

function runtimeModel(ticketValue: RuntimeCredentialTicket) {
  return {
    id: 'model-1',
    name: 'Model One',
    protocol: 'OPENAI_RESPONSES' as const,
    baseUrl: 'https://models.example.test/v1',
    credential: {
      type: 'RUNTIME_TICKET' as const,
      credentialId: 'credential-1',
      ticket: ticketValue
    },
    modelId: 'upstream-model-1',
    contextWindowTokens: 100_000,
    maxOutputTokens: 4_096,
    inputCapabilities: ['TEXT' as const, 'IMAGE' as const],
    outputCapabilities: ['TEXT' as const],
    reasoningEfforts: ['high' as const],
    hostedWebSearch: false,
    responsesTransport: { transport: 'WEBSOCKET' as const },
    responsesPreviousResponseId: true,
    imageGeneration: {
      generateEndpoint: 'https://models.example.test/v1/images/generations',
      editEndpoint: 'https://models.example.test/v1/images/edits',
      imageModelId: 'gpt-image-2',
      httpVersion: '1.1' as const
    },
    enabled: true
  };
}

function ticket(
  nonce: string,
  issuedAt: number,
  allowedModelIds: readonly string[] = ['model-1']
): RuntimeCredentialTicket {
  return {
    userId: 1,
    credentialId: 'credential-1',
    nodeId: 'node-1',
    workspaceId: 'workspace-1',
    sessionId: 'session-1',
    runtimeScopeId: 'scope-1',
    allowedModelIds: [...allowedModelIds],
    issuedAt,
    expiresAt: issuedAt + 3_600_000,
    nonce,
    signature: 'a'.repeat(64)
  };
}

function resolvedCredential(revision: number, expiresAt = 120_000) {
  return {
    bearer: `bearer-${revision}`,
    headers: { 'chatgpt-account-id': `account-${revision}` },
    socks5Url: 'socks5://proxy.example.test:1080',
    expiresAt,
    revision
  };
}

function response(replyTo: string, payload: unknown): NodeEnvelope {
  return {
    version: NODE_PROTOCOL_VERSION,
    id: `response-${replyTo}`,
    replyTo,
    type: 'credential.response',
    payload
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
