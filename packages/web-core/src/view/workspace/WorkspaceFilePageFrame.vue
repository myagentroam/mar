<script setup lang="ts">
import MarIcon from '../common/MarIcon.vue';
import { tooltipOptions } from '../../util/tooltip.js';
import { computed, ref, useSlots } from 'vue';
import { translate } from '../../service/LocalePreferenceService.js';
import FilePreviewLoading from './FilePreviewLoading.vue';

const props = withDefaults(
  defineProps<{
    readonly fileName: string;
    readonly path: string;
    readonly sourceLabel?: string | undefined;
    readonly loading?: boolean;
    readonly fullscreen?: boolean;
    readonly mobileActionsLabel?: string | undefined;
    readonly mobileActionsLayout?: 'compact' | 'wrap' | 'stacked';
  }>(),
  { mobileActionsLayout: 'wrap' }
);

const pathLabel = computed(() => (props.path === props.fileName ? undefined : props.path));
const root = ref<HTMLElement>();
const mobileActionsExpanded = ref(true);
const slots = useSlots();

function toggleMobileActions(): void {
  mobileActionsExpanded.value = !mobileActionsExpanded.value;
}

defineExpose({ root });
</script>

<template>
  <section
    ref="root"
    class="workspace-file-page-frame"
    role="dialog"
    tabindex="-1"
    :class="{ 'is-loading': props.loading, 'is-fullscreen': props.fullscreen }"
    :aria-busy="props.loading || undefined"
  >
    <header class="file-preview-header workspace-file-page-frame-header">
      <div class="workspace-file-page-frame-title">
        <span v-if="props.sourceLabel" class="file-preview-eyebrow">{{ props.sourceLabel }}</span>
        <el-tooltip v-bind="tooltipOptions" :content="props.path">
          <h2 :aria-description="props.path">{{ props.fileName }}</h2>
        </el-tooltip>
        <el-tooltip v-bind="tooltipOptions" v-if="pathLabel" :content="props.path"
          ><small>{{ pathLabel }}</small></el-tooltip
        >
        <slot name="status" />
      </div>
      <div class="file-preview-actions file-preview-desktop-actions">
        <slot name="leading-actions" />
        <slot name="primary-actions" />
        <slot name="secondary-actions" />
      </div>
    </header>
    <div class="workspace-file-page-frame-content">
      <FilePreviewLoading v-if="props.loading" overlay />
      <slot />
    </div>
    <div
      v-if="slots['mobile-actions']"
      class="mobile-preview-actions workspace-file-mobile-actions"
      :class="[`is-${props.mobileActionsLayout}`, { 'is-collapsed': !mobileActionsExpanded }]"
      :aria-label="
        props.mobileActionsLabel ?? translate('generated.filePreviewDialog.filePreviewActions')
      "
    >
      <div
        class="workspace-file-mobile-actions-body"
        :aria-hidden="!mobileActionsExpanded"
        :inert="!mobileActionsExpanded"
      >
        <slot name="mobile-actions" />
      </div>
      <el-tooltip
        v-bind="tooltipOptions"
        :content="
          mobileActionsExpanded
            ? translate('filePreviewDialog.collapseMobileActions')
            : translate('filePreviewDialog.expandMobileActions')
        "
        ><span class="mar-tooltip-control"
          ><button
            class="workspace-file-mobile-actions-toggle"
            type="button"
            :aria-expanded="mobileActionsExpanded"
            :aria-label="
              mobileActionsExpanded
                ? translate('filePreviewDialog.collapseMobileActions')
                : translate('filePreviewDialog.expandMobileActions')
            "
            @click="toggleMobileActions"
          >
            <MarIcon name="menu" v-if="mobileActionsExpanded" />
            <MarIcon name="menu" v-else /></button></span
      ></el-tooltip>
    </div>
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
}

.workspace-file-page-frame-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  border-bottom: 1px solid var(--mar-border-strong);
  background: var(--mar-bg-panel);
  padding: 0.3rem 1rem;
}

.workspace-file-page-frame-title > h2 {
  overflow: hidden;
  max-width: min(68vw, 860px);
  margin: 0;
  font-family: var(--mar-font-mono);
  font-size: var(--mar-font-size-body);
  font-weight: 500;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.workspace-file-mobile-actions {
  display: none;
}

.workspace-file-page-frame-title > h2,
.workspace-file-page-frame-title > small {
  display: block;
  overflow: hidden;
  line-height: 1.2;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.workspace-file-page-frame-title :deep(.file-preview-eyebrow) {
  line-height: 1.2;
}

.workspace-file-page-frame-title > small {
  color: var(--el-text-color-secondary);
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

@media (min-width: 768px) {
  .workspace-file-page-frame-title {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    column-gap: 8px;
    align-items: center;
  }

  .workspace-file-page-frame-title > h2 {
    grid-area: 1 / 1;
  }

  .workspace-file-page-frame-title > small {
    grid-row: 2;
    grid-column: 1 / -1;
  }

  .workspace-file-page-frame-title :deep(.file-preview-eyebrow) {
    grid-area: 1 / 2;
    margin-bottom: 0;
    white-space: nowrap;
  }

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

  .file-preview-desktop-actions :deep(.el-button + .el-button) {
    margin-left: 0;
  }

  .file-preview-desktop-actions :deep(.el-button.is-circle) {
    width: var(--mar-compact-control-size);
    height: var(--mar-compact-control-size);
    border-radius: var(--mar-radius-control);
  }
}

@media (max-width: 767px) {
  .workspace-file-page-frame-header > .file-preview-desktop-actions {
    display: none;
  }
  .workspace-file-mobile-actions {
    position: fixed;
    z-index: 3;
    right: max(0.75rem, env(safe-area-inset-right));
    bottom: calc(0.75rem + env(safe-area-inset-bottom));
    display: flex;
    align-items: center;
    gap: 0;
    border: 1px solid var(--mar-border-default);
    border-radius: 0.75rem;
    background: color-mix(in srgb, var(--mar-bg-panel) 96%, transparent);
    box-shadow: 0 4px 14px var(--mar-shadow-medium);
    padding: 0.25rem 0.2rem 0.25rem 0.25rem;
  }
  .workspace-file-mobile-actions :deep(.el-button) {
    width: 36px;
    min-width: 36px;
    height: 36px;
    min-height: 36px;
  }
  .workspace-file-page-frame-header {
    align-items: flex-start;
  }

  .workspace-file-page-frame .file-preview-actions {
    min-height: 36px;
  }

  .workspace-file-mobile-actions-body {
    display: flex;
    min-width: 0;
    max-height: 6rem;
    gap: 0.35rem;
    justify-content: flex-end;
    overflow: hidden;
    opacity: 1;
    transform: translateX(0) scaleX(1);
    transform-origin: right center;
    transition:
      max-width 0.18s ease,
      max-height 0.18s ease,
      opacity 0.14s ease,
      transform 0.18s ease;
  }

  .workspace-file-mobile-actions.is-compact .workspace-file-mobile-actions-body {
    max-width: min(4.9rem, calc(100vw - 4.5rem));
  }

  .workspace-file-mobile-actions.is-wrap .workspace-file-mobile-actions-body {
    max-width: min(10.4rem, calc(100vw - 4.5rem));
    flex-wrap: wrap;
  }

  .workspace-file-mobile-actions.is-stacked .workspace-file-mobile-actions-body {
    max-width: min(16rem, calc(100vw - 4.5rem));
    flex-direction: column;
    gap: 0.25rem;
    justify-content: center;
  }

  .workspace-file-mobile-actions-body :deep(.el-button + .el-button) {
    margin-left: 0;
  }

  .workspace-file-mobile-actions-toggle {
    display: grid;
    width: 36px;
    min-width: 36px;
    height: 36px;
    min-height: 36px;
    place-items: center;
    margin-left: 0.2rem;
    border: 0;
    background: transparent;
    color: var(--mar-text-secondary);
    cursor: pointer;
    font-size: 1.1rem;
  }

  .workspace-file-mobile-actions-toggle:hover,
  .workspace-file-mobile-actions-toggle:active {
    background: transparent;
    color: var(--mar-color-brand);
  }

  .workspace-file-mobile-actions-toggle:focus-visible {
    background: transparent;
    box-shadow: 0 0 0 2px color-mix(in srgb, var(--mar-color-brand) 35%, transparent);
    color: var(--mar-color-brand);
    outline: none;
  }

  .workspace-file-mobile-actions.is-collapsed .workspace-file-mobile-actions-body {
    max-width: 0;
    max-height: 0;
    opacity: 0;
    transform: translateX(0.45rem) scaleX(0.92);
    pointer-events: none;
  }

  .workspace-file-mobile-actions.is-collapsed .workspace-file-mobile-actions-toggle {
    margin-left: 0;
  }
}
</style>
