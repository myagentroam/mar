<script setup lang="ts">
import '@myagentroam/mar-ui/surface-chrome.css';
import './composer-candidate-picker.css';
import { computed, nextTick, ref, useId, watch } from 'vue';
import { translate } from '../../service/locale-preference-service.js';
import type { QuickPrompt, RunnerCommand } from '../../model/workbench.js';
import type { EffectiveWorkspaceSkill } from '../../service/effective-workspace-skill-service.js';

const props = defineProps<{
  readonly open: boolean;
  readonly commands: readonly RunnerCommand[];
  readonly skills: readonly EffectiveWorkspaceSkill[];
  readonly quickPrompts: readonly QuickPrompt[];
  readonly quickPromptsLoading: boolean;
  readonly quickPromptsFailed: boolean;
  readonly pickerKind: 'runner' | 'quick-prompt' | undefined;
  readonly skillsEnabled: boolean;
  readonly skillsLoading: boolean;
  readonly skillsFailed: boolean;
  readonly activeIndex: number;
  readonly loading: boolean;
  readonly failed: boolean;
}>();
const emit = defineEmits<{
  activate: [index: number];
  select: [command: RunnerCommand];
  selectSkill: [skill: EffectiveWorkspaceSkill];
  selectQuickPrompt: [prompt: QuickPrompt];
}>();
const picker = ref<HTMLElement>();
const quickPromptHeadingId = useId();
const pickerLabel = computed(() => {
  if (props.pickerKind === 'quick-prompt') {
    return props.quickPrompts.length > 0 ? undefined : translate('quickPrompts.picker');
  }
  return translate(
    props.skillsEnabled
      ? 'generated.composerCommandPicker.commandsAndSkills'
      : 'generated.composerCommandPicker.runnerCommands'
  );
});

function candidateTooltip(index: number, description: string): string | undefined {
  const label = picker.value?.querySelector<HTMLElement>(
    `[data-picker-index="${index}"] .candidate-name`
  );
  const clippedName = label && label.scrollWidth > label.clientWidth ? label.textContent : '';
  return [clippedName, description].filter(Boolean).join('\n') || undefined;
}

watch(
  () => [props.open, props.activeIndex, props.commands.length, props.skills.length] as const,
  async ([open]) => {
    if (!open) return;
    await nextTick();
    const container = picker.value;
    const option = container?.querySelector<HTMLElement>(
      `[data-picker-index="${props.activeIndex}"]`
    );
    if (container === undefined || option === null || option === undefined) return;
    const optionTop = option.offsetTop;
    const optionBottom = optionTop + option.offsetHeight;
    if (optionTop < container.scrollTop) container.scrollTop = optionTop;
    else if (optionBottom > container.scrollTop + container.clientHeight)
      container.scrollTop = optionBottom - container.clientHeight;
  },
  { flush: 'post' }
);

function statusText(): string {
  if (props.pickerKind === 'quick-prompt') {
    if (props.quickPromptsLoading) return translate('common.loading');
    if (props.quickPromptsFailed) return translate('quickPrompts.loadFailed');
    return translate('quickPrompts.noMatches');
  }
  if (props.loading) return translate('generated.composerCommandPicker.loadingRunnerCommands');
  if (props.failed)
    return translate('generated.composerCommandPicker.runnerCommandsFailedToLoadTypeAgain');
  if (props.skillsEnabled && props.skillsLoading)
    return translate('generated.composerCommandPicker.loadingSkills');
  if (props.skillsEnabled && props.skillsFailed)
    return translate('generated.composerCommandPicker.skillsFailedToLoadTypeAgain');
  return props.skillsEnabled
    ? translate('generated.composerCommandPicker.noAvailableCommandsOrSkills')
    : translate('generated.composerCommandPicker.thisRunnerHasNoAvailableSlashCommands');
}
</script>

<template>
  <div
    v-if="open"
    ref="picker"
    class="command-picker mar-composer-candidate-picker mar-compact-overlay"
    role="listbox"
    :aria-label="pickerLabel"
    :aria-labelledby="
      pickerKind === 'quick-prompt' && quickPrompts.length > 0 ? quickPromptHeadingId : undefined
    "
  >
    <template v-if="commands.length > 0">
      <p class="mar-composer-candidate-heading" role="presentation">
        {{ translate('generated.composerCommandPicker.runnerCommands') }}
      </p>
      <button
        v-tooltip="() => candidateTooltip(index, command.description)"
        v-for="(command, index) in commands"
        :key="command.id"
        type="button"
        role="option"
        :aria-selected="index === activeIndex"
        :data-picker-index="index"
        @mouseenter="emit('activate', index)"
        @click="emit('select', command)"
      >
        <span class="candidate-name">/{{ command.id }}</span>
        <span class="candidate-description">{{ command.description }}</span>
      </button>
    </template>
    <template v-if="skillsEnabled && skills.length > 0">
      <p class="mar-composer-candidate-heading" role="presentation">
        {{ translate('generated.composerCommandPicker.skills') }}
      </p>
      <button
        v-tooltip="() => candidateTooltip(commands.length + index, skill.description)"
        v-for="(skill, index) in skills"
        :key="skill.name"
        type="button"
        role="option"
        :aria-selected="commands.length + index === activeIndex"
        :data-picker-index="commands.length + index"
        @mouseenter="emit('activate', commands.length + index)"
        @click="emit('selectSkill', skill)"
      >
        <span class="candidate-name">{{ skill.name }}</span>
        <span class="candidate-description">{{ skill.description }}</span>
      </button>
    </template>
    <template v-if="quickPrompts.length > 0">
      <p :id="quickPromptHeadingId" class="mar-composer-candidate-heading" role="presentation">
        {{ translate('quickPrompts.picker') }}
      </p>
      <button
        v-tooltip="() => candidateTooltip(index, prompt.prompt)"
        v-for="(prompt, index) in quickPrompts"
        :key="prompt.id"
        type="button"
        role="option"
        :aria-selected="index === activeIndex"
        :data-picker-index="index"
        @mouseenter="emit('activate', index)"
        @click="emit('selectQuickPrompt', prompt)"
      >
        <span class="candidate-name">#{{ prompt.phrase }}</span>
        <span class="candidate-description">{{ prompt.prompt }}</span>
      </button>
    </template>
    <p v-if="commands.length === 0 && skills.length === 0 && quickPrompts.length === 0">
      {{ statusText() }}
    </p>
  </div>
</template>
