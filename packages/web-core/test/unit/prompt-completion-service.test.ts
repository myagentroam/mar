import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PromptCompletionResponse } from '@myagentroam/protocol';
import {
  PromptCompletionService,
  promptCompletionAutomaticKey,
  promptCompletionAutomaticTerminalKey,
  type CompletionAutomaticReason
} from '../../src/service/prompt-completion-service';

function fixture(
  canRequest = () => true,
  canAutomaticRequest?: (reason: CompletionAutomaticReason) => boolean
) {
  let draft = { text: 'Check suffix', cursor: 6 };
  let contextRevision = 'initial';
  let resolve!: (value: PromptCompletionResponse) => void;
  const request = vi.fn(
    (_draft, _signal: AbortSignal, _trigger?: string) =>
      new Promise<PromptCompletionResponse>((r) => {
        resolve = r;
      })
  );
  const apply = vi.fn(() => true);
  const feedback = vi.fn();
  const service = new PromptCompletionService({
    readDraft: () => draft,
    canRequest,
    readContextRevision: () => contextRevision,
    ...(canAutomaticRequest === undefined ? {} : { canAutomaticRequest }),
    request,
    apply,
    feedback,
    changed: vi.fn()
  });
  const ready = () =>
    resolve({
      status: 'ready',
      suggestion: 'API ',
      source: 'generated',
      expiresAt: Date.now() + 30_000,
      requestId: 'r',
      contextVersion: 'c',
      historyGeneration: 'h',
      draftRevision: 1,
      cursorPosition: 6
    });
  return {
    service,
    setContextRevision: (value: string) => {
      contextRevision = value;
    },
    request,
    apply,
    feedback,
    ready,
    resolve: (value: PromptCompletionResponse) => resolve(value),
    setDraft: (text: string, cursor: number) => {
      draft = { text, cursor };
    }
  };
}

afterEach(() => vi.useRealTimers());

it('preserves transport error identity and diagnostics for the shared presenter', async () => {
  const f = fixture();
  const error = Object.assign(new Error('The resource is unavailable.'), {
    code: 'PROMPT_COMPLETION_UNAVAILABLE',
    requestId: 'request-1'
  });
  f.request.mockRejectedValueOnce(error);
  await f.service.request();
  expect(f.feedback).toHaveBeenCalledWith('PROMPT_COMPLETION_FAILED', error);
  expect(f.service.state.kind).toBe('idle');
});

describe('Manual prompt completion intents', () => {
  it('only requests after two independent Tabs and retains focus on timeout', async () => {
    vi.useFakeTimers();
    const f = fixture();
    expect(f.service.tab()).toBe(true);
    expect(f.service.tab(true)).toBe(true);
    expect(f.request).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(300);
    expect(f.service.armed).toBe(false);
    f.service.tab();
    f.service.tab();
    expect(f.request).toHaveBeenCalledTimes(1);
    f.service.dispose();
  });

  it('cancels immediately on one Tab and discards a late result', async () => {
    vi.useFakeTimers();
    const f = fixture();
    void f.service.request();
    const signal = f.request.mock.calls[0]![1];
    f.service.tab();
    f.ready();
    await Promise.resolve();
    await Promise.resolve();
    expect(f.service.state.kind).toBe('idle');
    expect(signal.aborted).toBe(true);
    expect(f.apply).not.toHaveBeenCalled();
    expect(f.request).toHaveBeenCalledTimes(1);
    expect(f.service.state.kind).toBe('idle');
  });

  it('retains cancellation after a pending single Tab', async () => {
    vi.useFakeTimers();
    const f = fixture();
    void f.service.request();
    f.service.tab();
    f.ready();
    await vi.advanceTimersByTimeAsync(300);
    expect(f.apply).not.toHaveBeenCalled();
    expect(f.service.armed).toBe(false);
    expect(f.service.state.kind).toBe('idle');
  });

  it('accepts a ready insertion against the exact original draft', async () => {
    const f = fixture();
    const pending = f.service.request();
    f.ready();
    await pending;
    f.service.tab();
    expect(f.apply).toHaveBeenCalledWith({ text: 'Check suffix', cursor: 6 }, 'API ');
    expect(f.service.state.kind).toBe('idle');
  });

  it('preserves predictions across cursor moves but rejects cancellation', async () => {
    const f = fixture();
    const pending = f.service.request();
    f.setDraft('Check suffix', 2);
    f.ready();
    await pending;
    expect(f.service.state.kind).toBe('ready');
    expect(f.apply).not.toHaveBeenCalled();
    const second = f.service.request();
    f.service.cancel();
    f.ready();
    await second;
    expect(f.service.state.kind).toBe('idle');
  });

  it('shows an empty result briefly in the status state without a toast or retry', async () => {
    vi.useFakeTimers();
    const f = fixture();
    const pending = f.service.request();
    f.resolve({
      status: 'empty',
      requestId: 'r',
      contextVersion: 'c',
      historyGeneration: 'h',
      draftRevision: 1,
      cursorPosition: 6
    });
    await pending;
    expect(f.service.state).toEqual({ kind: 'idle', notice: 'empty' });
    expect(f.feedback).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(f.service.state).toEqual({ kind: 'idle' });
    expect(f.request).toHaveBeenCalledTimes(1);
    f.service.dispose();
  });

  it('clears delayed navigation on cancel and never starts automatic retries', async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.service.tab();
    f.service.cancel();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(f.service.armed).toBe(false);
    expect(f.request).not.toHaveBeenCalled();
  });
});

describe('Automatic prompt prediction', () => {
  it('drops a queued ending when the latest turn is no longer terminal', async () => {
    vi.useFakeTimers();
    const f = fixture(
      () => false,
      (reason) => reason === 'TURN_END'
    );
    f.setDraft('', 0);
    f.service.automaticSignal('ended', 'TURN_END');
    await vi.advanceTimersByTimeAsync(400);
    f.service.automaticSignal('', 'TURN_END');
    f.service.automaticSignal('next-turn-reply');
    await vi.advanceTimersByTimeAsync(16_000);
    expect(f.request).not.toHaveBeenCalled();
    f.service.dispose();
  });

  it('allows an unfocused turn ending but not replies or manual requests, without late-text duplicate endings', async () => {
    vi.useFakeTimers();
    const f = fixture(
      () => false,
      (reason) => reason === 'TURN_END'
    );
    f.setDraft('', 0);
    await f.service.request();
    f.service.automaticSignal('reply-1');
    await vi.advanceTimersByTimeAsync(750);
    expect(f.request).not.toHaveBeenCalled();
    f.service.automaticSignal('turn-ended', 'TURN_END');
    f.service.automaticSignal('reply-2');
    await vi.advanceTimersByTimeAsync(750);
    expect(f.request).toHaveBeenCalledOnce();
    expect(f.request.mock.calls[0]![2]).toBe('AUTO');
    f.ready();
    await vi.advanceTimersByTimeAsync(1);
    f.service.automaticSignal('turn-ended', 'TURN_END');
    f.service.automaticSignal('late-final-text');
    await vi.advanceTimersByTimeAsync(16_000);
    expect(f.request).toHaveBeenCalledOnce();
    f.setDraft('Keep my draft', 0);
    f.service.automaticSignal('next-turn-ended', 'TURN_END');
    await vi.advanceTimersByTimeAsync(16_000);
    expect(f.request).toHaveBeenCalledOnce();
    f.service.dispose();
  });

  it('preserves turn-ending priority through in-flight generation and browser foreground recovery', async () => {
    vi.useFakeTimers();
    let focused = true,
      foreground = true;
    const f = fixture(
      () => focused && foreground,
      (reason) => foreground && (reason === 'TURN_END' || focused)
    );
    f.setDraft('', 0);
    void f.service.request();
    focused = false;
    f.service.automaticSignal('ended', 'TURN_END');
    f.service.automaticSignal('later-reply');
    foreground = false;
    f.ready();
    await vi.advanceTimersByTimeAsync(16_000);
    expect(f.request).toHaveBeenCalledOnce();
    foreground = true;
    f.service.wakeAutomatic();
    await vi.advanceTimersByTimeAsync(750);
    expect(f.request).toHaveBeenCalledTimes(2);
    expect(f.request.mock.calls[1]![2]).toBe('AUTO');
    f.service.dispose();
  });

  it('establishes terminal history baselines without replaying completed turns after navigation', async () => {
    vi.useFakeTimers();
    const f = fixture(
      () => false,
      (reason) => reason === 'TURN_END'
    );
    f.setDraft('', 0);
    f.service.automaticSignal('old-session-ended', 'TURN_END');
    f.service.automaticBaseline('loaded-reply', 'loaded-ending');
    f.service.automaticSignal('loaded-ending', 'TURN_END');
    f.service.wakeAutomatic();
    await vi.advanceTimersByTimeAsync(16_000);
    expect(f.request).not.toHaveBeenCalled();
    f.service.automaticSignal('new-ending', 'TURN_END');
    await vi.advanceTimersByTimeAsync(750);
    expect(f.request).toHaveBeenCalledOnce();
    f.service.dispose();
  });

  it('waits one second on entry and coalesces replies, endings and focus without extending the wait', async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.setDraft('', 0);
    f.service.automaticBaseline('loaded', '');
    f.service.automaticEnter();
    await vi.advanceTimersByTimeAsync(500);
    f.service.automaticSignal('reply');
    f.service.automaticSignal('ended', 'TURN_END');
    f.service.automaticFocus();
    await vi.advanceTimersByTimeAsync(499);
    expect(f.request).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(f.request).toHaveBeenCalledOnce();
    f.ready();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(f.request).toHaveBeenCalledOnce();
    f.service.dispose();
  });

  it('keeps an entry check until history is ready even when early focus could not request', async () => {
    vi.useFakeTimers();
    let loaded = false;
    const f = fixture(
      () => false,
      (reason) => loaded && reason === 'ENTER'
    );
    f.setDraft('', 0);
    f.service.automaticBaseline();
    f.service.automaticEnter();
    f.service.automaticFocus();
    await vi.advanceTimersByTimeAsync(1200);
    expect(f.request).not.toHaveBeenCalled();
    loaded = true;
    f.service.automaticBaseline('loaded', '');
    await vi.advanceTimersByTimeAsync(0);
    expect(f.request).toHaveBeenCalledOnce();
    f.service.dispose();
  });

  it('drops short visits and does not carry the previous conversation cooldown into a new visit', async () => {
    vi.useFakeTimers();
    const f = fixture(
      () => false,
      (reason) => reason === 'ENTER'
    );
    f.setDraft('', 0);
    f.service.automaticBaseline('session-a', '');
    f.service.automaticEnter();
    await vi.advanceTimersByTimeAsync(600);
    f.service.cancel();
    f.service.automaticBaseline('session-b', '');
    f.service.automaticEnter();
    await vi.advanceTimersByTimeAsync(400);
    expect(f.request).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(600);
    expect(f.request).toHaveBeenCalledOnce();
    f.ready();
    await vi.advanceTimersByTimeAsync(0);
    f.service.cancel();
    f.service.automaticBaseline('session-c', '');
    f.service.automaticEnter();
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.request).toHaveBeenCalledTimes(2);
    f.service.dispose();
  });

  it('retains an unfocused entry check in the background without replaying a completed visit', async () => {
    vi.useFakeTimers();
    let foreground = false;
    const f = fixture(
      () => false,
      (reason) => foreground && reason === 'ENTER'
    );
    f.setDraft('', 0);
    f.service.automaticBaseline('running', '');
    f.service.automaticEnter();
    f.service.automaticBlur();
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.request).not.toHaveBeenCalled();
    foreground = true;
    f.service.wakeAutomatic();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.request).toHaveBeenCalledOnce();
    f.ready();
    await vi.advanceTimersByTimeAsync(20_000);
    f.service.wakeAutomatic();
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.request).toHaveBeenCalledOnce();
    f.service.dispose();
  });

  it.each(['cancel', 'draft', 'manual'] as const)(
    'lets %s consume the pending entry check',
    async (action) => {
      vi.useFakeTimers();
      const f = fixture();
      f.setDraft('', 0);
      f.service.automaticBaseline('loaded', '');
      f.service.automaticEnter();
      await vi.advanceTimersByTimeAsync(500);
      if (action === 'cancel') f.service.cancel();
      else if (action === 'draft') f.setDraft('Keep my draft', 13);
      else void f.service.request();
      await vi.advanceTimersByTimeAsync(20_000);
      expect(f.request).toHaveBeenCalledTimes(action === 'manual' ? 1 : 0);
      if (action === 'manual') expect(f.request.mock.calls[0]?.[2]).toBe('MANUAL');
      f.service.dispose();
    }
  );

  it('refocuses running turns and reuses a current candidate or in-flight request', async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.setDraft('', 0);
    f.service.automaticBaseline('running', '');
    f.service.automaticFocus();
    await vi.advanceTimersByTimeAsync(750);
    expect(f.request).toHaveBeenCalledOnce();
    f.service.automaticFocus();
    f.ready();
    await vi.advanceTimersByTimeAsync(1);
    f.service.automaticFocus();
    await vi.advanceTimersByTimeAsync(16_000);
    expect(f.request).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(15_000);
    f.service.automaticFocus();
    await vi.advanceTimersByTimeAsync(750);
    expect(f.request).toHaveBeenCalledTimes(2);
    f.service.dispose();
  });

  it('drops unfocused replies at observation and dispatch rather than replaying them on wake', async () => {
    vi.useFakeTimers();
    let focused = false;
    const f = fixture(() => focused);
    f.setDraft('', 0);
    f.service.automaticSignal('unfocused');
    focused = true;
    f.service.wakeAutomatic();
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.request).not.toHaveBeenCalled();
    f.service.automaticSignal('focused');
    focused = false;
    await vi.advanceTimersByTimeAsync(1000);
    focused = true;
    f.service.wakeAutomatic();
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.request).not.toHaveBeenCalled();
    f.service.automaticSignal('fresh');
    await vi.advanceTimersByTimeAsync(750);
    expect(f.request).toHaveBeenCalledOnce();
    f.service.dispose();
  });

  it('keeps a double-Tab gesture ahead of an automatic request becoming due between the keys', async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.setDraft('', 0);
    f.service.automaticSignal('reply');
    await vi.advanceTimersByTimeAsync(600);
    f.service.tab();
    await vi.advanceTimersByTimeAsync(200);
    expect(f.request).not.toHaveBeenCalled();
    f.service.tab();
    expect(f.request).toHaveBeenCalledOnce();
    expect(f.request.mock.calls[0]![2]).toBe('MANUAL');
    f.ready();
    await vi.advanceTimersByTimeAsync(16_000);
    expect(f.request).toHaveBeenCalledOnce();
    f.service.dispose();
  });

  it('resumes a queued automatic request when a single-Tab gesture times out', async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.setDraft('', 0);
    f.service.automaticSignal('reply');
    await vi.advanceTimersByTimeAsync(600);
    f.service.tab();
    await vi.advanceTimersByTimeAsync(200);
    expect(f.request).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.service.armed).toBe(false);
    expect(f.request).toHaveBeenCalledOnce();
    expect(f.request.mock.calls[0]![2]).toBe('AUTO');
    f.service.dispose();
  });

  it('merges reply, ending and focus signals into one request with no follow-up for the same context', async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.setDraft('', 0);
    f.service.automaticSignal('final-reply');
    f.service.automaticSignal('ended', 'TURN_END');
    f.service.automaticFocus();
    await vi.advanceTimersByTimeAsync(750);
    expect(f.request).toHaveBeenCalledOnce();
    f.service.automaticFocus();
    f.ready();
    await vi.advanceTimersByTimeAsync(16_000);
    expect(f.request).toHaveBeenCalledOnce();
    f.service.dispose();
  });

  it('does not starve automatic generation under continuous streaming reply updates', async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.setDraft('', 0);
    for (let i = 0; i < 5; i++) {
      f.service.automaticSignal(`stream-${i}`);
      await vi.advanceTimersByTimeAsync(200);
    }
    expect(f.request).toHaveBeenCalledOnce();
    expect(f.request.mock.calls[0]![1].aborted).toBe(false);
    f.service.dispose();
  });

  it('silently handles automatic abstention and errors without an empty-result notice', async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.setDraft('', 0);
    const pending = f.service.request('AUTO');
    f.resolve({ status: 'empty' } as PromptCompletionResponse);
    await pending;
    expect(f.service.state).toEqual({ kind: 'idle' });
    f.request.mockRejectedValueOnce(new Error('Unavailable'));
    await f.service.request('AUTO');
    expect(f.feedback).not.toHaveBeenCalled();
    expect(f.service.state).toEqual({ kind: 'idle' });
    f.service.dispose();
  });

  it('refreshes on completed-turn refocus after browsing or task context changes without inventing an event', async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.setDraft('', 0);
    f.service.automaticBaseline('reply', 'ended');
    f.service.automaticFocus();
    await vi.advanceTimersByTimeAsync(750);
    f.ready();
    await vi.advanceTimersByTimeAsync(1);
    f.setContextRevision('new-diff-and-goal');
    await vi.advanceTimersByTimeAsync(16_000);
    expect(f.request).toHaveBeenCalledOnce();
    f.service.automaticFocus();
    await vi.advanceTimersByTimeAsync(750);
    expect(f.request).toHaveBeenCalledTimes(2);
    f.service.automaticFocus();
    f.ready();
    await vi.advanceTimersByTimeAsync(16_000);
    expect(f.request).toHaveBeenCalledTimes(2);
    f.service.dispose();
  });

  it('keeps a focused check eligible when the current conversation starts another turn', async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.setDraft('', 0);
    f.service.automaticBaseline('old-reply', 'ended');
    f.service.automaticFocus();
    await vi.advanceTimersByTimeAsync(400);
    f.service.automaticSignal('', 'TURN_END');
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.request).toHaveBeenCalledOnce();
    f.service.dispose();
  });

  it.each(['REPLY', 'TURN_END'] as const)(
    'retains a coalesced focus check when %s becomes stale',
    async (reason) => {
      vi.useFakeTimers();
      const f = fixture();
      f.setDraft('', 0);
      f.service.automaticBaseline('old-reply', '');
      f.service.automaticSignal('queued', reason);
      f.service.automaticFocus();
      await vi.advanceTimersByTimeAsync(400);
      f.service.automaticSignal('', reason);
      await vi.advanceTimersByTimeAsync(350);
      expect(f.request).toHaveBeenCalledOnce();
      f.ready();
      await vi.advanceTimersByTimeAsync(20_000);
      expect(f.request).toHaveBeenCalledOnce();
      f.service.dispose();
    }
  );

  it.each(['blur', 'cancel', 'baseline'] as const)(
    'does not revive a coalesced focus check after %s',
    async (action) => {
      vi.useFakeTimers();
      let focused = true;
      const f = fixture(
        () => focused,
        (reason) => reason === 'TURN_END' || focused
      );
      f.setDraft('', 0);
      f.service.automaticBaseline('old-reply', '');
      f.service.automaticSignal('ended', 'TURN_END');
      f.service.automaticFocus();
      if (action === 'blur') {
        focused = false;
        f.service.automaticBlur();
      } else if (action === 'cancel') f.service.cancel();
      else f.service.automaticBaseline('old-reply', 'ended');
      f.service.automaticSignal('', 'TURN_END');
      focused = true;
      f.service.wakeAutomatic();
      await vi.advanceTimersByTimeAsync(1000);
      expect(f.request).not.toHaveBeenCalled();
      f.service.dispose();
    }
  );

  it('drops queued focused signals immediately on blur while preserving ending priority', async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.setDraft('', 0);
    f.service.automaticSignal('reply');
    f.service.automaticBlur();
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.request).not.toHaveBeenCalled();
    f.service.automaticSignal('ended', 'TURN_END');
    f.service.automaticSignal('final');
    f.service.automaticBlur();
    await vi.advanceTimersByTimeAsync(750);
    expect(f.request).toHaveBeenCalledOnce();
    f.service.dispose();
  });

  it('expires the preserved candidate without cancelling its in-flight automatic refresh', async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.setDraft('', 0);
    const initial = f.service.request();
    f.ready();
    await initial;
    f.service.automaticSignal('new-reply');
    await vi.advanceTimersByTimeAsync(15_000);
    expect(f.service.preview?.suggestion).toBe('API ');
    await vi.advanceTimersByTimeAsync(15_000);
    expect(f.service.state.kind).toBe('pending');
    expect(f.service.preview).toBeUndefined();
    expect(f.request.mock.calls[1]![1].aborted).toBe(false);
    f.ready();
    await vi.advanceTimersByTimeAsync(1);
    expect(f.service.state.kind).toBe('ready');
    f.service.dispose();
  });

  it('establishes a navigation baseline without replaying loaded history or queued old events', async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.setDraft('', 0);
    f.service.automaticSignal('session-a-live');
    f.service.automaticBaseline('session-b-loaded');
    f.service.automaticSignal('session-b-loaded');
    f.service.wakeAutomatic();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(f.request).not.toHaveBeenCalled();
    f.service.automaticSignal('session-b-live');
    await vi.advanceTimersByTimeAsync(750);
    expect(f.request).toHaveBeenCalledOnce();
    f.service.dispose();
  });

  it('keeps drafts and coalesces refocus into an already generating prediction', async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.service.automaticFocus();
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.request).not.toHaveBeenCalled();
    f.setDraft('', 0);
    void f.service.request();
    f.service.automaticFocus();
    f.ready();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(f.request).toHaveBeenCalledOnce();
    expect(f.request.mock.calls[0]![1].aborted).toBe(false);
    f.service.dispose();
  });

  it('coalesces new empty-draft signals without replaying an observed signal', async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.setDraft('', 0);
    f.service.automaticSignal('message-1');
    await vi.advanceTimersByTimeAsync(400);
    f.service.automaticSignal('message-2');
    await vi.advanceTimersByTimeAsync(349);
    expect(f.request).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(f.request).toHaveBeenCalledOnce();
    expect(f.request.mock.calls[0]![2]).toBe('AUTO');
    f.service.cancel();
    f.service.automaticSignal('message-2');
    f.service.wakeAutomatic();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(f.request).toHaveBeenCalledOnce();
    f.service.dispose();
  });

  it('keeps user drafts but refreshes an existing prediction for new Agent replies', async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.service.automaticSignal('with-draft');
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.request).not.toHaveBeenCalled();
    f.setDraft('', 0);
    void f.service.request();
    f.ready();
    await vi.advanceTimersByTimeAsync(1);
    expect(f.service.state.kind).toBe('ready');
    f.service.automaticSignal('new-reply');
    await vi.advanceTimersByTimeAsync(15_000);
    expect(f.request).toHaveBeenCalledTimes(2);
    expect(f.service.state.kind).toBe('pending');
    expect(f.service.state).toMatchObject({ previous: { suggestion: 'API ' } });
    f.ready();
    await vi.advanceTimersByTimeAsync(1);
    expect(f.service.state.kind).toBe('ready');
    f.service.dispose();
  });

  it('coalesces new replies during generation into one fresh prediction after it finishes', async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.setDraft('', 0);
    void f.service.request();
    f.service.automaticSignal('reply-1');
    f.service.automaticSignal('completed');
    await vi.advanceTimersByTimeAsync(16_000);
    expect(f.request).toHaveBeenCalledOnce();
    expect(f.request.mock.calls[0]![1].aborted).toBe(false);
    f.ready();
    await vi.advanceTimersByTimeAsync(750);
    expect(f.request).toHaveBeenCalledTimes(2);
    f.service.dispose();
  });

  it('retains a background ending when the previous suggestion expires', async () => {
    vi.useFakeTimers();
    let foreground = true;
    const f = fixture(() => foreground);
    f.setDraft('', 0);
    void f.service.request();
    f.ready();
    await vi.advanceTimersByTimeAsync(1);
    foreground = false;
    f.service.automaticSignal('ended', 'TURN_END');
    await vi.advanceTimersByTimeAsync(31_000);
    expect(f.service.state.kind).toBe('idle');
    expect(f.request).toHaveBeenCalledOnce();
    foreground = true;
    f.service.wakeAutomatic();
    await vi.advanceTimersByTimeAsync(750);
    expect(f.request).toHaveBeenCalledTimes(2);
    expect(f.request.mock.calls[1]![2]).toBe('AUTO');
    f.service.dispose();
  });

  it('limits automatic requests after cancellation and drops old scheduled events on disposal', async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.setDraft('', 0);
    void f.service.request();
    f.service.cancel();
    f.service.automaticSignal('new-message');
    await vi.advanceTimersByTimeAsync(14_999);
    expect(f.request).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(f.request).toHaveBeenCalledTimes(2);
    f.service.cancel();
    f.service.automaticSignal('last-message');
    f.service.dispose();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(f.request).toHaveBeenCalledTimes(2);
  });
});

describe('Automatic prediction event projection', () => {
  const turn = (
    items: readonly import('../../src/model/workbench.js').ConversationItem[],
    status = 'RUNNING'
  ) => ({ id: 'turn', sessionId: 'session', runId: 'run', status, items });
  it('projects terminal transitions separately from public reply text and ignores older completed turns', () => {
    const reply = {
      id: 'reply',
      kind: 'assistant_message',
      status: 'COMPLETED',
      payload: { text: 'Finished' }
    };
    expect(promptCompletionAutomaticTerminalKey([])).toBe('');
    expect(promptCompletionAutomaticTerminalKey([turn([reply])])).toBe('');
    for (const status of ['SUCCEEDED', 'FAILED', 'CANCELLED', 'INTERRUPTED', 'LOST']) {
      const terminal = promptCompletionAutomaticTerminalKey([turn([reply], status)]);
      expect(terminal).not.toBe('');
      expect(
        promptCompletionAutomaticTerminalKey([
          turn([{ ...reply, payload: { text: 'Late final text' } }], status)
        ])
      ).toBe(terminal);
    }
    expect(
      promptCompletionAutomaticTerminalKey([
        turn([], 'SUCCEEDED'),
        { ...turn([]), id: 'next-turn' }
      ])
    ).toBe('');
    expect(promptCompletionAutomaticTerminalKey([turn([], 'WAITING_INPUT')])).toBe('');
  });

  it('ignores tool-only progress and reacts to public reply text and terminal status', () => {
    expect(promptCompletionAutomaticKey([])).toBe('');
    expect(
      promptCompletionAutomaticKey([
        turn([{ id: 'tool', kind: 'tool_call', status: 'COMPLETED', payload: {} }])
      ])
    ).toBe('');
    const reply = {
      id: 'reply',
      kind: 'assistant_message',
      status: 'IN_PROGRESS',
      payload: { text: 'Working on API' }
    };
    const original = promptCompletionAutomaticKey([turn([reply])]);
    expect(original).not.toBe('');
    expect(
      promptCompletionAutomaticKey([
        turn([reply, { id: 'tool', kind: 'tool_call', status: 'COMPLETED', payload: {} }])
      ])
    ).toBe(original);
    expect(
      promptCompletionAutomaticKey([turn([{ ...reply, payload: { text: 'API implemented' } }])])
    ).not.toBe(original);
    expect(promptCompletionAutomaticKey([turn([reply], 'SUCCEEDED')])).not.toBe(original);
    expect(promptCompletionAutomaticKey([turn([], 'SUCCEEDED')])).not.toBe('');
    expect(promptCompletionAutomaticKey([turn([{ ...reply, payload: null }])])).toBe('');
  });

  it('defers an ending until the browser foreground guard allows it', async () => {
    vi.useFakeTimers();
    let foreground = false;
    const request = vi.fn(
      async (_draft: unknown, _signal: AbortSignal, _trigger: string) =>
        ({ status: 'empty' }) as never
    );
    const service = new PromptCompletionService({
      readDraft: () => ({ text: '', cursor: 0 }),
      canRequest: () => foreground,
      request,
      apply: () => false,
      changed: () => {},
      feedback: vi.fn()
    });
    service.automaticSignal('ended', 'TURN_END');
    await vi.advanceTimersByTimeAsync(1000);
    expect(request).not.toHaveBeenCalled();
    foreground = true;
    service.wakeAutomatic();
    await vi.advanceTimersByTimeAsync(750);
    expect(request).toHaveBeenCalledOnce();
    expect(request.mock.calls[0]![2]).toBe('AUTO');
    service.dispose();
  });
});
