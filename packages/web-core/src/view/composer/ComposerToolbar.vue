<script setup lang="ts">
import { MarScrollbar } from '@myagentroam/mar-ui/scrollbar';
import { MarOption, MarOptionGroup, MarSelect } from '@myagentroam/mar-ui/select';
import { MarIcon } from '@myagentroam/mar-ui/icons';
import ComposerSendButton from './ComposerSendButton.vue';
import './composer-toolbar.css';
import { translate } from '../../service/locale-preference-service.js';
import {
  composerModelKeys,
  composerSendKeys,
  shortcutKeyLabel,
  shortcutTooltip
} from '../../service/console-shortcut-keys.js';
import { computed, ref, useTemplateRef } from 'vue';
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
  readonly modelShortcut?: boolean;
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
  readonly hideContextUsage?: boolean;
  readonly contextUsageLabel: string;
  readonly canCompactContext: boolean;
  readonly mobileViewport: boolean;
  readonly contextKey?: string | undefined;
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
  send: [];
  steer: [];
}>();

const fileInput = ref<HTMLInputElement>();
const hasModelAndEffort = computed(() => props.models.length > 0 && props.efforts.length > 0);
const modelMenuValues = computed(() => [
  ...props.models.map((model) => `model:${model.id}`),
  ...props.efforts.map((effort) => `effort:${effort}`)
]);
const canSteer = computed(
  () =>
    props.interruptVisible &&
    props.activeRun?.status !== 'CANCELLING' &&
    props.canInterrupt &&
    !props.hasSelectedCommand
);
const sendDisabled = computed(
  () =>
    (!props.inputHasContent && !props.hasSelectedCommand) ||
    props.loading ||
    props.submitting ||
    (props.attachmentsPending && !props.hasSelectedCommand)
);
const sendTooltip = computed(() => {
  if (props.submitting) return translate('workbench.sending');
  const label = translate(
    props.interruptVisible && !props.hasSelectedCommand
      ? 'keyboardShortcuts.queueMessage'
      : 'generated.composerToolbar.send2'
  );
  if (props.mobileViewport || sendDisabled.value) return label;
  return shortcutTooltip(label, [composerSendKeys[0]]);
});
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
const contextPercentage = computed(() => props.contextUsage?.percentage ?? 0);
const modelSelect = useTemplateRef('modelSelect');

function openModelMenu(): boolean {
  if (props.configurationDisabled || !modelSelect.value) return false;
  modelSelect.value.focus();
  modelSelect.value.toggleMenu();
  return true;
}

function onModelMenuKeydown(event: KeyboardEvent): void {
  if (event.altKey || event.ctrlKey || event.metaKey || event.isComposing) return;
  const select = modelSelect.value;
  if (!select?.expanded) return;
  // Use stable option values; a profile refresh can reorder the rendered options.
  const hovered = modelMenuValues.value.findIndex((value) => value === select.activeValue);
  const modelIndex = Math.max(
    0,
    props.models.findIndex((model) => model.id === props.selectedModel)
  );
  const effortIndex =
    props.models.length + Math.max(0, props.efforts.indexOf(props.selectedEffort));
  const inModels = props.models.length > 0 && (hovered < 0 || hovered < props.models.length);
  const start = inModels ? 0 : props.models.length;
  const count = inModels ? props.models.length : props.efforts.length;
  if (count === 0) return;
  const current = hovered < 0 ? (inModels ? modelIndex : effortIndex) : hovered;
  let target: number;
  switch (event.key) {
    case 'Tab':
    case 'ArrowLeft':
    case 'ArrowRight':
      if (!hasModelAndEffort.value) return;
      target =
        event.key === 'ArrowLeft'
          ? modelIndex
          : event.key === 'ArrowRight'
            ? effortIndex
            : inModels
              ? effortIndex
              : modelIndex;
      break;
    case 'ArrowUp':
    case 'ArrowDown':
      target = start + ((current - start + (event.key === 'ArrowDown' ? 1 : -1) + count) % count);
      break;
    case 'Home':
      target = start;
      break;
    case 'End':
      target = start + count - 1;
      break;
    case 'PageUp':
      target = Math.max(start, current - 10);
      break;
    case 'PageDown':
      target = Math.min(start + count - 1, current + 10);
      break;
    default:
      return;
  }
  const value = modelMenuValues.value[target];
  if (value === undefined) return;
  event.preventDefault();
  event.stopPropagation();
  select.setActiveValue(value);
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
      'composer-toolbar mar-composer-toolbar',
      {
        'has-runner-select': draftSessionOpen,
        'has-mobile-send': canInterrupt && inputHasContent,
        'is-mobile': mobileViewport
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
        class="composer-attachment-button mar-composer-attachment mar-icon-action"
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
        <MarSelect
          :model-value="runner"
          :tooltip="translate('common.runner')"
          :aria-label="translate('common.runner')"
          class="composer-runner-select"
          popper-class="composer-mini-popper composer-runner-popper"
          :disabled="runnerLoading || runnerDisabled"
          :loading="runnerLoading"
          @change="emit('updateRunner', $event)"
        >
          <MarOption
            v-for="option in runnerOptions"
            :key="option.value"
            :value="option.value"
            :label="option.label"
          />
        </MarSelect>
      </div>
      <div v-if="!hideModelSelection" class="composer-model-slot">
        <span
          v-tooltip="translate('generated.composerToolbar.fastModeIsEnabled')"
          v-if="runner === 'codex' && fastEnabled"
          class="composer-fast-badge"
          >{{ translate('common.fast') }}</span
        >
        <div class="composer-select-slot" :data-label="modelEffortLabel">
          <MarSelect
            ref="modelSelect"
            :model-value="modelEffortSelection"
            :disabled="configurationDisabled"
            :placeholder="modelEffortLabel"
            :aria-label="translate('generated.composerToolbar.modelAndReasoningEffort')"
            :tooltip="
              modelShortcut && !configurationDisabled
                ? shortcutTooltip(
                    modelEffortLabel ||
                      translate('generated.composerToolbar.modelAndReasoningEffort'),
                    composerModelKeys
                  )
                : undefined
            "
            class="composer-model-effort-select mar-composer-dropdown-trigger"
            :popper-class="
              hasModelAndEffort
                ? 'composer-mini-popper composer-model-effort-popper'
                : 'composer-mini-popper composer-model-effort-popper composer-model-menu-single-column'
            "
            @change="emit('updateModelEffort', String($event))"
            @keydown.capture="onModelMenuKeydown"
          >
            <div class="composer-model-menu-columns">
              <MarOptionGroup v-if="models.length" :label="translate('common.model')">
                <MarScrollbar always max-height="var(--composer-model-list-height)">
                  <MarOption
                    v-for="model in models"
                    :key="model.id"
                    :class="{ 'composer-model-effort-option-selected': model.id === selectedModel }"
                    :label="model.label"
                    :value="`model:${model.id}`"
                  />
                </MarScrollbar>
              </MarOptionGroup>
              <MarOptionGroup v-if="efforts.length" :label="translate('common.reasoning')">
                <MarScrollbar always max-height="var(--composer-model-list-height)">
                  <MarOption
                    v-for="effort in efforts"
                    :key="effort"
                    :class="{ 'composer-model-effort-option-selected': effort === selectedEffort }"
                    :label="props.effortLabel(effort)"
                    :value="`effort:${effort}`"
                  />
                </MarScrollbar>
              </MarOptionGroup>
            </div>
          </MarSelect>
        </div>
      </div>
      <div
        v-if="!hideAccessSelection"
        class="composer-select-slot composer-access-slot"
        :data-label="accessLabel"
      >
        <MarSelect
          :model-value="access"
          :disabled="accessDisabled"
          :aria-label="translate('generated.composerToolbar.access')"
          class="composer-access-select mar-composer-dropdown-trigger"
          popper-class="composer-mini-popper composer-access-popper"
          @change="emit('updateAccess', String($event))"
        >
          <MarOption
            v-for="option in accessOptions"
            :key="option.id"
            :label="option.label"
            :value="option.id"
          />
        </MarSelect>
      </div>
    </div>
    <button
      v-tooltip="{ content: contextHint, placement: 'top', touch: !canCompactContext }"
      v-if="!hideContextUsage"
      class="composer-context-button mar-text-action"
      type="button"
      :aria-label="contextUsageLabel"
      :aria-description="contextHint"
      :aria-disabled="!canCompactContext"
      :style="{
        '--context-usage': `${Math.min(100, Math.max(0, contextPercentage))}%`
      }"
      @click="canCompactContext && emit('compact')"
    >
      <i aria-hidden="true" />
      <span>{{ Math.round(contextPercentage * 10) / 10 }}%</span>
    </button>
    <span
      v-if="!mobileViewport || submitting"
      class="composer-hint"
      :class="{ 'is-submitting mar-composer-mobile-status': submitting }"
    >
      <span
        v-if="!mobileViewport"
        class="composer-keyboard-hint"
        :aria-hidden="submitting || undefined"
        >{{
          activeRun
            ? translate('generated.composerToolbar.enterToQueueCtrlEnterToStop', {
                send: shortcutKeyLabel(composerSendKeys[0]),
                steer: shortcutKeyLabel(composerSendKeys[1])
              })
            : translate('generated.composerToolbar.enterToSendShiftAltEnterFor', {
                send: shortcutKeyLabel(composerSendKeys[0])
              })
        }}</span
      >
      <span v-if="submitting" class="composer-submitting mar-composer-submitting" role="status">{{
        translate('workbench.sending')
      }}</span>
    </span>
    <button
      v-tooltip="
        activeRun?.status === 'CANCELLING'
          ? translate('generated.composerToolbar.stopping')
          : translate('generated.composerToolbar.stopRun')
      "
      v-if="interruptVisible"
      class="composer-stop-button mar-composer-action mar-composer-stop-action"
      :disabled="!canInterrupt"
      type="button"
      :aria-label="translate('generated.composerToolbar.stopRun')"
      @click="emit('stop')"
    >
      <MarIcon name="stop" />
    </button>
    <ComposerSendButton
      v-tooltip="sendTooltip"
      v-if="!canInterrupt || inputHasContent"
      class="composer-send-button mar-composer-action"
      :disabled="sendDisabled"
      :mobile-viewport="mobileViewport"
      :can-steer="canSteer"
      :context-key="`${contextKey ?? ''}:${activeRun?.id ?? ''}`"
      :submitting="submitting"
      :label="translate(submitting ? 'workbench.sending' : 'generated.composerToolbar.send')"
      @send="emit('send')"
      @steer="emit('steer')"
    />
  </div>
</template>

<style scoped>
.attachment-file-input {
  display: none;
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

.composer-model-slot > .composer-select-slot {
  min-width: 0;
}

:is(.composer-model-slot > .composer-select-slot, .composer-access-slot)::before {
  padding-inline-start: var(--composer-dropdown-trigger-padding);
  padding-inline-end: calc(
    var(--composer-dropdown-trigger-padding) + var(--composer-dropdown-trigger-gap) +
      var(--composer-dropdown-trigger-icon-size)
  );
}

.composer-runner-select,
.composer-model-effort-select,
.composer-access-select {
  grid-area: 1 / 1;
  width: 100%;
  max-width: 100%;
}

.composer-config,
.composer-hint {
  color: var(--mar-text-secondary);
  font-size: var(--mar-font-size-meta);
}

.composer-hint {
  flex-shrink: 0;
  margin-left: auto;
  white-space: nowrap;
}

.composer-hint.is-submitting .composer-keyboard-hint {
  display: none;
}

@container (max-width: 680px) {
  .composer-hint:not(.is-submitting) {
    display: none;
  }

  /* The busy send button already shows progress; keep the live status without reflow. */
  .composer-hint.is-submitting {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
  }
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
    var(--mar-conversation-activity-fg) var(--context-usage),
    color-mix(in srgb, var(--mar-text-secondary) 30%, transparent) 0
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

@media (max-width: 767px) {
  .composer-context-button {
    min-height: var(--composer-toolbar-row-height);
  }

  .composer-toolbar {
    grid-template-columns: auto minmax(0, 1.25fr) minmax(0, 0.9fr) auto var(--composer-action-size);
  }
}

@media (max-width: 767px) {
  .composer-toolbar.has-runner-select {
    grid-template-columns: auto minmax(0, 0.55fr) minmax(0, 1.15fr) minmax(0, 0.8fr) auto var(
        --composer-action-size
      );
  }
}

@media (max-width: 767px) {
  .composer-toolbar.has-mobile-send {
    grid-template-columns: auto minmax(0, 1.25fr) minmax(0, 0.9fr) auto repeat(
        2,
        var(--composer-action-size)
      );
  }
}

@media (max-width: 767px) {
  .composer-toolbar.has-runner-select.has-mobile-send {
    grid-template-columns: auto minmax(0, 0.55fr) minmax(0, 1.15fr) minmax(0, 0.8fr) auto repeat(
        2,
        var(--composer-action-size)
      );
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
    justify-self: start;
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
.composer-runner-select :deep(.mar-ui-select__field) {
  --mar-ui-select-padding: 0.35rem;
  --mar-ui-select-height: var(--mar-compact-control-size);
  background: transparent;
  box-shadow: none;
}

.composer-runner-select :deep(.mar-ui-select__field:not([data-disabled]):hover) {
  background: var(--mar-fill-soft);
  box-shadow: 0 0 0 1px var(--mar-border-medium) inset;
}

.composer-runner-select
  :deep(.mar-ui-select__field:not([data-disabled]):is(:focus-within, [data-expanded])) {
  background: var(--mar-fill-soft);
  box-shadow: 0 0 0 1px var(--mar-input-border-focus) inset;
}

.composer-runner-select :deep(.mar-ui-select__field:not([data-disabled]) .mar-ui-select__label) {
  color: var(--mar-text-primary);
}

:global(
  .composer-model-effort-popper
    .mar-ui-option.composer-model-effort-option-selected:not([aria-disabled='true'])
) {
  background: var(--mar-fill-selection);
}

:global(.composer-mini-popper:not(.composer-model-effort-popper)) {
  --mar-ui-popup-height-cap: 274px;
}

:global(.composer-model-effort-popper) {
  --composer-model-list-height: max(0px, calc(var(--mar-ui-popup-max-height, 100dvh) - 2rem - 2px));
  --mar-ui-popup-content-overflow: clip;
  --mar-ui-popup-padding: 0;
  --mar-ui-popup-width-cap: 500px;
}

.composer-model-menu-columns {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 6.75rem;
}

.composer-model-menu-columns :deep(.mar-ui-option-group) {
  min-width: 0;
  min-height: 0;
}

.composer-model-menu-columns :deep(.mar-ui-option-group__label) {
  box-sizing: border-box;
  display: block;
  height: 2rem;
  padding: 0.25rem 0.75rem;
  color: var(--mar-text-secondary);
  font-size: var(--mar-font-size-meta);
  line-height: var(--mar-compact-control-size);
}

.composer-model-menu-columns :deep(.mar-ui-option-group + .mar-ui-option-group) {
  border-left: 1px solid var(--mar-border-default);
}

:global(.composer-model-menu-single-column .composer-model-menu-columns) {
  grid-template-columns: minmax(0, 1fr);
}
</style>
