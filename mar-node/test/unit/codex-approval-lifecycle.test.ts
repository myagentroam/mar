vi.mock('ws', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ws')>();
  const { mockedWebSocket } = await import('./support/control-socket.js');
  return { ...actual, default: mockedWebSocket(actual.default) };
});
import { connectTestSocket } from './support/control-socket.js';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { CodexAppServerClient } from '../../src/runner/codex/codex-app-server.js';
import { NodeConnector } from '../../src/connector.js';
import { NodeDatabase } from '../../src/database.js';
import type { NodeRuntimeState } from '../../src/runtime-state.js';
import { marctlSessionProgress } from '../../src/service/session-recent-activity.js';
import type { CodexRunner } from '../../src/runner/codex-runner.js';
import {
  captureSocket,
  capabilities,
  codexProfileClientFactory
} from './support/codex-connector.js';

const approvalTimeoutMs = 10 * 60_000;

type CapturedMessage = { type: string; payload: Record<string, unknown> };
type CapturedRunEvent = { runId: string; eventType: string; payload: unknown };

function approvalEventIds(events: readonly CapturedRunEvent[], eventType: string): string[] {
  return events.flatMap(({ eventType: candidateType, payload }) => {
    const eventPayload = payload;
    if (
      candidateType !== eventType ||
      eventPayload === null ||
      typeof eventPayload !== 'object' ||
      Array.isArray(eventPayload) ||
      typeof (eventPayload as Record<string, unknown>).approvalId !== 'string'
    )
      return [];
    return [(eventPayload as Record<string, unknown>).approvalId as string];
  });
}

async function createFixture() {
  const workspacePath = await mkdtemp(join(tmpdir(), 'mar-codex-approval-lifecycle-'));
  const database = new NodeDatabase(':memory:', randomUUID());
  const workspace = database.saveWorkspace({
    id: 'workspace-codex-approval',
    path: workspacePath,
    kind: 'DIRECTORY',
    gitSummary: null
  });
  const sent: CapturedMessage[] = [];
  const runEvents: CapturedRunEvent[] = [];
  const expiredEventsAtNativeResponse: string[][] = [];
  const nativeRespond = vi.fn(() => {
    expiredEventsAtNativeResponse.push(approvalEventIds(runEvents, 'approval.expired'));
  });
  const client = {
    onNotification: () => () => undefined,
    start: async () => undefined,
    stop: vi.fn(),
    configureEnvironment: () => undefined,
    respond: nativeRespond
  } as unknown as CodexAppServerClient;
  const connector = new NodeConnector({
    config: {
      serverUrl: 'http://127.0.0.1',
      allowedRoots: [workspacePath],
      dataDirectory: join(workspacePath, 'node-data')
    },
    reconnect: false,
    capabilities: capabilities(),
    codexProfileClientFactory,
    database,
    codexClient: client
  });
  const internals = connector as unknown as {
    runtime: NodeRuntimeState;
    codexClient: CodexRunner;
    codexRunController: {
      handleNotification(notification: {
        method: string;
        requestId?: string | number;
        params: unknown;
      }): void;
    };
    executeNodeOperation(operation: string, data: unknown): Promise<unknown>;
  };
  const appendRunEvent = internals.runtime.appendRunEvent.bind(internals.runtime);
  internals.runtime.appendRunEvent = (input) => {
    runEvents.push({ runId: input.runId, eventType: input.eventType, payload: input.payload });
    return appendRunEvent(input);
  };
  connectTestSocket(connector, captureSocket(sent, connector));
  const session = internals.runtime.createAgentSession({
    workspaceId: workspace.id,
    runner: 'codex',
    cwd: workspacePath
  });
  const { run } = internals.runtime.createMessageRun({
    sessionId: session.id,
    clientMessageId: randomUUID(),
    content: 'Review the pending approval.',
    initiatedByUserId: 41
  });
  const execution = internals.runtime.createExecution(run.id);
  internals.runtime.transitionRun(run.id, 'RUNNING');
  const threadId = `thread-${randomUUID()}`;
  internals.codexClient.execution.runs.set(execution.id, {
    sessionId: session.id,
    threadId,
    turnId: execution.turnId,
    cwd: workspacePath
  });

  if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(0);

  return {
    connector,
    runtime: internals.runtime,
    codex: internals.codexClient,
    executeNodeOperation: (operation: string, data: unknown) =>
      internals.executeNodeOperation(operation, data),
    sessionId: session.id,
    runId: run.id,
    executionId: execution.id,
    turnId: execution.turnId,
    threadId,
    sent,
    runEvents,
    nativeRespond,
    expiredEventsAtNativeResponse,
    requestApproval(method: string, requestId: string, params: Record<string, unknown> = {}) {
      internals.codexRunController.handleNotification({
        method,
        requestId,
        params: { ...params, threadId, turnId: execution.turnId }
      });
      return `codex:${execution.id}:${requestId}`;
    },
    async dispose() {
      await connector.stop();
      await rm(workspacePath, { recursive: true, force: true });
    }
  };
}

describe('Codex approval lifecycle', () => {
  it('projects both approval methods distinctly without exposing native params', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-26T00:00:00.000Z'));
    const fixture = await createFixture();
    try {
      const commandApprovalId = fixture.requestApproval(
        'item/commandExecution/requestApproval',
        'command-request',
        { command: 'DO_NOT_EXPOSE_COMMAND_ARGUMENTS', cwd: '/private/command/path' }
      );
      const fileApprovalId = fixture.requestApproval(
        'item/fileChange/requestApproval',
        'file-request',
        { filePath: 'DO_NOT_EXPOSE_FILE_PATH', patch: 'DO_NOT_EXPOSE_FILE_PATCH' }
      );

      const progress = marctlSessionProgress(fixture.runtime, fixture.sessionId);
      expect(progress.pendingApprovals).toEqual([
        {
          runId: fixture.runId,
          approvalId: commandApprovalId,
          name: 'command_execution',
          summary: 'Command execution requires approval.',
          truncated: false
        },
        {
          runId: fixture.runId,
          approvalId: fileApprovalId,
          name: 'file_change',
          summary: 'File changes require approval.',
          truncated: false
        }
      ]);
      expect(progress.runId).toBe(fixture.runId);
      expect(progress).not.toHaveProperty('executionId');
      const projected = JSON.stringify(progress);
      expect(projected).not.toContain('DO_NOT_EXPOSE_COMMAND_ARGUMENTS');
      expect(projected).not.toContain('/private/command/path');
      expect(projected).not.toContain('DO_NOT_EXPOSE_FILE_PATH');
      expect(projected).not.toContain('DO_NOT_EXPOSE_FILE_PATCH');
    } finally {
      await fixture.dispose();
      vi.useRealTimers();
    }
  });

  it('expires approval state before rejecting the native request and refuses a late decision', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-26T00:00:00.000Z'));
    const fixture = await createFixture();
    try {
      const approvalId = fixture.requestApproval(
        'item/commandExecution/requestApproval',
        'expiring-request',
        { command: 'DO_NOT_EXPOSE_ON_EXPIRY' }
      );

      await vi.advanceTimersByTimeAsync(approvalTimeoutMs);

      expect(approvalEventIds(fixture.runEvents, 'approval.expired')).toContain(approvalId);
      expect(fixture.expiredEventsAtNativeResponse[0]).toContain(approvalId);
      expect(fixture.nativeRespond).toHaveBeenCalledWith('expiring-request', {
        decision: 'decline'
      });
      expect(fixture.runtime.getApproval(approvalId)?.status).toBe('EXPIRED');
      expect(marctlSessionProgress(fixture.runtime, fixture.sessionId).pendingApprovals).toEqual(
        []
      );
      await expect(
        fixture.executeNodeOperation('run.approval.decide', {
          runId: fixture.runId,
          approvalId,
          decision: 'APPROVED',
          __requestUserId: 41
        })
      ).rejects.toThrow('APPROVAL_EXPIRED');
      expect(fixture.nativeRespond).toHaveBeenCalledTimes(1);
    } finally {
      await fixture.dispose();
      vi.useRealTimers();
    }
  });

  it('clears the native mapping and expiry timer after explicit approval', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-26T00:00:00.000Z'));
    const fixture = await createFixture();
    try {
      const timerCount = vi.getTimerCount();
      const approvalId = fixture.requestApproval(
        'item/commandExecution/requestApproval',
        'approved-request'
      );
      expect(fixture.codex.execution.approvals.has(approvalId)).toBe(true);
      expect(vi.getTimerCount()).toBe(timerCount + 1);

      await fixture.executeNodeOperation('run.approval.decide', {
        runId: fixture.runId,
        approvalId,
        decision: 'APPROVED',
        __requestUserId: 41
      });

      expect(fixture.runtime.getApproval(approvalId)?.status).toBe('APPROVED');
      expect(fixture.codex.execution.approvals.has(approvalId)).toBe(false);
      expect(fixture.nativeRespond).toHaveBeenCalledExactlyOnceWith('approved-request', {
        decision: 'accept'
      });
      expect(vi.getTimerCount()).toBe(timerCount);

      await vi.advanceTimersByTimeAsync(approvalTimeoutMs + 60_000);

      expect(approvalEventIds(fixture.runEvents, 'approval.expired')).not.toContain(approvalId);
      expect(fixture.nativeRespond).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(timerCount);
    } finally {
      await fixture.dispose();
      vi.useRealTimers();
    }
  });

  it('re-arms expiry when the system clock moves backward', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-26T00:00:00.000Z'));
    const fixture = await createFixture();
    try {
      const timerCount = vi.getTimerCount();
      const approvalId = fixture.requestApproval(
        'item/fileChange/requestApproval',
        'clock-adjusted-request',
        { filePath: 'DO_NOT_EXPOSE_AFTER_CLOCK_CHANGE' }
      );
      expect(vi.getTimerCount()).toBe(timerCount + 1);

      vi.setSystemTime(new Date(Date.now() - 60_000));
      await vi.advanceTimersByTimeAsync(approvalTimeoutMs);

      expect(fixture.runtime.getApproval(approvalId)?.status).toBe('PENDING');
      expect(approvalEventIds(fixture.runEvents, 'approval.expired')).not.toContain(approvalId);
      expect(vi.getTimerCount()).toBe(timerCount + 1);

      await vi.advanceTimersByTimeAsync(60_000);
      expect(approvalEventIds(fixture.runEvents, 'approval.expired')).toContain(approvalId);
      expect(marctlSessionProgress(fixture.runtime, fixture.sessionId).pendingApprovals).toEqual(
        []
      );
    } finally {
      await fixture.dispose();
      vi.useRealTimers();
    }
  });

  it('clears native mappings and expiry timers on Execution release and Node stop', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-26T00:00:00.000Z'));
    const fixture = await createFixture();
    try {
      const timerCount = vi.getTimerCount();
      const releasedApprovalId = fixture.requestApproval(
        'item/commandExecution/requestApproval',
        'released-request'
      );
      expect(fixture.codex.execution.approvals.has(releasedApprovalId)).toBe(true);
      expect(vi.getTimerCount()).toBe(timerCount + 1);

      fixture.codex.releaseEnvironment(fixture.executionId);

      expect(fixture.codex.execution.approvals.has(releasedApprovalId)).toBe(false);
      expect(vi.getTimerCount()).toBe(timerCount);

      const stoppedApprovalId = fixture.requestApproval(
        'item/fileChange/requestApproval',
        'stopped-request'
      );
      expect(fixture.codex.execution.approvals.has(stoppedApprovalId)).toBe(true);
      expect(vi.getTimerCount()).toBe(timerCount + 1);

      await fixture.connector.stop();

      expect(fixture.codex.execution.approvals.size).toBe(0);
      expect(vi.getTimerCount()).toBeLessThanOrEqual(timerCount);
      await vi.advanceTimersByTimeAsync(approvalTimeoutMs);
      expect(fixture.nativeRespond).not.toHaveBeenCalled();
      expect(approvalEventIds(fixture.runEvents, 'approval.expired')).not.toContain(
        stoppedApprovalId
      );
    } finally {
      await fixture.dispose();
      vi.useRealTimers();
    }
  });
});
