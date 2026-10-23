<script setup lang="ts">
import { nextTick, ref, watch } from 'vue';
import { translate } from '../../service/LocalePreferenceService.js';
import type { QuickPrompt, RunnerCommand } from '../../model/workbench.js';
import type { EffectiveWorkspaceSkill } from '../../service/EffectiveWorkspaceSkillService.js';

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
    class="command-picker"
    role="listbox"
    :aria-label="
      translate(
        skillsEnabled
          ? 'generated.composerCommandPicker.commandsAndSkills'
          : 'generated.composerCommandPicker.runnerCommands'
      )
    "
  >
    <template v-if="commands.length > 0">
      <p class="picker-group" role="presentation">
        {{ translate('generated.composerCommandPicker.runnerCommands') }}
      </p>
      <button
        v-for="(command, index) in commands"
        :key="command.id"
        :class="{ active: index === activeIndex }"
        type="button"
        role="option"
        :aria-selected="index === activeIndex"
        :data-picker-index="index"
        @mouseenter="emit('activate', index)"
        @click="emit('select', command)"
      >
        <strong>/{{ command.id }}</strong
        ><span :title="command.description">{{ command.description }}</span>
      </button>
    </template>
    <template v-if="skillsEnabled && skills.length > 0">
      <p class="picker-group" role="presentation">
        {{ translate('generated.composerCommandPicker.skills') }}
      </p>
      <button
        v-for="(skill, index) in skills"
        :key="skill.name"
        :class="{ active: commands.length + index === activeIndex }"
        type="button"
        role="option"
        :aria-selected="commands.length + index === activeIndex"
        :data-picker-index="commands.length + index"
        @mouseenter="emit('activate', commands.length + index)"
        @click="emit('selectSkill', skill)"
      >
        <strong>{{ skill.name }}</strong
        ><span :title="skill.description">{{ skill.description }}</span>
      </button>
    </template>
    <template v-if="quickPrompts.length > 0">
      <p class="picker-group" role="presentation">{{ translate('quickPrompts.picker') }}</p>
      <button
        v-for="(prompt, index) in quickPrompts"
        :key="prompt.id"
        :class="{ active: index === activeIndex }"
        type="button"
        role="option"
        :aria-selected="index === activeIndex"
        :data-picker-index="index"
        @mouseenter="emit('activate', index)"
        @click="emit('selectQuickPrompt', prompt)"
      >
        <strong :title="`#${prompt.phrase}`">#{{ prompt.phrase }}</strong>
        <span class="quick-prompt-content" :title="prompt.prompt">{{ prompt.prompt }}</span>
      </button>
    </template>
    <p v-if="commands.length === 0 && skills.length === 0 && quickPrompts.length === 0">
      {{ statusText() }}
    </p>
  </div>
</template>
<style scoped>
.command-picker {
  position: absolute;
  right: 0;
  bottom: calc(100% + 0.5rem);
  left: 0;
  display: grid;
  max-height: 200px;
  overflow: auto;
  border: 1px solid var(--mar-border-strong);
  border-radius: 5px;
  background: var(--mar-control-bg-color-overlay);
  box-shadow: 0 4px 12px var(--mar-shadow-soft);
}

.picker-group {
  margin: 0;
  padding: 0.35rem 0.65rem 0.15rem;
  color: var(--mar-text-tertiary);
  font-size: var(--mar-font-size-meta);
  font-weight: 600;
}

.command-picker button {
  font-family: inherit;
  font-size: var(--mar-font-size-body);
  line-height: 1.4;
  display: grid;
  grid-template-columns: 150px minmax(0, 1fr);
  gap: 0.55rem;
  border: 0;
  border-bottom: 1px solid var(--mar-fill-hover);
  border-radius: 0;
  background: var(--mar-control-bg-color-overlay);
  color: var(--mar-text-primary);
  cursor: pointer;
  padding: 0.55rem 0.65rem;
  text-align: left;
}

.command-picker button:hover,
.command-picker button.active {
  background: var(--mar-color-brand-selected);
}

.command-picker button strong {
  font-weight: 600;
}

.command-picker button span,
.command-picker p {
  color: var(--mar-text-tertiary);
  font-size: var(--mar-font-size-meta);
}

.command-picker button span {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.quick-prompt-content {
  color: var(--mar-text-tertiary);
}

.command-picker button:is(:hover, .active),
.command-picker button:is(:hover, .active) span {
  color: var(--mar-color-brand-text);
}

.command-picker > p:last-child {
  margin: 0;
  padding: 0.65rem;
}
</style>
<style scoped>
@media (max-width: 767px) {
  .command-picker {
    max-height: min(200px, 34dvh);
  }

  .command-picker button {
    align-items: center;
    box-sizing: border-box;
    width: 100%;
    justify-self: stretch;
    grid-template-columns: max-content minmax(0, 1fr);
    gap: 0.45rem;
    padding: 0.5rem 0.65rem;
  }

  .command-picker button.active {
    width: 100%;
  }

  .command-picker strong {
    white-space: nowrap;
  }

  .command-picker button span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
}
</style>
