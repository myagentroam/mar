import { describe, expect, it, vi } from 'vitest';
import type {
  RemoteDesktopRelayNodeCommand,
  RemoteDesktopRelayServerMessage
} from '@myagentroam/protocol';
import { RemoteDesktopAdmission } from '../../src/remote-desktop-admission.js';
import { RemoteDesktopRelayCoordinator } from '../../src/remote-desktop-relay-coordinator.js';

const identity = { userId: 1, sessionHash: 'session-a', workbenchConnectionId: 'page-12345678' };
const request = {
  type: 'desktop.relay.prepare',
  requestId: 'request-123',
  nodeId: 'node-a',
  nodeGeneration: 'generation-a',
  desktopGeneration: 'desktop-a',
  topologyRevision: 1,
  mode: 'CONTROL'
} as const;

function fixture() {
  const admission = new RemoteDesktopAdmission();
  const pairing = {
    prepare: vi.fn(() => ({
      browserTicket: 'browser-ticket',
      nodeTicket: 'node-ticket',
      deadline: 16000
    })),
    opened: vi.fn(() => true),
    cancel: vi.fn()
  };
  const authorize = vi.fn(async () => true);
  const preflight = vi.fn(async () => 4);
  const sendNode = vi.fn((_node: string, _message: RemoteDesktopRelayNodeCommand) => true);
  const sendBrowser = vi.fn(
    async (_id: string, _message: RemoteDesktopRelayServerMessage) => 'delivered' as const
  );
  let now = 1000;
  const coordinator = new RemoteDesktopRelayCoordinator({
    admission,
    pairing,
    authorize,
    preflight,
    sendNode,
    sendBrowser,
    now: () => now
  });
  return {
    admission,
    pairing,
    authorize,
    preflight,
    sendNode,
    sendBrowser,
    coordinator,
    advance: (ms: number) => (now += ms)
  };
}

describe('Remote Desktop relay coordinator', () => {
  it('retires a disconnected page after lease expiry without reporting settlement', async () => {
    vi.useFakeTimers();
    const f = fixture();
    try {
      await f.coordinator.handleBrowser(identity, request);
      const command = f.sendNode.mock.calls[0]![1];
      if (command.type !== 'desktop.relay.prepare') throw new Error('unexpected command');
      f.coordinator.revokeConnection(identity.workbenchConnectionId);
      f.advance(30_000);
      await vi.advanceTimersByTimeAsync(1000);
      expect(f.admission.get(command.attachmentId)).toBeUndefined();
      const sent = f.sendNode.mock.calls.length;
      await vi.advanceTimersByTimeAsync(2000);
      expect(f.sendNode.mock.calls.length).toBe(sent);
      expect(f.sendBrowser.mock.calls.map((call) => call[1])).not.toContainEqual(
        expect.objectContaining({ type: 'desktop.relay.settled' })
      );
    } finally {
      f.coordinator.close();
      vi.useRealTimers();
    }
  });
  it('correlates a cleanup-confirmed Node rejection before prepared with the request', async () => {
    const f = fixture();
    await f.coordinator.handleBrowser(identity, request);
    const command = f.sendNode.mock.calls[0]![1];
    if (command.type !== 'desktop.relay.prepare') throw new Error('unexpected command');
    await f.coordinator.onNodeEvent('node-a', 'generation-a', {
      type: 'desktop.relay.closed',
      attachmentId: command.attachmentId,
      nodeGeneration: 'generation-a',
      code: 'DESKTOP_TOPOLOGY_UNAVAILABLE'
    });
    expect(f.sendBrowser).toHaveBeenCalledWith(
      identity.workbenchConnectionId,
      expect.objectContaining({
        type: 'desktop.relay.error',
        requestId: request.requestId,
        code: 'DESKTOP_TOPOLOGY_UNAVAILABLE',
        settled: true
      })
    );
    f.coordinator.close();
  });
  it('only marks pre-dispatch errors as settled when submission is certain', async () => {
    const safe = fixture();
    safe.authorize.mockResolvedValueOnce(false);
    await safe.coordinator.handleBrowser(identity, request);
    expect(safe.sendBrowser).toHaveBeenCalledWith(
      identity.workbenchConnectionId,
      expect.objectContaining({ type: 'desktop.relay.error', settled: true })
    );
    safe.coordinator.close();
    const unknown = fixture();
    unknown.sendNode.mockImplementationOnce(() => {
      throw new Error('ambiguous');
    });
    await unknown.coordinator.handleBrowser(identity, request);
    const error = unknown.sendBrowser.mock.calls
      .map((call) => call[1])
      .find((message) => message.type === 'desktop.relay.error');
    expect(error).toBeDefined();
    expect(error).not.toHaveProperty('settled');
    unknown.coordinator.close();
  });
  it('binds separate tickets and retains its shared slot until the original Node confirms cleanup', async () => {
    const f = fixture();
    try {
      await f.coordinator.handleBrowser(identity, request);
      const command = f.sendNode.mock.calls[0]![1];
      if (command.type !== 'desktop.relay.prepare') throw new Error('unexpected command');
      expect(command.ticket).toBe('node-ticket');
      const attachmentId = command.attachmentId;
      await f.coordinator.onNodeEvent('node-a', 'generation-a', {
        type: 'desktop.relay.ready',
        nodeGeneration: 'generation-a',
        attachmentId,
        phase: 'PREPARED'
      });
      expect(f.sendBrowser).toHaveBeenCalledWith(
        identity.workbenchConnectionId,
        expect.objectContaining({
          type: 'desktop.relay.prepared',
          attachmentId,
          ticket: 'browser-ticket',
          grant: command.grant
        })
      );
      await f.coordinator.handleBrowser(identity, { type: 'desktop.ready', attachmentId });
      await Promise.all(
        (['OPEN', 'ATTACHED', 'ACTIVE'] as const).map((phase) =>
          f.coordinator.onNodeEvent('node-a', 'generation-a', {
            type: 'desktop.relay.ready',
            nodeGeneration: 'generation-a',
            attachmentId,
            phase
          })
        )
      );
      expect(f.admission.get(attachmentId)?.phase).toBe('ACTIVE');
      expect(f.pairing.opened).toHaveBeenCalledWith(attachmentId);
      await f.coordinator.handleBrowser(identity, { type: 'desktop.relay.cancel', attachmentId });
      expect(f.admission.get(attachmentId)?.phase).toBe('CLOSING');
      expect(f.sendBrowser).toHaveBeenCalledWith(identity.workbenchConnectionId, {
        type: 'desktop.relay.closed',
        attachmentId,
        code: 'DESKTOP_CANCELLED'
      });
      expect(
        f.sendBrowser.mock.calls.some(([, message]) => message.type === 'desktop.relay.settled')
      ).toBe(false);
      await f.coordinator.onNodeEvent('node-a', 'generation-new', {
        type: 'desktop.relay.closed',
        nodeGeneration: 'generation-new',
        attachmentId,
        code: 'DESKTOP_CANCELLED'
      });
      expect(f.admission.countNode('node-a')).toBe(1);
      expect(
        f.sendBrowser.mock.calls.some(([, message]) => message.type === 'desktop.relay.settled')
      ).toBe(false);
      await f.coordinator.onNodeEvent('node-a', 'generation-a', {
        type: 'desktop.relay.closed',
        nodeGeneration: 'generation-a',
        attachmentId,
        code: 'DESKTOP_CANCELLED'
      });
      expect(f.admission.countNode('node-a')).toBe(0);
      expect(f.sendBrowser).toHaveBeenCalledWith(identity.workbenchConnectionId, {
        type: 'desktop.relay.settled',
        attachmentId,
        code: 'DESKTOP_CANCELLED'
      });
    } finally {
      f.coordinator.close();
    }
  });

  it('does not revive preflight after page revocation', async () => {
    const f = fixture();
    let resume!: (value: number) => void;
    f.preflight.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resume = resolve;
        })
    );
    try {
      const pending = f.coordinator.handleBrowser(identity, request);
      await vi.waitFor(() => expect(resume).toBeDefined());
      f.coordinator.revokeConnection(identity.workbenchConnectionId);
      resume(4);
      await pending;
      expect(f.sendNode).not.toHaveBeenCalled();
      expect(f.admission.countNode('node-a')).toBe(0);
    } finally {
      f.coordinator.close();
    }
  });

  it.each(['connection', 'session', 'user', 'node'] as const)(
    'does not cancel another owner’s pending prepare when an unrelated %s is revoked',
    async (scope) => {
      const f = fixture();
      let resume!: (value: number) => void;
      f.preflight.mockImplementationOnce(() => new Promise((resolve) => (resume = resolve)));
      try {
        const pending = f.coordinator.handleBrowser(identity, request);
        await vi.waitFor(() => expect(resume).toBeDefined());
        if (scope === 'connection') f.coordinator.revokeConnection('other-page');
        if (scope === 'session') f.coordinator.revokeSession('other-session');
        if (scope === 'user') f.coordinator.revokeUser(2);
        if (scope === 'node') f.coordinator.revokeNode('other-node');
        resume(4);
        await pending;
        expect(f.sendNode).toHaveBeenCalledOnce();
        expect(f.sendNode).toHaveBeenCalledWith(
          'node-a',
          expect.objectContaining({ type: 'desktop.relay.prepare' })
        );
        expect(f.sendBrowser).not.toHaveBeenCalled();
      } finally {
        f.coordinator.close();
      }
    }
  );

  it('keeps a second window’s pending prepare when the first window disconnects', async () => {
    const f = fixture();
    const second = { ...identity, workbenchConnectionId: 'page-87654321' };
    let resume!: (value: number) => void;
    try {
      await f.coordinator.handleBrowser(identity, request);
      const firstCommand = f.sendNode.mock.calls[0]![1];
      if (firstCommand.type !== 'desktop.relay.prepare') throw new Error('unexpected command');
      f.preflight.mockImplementationOnce(() => new Promise((resolve) => (resume = resolve)));
      const pending = f.coordinator.handleBrowser(second, { ...request, requestId: 'second' });
      await vi.waitFor(() => expect(resume).toBeDefined());
      f.coordinator.revokeConnection(identity.workbenchConnectionId);
      resume(4);
      await pending;
      expect(f.sendNode).toHaveBeenCalledWith(
        'node-a',
        expect.objectContaining({
          type: 'desktop.relay.cancel',
          attachmentId: firstCommand.attachmentId
        })
      );
      const commands = f.sendNode.mock.calls.map(([, message]) => message);
      const prepares = commands.filter((message) => message.type === 'desktop.relay.prepare');
      expect(prepares).toHaveLength(2);
      expect(prepares[1]!.attachmentId).not.toBe(firstCommand.attachmentId);
      expect(f.admission.get(prepares[1]!.attachmentId)?.phase).toBe('RESERVED');
    } finally {
      f.coordinator.close();
    }
  });

  it.each(['connection', 'session', 'user', 'node', 'generation', 'shutdown'] as const)(
    'does not dispatch a pending prepare after its own %s is revoked',
    async (scope) => {
      const f = fixture();
      let resume!: (value: number) => void;
      f.preflight.mockImplementationOnce(() => new Promise((resolve) => (resume = resolve)));
      try {
        const pending = f.coordinator.handleBrowser(identity, request);
        await vi.waitFor(() => expect(resume).toBeDefined());
        if (scope === 'connection') f.coordinator.revokeConnection(identity.workbenchConnectionId);
        if (scope === 'session') f.coordinator.revokeSession(identity.sessionHash);
        if (scope === 'user') f.coordinator.revokeUser(identity.userId);
        if (scope === 'node') f.coordinator.revokeNode(request.nodeId);
        if (scope === 'generation') f.coordinator.retireOtherGenerations(request.nodeId, 'new');
        if (scope === 'shutdown') f.coordinator.close();
        resume(4);
        await pending;
        expect(f.sendNode).not.toHaveBeenCalled();
        expect(f.admission.countNode(request.nodeId)).toBe(0);
      } finally {
        f.coordinator.close();
      }
    }
  );

  it('does not dispatch when its user is revoked during the initial authorization', async () => {
    const f = fixture();
    let resume!: (value: boolean) => void;
    f.authorize.mockImplementationOnce(() => new Promise((resolve) => (resume = resolve)));
    try {
      const pending = f.coordinator.handleBrowser(identity, request);
      await vi.waitFor(() => expect(resume).toBeDefined());
      f.coordinator.revokeUser(identity.userId);
      resume(true);
      await pending;
      expect(f.sendNode).not.toHaveBeenCalled();
      expect(f.admission.countNode(request.nodeId)).toBe(0);
    } finally {
      f.coordinator.close();
    }
  });

  it('cancels the pair and retries cleanup after disconnect until generation replacement', async () => {
    vi.useFakeTimers();
    const f = fixture();
    try {
      await f.coordinator.handleBrowser(identity, request);
      const command = f.sendNode.mock.calls[0]![1];
      if (command.type !== 'desktop.relay.prepare') throw new Error('unexpected command');
      f.coordinator.revokeConnection(identity.workbenchConnectionId);
      expect(f.pairing.cancel).toHaveBeenCalledWith(command.attachmentId);
      f.coordinator.retireOtherGenerations('node-a', 'generation-a');
      const sent = f.sendNode.mock.calls.length;
      await vi.advanceTimersByTimeAsync(1000);
      expect(f.sendNode.mock.calls.length).toBe(sent + 1);
      expect(f.admission.get(command.attachmentId)?.phase).toBe('CLOSING');
      f.coordinator.retireOtherGenerations('node-a', 'generation-b');
      expect(f.admission.get(command.attachmentId)).toBeUndefined();
      const retired = f.sendNode.mock.calls.length;
      await vi.advanceTimersByTimeAsync(2000);
      expect(f.sendNode.mock.calls.length).toBe(retired);
      expect(
        f.sendBrowser.mock.calls.some(([, message]) => message.type === 'desktop.relay.settled')
      ).toBe(false);
    } finally {
      f.coordinator.close();
      vi.useRealTimers();
    }
  });

  it('fences and cancels when pairing already closed admission', async () => {
    const f = fixture();
    try {
      await f.coordinator.handleBrowser(identity, request);
      const command = f.sendNode.mock.calls[0]![1];
      if (command.type !== 'desktop.relay.prepare') throw new Error('unexpected command');
      f.admission.beginClose(command.attachmentId);
      f.coordinator.pairingClosed(command.attachmentId);
      expect(f.sendNode).toHaveBeenLastCalledWith('node-a', {
        type: 'desktop.relay.cancel',
        attachmentId: command.attachmentId,
        code: 'DESKTOP_TRANSPORT_ERROR'
      });
      expect(f.admission.countNode('node-a')).toBe(1);
    } finally {
      f.coordinator.close();
    }
  });

  it('releases a definitely unsubmitted reservation without accepting pairing callbacks', async () => {
    const f = fixture();
    f.sendNode.mockReturnValue(false);
    try {
      await f.coordinator.handleBrowser(identity, request);
      expect(f.admission.countNode('node-a')).toBe(0);
      expect(f.pairing.cancel).toHaveBeenCalledOnce();
      expect(f.sendBrowser).toHaveBeenCalledWith(
        identity.workbenchConnectionId,
        expect.objectContaining({ type: 'desktop.relay.error', code: 'NODE_OFFLINE' })
      );
    } finally {
      f.coordinator.close();
    }
  });

  it('rejects a foreign page and retries cancellation until the owning generation settles', async () => {
    vi.useFakeTimers();
    const f = fixture();
    try {
      await f.coordinator.handleBrowser(identity, request);
      const command = f.sendNode.mock.calls[0]![1];
      if (command.type !== 'desktop.relay.prepare') throw new Error('unexpected command');
      await f.coordinator.handleBrowser(
        { ...identity, sessionHash: 'other' },
        {
          type: 'desktop.relay.cancel',
          attachmentId: command.attachmentId
        }
      );
      expect(f.admission.get(command.attachmentId)?.phase).toBe('RESERVED');
      await f.coordinator.handleBrowser(identity, {
        type: 'desktop.relay.cancel',
        attachmentId: command.attachmentId
      });
      const count = f.sendNode.mock.calls.length;
      await vi.advanceTimersByTimeAsync(1000);
      expect(f.sendNode).toHaveBeenCalledTimes(count + 1);
      expect(f.sendNode).toHaveBeenLastCalledWith('node-a', {
        type: 'desktop.relay.cancel',
        attachmentId: command.attachmentId,
        code: 'DESKTOP_CANCELLED'
      });
    } finally {
      f.coordinator.close();
      vi.useRealTimers();
    }
  });

  it('cleans up a reservation if pairing preparation throws before submission', async () => {
    const f = fixture();
    f.pairing.prepare.mockImplementation(() => {
      throw new Error('internal detail');
    });
    try {
      await f.coordinator.handleBrowser(identity, request);
      expect(f.admission.countNode('node-a')).toBe(0);
      expect(f.sendNode).not.toHaveBeenCalled();
      expect(f.sendBrowser).toHaveBeenCalledWith(
        identity.workbenchConnectionId,
        expect.objectContaining({
          type: 'desktop.relay.error',
          code: 'DESKTOP_CONTROL_UNAVAILABLE'
        })
      );
    } finally {
      f.coordinator.close();
    }
  });
});
