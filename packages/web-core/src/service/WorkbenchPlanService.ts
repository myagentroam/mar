import type { MessageFeedback } from '../model/message-feedback.js';
import type { WorkspaceTarget } from '../model/workbench.js';
import type { ComputedRef, Ref } from 'vue';
import type {
  AgentRun,
  ConversationTurn,
  RunnerCommand,
  RunnerCommandState,
  Session
} from '../model/workbench.js';
import { translate } from './LocalePreferenceService.js';

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
}

/** Owns the close-Plan then submit-implementation transaction. */
export function createWorkbenchPlanService(options: WorkbenchPlanServiceOptions) {
  async function implement(item: ConversationTurn['items'][number]): Promise<void> {
    const state = options.continuationFor(item);
    const session = options.selectedSession.value;
    if (
      state?.continuation === null ||
      state?.continuation === undefined ||
      session === undefined ||
      options.workspaceTarget.value?.nodeId === undefined
    )
      return;

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
      if (options.selectedSessionId.value === target.id) {
        options.selectedCommand.value = undefined;
        options.commandPickerOpen.value = false;
        options.input.value = state.continuation.prompt;
        await options.send();
      }
    } catch (error) {
      if (completedInSubmissionWindow)
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
