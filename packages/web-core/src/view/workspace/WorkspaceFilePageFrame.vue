<script setup lang="ts">
import './file-tooltip-trigger.css';
import './file-preview.css';
import './view-toolbar-control.css';
import { computed, nextTick, onBeforeUnmount, ref, useSlots, watch } from 'vue';
import { createMobileSurfaceFocusService } from '../../service/mobile-surface-focus-service.js';
import { translate } from '../../service/locale-preference-service.js';
import WorkspaceFloatingActions from '../common/WorkspaceFloatingActions.vue';
import FilePreviewLoading from './FilePreviewLoading.vue';
import FilePreviewState from './FilePreviewState.vue';

const props = withDefaults(
  defineProps<{
    readonly fileName: string;
    readonly path: string;
    readonly sourceLabel?: string | undefined;
    readonly loading?: boolean;
    readonly loadError?: string | undefined;
    readonly fullscreen?: boolean;
    readonly contained?: boolean;
    readonly mobileActionsLabel?: string | undefined;
    readonly mobileActionsLayout?: 'compact' | 'wrap' | 'stacked' | 'image';
  }>(),
  { mobileActionsLayout: 'wrap' }
);

const pathLabel = computed(() => (props.path === props.fileName ? undefined : props.path));
const emit = defineEmits<{ retry: [] }>();
const root = ref<HTMLElement>();
const retrying = ref(false);
watch(
  () => props.path,
  () => {
    retrying.value = false;
  }
);
watch(
  () => props.loading,
  (loading) => {
    if (loading || !retrying.value) return;
    const active = document.activeElement;
    if (!props.loadError && active?.closest('.file-preview-state') && root.value?.contains(active))
      root.value.focus({ preventScroll: true });
    retrying.value = false;
  }
);
async function retryRead(): Promise<void> {
  if (props.loading || retrying.value) return;
  retrying.value = true;
  emit('retry');
  await nextTick();
  if (!props.loading) retrying.value = false;
}
const slots = useSlots();
const focus = createMobileSurfaceFocusService({
  isOpen: () => props.fullscreen === true && !props.contained,
  regions: () => [root.value]
});
onBeforeUnmount(focus.dispose);

defineExpose({ root });
</script>

<template>
  <section
    ref="root"
    class="workspace-file-page-frame"
    :role="props.fullscreen && !props.contained ? 'dialog' : 'region'"
    :aria-modal="(props.fullscreen && !props.contained) || undefined"
    tabindex="-1"
    :class="{ 'is-loading': props.loading, 'is-fullscreen': props.fullscreen && !props.contained }"
    :aria-busy="props.loading || undefined"
  >
    <header class="file-preview-header workspace-file-page-frame-header">
      <div class="workspace-file-page-frame-title">
        <div class="workspace-file-page-frame-heading">
          <h2 v-tooltip="props.path" :aria-description="props.path">{{ props.fileName }}</h2>
          <span v-if="props.sourceLabel || slots.metadata" class="mar-file-preview-eyebrow">
            <slot name="metadata">{{ props.sourceLabel }}</slot>
          </span>
        </div>
        <small v-tooltip="props.path" v-if="pathLabel">{{ pathLabel }}</small>
        <slot name="status" />
      </div>
      <div class="mar-file-preview-actions file-preview-desktop-actions">
        <slot name="leading-actions" />
        <slot name="primary-actions" />
        <slot name="secondary-actions" />
      </div>
    </header>
    <div class="workspace-file-page-frame-content">
      <FilePreviewLoading v-if="props.loading && !retrying" overlay />
      <FilePreviewState
        v-if="retrying || (!props.loading && props.loadError)"
        :message="props.loadError ?? ''"
        :retrying="retrying"
        retryable
        @retry="retryRead"
      />
      <slot v-else-if="!props.loadError" />
    </div>
    <WorkspaceFloatingActions
      v-if="slots['mobile-actions']"
      class="mobile-preview-actions workspace-file-mobile-actions"
      :layout="props.mobileActionsLayout"
      :label="
        props.mobileActionsLabel ?? translate('generated.filePreviewDialog.filePreviewActions')
      "
      :collapse-label="translate('filePreviewDialog.collapseMobileActions')"
      :expand-label="translate('filePreviewDialog.expandMobileActions')"
      mobile-only
    >
      <slot name="mobile-actions" />
    </WorkspaceFloatingActions>
  </section>
</template>

<style scoped>
.workspace-file-page-frame {
  display: flex;
  min-width: 0;
  min-height: 0;
  flex: 1;
  flex-direction: column;
  overflow: hidden;
}

.workspace-file-page-frame.is-fullscreen {
  position: fixed;
  z-index: 50;
  inset: 0;
  background: var(--mar-bg-page);
  color: var(--mar-text-primary);
}

.workspace-file-page-frame-title {
  min-width: 0;
  flex: 1;
}

.workspace-file-page-frame-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  border-bottom: 1px solid var(--mar-border-subtle);
  background: var(--mar-bg-panel);
  padding: 0.3rem 1rem;
}

.workspace-file-page-frame-heading {
  display: flex;
  align-items: baseline;
  gap: 0.5rem;
}

.workspace-file-page-frame-heading > h2 {
  margin: 0;
  font-family: var(--mar-font-mono);
  font-size: var(--mar-font-size-body);
  font-weight: 500;
}

.workspace-file-page-frame-heading > h2,
.workspace-file-page-frame-title > small {
  display: block;
  overflow: hidden;
  line-height: 1.2;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.mar-file-preview-eyebrow {
  flex: none;
  color: var(--mar-text-secondary);
  font-size: var(--mar-font-size-meta);
  font-weight: 400;
  line-height: 1.2;
  white-space: nowrap;
}

.workspace-file-page-frame-title > small {
  color: var(--mar-text-secondary);
  font-family: var(--mar-font-mono);
  font-size: var(--mar-font-size-meta);
}

.workspace-file-page-frame-content {
  position: relative;
  isolation: isolate;
  display: flex;
  min-height: 0;
  flex: 1;
  flex-direction: column;
}

.workspace-file-page-frame :deep(.mar-file-preview-actions .mar-ui-button.mar-ui-button--circle) {
  border-radius: var(--mar-radius-control);
}

@media (min-width: 768px) {
  .workspace-file-page-frame-header {
    box-sizing: border-box;
    min-height: var(--mar-workbench-header-height);
    height: var(--mar-workbench-header-height);
    flex-shrink: 0;
    padding: 0 12px;
  }

  .file-preview-desktop-actions {
    align-items: center;
    gap: 6px;
  }

  .file-preview-desktop-actions :deep(.mar-ui-button + .mar-ui-button) {
    margin-left: 0;
  }

  .file-preview-desktop-actions :deep(.mar-ui-button.mar-ui-button--circle) {
    width: var(--mar-compact-control-size);
    height: var(--mar-compact-control-size);
  }
}

@media (max-width: 767px) {
  .workspace-file-page-frame-header > .file-preview-desktop-actions {
    display: none;
  }
  .workspace-file-page-frame-header {
    align-items: flex-start;
  }

  .workspace-file-page-frame .mar-file-preview-actions {
    min-height: 36px;
  }
}
</style>
