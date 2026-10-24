<script setup lang="ts">
import { marIcon } from '../../util/mar-icons.js';
import MarIcon from '../common/MarIcon.vue';
import { translate } from '../../service/locale-preference-service.js';
import type { SelectInstance } from 'element-plus';
import { computed, nextTick, ref } from 'vue';
import type { AgentRun, RunnerProfile, Session } from '../../model/workbench.js';

const props = defineProps<{
  readonly draftSessionOpen: boolean;
  readonly runner: Session['runner'];
  readonly runnerOptions: readonly { readonly value: Session['runner']; readonly label: string }[];
  readonly runnerLoading: boolean;
  readonly runnerDisabled?: boolean;
  readonly runnerLabel: string | undefined;
  readonly modelEffortSelection: string | undefined;
  readonly modelEffortLabel: string;
  readonly hideModelSelection?: boolean;
  readonly hideAccessSelection?: boolean;
  readonly selectedModel: string;
  readonly selectedEffort: string;
  readonly models: RunnerProfile['models'];
  readonly efforts: readonly string[];
  readonly access: string;
  readonly accessLabel: string;
  readonly accessOptions: RunnerProfile['accessOptions'];
  readonly configurationDisabled: boolean;
  readonly accessDisabled: boolean;
  readonly fastEnabled: boolean;
  readonly contextUsage: { readonly percentage: number } | null | undefined;
  readonly contextUsageLabel: string;
  readonly canCompactContext: boolean;
  readonly mobileViewport: boolean;
  readonly activeRun: AgentRun | undefined;
  readonly canInterrupt: boolean;
  readonly interruptVisible: boolean;
  readonly inputHasContent: boolean;
  readonly hasSelectedCommand: boolean;
  readonly loading: boolean;
  readonly submitting?: boolean;
  readonly attachmentsPending: boolean;
  readonly effortLabel: (effort: string) => string;
}>();

const emit = defineEmits<{
  files: [files: FileList];
  updateRunner: [runner: Session['runner']];
  updateModelEffort: [value: string];
  updateAccess: [value: string];
  compact: [];
  stop: [];
}>();

const fileInput = ref<HTMLInputElement>();
const contextHint = computed(() =>
  [
    props.contextUsageLabel,
    translate(
      props.canCompactContext
        ? 'generated.composerToolbar.viewContextUsageClickToCompactContext'
        : 'generated.composerToolbar.compactUnavailable'
    )
  ].join('\n')
);
const modelSelect = ref<SelectInstance>();

function openModelMenu(): boolean {
  if (props.configurationDisabled || modelSelect.value === undefined) return false;
  modelSelect.value.focus();
  modelSelect.value.toggleMenu();
  return true;
}

function onModelMenuKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Tab' || event.altKey || event.ctrlKey || event.metaKey || event.isComposing)
    return;
  const select = modelSelect.value;
  if (!select?.expanded || props.efforts.length === 0 || props.models.length === 0) return;
  const hovered = select.states.hoveringIndex;
  const effortIndex = Math.max(0, props.efforts.indexOf(props.selectedEffort));
  const modelIndex =
    props.efforts.length +
    Math.max(
      0,
      props.models.findIndex((model) => model.id === props.selectedModel)
    );
  const target =
    hovered < 0
      ? event.shiftKey
        ? effortIndex
        : modelIndex
      : hovered < props.efforts.length
        ? modelIndex
        : effortIndex;
  const option = select.optionsArray[target];
  if (option === undefined) return;
  event.preventDefault();
  select.states.hoveringIndex = target;
  void nextTick(() => select.scrollToOption(option));
}

defineExpose({ openModelMenu });

function selectFiles(event: Event): void {
  const input = event.target as HTMLInputElement;
  if (input.files !== null) emit('files', input.files);
  input.value = '';
}
</script>

<template>
  <div
    :class="[
      'composer-toolbar',
      {
        'has-runner-select': draftSessionOpen,
        'has-mobile-send': canInterrupt && inputHasContent
      }
    ]"
  >
    <input
      ref="fileInput"
      class="attachment-file-input"
      type="file"
      multiple
      @change="selectFiles"
    />
    <div :class="['composer-configuration', { 'has-runner-select': draftSessionOpen }]">
      <button
        v-tooltip="translate('generated.composerToolbar.addAttachment2')"
        class="composer-icon-button composer-attachment-button utility-control"
        type="button"
        :aria-label="translate('generated.composerToolbar.addAttachment')"
        @click="fileInput?.click()"
      >
        <MarIcon name="attachment" />
      </button>
      <div
        v-if="draftSessionOpen"
        class="composer-select-slot composer-runner-slot"
        :data-label="runnerLabel"
      >
        <el-select
          :model-value="runner"
          :aria-label="translate('common.runner')"
          class="composer-runner-select"
          popper-class="composer-mini-popper composer-runner-popper"
          size="small"
          teleported
          :disabled="runnerLoading || runnerDisabled"
          :loading="runnerLoading"
          @change="emit('updateRunner', $event as Session['runner'])"
          :clear-icon="marIcon('clear-input')"
          :suffix-icon="marIcon('chevron-down')"
        >
          <el-option
            v-for="option in runnerOptions"
            :key="option.value"
            :value="option.value"
            :label="option.label"
          />
        </el-select>
      </div>
      <div v-if="!hideModelSelection" class="composer-model-slot">
        <span
          v-tooltip="translate('generated.composerToolbar.fastModeIsEnabled')"
          v-if="runner === 'codex' && fastEnabled"
          class="composer-fast-badge"
          >{{ translate('common.fast') }}</span
        >
        <div class="composer-select-slot" :data-label="modelEffortLabel">
          <el-select
            ref="modelSelect"
            :key="modelEffortLabel"
            :model-value="modelEffortSelection"
            :disabled="configurationDisabled"
            :placeholder="modelEffortLabel"
            :aria-label="translate('generated.composerToolbar.modelAndReasoningEffort')"
            class="composer-model-effort-select"
            popper-class="composer-mini-popper composer-model-effort-popper"
            size="small"
            teleported
            @change="emit('updateModelEffort', String($event))"
            @keydown="onModelMenuKeydown"
            :clear-icon="marIcon('clear-input')"
            :suffix-icon="marIcon('chevron-down')"
          >
            <el-option-group :label="translate('common.reasoning')">
              <el-option
                v-for="effort in efforts"
                :key="effort"
                :class="{ 'composer-model-effort-option-selected': effort === selectedEffort }"
                :label="props.effortLabel(effort)"
                :value="`effort:${effort}`"
              />
            </el-option-group>
            <el-option-group :label="translate('common.model')">
              <el-option
                v-for="model in models"
                :key="model.id"
                :class="{ 'composer-model-effort-option-selected': model.id === selectedModel }"
                :label="model.label"
                :value="`model:${model.id}`"
              />
            </el-option-group>
          </el-select>
        </div>
      </div>
      <div
        v-if="!hideAccessSelection"
        class="composer-select-slot composer-access-slot"
        :data-label="accessLabel"
      >
        <el-select
          :model-value="access"
          :disabled="accessDisabled"
          :aria-label="translate('generated.composerToolbar.access')"
          class="composer-access-select"
          popper-class="composer-mini-popper composer-access-popper"
          size="small"
          teleported
          @change="emit('updateAccess', String($event))"
          :clear-icon="marIcon('clear-input')"
          :suffix-icon="marIcon('chevron-down')"
        >
          <el-option
            v-for="option in accessOptions"
            :key="option.id"
            :label="option.label"
            :value="option.id"
          />
        </el-select>
      </div>
    </div>
    <button
      v-tooltip="{ content: contextHint, placement: 'top', touch: !canCompactContext }"
      v-if="contextUsage !== undefined && contextUsage !== null"
      class="composer-context-button utility-control"
      type="button"
      :aria-label="contextUsageLabel"
      :aria-description="contextHint"
      :aria-disabled="!canCompactContext"
      :style="{
        '--context-usage': `${Math.min(100, Math.max(0, contextUsage.percentage))}%`
      }"
      @click="canCompactContext && emit('compact')"
    >
      <i aria-hidden="true" />
      <span>{{ Math.round(contextUsage.percentage * 10) / 10 }}%</span>
    </button>
    <span v-if="!mobileViewport" class="composer-hint" :class="{ 'is-submitting': submitting }">
      <span :aria-hidden="submitting || undefined">{{
        activeRun
          ? translate('generated.composerToolbar.enterToQueueCtrlEnterToStop')
          : translate('generated.composerToolbar.enterToSendShiftAltEnterFor')
      }}</span>
      <span v-if="submitting" class="composer-submitting" role="status">{{
        translate('workbench.sending')
      }}</span>
    </span>
    <button
      v-tooltip="
        activeRun?.status === 'CANCELLING'
          ? translate('generated.composerToolbar.stopping')
          : translate('generated.composerToolbar.stopRunEsc')
      "
      v-if="interruptVisible"
      class="composer-stop-button"
      :disabled="!canInterrupt"
      type="button"
      :aria-label="translate('generated.composerToolbar.stopRun')"
      @click="emit('stop')"
    >
      <MarIcon name="stop" />
    </button>
    <button
      v-tooltip="translate(submitting ? 'workbench.sending' : 'generated.composerToolbar.send2')"
      v-if="!canInterrupt || inputHasContent"
      class="composer-send-button"
      :disabled="
        (!inputHasContent && !hasSelectedCommand) ||
        loading ||
        submitting ||
        (attachmentsPending && !hasSelectedCommand)
      "
      type="submit"
      :aria-label="translate(submitting ? 'workbench.sending' : 'generated.composerToolbar.send')"
      :aria-busy="submitting || undefined"
    >
      <MarIcon name="loading-action" aria-hidden="true" v-if="submitting" />
      <MarIcon name="send" aria-hidden="true" v-else />
    </button>
  </div>
</template>

<style scoped>
.composer-submitting {
  position: absolute;
  inset: 0;
  text-align: right;
  color: var(--mar-text-secondary);
  font-size: var(--mar-font-size-meta);
  flex-shrink: 0;
}

.attachment-file-input {
  display: none;
}

.composer-toolbar {
  display: flex;
  min-width: 0;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.4rem;
  border-top: 1px solid var(--mar-border-subtle);
  padding: 0.18rem 0.62rem 0.18rem 0.25rem;
}

.composer-configuration {
  display: flex;
  min-width: 0;
  flex: 1 1 420px;
  flex-wrap: wrap;
  align-items: center;
  gap: clamp(0.35rem, 0.9vw, 0.75rem);
}

.composer-configuration > * {
  min-width: 0;
  max-width: 100%;
  flex: 0 1 auto;
}

.composer-select-slot {
  display: grid;
}

.composer-model-slot {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 0.18rem;
}

.composer-fast-badge {
  flex: 0 0 auto;
  border: 1px solid var(--mar-color-warning-accent);
  border-radius: 4px;
  background: var(--mar-color-warning-bg);
  color: var(--mar-color-warning-text);
  padding: 0.05rem 0.28rem;
  font-size: var(--mar-font-size-meta);
  font-weight: 600;
  line-height: 1.2;
}

.composer-select-slot::before {
  content: attr(data-label);
  box-sizing: border-box;
  grid-area: 1 / 1;
  min-height: var(--mar-compact-control-size);
  width: max-content;
  max-width: 100%;
  visibility: hidden;
  overflow: hidden;
  padding: 1px 1.55rem 1px 0.35rem;
  font-size: var(--mar-font-size-meta);
  line-height: calc(var(--mar-compact-control-size) - 2px);
  white-space: nowrap;
}

.composer-runner-select,
.composer-model-effort-select,
.composer-access-select {
  grid-area: 1 / 1;
  width: 100%;
  max-width: 100%;
}

.composer-mini-popper {
  z-index: 2500 !important;
  border: 1px solid var(--mar-border-default) !important;
  border-radius: 8px !important;
  box-shadow: 0 8px 20px var(--mar-shadow-medium) !important;
}

.composer-config,
.composer-hint {
  color: var(--mar-text-tertiary);
  font-size: var(--mar-font-size-meta);
}

.composer-hint {
  position: relative;
  margin-left: auto;
}

.composer-hint.is-submitting > :first-child {
  visibility: hidden;
}

.composer-context-button {
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 0.26rem;
  min-height: var(--mar-compact-control-size);
  border: 0;
  border-radius: var(--mar-radius-control);
  padding: 0.1rem 0.3rem;
  font-size: var(--mar-font-size-meta);
  line-height: 1;
  cursor: pointer;
}

.composer-context-button[aria-disabled='true'] {
  cursor: not-allowed;
  opacity: 0.65;
}

.composer-context-button i {
  display: block;
  width: 0.9rem;
  height: 0.9rem;
  border-radius: 50%;
  background: conic-gradient(
    var(--mar-color-brand) var(--context-usage),
    var(--mar-border-medium) 0
  );
  position: relative;
}

.composer-context-button i::after {
  position: absolute;
  inset: 0.18rem;
  border-radius: inherit;
  background: var(--mar-bg-panel);
  content: '';
}

.composer-icon-button {
  width: var(--mar-compact-control-size);
  min-width: var(--mar-compact-control-size);
  height: var(--mar-compact-control-size);
  border: 1px solid var(--mar-border-default);
  border-radius: 6px;
  background: var(--mar-bg-panel);
  color: var(--mar-text-tertiary);
  padding: 0;
}

.composer-attachment-button {
  display: inline-grid;
  flex: 0 0 auto;
  align-self: center;
  place-items: center;
  border: 0;
  background: transparent;
  color: var(--mar-text-secondary);
  cursor: pointer;
}

.composer-send-button,
.composer-stop-button {
  display: inline-grid;
  width: 24px;
  min-width: 24px;
  height: 24px;
  place-items: center;
  border: 1px solid var(--mar-color-brand);
  border-radius: 50%;
  background: var(--mar-color-brand);
  color: var(--mar-color-on-accent);
  padding: 0;
  cursor: pointer;
}

@media (min-width: 768px) {
  .composer-toolbar {
    padding-right: 0.75rem;
  }
}

.composer-stop-button {
  border-color: var(--mar-color-danger-text);
  background: var(--mar-bg-panel);
  color: var(--mar-color-danger-text);
}

.composer-send-button:not(:disabled):hover {
  border-color: var(--mar-color-brand-hover);
  background: var(--mar-color-brand-hover);
}

.composer-stop-button:not(:disabled):hover {
  background: var(--mar-color-danger-bg);
}

.composer-send-button:not(:disabled):focus-visible,
.composer-stop-button:not(:disabled):focus-visible {
  outline: 2px solid var(--mar-color-brand);
  outline-offset: 2px;
}

.composer-stop-button:not(:disabled):focus-visible {
  outline-color: var(--mar-color-danger-text);
}

.composer-send-button:disabled:not([aria-busy='true']),
.composer-stop-button:disabled {
  cursor: not-allowed;
  border-color: var(--mar-border-default);
  background: var(--mar-fill-soft);
  color: var(--mar-text-faint);
}

.composer-send-button[aria-busy='true'] {
  cursor: progress;
}

.composer-send-button[aria-busy='true'] :deep(.mar-icon[data-mar-icon='loading-action']) {
  animation-duration: 1s;
}

@media (max-width: 767px) {
  .composer-context-button {
    min-height: 36px;
  }
}

@media (max-width: 767px) {
  .composer-send-button,
  .composer-stop-button {
    width: 36px;
    min-width: 36px;
    height: 36px;
    min-height: 36px;
  }
}

@media (max-width: 767px) {
  .composer-toolbar {
    display: grid;
    grid-template-columns: auto minmax(0, 1.25fr) minmax(0, 0.9fr) auto 36px;
    align-items: center;
    gap: 0.28rem;
  }
}

@media (max-width: 767px) {
  .composer-toolbar.has-runner-select {
    grid-template-columns: auto minmax(0, 0.55fr) minmax(0, 1.15fr) minmax(0, 0.8fr) auto 36px;
  }
}

@media (max-width: 767px) {
  .composer-toolbar.has-mobile-send {
    grid-template-columns: auto minmax(0, 1.25fr) minmax(0, 0.9fr) auto 36px 36px;
  }
}

@media (max-width: 767px) {
  .composer-toolbar.has-runner-select.has-mobile-send {
    grid-template-columns: auto minmax(0, 0.55fr) minmax(0, 1.15fr) minmax(0, 0.8fr) auto 36px 36px;
  }
}

@media (max-width: 767px) {
  .composer-configuration {
    display: contents;
  }
}

@media (max-width: 767px) {
  .composer-configuration > .composer-attachment-button {
    grid-column: 1;
    grid-row: 1;
    justify-self: start;
    width: 28px;
    min-width: 28px;
    height: 28px;
  }

  .composer-attachment-button :deep(.mar-icon) {
    font-size: 20px;
  }
}

@media (max-width: 767px) {
  .composer-configuration > .composer-model-slot {
    grid-column: 2;
    grid-row: 1;
  }
}

@media (max-width: 767px) {
  .composer-configuration > .composer-access-slot {
    grid-column: 3;
    grid-row: 1;
  }
}

@media (max-width: 767px) {
  .composer-context-button {
    grid-column: 4;
    grid-row: 1;
  }
}

@media (max-width: 767px) {
  .composer-send-button,
  .composer-stop-button {
    grid-column: 5;
    grid-row: 1;
  }
}

@media (max-width: 767px) {
  .composer-toolbar.has-mobile-send .composer-stop-button {
    grid-column: 5;
  }
}

@media (max-width: 767px) {
  .composer-toolbar.has-mobile-send .composer-send-button {
    grid-column: 6;
  }
}

@media (max-width: 767px) {
  .composer-toolbar.has-runner-select .composer-configuration > .composer-runner-slot {
    grid-column: 2;
    grid-row: 1;
  }
}

@media (max-width: 767px) {
  .composer-toolbar.has-runner-select .composer-configuration > .composer-model-slot {
    grid-column: 3;
    grid-row: 1;
  }
}

@media (max-width: 767px) {
  .composer-toolbar.has-runner-select .composer-configuration > .composer-access-slot {
    grid-column: 4;
    grid-row: 1;
  }
}

@media (max-width: 767px) {
  .composer-toolbar.has-runner-select .composer-context-button {
    grid-column: 5;
  }
}

@media (max-width: 767px) {
  .composer-toolbar.has-runner-select .composer-send-button,
  .composer-toolbar.has-runner-select .composer-stop-button {
    grid-column: 6;
  }
}

@media (max-width: 767px) {
  .composer-toolbar.has-runner-select.has-mobile-send .composer-stop-button {
    grid-column: 6;
  }
}

@media (max-width: 767px) {
  .composer-toolbar.has-runner-select.has-mobile-send .composer-send-button {
    grid-column: 7;
  }
}

@media (max-width: 767px) {
  .composer-select-slot::before {
    display: none;
  }
}

@media (max-width: 767px) {
  .composer-runner-select,
  .composer-model-effort-select,
  .composer-access-select {
    min-width: 0;
  }
}

@media (max-width: 460px) {
  .composer-configuration {
    flex-basis: 100%;
  }
}

@media (max-width: 460px) {
  .composer-configuration > :not(.composer-attachment-button) {
    min-width: 0;
    flex-grow: 0;
  }
}

@media (max-width: 460px) {
  .composer-runner-select,
  .composer-model-effort-select,
  .composer-access-select {
    width: 100%;
  }
}
</style>

<style scoped>
:global(.composer-runner-select .el-select__wrapper),
:global(.composer-access-select .el-select__wrapper),
:global(.composer-model-effort-select .el-select__wrapper) {
  min-height: var(--mar-compact-control-size);
  border-radius: 6px;
  background: transparent;
  box-shadow: none;
  padding: 1px 0.35rem;
}

:global(.composer-runner-select .el-select__wrapper:hover),
:global(.composer-runner-select .el-select__wrapper.is-focused),
:global(.composer-access-select .el-select__wrapper:hover),
:global(.composer-access-select .el-select__wrapper.is-focused),
:global(.composer-model-effort-select .el-select__wrapper:hover),
:global(.composer-model-effort-select .el-select__wrapper.is-focused) {
  background: var(--mar-fill-soft);
  box-shadow: 0 0 0 1px var(--mar-color-brand-border) inset;
}

:global(.composer-runner-select .el-select__selected-item),
:global(.composer-access-select .el-select__selected-item),
:global(.composer-model-effort-select .el-select__selected-item),
:global(.composer-runner-select .el-select__placeholder),
:global(.composer-access-select .el-select__placeholder),
:global(.composer-model-effort-select .el-select__placeholder) {
  color: var(--mar-text-primary);
  font-size: var(--mar-font-size-meta);
  opacity: 1;
}

:global(.composer-runner-select .el-select__placeholder),
:global(.composer-access-select .el-select__placeholder),
:global(.composer-model-effort-select .el-select__placeholder) {
  position: static;
  z-index: auto;
  width: auto;
  transform: none;
}

:global(.composer-runner-select .el-select__caret),
:global(.composer-access-select .el-select__caret),
:global(.composer-model-effort-select .el-select__caret) {
  color: var(--mar-text-faint);
}

:global(.composer-mini-popper .el-select-dropdown__item),
:global(.composer-model-effort-popper .el-select-dropdown__item) {
  height: var(--mar-compact-control-size);
  color: var(--mar-text-primary);
  font-size: var(--mar-font-size-body);
  line-height: var(--mar-compact-control-size);
}

:global(.composer-model-effort-popper .el-select-dropdown__item.is-selected),
:global(
  .composer-model-effort-popper .el-select-dropdown__item.composer-model-effort-option-selected
) {
  background: var(--mar-fill-selection);
  color: var(--mar-text-primary);
  font-weight: 400;
}

:global(.composer-model-effort-popper .el-select-dropdown__wrap),
:global(.composer-model-effort-popper .el-scrollbar__wrap) {
  max-height: none;
}

:global(.composer-model-effort-popper .el-select-group__title) {
  display: block;
  height: var(--mar-compact-control-size);
  color: var(--mar-text-tertiary);
  font-size: var(--mar-font-size-meta);
  line-height: var(--mar-compact-control-size);
}

:global(.composer-model-effort-popper .el-select-group__wrap + .el-select-group__wrap) {
  margin-top: 0.25rem;
  border-top: 1px solid var(--mar-border-default);
  padding-top: 0.25rem;
}

:global(.composer-send-button .mar-icon),
:global(.composer-stop-button .mar-icon) {
  font-size: 0.92rem;
}

@media (max-width: 767px) {
  :global(.composer-send-button .mar-icon),
  :global(.composer-stop-button .mar-icon) {
    font-size: 20px;
  }
}
</style>
