import type { ContextGcExecResult } from './context-gc-replacements.js';

/** The same process-lifetime selection is used for Direct output and retained cell inputs. */
export interface ContextGcExecFact<T> {
  readonly value: T;
  readonly callId: string;
  readonly toolName: string;
  readonly sequence: number;
  readonly input?: Record<string, unknown>;
  readonly result?: ContextGcExecResult;
}

export function terminalExecLifecycles<T>(
  facts: readonly ContextGcExecFact<T>[],
  active: ReadonlySet<string>
): ContextGcExecFact<T>[][] {
  const ordered = [...facts].sort((a, b) => a.sequence - b.sequence);
  const lifecycles: ContextGcExecFact<T>[][] = [];
  for (const start of ordered) {
    if (!start.input || !start.result) continue;
    const isStart =
      start.toolName === 'exec' &&
      (start.input.action === 'start' ||
        (start.input.action == null && typeof start.input.command === 'string'));
    const processId =
      typeof start.input.processId === 'string' ? start.input.processId : start.result.processId;
    if (!isStart) {
      if (start.toolName !== 'exec_wait' || !processId) continue;
      const previous = ordered.findLast(
        (item) =>
          item.sequence < start.sequence &&
          (item.input?.processId === processId || item.result?.processId === processId)
      );
      if (
        previous &&
        previous.result?.status !== 'completed' &&
        previous.result?.status !== 'cancelled'
      )
        continue;
    }
    const lifecycle = [start];
    let terminal = start.result.status !== 'running';
    if (!terminal) {
      if (!processId) continue;
      const related = ordered.filter(
        (item) => item.sequence > start.sequence && item.input?.processId === processId
      );
      for (const item of related) {
        if (!item.result) break;
        lifecycle.push(item);
        if (item.result.status !== 'running') {
          terminal = true;
          break;
        }
      }
    }
    if (terminal && (!processId || !active.has(processId))) lifecycles.push(lifecycle);
  }
  return lifecycles;
}
