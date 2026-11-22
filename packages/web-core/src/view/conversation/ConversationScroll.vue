<script setup lang="ts">
import { MarButton } from '@myagentroam/mar-ui/button';
import { translate } from '../../service/locale-preference-service.js';
import MarBusyIndicator from '@myagentroam/mar-ui/busy-indicator';
import {
  computed,
  nextTick,
  onBeforeUnmount,
  onBeforeUpdate,
  onMounted,
  onUpdated,
  ref,
  watch
} from 'vue';

const props = defineProps<{
  readonly contextKey?: string | undefined;
  readonly hasOlder: boolean;
  readonly loadingInitial: boolean;
  readonly initialSyncPending?: boolean;
  readonly initialLoadFailed: boolean;
  readonly initialError?: string | undefined;
  readonly loadingOlder: boolean;
  readonly olderError?: string;
  readonly hasTurns: boolean;
  readonly following: boolean;
  readonly emptyPrompt?: 'workspace' | 'hosted' | undefined;
}>();

const emit = defineEmits<{
  scrollElement: [element: HTMLElement | undefined];
  scroll: [];
  scrollIntent: [];
  loadOlder: [];
  latest: [];
  reload: [];
}>();

const region = ref<HTMLElement>();
const element = ref<HTMLElement>();
const content = ref<HTMLElement>();
const historyMarker = ref<HTMLElement>();
const showFocusOutline = ref(false);
const hasScrollRange = ref(false);
const showLatest = computed(() => hasScrollRange.value && !props.following && props.hasTurns);
let contentObserver: ResizeObserver | undefined;
let renderedEmpty = false;
let previousComposerRect: DOMRect | undefined;
let composerAnimation: Animation | undefined;
let motionPreference: MediaQueryList | undefined;
const reloading = ref(false);
const olderAction = ref<'retry' | 'load'>();
let touchY: number | undefined;
let scrollbarPointerY: number | undefined;
let initialLayoutChecked = false;
let initialLayoutFrame: number | undefined;

function historyMarkerVisible(): boolean {
  const current = element.value;
  const marker = historyMarker.value;
  if (!current || current.clientHeight === 0 || !marker) return false;
  const markerRect = marker.getBoundingClientRect();
  const viewport = current.getBoundingClientRect();
  return markerRect.bottom > viewport.top && markerRect.top < viewport.bottom;
}

function scheduleInitialHistoryCheck(): void {
  if (initialLayoutChecked || initialLayoutFrame !== undefined) return;
  initialLayoutFrame = requestAnimationFrame(() => {
    initialLayoutFrame = undefined;
    const current = element.value;
    if (
      initialLayoutChecked ||
      current === undefined ||
      current.clientHeight === 0 ||
      props.loadingInitial ||
      props.initialSyncPending ||
      props.initialLoadFailed ||
      props.loadingOlder ||
      !props.hasTurns
    )
      return;
    initialLayoutChecked = true;
    if (!props.olderError && historyMarkerVisible()) void loadOlder();
  });
}

function canScroll(current = element.value): boolean {
  return (
    current !== undefined && current.clientHeight > 0 && current.scrollHeight > current.clientHeight
  );
}

function onScroll(): void {
  hasScrollRange.value = canScroll();
  emit('scroll');
}

function onUpwardIntent(): void {
  const atHistoryBoundary = !props.olderError && historyMarkerVisible();
  if (canScroll() || atHistoryBoundary) emit('scrollIntent');
  if (atHistoryBoundary) void loadOlder();
}

function onWheel(event: WheelEvent): void {
  if (event.deltaY < 0) onUpwardIntent();
}

function onTouchStart(event: TouchEvent): void {
  touchY = event.touches[0]?.clientY;
}

function onTouchMove(event: TouchEvent): void {
  const nextY = event.touches[0]?.clientY;
  if (nextY !== undefined && touchY !== undefined && nextY > touchY) onUpwardIntent();
  touchY = nextY;
}

function onScrollFocus(): void {
  // Keep the browser's indication at focus entry, not when a modifier later changes its heuristic.
  showFocusOutline.value = element.value?.matches(':focus-visible') === true;
}

function onScrollKeydown(event: KeyboardEvent): void {
  const target = event.target;
  if (
    event.defaultPrevented ||
    (target instanceof HTMLElement &&
      (target.isContentEditable || target.closest('input, textarea, select')))
  )
    return;
  // Modified Page Up/Down shortcuts do not scroll the conversation.
  if ((event.ctrlKey || event.altKey) && (event.key === 'PageUp' || event.key === 'PageDown'))
    return;
  const scrollsUp =
    ['ArrowUp', 'PageUp', 'Home'].includes(event.key) || (event.key === ' ' && event.shiftKey);
  if (
    target === event.currentTarget &&
    (scrollsUp || ['ArrowDown', 'PageDown', 'End', ' '].includes(event.key))
  )
    showFocusOutline.value = true;
  if (scrollsUp) onUpwardIntent();
}

function onScrollPointerdown(event: PointerEvent): void {
  scrollbarPointerY = undefined;
  if (event.button === 0) showFocusOutline.value = false;
  const current = element.value;
  if (
    event.button !== 0 ||
    event.pointerType === 'touch' ||
    current === undefined ||
    !canScroll(current) ||
    event.target !== current
  )
    return;
  const scrollbarWidth = current.offsetWidth - current.clientWidth - current.clientLeft;
  const right = current.getBoundingClientRect().right;
  if (scrollbarWidth <= 0) {
    // Overlay scrollbars have no gutter; a click alone must not pause following.
    const overlayWidth =
      Number.parseFloat(getComputedStyle(current, '::-webkit-scrollbar').width) || 8;
    if (event.clientX >= right - overlayWidth && event.clientX < right)
      scrollbarPointerY = event.clientY;
    return;
  }
  if (event.clientX >= right - scrollbarWidth && event.clientX < right) {
    scrollbarPointerY = event.clientY;
    emit('scrollIntent');
  }
}

function onScrollbarPointermove(event: PointerEvent): void {
  if (scrollbarPointerY === undefined) return;
  if (event.buttons === 1 && event.clientY < scrollbarPointerY) onUpwardIntent();
  scrollbarPointerY = event.buttons === 1 ? event.clientY : undefined;
}

const showEmptyPrompt = computed(
  () =>
    props.emptyPrompt !== undefined &&
    !props.hasTurns &&
    !props.hasOlder &&
    !props.loadingInitial &&
    !props.initialLoadFailed &&
    !props.loadingOlder &&
    !props.olderError &&
    !reloading.value
);

watch(
  () => props.contextKey,
  () => {
    initialLayoutChecked = false;
  }
);
watch(
  () => props.loadingInitial,
  (loading) => {
    if (loading) initialLayoutChecked = false;
    if (!loading) {
      const button = element.value?.querySelector('.conversation-reload');
      if (reloading.value && !props.initialLoadFailed && button === document.activeElement)
        element.value?.focus({ preventScroll: true });
      reloading.value = false;
    }
  }
);
watch(
  () => props.initialSyncPending,
  (pending) => {
    if (pending) initialLayoutChecked = false;
  }
);
watch(
  () => props.loadingOlder,
  (loading) => {
    if (loading) initialLayoutChecked = true;
    if (!loading) {
      const button = element.value?.querySelector('.conversation-history-control button');
      if (!props.olderError && button === document.activeElement)
        element.value?.focus({ preventScroll: true });
      olderAction.value = undefined;
    }
  }
);

async function reload(): Promise<void> {
  if (props.loadingInitial || reloading.value) return;
  reloading.value = true;
  emit('reload');
  await nextTick();
  if (!props.loadingInitial) reloading.value = false;
}

async function loadOlder(): Promise<void> {
  if (
    props.loadingInitial ||
    props.initialLoadFailed ||
    !props.hasOlder ||
    props.loadingOlder ||
    olderAction.value !== undefined
  )
    return;
  olderAction.value = props.olderError ? 'retry' : 'load';
  emit('loadOlder');
  await nextTick();
  if (!props.loadingOlder) olderAction.value = undefined;
}

function composerHost(): HTMLElement | undefined {
  const sibling = region.value?.nextElementSibling;
  return sibling instanceof HTMLElement && sibling.classList.contains('composer-host')
    ? sibling
    : undefined;
}

function cancelComposerMotion(): void {
  composerAnimation?.cancel();
  composerAnimation = undefined;
}

function updateMotionPreference(event: MediaQueryListEvent): void {
  if (event.matches) cancelComposerMotion();
}

onBeforeUpdate(() => {
  if (!props.hasOlder && historyMarker.value?.contains(document.activeElement))
    element.value?.focus({ preventScroll: true });
  const composer = composerHost();
  const motionAllowed =
    motionPreference?.matches === false &&
    window.matchMedia('(min-width: 768px)').matches &&
    !document.hidden;
  if (showEmptyPrompt.value || !motionAllowed) cancelComposerMotion();
  previousComposerRect =
    renderedEmpty && !showEmptyPrompt.value && composer !== undefined && motionAllowed
      ? composer.getBoundingClientRect()
      : undefined;
});

onUpdated(() => {
  scheduleInitialHistoryCheck();
  renderedEmpty = showEmptyPrompt.value;
  const previous = previousComposerRect;
  previousComposerRect = undefined;
  const composer = composerHost();
  if (previous === undefined || composer === undefined) return;
  const next = composer.getBoundingClientRect();
  const deltaX = previous.x - next.x;
  const deltaY = previous.y - next.y;
  cancelComposerMotion();
  if (Math.abs(deltaX) < 0.5 && Math.abs(deltaY) < 0.5) return;
  const animation = composer.animate(
    [{ transform: `translate(${deltaX}px, ${deltaY}px)` }, { transform: 'translate(0px, 0px)' }],
    { duration: 180, easing: 'cubic-bezier(0.2, 0, 0, 1)' }
  );
  composerAnimation = animation;
  const finished = () => {
    if (composerAnimation === animation) composerAnimation = undefined;
  };
  void animation.finished.then(finished, finished);
});

onMounted(() => {
  renderedEmpty = showEmptyPrompt.value;
  motionPreference = window.matchMedia('(prefers-reduced-motion: reduce)');
  motionPreference.addEventListener('change', updateMotionPreference);
  emit('scrollElement', element.value);
  hasScrollRange.value = canScroll();
  scheduleInitialHistoryCheck();
  if (content.value && typeof ResizeObserver !== 'undefined') {
    contentObserver = new ResizeObserver(() => {
      onScroll();
      scheduleInitialHistoryCheck();
    });
    contentObserver.observe(content.value);
    if (element.value) contentObserver.observe(element.value);
  }
});
onBeforeUnmount(() => {
  if (initialLayoutFrame !== undefined) cancelAnimationFrame(initialLayoutFrame);
  contentObserver?.disconnect();
  motionPreference?.removeEventListener('change', updateMotionPreference);
  cancelComposerMotion();
  emit('scrollElement', undefined);
});
</script>

<template>
  <div
    ref="region"
    class="conversation-scroll-region"
    :class="{
      'is-empty': showEmptyPrompt,
      'is-workspace-welcome': showEmptyPrompt && emptyPrompt === 'workspace'
    }"
  >
    <div
      ref="element"
      class="conversation-scroll"
      :class="{ 'shows-focus-outline': showFocusOutline }"
      tabindex="0"
      @focus="onScrollFocus"
      @scroll="onScroll"
      @wheel.passive="onWheel"
      @touchstart.passive="onTouchStart"
      @touchmove.passive="onTouchMove"
      @keydown="onScrollKeydown"
      @pointerdown="onScrollPointerdown"
      @pointermove="onScrollbarPointermove"
      @pointerup="scrollbarPointerY = undefined"
      @pointercancel="scrollbarPointerY = undefined"
    >
      <div
        ref="content"
        class="conversation-scroll-content"
        :class="{ 'is-empty': showEmptyPrompt }"
      >
        <div
          v-if="loadingInitial && !initialLoadFailed && !reloading"
          class="conversation-load-older conversation-loading-initial"
          :class="{ 'is-centered': !hasTurns }"
          role="status"
          aria-live="polite"
          :aria-label="translate('generated.conversationScroll.loadingConversationHistory')"
        >
          <MarBusyIndicator class="history-busy-indicator mar-read-loading-indicator" />
        </div>
        <MarButton
          v-if="initialLoadFailed || reloading"
          class="conversation-load-older conversation-reload"
          :class="{ 'is-centered': !hasTurns }"
          v-tooltip="!loadingInitial && !reloading ? initialError : ''"
          :aria-description="!loadingInitial && !reloading ? initialError : undefined"
          link
          native-type="button"
          :aria-disabled="loadingInitial || reloading"
          :aria-busy="loadingInitial || reloading"
          :aria-label="
            loadingInitial || reloading
              ? translate('generated.conversationScroll.loadingConversationHistory')
              : undefined
          "
          @click="reload"
        >
          <MarBusyIndicator
            v-if="loadingInitial || reloading"
            class="history-busy-indicator mar-read-loading-indicator"
          />
          <template v-else>{{ translate('common.loadFailedRetry') }}</template>
        </MarButton>
        <div
          v-if="!loadingInitial && !initialLoadFailed && !reloading && hasOlder && hasTurns"
          ref="historyMarker"
          class="conversation-history-control"
          :aria-busy="loadingOlder || olderAction !== undefined"
        >
          <div
            v-if="(loadingOlder || olderAction !== undefined) && olderAction !== 'retry'"
            class="conversation-load-older"
            role="status"
            :aria-label="translate('generated.conversationScroll.loadingEarlierMessages')"
          >
            <MarBusyIndicator class="history-busy-indicator mar-read-loading-indicator" />
          </div>
          <MarButton
            v-if="olderAction === 'retry' || (olderError && !loadingOlder)"
            class="conversation-load-older conversation-history-error"
            v-tooltip="!loadingOlder && olderAction === undefined ? olderError : ''"
            :aria-description="!loadingOlder && olderAction === undefined ? olderError : undefined"
            link
            native-type="button"
            :aria-disabled="loadingOlder"
            :aria-busy="loadingOlder"
            :aria-label="
              loadingOlder || olderAction !== undefined
                ? translate('generated.conversationScroll.loadingEarlierMessages')
                : undefined
            "
            data-history-action="retry"
            @click="loadOlder"
          >
            <MarBusyIndicator
              v-if="loadingOlder || olderAction !== undefined"
              class="history-busy-indicator mar-read-loading-indicator"
            />
            <template v-else>{{ translate('common.loadFailedRetry') }}</template>
          </MarButton>
        </div>
        <section v-if="showEmptyPrompt" class="conversation-empty">
          <h2>{{ translate(`conversationEmpty.${emptyPrompt}.title`) }}</h2>
          <slot name="empty-description">
            <p>{{ translate(`conversationEmpty.${emptyPrompt}.description`) }}</p>
          </slot>
        </section>
        <slot />
      </div>
    </div>
    <Transition name="conversation-latest">
      <MarButton
        v-if="showLatest"
        class="conversation-latest"
        icon="to-bottom"
        round
        native-type="button"
        @click="emit('latest')"
      >
        {{ translate('generated.conversationScroll.jumpToLatest') }}
      </MarButton>
    </Transition>
    <div v-if="$slots.status" class="conversation-status" :class="{ 'has-latest': showLatest }">
      <slot name="status" />
    </div>
  </div>
</template>

<style scoped>
@media (min-width: 768px) {
  .conversation-scroll-region.is-empty {
    margin-top: auto;
  }
}

.conversation-history-control {
  /* Keep loading and retry feedback from shifting the reading viewport. */
  min-height: calc(24px + 0.8rem);
  text-align: center;
  color: var(--mar-text-secondary);
  font-size: var(--mar-font-size-meta);
}
.conversation-history-error {
  overflow-wrap: anywhere;
  margin: 0;
}

.conversation-scroll-region {
  position: relative;
  flex: 1;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}

.conversation-scroll {
  height: 100%;
  min-width: 0;
  overflow: auto;
  padding: 1rem clamp(1rem, 4vw, 2.5rem);
  background: var(--mar-conversation-canvas);
}

@media (min-width: 768px) {
  .conversation-scroll {
    overscroll-behavior: contain;
  }
}

:where(.conversation-header + .conversation-scroll-region:not(.is-empty)) .conversation-scroll {
  padding-block-start: 0.5rem;
}

.conversation-scroll:focus-visible:not(.shows-focus-outline) {
  outline: none;
}

.conversation-scroll.shows-focus-outline:focus {
  outline: 2px solid var(--mar-control-focus);
  outline-offset: -2px;
}

:where(.conversation-scroll-region:not(.is-empty)) .conversation-scroll {
  padding-bottom: 0.5rem;
}

.conversation-scroll-content {
  display: flow-root;
}

.conversation-scroll-content.is-empty {
  display: flex;
  flex-direction: column;
  min-height: 100%;
}

.conversation-empty {
  display: grid;
  flex: 1;
  align-content: center;
  justify-items: center;
  gap: 0.75rem;
  padding: 2rem 1rem;
  text-align: center;
  overflow-wrap: anywhere;
}

@media (min-width: 768px) {
  .conversation-scroll-region.is-empty {
    flex: 0 0 auto;
  }

  .conversation-scroll-region.is-empty .conversation-scroll {
    height: auto;
    overflow: visible;
    background: transparent;
  }

  .conversation-scroll-region.is-workspace-welcome .conversation-scroll {
    padding-block-end: 0;
  }

  .conversation-scroll-region.is-empty .conversation-scroll-content.is-empty {
    min-height: 0;
  }

  .conversation-scroll-region.is-empty .conversation-empty {
    flex: none;
    padding: 0.5rem 1rem 1rem;
  }

  .conversation-scroll-region.is-workspace-welcome .conversation-empty {
    gap: 0.5rem;
    padding-block-end: 0.625rem;
  }
}

.conversation-empty h2 {
  margin: 0;
  color: var(--mar-text-primary);
  font-size: var(--mar-font-size-page-title);
  font-weight: 600;
  line-height: 1.4;
}

.conversation-empty p {
  max-width: 28rem;
  margin: 0;
  color: var(--mar-text-secondary);
  font-size: var(--mar-font-size-body);
  line-height: 1.6;
}

.conversation-load-older {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 24px;
  width: max-content;
  max-width: 100%;
  margin: 0 auto 0.8rem;
}

.conversation-loading-initial.is-centered,
.conversation-reload.is-centered {
  position: absolute;
  inset: 50% auto auto 50%;
  max-width: calc(100% - 16px);
  margin: 0;
  transform: translate(-50%, -50%);
}

.conversation-loading-initial.is-centered {
  position: absolute;
  inset: 0;
  width: auto;
  max-width: none;
  transform: none;
  pointer-events: none;
}

.conversation-latest {
  --mar-ui-button-fg: var(--mar-text-secondary);
  --mar-ui-button-bg: var(--mar-control-bg-color-overlay);
  --mar-ui-button-border: var(--mar-border-default);
  --mar-ui-button-hover-fg: var(--mar-text-primary);
  --mar-ui-button-hover-bg: var(--mar-fill-row-hover);
  --mar-ui-button-hover-border: var(--mar-border-medium);
  --mar-ui-button-active-fg: var(--mar-text-primary);
  --mar-ui-button-active-bg: var(--mar-fill-selection);
  --mar-ui-button-active-border: var(--mar-border-medium);
  position: absolute;
  right: 1rem;
  bottom: 0.75rem;
  z-index: 2;
  min-height: 28px;
  margin: 0;
  box-shadow: 0 2px 8px var(--mar-shadow-soft);
}

.conversation-latest-enter-active,
.conversation-latest-leave-active {
  transition:
    opacity 160ms ease,
    transform 160ms ease;
}

.conversation-latest-enter-from,
.conversation-latest-leave-to {
  opacity: 0;
  transform: translateY(4px);
}

.conversation-latest-leave-active {
  pointer-events: none;
}

@media (prefers-reduced-motion: reduce) {
  .conversation-latest-enter-active,
  .conversation-latest-leave-active {
    transition: none;
  }
}

.conversation-status {
  position: absolute;
  right: 1rem;
  bottom: 0.25rem;
  z-index: 2;
}

.conversation-status.has-latest {
  bottom: calc(0.75rem + var(--mar-utility-control-size) + 0.5rem);
}

@media (max-width: 767px) {
  .conversation-scroll-region:has(.conversation-status:not(:empty)) .conversation-scroll {
    padding-bottom: calc(var(--mar-utility-control-size) + 0.5rem);
  }
}
</style>
