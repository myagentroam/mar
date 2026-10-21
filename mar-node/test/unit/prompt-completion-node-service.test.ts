import { describe, expect, it, vi } from 'vitest';
import type { GeneratePromptCompletionInput } from '../../src/service/prompt-completion-generator.js';
import type { PromptCompletionContext, PromptCompletionTarget } from '@myagentroam/protocol';
import { PromptCompletionNodeService } from '../../src/service/prompt-completion-node-service.js';
import { MarAgentRuntimeModelFactory } from '../../src/runner/mar-agent/runtime-model-factory.js';

function fixture(
  target: PromptCompletionTarget = { kind: 'WORKSPACE', workspaceId: 'workspace' },
  sessionId: string | null = null
) {
  let observed = true;
  let now = 1_000;
  const actor = {
    __requestUserId: 1,
    __workspaceWatchSessionHash: 'cookie-session',
    __usageGrant: { scopeId: '11111111-1111-4111-8111-111111111111', token: 'fixture-token' }
  };
  const descriptor = {
    target,
    runner: 'codex',
    sessionId,
    workbenchConnectionId: 'connection',
    pageEpoch: 'page'
  };
  const generate = vi.fn(async (_input: GeneratePromptCompletionInput) => ({
    suggestion: 'Check compatibility'
  }));
  const references = vi.fn(async () => [
    { sessionId: 'reference', id: 'message', revision: 1, text: 'Prefer tests' }
  ]);
  const readPage = vi.fn(async () => []);
  const release = vi.fn();
  const usage = { completion: vi.fn(() => ({ release })) };
  const service = new PromptCompletionNodeService({
    generation: () => 'node',
    observed: () => observed,
    readPage,
    references,
    generate,
    usage,
    modelFactory: new MarAgentRuntimeModelFactory({ resolve: vi.fn() }),
    now: () => now
  });
  const runtime = {
    workspaceId: 'workspace',
    authorizationView: 'view',
    expiresAt: 31_000,
    runtimeScopeId: 'scope',
    modelRevision: 'revision',
    credentialScope: 'credential',
    reasoningEffort: 'low',
    model: {
      id: 'model',
      name: 'Model',
      protocol: 'OPENAI_RESPONSES',
      modelId: 'model',
      baseUrl: 'https://model.invalid/v1',
      apiKey: 'fixture-key',
      contextWindowTokens: 32_000,
      maxOutputTokens: 512,
      inputCapabilities: ['TEXT'],
      outputCapabilities: ['TEXT'],
      reasoningEfforts: ['low'],
      titleGeneration: false,
      codeMode: false,
      hostedWebSearch: false,
      responsesToolNamespace: 'functions',
      responsesPreviousResponseId: false,
      enabled: true
    }
  };
  async function call(operation: string, data: unknown) {
    return service.operations()[operation]!(data);
  }
  async function context() {
    return (await call('prompt-completion.context', {
      ...descriptor,
      ...actor
    })) as PromptCompletionContext;
  }
  function request(identity: PromptCompletionContext) {
    return {
      ...actor,
      target,
      workbenchConnectionId: 'connection',
      runtime,
      request: {
        trigger: 'MANUAL',
        completionMode: 'COMPLETE',
        draft: 'Please ',
        cursorPosition: 7,
        draftRevision: 1,
        contextVersion: identity.contextVersion,
        historyGeneration: identity.historyGeneration,
        requestId: 'request',
        pageEpoch: 'page',
        intentSequence: 1,
        runner: 'codex',
        sessionId
      }
    };
  }
  return {
    service,
    call,
    context,
    request,
    readPage,
    references,
    generate,
    usage,
    actor,
    descriptor,
    setObserved: (value: boolean) => {
      observed = value;
    },
    advance: () => {
      now += 2_001;
    }
  };
}

describe('PromptCompletionNodeService', () => {
  it.each([301_000, 301_250])(
    'uses the Server expiry %s without imposing a Node-local lifetime cap',
    async (expiresAt) => {
      const f = fixture();
      try {
        const request = f.request(await f.context());
        request.runtime.expiresAt = expiresAt;
        await expect(f.call('prompt-completion.generate', request)).resolves.toMatchObject({
          status: 'ready',
          expiresAt: 31_000
        });
        expect(f.generate).toHaveBeenCalledOnce();
      } finally {
        f.service.dispose();
      }
    }
  );

  it('still rejects a different workspace and does not generate with expired authorization', async () => {
    const f = fixture();
    try {
      const request = f.request(await f.context());
      request.runtime.workspaceId = 'different-workspace';
      await expect(f.call('prompt-completion.generate', request)).rejects.toThrow(
        'PROMPT_COMPLETION_AUTHORIZATION_INVALID'
      );
      request.runtime.workspaceId = 'workspace';
      request.runtime.expiresAt = 1_000;
      await expect(f.call('prompt-completion.generate', request)).resolves.toMatchObject({
        status: 'skipped',
        reason: 'UNAVAILABLE'
      });
      expect(f.generate).not.toHaveBeenCalled();
      expect(f.usage.completion).not.toHaveBeenCalled();
    } finally {
      f.service.dispose();
    }
  });

  it('retires removed or edited reference history for future requests without cancelling generation', async () => {
    const f = fixture({ kind: 'WORKSPACE', workspaceId: 'workspace' }, 'current');
    try {
      const identity = await f.context();
      const first = f.request(identity);
      expect(await f.call('prompt-completion.generate', first)).toMatchObject({ status: 'ready' });
      f.advance();
      let finish!: (value: { suggestion: string }) => void;
      f.generate.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          })
      );
      const next = (sequence: number) => ({
        ...first,
        request: { ...first.request, requestId: `request-${sequence}`, intentSequence: sequence }
      });
      const pending = f.call('prompt-completion.generate', next(2));
      await vi.waitFor(() => expect(f.generate).toHaveBeenCalledTimes(2));
      expect(f.generate.mock.calls[1]![0].referenceMessages).toContain('Prefer tests');
      f.references.mockResolvedValue([]);
      f.service.invalidateSession('workspace', 'reference');
      expect(f.generate.mock.calls[1]![0].signal.aborted).toBe(false);
      finish({ suggestion: 'Check compatibility' });
      expect(await pending).toMatchObject({ status: 'ready' });
      f.advance();
      expect(await f.call('prompt-completion.generate', next(3))).toMatchObject({
        status: 'ready'
      });
      expect(f.generate.mock.calls[2]![0].referenceMessages).toEqual([]);
      expect(f.references).toHaveBeenCalledTimes(2);
    } finally {
      f.service.dispose();
    }
  });

  it('bounds context preflight time and retains occupancy until a slow reader stops', async () => {
    vi.useFakeTimers();
    const f = fixture();
    let finish!: (value: never[]) => void;
    f.readPage.mockImplementationOnce(
      () =>
        new Promise<never[]>((resolve) => {
          finish = resolve;
        })
    );
    try {
      const pending = f.context();
      const failed = expect(pending).rejects.toThrow('PROMPT_COMPLETION_CONTEXT_TIMEOUT');
      await vi.advanceTimersByTimeAsync(1_001);
      await failed;
      await expect(f.context()).rejects.toThrow('PROMPT_COMPLETION_CONTEXT_BUSY');
      finish([]);
      await vi.advanceTimersByTimeAsync(0);
      expect(await f.context()).toHaveProperty('contextVersion');
      f.service.dispose();
      await expect(f.context()).rejects.toThrow('PROMPT_COMPLETION_UNAVAILABLE');
      expect(f.generate).not.toHaveBeenCalled();
    } finally {
      f.service.dispose();
      vi.useRealTimers();
    }
  });

  it('uses one normalized boundary for four runners and never puts a draft into reference-cache reads', async () => {
    const f = fixture();
    const identity = await f.context();
    expect(f.generate).not.toHaveBeenCalled();
    for (const [index, runner] of ['mar-agent', 'codex', 'claude-code', 'opencode'].entries()) {
      const context = (await f.call('prompt-completion.context', {
        ...f.descriptor,
        runner,
        ...f.actor
      })) as PromptCompletionContext;
      const packet = f.request(context);
      expect(
        await f.call('prompt-completion.generate', {
          ...packet,
          request: {
            ...packet.request,
            runner,
            requestId: `request-${index}`,
            intentSequence: index + 1
          }
        })
      ).toMatchObject({ status: 'ready' });
      f.advance();
    }
    expect(identity.historyGeneration).toBeTruthy();
    expect(f.generate).toHaveBeenCalledTimes(4);
    expect(f.generate.mock.calls[0]![0].referenceMessages).toContain('Prefer tests');
    expect(JSON.stringify(f.references.mock.calls)).not.toContain('Please');
    expect(f.usage.completion).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Object),
      expect.any(String),
      1
    );
    f.service.dispose();
  });

  it('rejects hosted targets without loading history or generating', async () => {
    const f = fixture();
    const identity = await f.context();
    f.readPage.mockClear();
    const packet = {
      ...f.request(identity),
      target: { kind: 'HOSTED_CONVERSATION', conversationId: 'conversation' }
    };
    await expect(f.call('prompt-completion.generate', packet)).rejects.toThrow();
    expect(
      f.service.operations()['conversation.hosted.prompt-completion.generate']
    ).toBeUndefined();
    expect(f.readPage).not.toHaveBeenCalled();
    expect(f.references).not.toHaveBeenCalled();
    expect(f.generate).not.toHaveBeenCalled();
    f.service.dispose();
  });

  it('requires trusted actor metadata and an existing observation before reading context', async () => {
    const f = fixture();
    await expect(f.call('prompt-completion.context', f.descriptor)).rejects.toThrow(
      'USER_AUTHORIZATION_REQUIRED'
    );
    f.setObserved(false);
    await expect(f.context()).rejects.toThrow('PROMPT_COMPLETION_CONTEXT_UNAVAILABLE');
    expect(f.readPage).not.toHaveBeenCalled();
    f.service.dispose();
  });

  it('preserves cancel-before-generate and separates cookie-session ownership', async () => {
    const f = fixture();
    const packet = f.request(await f.context());
    await f.call('prompt-completion.cancel', {
      ...f.actor,
      requestId: 'request',
      pageEpoch: 'page',
      intentSequence: 1
    });
    expect(await f.call('prompt-completion.generate', packet)).toMatchObject({
      status: 'cancelled'
    });
    expect(f.generate).not.toHaveBeenCalled();
    expect(
      await f.call('prompt-completion.generate', {
        ...packet,
        __workspaceWatchSessionHash: 'another-cookie'
      })
    ).toMatchObject({ status: 'ready' });
    f.service.dispose();
  });

  it('invalidates history identities without allowing an old suggestion to be generated', async () => {
    const f = fixture();
    const packet = f.request(await f.context());
    f.service.invalidateWorkspace('workspace');
    expect(await f.call('prompt-completion.generate', packet)).toMatchObject({
      status: 'cancelled'
    });
    expect(f.generate).not.toHaveBeenCalled();
    f.service.dispose();
  });
});
