import type { WorkspaceTarget } from '../model/workbench.js';
import type { Ref } from 'vue';
import type {
  ComposerReferenceCandidate,
  ComposerRangeEdit
} from './composer-reference-service.js';
import type { createComposerReferenceService } from './composer-reference-service.js';
import type { createRunnerInteractionService } from './runner-interaction-service.js';
import { quickPromptAtCursor, slashCommandAtCursor } from './runner-interaction-service.js';
import { registerComposerShortcuts } from './composer-shortcut-service.js';
import { consoleKeyboardShortcutService } from './console-keyboard-shortcut-service.js';
import { composerSendKeys, composerStopKeys } from './console-shortcut-keys.js';

interface WorkbenchComposerInteractionOptions {
  readonly input: Ref<string>;
  readonly workspaceTarget: Readonly<Ref<WorkspaceTarget | undefined>>;
  readonly filesReady: Readonly<Ref<boolean>>;
  readonly mobileViewport: Readonly<Ref<boolean>>;
  readonly canInterruptTurn: Readonly<Ref<boolean>>;
  readonly runnerProfilesLoading: Readonly<Ref<boolean>>;
  readonly runnerProfilesFailed: Readonly<Ref<boolean>>;
  readonly commandPickerOpen: Ref<boolean>;
  readonly fileReferences: ReturnType<typeof createComposerReferenceService>;
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
  readonly editRange: ComposerRangeEdit;
  readonly sentHistory?: {
    readonly reset: () => void;
    readonly recall: (
      direction: import('./composer-send-history-service.js').ComposerSendHistoryDirection,
      replace: (body: string) => boolean
    ) => boolean;
  };
}

export function createWorkbenchComposerInteractionController(
  options: WorkbenchComposerInteractionOptions
) {
  const handledHistoryKeys = new Set<string>();

  function registerShortcuts(owner: () => Element | undefined): () => void {
    const releases = [
      registerComposerShortcuts({
        owner,
        canSend: () =>
          !options.mobileViewport.value &&
          !options.fileReferences.open.value &&
          (!options.runnerInteractions.commandPickerOpen.value ||
            options.runnerInteractions.visibleEntryCount.value === 0),
        canReplace: () => true,
        canStop: () =>
          options.canInterruptTurn.value &&
          !options.fileReferences.open.value &&
          !options.runnerInteractions.commandPickerOpen.value,
        send: (replace) => options.sendMessage(replace),
        stop: () => {
          void options.stopActiveRun();
        }
      }),
      consoleKeyboardShortcutService.register({
        command: 'composer.acceptPicker',
        scope: 'pane',
        priority: 110,
        owner,
        keys: composerSendKeys,
        when: () =>
          !options.mobileViewport.value &&
          (options.fileReferences.open.value ||
            (options.runnerInteractions.commandPickerOpen.value &&
              options.runnerInteractions.visibleEntryCount.value > 0)),
        execute: () => {
          if (options.fileReferences.open.value) {
            const entry =
              options.fileReferences.candidates.value[options.fileReferences.activeIndex.value];
            if (entry !== undefined) selectReference(entry);
          } else options.runnerInteractions.acceptPicker(pickerCallbacks());
          return 'HANDLED';
        }
      }),
      consoleKeyboardShortcutService.register({
        command: 'composer.dismissPicker',
        scope: 'pane',
        priority: 110,
        owner,
        keys: composerStopKeys,
        when: () =>
          options.fileReferences.open.value || options.runnerInteractions.commandPickerOpen.value,
        execute: () => {
          if (options.fileReferences.open.value) {
            options.fileReferences.cancelSearch();
            options.fileReferences.close();
          } else options.runnerInteractions.dismissPicker();
          return 'HANDLED';
        }
      })
    ];
    return () => releases.forEach((release) => release());
  }
  function updatePickers(cursor = options.input.value.length): void {
    options.runnerInteractions.onInput(cursor);
    options.fileReferences.update(cursor);
    if (
      (!options.filesReady.value && !options.fileReferences.sessionAvailable()) ||
      options.workspaceTarget.value?.workspaceId === undefined
    )
      options.fileReferences.close();
    if (options.fileReferences.open.value) options.commandPickerOpen.value = false;
    options.fileReferences.scheduleSearch();
  }

  function onComposerInput(
    cursor = options.input.value.length,
    source: 'keyboard' | 'paste' = 'keyboard'
  ): void {
    options.sentHistory?.reset();
    if (source === 'paste') {
      options.commandPickerOpen.value = false;
      options.fileReferences.cancelSearch();
      options.fileReferences.close();
      return;
    }
    const slashQuery = slashCommandAtCursor(options.input.value, cursor);
    const quickPromptQuery = quickPromptAtCursor(options.input.value, cursor);
    updatePickers(cursor);
    if (options.fileReferences.open.value) return;
    if (slashQuery !== undefined) options.ensureComposerSkills();
    if (quickPromptQuery !== undefined) options.ensureQuickPrompts();
    if (
      slashQuery !== undefined &&
      options.workspaceTarget.value?.nodeId !== undefined &&
      !options.runnerProfilesLoading.value &&
      (options.runnerProfilesFailed.value ||
        !options.hasRunnerProfile(options.workspaceTarget.value?.nodeId))
    )
      void options.loadRunnerProfiles(options.workspaceTarget.value?.nodeId);
  }

  function onComposerCursor(cursor: number, key?: string): void {
    if (key !== undefined && handledHistoryKeys.delete(key)) return;
    updatePickers(cursor);
  }

  function onComposerKeydown(event: KeyboardEvent, replaceBody?: (body: string) => boolean): void {
    if (event.isComposing) return;
    if (!event.repeat) handledHistoryKeys.delete(event.key);
    if (
      options.sentHistory !== undefined &&
      replaceBody !== undefined &&
      event.altKey &&
      !event.shiftKey &&
      !event.ctrlKey &&
      !event.metaKey &&
      (event.key === 'ArrowUp' || event.key === 'ArrowDown')
    ) {
      if (event.defaultPrevented) return;
      if (options.sentHistory.recall(event.key === 'ArrowUp' ? 'older' : 'newer', replaceBody)) {
        handledHistoryKeys.add(event.key);
        event.preventDefault();
        options.fileReferences.cancelSearch();
        options.fileReferences.close();
        options.runnerInteractions.dismissPicker();
        return;
      }
    }
    if (options.fileReferences.open.value) {
      if (
        (event.key === 'ArrowDown' || event.key === 'ArrowUp') &&
        options.fileReferences.candidates.value.length > 0
      ) {
        event.preventDefault();
        const delta = event.key === 'ArrowDown' ? 1 : -1;
        options.fileReferences.activeIndex.value =
          (options.fileReferences.activeIndex.value +
            delta +
            options.fileReferences.candidates.value.length) %
          options.fileReferences.candidates.value.length;
        return;
      }
    }
    options.runnerInteractions.onKeydown(event);
  }

  function pickerCallbacks() {
    return {
      send: options.sendMessage,
      selectQuickPrompt: selectQuickPrompt,
      selectSkill: options.selectSkill
    };
  }

  function selectReference(entry: ComposerReferenceCandidate): void {
    options.fileReferences.selectCandidate(entry, options.editRange);
  }

  function selectQuickPrompt(
    prompt: Parameters<typeof options.runnerInteractions.selectQuickPrompt>[0]
  ): void {
    options.runnerInteractions.selectQuickPrompt(prompt, options.editRange);
  }

  function onComposerScroll(): void {
    options.handleConversationScroll(() => void options.loadOlderConversationTurns());
  }

  return {
    registerShortcuts,
    onComposerCursor,
    onComposerInput,
    onComposerKeydown,
    onComposerScroll,
    scrollConversationToLatest: options.scrollToLatest,
    scrollConversationToLatestAfterLayout: options.scrollToLatestAfterLayout,
    selectReference,
    selectQuickPrompt
  };
}
