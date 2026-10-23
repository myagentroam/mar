import type { MessageFeedback } from '../model/message-feedback.js';
import type { WorkspaceTarget } from '../model/workbench.js';
import type { Ref } from 'vue';
import { translate } from './LocalePreferenceService.js';

/** Submits approval decisions; Conversation Item events own the visible state. */
export function createWorkbenchApprovalService(options: {
  readonly workspaceTarget: Readonly<Ref<WorkspaceTarget | undefined>>;
  readonly notice: MessageFeedback;
  readonly request: <T>(path: string, init?: RequestInit) => Promise<T>;
  readonly errorMessage: (error: unknown) => string;
  readonly beginSubmission: () => (() => boolean) | undefined;
}) {
  async function decide(
    runId: string,
    approvalId: string,
    decision: 'APPROVED' | 'REJECTED'
  ): Promise<void> {
    const nodeId = options.workspaceTarget.value?.nodeId;
    if (nodeId === undefined) return;
    const finishSubmission = options.beginSubmission();
    if (finishSubmission === undefined) return;
    try {
      await options.request(
        `/api/agent-runs/${encodeURIComponent(runId)}/approvals/${encodeURIComponent(approvalId)}/decision`,
        { method: 'POST', body: JSON.stringify({ nodeId, decision }) }
      );
    } catch (error) {
      if (finishSubmission())
        options.notice(
          translate('generated.workbenchApprovalService.approvalWasNotSubmitted', {
            value0: options.errorMessage(error)
          }),
          'error',
          error
        );
    } finally {
      finishSubmission();
    }
  }

  return { decideApproval: decide };
}
