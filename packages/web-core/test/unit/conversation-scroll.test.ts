import { describe, expect, it, vi } from 'vitest';
import { createConversationScrollService } from '../../src/service/conversation-scroll-service';

function scrollElement(values: {
  readonly scrollHeight: number;
  readonly scrollTop: number;
  readonly clientHeight: number;
}): HTMLElement {
  return { ...values } as HTMLElement;
}

describe('Web session scrolling status', () => {
  it.each([true, false])('Preserves follow intent during content expansion: %s', (following) => {
    const element = scrollElement({
      scrollHeight: 1000,
      scrollTop: following ? 800 : 300,
      clientHeight: 200
    });
    const state = createConversationScrollService();
    state.setElement(element);
    state.following.value = following;
    Object.defineProperty(element, 'scrollHeight', { value: 1500, configurable: true });
    const loadOlder = vi.fn();
    state.handleScroll(loadOlder);
    expect(element.scrollTop).toBe(following ? 1500 : 300);
    expect(state.following.value).toBe(following);
    expect(loadOlder).not.toHaveBeenCalled();
  });

  it('Honors upward user scrolling even when content expands in the same frame', () => {
    const element = scrollElement({ scrollHeight: 1000, scrollTop: 800, clientHeight: 200 });
    const state = createConversationScrollService();
    state.setElement(element);
    Object.defineProperty(element, 'scrollHeight', { value: 1500 });
    element.scrollTop = 600;
    state.handleScroll(vi.fn());
    expect(element.scrollTop).toBe(600);
    expect(state.following.value).toBe(false);
  });

  it('Stay pinned near the bottom and load older messages after the user scrolls away', () => {
    const state = createConversationScrollService();
    const loadOlder = vi.fn();
    state.setElement(scrollElement({ scrollHeight: 1000, scrollTop: 780, clientHeight: 200 }));
    state.handleScroll(loadOlder);
    expect(state.following.value).toBe(true);
    expect(loadOlder).not.toHaveBeenCalled();

    state.setElement(scrollElement({ scrollHeight: 1000, scrollTop: 20, clientHeight: 200 }));
    state.handleScroll(loadOlder);
    expect(state.following.value).toBe(false);
    expect(loadOlder).toHaveBeenCalledTimes(1);
  });

  it('Do not change follow mode or load older messages during initial positioning', () => {
    const state = createConversationScrollService();
    const loadOlder = vi.fn();
    state.following.value = false;
    state.positioningInitialConversation.value = true;
    state.setElement(scrollElement({ scrollHeight: 1000, scrollTop: 0, clientHeight: 200 }));

    state.handleScroll(loadOlder);
    expect(state.following.value).toBe(false);
    expect(loadOlder).not.toHaveBeenCalled();
  });

  it('Return to the latest message by scrolling to the bottom and re-enable auto-follow', () => {
    const state = createConversationScrollService();
    const element = scrollElement({ scrollHeight: 1000, scrollTop: 20, clientHeight: 200 });
    state.setElement(element);
    state.following.value = false;

    state.scrollToLatest();
    expect(element.scrollTop).toBe(1000);
    expect(state.following.value).toBe(true);
  });

  it('Do not mistake layout changes for upward user scrolling while following the bottom', () => {
    const layout = {
      scrollHeight: 1000,
      clientHeight: 200,
      clientWidth: 800
    };
    const element = {
      get scrollHeight() {
        return layout.scrollHeight;
      },
      get clientHeight() {
        return layout.clientHeight;
      },
      get clientWidth() {
        return layout.clientWidth;
      },
      scrollTop: 800
    } as HTMLElement;
    const state = createConversationScrollService();
    state.setElement(element);

    layout.scrollHeight = 1600;
    layout.clientHeight = 500;
    layout.clientWidth = 390;
    state.handleScroll(vi.fn());

    expect(element.scrollTop).toBe(1600);
    expect(state.following.value).toBe(true);
  });

  it('Cancel a pending bottom-follow after the user scrolls up', async () => {
    vi.useFakeTimers();
    const animationFrames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      animationFrames.push(callback);
      return animationFrames.length;
    });
    try {
      const state = createConversationScrollService();
      const element = scrollElement({ scrollHeight: 1000, scrollTop: 0, clientHeight: 200 });
      state.setElement(element);

      const positioning = state.scrollToLatestAfterLayout();
      await Promise.resolve();
      await Promise.resolve();
      expect(animationFrames).toHaveLength(1);

      element.scrollTop = 0;
      state.handleScroll(vi.fn());
      expect(state.following.value).toBe(false);
      animationFrames.shift()?.(0);
      await Promise.resolve();
      await vi.runAllTimersAsync();
      await positioning;

      expect(element.scrollTop).toBe(0);
      expect(state.following.value).toBe(false);
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });
});
