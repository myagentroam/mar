import { executionActivity } from './support/execution-activity.js';
import { describe, expect, it, vi } from 'vitest';
import {
  AgentError,
  type ToolApprovalRequest,
  type ToolApprovalDecision
} from '../../../mar-agent/src/index.js';
import { MarAgentManagedRunController } from '../../src/runner/mar-agent/managed-run-controller.js';
import { MarAgentRunner } from '../../src/runner/mar-agent-runner.js';

function fixture() {
  const host = {
    ...executionActivity(),
    adopt: vi.fn(),
    promote: vi.fn(),
    syncTitle: vi.fn(),
    emit: vi.fn(),
    emitItem: vi.fn(),
    run: vi.fn(),
    commandState: vi.fn(),
    setCommandState: vi.fn(),
    clearCommandState: vi.fn(),
    commandStates: vi.fn(() => []),
    webSearch: vi.fn(),
    createApproval: vi.fn(),
    publishApproval: vi.fn()
  };
  const controller = new MarAgentManagedRunController(new MarAgentRunner(), host);
  const internal = controller as unknown as {
    requestApproval(
      runId: string,
      request: ToolApprovalRequest,
      signal: AbortSignal
    ): Promise<ToolApprovalDecision>;
    clearInteractions(runId: string): void;
  };
  const request: ToolApprovalRequest = {
    approvalId: 'mar-agent:approval',
    expiresAt: Date.now() + 600_000,
    reason: 'Confirm the selected target.',
    input: { command: 'echo fixture', cwd: '/fixture' },
    source: { sessionId: 'sdk-session', executionId: 'execution', callId: 'call', toolName: 'exec' }
  };
  return { controller, internal, host, request };
}

describe('MAR online approval adapter', () => {
  it.each(['APPROVED', 'REJECTED'] as const)(
    'uses the native response channel for %s',
    async (decision) => {
      const f = fixture();
      const waiting = f.internal.requestApproval('run', f.request, new AbortController().signal);
      expect(f.host.createApproval).toHaveBeenCalledExactlyOnceWith({
        runId: 'run',
        approvalId: f.request.approvalId,
        expiresAt: f.request.expiresAt,
        payload: {
          toolName: 'exec',
          input: f.request.input,
          reason: f.request.reason,
          source: f.request.source
        }
      });
      expect(f.host.publishApproval).toHaveBeenCalledExactlyOnceWith(
        f.host.createApproval.mock.calls[0]![0]
      );
      expect(
        f.controller.decideApproval({ runId: 'other', approvalId: f.request.approvalId, decision })
      ).toBe(false);
      expect(
        f.controller.decideApproval({ runId: 'run', approvalId: f.request.approvalId, decision })
      ).toBe(true);
      await expect(waiting).resolves.toBe(decision);
      expect(
        f.controller.decideApproval({ runId: 'run', approvalId: f.request.approvalId, decision })
      ).toBe(false);
      await f.controller.dispose();
    }
  );

  it('keeps simultaneous requests independent', async () => {
    const f = fixture();
    const first = f.internal.requestApproval('run', f.request, new AbortController().signal);
    const second = f.internal.requestApproval(
      'run',
      { ...f.request, approvalId: 'second' },
      new AbortController().signal
    );
    f.controller.decideApproval({ runId: 'run', approvalId: 'second', decision: 'REJECTED' });
    await expect(second).resolves.toBe('REJECTED');
    f.controller.decideApproval({
      runId: 'run',
      approvalId: f.request.approvalId,
      decision: 'APPROVED'
    });
    await expect(first).resolves.toBe('APPROVED');
    await f.controller.dispose();
  });

  it.each(['MAR_AGENT_APPROVAL_EXPIRED', 'MAR_AGENT_EXECUTION_CANCELLED'])(
    'removes the callback on %s and ignores a late allow',
    async (code) => {
      const f = fixture();
      const cancellation = new AbortController();
      const waiting = f.internal.requestApproval('run', f.request, cancellation.signal);
      const checked = expect(waiting).rejects.toMatchObject({ code });
      cancellation.abort(new AgentError(code, 'Approval is no longer available.'));
      await checked;
      expect(f.host.emit).toHaveBeenCalledTimes(code === 'MAR_AGENT_APPROVAL_EXPIRED' ? 1 : 0);
      expect(
        f.controller.decideApproval({
          runId: 'run',
          approvalId: f.request.approvalId,
          decision: 'APPROVED'
        })
      ).toBe(false);
      await f.controller.dispose();
    }
  );

  it('supports existing Node policies that decide while publishing', async () => {
    const f = fixture();
    f.host.publishApproval.mockImplementation(() => {
      f.controller.decideApproval({
        runId: 'run',
        approvalId: f.request.approvalId,
        decision: 'APPROVED'
      });
    });
    await expect(
      f.internal.requestApproval('run', f.request, new AbortController().signal)
    ).resolves.toBe('APPROVED');
    await f.controller.dispose();
  });

  it('releases all pending approvals when their execution finishes', async () => {
    const f = fixture();
    const waiting = f.internal.requestApproval('run', f.request, new AbortController().signal);
    f.internal.clearInteractions('run');
    await expect(waiting).resolves.toBe('REJECTED');
    expect(
      f.controller.decideApproval({
        runId: 'run',
        approvalId: f.request.approvalId,
        decision: 'APPROVED'
      })
    ).toBe(false);
    await f.controller.dispose();
  });
});
