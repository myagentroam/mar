import type { WorkspaceTarget } from '../model/workbench.js';
import { ElMessageBox } from 'element-plus';
import type { ComputedRef, Ref } from 'vue';
import type { RunnerCommand, Session } from '../model/workbench.js';
import { translate } from './LocalePreferenceService.js';

interface WorkbenchContextCommandServiceOptions {
  readonly workspaceTarget: Readonly<Ref<WorkspaceTarget | undefined>>;
  readonly selectedSession: ComputedRef<Session | undefined>;
  readonly compactCommand: ComputedRef<RunnerCommand | undefined>;
  readonly canCompact: ComputedRef<boolean>;
  readonly notice: Ref<string>;
  readonly request: <T>(path: string, init?: RequestInit) => Promise<T>;
  readonly execute: (session: Session, command: RunnerCommand, input: string) => Promise<unknown>;
  readonly errorMessage: (error: unknown) => string;
  readonly beginSubmission: (context?: string) => (() => boolean) | undefined;
}

/** Owns the authoritative `/compact` command transaction. */
export function createWorkbenchContextCommandService(
  options: WorkbenchContextCommandServiceOptions
) {
  async function compact(): Promise<void> {
    const nodeId = options.workspaceTarget.value?.nodeId;
    const session = options.selectedSession.value;
    const command = options.compactCommand.value;
    if (
      nodeId === undefined ||
      session === undefined ||
      command === undefined ||
      !options.canCompact.value
    )
      return;
    try {
      await ElMessageBox.confirm(
        translate('generated.workbenchContextCommandService.compactOlderContextToFreeWindowSpace'),
        translate('generated.workbenchContextCommandService.compactContext'),
        {
          confirmButtonText: translate('generated.workbenchContextCommandService.compact'),
          cancelButtonText: translate('generated.workbenchContextCommandService.cancel'),
          type: 'warning'
        }
      );
    } catch {
      return;
    }
    if (
      options.workspaceTarget.value?.nodeId !== nodeId ||
      options.selectedSession.value?.id !== session.id ||
      !options.canCompact.value
    )
      return;
    const finishSubmission = options.beginSubmission(`session:${session.id}`);
    if (finishSubmission === undefined) return;
    options.notice.value = '';
    try {
      await options.execute(session, command, '/compact');
    } catch (error) {
      if (finishSubmission())
        options.notice.value = translate(
          'generated.workbenchContextCommandService.unableToCompactContext',
          { value0: options.errorMessage(error) }
        );
    } finally {
      finishSubmission();
    }
  }

  return { compactCurrentContext: compact };
}
