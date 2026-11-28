<script setup lang="ts">
import './file-tooltip-trigger.css';
import './file-preview.css';
import './view-toolbar-control.css';
import { computed, nextTick, onBeforeUnmount, ref, useId, useSlots, watch } from 'vue';
import { MarButton } from '@myagentroam/mar-ui/button';
import { MarDropdown, MarDropdownMenu } from '@myagentroam/mar-ui/dropdown';
import { createMobileSurfaceFocusService } from '../../service/mobile-surface-focus-service.js';
import { translate } from '../../service/locale-preference-service.js';
import FilePreviewLoading from './FilePreviewLoading.vue';
import FilePreviewState from './FilePreviewState.vue';

// The frame owns the mobile toolbar and its position; file pages own the actions and state.
const props = defineProps<{
  readonly fileName: string;
  readonly path: string;
  readonly sourceLabel?: string | undefined;
  readonly loading?: boolean;
  readonly loadError?: string | undefined;
  readonly fullscreen?: boolean;
  readonly contained?: boolean;
  readonly mobileActionsLabel?: string | undefined;
}>();

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
const mobileActionsId = useId();
const mobileActionsExpanded = ref(true);
const mobileToggleLabel = computed(() =>
  mobileActionsExpanded.value
    ? translate('filePreviewDialog.collapseToolbar')
    : translate('filePreviewDialog.expandToolbar')
);
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
      <div v-if="slots['mobile-header-actions']" class="file-preview-mobile-header-actions">
        <slot name="mobile-header-actions" />
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
    <div v-if="slots['mobile-actions'] || slots['mobile-menu']" class="file-preview-mobile-footer">
      <div
        class="workspace-file-mobile-actions mar-compact-overlay"
        :class="{
          'is-disclosable': slots['mobile-menu'],
          'is-collapsed': slots['mobile-menu'] && !mobileActionsExpanded
        }"
        role="group"
        :aria-label="
          props.mobileActionsLabel ?? translate('generated.filePreviewDialog.filePreviewActions')
        "
      >
        <div
          :id="mobileActionsId"
          class="file-preview-mobile-reveal"
          :inert="!!slots['mobile-menu'] && !mobileActionsExpanded"
          :aria-hidden="(!!slots['mobile-menu'] && !mobileActionsExpanded) || undefined"
        >
          <div class="file-preview-mobile-clip">
            <div class="file-preview-mobile-row">
              <slot name="mobile-actions" />
              <MarDropdown
                v-if="slots['mobile-menu']"
                :disabled="!mobileActionsExpanded"
                placement="top-end"
                popper-class="mar-ui-popup--animated-exit"
              >
                <MarButton
                  v-tooltip="translate('filePreviewDialog.moreActions')"
                  :aria-label="translate('filePreviewDialog.moreActions')"
                  class="mar-icon-action"
                  icon="more"
                  text
                />
                <template #dropdown>
                  <MarDropdownMenu :aria-label="translate('filePreviewDialog.moreActions')">
                    <slot name="mobile-menu" />
                  </MarDropdownMenu>
                </template>
              </MarDropdown>
            </div>
          </div>
        </div>
        <MarButton
          v-if="slots['mobile-menu']"
          v-tooltip="mobileToggleLabel"
          class="file-preview-mobile-toggle mar-icon-action mar-icon-action--panel-toggle"
          :aria-label="mobileToggleLabel"
          :aria-expanded="mobileActionsExpanded"
          :aria-controls="mobileActionsId"
          :icon="mobileActionsExpanded ? 'chevrons-right' : 'chevrons-left'"
          text
          @click="mobileActionsExpanded = !mobileActionsExpanded"
        />
      </div>
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

.file-preview-mobile-footer,
.file-preview-mobile-header-actions {
  display: none;
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

  .workspace-file-page-frame.is-fullscreen {
    padding: env(safe-area-inset-top, 0px) env(safe-area-inset-right, 0px)
      env(safe-area-inset-bottom, 0px) env(safe-area-inset-left, 0px);
  }

  .file-preview-mobile-header-actions {
    display: flex;
    align-self: center;
  }

  /* Keep the reading viewport separate from the dock; opening the menu never resizes it. */
  .file-preview-mobile-footer {
    display: flex;
    flex: none;
    justify-content: flex-end;
    padding: 8px 12px 12px;
  }

  .workspace-file-mobile-actions {
    --image-action-gap: 4px;
    display: flex;
    align-items: center;
    border-radius: var(--mar-radius-surface);
  }

  .file-preview-mobile-row {
    display: flex;
    flex: none;
    align-items: center;
    gap: 4px;
    padding: 4px;
  }

  .is-disclosable .file-preview-mobile-row {
    padding-inline-end: 0;
  }

  /* Size only the disclosure track. The toggle stays at the footer's right edge;
     the full-size row stays mounted and is clipped instead of squeezing the icons. */
  .is-disclosable .file-preview-mobile-reveal {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    justify-content: end;
    opacity: 1;

    @media (prefers-reduced-motion: no-preference) {
      transition:
        grid-template-columns 160ms ease-out,
        opacity 120ms ease-out;
    }
  }

  .is-collapsed .file-preview-mobile-reveal {
    grid-template-columns: minmax(0, 0fr);
    opacity: 0;
  }

  .is-disclosable .file-preview-mobile-clip {
    display: flex;
    min-inline-size: 0;
    justify-content: flex-end;
    overflow: clip;
    overflow-clip-margin: 4px; /* Leave room for the shared keyboard focus outline. */
  }

  .workspace-file-mobile-actions :deep(.mar-icon-action),
  .file-preview-mobile-header-actions :deep(.mar-icon-action) {
    --mar-ui-button-icon-size: 18px;
    inline-size: 36px;
    min-inline-size: 36px;
    block-size: 36px;
    margin-inline-start: 0;
  }

  .workspace-file-mobile-actions :deep(.file-preview-mobile-toggle) {
    flex: none;
    margin: 4px;
  }
}
</style>
