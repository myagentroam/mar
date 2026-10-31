import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';
import { parseComposerTags } from '@myagentroam/protocol';
import type { NodeRuntimeState } from '../runtime-state.js';
import type { ContinuousRunCoordinator } from './continuous-run-coordinator.js';
import type { GoalRuntime } from './goal-runtime.js';
import { safeErrorCode } from '../util/safe-error.js';
import {
  captureRestartExecution,
  openRestartState,
  restartExecutionSchema,
  sealRestartState,
  type RestartExecution
} from './restart-execution-state.js';

const identifier = z.string().min(1).max(512);
const count = z.number().int().nonnegative();
const attachmentSchema = z
  .object({
    name: z.string().min(1).max(512),
    mime: z.string().min(1).max(128),
    dataBase64: z.string().min(1).max(7_000_000)
  })
  .strict();
const messageSchema = z
  .object({
    id: identifier,
    clientMessageId: identifier,
    content: z.string().max(1_000_000),
    attachments: z.array(attachmentSchema).max(5),
    execution: restartExecutionSchema.optional(),
    immediate: z.boolean(),
    suppressNotifications: z.boolean().optional()
  })
  .strict();
const goalSchema = z
  .object({
    goal: z
      .object({
        id: identifier,
        sessionId: identifier,
        objective: z.string().min(1).max(20_000),
        inputTags: z.string().default(''),
        startedAt: count,
        revisionStartedAt: count,
        revision: z.number().int().positive(),
        status: z.enum(['active', 'completed', 'blocked']),
        turns: count,
        retryRequired: z.boolean(),
        retryStartedAtTurn: count.nullable(),
        consecutiveNoProgressTurns: count
      })
      .strict(),
    executionFailures: count
  })
  .strict();
const sessionSchema = z
  .object({
    session: z
      .object({
        id: identifier,
        workspaceId: identifier,
        cwd: z.string().min(1),
        modelId: z.string().nullable(),
        effort: z.string().nullable(),
        access: z.string().nullable()
      })
      .strict(),
    execution: restartExecutionSchema.optional(),
    paused: z.boolean(),
    plan: z.boolean(),
    awaitingGoal: z.boolean(),
    suppressNotifications: z.boolean().optional(),
    goal: goalSchema.optional(),
    current: messageSchema.optional(),
    queue: z.array(messageSchema)
  })
  .strict();
export const plannedRestartSchema = z
  .object({
    schemaVersion: z.literal(3),
    id: identifier,
    nodeId: identifier,
    serverUrl: z.string().min(1),
    createdAt: count,
    sessions: z.array(sessionSchema)
  })
  .strict();
export type RestartMessage = z.infer<typeof messageSchema>;
export type RestartSession = z.infer<typeof sessionSchema>;
export type PlannedRestart = z.infer<typeof plannedRestartSchema>;
interface CaptureDiagnostic {
  readonly reason: 'session_not_ready' | 'goal_schema_invalid' | 'snapshot_schema_invalid';
  readonly issues?: readonly { readonly code: string; readonly path: string }[];
  readonly issuesTruncated?: boolean;
}

// Only this producer can associate log-safe metadata with an original failure.
const captureDiagnostics = new WeakMap<Error, CaptureDiagnostic>();
const captureFields = new Set([
  ...Object.keys(plannedRestartSchema.shape),
  ...Object.keys(sessionSchema.shape),
  ...Object.keys(sessionSchema.shape.session.shape),
  ...Object.keys(goalSchema.shape),
  ...Object.keys(goalSchema.shape.goal.shape),
  ...Object.keys(messageSchema.shape),
  ...Object.keys(attachmentSchema.shape)
]);

export function plannedRestartCaptureDiagnostic(error: unknown): CaptureDiagnostic | undefined {
  return error instanceof Error ? captureDiagnostics.get(error) : undefined;
}

function parseCapture<T extends z.ZodType>(
  schema: T,
  input: unknown,
  reason: 'goal_schema_invalid' | 'snapshot_schema_invalid'
): z.output<T> {
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  captureDiagnostics.set(result.error, {
    reason,
    issues: result.error.issues.slice(0, 12).map((issue) => ({
      code: issue.code,
      // Only schema-owned fields and array offsets, never unknown keys or input values.
      path: issue.path
        .slice(0, 8)
        .map((part) =>
          typeof part === 'number'
            ? `[${part}]`
            : captureFields.has(String(part))
              ? String(part)
              : '*'
        )
        .join('.')
        .replaceAll('.[', '[')
        .slice(0, 160)
    })),
    issuesTruncated: result.error.issues.length > 12
  });
  throw result.error;
}

export const RESTART_NOTICE =
  'The previous execution was interrupted by a system restart. Check the session history and current workspace, then continue unfinished work. Verify completed or uncertain actions before proceeding; do not blindly repeat actions with external side effects.';

interface Options {
  readonly directory: () => string;
  readonly identity: () => { nodeId: string; serverUrl: string };
  readonly credential: () => string;
  readonly runtime: NodeRuntimeState;
  readonly coordinator: Pick<ContinuousRunCoordinator<unknown>, 'pending' | 'isImmediate'>;
  readonly goals: GoalRuntime;
  readonly goalExecution?: (sessionId: string) => RestartExecution | undefined;
  readonly executionContext?: (
    sessionId: string,
    context: RestartExecution['executionContext'],
    selectedModelId?: string | null
  ) => RestartExecution['executionContext'];
  readonly commandActive: (sessionId: string, command: string) => boolean;
  readonly inputState: (
    session: RestartSession,
    message: RestartMessage
  ) => Promise<'missing' | 'completed' | 'interrupted' | 'paused'>;
  readonly restore: (session: RestartSession, handoffId: string) => Promise<void>;
  readonly diagnose: (code: string, sessionId?: string, errorCode?: string) => void;
}

/** A one-shot orderly-shutdown handoff, not a crash-recovery journal. */
export class PlannedRestartHandoff {
  private pending: PlannedRestart | undefined;
  private readonly blocked = new Set<string>();
  private recovery: Promise<void> | undefined;

  constructor(private readonly options: Options) {}

  private path(processing = false): string {
    return resolve(
      this.options.directory(),
      processing ? 'planned-restart-handoff.processing.json' : 'planned-restart-handoff.json'
    );
  }

  blocks(sessionId: string): boolean {
    return this.blocked.has(sessionId);
  }

  blocksOperation(operation: string, input: Record<string, unknown>): boolean {
    const sessionId =
      typeof input.sessionId === 'string'
        ? input.sessionId
        : typeof input.queueItemId === 'string'
          ? this.options.runtime.getQueueItem(input.queueItemId)?.sessionId
          : undefined;
    if (sessionId === undefined || !this.blocks(sessionId)) return false;
    return (
      operation === 'session.message' ||
      operation.startsWith('session.command.') ||
      (operation.startsWith('workspace.queue.') && operation !== 'workspace.queue.get') ||
      [
        'session.remove',
        'session.rewind',
        'session.rollback',
        'session.config.update',
        'session.metadata.update'
      ].includes(operation)
    );
  }

  async load(): Promise<void> {
    this.recovery = undefined;
    this.pending = undefined;
    this.blocked.clear();
    let text: string;
    try {
      text = await readFile(this.path(), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        this.options.diagnose('RESTART_HANDOFF_READ_FAILED');
      return;
    }
    try {
      const value = plannedRestartSchema.parse(openRestartState(text, this.options.credential()));
      const identity = this.options.identity();
      if (value.nodeId !== identity.nodeId || value.serverUrl !== identity.serverUrl)
        throw new Error('RESTART_HANDOFF_IDENTITY_MISMATCH');
      this.pending = value;
      for (const entry of value.sessions) this.blocked.add(entry.session.id);
    } catch {
      this.options.diagnose('RESTART_HANDOFF_INVALID');
    }
  }

  capture(): PlannedRestart {
    const { runtime, coordinator, goals } = this.options;
    const sessions: RestartSession[] = [...(this.pending?.sessions ?? [])];
    for (const session of runtime.listAgentSessions()) {
      if (session.runner !== 'mar-agent' || this.blocks(session.id)) continue;
      const queue = runtime.sessionQueue(session.id);
      const active = runtime.activeSessionRun(session.id);
      const goalItemId = queue.itemIds.find((id) => coordinator.pending(id)?.goal !== undefined);
      const notificationSource =
        active ?? (goalItemId === undefined ? undefined : runtime.getQueueItem(goalItemId));
      const goal = goals.restartState(session.id);
      const awaitingGoal = goal === undefined && this.options.commandActive(session.id, 'goal');
      const currentId = active && (runtime.currentExecutionId(active.id) ?? active.id);
      const pending = currentId === undefined ? undefined : coordinator.pending(currentId);
      const checkpoint = (execution: RestartExecution | undefined, activeInput = false) => {
        if (execution !== undefined && activeInput)
          execution.configuration = {
            modelId: session.modelId,
            effort: session.effort,
            access: session.access
          };
        if (execution !== undefined && this.options.executionContext !== undefined)
          execution.executionContext = this.options.executionContext(
            session.id,
            execution.executionContext,
            execution.configuration?.modelId
          );
        return execution;
      };
      const toMessage = (
        id: string,
        clientMessageId: string,
        content: string,
        attachments: RestartMessage['attachments'],
        originatingUser: number | undefined,
        suppressNotifications: boolean | undefined,
        activeInput = false
      ): RestartMessage => ({
        id,
        clientMessageId,
        content: withoutAttachmentTags(content),
        attachments,
        execution: checkpoint(
          captureRestartExecution(coordinator.pending(id), originatingUser),
          activeInput
        ),
        immediate: coordinator.isImmediate(id),
        ...(suppressNotifications === true ? { suppressNotifications: true } : {})
      });
      const items = queue.itemIds.flatMap((id) => {
        if (coordinator.pending(id)?.goal !== undefined) return [];
        const item = runtime.getQueueItem(id)!;
        const original = coordinator.pending(id)?.restartMessage;
        return [
          toMessage(
            id,
            item.clientMessageId,
            original?.content ?? item.content,
            [...(original?.attachments ?? item.attachments)],
            item.initiatedByUserId,
            item.suppressNotifications
          )
        ];
      });
      const current =
        pending?.restartMessage === undefined || pending.goal !== undefined
          ? undefined
          : toMessage(
              currentId!,
              pending.clientMessageId ?? active!.clientMessageId,
              pending.restartMessage.content,
              [...pending.restartMessage.attachments],
              pending.restartMessage.initiatedByUserId ?? active?.initiatedByUserId,
              active?.suppressNotifications,
              true
            );
      if (current === undefined && items.length === 0 && goal === undefined && !awaitingGoal)
        continue;
      if (session.externalSessionId === null) {
        const error = Object.assign(new Error('RESTART_SESSION_NOT_READY'), {
          code: 'RESTART_SESSION_NOT_READY'
        });
        captureDiagnostics.set(error, { reason: 'session_not_ready' });
        throw error;
      }
      const goalItem = goalItemId === undefined ? undefined : runtime.getQueueItem(goalItemId);
      const execution =
        captureRestartExecution(
          goalItem === undefined ? undefined : coordinator.pending(goalItem.id),
          goalItem?.initiatedByUserId
        ) ??
        captureRestartExecution(pending, active?.initiatedByUserId) ??
        this.options.goalExecution?.(session.id);
      sessions.push({
        session: {
          id: session.externalSessionId,
          workspaceId: session.workspaceId,
          cwd: session.cwd,
          modelId: session.modelId,
          effort: session.effort,
          access: session.access
        },
        ...(execution === undefined
          ? {}
          : { execution: checkpoint(execution, goalItem === undefined) }),
        paused: queue.paused,
        plan: this.options.commandActive(session.id, 'plan'),
        awaitingGoal,
        ...(notificationSource?.suppressNotifications === true
          ? { suppressNotifications: true }
          : {}),
        ...(goal === undefined
          ? {}
          : { goal: parseCapture(goalSchema, goal, 'goal_schema_invalid') }),
        ...(current === undefined ? {} : { current }),
        queue: items
      });
    }
    return parseCapture(
      plannedRestartSchema,
      {
        schemaVersion: 3,
        id: randomUUID(),
        ...this.options.identity(),
        createdAt: Date.now(),
        sessions
      },
      'snapshot_schema_invalid'
    );
  }

  async publish(snapshot: PlannedRestart): Promise<void> {
    for (const entry of snapshot.sessions) {
      const goal = this.options.goals.restartState(entry.session.id);
      if (goal !== undefined) entry.goal = goalSchema.parse(goal);
      if (entry.current !== undefined) {
        const state = await this.options.inputState(entry, entry.current);
        if (state === 'completed') delete entry.current;
        if (state === 'paused') entry.paused = true;
      }
    }
    if (snapshot.sessions.length === 0) return;
    const temporary = `${this.path()}.${process.pid}.tmp`;
    await mkdir(this.options.directory(), { recursive: true, mode: 0o700 });
    try {
      await writeFile(
        temporary,
        sealRestartState(plannedRestartSchema.parse(snapshot), this.options.credential()),
        {
          mode: 0o600
        }
      );
      await rename(temporary, this.path());
    } finally {
      await rm(temporary, { force: true });
    }
  }

  recover(): Promise<void> {
    if (this.pending === undefined) return this.recovery ?? Promise.resolve();
    return (this.recovery ??= this.consume());
  }

  async wait(): Promise<void> {
    await this.recovery;
  }

  private async consume(): Promise<void> {
    const value = this.pending!;
    this.pending = undefined;
    let failed = false;
    try {
      await rename(this.path(), this.path(true));
      for (const entry of value.sessions) {
        try {
          await this.options.restore(entry, value.id);
        } catch (error) {
          failed = true;
          const errorCode = safeErrorCode(error, 'RESTART_SESSION_RESTORE_FAILED');
          this.options.diagnose(
            'RESTART_SESSION_RESTORE_FAILED',
            entry.session.id,
            errorCode === 'RESTART_SESSION_RESTORE_FAILED' ? undefined : errorCode
          );
        } finally {
          this.blocked.delete(entry.session.id);
        }
      }
      if (!failed) await rm(this.path(true), { force: true });
    } catch {
      this.options.diagnose('RESTART_HANDOFF_CONSUME_FAILED');
    } finally {
      this.blocked.clear();
    }
  }
}

function withoutAttachmentTags(content: string): string {
  return parseComposerTags(content)
    .map((part) =>
      part.kind === 'text' ? part.text : part.kind === 'mar_attachments' ? '' : part.raw
    )
    .join('')
    .trim();
}
