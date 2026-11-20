import { nextTick, ref } from 'vue';

const FOLLOW_THRESHOLD_PX = 28;
const LOAD_OLDER_THRESHOLD_PX = 48;

/** Owns conversation following, explicit navigation, and reading-anchor compensation. */
export function createConversationScrollService() {
  const element = ref<HTMLElement>();
  const following = ref(true);
  const positioningInitialConversation = ref(false);
  let clientWidth: number | undefined;
  let clientHeight: number | undefined;
  let scrollHeight: number | undefined;
  let lastScrollTop = 0;
  let latestScrollTarget: number | undefined;
  let readingAnchor: { readonly element: Element; readonly top: number } | undefined;

  function setElement(next: HTMLElement | undefined): void {
    const previous = element.value;
    if (previous !== next) {
      if (previous !== undefined) {
        if (Reflect.has(previous, 'onscrollend'))
          previous.removeEventListener('scrollend', handleScrollEnd);
        cancelLatestScroll(previous);
      }
      if (next !== undefined && Reflect.has(next, 'onscrollend'))
        next.addEventListener('scrollend', handleScrollEnd);
    }
    element.value = next;
    clientWidth = next?.clientWidth;
    clientHeight = next?.clientHeight;
    scrollHeight = next?.scrollHeight;
    lastScrollTop = next?.scrollTop ?? 0;
    readingAnchor = undefined;
  }

  function updateLayout(current: HTMLElement): boolean {
    const changed =
      current.clientWidth !== clientWidth ||
      current.clientHeight !== clientHeight ||
      current.scrollHeight !== scrollHeight;
    clientWidth = current.clientWidth;
    clientHeight = current.clientHeight;
    scrollHeight = current.scrollHeight;
    return changed;
  }

  function captureReadingAnchor(current: HTMLElement): void {
    const bounds = current.getBoundingClientRect();
    const candidate = current.ownerDocument.elementFromPoint(
      bounds.left + bounds.width / 2,
      bounds.top + bounds.height / 2
    );
    readingAnchor =
      candidate !== null && candidate !== current && current.contains(candidate)
        ? { element: candidate, top: candidate.getBoundingClientRect().top }
        : undefined;
  }

  function handleScroll(onLoadOlder: () => void): void {
    const current = element.value;
    if (current === undefined || positioningInitialConversation.value) return;
    const layoutChanged = updateLayout(current);
    if (latestScrollTarget !== undefined) {
      const bottom = current.scrollHeight - current.clientHeight;
      if (current.scrollTop >= bottom - 1) scrollToLatest();
      else if (!Reflect.has(current, 'onscrollend') && current.scrollTop >= latestScrollTarget - 1)
        jumpToLatest();
      return;
    }
    // Layout can also move scrollTop. Explicit upward intent stops following before the scroll event.
    if (layoutChanged && following.value) {
      scrollToLatest();
      return;
    }
    // Height can also change below the reader; compare the actual visible element instead.
    const anchored =
      readingAnchor !== undefined &&
      current.contains(readingAnchor.element) &&
      Math.abs(readingAnchor.element.getBoundingClientRect().top - readingAnchor.top) < 1;
    const movedUp = !anchored && current.scrollTop < lastScrollTop - 1;
    const movedDown = !anchored && current.scrollTop > lastScrollTop;
    const distanceFromBottom = current.scrollHeight - current.scrollTop - current.clientHeight;
    lastScrollTop = current.scrollTop;
    if (layoutChanged && !movedUp && !movedDown) {
      if (readingAnchor === undefined) captureReadingAnchor(current);
      return;
    }
    following.value =
      !movedUp && (following.value || movedDown) && distanceFromBottom < FOLLOW_THRESHOLD_PX;
    if (following.value) readingAnchor = undefined;
    else if (movedUp || movedDown || readingAnchor === undefined) captureReadingAnchor(current);
    if (
      movedUp &&
      current.scrollTop < LOAD_OLDER_THRESHOLD_PX &&
      current.scrollHeight > current.clientHeight + LOAD_OLDER_THRESHOLD_PX
    )
      onLoadOlder();
  }

  function handleResize(): void {
    const current = element.value;
    if (current === undefined || !updateLayout(current) || !following.value) return;
    void scrollToLatestAfterLayout();
  }

  function stopFollowing(): void {
    const current = element.value;
    if (current === undefined) return;
    cancelLatestScroll(current);
    following.value = false;
    positioningInitialConversation.value = false;
    updateLayout(current);
    lastScrollTop = current.scrollTop;
    captureReadingAnchor(current);
  }

  function scrollToLatest(): void {
    const current = element.value;
    if (current === undefined) return;
    latestScrollTarget = undefined;
    current.scrollTop = current.scrollHeight;
    lastScrollTop = current.scrollTop;
    following.value = true;
    readingAnchor = undefined;
  }

  function cancelLatestScroll(current: HTMLElement): void {
    if (latestScrollTarget === undefined) return;
    latestScrollTarget = undefined;
    current.scrollTo({ top: current.scrollTop, behavior: 'instant' });
  }

  function handleScrollEnd(): void {
    const current = element.value;
    // A previously queued scrollend can arrive before a new jump has moved the viewport.
    if (
      current === undefined ||
      latestScrollTarget === undefined ||
      current.scrollTop === lastScrollTop
    )
      return;
    if (current.scrollTop >= latestScrollTarget - 1) {
      // Streaming content may have moved the bottom while heading to the previous destination.
      jumpToLatest();
      return;
    }
    latestScrollTarget = undefined;
    lastScrollTop = current.scrollTop;
    captureReadingAnchor(current);
  }

  function jumpToLatest(): void {
    const current = element.value;
    if (current === undefined) return;
    const bottom = current.scrollHeight - current.clientHeight;
    if (
      current.scrollTop >= bottom - 1 ||
      current.ownerDocument.defaultView?.matchMedia('(prefers-reduced-motion: reduce)').matches
    ) {
      scrollToLatest();
      return;
    }
    lastScrollTop = current.scrollTop;
    latestScrollTarget = bottom;
    current.scrollTo({ top: bottom, behavior: 'smooth' });
  }

  function captureAnchor(followBottom: boolean): () => void {
    const target = element.value;
    if (target === undefined) return () => undefined;
    const previousHeight = target.scrollHeight;
    const previousTop = target.scrollTop;
    const wasFollowing = followBottom && following.value;
    return () => {
      if (
        element.value !== target ||
        target.scrollTop !== previousTop ||
        latestScrollTarget !== undefined
      )
        return;
      if (wasFollowing) {
        if (following.value) {
          scrollToLatest();
          updateLayout(target);
        }
        return;
      }
      target.scrollTop = previousTop + (target.scrollHeight - previousHeight);
      lastScrollTop = target.scrollTop;
      updateLayout(target);
      if (!following.value) captureReadingAnchor(target);
    };
  }

  function captureRenderAnchor(): () => void {
    return captureAnchor(true);
  }

  function capturePrependAnchor(): () => void {
    return captureAnchor(false);
  }

  async function scrollToLatestAfterLayout(isCurrent: () => boolean = () => true): Promise<void> {
    const target = element.value;
    if (target === undefined || !isCurrent()) return;
    scrollToLatest();
    await nextTick();
    if (element.value !== target || !following.value || !isCurrent()) return;
    scrollToLatest();
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    if (element.value !== target || !following.value || !isCurrent()) return;
    scrollToLatest();
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    if (element.value !== target || !following.value || !isCurrent()) return;
    scrollToLatest();
  }

  return {
    element,
    following,
    positioningInitialConversation,
    setElement,
    handleScroll,
    handleResize,
    stopFollowing,
    scrollToLatest,
    jumpToLatest,
    captureRenderAnchor,
    capturePrependAnchor,
    scrollToLatestAfterLayout
  };
}
