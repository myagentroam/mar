<script setup lang="ts">
import MarIcon from '../common/MarIcon.vue';
import { translate } from '../../service/LocalePreferenceService.js';
import BusyIndicator from '../common/BusyIndicator.vue';
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';

const props = defineProps<{
  readonly hasOlder: boolean;
  readonly loadingInitial: boolean;
  readonly initialLoadFailed: boolean;
  readonly loadingOlder: boolean;
  readonly olderError?: string;
  readonly hasTurns: boolean;
  readonly following: boolean;
}>();

const emit = defineEmits<{
  scrollElement: [element: HTMLElement | undefined];
  scroll: [];
  loadOlder: [];
  latest: [];
  reload: [];
}>();

const element = ref<HTMLElement>();
const content = ref<HTMLElement>();
let contentObserver: ResizeObserver | undefined;
const reloading = ref(false);
const olderAction = ref<'retry' | 'load'>();

watch(
  () => props.loadingInitial,
  (loading) => {
    if (!loading) reloading.value = false;
  }
);
watch(
  () => props.loadingOlder,
  (loading) => {
    if (!loading) olderAction.value = undefined;
    else if (typeof document !== 'undefined') {
      const button = element.value?.querySelector('.conversation-history-control button');
      // Focusing an offscreen button can scroll to the automatic pagination boundary.
      if (button && button === document.activeElement)
        olderAction.value ??=
          button.getAttribute('data-history-action') === 'retry' ? 'retry' : 'load';
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
  if (props.loadingOlder || olderAction.value !== undefined) return;
  olderAction.value = props.olderError ? 'retry' : 'load';
  emit('loadOlder');
  await nextTick();
  if (!props.loadingOlder) olderAction.value = undefined;
}

onMounted(() => {
  emit('scrollElement', element.value);
  if (content.value && typeof ResizeObserver !== 'undefined') {
    contentObserver = new ResizeObserver(() => emit('scroll'));
    contentObserver.observe(content.value);
  }
});
onBeforeUnmount(() => {
  contentObserver?.disconnect();
  emit('scrollElement', undefined);
});
</script>

<template>
  <div class="conversation-scroll-region">
    <div ref="element" class="conversation-scroll" @scroll="emit('scroll')">
      <div ref="content" class="conversation-scroll-content">
        <div
          v-if="loadingInitial && !reloading"
          class="conversation-load-older conversation-loading-initial"
          role="status"
          aria-live="polite"
          :aria-label="translate('generated.conversationScroll.loadingConversationHistory')"
        >
          <BusyIndicator class="history-busy-indicator" />
        </div>
        <el-button
          v-if="initialLoadFailed || reloading"
          class="conversation-load-older conversation-reload"
          link
          type="primary"
          size="small"
          native-type="button"
          :aria-disabled="loadingInitial || reloading"
          :aria-busy="loadingInitial || reloading"
          @click="reload"
        >
          <template v-if="loadingInitial || reloading" #icon>
            <MarIcon name="loading-action" />
          </template>
          {{ translate('generated.conversationScroll.reloadConversationHistory') }}
        </el-button>
        <div
          v-if="!loadingInitial && !initialLoadFailed && !reloading && hasOlder && hasTurns"
          class="conversation-history-control"
          :aria-busy="loadingOlder"
        >
          <p v-if="olderError" class="conversation-history-error" role="status">{{ olderError }}</p>
          <div
            v-if="loadingOlder && olderAction === undefined"
            class="conversation-load-older"
            role="status"
            :aria-label="translate('generated.conversationScroll.loadingEarlierMessages')"
          >
            <BusyIndicator class="history-busy-indicator" />
          </div>
          <el-button
            v-if="!loadingOlder || olderAction !== undefined"
            class="conversation-load-older"
            link
            type="primary"
            size="small"
            native-type="button"
            :aria-disabled="loadingOlder"
            :aria-busy="loadingOlder"
            :data-history-action="olderAction ?? (olderError ? 'retry' : 'load')"
            @click="loadOlder"
          >
            <template v-if="loadingOlder" #icon>
              <MarIcon name="loading-action" />
            </template>
            {{
              (olderAction ?? (olderError ? 'retry' : 'load')) === 'retry'
                ? translate('conversationActivity.retry')
                : translate('generated.conversationScroll.loadEarlierMessages')
            }}
          </el-button>
        </div>
        <p
          v-else-if="!loadingInitial && !initialLoadFailed && !reloading && hasTurns"
          class="conversation-history-start"
        >
          {{ translate('conversationActivity.historyStart') }}
        </p>
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
.conversation-history-control,
.conversation-history-start {
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

.conversation-scroll-content {
  display: flow-root;
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

.history-busy-indicator {
  color: var(--mar-color-brand-text);
}

.conversation-latest {
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
  bottom: 0.75rem;
  z-index: 2;
}

.conversation-status.has-latest {
  bottom: calc(0.75rem + var(--mar-utility-control-size) + 0.5rem);
}

@media (max-width: 767px) {
  .conversation-scroll-region:has(.conversation-status:not(:empty)) .conversation-scroll {
    padding-bottom: calc(var(--mar-utility-control-size) + 0.5rem);
  }

  .conversation-status:not(.has-latest) {
    bottom: 0.25rem;
  }
}
</style>
