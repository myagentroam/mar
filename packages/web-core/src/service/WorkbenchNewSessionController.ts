import type { WorkspaceTarget } from '../model/workbench.js';
import { nextTick, type Ref } from 'vue';
import type {
  AgentRun,
  ConversationTurn,
  RunnerProfile,
  Session,
  Workspace
} from '../model/workbench.js';
import type { SessionContextUsage } from '../service/ConversationStateService.js';
import { createComposerAttachmentInputService } from '../service/ComposerAttachmentInputService.js';
import { translate } from '../service/LocalePreferenceService.js';

interface WorkbenchNewSessionControllerOptions {
  readonly workspaceTarget: Readonly<Ref<WorkspaceTarget | undefined>>;
  readonly selectedSessionId: Ref<string | undefined>;
  readonly selectedRunId: Ref<string | undefined>;
  readonly selectedWorkspace: Readonly<Ref<Workspace | undefined>>;
  readonly sessions: Ref<Session[]>;
  readonly runs: Ref<AgentRun[]>;
  readonly conversationTurns: Ref<ConversationTurn[]>;
  readonly conversationNextCursor: Ref<string | null>;
  readonly loadingOlderConversation: Ref<boolean>;
  readonly loadingInitialConversation: Ref<boolean>;
  readonly initialLoadFailed: Ref<boolean>;
  readonly sessionContextUsage: Ref<SessionContextUsage | null | undefined>;
  readonly sessionInput: Ref<string>;
  readonly draftSessionOpen: Ref<boolean>;
  readonly newSessionRunner: Ref<Session['runner']>;
  readonly newSessionModel: Ref<string | undefined>;
  readonly newSessionEffort: Ref<string | undefined>;
  readonly newSessionAccess: Ref<string | undefined>;
  readonly runnerProfiles: Ref<readonly RunnerProfile[]>;
  readonly draggingComposerAttachments: Ref<boolean>;
  readonly canUseComposer: Readonly<Ref<boolean>>;
  readonly notice: Ref<string>;
  readonly closeMobileWorkspaceSurface: () => void;
  readonly stopSelectedSessionWatch: () => void;
  readonly nextDetailRequest: () => void;
  readonly applyRunnerDefaults: (runner: Session['runner']) => void;
  readonly resetRunnerInteraction: () => void;
  readonly addNewSessionFiles: (files: Iterable<File>) => void;
  readonly focusInputAt: (cursor: number) => void;
}

export function createWorkbenchNewSessionController(options: WorkbenchNewSessionControllerOptions) {
  const attachmentInput = createComposerAttachmentInputService({
    canAcceptFiles: () => true,
    addFiles: options.addNewSessionFiles,
    rejectDirectory: () => {
      options.notice.value = translate(
        'generated.workbenchNewSessionController.foldersCannotBeAttachedCompressTheFolder'
      );
    },
    setDragging: (dragging) => (options.draggingComposerAttachments.value = dragging)
  });

  function ensureDraftRunnerSupported(profiles = options.runnerProfiles.value): void {
    const supportedRunner = profiles.find((profile) => profile.capabilities.includes('turn.start'));
    if (
      supportedRunner !== undefined &&
      !profiles.some(
        (profile) =>
          profile.runner === options.newSessionRunner.value &&
          profile.capabilities.includes('turn.start')
      )
    )
      options.applyRunnerDefaults(supportedRunner.runner);
  }

  async function createDraftSession(title: string): Promise<Session | undefined> {
    if (
      options.workspaceTarget.value?.nodeId === undefined ||
      options.selectedWorkspace.value === undefined
    )
      return;
    const draft: Session = {
      id: `draft:${crypto.randomUUID()}`,
      workspaceId: options.selectedWorkspace.value.id,
      runner: options.newSessionRunner.value,
      nativeControl: 'MAR_MANAGED',
      runnerTitle: title,
      model: options.newSessionModel.value ?? null,
      effort: options.newSessionEffort.value ?? null,
      access: options.newSessionAccess.value ?? null,
      activity: 'IDLE'
    };
    options.sessions.value = [draft, ...options.sessions.value];
    options.draftSessionOpen.value = false;
    options.selectedSessionId.value = draft.id;
    return draft;
  }

  function openNewSessionComposer(): void {
    options.closeMobileWorkspaceSurface();
    if (!options.draftSessionOpen.value) {
      options.stopSelectedSessionWatch();
      options.nextDetailRequest();
      ensureDraftRunnerSupported();
      options.applyRunnerDefaults(options.newSessionRunner.value);
      options.draftSessionOpen.value = true;
      options.selectedSessionId.value = undefined;
      options.selectedRunId.value = undefined;
      options.runs.value = [];
      options.sessionContextUsage.value = undefined;
      options.conversationTurns.value = [];
      options.conversationNextCursor.value = null;
      options.loadingOlderConversation.value = false;
      options.loadingInitialConversation.value = false;
      options.initialLoadFailed.value = false;
      options.resetRunnerInteraction();
    }
    void nextTick(() => options.focusInputAt(options.sessionInput.value.length));
  }

  return {
    createDraftSession,
    ensureDraftRunnerSupported,
    onComposerAttachmentDragEnter: attachmentInput.onDragEnter,
    onComposerAttachmentDragLeave: attachmentInput.onDragLeave,
    onComposerAttachmentDrop: attachmentInput.onDrop,
    onNewSessionPaste: attachmentInput.onPaste,
    openNewSessionComposer
  };
}
