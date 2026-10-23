import type { MessageFeedback } from '../model/message-feedback.js';
import type { WorkspaceTarget } from '../model/workbench.js';
import type { ComputedRef, Ref } from 'vue';
import type { AgentRun, GoalExitSummary } from '../model/workbench.js';
import type { createRunService } from './RunService.js';
import { translate } from './LocalePreferenceService.js';
import { errorCode } from '../util/api-error.js';

interface WorkbenchRunControlServiceOptions {
  readonly workspaceTarget: Readonly<Ref<WorkspaceTarget | undefined>>;
  readonly selectedSessionId: Ref<string | undefined>;
  readonly selectedRunId: Ref<string | undefined>;
  readonly activeRun: ComputedRef<AgentRun | undefined>;
  readonly runs: Ref<AgentRun[]>;
  readonly notice: MessageFeedback;
  readonly runService: ReturnType<typeof createRunService>;
  readonly request: <T>(path: string, init?: RequestInit) => Promise<T>;
  readonly sessionPathId: (sessionId: string) => string;
  readonly errorMessage: (error: unknown) => string;
  readonly beginSubmission: (context?: string) => (() => boolean) | undefined;
}

/** Owns immediate interrupt settlement, rollback and missing-Run reconciliation. */
export function createWorkbenchRunControlService(options: WorkbenchRunControlServiceOptions) {
  const missingRunError = (error: unknown) => errorCode(error) === 'RUN_NOT_FOUND';

  async function stopActiveRun(): Promise<void> {
    const nodeId = options.workspaceTarget.value?.nodeId;
    const workspaceId = options.workspaceTarget.value?.workspaceId;
    const sessionId = options.selectedSessionId.value;
    if (nodeId === undefined || workspaceId === undefined || sessionId === undefined) return;
    const run = options.activeRun.value;
    const finishSubmission = options.beginSubmission(`session:${sessionId}`);
    if (finishSubmission === undefined) return;
    if (run === undefined) {
      try {
        const result = await options.request<{ run: AgentRun; goalExit?: GoalExitSummary }>(
          `/api/agent-sessions/${options.sessionPathId(sessionId)}/interrupt`,
          { method: 'POST', body: JSON.stringify({ nodeId }) }
        );
        options.runService.mergeSnapshots([result.run]);
        options.selectedRunId.value = result.run.id;
      } catch (error) {
        const completedInSubmissionWindow = finishSubmission();
        if (!missingRunError(error) && completedInSubmissionWindow) {
          options.notice(
            translate('generated.workbenchRunControlService.runOperationDenied', {
              value0: options.errorMessage(error)
            }),
            'error',
            error
          );
        }
      } finally {
        finishSubmission();
      }
      return;
    }
    try {
      const result = await options.request<{ run?: AgentRun; goalExit?: GoalExitSummary }>(
        `/api/agent-runs/${encodeURIComponent(run.id)}/interrupt`,
        { method: 'POST', body: JSON.stringify({ nodeId }) }
      );
      if (result.run !== undefined)
        options.runs.value = options.runs.value.map((candidate) =>
          candidate.id === result.run?.id ? result.run : candidate
        );
    } catch (error) {
      const completedInSubmissionWindow = finishSubmission();
      if (!missingRunError(error) && completedInSubmissionWindow) {
        options.notice(
          translate('generated.workbenchRunControlService.runOperationDenied2', {
            value0: options.errorMessage(error)
          }),
          'error',
          error
        );
      }
    } finally {
      finishSubmission();
    }
  }

  return { stopActiveRun };
}
