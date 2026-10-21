import { nextTick, ref } from 'vue';

const FOLLOW_THRESHOLD_PX = 28;
const LOAD_OLDER_THRESHOLD_PX = 48;

export function createConversationScrollService() {
  const element = ref<HTMLElement>();
  const following = ref(true);
  const positioningInitialConversation = ref(false);
  let clientWidth: number | undefined;
  let clientHeight: number | undefined;

  function setElement(next: HTMLElement | undefined): void {
    element.value = next;
    clientWidth = next?.clientWidth;
    clientHeight = next?.clientHeight;
  }

  function updateLayout(current: HTMLElement): boolean {
    const changed = current.clientWidth !== clientWidth || current.clientHeight !== clientHeight;
    clientWidth = current.clientWidth;
    clientHeight = current.clientHeight;
    return changed;
  }

  function handleScroll(onLoadOlder: () => void): void {
    const current = element.value;
    if (current === undefined || positioningInitialConversation.value) return;
    if (updateLayout(current)) {
      if (following.value) scrollToLatest();
      return;
    }
    following.value =
      current.scrollHeight - current.scrollTop - current.clientHeight < FOLLOW_THRESHOLD_PX;
    if (
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

  function scrollToLatest(): void {
    const current = element.value;
    if (current === undefined) return;
    current.scrollTop = current.scrollHeight;
    following.value = true;
  }

  async function scrollToLatestAfterLayout(): Promise<void> {
    const target = element.value;
    if (target === undefined) return;
    scrollToLatest();
    await nextTick();
    if (element.value !== target || !following.value) return;
    scrollToLatest();
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    if (element.value !== target || !following.value) return;
    scrollToLatest();
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    if (element.value !== target || !following.value) return;
    scrollToLatest();
  }

  return {
    element,
    following,
    positioningInitialConversation,
    setElement,
    handleScroll,
    handleResize,
    scrollToLatest,
    scrollToLatestAfterLayout
  };
}
