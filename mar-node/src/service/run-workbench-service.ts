import type { NodeOperationHandler } from '../application/node-operation-contracts.js';
import { modelResourceReadInputSchema, runImageReadInputSchema } from '@myagentroam/protocol';
import { nodeOperationData } from '../connection/node-operation-data.js';
import type { NodeAgentRun } from '../runtime-model.js';
import type { NodeRuntimeState } from '../runtime-state.js';
import { isTerminalRunStatus } from '../session/runtime/type-guards.js';
import { isPlainRecord } from '../util/records.js';
import { isHostedConversationImageRunId } from '../runner/mar-agent/generated-images.js';
import { assertRunOwner, assertSessionControlOwner } from './run-ownership-policy.js';
import { imagePreviews } from './image-preview-service.js';

export interface RunWorkbenchServiceOptions {
  readonly runtime: NodeRuntimeState;
  readonly readImage: (runId: string, selector: number | string) => Promise<unknown | undefined>;
  readonly readModelResource?: (
    input: import('@myagentroam/protocol').ModelResourceReadInput
  ) => Promise<unknown | undefined>;
  readonly respondUserInput: (
    runId: string,
    requestId: string,
    answers: Record<string, unknown>
  ) => void;
  readonly pauseQueue: (sessionId: string) => void;
  readonly runInterrupted: (sessionId: string) => Readonly<Record<string, unknown>> | undefined;
  readonly emitRun: (
    runId: string,
    eventType: string,
    payload: unknown,
    status?: 'INTERRUPTED'
  ) => void;
  readonly control: (operation: string, payload: Record<string, unknown>) => void;
  readonly markInterrupted: (runId: string) => void;
}

export class RunWorkbenchService {
  constructor(private readonly options: RunWorkbenchServiceOptions) {}

  operations(): Readonly<Record<string, NodeOperationHandler>> {
    return {
      'run.get': (data) => this.get(record(data)),
      'run.image.read': (data) => this.image(record(data)),
      'model.resource.read': (data) => this.modelResource(record(data)),
      'run.user-input.respond': (data) => this.respond(record(data)),
      'session.interrupt': (data) => this.interruptSession(record(data)),
      'run.cancel': (data) => this.cancelOrInterrupt('run.cancel', record(data)),
      'run.interrupt': (data) => this.cancelOrInterrupt('run.interrupt', record(data)),
      'run.approval.decide': (data) => this.decideApproval(record(data))
    };
  }

  /** Resolve and stop the current Session execution inside its existing control owner. */
  stopAgentSession(input: {
    readonly sessionId: string;
    readonly requestUserId?: number;
  }): unknown {
    const run = this.options.runtime.activeSessionRun(input.sessionId);
    if (run !== undefined)
      return this.cancelOrInterrupt('run.cancel', {
        runId: run.id,
        ...(input.requestUserId === undefined ? {} : { __requestUserId: input.requestUserId })
      });
    if (!this.options.runtime.getAgentSession(input.sessionId))
      throw new Error('SESSION_NOT_FOUND');
    assertSessionControlOwner(this.options.runtime, input.sessionId, input.requestUserId);
    let result: Readonly<Record<string, unknown>> | undefined;
    try {
      this.options.pauseQueue(input.sessionId);
    } finally {
      result = this.options.runInterrupted(input.sessionId);
    }
    return { status: 'IDLE', ...result };
  }

  private async modelResource(input: Record<string, unknown>): Promise<unknown> {
    const parsed = modelResourceReadInputSchema.safeParse(nodeOperationData(input));
    if (!parsed.success) throw new Error('RUN_IMAGE_INVALID');
    const image = await this.options.readModelResource?.(parsed.data);
    if (image === undefined) throw new Error('RUN_IMAGE_NOT_FOUND');
    return { image };
  }

  private get(input: Record<string, unknown>): { run: NodeAgentRun } {
    return { run: this.requireRun(input.runId) };
  }

  private async image(input: Record<string, unknown>): Promise<unknown> {
    const parsed = runImageReadInputSchema.safeParse(nodeOperationData(input));
    if (!parsed.success) throw new Error('RUN_IMAGE_INVALID');
    const reference = parsed.data;
    if (isHostedConversationImageRunId(reference.runId)) throw new Error('RUN_IMAGE_INVALID');
    const native = reference.runId.startsWith('native-history:');
    if (native !== 'imageRef' in reference) throw new Error('RUN_IMAGE_INVALID');
    const selector = 'imageRef' in reference ? reference.imageRef : reference.imageIndex;
    const image = await this.options.readImage(reference.runId, selector);
    if (image === undefined) throw new Error('RUN_IMAGE_NOT_FOUND');
    return {
      image:
        reference.preview === undefined
          ? image
          : await imagePreviews.fromImage(image, reference.preview)
    };
  }

  private respond(input: Record<string, unknown>): unknown {
    if (
      typeof input.runId !== 'string' ||
      typeof input.requestId !== 'string' ||
      !isPlainRecord(input.answers)
    )
      throw new Error('USER_INPUT_INVALID');
    const run = this.requireOwnedRun(input.runId, input.__requestUserId);
    // Direct control-envelope runs use the public Run ID as their Runner
    // handle. Continuous Workbench runs resolve to their current Execution.
    const executionId = this.options.runtime.currentExecutionId(run.id) ?? run.id;
    this.options.respondUserInput(executionId, input.requestId, input.answers);
    return { accepted: true };
  }

  private interruptSession(input: Record<string, unknown>): unknown {
    if (typeof input.sessionId !== 'string') throw new Error('SESSION_NOT_FOUND');
    const session = this.options.runtime.getAgentSession(input.sessionId);
    if (session === undefined) throw new Error('SESSION_NOT_FOUND');
    const run = this.options.runtime.activeSessionRun(session.id);
    if (run === undefined || isTerminalRunStatus(run.status)) throw new Error('RUN_NOT_FOUND');
    const result = this.cancelOrInterrupt('run.interrupt', {
      runId: run.id,
      __requestUserId: input.__requestUserId
    });
    return result;
  }

  private cancelOrInterrupt(
    operation: 'run.cancel' | 'run.interrupt',
    input: Record<string, unknown>
  ): unknown {
    const run = this.requireOwnedRun(input.runId, input.__requestUserId);
    if (input.workspaceId !== undefined && run.workspaceId !== input.workspaceId)
      throw new Error('RUN_NOT_FOUND');
    const next = this.options.runtime.transitionRun(run.id, 'CANCELLING');
    const executionId = this.options.runtime.currentExecutionId(run.id);
    const turn = this.options.runtime.conversationTurnForRun(run.id);
    const controlRunId =
      executionId ?? (turn === undefined || turn.userItemId === null ? run.id : undefined);
    let interruptionResult: Readonly<Record<string, unknown>> | undefined;
    try {
      this.options.pauseQueue(run.sessionId);
      if (controlRunId === undefined) {
        this.options.markInterrupted(run.id);
        this.options.emitRun(
          run.id,
          'run.interrupted',
          { code: 'USER_INTERRUPTED' },
          'INTERRUPTED'
        );
      } else {
        this.options.markInterrupted(controlRunId);
        this.options.control(operation, { runId: controlRunId });
      }
    } finally {
      interruptionResult = this.options.runInterrupted(run.sessionId);
    }
    return { run: next, ...interruptionResult };
  }

  private decideApproval(input: Record<string, unknown>): unknown {
    if (
      typeof input.runId !== 'string' ||
      typeof input.approvalId !== 'string' ||
      (input.decision !== 'APPROVED' && input.decision !== 'REJECTED')
    )
      throw new Error('APPROVAL_DECISION_INVALID');
    const current = this.options.runtime.getApproval(input.approvalId);
    if (current === undefined || this.options.runtime.canonicalRunId(current.runId) !== input.runId)
      throw new Error('APPROVAL_NOT_FOUND');
    const run = this.options.runtime.activeSessionRun(this.requireRun(input.runId).sessionId);
    if (
      run?.id !== input.runId ||
      (current.runId !== run.id &&
        current.runId !== this.options.runtime.currentExecutionId(run.id))
    )
      throw new Error('APPROVAL_NOT_FOUND');
    this.assertRunOwner(current.runId, input.__requestUserId);
    const approval = this.options.runtime.decideApproval(input.approvalId, input.decision);
    this.options.emitRun(approval.runId, 'approval.decided', {
      approvalId: approval.id,
      decision: input.decision
    });
    this.options.control('run.approval.decision', {
      runId: approval.runId,
      approvalId: approval.id,
      decision: input.decision
    });
    return { approval };
  }

  private requireRun(runId: unknown): NodeAgentRun {
    if (typeof runId !== 'string') throw new Error('RUN_NOT_FOUND');
    const run = this.options.runtime.getRun(runId);
    if (run === undefined) throw new Error('RUN_NOT_FOUND');
    return run;
  }

  private requireOwnedRun(runId: unknown, requestUserId: unknown): NodeAgentRun {
    const run = this.requireRun(runId);
    assertRunOwner(run, requestUserId);
    return run;
  }

  private assertRunOwner(runId: string, requestUserId: unknown): void {
    assertRunOwner(this.requireRun(runId), requestUserId);
  }
}

function record(value: unknown): Record<string, unknown> {
  return isPlainRecord(value) ? value : {};
}
