import type { MessageFeedback } from '../model/message-feedback.js';
import { marIcon } from '../util/mar-icons.js';
import type { WorkspaceTarget } from '../model/workbench.js';
import { ElMessageBox } from './message-box-service.js';
import { getCurrentScope, type ComputedRef, type Ref } from 'vue';
import type { RunnerCommand, Session } from '../model/workbench.js';
import { translate } from './locale-preference-service.js';

interface WorkbenchContextCommandServiceOptions {
  readonly workspaceTarget: Readonly<Ref<WorkspaceTarget | undefined>>;
  readonly selectedSession: ComputedRef<Session | undefined>;
  readonly compactCommand: ComputedRef<RunnerCommand | undefined>;
  readonly canCompact: ComputedRef<boolean>;
  readonly contextUsageLabel: ComputedRef<string>;
  readonly notice: MessageFeedback;
  readonly request: <T>(path: string, init?: RequestInit) => Promise<T>;
  readonly execute: (session: Session, command: RunnerCommand, input: string) => Promise<unknown>;
  readonly errorMessage: (error: unknown) => string;
  readonly beginSubmission: (context?: string) => (() => boolean) | undefined;
  readonly currentRevision: () => number;
}

/** Owns the authoritative `/compact` command transaction. */
export function createWorkbenchContextCommandService(
  options: WorkbenchContextCommandServiceOptions
) {
  const scope = getCurrentScope();
  async function compact(): Promise<void> {
    const workspace = options.workspaceTarget.value;
    const session = options.selectedSession.value;
    const command = options.compactCommand.value;
    if (
      workspace === undefined ||
      session === undefined ||
      command === undefined ||
      !options.canCompact.value
    )
      return;
    const revision = options.currentRevision();
    const current = () =>
      scope?.active !== false &&
      options.currentRevision() === revision &&
      options.workspaceTarget.value?.nodeId === workspace.nodeId &&
      options.workspaceTarget.value?.workspaceId === workspace.workspaceId &&
      options.selectedSession.value?.id === session.id;
    try {
      await ElMessageBox.confirm(
        [
          options.contextUsageLabel.value,
          translate('generated.workbenchContextCommandService.compactOlderContextToFreeWindowSpace')
        ]
          .filter(Boolean)
          .join('\n\n'),
        translate('generated.workbenchContextCommandService.compactContext'),
        {
          closeIcon: marIcon('close'),
          icon: marIcon('warning'),
          confirmButtonText: translate('generated.workbenchContextCommandService.compact'),
          cancelButtonText: translate('generated.workbenchContextCommandService.cancel'),
          type: 'warning'
        }
      );
    } catch {
      return;
    }
    if (!current() || !options.canCompact.value) return;
    const finishSubmission = options.beginSubmission(`session:${session.id}`);
    if (finishSubmission === undefined) return;

    try {
      await options.execute(session, command, '/compact');
    } catch (error) {
      if (finishSubmission() && current())
        options.notice(
          translate('generated.workbenchContextCommandService.unableToCompactContext', {
            value0: options.errorMessage(error)
          }),
          'error',
          error
        );
    } finally {
      finishSubmission();
    }
  }

  return { compactCurrentContext: compact };
}
