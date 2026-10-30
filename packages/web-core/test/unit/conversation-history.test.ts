import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CONVERSATION_INITIAL_SEGMENT_LIMIT,
  CONVERSATION_INITIAL_RENDER_CHARACTERS,
  CONVERSATION_INITIAL_RENDER_ITEMS,
  CONVERSATION_RECENT_SEGMENT_BUFFER_LIMIT,
  CONVERSATION_RECENT_SEGMENT_LIMIT,
  CONVERSATION_SEGMENT_PAGE_SIZE,
  initialConversationRenderItemCount,
  latestConversationItems,
  limitConversationHistory,
  mergeConversationPayload
} from '../../src/util/conversation-history.js';
import { createConversationStateService } from '../../src/service/conversation-state-service.js';

function turn(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    sessionId: 'session-1',
    runId: null,
    status: 'RUNNING',
    items: [],
    ...overrides
  };
}

describe('Conversation History Window and Render State', () => {
  it('preserves input truncation when an output delta declares source truncation', () => {
    const frame = (text: string, truncation: Record<string, unknown>) => ({
      output: {
        blocks: [{ channel: 'STDOUT', text }],
        ...(truncation.output ? { truncation: truncation.output } : {})
      },
      toolPresentation: {
        kind: 'EXECUTION',
        execution: {
          kind: 'SHELL',
          truncation: truncation.input ? { input: true } : undefined
        }
      }
    });
    const value = mergeConversationPayload(
      frame('before', { input: true }),
      frame('after', { output: 'SOURCE' }),
      'output'
    );
    expect(value).toMatchObject({
      output: { blocks: [{ channel: 'STDOUT', text: 'beforeafter' }], truncation: 'SOURCE' },
      toolPresentation: {
        execution: {
          truncation: { input: true }
        }
      }
    });
  });
  it('retains channel tails and replaces execution presentation for terminal snapshots', () => {
    const frame = (text: string) => ({
      output: {
        blocks: [
          { channel: 'STDOUT', text },
          { channel: 'STDERR', text: 'e' }
        ]
      },
      toolPresentation: {
        kind: 'EXECUTION',
        execution: {
          kind: 'SHELL'
        }
      }
    });
    let value = mergeConversationPayload({}, frame('a'.repeat(9999)), 'output');
    value = mergeConversationPayload(value, frame('😀tail'), 'output');
    expect(value).toMatchObject({
      output: {
        truncation: 'HEAD',
        blocks: [
          { channel: 'STDOUT', text: expect.stringMatching(/😀tail$/u) },
          { channel: 'STDERR', text: 'ee' }
        ]
      }
    });
    value = mergeConversationPayload(value, frame('done'), undefined);
    expect(value).toMatchObject({
      output: { blocks: [{ text: 'done' }, { text: 'e' }] }
    });
    expect((value as any).output.truncation).toBeUndefined();
  });
  it('applies generic output deltas and authoritative snapshots without retaining old truncation', () => {
    let value: unknown = { inputSummary: 'input', truncated: true };
    value = mergeConversationPayload(
      value,
      { output: { text: 'one', truncated: false } },
      'output'
    );
    value = mergeConversationPayload(
      value,
      { output: { text: 'two', truncated: false } },
      'output'
    );
    expect(value).toMatchObject({ output: { text: 'onetwo', truncated: false }, truncated: true });
    value = mergeConversationPayload(
      value,
      { output: { text: 'snapshot', truncated: true } },
      undefined
    );
    value = mergeConversationPayload(
      value,
      { output: { text: 'snapshot', truncated: false } },
      undefined
    );
    value = mergeConversationPayload(value, { output: { text: '!', truncated: false } }, 'output');
    expect(value).toMatchObject({
      output: { text: 'snapshot!', truncated: false },
      truncated: true
    });
    value = mergeConversationPayload(
      value,
      { output: { text: 'x'.repeat(10_001), truncated: false } },
      'output'
    );
    expect(
      (value as { output: { text: string; truncated: boolean } }).output.text.length
    ).toBeLessThanOrEqual(10_000);
    expect((value as { output: { truncated: boolean } }).output.truncated).toBe(true);
    value = mergeConversationPayload(
      value,
      { output: { text: '😀newest', truncated: false } },
      'output'
    );
    value = mergeConversationPayload(
      value,
      { output: { text: '-tail', truncated: false } },
      'output'
    );
    expect(value).toMatchObject({
      output: { text: expect.stringMatching(/😀newest-tail$/u), truncated: true }
    });
    expect((value as { output: { text: string } }).output.text).not.toMatch(/^[\uDC00-\uDFFF]/u);
    value = mergeConversationPayload(
      value,
      { output: { text: 'final', truncated: false } },
      undefined
    );
    expect(value).toMatchObject({ output: { text: 'final', truncated: false }, truncated: true });
  });
  afterEach(() => vi.useRealTimers());

  it('Releases the waiter when the render window is replaced or canceled; an old confirmation cannot complete the new window', async () => {
    const state = createConversationStateService(vi.fn());
    const first = state.beginInitialRender();
    const firstVersion = state.initialRenderVersion.value;
    let settled = false;
    const next = state.beginInitialRender().then(() => {
      settled = true;
    });
    await first;
    state.confirmInitialRender(firstVersion);
    await Promise.resolve();
    expect(settled).toBe(false);
    state.cancelInitialRender();
    await next;
    expect(settled).toBe(true);
    expect(state.nextDetailRequest()).toBe(1);
    expect(state.nextDetailRequest()).toBe(2);
    expect(state.currentDetailRequest()).toBe(2);
  });

  it('Resolves the render wait within its bound when the timeline is not mounted, without leaving a loading state hanging', async () => {
    vi.useFakeTimers();
    const state = createConversationStateService(vi.fn());
    const settled = vi.fn();
    const completed = state.beginInitialRender().then(settled);
    await vi.advanceTimersByTimeAsync(9_999);
    expect(settled).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await completed;
    expect(settled).toHaveBeenCalledOnce();
    state.cancelInitialRender();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('Retains the contiguous newest history window within the byte limit without mutating the original records', () => {
    const original = Array.from({ length: 20 }, (_, index) => ({
      ...turn(`turn-${index}`),
      items: [
        {
          id: `item-${index}`,
          kind: 'assistant_message',
          status: 'COMPLETED',
          payload: { text: 'x'.repeat(2_000) }
        }
      ]
    }));
    const limited = limitConversationHistory(original, 6_000);
    expect(new TextEncoder().encode(JSON.stringify(limited)).byteLength).toBeLessThanOrEqual(6_000);
    expect(limited.length).toBeGreaterThan(0);
    expect(limited.length).toBeLessThan(original.length);
    expect(limited).toEqual(original.slice(-limited.length));
    expect(limited.at(-1)?.id).toBe('turn-19');
    expect(original).toHaveLength(20);
    expect(original[0]?.items[0]?.payload.text).toHaveLength(2_000);
  });

  it('Waits for the timeline to confirm the current render generation before completing the initial render', async () => {
    const state = createConversationStateService(vi.fn());
    let settled = false;
    const completed = state.beginInitialRender().then(() => {
      settled = true;
    });

    expect(state.initialRenderVersion.value).toBe(1);
    state.confirmInitialRender(2);
    await Promise.resolve();
    expect(settled).toBe(false);
    state.confirmInitialRender(1);
    await completed;
    expect(settled).toBe(true);
  });

  it('Keeps the newest content on the initial screen within item-count and content-size limits; later extensions preserve order', () => {
    const oversized = Array.from({ length: CONVERSATION_INITIAL_RENDER_ITEMS + 5 }, (_, index) => ({
      id: `item-${index + 1}`,
      kind: 'assistant_message',
      status: 'COMPLETED',
      payload: { text: index === 0 ? 'x'.repeat(CONVERSATION_INITIAL_RENDER_CHARACTERS) : 'ok' }
    }));
    const turns = [
      turn('turn-1', { items: oversized.slice(0, 20) }),
      turn('turn-2', { items: oversized.slice(20) })
    ];

    const initialCount = initialConversationRenderItemCount(turns as never);
    const initial = latestConversationItems(turns as never, initialCount);
    const expanded = latestConversationItems(turns as never, initialCount + 8);

    expect(initialCount).toBe(CONVERSATION_INITIAL_RENDER_ITEMS);
    expect(initial.flatMap((item) => item.items).map((item) => item.id)).toEqual(
      oversized.slice(-CONVERSATION_INITIAL_RENDER_ITEMS).map((item) => item.id)
    );
    expect(expanded.flatMap((item) => item.items).map((item) => item.id)).toEqual(
      oversized.slice(-(CONVERSATION_INITIAL_RENDER_ITEMS + 5)).map((item) => item.id)
    );
  });

  it('Displays a single oversized latest Item on the initial screen', () => {
    const turns = [
      turn('turn-1', {
        items: [
          {
            id: 'large-item',
            kind: 'assistant_message',
            status: 'COMPLETED',
            payload: { text: 'x'.repeat(CONVERSATION_INITIAL_RENDER_CHARACTERS + 1) }
          }
        ]
      })
    ];

    expect(initialConversationRenderItemCount(turns as never)).toBe(1);
    expect(latestConversationItems(turns as never, 1)[0]?.items[0]?.id).toBe('large-item');
  });

  it('Defers earlier Items after the initial content reaches the character limit', () => {
    const turns = [
      turn('turn-1', {
        items: ['oldest', 'middle', 'latest'].map((id) => ({
          id,
          kind: 'assistant_message',
          status: 'COMPLETED',
          payload: { text: 'x'.repeat(Math.ceil(CONVERSATION_INITIAL_RENDER_CHARACTERS / 2)) }
        }))
      })
    ];

    const initialCount = initialConversationRenderItemCount(turns as never);

    expect(initialCount).toBe(1);
    expect(latestConversationItems(turns as never, initialCount)[0]?.items[0]?.id).toBe('latest');
  });

  it('uses three Segments per initial screen and history page without changing retention', () => {
    expect(CONVERSATION_INITIAL_SEGMENT_LIMIT).toBe(3);
    expect(CONVERSATION_SEGMENT_PAGE_SIZE).toBe(3);
    expect(CONVERSATION_RECENT_SEGMENT_LIMIT).toBe(15);
    expect(CONVERSATION_RECENT_SEGMENT_BUFFER_LIMIT).toBe(30);
  });
});
