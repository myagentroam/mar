import { afterEach, describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import { PromptCompletionClientService } from '../../src/service/prompt-completion-client-service.js';
import {
  createPromptCompletionPreferenceService,
  PROMPT_COMPLETION_STORAGE_KEY
} from '../../src/service/prompt-completion-preference-service.js';

function fixture() {
  const connection = ref<string | undefined>('connection');
  const key = ref('view');
  const enabled = ref(true);
  const context = { contextVersion: 'context', historyGeneration: 'history', progressRevision: 1 };
  const request = vi.fn(async (path: string, init?: RequestInit): Promise<unknown> => {
    if (path.endsWith('/context')) return context;
    if (path.endsWith('/cancel')) return { cancelled: true };
    const body = JSON.parse(init!.body as string).request;
    return {
      requestId: body.requestId,
      cursorPosition: body.cursorPosition,
      draftRevision: body.draftRevision,
      contextVersion: body.contextVersion,
      historyGeneration: body.historyGeneration,
      status: 'ready',
      suggestion: ' tests',
      source: 'generated',
      expiresAt: Date.now() + 30_000
    };
  });
  const client = new PromptCompletionClientService({
    connectionId: () => connection.value,
    request: async <T>(path: string, init?: RequestInit) => (await request(path, init)) as T
  });
  const binding = client.bind({
    enabled: () => enabled.value,
    target: () => ({
      nodeId: 'node',
      runner: 'codex',
      sessionId: key.value,
      target: { kind: 'WORKSPACE', workspaceId: 'workspace' }
    })
  });
  return { client, binding, request, connection, key, enabled, context };
}

describe('Prompt completion page transport', () => {
  it('projects reply and terminal versions independently without model requests', () => {
    const f = fixture();
    const reply = ref('reply-version');
    const terminal = ref('');
    const contextRevision = ref('before-browsing');
    const binding = f.client.bind({
      enabled: () => true,
      automaticKey: () => reply.value,
      automaticTerminalKey: () => terminal.value,
      readContextRevision: () => contextRevision.value,
      target: () => ({
        nodeId: 'node',
        runner: 'codex',
        sessionId: 'session',
        target: { kind: 'WORKSPACE', workspaceId: 'workspace' }
      })
    });
    expect(binding.value.automaticTerminalKey).toBe('');
    terminal.value = 'turn-ended';
    expect(binding.value.automaticKey).toBe('reply-version');
    expect(binding.value.automaticTerminalKey).toBe('turn-ended');
    expect(binding.value.readContextRevision?.()).toBe('before-browsing');
    contextRevision.value = 'after-browsing';
    expect(binding.value.readContextRevision?.()).toBe('after-browsing');
    expect(f.request).not.toHaveBeenCalled();
  });

  it('only preflights and generates after an explicit request, with exact cursor and draft', async () => {
    const f = fixture();
    expect(f.binding.value.enabled).toBe(true);
    f.key.value = 'agent-progress';
    f.connection.value = 'new-connection';
    expect(f.request).not.toHaveBeenCalled();
    expect(
      (
        await f.binding.value.request(
          { text: 'Check now', cursor: 5 },
          new AbortController().signal
        )
      ).status
    ).toBe('ready');
    expect(f.request).toHaveBeenCalledTimes(2);
    const data = JSON.parse(f.request.mock.calls[1]![1]!.body as string);
    expect(data.request).toMatchObject({
      draft: 'Check now',
      cursorPosition: 5,
      trigger: 'MANUAL',
      completionMode: 'REWRITE',
      runner: 'codex',
      contextVersion: 'context',
      historyGeneration: 'history'
    });
    expect(data).not.toHaveProperty('runtime');
  });
  it('sends an independent cancellation while context preflight is pending and never generates afterward', async () => {
    const f = fixture();
    let release!: (value: unknown) => void;
    f.request.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        })
    );
    const controller = new AbortController();
    const pending = f.binding.value.request({ text: '', cursor: 0 }, controller.signal);
    controller.abort();
    expect(f.request.mock.calls[1]![0]).toMatch(/\/cancel$/);
    expect(f.request.mock.calls[1]![1]!.signal?.aborted).toBe(false);
    release(f.context);
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(f.request).toHaveBeenCalledTimes(2);
  });
  it('rejects stale resource bindings before network access and separates connection epochs', async () => {
    const f = fixture();
    const old = f.binding.value;
    f.key.value = 'another-resource';
    await expect(
      old.request({ text: '', cursor: 0 }, new AbortController().signal)
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(f.request).not.toHaveBeenCalled();
    await f.binding.value.request({ text: '', cursor: 0 }, new AbortController().signal);
    const first = JSON.parse(f.request.mock.calls[1]![1]!.body as string).request;
    f.connection.value = 'replacement';
    await f.binding.value.request({ text: '', cursor: 0 }, new AbortController().signal);
    const next = JSON.parse(f.request.mock.calls[3]![1]!.body as string).request;
    expect(next.pageEpoch).not.toBe(first.pageEpoch);
  });
  it('keeps an in-flight prediction when conversation state advances', async () => {
    const f = fixture();
    const binding = f.binding.value;
    const key = binding.contextKey;
    const pending = binding.request({ text: 'Check', cursor: 5 }, new AbortController().signal);
    f.context.contextVersion = 'new-message-and-goal';
    f.context.progressRevision++;
    expect(f.binding.value.contextKey).toBe(key);
    await expect(pending).resolves.toMatchObject({ status: 'ready' });
    expect(f.request.mock.calls.some(([path]) => path.endsWith('/cancel'))).toBe(false);
  });
  it('preserves AUTO intent through the existing context and generation relay', async () => {
    const f = fixture();
    await f.binding.value.request(
      { text: '', cursor: 0 },
      new AbortController().signal,
      undefined,
      'AUTO'
    );
    const call = f.request.mock.calls.find(([path]) => path.endsWith('/generate'))!;
    expect(JSON.parse(call[1]!.body as string).request).toMatchObject({
      trigger: 'AUTO',
      completionMode: 'NEXT',
      draft: ''
    });
  });
  it('rejects mismatched response identities', async () => {
    const f = fixture();
    f.request.mockResolvedValueOnce(f.context).mockResolvedValueOnce({
      contextVersion: 'context',
      historyGeneration: 'history',
      requestId: 'other',
      draftRevision: 1,
      cursorPosition: 0,
      status: 'empty'
    });
    await expect(
      f.binding.value.request({ text: '', cursor: 0 }, new AbortController().signal)
    ).rejects.toMatchObject({ name: 'AbortError' });
  });
});

afterEach(() => vi.unstubAllGlobals());

describe('Prompt completion browser preferences', () => {
  function storageFixture(stored: string | null = null) {
    const values = new Map<string, string>();
    if (stored !== null) values.set(PROMPT_COMPLETION_STORAGE_KEY, stored);
    const storage = {
      getItem: vi.fn((key: string) => values.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => {
        values.set(key, value);
      })
    };
    vi.stubGlobal('localStorage', storage);
    return { values, storage };
  }

  it.each([null, '', 'invalid', '{"work":true}'])(
    'defaults on for absent or invalid browser value %s without writing',
    (stored) => {
      const { storage } = storageFixture(stored);
      expect(createPromptCompletionPreferenceService().enabled.value).toBe(true);
      expect(storage.setItem).not.toHaveBeenCalled();
    }
  );

  it('preserves an explicitly saved disabled preference', () => {
    const { storage } = storageFixture('false');
    expect(createPromptCompletionPreferenceService().enabled.value).toBe(false);
    expect(storage.setItem).not.toHaveBeenCalled();
  });

  it('immediately persists changes locally and restores them in a new instance', () => {
    const { storage } = storageFixture();
    const service = createPromptCompletionPreferenceService();
    service.setEnabled(true);
    expect(service.enabled.value).toBe(true);
    expect(storage.setItem).toHaveBeenLastCalledWith(PROMPT_COMPLETION_STORAGE_KEY, 'true');
    const restored = createPromptCompletionPreferenceService();
    expect(restored.enabled.value).toBe(true);
    restored.setEnabled(false);
    expect(restored.enabled.value).toBe(false);
    expect(createPromptCompletionPreferenceService().enabled.value).toBe(false);
  });

  it('uses the enabled default when browser storage cannot be read', () => {
    const { storage } = storageFixture();
    storage.getItem.mockImplementation(() => {
      throw new Error('Storage unavailable');
    });
    expect(createPromptCompletionPreferenceService().enabled.value).toBe(true);
  });

  it('does not report a saved value when browser persistence fails', () => {
    const { storage } = storageFixture('false');
    const service = createPromptCompletionPreferenceService();
    storage.setItem.mockImplementation(() => {
      throw new Error('Storage unavailable');
    });
    expect(() => service.setEnabled(true)).toThrow('Storage unavailable');
    expect(service.enabled.value).toBe(false);
  });
});
