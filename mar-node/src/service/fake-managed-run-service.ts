import type { NodeEnvelope } from '@myagentroam/protocol';
import type { FakeRunnerStep } from '../fake-runner.js';
import type { RunnerExecutionStatus } from '../runner/contracts.js';
import type { NodeRuntimeState } from '../runtime-state.js';
import type { FakeTestRunner } from '../runner/fake-test-runner.js';
import type { RunnerRegistry } from '../runner/runner-registry.js';

interface FakeManagedRunServiceOptions {
  readonly runner: FakeTestRunner;
  readonly script: (input: unknown, runId: string) => readonly FakeRunnerStep[];
  readonly runners: RunnerRegistry;
  readonly runtime: NodeRuntimeState;
  readonly emitRun: (
    runId: string,
    type: string,
    payload: unknown,
    status?: RunnerExecutionStatus
  ) => void;
  readonly publishApproval: (input: {
    readonly runId: string;
    readonly approvalId: string;
    readonly payload: unknown;
    readonly expiresAt: number;
  }) => void;
  readonly disconnect: () => void;
}

/** Test-only managed Run adapter; production Runner paths never depend on it. */
export class FakeManagedRunService {
  constructor(private readonly options: FakeManagedRunServiceOptions) {}

  start(envelope: NodeEnvelope): void {
    const payload = envelope.payload as {
      runId?: unknown;
      sessionId?: unknown;
      workspaceId?: unknown;
      runner?: unknown;
      input?: unknown;
      cwd?: unknown;
    };
    if (typeof payload.runId !== 'string' || this.options.runtime.isExecutionActive(payload.runId))
      return;
    const runId = payload.runId;
    const cwd = typeof payload.cwd === 'string' ? payload.cwd : undefined;
    if (
      typeof payload.sessionId === 'string' &&
      typeof payload.runner === 'string' &&
      cwd !== undefined
    ) {
      const runner = this.options.runners.product(payload.runner);
      if (runner === undefined) return;
      this.options.runtime.adoptRun({
        runId,
        sessionId: payload.sessionId,
        ...(typeof payload.workspaceId === 'string' ? { workspaceId: payload.workspaceId } : {}),
        runner: runner.name,
        cwd
      });
    }
    this.options.runtime.executionAccepted(runId);
    void this.options.runner
      .start(runId, this.options.script(payload.input, runId), {
        event: (eventType, eventPayload, status) => {
          this.options.emitRun(runId, eventType, eventPayload, status);
        },
        approval: (approvalId, approvalPayload, expiresAt) => {
          try {
            this.options.runtime.createApproval({
              runId,
              approvalId,
              payload: approvalPayload,
              expiresAt
            });
          } catch {
            return;
          }
          this.options.publishApproval({
            runId,
            approvalId,
            payload: approvalPayload,
            expiresAt
          });
        },
        disconnect: this.options.disconnect
      })
      .finally(() => this.options.runtime.executionReleased(runId));
  }
}
