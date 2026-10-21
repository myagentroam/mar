<script setup lang="ts">
import { translate } from '../../service/LocalePreferenceService.js';
import { Bottom } from '@element-plus/icons-vue';
import { onBeforeUnmount, onMounted, ref } from 'vue';

defineProps<{
  readonly hasOlder: boolean;
  readonly loadingInitial: boolean;
  readonly initialLoadFailed: boolean;
  readonly loadingOlder: boolean;
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

onMounted(() => emit('scrollElement', element.value));
onBeforeUnmount(() => emit('scrollElement', undefined));
</script>

<template>
  <div class="conversation-scroll-region">
    <div ref="element" class="conversation-scroll" @scroll="emit('scroll')">
      <div
        v-if="loadingInitial"
        class="conversation-load-older conversation-loading-initial"
        role="status"
        aria-live="polite"
      >
        {{ translate('generated.conversationScroll.loadingConversationHistory') }}
      </div>
      <el-button
        v-else-if="initialLoadFailed"
        class="conversation-load-older conversation-reload"
        link
        type="primary"
        size="small"
        native-type="button"
        @click="emit('reload')"
      >
        {{ translate('generated.conversationScroll.reloadConversationHistory') }}
      </el-button>
      <el-button
        v-else-if="hasOlder && hasTurns"
        class="conversation-load-older"
        link
        type="primary"
        size="small"
        native-type="button"
        :disabled="loadingOlder"
        @click="emit('loadOlder')"
      >
        {{
          loadingOlder
            ? translate('generated.conversationScroll.loadingEarlierMessages')
            : translate('generated.conversationScroll.loadEarlierMessages')
        }}
      </el-button>
      <slot />
    </div>
    <el-button
      v-if="!following && hasTurns"
      class="conversation-latest"
      size="small"
      round
      native-type="button"
      @click="emit('latest')"
    >
      <el-icon aria-hidden="true"><Bottom /></el-icon>
      {{ translate('generated.conversationScroll.jumpToLatest') }}
    </el-button>
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

.conversation-load-older {
  display: flex;
  width: max-content;
  max-width: 100%;
  margin: 0 auto 0.8rem;
}

.conversation-loading-initial {
  color: var(--mar-text-faint);
  font-size: 0.7rem;
  text-align: center;
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

.conversation-status {
  position: absolute;
  right: 1rem;
  bottom: 0.75rem;
  z-index: 2;
}

.conversation-status.has-latest {
  bottom: calc(0.75rem + var(--mar-utility-control-size) + 0.5rem);
}
</style>
