import { describe, expect, it, vi } from 'vitest';
import { createConversationScrollService } from '../../src/service/conversation-scroll-service';

function scrollElement(values: {
  readonly scrollHeight: number;
  readonly scrollTop: number;
  readonly clientHeight: number;
}): HTMLElement {
  return {
    ...values,
    ownerDocument: { elementFromPoint: () => null },
    getBoundingClientRect: () => ({ top: 0, left: 0, width: 100, height: values.clientHeight }),
    contains: () => false
  } as unknown as HTMLElement;
}

function readingAnchor(element: HTMLElement): { shiftContent: (delta: number) => void } {
  let contentTop = element.scrollTop;
  const anchor = {
    isConnected: true,
    getBoundingClientRect: () => ({ top: contentTop - element.scrollTop })
  };
  Object.assign(element, {
    ownerDocument: { elementFromPoint: () => anchor },
    contains: (candidate: unknown) => candidate === anchor
  });
  return {
    shiftContent: (delta) => {
      contentTop += delta;
    }
  };
}

describe('Web session scrolling status', () => {
  it.each(['capturePrependAnchor', 'captureRenderAnchor'] as const)(
    'preserves the top reading anchor without chaining through %s',
    (capture) => {
      const element = scrollElement({ scrollHeight: 1000, scrollTop: 0, clientHeight: 200 });
      const state = createConversationScrollService();
      state.setElement(element);
      state.stopFollowing();
      const restore = state[capture]();
      Object.defineProperty(element, 'scrollHeight', { value: 1600 });
      restore();
      expect(element.scrollTop).toBe(600);
      const loadOlder = vi.fn();
      state.handleScroll(loadOlder);
      expect(loadOlder).not.toHaveBeenCalled();
    }
  );

  it('honors upward intent when short history becomes scrollable after a prepend', () => {
    const element = scrollElement({ scrollHeight: 150, scrollTop: 0, clientHeight: 200 });
    const state = createConversationScrollService();
    state.setElement(element);
    state.stopFollowing();
    const restore = state.capturePrependAnchor();
    Object.defineProperty(element, 'scrollHeight', { value: 750 });
    restore();
    state.handleResize();
    expect(state.following.value).toBe(false);
    expect(element.scrollTop).toBe(600);
  });

  it.each([
    { height: 220, top: 20 },
    { height: 220, top: 0 },
    { height: 200, top: 0 }
  ])(
    'does not resume following near the bottom without downward movement: %s',
    ({ height, top }) => {
      const element = scrollElement({ scrollHeight: height, scrollTop: top, clientHeight: 200 });
      const state = createConversationScrollService();
      state.setElement(element);
      state.stopFollowing();
      element.scrollTop = 0;
      state.handleScroll(vi.fn());
      expect(state.following.value).toBe(false);
      const restore = state.capturePrependAnchor();
      Object.defineProperty(element, 'scrollHeight', { value: height + 600 });
      restore();
      expect(element.scrollTop).toBe(600);
    }
  );

  it('resumes following when the reader scrolls down to the latest message', () => {
    const element = scrollElement({ scrollHeight: 1000, scrollTop: 700, clientHeight: 200 });
    const state = createConversationScrollService();
    state.setElement(element);
    state.stopFollowing();
    element.scrollTop = 800;
    state.handleScroll(vi.fn());
    expect(state.following.value).toBe(true);
  });

  it('resumes following when downward scrolling reaches the bottom during a layout change', () => {
    const element = scrollElement({ scrollHeight: 1000, scrollTop: 700, clientHeight: 200 });
    const state = createConversationScrollService();
    state.setElement(element);
    state.stopFollowing();
    Object.defineProperty(element, 'scrollHeight', { value: 1200 });
    element.scrollTop = 1000;
    state.handleScroll(vi.fn());
    expect(state.following.value).toBe(true);
  });

  it.each(['together', 'after-layout', 'after-resize'] as const)(
    'does not treat native anchor compensation as downward reading: %s',
    (delivery) => {
      const element = scrollElement({ scrollHeight: 1000, scrollTop: 780, clientHeight: 200 });
      const anchor = readingAnchor(element);
      const state = createConversationScrollService();
      state.setElement(element);
      state.stopFollowing();
      Object.defineProperty(element, 'scrollHeight', { value: 1200 });
      anchor.shiftContent(200);
      const loadOlder = vi.fn();
      if (delivery === 'after-layout') state.handleScroll(loadOlder);
      if (delivery === 'after-resize') state.handleResize();
      element.scrollTop = 980;
      state.handleScroll(loadOlder);
      state.handleScroll(loadOlder);
      expect(state.following.value).toBe(false);
      expect(loadOlder).not.toHaveBeenCalled();
      element.scrollTop = 1000;
      state.handleScroll(loadOlder);
      expect(state.following.value).toBe(true);
    }
  );

  it('does not load another page when native anchoring follows content shrinking above the viewport', () => {
    const element = scrollElement({ scrollHeight: 500, scrollTop: 280, clientHeight: 200 });
    const anchor = readingAnchor(element);
    const state = createConversationScrollService();
    state.setElement(element);
    state.stopFollowing();
    Object.defineProperty(element, 'scrollHeight', { value: 260 });
    anchor.shiftContent(-240);
    element.scrollTop = 40;
    const loadOlder = vi.fn();
    state.handleScroll(loadOlder);
    expect(loadOlder).not.toHaveBeenCalled();
    expect(state.following.value).toBe(false);
  });

  it('resumes following after real downward scrolling matches an earlier height change', () => {
    const element = scrollElement({ scrollHeight: 1000, scrollTop: 800, clientHeight: 200 });
    readingAnchor(element);
    const state = createConversationScrollService();
    state.setElement(element);
    state.stopFollowing();
    Object.defineProperty(element, 'scrollHeight', { value: 1200 });
    state.handleScroll(vi.fn());
    element.scrollTop = 1000;
    state.handleScroll(vi.fn());
    expect(state.following.value).toBe(true);
  });

  it('preserves reading intent when content grows above and below the visible anchor together', () => {
    const element = scrollElement({ scrollHeight: 1000, scrollTop: 780, clientHeight: 200 });
    const anchor = readingAnchor(element);
    const state = createConversationScrollService();
    state.setElement(element);
    state.stopFollowing();
    Object.defineProperty(element, 'scrollHeight', { value: 1205 });
    anchor.shiftContent(200);
    element.scrollTop = 980;
    state.handleScroll(vi.fn());
    expect(state.following.value).toBe(false);
  });

  it('adopts the current reading position when upward intent follows an unobserved layout change', () => {
    const element = scrollElement({ scrollHeight: 1000, scrollTop: 800, clientHeight: 200 });
    const state = createConversationScrollService();
    state.setElement(element);
    Object.defineProperty(element, 'scrollHeight', { value: 1200 });
    element.scrollTop = 980;
    state.stopFollowing();
    state.handleScroll(vi.fn());
    expect(state.following.value).toBe(false);
  });

  it.each([
    { scrollHeight: 500, clientHeight: 200, scrollTop: 300 },
    { scrollHeight: 1000, clientHeight: 600, scrollTop: 400 }
  ])(
    'preserves following when a shrinking scroll range clamps the viewport to the bottom: %s',
    (layout) => {
      const element = scrollElement({ scrollHeight: 1000, scrollTop: 800, clientHeight: 200 });
      const state = createConversationScrollService();
      state.setElement(element);
      Object.defineProperty(element, 'scrollHeight', { value: layout.scrollHeight });
      Object.defineProperty(element, 'clientHeight', { value: layout.clientHeight });
      element.scrollTop = layout.scrollTop;
      const loadOlder = vi.fn();
      state.handleScroll(loadOlder);
      expect(state.following.value).toBe(true);
      expect(loadOlder).not.toHaveBeenCalled();
    }
  );

  it('does not override explicit upward intent when a shrinking range also reaches the bottom', () => {
    const element = scrollElement({ scrollHeight: 1000, scrollTop: 800, clientHeight: 200 });
    const state = createConversationScrollService();
    state.setElement(element);
    state.stopFollowing();
    Object.defineProperty(element, 'scrollHeight', { value: 500 });
    element.scrollTop = 300;
    state.handleScroll(vi.fn());
    expect(state.following.value).toBe(false);
  });

  it.each([
    { following: true, top: 0 },
    { following: false, top: 300 }
  ])(
    'preserves the reading anchor outside an active top-boundary load: %s',
    ({ following, top }) => {
      const element = scrollElement({ scrollHeight: 1000, scrollTop: top, clientHeight: 200 });
      const state = createConversationScrollService();
      state.setElement(element);
      state.following.value = following;
      const restore = state.capturePrependAnchor();
      Object.defineProperty(element, 'scrollHeight', { value: 1600 });
      restore();
      expect(element.scrollTop).toBe(top + 600);
    }
  );

  it('owns progressive mounting anchor compensation without overriding an intervening user scroll', () => {
    const element = scrollElement({ scrollHeight: 1000, scrollTop: 300, clientHeight: 200 });
    const state = createConversationScrollService();
    state.setElement(element);
    state.following.value = false;
    const restore = state.captureRenderAnchor();
    Object.defineProperty(element, 'scrollHeight', { value: 1200, configurable: true });
    restore();
    expect(element.scrollTop).toBe(500);
    const afterUserScroll = state.captureRenderAnchor();
    element.scrollTop = 400;
    state.handleScroll(vi.fn());
    Object.defineProperty(element, 'scrollHeight', { value: 1400, configurable: true });
    afterUserScroll();
    expect(element.scrollTop).toBe(400);
  });

  it('keeps a following reader at the bottom but honors explicit upward intent during mounting', () => {
    const element = scrollElement({ scrollHeight: 1000, scrollTop: 800, clientHeight: 200 });
    const state = createConversationScrollService();
    state.setElement(element);
    const restore = state.captureRenderAnchor();
    Object.defineProperty(element, 'scrollHeight', { value: 1200, configurable: true });
    restore();
    expect(element.scrollTop).toBe(1200);
    const cancelled = state.captureRenderAnchor();
    state.stopFollowing();
    element.scrollTop = 700;
    Object.defineProperty(element, 'scrollHeight', { value: 1400, configurable: true });
    cancelled();
    expect(element.scrollTop).toBe(700);
    expect(state.following.value).toBe(false);
  });

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

    const element = scrollElement({ scrollHeight: 1000, scrollTop: 300, clientHeight: 200 });
    state.setElement(element);
    element.scrollTop = 20;
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

  it('cancels pending calibration when the conversation changes on the same scroll element', async () => {
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
      let current = true;
      const positioning = state.scrollToLatestAfterLayout(() => current);
      await Promise.resolve();
      await Promise.resolve();
      current = false;
      element.scrollTop = 120;
      animationFrames.shift()?.(0);
      await vi.runAllTimersAsync();
      await positioning;
      expect(element.scrollTop).toBe(120);
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });

  it('lets explicit reading intent cancel protected calibration before the next frame', async () => {
    const state = createConversationScrollService();
    const element = scrollElement({ scrollHeight: 1000, scrollTop: 800, clientHeight: 200 });
    state.setElement(element);
    state.positioningInitialConversation.value = true;
    const pending = state.scrollToLatestAfterLayout();

    state.stopFollowing();
    element.scrollTop = 400;
    state.handleScroll(vi.fn());
    await pending;

    expect(state.following.value).toBe(false);
    expect(state.positioningInitialConversation.value).toBe(false);
    expect(element.scrollTop).toBe(400);
  });
});
