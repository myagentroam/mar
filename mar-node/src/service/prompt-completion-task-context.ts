import { createHash } from 'node:crypto';
import { composerVisibleText } from '@myagentroam/protocol';
import type { CompletionContextProjection } from './prompt-completion-context.js';

export type PredictionPhase =
  'RUNNING' | 'COMPLETED' | 'WAITING_INPUT' | 'WAITING_APPROVAL' | 'FAILED' | 'IDLE' | 'UNKNOWN';
export interface PredictionTaskState {
  readonly runStatus?: string;
  readonly goal:
    | {
        readonly id: string;
        readonly objective: string;
        readonly status: string;
        readonly revision: number;
      }
    | null
    | 'UNKNOWN';
  readonly queue:
    | {
        readonly version: number;
        readonly paused: boolean;
        readonly items: readonly { readonly queueItemId: string; readonly content: string }[];
      }
    | 'UNKNOWN';
}

/** Uses canonical task state only; pending work is the existing Goal/Queue/waiting projection. */
export function withPredictionTaskState(
  context: CompletionContextProjection,
  task: PredictionTaskState
): CompletionContextProjection {
  const snapshot = JSON.parse(context.executionSnapshot) as {
    status: string;
    waiting: { kind: string; status: string }[];
  };
  const runStatus = task.runStatus ?? snapshot.status;
  const waiting = snapshot.waiting;
  const phase: PredictionPhase = waiting.some((item) => item.kind === 'approval')
    ? 'WAITING_APPROVAL'
    : waiting.some((item) => item.kind === 'user_input_request')
      ? 'WAITING_INPUT'
      : ['RUNNING', 'STARTING', 'QUEUED', 'IN_PROGRESS'].includes(runStatus)
        ? 'RUNNING'
        : ['COMPLETED', 'SUCCEEDED'].includes(runStatus)
          ? 'COMPLETED'
          : runStatus === 'FAILED'
            ? 'FAILED'
            : runStatus === 'IDLE'
              ? 'IDLE'
              : 'UNKNOWN';
  const goal =
    typeof task.goal === 'object' && task.goal !== null
      ? { ...task.goal, objective: composerVisibleText(task.goal.objective).slice(0, 2048) }
      : task.goal;
  const queue =
    task.queue === 'UNKNOWN'
      ? 'UNKNOWN'
      : {
          version: task.queue.version,
          paused: task.queue.paused,
          total: task.queue.items.length,
          items: task.queue.items.slice(0, 8).map((item) => ({
            id: item.queueItemId,
            text: composerVisibleText(item.content).slice(0, 768),
            status: 'QUEUED_NOT_EXECUTED'
          }))
        };
  const tasks = { phase, goal, queue, pendingWork: { source: 'GOAL_QUEUE_WAITING', waiting } };
  return {
    ...context,
    identity: {
      ...context.identity,
      contextVersion: createHash('sha256')
        .update(JSON.stringify([context.identity.contextVersion, tasks]))
        .digest('hex')
    },
    executionSnapshot: JSON.stringify({
      ...snapshot,
      status: task.runStatus ?? snapshot.status,
      ...tasks
    })
  };
}
