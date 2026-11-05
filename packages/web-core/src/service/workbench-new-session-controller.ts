import type { WorkspaceTarget } from '../model/workbench.js';
import { nextTick, type Ref } from 'vue';
import type { RunnerProfile, Session, Workspace } from '../model/workbench.js';

interface WorkbenchNewSessionControllerOptions {
  readonly workspaceTarget: Readonly<Ref<WorkspaceTarget | undefined>>;
  readonly selectedSessionId: Readonly<Ref<string | undefined>>;
  readonly setSelectedSessionId: (id: string | undefined) => void;
  readonly selectedWorkspace: Readonly<Ref<Workspace | undefined>>;
  readonly sessions: Readonly<Ref<readonly Session[]>>;
  readonly prependSession: (session: Session) => void;
  readonly prepareDraft: () => void;
  readonly focusDraft: () => void;
  readonly draftSessionOpen: Readonly<Ref<boolean>>;
  readonly setDraftOpen: (open: boolean) => void;
  readonly newSessionRunner: Readonly<Ref<Session['runner']>>;
  readonly newSessionModel: Readonly<Ref<string | undefined>>;
  readonly newSessionEffort: Readonly<Ref<string | undefined>>;
  readonly newSessionAccess: Readonly<Ref<string | undefined>>;
  readonly runnerProfiles: Ref<readonly RunnerProfile[]>;
  readonly canUseComposer: Readonly<Ref<boolean>>;
  readonly closeMobileWorkspaceSurface: () => void;
  readonly saveCurrent: () => void;
  readonly stopSelectedSessionWatch: () => void;
  readonly applyRunnerDefaults: (runner: Session['runner']) => void;
}

export function createWorkbenchNewSessionController(options: WorkbenchNewSessionControllerOptions) {
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
      modelId: options.newSessionModel.value ?? null,
      effort: options.newSessionEffort.value ?? null,
      access: options.newSessionAccess.value ?? null,
      activity: 'IDLE'
    };
    options.prependSession(draft);
    options.setDraftOpen(false);
    options.setSelectedSessionId(draft.id);
    return draft;
  }

  function openNewSessionComposer(): void {
    options.closeMobileWorkspaceSurface();
    if (!options.draftSessionOpen.value) {
      options.saveCurrent();
      options.stopSelectedSessionWatch();
      ensureDraftRunnerSupported();
      options.applyRunnerDefaults(options.newSessionRunner.value);
      options.setDraftOpen(true);
      options.setSelectedSessionId(undefined);
      options.prepareDraft();
    }
    void nextTick(options.focusDraft);
  }

  return {
    createDraftSession,
    ensureDraftRunnerSupported,
    openNewSessionComposer
  };
}
