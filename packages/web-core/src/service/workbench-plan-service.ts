import type { MessageFeedback } from '../model/message-feedback.js';
import type { WorkspaceTarget } from '../model/workbench.js';
import { getCurrentScope, type ComputedRef, type Ref } from 'vue';
import type {
  AgentRun,
  ConversationTurn,
  RunnerCommand,
  RunnerCommandState,
  Session
} from '../model/workbench.js';
import { translate } from './locale-preference-service.js';

interface WorkbenchPlanServiceOptions {
  readonly workspaceTarget: Readonly<Ref<WorkspaceTarget | undefined>>;
  readonly selectedSessionId: Ref<string | undefined>;
  readonly selectedSession: ComputedRef<Session | undefined>;
  readonly input: Ref<string>;
  readonly selectedCommand: Ref<RunnerCommand | undefined>;
  readonly commandPickerOpen: Ref<boolean>;
  readonly notice: MessageFeedback;
  readonly continuationFor: (
    item: ConversationTurn['items'][number]
  ) => RunnerCommandState | undefined;
  readonly execute: (
    session: Session,
    commandId: string,
    input: string
  ) => Promise<{ session?: Session; run?: AgentRun }>;
  readonly send: () => Promise<void>;
  readonly errorMessage: (error: unknown) => string;
  readonly beginSubmission: (context?: string) => (() => boolean) | undefined;
  readonly currentRevision: () => number;
}

/** Owns the close-Plan then submit-implementation transaction. */
export function createWorkbenchPlanService(options: WorkbenchPlanServiceOptions) {
  const scope = getCurrentScope();
  async function implement(item: ConversationTurn['items'][number]): Promise<void> {
    const state = options.continuationFor(item);
    const session = options.selectedSession.value;
    const workspace = options.workspaceTarget.value;
    if (
      state?.continuation === null ||
      state?.continuation === undefined ||
      session === undefined ||
      workspace === undefined
    )
      return;

    const revision = options.currentRevision();
    const current = (sessionId: string) =>
      scope?.active !== false &&
      options.currentRevision() === revision &&
      options.workspaceTarget.value?.nodeId === workspace.nodeId &&
      options.workspaceTarget.value?.workspaceId === workspace.workspaceId &&
      options.selectedSessionId.value === sessionId;
    let completedInSubmissionWindow = true;
    try {
      let target = session;
      if (state.closeInput !== null) {
        const finishSubmission = options.beginSubmission(`session:${session.id}`);
        if (finishSubmission === undefined) return;
        let result: { session?: Session; run?: AgentRun };
        try {
          result = await options.execute(session, state.commandId, state.closeInput);
        } finally {
          completedInSubmissionWindow = finishSubmission();
        }
        if (!completedInSubmissionWindow) return;
        target = result.session ?? session;
      }
      if (current(target.id)) {
        options.selectedCommand.value = undefined;
        options.commandPickerOpen.value = false;
        options.input.value = state.continuation.prompt;
        await options.send();
      }
    } catch (error) {
      if (completedInSubmissionWindow && current(session.id))
        options.notice(
          translate('generated.workbenchPlanService.unableToImplementThePlan', {
            value0: options.errorMessage(error)
          }),
          'error',
          error
        );
    }
  }

  return { implementPlan: implement };
}
