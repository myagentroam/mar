<script setup lang="ts">
import { translate } from '../../service/LocalePreferenceService.js';
import { Paperclip, Promotion } from '@element-plus/icons-vue';
import type { SelectInstance } from 'element-plus';
import { nextTick, ref } from 'vue';
import type { AgentRun, RunnerProfile, Session } from '../../model/workbench.js';

const props = defineProps<{
  readonly draftSessionOpen: boolean;
  readonly runner: Session['runner'];
  readonly runnerOptions: readonly { readonly value: Session['runner']; readonly label: string }[];
  readonly runnerLoading: boolean;
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
        class="composer-icon-button composer-attachment-button utility-control"
        type="button"
        :aria-label="translate('generated.composerToolbar.addAttachment')"
        :title="translate('generated.composerToolbar.addAttachment2')"
        @click="fileInput?.click()"
      >
        <el-icon><Paperclip /></el-icon>
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
          :disabled="runnerLoading"
          :loading="runnerLoading"
          @change="emit('updateRunner', $event as Session['runner'])"
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
          v-if="runner === 'codex' && fastEnabled"
          class="composer-fast-badge"
          :title="translate('generated.composerToolbar.fastModeIsEnabled')"
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
    <el-tooltip
      v-if="contextUsage !== undefined && contextUsage !== null"
      :content="contextUsageLabel"
      placement="top"
    >
      <button
        class="composer-context-button"
        type="button"
        :aria-label="contextUsageLabel"
        :aria-disabled="!canCompactContext"
        :style="{
          '--context-usage': `${Math.min(100, Math.max(0, contextUsage.percentage))}%`
        }"
        :title="translate('generated.composerToolbar.viewContextUsageClickToCompactContext')"
        @click="emit('compact')"
      >
        <i aria-hidden="true" />
        <span>{{ Math.round(contextUsage.percentage * 10) / 10 }}%</span>
      </button>
    </el-tooltip>
    <span v-if="!mobileViewport" class="composer-hint">{{
      activeRun
        ? translate('generated.composerToolbar.enterToQueueCtrlEnterToStop')
        : translate('generated.composerToolbar.enterToSendShiftAltEnterFor')
    }}</span>
    <button
      v-if="interruptVisible"
      class="composer-stop-button"
      :disabled="loading || !canInterrupt"
      type="button"
      :aria-label="translate('generated.composerToolbar.stopRun')"
      :title="
        activeRun?.status === 'CANCELLING'
          ? translate('generated.composerToolbar.stopping')
          : translate('generated.composerToolbar.stopRunEsc')
      "
      @click="emit('stop')"
    >
      <i class="composer-stop-square" aria-hidden="true" />
    </button>
    <button
      v-if="!canInterrupt || inputHasContent"
      class="composer-send-button"
      :disabled="
        (!inputHasContent && !hasSelectedCommand) ||
        loading ||
        (attachmentsPending && !hasSelectedCommand)
      "
      type="submit"
      :aria-label="translate('generated.composerToolbar.send')"
      :title="translate('generated.composerToolbar.send2')"
    >
      <el-icon><Promotion /></el-icon>
    </button>
  </div>
</template>

<style scoped>
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
  margin-left: auto;
}

.composer-context-button {
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 0.26rem;
  min-height: var(--mar-compact-control-size);
  border: 0;
  border-radius: 5px;
  background: transparent;
  color: var(--mar-text-tertiary);
  padding: 0.1rem 0.3rem;
  font-size: var(--mar-font-size-meta);
  line-height: 1;
  cursor: pointer;
}

.composer-context-button:hover,
.composer-context-button:focus-visible {
  background: var(--mar-color-brand-subtle);
  color: var(--mar-color-brand-text);
  outline: none;
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
  width: var(--mar-compact-control-size);
  min-width: var(--mar-compact-control-size);
  height: var(--mar-compact-control-size);
  place-items: center;
  border: 1px solid var(--mar-color-brand);
  border-radius: 50%;
  background: var(--mar-color-brand);
  color: var(--mar-color-on-accent);
  padding: 0;
  cursor: pointer;
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

.composer-send-button:disabled,
.composer-stop-button:disabled {
  cursor: not-allowed;
  border-color: var(--mar-border-default);
  background: var(--mar-fill-soft);
  color: var(--mar-text-faint);
}

.composer-stop-square {
  display: block;
  width: 0.58rem;
  height: 0.58rem;
  border-radius: 1px;
  background: currentcolor;
}

@media (max-width: 767px) {
  .composer-context-button {
    min-height: 36px;
  }
}

@media (max-width: 767px) {
  .composer-send-button,
  .composer-stop-button {
    position: relative;
    width: 36px;
    min-width: 36px;
    height: 36px;
    min-height: 36px;
    border-color: transparent;
    background: transparent;
  }

  .composer-send-button::before,
  .composer-stop-button::before {
    position: absolute;
    inset: 4px;
    border: 1px solid var(--mar-color-brand);
    border-radius: 50%;
    background: var(--mar-color-brand);
    content: '';
  }

  .composer-stop-button {
    color: var(--mar-color-danger-text);
  }

  .composer-stop-button::before {
    border-color: var(--mar-color-danger-text);
    background: var(--mar-bg-panel);
  }

  .composer-send-button:not(:disabled):hover::before {
    border-color: var(--mar-color-brand-hover);
    background: var(--mar-color-brand-hover);
  }

  .composer-stop-button:not(:disabled):hover::before {
    background: var(--mar-color-danger-bg);
  }

  .composer-send-button:disabled,
  .composer-stop-button:disabled {
    border-color: transparent;
    background: transparent;
  }

  .composer-send-button:disabled::before,
  .composer-stop-button:disabled::before {
    border-color: var(--mar-border-default);
    background: var(--mar-fill-soft);
  }

  .composer-send-button :deep(.el-icon),
  .composer-stop-button .composer-stop-square {
    position: relative;
    z-index: 1;
  }
}

@media (max-width: 767px) {
  .composer-toolbar {
    display: grid;
    grid-template-columns: 36px minmax(0, 1.25fr) minmax(0, 0.9fr) auto 36px;
    align-items: center;
    gap: 0.28rem;
  }
}

@media (max-width: 767px) {
  .composer-toolbar.has-runner-select {
    grid-template-columns: 36px minmax(0, 0.55fr) minmax(0, 1.15fr) minmax(0, 0.8fr) auto 36px;
  }
}

@media (max-width: 767px) {
  .composer-toolbar.has-mobile-send {
    grid-template-columns: 36px minmax(0, 1.25fr) minmax(0, 0.9fr) auto 36px 36px;
  }
}

@media (max-width: 767px) {
  .composer-toolbar.has-runner-select.has-mobile-send {
    grid-template-columns: 36px minmax(0, 0.55fr) minmax(0, 1.15fr) minmax(0, 0.8fr) auto 36px 36px;
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

:global(.composer-mini-popper .el-select-dropdown__item.composer-model-effort-option-selected) {
  background: var(--mar-color-brand-selected);
  color: var(--mar-color-brand-text);
  font-weight: 600;
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

:global(.composer-send-button .el-icon),
:global(.composer-stop-button .el-icon) {
  font-size: 0.92rem;
}
</style>
