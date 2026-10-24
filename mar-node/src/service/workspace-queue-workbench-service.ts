import type { NodeOperationHandler } from '../connector/node-operation-router.js';
import type { RegisteredRunnerName } from '../runner/abstract-runner.js';
import { steerComposerMessage } from '@myagentroam/protocol';
import type { NodeRuntimeState } from '../runtime-state.js';
import type { NodeAgentSession } from '../database.js';
import { isPlainRecord, withNonImageAttachmentPrompt } from '../util/node-operation-parsers.js';
import type { ContinuousRunCoordinator } from './continuous-run-coordinator.js';
import { assertQueueItemOwner, assertSessionControlOwner } from './run-ownership-policy.js';
import { nodeLog } from '../operational.js';
import { safeErrorCode } from '../util/safe-error.js';

export interface WorkspaceQueueWorkbenchServiceOptions {
  readonly runtime: NodeRuntimeState;
  readonly resolve: (
    sessionId: string,
    registeredOnly?: boolean
  ) => Promise<NodeAgentSession | undefined>;
  readonly coordinator: ContinuousRunCoordinator<unknown>;
  readonly emit: (workspaceId: string, sessionId: string) => void;
  readonly prepareInput: (
    runner: RegisteredRunnerName,
    input: string,
    collaborationMode: 'default' | 'plan'
  ) => string;
}

export class WorkspaceQueueWorkbenchService {
  constructor(private readonly options: WorkspaceQueueWorkbenchServiceOptions) {}

  operations(): Readonly<Record<string, NodeOperationHandler>> {
    return {
      'workspace.queue.get': (data) => this.get(record(data)),
      'workspace.queue.resume': (data) => this.pauseOrResume('resume', record(data)),
      'workspace.queue.pause': (data) => this.pauseOrResume('pause', record(data)),
      'workspace.queue.reorder': (data) => this.reorder(record(data)),
      'workspace.queue.message.update': (data) => this.update(record(data)),
      'workspace.queue.message.delete': (data) => this.delete(record(data)),
      'workspace.queue.message.execute': (data) => this.execute(record(data))
    };
  }

  pauseSessionQueue(sessionId: string): void {
    const session = this.options.runtime.getAgentSession(sessionId);
    if (session === undefined) throw new Error('SESSION_NOT_FOUND');
    this.options.runtime.pauseSessionQueue(session.id);
    this.options.emit(session.workspaceId, session.id);
  }

  resumeAfterCommandRun(sessionId: string): void {
    const session = this.options.runtime.getAgentSession(sessionId);
    if (session === undefined) throw new Error('SESSION_NOT_FOUND');
    if (!this.options.runtime.sessionQueue(session.id).paused) return;
    void this.options.coordinator
      .resume(session.id)
      .then(() => this.options.emit(session.workspaceId, session.id))
      .catch((error) =>
        nodeLog('queue.resume.failed', {
          sessionId,
          code: safeErrorCode(error, 'QUEUE_RESUME_FAILED')
        })
      );
  }

  present(workspaceId: string, sessionId: string): unknown {
    const session = this.options.runtime.getAgentSession(sessionId);
    if (session?.workspaceId !== workspaceId) throw new Error('SESSION_NOT_FOUND');
    return this.snapshot(sessionId);
  }

  snapshot(sessionId: string): unknown {
    const queue = this.options.runtime.sessionQueue(sessionId);
    return {
      version: queue.version,
      paused: queue.paused,
      items: queue.itemIds.flatMap((itemId) => {
        const item = this.publicQueueItem(itemId);
        if (item === undefined) return [];
        const session = this.options.runtime.getAgentSession(item.sessionId);
        return [
          {
            queueItemId: item.id,
            sessionId: item.sessionId,
            workspaceId: item.workspaceId,
            runner: item.runner,
            clientMessageId: item.clientMessageId,
            sessionTitle: session?.customTitle ?? session?.runnerTitle ?? 'Untitled session',
            content: item.content,
            createdAt: item.createdAt
          }
        ];
      })
    };
  }

  private async get(input: Record<string, unknown>): Promise<unknown> {
    if (typeof input.workspaceId !== 'string' || typeof input.sessionId !== 'string')
      throw new Error('WORKSPACE_NOT_FOUND');
    const session =
      this.options.runtime.getAgentSession(input.sessionId) ??
      (await this.options.resolve(input.sessionId, input.registeredOnly === true));
    if (session?.workspaceId !== input.workspaceId) throw new Error('SESSION_NOT_FOUND');
    return {
      queue: this.snapshot(session.id)
    };
  }

  private async pauseOrResume(
    mode: 'pause' | 'resume',
    input: Record<string, unknown>
  ): Promise<unknown> {
    const session = this.requireSession(input);
    assertSessionControlOwner(this.options.runtime, session.id, input.__requestUserId);
    if (mode === 'resume') await this.options.coordinator.resume(session.id);
    else this.options.runtime.pauseSessionQueue(session.id);
    this.options.emit(session.workspaceId, session.id);
    return {
      queue: this.present(session.workspaceId, session.id),
      auditReceipt: this.auditReceipt(
        session.id,
        undefined,
        mode === 'pause' ? 'PAUSE_QUEUE' : 'RESUME_QUEUE'
      )
    };
  }

  private reorder(input: Record<string, unknown>): unknown {
    if (
      !Number.isInteger(input.expectedVersion) ||
      !Array.isArray(input.queueItemIds) ||
      input.queueItemIds.some((id) => typeof id !== 'string')
    )
      throw new Error('QUEUE_INVALID');
    const session = this.requireSession(input);
    assertSessionControlOwner(this.options.runtime, session.id, input.__requestUserId);
    const current = this.options.runtime.sessionQueue(session.id);
    const publicItemIds = new Set(
      current.itemIds.filter((itemId) => this.publicQueueItem(itemId) !== undefined)
    );
    const reorderedIds = input.queueItemIds as string[];
    if (
      reorderedIds.length !== publicItemIds.size ||
      new Set(reorderedIds).size !== reorderedIds.length ||
      reorderedIds.some((itemId) => !publicItemIds.has(itemId))
    )
      throw new Error('QUEUE_VERSION_CONFLICT');
    let index = 0;
    // Reorder only public slots, leaving internal continuations in place.
    this.options.runtime.reorderSessionQueue(
      session.id,
      input.expectedVersion as number,
      current.itemIds.map((itemId) => (publicItemIds.has(itemId) ? reorderedIds[index++]! : itemId))
    );
    this.options.emit(session.workspaceId, session.id);
    return {
      queue: this.present(session.workspaceId, session.id),
      auditReceipt: this.auditReceipt(session.id, undefined, 'REORDER_QUEUE')
    };
  }

  private update(input: Record<string, unknown>): unknown {
    if (
      typeof input.queueItemId !== 'string' ||
      typeof input.content !== 'string' ||
      input.content.trim().length === 0
    )
      throw new Error('QUEUE_INVALID');
    const item = this.requireItem(input.queueItemId, input.workspaceId);
    assertQueueItemOwner(item, input.__requestUserId);
    const content = input.content.trim();
    const prepared = this.options.coordinator.pending(item.id);
    const prepareRunnerInput = (steering: boolean) =>
      prepared === undefined
        ? undefined
        : this.options.prepareInput(
            prepared.executionContext.runner,
            withNonImageAttachmentPrompt(
              steering ? steerComposerMessage(content) : content,
              prepared.attachmentPaths,
              prepared.attachmentFiles
            ),
            prepared.collaborationMode
          );
    const runnerInput = prepareRunnerInput(prepared?.steering === true);
    this.options.runtime.updateQueueItem(item.id, content);
    if (runnerInput !== undefined)
      this.options.coordinator.updatePreparedInput(
        item.id,
        runnerInput,
        prepared?.prepareSteerInput === undefined ? undefined : () => prepareRunnerInput(true)!
      );
    this.options.emit(item.workspaceId, item.sessionId);
    return {
      queue: this.present(item.workspaceId, item.sessionId),
      auditReceipt: this.auditReceipt(item.sessionId, item.id, 'EDIT_QUEUE')
    };
  }

  private delete(input: Record<string, unknown>): unknown {
    if (typeof input.queueItemId !== 'string') throw new Error('QUEUE_INVALID');
    const item = this.requireItem(input.queueItemId, input.workspaceId);
    assertQueueItemOwner(item, input.__requestUserId);
    this.options.coordinator.deleteQueueItem(item.id);
    return {
      queue: this.present(item.workspaceId, item.sessionId),
      auditReceipt: this.auditReceipt(item.sessionId, item.id, 'DELETE_QUEUE')
    };
  }

  private async execute(input: Record<string, unknown>): Promise<unknown> {
    if (typeof input.queueItemId !== 'string') throw new Error('QUEUE_INVALID');
    const item = this.requireItem(input.queueItemId, input.workspaceId);
    assertQueueItemOwner(item, input.__requestUserId);
    const result = await this.options.coordinator.executeQueueItem(input.queueItemId);
    if (isPlainRecord(result))
      return {
        ...result,
        auditReceipt: this.auditReceipt(item.sessionId, item.id, 'EXECUTE_QUEUE')
      };
    return {
      result,
      auditReceipt: this.auditReceipt(item.sessionId, item.id, 'EXECUTE_QUEUE')
    };
  }

  private requireSession(input: Record<string, unknown>) {
    if (typeof input.workspaceId !== 'string' || typeof input.sessionId !== 'string')
      throw new Error('WORKSPACE_NOT_FOUND');
    const session = this.options.runtime.getAgentSession(input.sessionId);
    if (session?.workspaceId !== input.workspaceId) throw new Error('SESSION_NOT_FOUND');
    return session;
  }

  private publicQueueItem(itemId: string) {
    const item = this.options.runtime.getQueueItem(itemId);
    return item?.goalInput === true ? undefined : item;
  }

  queuedCount(sessionId: string): number {
    return this.options.runtime
      .sessionQueue(sessionId)
      .itemIds.filter((id) => this.publicQueueItem(id) !== undefined).length;
  }

  private requireItem(itemId: string, workspaceId?: unknown) {
    const item = this.publicQueueItem(itemId);
    if (item === undefined) throw new Error('QUEUE_ITEM_INVALID');
    if (typeof workspaceId !== 'string' || item.workspaceId !== workspaceId)
      throw new Error('QUEUE_ITEM_INVALID');
    return item;
  }

  private auditReceipt(
    sessionId: string,
    queueItemId: string | undefined,
    inputMode:
      | 'EDIT_QUEUE'
      | 'DELETE_QUEUE'
      | 'REORDER_QUEUE'
      | 'EXECUTE_QUEUE'
      | 'PAUSE_QUEUE'
      | 'RESUME_QUEUE'
  ) {
    const session = this.options.runtime.getAgentSession(sessionId);
    if (session === undefined) throw new Error('SESSION_NOT_FOUND');
    return {
      sessionId,
      conversationTitle: session.customTitle ?? session.runnerTitle ?? 'Untitled session',
      ...(queueItemId === undefined ? {} : { queueItemId }),
      inputMode
    };
  }
}

function record(value: unknown): Record<string, unknown> {
  return isPlainRecord(value) ? value : {};
}
