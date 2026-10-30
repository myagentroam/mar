<script setup lang="ts">
import MarIcon from '../common/MarIcon.vue';
import { translate } from '../../service/locale-preference-service.js';
import BusyIndicator from '../common/BusyIndicator.vue';
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
  readonly initialLoadFailed: boolean;
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
  if (current === undefined || current.clientHeight === 0 || marker === undefined) return false;
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
      props.initialLoadFailed ||
      props.loadingOlder ||
      !props.hasTurns
    )
      return;
    initialLayoutChecked = true;
    if (!props.olderError && historyMarkerVisible()) void loadOlder();
  });
}

function onUpwardIntent(): void {
  emit('scrollIntent');
  if (!props.olderError && historyMarkerVisible()) void loadOlder();
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

function onScrollKeydown(event: KeyboardEvent): void {
  const target = event.target;
  if (
    event.defaultPrevented ||
    (target instanceof HTMLElement &&
      (target.isContentEditable || target.closest('input, textarea, select')))
  )
    return;
  if (['ArrowUp', 'PageUp', 'Home'].includes(event.key) || (event.key === ' ' && event.shiftKey))
    onUpwardIntent();
}

function onScrollbarPointerdown(event: PointerEvent): void {
  scrollbarPointerY = undefined;
  const current = element.value;
  if (
    event.button !== 0 ||
    event.pointerType === 'touch' ||
    current === undefined ||
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
  scheduleInitialHistoryCheck();
  if (content.value && typeof ResizeObserver !== 'undefined') {
    contentObserver = new ResizeObserver(() => {
      emit('scroll');
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
  <div ref="region" class="conversation-scroll-region" :class="{ 'is-empty': showEmptyPrompt }">
    <div
      ref="element"
      class="conversation-scroll"
      tabindex="0"
      @scroll="emit('scroll')"
      @wheel.passive="onWheel"
      @touchstart.passive="onTouchStart"
      @touchmove.passive="onTouchMove"
      @keydown="onScrollKeydown"
      @pointerdown="onScrollbarPointerdown"
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
          role="status"
          aria-live="polite"
          :aria-label="translate('generated.conversationScroll.loadingConversationHistory')"
        >
          <BusyIndicator class="history-busy-indicator read-loading-indicator" />
        </div>
        <el-button
          v-if="initialLoadFailed || reloading"
          class="conversation-load-older conversation-reload"
          link
          size="small"
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
          <BusyIndicator
            v-if="loadingInitial || reloading"
            class="history-busy-indicator read-loading-indicator"
          />
          <template v-else>{{ translate('common.loadFailedRetry') }}</template>
        </el-button>
        <div
          v-if="
            !loadingInitial &&
            !initialLoadFailed &&
            !reloading &&
            (hasOlder || olderAction === 'retry') &&
            hasTurns
          "
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
            <BusyIndicator class="history-busy-indicator read-loading-indicator" />
          </div>
          <el-button
            v-if="olderAction === 'retry' || (olderError && !loadingOlder)"
            class="conversation-load-older conversation-history-error"
            link
            size="small"
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
            <BusyIndicator
              v-if="loadingOlder || olderAction !== undefined"
              class="history-busy-indicator read-loading-indicator"
            />
            <template v-else>{{ translate('common.loadFailedRetry') }}</template>
          </el-button>
        </div>
        <section v-if="showEmptyPrompt" class="conversation-empty">
          <h2>{{ translate(`conversationEmpty.${emptyPrompt}.title`) }}</h2>
          <p>{{ translate(`conversationEmpty.${emptyPrompt}.description`) }}</p>
        </section>
        <slot />
      </div>
    </div>
    <Transition name="conversation-latest">
      <el-button
        v-if="!following && hasTurns"
        class="conversation-latest"
        size="small"
        round
        native-type="button"
        @click="emit('latest')"
      >
        <MarIcon name="to-bottom" aria-hidden="true" />
        {{ translate('generated.conversationScroll.jumpToLatest') }}
      </el-button>
    </Transition>
    <div
      v-if="$slots.status"
      class="conversation-status"
      :class="{ 'has-latest': !following && hasTurns }"
    >
      <slot name="status" />
    </div>
  </div>
</template>

<style scoped>
.conversation-history-control {
  min-height: 1px;
  text-align: center;
  color: var(--mar-conversation-muted);
  font-size: var(--mar-font-size-meta);
}
.conversation-history-error {
  color: var(--mar-color-danger-text);
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

.conversation-scroll:focus-visible {
  outline: 2px solid var(--mar-color-brand);
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

  .conversation-scroll-region.is-empty .conversation-scroll-content.is-empty {
    min-height: 0;
  }

  .conversation-scroll-region.is-empty .conversation-empty {
    flex: none;
    padding: 0.5rem 1rem 1rem;
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
  color: var(--mar-conversation-muted);
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

.conversation-loading-initial {
  color: var(--mar-text-faint);
  font-size: var(--mar-font-size-meta);
  text-align: center;
}

.conversation-latest {
  --el-button-text-color: var(--mar-text-secondary);
  --el-button-bg-color: var(--mar-control-bg-color-overlay);
  --el-button-border-color: var(--mar-border-default);
  --el-button-hover-text-color: var(--mar-text-primary);
  --el-button-hover-bg-color: var(--mar-fill-row-hover);
  --el-button-hover-border-color: var(--mar-border-medium);
  --el-button-active-text-color: var(--mar-text-primary);
  --el-button-active-bg-color: var(--mar-fill-selection);
  --el-button-active-border-color: var(--mar-border-medium);
  --el-button-outline-color: var(--mar-color-brand);
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
