import { describe, expect, it, vi } from 'vitest';
import type { GeneratePromptCompletionInput } from '../../src/service/prompt-completion-generator.js';
import type { PromptCompletionRequest } from '@myagentroam/protocol';
import {
  PromptCompletionService,
  type CompletionAuthorization
} from '../../src/service/prompt-completion-service.js';
import { MarAgentRuntimeModelFactory } from '../../src/runner/mar-agent/runtime-model-factory.js';
import type { CompletionContextProjection } from '../../src/service/prompt-completion-context.js';

function fixture(
  generate = vi.fn(async (_input: GeneratePromptCompletionInput) => ({
    suggestion: 'Test compatibility' as string | null
  })),
  referenceMessages: readonly string[] = ['Review only current changes']
) {
  let now = 1_000;
  let authorized = true;
  const request: PromptCompletionRequest = {
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
    sessionId: 'session'
  };
  const authorization: CompletionAuthorization = {
    userId: '1',
    scope: { workspaceId: 'workspace', generation: 'node', authorizationView: 'view' },
    expiresAt: 31_000,
    modelRevision: 'model-revision',
    credentialScope: 'credential',
    reasoningEffort: 'low',
    runtimeScopeId: 'runtime',
    executionId: 'execution',
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
  const context: CompletionContextProjection = {
    identity: { contextVersion: 'context', historyGeneration: 'generation', progressRevision: 1 },
    history: [{ id: 'user', revision: 1, role: 'user', text: 'Check changes' }],
    references: [],
    executionSnapshot: '{"status":"RUNNING"}'
  };
  const readContext = vi.fn(async () => context);
  const release = vi.fn();
  const usage = vi.fn(() => ({ release }));
  const factory = new MarAgentRuntimeModelFactory({ resolve: vi.fn() });
  const create = vi.fn(factory.create.bind(factory));
  const record = vi.fn(async (_entry: Readonly<Record<string, unknown>>) => {});
  const service = new PromptCompletionService({
    record,
    modelFactory: { create },
    authorized: () => authorized,
    context: readContext,
    references: async () => referenceMessages,
    usage,
    generate,
    now: () => now
  });
  return {
    record,
    service,
    request,
    authorization,
    context,
    readContext,
    release,
    usage,
    create,
    generate,
    advance: (ms: number) => {
      now += ms;
    },
    revoke: () => {
      authorized = false;
    }
  };
}

function holdRecords(f: ReturnType<typeof fixture>) {
  let release!: () => void;
  let reject!: (error: Error) => void;
  const pending = new Promise<void>((resolve, rejectRecord) => {
    release = resolve;
    reject = rejectRecord;
  });
  f.record.mockReturnValue(pending);
  return { release, reject };
}

describe('PromptCompletionService', () => {
  it.each(['MANUAL', 'AUTO'] as const)(
    'only manual requests generate with no draft or conversation: %s',
    async (trigger) => {
      const f = fixture(undefined, []);
      f.readContext.mockResolvedValueOnce({ ...f.context, history: [] });
      const response = await f.service.generate(
        {
          ...f.request,
          trigger,
          completionMode: 'NEXT',
          draft: '',
          cursorPosition: 0
        },
        f.authorization
      );
      expect(response.status).toBe(trigger === 'MANUAL' ? 'ready' : 'empty');
      if (trigger === 'MANUAL') {
        expect(f.generate).toHaveBeenCalledWith(
          expect.objectContaining({ trigger, history: [], referenceMessages: [] })
        );
      } else {
        expect(f.generate).not.toHaveBeenCalled();
        expect(f.usage).not.toHaveBeenCalled();
      }
      f.service.dispose();
    }
  );

  it('forwards automatic intent and preserves normal abstention with conversation context', async () => {
    const f = fixture(
      vi.fn(async (_input: GeneratePromptCompletionInput) => ({ suggestion: null }))
    );
    await expect(
      f.service.generate(
        { ...f.request, trigger: 'AUTO', completionMode: 'NEXT', draft: '', cursorPosition: 0 },
        f.authorization
      )
    ).resolves.toMatchObject({ status: 'empty' });
    expect(f.generate).toHaveBeenCalledWith(expect.objectContaining({ trigger: 'AUTO' }));
    f.service.dispose();
  });

  it('records inputs, output and status without runtime credentials', async () => {
    const f = fixture();
    await f.service.generate(f.request, f.authorization);
    expect(f.record).toHaveBeenCalledTimes(1);
    expect(f.record.mock.calls[0]![0]).toMatchObject({
      status: 'ready',
      input: { trigger: f.request.trigger, draft: f.request.draft },
      output: 'Test compatibility'
    });
    const entry = JSON.stringify(f.record.mock.calls);
    expect(entry).not.toContain('fixture-key');
    expect(entry).not.toContain('https://model.invalid');
    expect(entry).toContain('Check changes');
    f.service.dispose();
  });

  it('records manual generation failure and releases usage rather than returning empty', async () => {
    const f = fixture();
    f.generate.mockRejectedValueOnce(
      Object.assign(new Error('Invalid prediction output.'), {
        code: 'PROMPT_COMPLETION_GENERATION_FAILED'
      })
    );
    await expect(f.service.generate(f.request, f.authorization)).rejects.toMatchObject({
      code: 'PROMPT_COMPLETION_GENERATION_FAILED'
    });
    expect(f.release).toHaveBeenCalledOnce();
    expect(f.record).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'failed',
        reason: 'PROMPT_COMPLETION_GENERATION_FAILED',
        output: null,
        input: expect.objectContaining({ trigger: 'MANUAL' })
      })
    );
    f.service.dispose();
  });

  it('returns successive generated results while earlier journal records remain pending', async () => {
    const f = fixture();
    const records = holdRecords(f);
    let firstResponse: unknown;
    let secondResponse: unknown;
    const first = f.service.generate(f.request, f.authorization).then((value) => {
      firstResponse = value;
    });
    let second: Promise<void> | undefined;
    try {
      await vi.waitFor(() =>
        expect(firstResponse).toMatchObject({ status: 'ready', suggestion: 'Test compatibility' })
      );
      expect(f.release).toHaveBeenCalledOnce();
      f.advance(2_001);
      second = f.service
        .generate({ ...f.request, requestId: 'second', intentSequence: 2 }, f.authorization)
        .then((value) => {
          secondResponse = value;
        });
      await vi.waitFor(() =>
        expect(secondResponse).toMatchObject({ status: 'ready', requestId: 'second' })
      );
      expect(f.record).toHaveBeenCalledTimes(2);
      expect(f.generate).toHaveBeenCalledTimes(2);
      expect(f.release).toHaveBeenCalledTimes(2);
    } finally {
      records.release();
      await Promise.all([first, second]);
      f.service.dispose();
    }
  });

  it('returns the original generation error before a pending record later rejects', async () => {
    const f = fixture();
    const records = holdRecords(f);
    const generationError = Object.assign(new Error('Private provider failure'), {
      code: 'PROMPT_COMPLETION_GENERATION_FAILED'
    });
    f.generate.mockRejectedValueOnce(generationError);
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let outcome: unknown;
    const result = f.service.generate(f.request, f.authorization).catch((error: unknown) => {
      outcome = error;
    });
    try {
      await vi.waitFor(() => expect(outcome).toBe(generationError));
      expect(f.release).toHaveBeenCalledOnce();
      expect(warning).not.toHaveBeenCalled();
      records.reject(new Error('Private journal path and contents'));
      // The late rejection must be handled even after the caller receives its error.
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(warning.mock.calls).toEqual([['PROMPT_COMPLETION_JOURNAL_WRITE_FAILED']]);
      expect(f.record).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'failed',
          reason: 'PROMPT_COMPLETION_GENERATION_FAILED',
          output: null
        })
      );
    } finally {
      records.release();
      await result;
      warning.mockRestore();
      f.service.dispose();
    }
  });

  it.each([
    { recordFailure: 'throw', generationFails: false },
    { recordFailure: 'reject', generationFails: false },
    { recordFailure: 'throw', generationFails: true },
    { recordFailure: 'reject', generationFails: true }
  ])(
    'preserves generation outcome when record fails: $recordFailure, generationFails=$generationFails',
    async ({ recordFailure, generationFails }) => {
      const f = fixture();
      const generationError = Object.assign(new Error('Private provider failure'), {
        code: 'PROMPT_COMPLETION_GENERATION_FAILED'
      });
      const recordError = new Error('Private journal path and contents');
      const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
      if (generationFails) f.generate.mockRejectedValueOnce(generationError);
      f.record.mockImplementationOnce(() => {
        if (recordFailure === 'throw') throw recordError;
        return Promise.reject(recordError);
      });
      try {
        const result = f.service.generate(f.request, f.authorization);
        if (generationFails) await expect(result).rejects.toBe(generationError);
        else
          await expect(result).resolves.toMatchObject({
            status: 'ready',
            suggestion: 'Test compatibility'
          });
        // Cross an event-loop turn so an unhandled rejection would reach the test runner.
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(warning.mock.calls).toEqual([['PROMPT_COMPLETION_JOURNAL_WRITE_FAILED']]);
        expect(f.release).toHaveBeenCalledOnce();
        expect(f.record).toHaveBeenCalledWith(
          expect.objectContaining({
            status: generationFails ? 'failed' : 'ready',
            output: generationFails ? null : 'Test compatibility',
            reason: generationFails ? 'PROMPT_COMPLETION_GENERATION_FAILED' : undefined
          })
        );
      } finally {
        warning.mockRestore();
        f.service.dispose();
      }
    }
  );

  it('keeps per-user limits across pages, cache invalidation and model failures', async () => {
    const f = fixture();
    await f.service.generate(f.request, f.authorization);
    f.service.invalidateWorkspace('workspace');
    expect(
      await f.service.generate({ ...f.request, pageEpoch: 'another' }, f.authorization)
    ).toMatchObject({ status: 'skipped', reason: 'RATE_LIMITED', retryAfterMs: 2_000 });
    f.advance(2_000);
    f.generate.mockRejectedValueOnce(new Error('PROVIDER_FAILURE'));
    await expect(
      f.service.generate({ ...f.request, pageEpoch: 'third' }, f.authorization)
    ).rejects.toThrow('PROVIDER_FAILURE');
    expect(
      await f.service.generate({ ...f.request, pageEpoch: 'fourth' }, f.authorization)
    ).toMatchObject({ status: 'skipped', reason: 'RATE_LIMITED' });
    expect(f.generate).toHaveBeenCalledTimes(2);
    f.service.dispose();
  });

  it('limits the rolling minute independently of two-second spacing', async () => {
    const f = fixture();
    const authorization = { ...f.authorization, expiresAt: 120_000 };
    for (let index = 1; index <= 20; index++) {
      expect(
        await f.service.generate(
          {
            ...f.request,
            draft: `Check ${index}`,
            cursorPosition: 0,
            intentSequence: index,
            requestId: `request-${index}`
          },
          authorization
        )
      ).toMatchObject({ status: 'ready' });
      f.advance(2_000);
    }
    expect(
      await f.service.generate(
        {
          ...f.request,
          draft: 'Another',
          cursorPosition: 0,
          intentSequence: 21,
          requestId: 'last'
        },
        authorization
      )
    ).toMatchObject({ status: 'skipped', reason: 'RATE_LIMITED', retryAfterMs: 20_000 });
    f.service.dispose();
  });

  it('returns immediately on cancellation without freeing physical capacity before cleanup', async () => {
    let finish!: (value: { suggestion: string | null }) => void;
    const f = fixture(
      vi.fn(
        (_input: GeneratePromptCompletionInput) =>
          new Promise((resolve) => {
            finish = resolve;
          })
      )
    );
    const first = f.service.generate(f.request, f.authorization);
    await vi.waitFor(() => expect(f.generate).toHaveBeenCalledTimes(1));
    f.service.cancel('1', { requestId: 'request', pageEpoch: 'page', intentSequence: 1 });
    expect(await first).toMatchObject({ status: 'cancelled' });
    expect(f.release).not.toHaveBeenCalled();
    expect(
      await f.service.generate({ ...f.request, pageEpoch: 'other' }, f.authorization)
    ).toMatchObject({ status: 'skipped', reason: 'IN_FLIGHT' });
    finish({ suggestion: 'late' });
    await vi.waitFor(() => expect(f.release).toHaveBeenCalledTimes(1));
    f.service.dispose();
  });

  it('retains page watermarks until their last refresh expires and rejects closed pages', async () => {
    const f = fixture();
    await f.service.generate(f.request, f.authorization);
    f.service.cancel('1', { requestId: 'request', pageEpoch: 'page', intentSequence: 1 });
    f.advance(59_000);
    const authorization = { ...f.authorization, expiresAt: 100_000 };
    expect(await f.service.generate(f.request, authorization)).toMatchObject({
      status: 'cancelled'
    });
    f.service.releasePage('1', 'page');
    expect(
      await f.service.generate({ ...f.request, requestId: 'new', intentSequence: 2 }, authorization)
    ).toMatchObject({ status: 'cancelled' });
    expect(f.generate).toHaveBeenCalledTimes(1);
    f.service.dispose();
  });

  it('retains cancellation watermarks for the full five-minute runtime authorization', async () => {
    const f = fixture();
    const authorization = { ...f.authorization, expiresAt: 301_000 };
    f.service.cancel('1', {
      requestId: f.request.requestId,
      pageEpoch: f.request.pageEpoch,
      intentSequence: f.request.intentSequence
    });
    f.advance(299_000);
    expect(await f.service.generate(f.request, authorization)).toMatchObject({
      status: 'cancelled'
    });
    expect(f.generate).not.toHaveBeenCalled();
    f.service.dispose();
  });

  it('keeps the twelve-second generation deadline with five-minute authorization', async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const f = fixture(
      vi.fn(async (input: GeneratePromptCompletionInput) => {
        signal = input.signal;
        return new Promise<{ suggestion: string | null }>((resolve) => {
          input.signal.addEventListener('abort', () => resolve({ suggestion: null }), {
            once: true
          });
        });
      })
    );
    const records = holdRecords(f);
    try {
      const result = f.service.generate(f.request, { ...f.authorization, expiresAt: 301_000 });
      await vi.advanceTimersByTimeAsync(11_999);
      expect(f.generate).toHaveBeenCalledOnce();
      expect(signal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await expect(result).resolves.toMatchObject({ status: 'cancelled' });
      expect(signal?.aborted).toBe(true);
      expect(f.release).toHaveBeenCalledOnce();
      expect(f.record).toHaveBeenCalledWith(expect.objectContaining({ status: 'cancelled' }));
    } finally {
      records.release();
      f.service.dispose();
      vi.useRealTimers();
    }
  });

  it('reclaims expired pages and cancel-only tombstones regardless of observation', async () => {
    const f = fixture();
    for (let index = 0; index < 128; index++)
      f.service.cancel('1', {
        requestId: 'cancel',
        pageEpoch: `closed-${index}`,
        intentSequence: 1
      });
    f.advance(361_000);
    const authorization = { ...f.authorization, expiresAt: 700_000 };
    expect(await f.service.generate(f.request, authorization)).toMatchObject({ status: 'ready' });
    f.advance(361_000);
    expect(
      await f.service.generate(f.request, { ...authorization, expiresAt: 1_000_000 })
    ).toMatchObject({ status: 'ready' });
    f.service.dispose();
  });

  it('generates fresh predictions for identical manual requests while reusing material and provider affinity', async () => {
    const f = fixture();
    const first = await f.service.generate(f.request, f.authorization);
    expect(first).toMatchObject({ status: 'ready', source: 'generated', requestId: 'request' });
    f.advance(2_001);
    const second = await f.service.generate(
      { ...f.request, requestId: 'second', intentSequence: 2 },
      f.authorization
    );
    expect(second).toMatchObject({ status: 'ready', source: 'generated', requestId: 'second' });
    expect(f.generate).toHaveBeenCalledTimes(2);
    expect(f.usage).toHaveBeenCalledTimes(2);
    expect(f.release).toHaveBeenCalledTimes(2);
    expect(f.generate.mock.calls[1]![0].promptCacheKey).toBe(
      f.generate.mock.calls[0]![0].promptCacheKey
    );
    expect(f.generate.mock.calls[0]?.[0]).toMatchObject({
      draft: 'Please ',
      cursorPosition: 7,
      executionSnapshot: '{"status":"RUNNING"}',
      referenceMessages: ['Review only current changes']
    });
    expect(f.create.mock.calls[0]?.[1]).toEqual({
      runtimeScopeId: 'runtime',
      executionId: 'execution'
    });
    f.service.dispose();
  });

  it('does not reuse results across users, drafts, cursor positions, model revisions or credential scopes', async () => {
    const f = fixture();
    await f.service.generate(f.request, f.authorization);
    const cases = [
      { authorization: { ...f.authorization, userId: '2' } },
      { authorization: { ...f.authorization, modelRevision: 'different' } },
      { authorization: { ...f.authorization, credentialScope: 'different' } },
      { draft: 'Please test ', cursorPosition: 12 },
      { cursorPosition: 0 }
    ];
    for (const [index, change] of cases.entries()) {
      f.advance(2_001);
      const { authorization = f.authorization, ...draft } = change;
      expect(
        await f.service.generate(
          { ...f.request, ...draft, requestId: String(index), intentSequence: index + 2 },
          authorization
        )
      ).toMatchObject({ status: 'ready', source: 'generated' });
    }
    expect(f.generate).toHaveBeenCalledTimes(6);
    f.service.dispose();
  });

  it('rejects AUTO and denied requests but snapshots current context after preflight changes', async () => {
    const f = fixture();
    await expect(
      f.service.generate({ ...f.request, trigger: 'AUTO' }, f.authorization)
    ).rejects.toThrow();
    expect(
      await f.service.generate({ ...f.request, contextVersion: 'old' }, f.authorization)
    ).toMatchObject({ status: 'ready', source: 'generated' });
    f.revoke();
    expect(
      await f.service.generate({ ...f.request, intentSequence: 2 }, f.authorization)
    ).toMatchObject({ status: 'skipped', reason: 'UNAVAILABLE' });
    expect(f.generate).toHaveBeenCalledTimes(1);
    f.service.dispose();
  });

  it('keeps cancel-before-generate tombstones per authenticated user and page', async () => {
    const f = fixture();
    f.service.cancel('1', { requestId: 'request', pageEpoch: 'page', intentSequence: 1 });
    expect(await f.service.generate(f.request, f.authorization)).toMatchObject({
      status: 'cancelled'
    });
    expect(await f.service.generate(f.request, { ...f.authorization, userId: '2' })).toMatchObject({
      status: 'ready'
    });
    expect(f.generate).toHaveBeenCalledTimes(1);
    f.service.dispose();
  });

  it('cancels an active request and discards late results', async () => {
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    let finish!: (value: { suggestion: string }) => void;
    const generate = vi.fn((_input: GeneratePromptCompletionInput) => {
      started();
      return new Promise<{ suggestion: string }>((resolve) => {
        finish = resolve;
      });
    });
    const f = fixture(generate);
    const records = holdRecords(f);
    const pending = f.service.generate(f.request, f.authorization);
    try {
      await ready;
      expect(
        await f.service.generate({ ...f.request, intentSequence: 2 }, f.authorization)
      ).toMatchObject({ status: 'skipped', reason: 'IN_FLIGHT' });
      f.service.cancel('1', { requestId: 'request', pageEpoch: 'page', intentSequence: 1 });
      expect(generate.mock.calls[0]?.[0].signal.aborted).toBe(true);
      finish({ suggestion: 'late' });
      expect(await pending).toMatchObject({ status: 'cancelled' });
      expect(f.release).toHaveBeenCalledTimes(1);
      expect(f.record).toHaveBeenCalledWith(expect.objectContaining({ status: 'cancelled' }));
    } finally {
      records.release();
      finish({ suggestion: 'late' });
      await pending;
      f.service.dispose();
    }
  });

  it('rechecks authorization without rejecting normal conversation updates', async () => {
    const f = fixture();
    f.generate.mockImplementation(async () => {
      f.revoke();
      return { suggestion: 'late' };
    });
    expect(await f.service.generate(f.request, f.authorization)).toMatchObject({
      status: 'cancelled'
    });
    const other = fixture();
    other.readContext.mockResolvedValueOnce(other.context).mockResolvedValue({
      ...other.context,
      identity: { ...other.context.identity, contextVersion: 'changed' }
    });
    expect(await other.service.generate(other.request, other.authorization)).toMatchObject({
      status: 'ready',
      source: 'generated'
    });
    expect(other.readContext).toHaveBeenCalledTimes(1);
    f.service.dispose();
    other.service.dispose();
  });

  it('retains usage on model failure and never retries', async () => {
    const f = fixture();
    f.generate.mockRejectedValueOnce(new Error('MODEL_FAILED'));
    await expect(f.service.generate(f.request, f.authorization)).rejects.toThrow('MODEL_FAILED');
    expect(f.release).toHaveBeenCalledTimes(1);
    expect(f.generate).toHaveBeenCalledTimes(1);
    f.service.dispose();
  });
});
