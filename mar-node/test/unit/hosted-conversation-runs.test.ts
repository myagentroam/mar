import { describe, expect, it, vi } from 'vitest';
import type { HostedConversationRuntimeHandle } from '../../src/hosting/runtime-contracts.js';
import { HostedConversationRuns } from '../../src/hosting/hosted-conversation-runs.js';

function handle(id: string): HostedConversationRuntimeHandle {
  return {
    run: { id, status: 'RUNNING', startedAt: 1, completedAt: null },
    completion: Promise.resolve({ status: 'SUCCEEDED', completedAt: 2 }),
    cancel: vi.fn(() => true)
  };
}

describe('Hosted Conversation Run ownership', () => {
  it('registers a message admission synchronously and reuses it for the same request', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const store = { findMessage: vi.fn(() => undefined) };
    const runs = new HostedConversationRuns({
      store: store as never,
      hostedWatch: {} as never,
      now: Date.now,
      nodeId: () => 'node',
      publishWorkbenchEvent: () => undefined,
      uploads: {} as never,
      runtime: {} as never,
      templates: {} as never,
      secretEnvironment: undefined,
      modelUsage: undefined
    });
    const begin = vi.fn(() => gate);
    const first = runs.admitMessage(1, 'conversation', 'message', begin);
    expect(runs.admitMessage(1, 'conversation', 'message', begin)).toBe(first);
    await expect(runs.admitMessage(1, 'conversation', 'other', begin)).rejects.toThrow(
      'HOSTED_CONVERSATION_RUN_ACTIVE'
    );
    expect(begin).toHaveBeenCalledOnce();
    release();
    await first;
    await runs.waitForAdmissions('conversation');
  });
  it('does not release a replacement when an older settlement completes', () => {
    const runs = new HostedConversationRuns({
      store: {} as never,
      hostedWatch: {} as never,
      now: Date.now,
      nodeId: () => 'node',
      publishWorkbenchEvent: () => undefined,
      uploads: {} as never,
      runtime: {} as never,
      templates: {} as never,
      secretEnvironment: undefined,
      modelUsage: undefined
    });
    const old = handle('old');
    const next = handle('next');
    const oldSettlement = Promise.resolve();
    const nextSettlement = Promise.resolve();
    runs.accept('conversation', old);
    runs.trackSettlement('conversation', oldSettlement);
    runs.accept('conversation', next);
    runs.trackSettlement('conversation', nextSettlement);
    runs.release('conversation', old, oldSettlement);
    expect(runs.current('conversation')).toBe(next);
    expect(runs.settlement('conversation')).toBe(nextSettlement);
    runs.release('conversation', next, nextSettlement);
    expect(runs.busy('conversation')).toBe(false);
  });

  it('joins pending admissions and preserves cancellation intent by Run', async () => {
    const runs = new HostedConversationRuns({
      store: {} as never,
      hostedWatch: {} as never,
      now: Date.now,
      nodeId: () => 'node',
      publishWorkbenchEvent: () => undefined,
      uploads: {} as never,
      runtime: {} as never,
      templates: {} as never,
      secretEnvironment: undefined,
      modelUsage: undefined
    });
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    runs.acceptMessage('conversation\0message', pending);
    const active = handle('run');
    runs.accept('conversation', active);
    const closing = runs.close();
    expect(active.cancel).toHaveBeenCalledOnce();
    expect(active.cancel).toHaveBeenCalledWith('shutdown');
    expect(runs.expectsInterruption('conversation', 'run')).toBe(true);
    let joined = false;
    const wait = runs.waitForAdmissions('conversation').then(() => {
      joined = true;
    });
    await Promise.resolve();
    expect(joined).toBe(false);
    release();
    await wait;
    await closing;
    expect(joined).toBe(true);
    expect(runs.hasPending('conversation')).toBe(false);
  });
});
