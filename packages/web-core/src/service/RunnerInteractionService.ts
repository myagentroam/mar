import { computed, ref, type Ref } from 'vue';
import type {
  RunnerCommand,
  RunnerCommandState,
  RunnerProfile,
  Session,
  QuickPrompt
} from '../model/workbench.js';
import { localizedRunnerCommandState } from '../util/runner-presentation.js';
import type { EffectiveWorkspaceSkill } from './EffectiveWorkspaceSkillService.js';

export interface DeferredRunnerCommand {
  readonly command: RunnerCommand;
  readonly input: string;
}

/** Returns the Slash word under the caret; only a start, whitespace, or newline may precede it. */
export function slashCommandAtCursor(value: string, cursor = value.length): string | undefined {
  const beforeCursor = value.slice(0, Math.max(0, Math.min(cursor, value.length)));
  const match = /(?:^|\s)\/([^\s]*)$/.exec(beforeCursor);
  return match === null ? undefined : match[1]!.toLocaleLowerCase();
}

/** Removes only the Slash command currently being picked, preserving the surrounding draft. */
export function removeSlashCommandAtCursor(value: string, cursor = value.length): string {
  const boundedCursor = Math.max(0, Math.min(cursor, value.length));
  const beforeCursor = value.slice(0, boundedCursor);
  const match = /(^|\s)\/[^\s]*$/.exec(beforeCursor);
  if (match === null) return value;
  return `${beforeCursor.slice(0, match.index + match[1]!.length)}${value.slice(boundedCursor)}`;
}

/** Returns the quick-prompt phrase under the caret; `#` only starts after whitespace or text start. */
export function quickPromptAtCursor(value: string, cursor = value.length): string | undefined {
  const beforeCursor = value.slice(0, Math.max(0, Math.min(cursor, value.length)));
  const match = /(?:^|\s)#([^\s]*)$/.exec(beforeCursor);
  return match === null ? undefined : match[1]!.toLocaleLowerCase();
}

export function replaceQuickPromptAtCursor(
  value: string,
  replacement: string,
  cursor = value.length
): { readonly value: string; readonly cursor: number } | undefined {
  const bounded = Math.max(0, Math.min(cursor, value.length));
  const beforeCursor = value.slice(0, bounded);
  const match = /(^|\s)#[^\s]*$/.exec(beforeCursor);
  if (match === null) return undefined;
  const start = match.index + match[1]!.length;
  return {
    value: `${beforeCursor.slice(0, start)}${replacement}${value.slice(bounded)}`,
    cursor: start + replacement.length
  };
}

export function createRunnerInteractionService(options: {
  readonly input: Ref<string>;
  readonly draftSessionOpen: Ref<boolean>;
  readonly selectedSession: Readonly<Ref<Session | undefined>>;
  readonly profile: Readonly<Ref<RunnerProfile | undefined>>;
  readonly commandAvailable?: (command: RunnerCommand) => boolean;
  readonly skills?: Readonly<Ref<readonly EffectiveWorkspaceSkill[]>>;
  readonly quickPrompts?: Readonly<Ref<readonly QuickPrompt[]>>;
}) {
  const selectedCommand = ref<RunnerCommand>();
  const deferredDraftCommands = ref<readonly DeferredRunnerCommand[]>([]);
  const codexFastEnabled = ref(false);
  const commandPickerOpen = ref(false);
  const commandCursor = ref(options.input.value.length);
  const activeCommandIndex = ref(0);
  const composerMode = ref<'message' | 'steer'>('message');
  const pickerKind = ref<'runner' | 'quick-prompt'>();
  let pickerQuery: string | undefined;
  let pickerCursor = commandCursor.value;

  const visibleCommands = computed(() => {
    const query = slashCommandAtCursor(options.input.value, commandCursor.value);
    if (query === undefined) return [];
    return (options.profile.value?.commands ?? []).filter(
      (command) =>
        command.available &&
        options.commandAvailable?.(command) !== false &&
        (query.length === 0 ||
          command.id.toLocaleLowerCase().includes(query) ||
          command.label.toLocaleLowerCase().includes(query))
    );
  });

  const visibleSkills = computed(() => {
    const query = slashCommandAtCursor(options.input.value, commandCursor.value);
    if (query === undefined) return [];
    const skills = options.skills?.value ?? [];
    if (query.length === 0) return skills;
    return skills.filter(
      (skill) =>
        skill.name.toLocaleLowerCase().includes(query) ||
        skill.description.toLocaleLowerCase().includes(query)
    );
  });

  const visibleEntryCount = computed(() =>
    pickerKind.value === 'quick-prompt'
      ? visibleQuickPrompts.value.length
      : visibleCommands.value.length + visibleSkills.value.length
  );

  const visibleQuickPrompts = computed(() => {
    const query = quickPromptAtCursor(options.input.value, commandCursor.value);
    if (query === undefined) return [];
    const prompts = options.quickPrompts?.value ?? [];
    if (query.length === 0) return prompts;
    return prompts
      .filter((prompt) => prompt.phrase.toLocaleLowerCase().includes(query))
      .sort(
        (left, right) =>
          quickPromptMatchPriority(left, query) - quickPromptMatchPriority(right, query)
      );
  });

  const activeCommandStates = computed<readonly RunnerCommandState[]>(() => {
    if (!options.draftSessionOpen.value)
      return (options.selectedSession.value?.commandStates ?? [])
        .filter((state) => state.commandId !== 'goal' || state.goal === undefined)
        .map(localizedRunnerCommandState);
    return deferredDraftCommands.value
      .map(({ command, input }) => ({
        commandId: command.id,
        active: true,
        label: command.stateLabel ?? command.label,
        detail: input === `/${command.id}` ? command.description : input,
        closable: true,
        closeInput: input
      }))
      .map(localizedRunnerCommandState);
  });

  function reset(): void {
    selectedCommand.value = undefined;
    deferredDraftCommands.value = [];
    commandPickerOpen.value = false;
    pickerKind.value = undefined;
    activeCommandIndex.value = 0;
    pickerQuery = undefined;
    pickerCursor = commandCursor.value;
    composerMode.value = 'message';
  }

  function updatePicker(cursor = options.input.value.length): void {
    commandCursor.value = cursor;
    const query = slashCommandAtCursor(options.input.value, cursor);
    const quickPromptQuery = quickPromptAtCursor(options.input.value, cursor);
    if (selectedCommand.value !== undefined && query !== selectedCommand.value.id)
      selectedCommand.value = undefined;
    pickerKind.value =
      query !== undefined ? 'runner' : quickPromptQuery !== undefined ? 'quick-prompt' : undefined;
    commandPickerOpen.value = pickerKind.value !== undefined;
    const nextPickerQuery =
      query ?? (quickPromptQuery === undefined ? undefined : `#${quickPromptQuery}`);
    if (nextPickerQuery !== pickerQuery || cursor !== pickerCursor) {
      activeCommandIndex.value = 0;
    }
    pickerQuery = nextPickerQuery;
    pickerCursor = cursor;
  }

  function clearCommand(): void {
    selectedCommand.value = undefined;
    if (options.input.value.trimStart().startsWith('/')) options.input.value = '';
  }

  function selectCommand(command: RunnerCommand, send: (preserveDraft: boolean) => void): void {
    if (options.commandAvailable?.(command) === false) return;
    selectedCommand.value = command;
    options.input.value = removeSlashCommandAtCursor(options.input.value, commandCursor.value);
    commandPickerOpen.value = false;
    pickerKind.value = undefined;
    if (
      command.interaction === 'IMMEDIATE_ACTION' ||
      command.interaction === 'DESTRUCTIVE_ACTION' ||
      command.interaction === 'TOGGLE'
    )
      send(true);
  }

  function selectSkill(
    skill: EffectiveWorkspaceSkill,
    stage: (skill: EffectiveWorkspaceSkill, cursor: number) => void
  ): void {
    const previousLength = options.input.value.length;
    options.input.value = removeSlashCommandAtCursor(options.input.value, commandCursor.value);
    const cursor = commandCursor.value - (previousLength - options.input.value.length);
    commandPickerOpen.value = false;
    pickerKind.value = undefined;
    stage(skill, cursor);
  }

  function selectQuickPrompt(prompt: QuickPrompt): number | undefined {
    const replacement = replaceQuickPromptAtCursor(
      options.input.value,
      prompt.prompt,
      commandCursor.value
    );
    if (replacement === undefined) return undefined;
    options.input.value = replacement.value;
    commandPickerOpen.value = false;
    pickerKind.value = undefined;
    return replacement.cursor;
  }

  function stageDraftCommand(command: RunnerCommand, input: string): void {
    const normalized = input.trim();
    if (command.interaction === 'TOGGLE') {
      const alreadyActive = deferredDraftCommands.value.some(
        (candidate) => candidate.command.id === command.id
      );
      if (command.id === 'goal' && alreadyActive) return;
      deferredDraftCommands.value = alreadyActive
        ? deferredDraftCommands.value.filter((candidate) => candidate.command.id !== command.id)
        : [...deferredDraftCommands.value, { command, input: normalized }];
      return;
    }
    deferredDraftCommands.value = [
      ...deferredDraftCommands.value.filter((candidate) => candidate.command.id !== command.id),
      { command, input: normalized }
    ];
  }

  function closeCommandState(
    state: RunnerCommandState,
    send: (command: RunnerCommand, input: string) => void
  ): void {
    if (!state.closable || state.closeInput === null) return;
    if (options.draftSessionOpen.value) {
      deferredDraftCommands.value = deferredDraftCommands.value.filter(
        (candidate) => candidate.command.id !== state.commandId
      );
      return;
    }
    const command = (options.profile.value?.commands ?? []).find(
      (candidate) => candidate.available && candidate.id === state.commandId
    );
    if (command === undefined) return;
    send(command, state.closeInput);
  }

  function onInput(cursor?: number): void {
    if (
      selectedCommand.value !== undefined &&
      slashCommandAtCursor(options.input.value, cursor) !== selectedCommand.value.id
    )
      selectedCommand.value = undefined;
    updatePicker(cursor);
  }

  function onKeydown(
    event: KeyboardEvent,
    callbacks: {
      readonly mobile: boolean;
      readonly canInterrupt: boolean;
      readonly stop: () => void;
      readonly send: (
        replaceCurrent: boolean,
        preserveDraft?: boolean,
        contentOverride?: string
      ) => void;
      readonly selectQuickPrompt?: (prompt: QuickPrompt) => void;
      readonly selectSkill?: (skill: EffectiveWorkspaceSkill, cursor: number) => void;
    }
  ): void {
    if (event.key === 'Escape' && commandPickerOpen.value) {
      event.preventDefault();
      commandPickerOpen.value = false;
      pickerKind.value = undefined;
      return;
    }
    if (event.key === 'Escape' && callbacks.canInterrupt) {
      event.preventDefault();
      callbacks.stop();
      return;
    }
    if (callbacks.mobile && event.key === 'Enter') return;
    if (commandPickerOpen.value && visibleEntryCount.value > 0) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const delta = event.key === 'ArrowDown' ? 1 : -1;
        activeCommandIndex.value =
          (activeCommandIndex.value + delta + visibleEntryCount.value) % visibleEntryCount.value;
        return;
      }
      if (event.key === 'Enter' && (event.shiftKey || event.altKey)) return;
      if (event.key === 'Enter') {
        event.preventDefault();
        if (pickerKind.value === 'quick-prompt') {
          const prompt = visibleQuickPrompts.value[activeCommandIndex.value];
          if (prompt !== undefined) callbacks.selectQuickPrompt?.(prompt);
          return;
        }
        const command = visibleCommands.value[activeCommandIndex.value];
        if (command !== undefined) {
          selectCommand(command, (preserveDraft) => callbacks.send(false, preserveDraft));
          return;
        }
        const skill = visibleSkills.value[activeCommandIndex.value - visibleCommands.value.length];
        if (skill !== undefined && callbacks.selectSkill !== undefined)
          selectSkill(skill, callbacks.selectSkill);
        return;
      }
    }
    if (event.key === 'Enter' && (event.shiftKey || event.altKey)) return;
    if (event.key === 'Enter') {
      event.preventDefault();
      // Run and Session snapshots are display hints only. Preserve the explicit keyboard intent
      // and let Node decide whether replacement or a normal start applies.
      callbacks.send(event.ctrlKey);
    }
  }

  return {
    selectedCommand,
    deferredDraftCommands,
    codexFastEnabled,
    commandPickerOpen,
    activeCommandIndex,
    composerMode,
    visibleCommands,
    visibleSkills,
    visibleQuickPrompts,
    pickerKind,
    visibleEntryCount,
    activeCommandStates,
    reset,
    updatePicker,
    clearCommand,
    selectCommand,
    selectSkill,
    selectQuickPrompt,
    stageDraftCommand,
    closeCommandState,
    onInput,
    onKeydown
  };
}

function quickPromptMatchPriority(prompt: QuickPrompt, query: string): number {
  const phrase = prompt.phrase.toLocaleLowerCase();
  if (phrase === query) return 0;
  if (phrase.startsWith(query)) return 1;
  return 2;
}
