import { nextTick, ref } from 'vue';

const FOLLOW_THRESHOLD_PX = 28;
const LOAD_OLDER_THRESHOLD_PX = 48;

export function createConversationScrollService() {
  const element = ref<HTMLElement>();
  const following = ref(true);
  const positioningInitialConversation = ref(false);
  let clientWidth: number | undefined;
  let clientHeight: number | undefined;
  let scrollHeight: number | undefined;
  let lastScrollTop = 0;
  let readingAnchor: { readonly element: Element; readonly top: number } | undefined;

  function setElement(next: HTMLElement | undefined): void {
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
    // Height can also change below the reader; compare the actual visible element instead.
    const anchored =
      readingAnchor !== undefined &&
      current.contains(readingAnchor.element) &&
      Math.abs(readingAnchor.element.getBoundingClientRect().top - readingAnchor.top) < 1;
    const movedUp = !anchored && current.scrollTop < lastScrollTop - 1;
    const movedDown = !anchored && current.scrollTop > lastScrollTop;
    const distanceFromBottom = current.scrollHeight - current.scrollTop - current.clientHeight;
    lastScrollTop = current.scrollTop;
    if (
      layoutChanged &&
      ((!movedUp && !movedDown) || (following.value && distanceFromBottom <= 1))
    ) {
      if (following.value) scrollToLatest();
      else if (readingAnchor === undefined) captureReadingAnchor(current);
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
    following.value = false;
    positioningInitialConversation.value = false;
    updateLayout(current);
    lastScrollTop = current.scrollTop;
    captureReadingAnchor(current);
  }

  function scrollToLatest(): void {
    const current = element.value;
    if (current === undefined) return;
    current.scrollTop = current.scrollHeight;
    lastScrollTop = current.scrollTop;
    following.value = true;
    readingAnchor = undefined;
  }

  function captureAnchor(followBottom: boolean): () => void {
    const target = element.value;
    if (target === undefined) return () => undefined;
    const previousHeight = target.scrollHeight;
    const previousTop = target.scrollTop;
    const wasFollowing = followBottom && following.value;
    return () => {
      if (element.value !== target || target.scrollTop !== previousTop) return;
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
    captureRenderAnchor,
    capturePrependAnchor,
    scrollToLatestAfterLayout
  };
}
