import type { WorkspaceTarget } from '../model/workbench.js';
import type { Ref } from 'vue';
import type { FileReferenceEntry } from './file-reference-service.js';
import type { createFileReferenceService } from './file-reference-service.js';
import type { createRunnerInteractionService } from './runner-interaction-service.js';
import { quickPromptAtCursor, slashCommandAtCursor } from './runner-interaction-service.js';

interface WorkbenchComposerInteractionOptions {
  readonly input: Ref<string>;
  readonly workspaceTarget: Readonly<Ref<WorkspaceTarget | undefined>>;
  readonly filesReady: Readonly<Ref<boolean>>;
  readonly mobileViewport: Readonly<Ref<boolean>>;
  readonly canInterruptTurn: Readonly<Ref<boolean>>;
  readonly runnerProfilesLoading: Ref<boolean>;
  readonly runnerProfilesFailed: Ref<boolean>;
  readonly commandPickerOpen: Ref<boolean>;
  readonly fileReferences: ReturnType<typeof createFileReferenceService>;
  readonly runnerInteractions: ReturnType<typeof createRunnerInteractionService>;
  readonly hasRunnerProfile: (nodeId: string) => boolean;
  readonly loadRunnerProfiles: (nodeId: string) => Promise<unknown>;
  readonly ensureComposerSkills: () => void;
  readonly ensureQuickPrompts: () => void;
  readonly selectSkill: (
    skill: Parameters<ReturnType<typeof createRunnerInteractionService>['selectSkill']>[0],
    cursor: number
  ) => void;
  readonly stopActiveRun: () => Promise<unknown>;
  readonly sendMessage: (
    replaceCurrent: boolean,
    preserveDraft?: boolean,
    contentOverride?: string
  ) => void;
  readonly loadOlderConversationTurns: () => Promise<unknown>;
  readonly handleConversationScroll: (loadOlder: () => void) => void;
  readonly scrollToLatest: () => void;
  readonly scrollToLatestAfterLayout: () => Promise<void>;
  readonly focusInputAt: (cursor: number) => void;
}

export function createWorkbenchComposerInteractionController(
  options: WorkbenchComposerInteractionOptions
) {
  function updatePickers(cursor = options.input.value.length): void {
    options.runnerInteractions.onInput(cursor);
    options.fileReferences.update(cursor);
    if (!options.filesReady.value || options.workspaceTarget.value?.workspaceId === undefined)
      options.fileReferences.close();
    if (options.fileReferences.open.value) options.commandPickerOpen.value = false;
    options.fileReferences.scheduleSearch();
  }

  function onComposerInput(
    cursor = options.input.value.length,
    source: 'keyboard' | 'paste' = 'keyboard'
  ): void {
    if (source === 'paste') {
      options.commandPickerOpen.value = false;
      options.fileReferences.cancelSearch();
      options.fileReferences.close();
      return;
    }
    const slashQuery = slashCommandAtCursor(options.input.value, cursor);
    const quickPromptQuery = quickPromptAtCursor(options.input.value, cursor);
    if (slashQuery !== undefined) options.ensureComposerSkills();
    if (quickPromptQuery !== undefined) options.ensureQuickPrompts();
    updatePickers(cursor);
    if (
      slashQuery !== undefined &&
      options.workspaceTarget.value?.nodeId !== undefined &&
      !options.runnerProfilesLoading.value &&
      (options.runnerProfilesFailed.value ||
        !options.hasRunnerProfile(options.workspaceTarget.value?.nodeId))
    )
      void options.loadRunnerProfiles(options.workspaceTarget.value?.nodeId);
  }

  function onComposerCursor(cursor: number): void {
    updatePickers(cursor);
  }

  function onComposerKeydown(event: KeyboardEvent): void {
    if (options.fileReferences.open.value) {
      if (
        (event.key === 'ArrowDown' || event.key === 'ArrowUp') &&
        options.fileReferences.entries.value.length > 0
      ) {
        event.preventDefault();
        const delta = event.key === 'ArrowDown' ? 1 : -1;
        options.fileReferences.activeIndex.value =
          (options.fileReferences.activeIndex.value +
            delta +
            options.fileReferences.entries.value.length) %
          options.fileReferences.entries.value.length;
        return;
      }
      if (
        event.key === 'Enter' &&
        !options.mobileViewport.value &&
        !event.shiftKey &&
        !event.altKey
      ) {
        const entry =
          options.fileReferences.entries.value[options.fileReferences.activeIndex.value];
        if (entry !== undefined) {
          event.preventDefault();
          selectFileReference(entry);
          return;
        }
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        options.fileReferences.cancelSearch();
        options.fileReferences.close();
        return;
      }
    }
    options.runnerInteractions.onKeydown(event, {
      mobile: options.mobileViewport.value,
      canInterrupt: options.canInterruptTurn.value,
      stop: () => void options.stopActiveRun(),
      send: options.sendMessage,
      selectQuickPrompt: (prompt) => {
        const cursor = options.runnerInteractions.selectQuickPrompt(prompt);
        if (cursor !== undefined) options.focusInputAt(cursor);
      },
      selectSkill: options.selectSkill
    });
  }

  function selectFileReference(entry: FileReferenceEntry): void {
    const cursor = options.fileReferences.select(entry);
    if (cursor === undefined) return;
    options.fileReferences.cancelSearch();
    options.focusInputAt(cursor);
  }

  function onComposerScroll(): void {
    options.handleConversationScroll(() => void options.loadOlderConversationTurns());
  }

  return {
    onComposerCursor,
    onComposerInput,
    onComposerKeydown,
    onComposerScroll,
    scrollConversationToLatest: options.scrollToLatest,
    scrollConversationToLatestAfterLayout: options.scrollToLatestAfterLayout,
    selectFileReference
  };
}
