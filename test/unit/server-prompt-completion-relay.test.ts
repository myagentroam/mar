import { describe, expect, it, vi } from 'vitest';
import {
  marAgentRuntimeModelConfigurationSchema,
  type PromptCompletionConfiguration,
  type PromptCompletionGenerateInput
} from '../../packages/protocol/src/index.js';
import type { CurrentUserSession } from '../../packages/server-core/src/session.js';
import { PromptCompletionRelayService } from '../../packages/server-core/src/prompt-completion-relay-service.js';

function fixture() {
  const actor: CurrentUserSession = {
    userId: 7,
    username: 'user',
    isAdmin: false,
    sessionHash: 'cookie-hash',
    mustChangePassword: false,
    csrfTokenHash: 'csrf-hash'
  };
  let configuration: PromptCompletionConfiguration = {
    enabled: true,
    modelId: 'model',
    reasoningEffort: null
  };
  let now = 1_000;
  const model = marAgentRuntimeModelConfigurationSchema.parse({
    id: 'model',
    name: 'Model',
    protocol: 'OPENAI_RESPONSES',
    modelId: 'model',
    baseUrl: 'https://model.invalid/v1',
    credential: { type: 'INLINE_API_KEY', value: 'fixture-key' },
    contextWindowTokens: 32_000,
    maxOutputTokens: 512,
    inputCapabilities: ['TEXT'],
    outputCapabilities: ['TEXT'],
    reasoningEfforts: ['low'],
    hostedWebSearch: false,
    enabled: true
  });
  const prepare = vi.fn(async () => ({ model, runtimeScopeId: 'scope' }));
  const revalidate = vi.fn(async () => undefined);
  const authorize = vi.fn(async () => ({
    workspaceId: 'workspace',
    authorizationView: 'view',
    revalidate
  }));
  const forward = vi.fn(
    async (
      _actor: CurrentUserSession,
      _nodeId: string,
      _target: unknown,
      operation: string,
      raw: unknown
    ) => {
      if (operation === 'cancel') return { cancelled: true };
      if (operation === 'context')
        return { contextVersion: 'context', historyGeneration: 'generation', progressRevision: 1 };
      const input = raw as PromptCompletionGenerateInput;
      return {
        status: 'ready',
        requestId: input.request.requestId,
        contextVersion: input.request.contextVersion,
        historyGeneration: input.request.historyGeneration,
        draftRevision: input.request.draftRevision,
        cursorPosition: input.request.cursorPosition,
        suggestion: 'Test compatibility',
        source: 'generated',
        expiresAt: 31_000
      };
    }
  );
  const ownsConnection = vi.fn(() => true);
  const canUseModel = vi.fn(async () => true);
  const service = new PromptCompletionRelayService({
    settings: {
      readConfiguration: async () => configuration
    },
    runtimeModels: { preparePromptCompletion: prepare },
    ownsConnection,
    available: async () => true,
    authorize,
    canUseModel,
    forward,
    now: () => now
  });
  const input: PromptCompletionGenerateInput = {
    target: { kind: 'WORKSPACE', workspaceId: 'workspace' },
    workbenchConnectionId: 'connection',
    request: {
      trigger: 'MANUAL',
      completionMode: 'COMPLETE',
      draft: 'Please ',
      cursorPosition: 7,
      draftRevision: 1,
      contextVersion: 'context',
      historyGeneration: 'generation',
      requestId: 'request',
      pageEpoch: 'page',
      intentSequence: 1,
      runner: 'codex',
      sessionId: null
    }
  };
  return {
    service,
    actor,
    input,
    prepare,
    authorize,
    forward,
    ownsConnection,
    canUseModel,
    revalidate,
    setNow: (value: number) => {
      now = value;
    },
    setConfiguration: (value: PromptCompletionConfiguration) => {
      configuration = value;
    }
  };
}

describe('PromptCompletionRelayService', () => {
  it('expires idle page intents by last use even while their connections remain open', async () => {
    const f = fixture();
    for (let index = 0; index < 128; index++) {
      await f.service.cancel(f.actor, 'node', f.input.target, 'connection', {
        requestId: `request-${index}`,
        pageEpoch: `page-${index}`,
        intentSequence: 1
      });
    }
    f.setNow(61_001);
    await expect(
      f.service.cancel(f.actor, 'node', f.input.target, 'connection', {
        requestId: 'fresh',
        pageEpoch: 'fresh',
        intentSequence: 1
      })
    ).resolves.toBeUndefined();
    expect(f.ownsConnection()).toBe(true);
  });

  it('refreshes a repeated cancellation tombstone from the last cancellation time', async () => {
    const f = fixture();
    const cancel = { requestId: 'request', pageEpoch: 'page', intentSequence: 1 };
    await f.service.cancel(f.actor, 'node', f.input.target, 'connection', cancel);
    f.setNow(50_000);
    await f.service.cancel(f.actor, 'node', f.input.target, 'connection', cancel);
    f.setNow(61_001);
    expect(await f.service.generate(f.actor, 'node', f.input)).toMatchObject({
      status: 'cancelled'
    });
    expect(f.prepare).not.toHaveBeenCalled();
  });

  it('authorizes a five-minute runtime, forwards one auxiliary model and returns only the public response', async () => {
    const f = fixture();
    const result = await f.service.generate(f.actor, 'node', f.input);
    expect(result).toMatchObject({ status: 'ready', suggestion: 'Test compatibility' });
    expect(JSON.stringify(result)).not.toContain('fixture-key');
    expect(f.prepare).toHaveBeenCalledExactlyOnceWith({
      userId: 7,
      nodeId: 'node',
      workspaceId: 'workspace',
      selectedModelId: 'model'
    });
    expect(f.forward).toHaveBeenCalledExactlyOnceWith(
      f.actor,
      'node',
      f.input.target,
      'generate',
      expect.objectContaining({
        runtime: expect.objectContaining({
          workspaceId: 'workspace',
          reasoningEffort: 'low',
          expiresAt: 301_000
        })
      }),
      'workspace'
    );
    expect(f.revalidate).toHaveBeenCalledTimes(2);
  });

  it('rejects disabled global configuration before accessing the resource or model', async () => {
    const f = fixture();
    f.setConfiguration({ enabled: false, modelId: null, reasoningEffort: null });
    await expect(f.service.generate(f.actor, 'node', f.input)).rejects.toMatchObject({
      code: 'PROMPT_COMPLETION_DISABLED'
    });
    expect(f.authorize).not.toHaveBeenCalled();
    expect(f.prepare).not.toHaveBeenCalled();
    expect(f.forward).not.toHaveBeenCalled();
  });

  it('registers cancellation before asynchronous authorization finishes', async () => {
    const f = fixture();
    let release!: () => void;
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.authorize.mockImplementationOnce(async () => {
      await wait;
      return { workspaceId: 'workspace', authorizationView: 'view', revalidate: f.revalidate };
    });
    const pending = f.service.generate(f.actor, 'node', f.input);
    await vi.waitFor(() => expect(f.authorize).toHaveBeenCalledOnce());
    await f.service.cancel(f.actor, 'node', f.input.target, 'connection', {
      requestId: 'request',
      pageEpoch: 'page',
      intentSequence: 1
    });
    release();
    expect(await pending).toMatchObject({ status: 'cancelled' });
    expect(f.prepare).not.toHaveBeenCalled();
    expect(f.forward.mock.calls.map((call) => call[3])).toEqual(['cancel']);
  });

  it('preserves cancel-before-generate without requiring configuration or resource access', async () => {
    const f = fixture();
    f.setConfiguration({ enabled: false, modelId: null, reasoningEffort: null });
    await f.service.cancel(f.actor, 'node', f.input.target, 'connection', {
      requestId: 'request',
      pageEpoch: 'page',
      intentSequence: 1
    });
    expect(await f.service.generate(f.actor, 'node', f.input)).toMatchObject({
      status: 'cancelled'
    });
    expect(f.authorize).not.toHaveBeenCalled();
  });

  it('coalesces exact transport replay but not conflicting draft reuse', async () => {
    const f = fixture();
    const first = f.service.generate(f.actor, 'node', f.input);
    expect(f.service.generate(f.actor, 'node', f.input)).toBe(first);
    expect(
      await f.service.generate(f.actor, 'node', {
        ...f.input,
        request: { ...f.input.request, draft: 'Other  ' }
      })
    ).toMatchObject({ status: 'cancelled' });
    await first;
    expect(f.prepare).toHaveBeenCalledOnce();
  });

  it('withholds results if model permission is revoked during generation', async () => {
    const f = fixture();
    f.canUseModel.mockResolvedValue(false);
    await expect(f.service.generate(f.actor, 'node', f.input)).rejects.toMatchObject({
      code: 'MAR_AGENT_MODEL_FORBIDDEN'
    });
  });

  it('preflights context without preparing credentials or starting a model request', async () => {
    const f = fixture();
    expect(
      await f.service.context(f.actor, 'node', {
        target: f.input.target,
        runner: 'codex',
        sessionId: null,
        pageEpoch: 'page',
        workbenchConnectionId: 'connection'
      })
    ).toMatchObject({ contextVersion: 'context' });
    expect(f.prepare).not.toHaveBeenCalled();
    f.ownsConnection.mockReturnValue(false);
    await expect(
      f.service.context(f.actor, 'node', {
        target: f.input.target,
        runner: 'codex',
        sessionId: null,
        pageEpoch: 'page',
        workbenchConnectionId: 'connection'
      })
    ).rejects.toMatchObject({ code: 'WORKBENCH_CONNECTION_NOT_FOUND' });
  });
});
