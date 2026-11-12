import { describe, expect, it, vi } from 'vitest';
import type {
  RemoteDesktopDirectNodeCommand,
  RemoteDesktopDirectServerMessage
} from '@myagentroam/protocol';
import { RemoteDesktopAdmission } from '../../src/remote-desktop-admission.js';
import { RemoteDesktopDirectCoordinator } from '../../src/remote-desktop-direct-coordinator.js';
import { NodeRequestError } from '../../src/node-request-error.js';

const identity = { userId: 1, sessionHash: 'session-a', workbenchConnectionId: 'page-12345678' };
const prepare = {
  type: 'desktop.direct.prepare',
  requestId: 'request-123',
  nodeId: 'node-a',
  nodeGeneration: 'generation-a',
  transportSessionId: 'transport-a',
  desktopGeneration: 'desktop-a',
  topologyRevision: 1,
  mode: 'CONTROL'
} as const;
const fingerprints = { browserFingerprint: 'browser', nodeFingerprint: 'node' };

function fixture() {
  const admission = new RemoteDesktopAdmission();
  const authorize = vi.fn(async () => true);
  const preflight = vi.fn(async () => 4);
  const transport = vi.fn(() => fingerprints);
  const sendNode = vi.fn((_node: string, _message: RemoteDesktopDirectNodeCommand) => true);
  const sendBrowser = vi.fn(
    async (_id: string, _message: RemoteDesktopDirectServerMessage) => 'delivered' as const
  );
  let now = 1_000;
  const coordinator = new RemoteDesktopDirectCoordinator({
    admission,
    authorize,
    preflight,
    transport: { authorizedTransport: transport },
    sendNode,
    sendBrowser,
    now: () => now
  });
  return {
    admission,
    authorize,
    preflight,
    transport,
    sendNode,
    sendBrowser,
    coordinator,
    advance: (ms: number) => (now += ms)
  };
}

describe('Remote Desktop Direct coordinator', () => {
  it('retires a disconnected page after lease expiry without reporting settlement', async () => {
    vi.useFakeTimers();
    const f = fixture();
    try {
      await f.coordinator.handleBrowser(identity, prepare);
      const command = f.sendNode.mock.calls[0]![1];
      if (command.type !== 'desktop.direct.prepare') throw new Error('unexpected command');
      f.coordinator.revokeConnection(identity.workbenchConnectionId);
      f.advance(30_000);
      await vi.advanceTimersByTimeAsync(1000);
      expect(f.admission.get(command.attachmentId)).toBeUndefined();
      const sent = f.sendNode.mock.calls.length;
      await vi.advanceTimersByTimeAsync(2000);
      expect(f.sendNode.mock.calls.length).toBe(sent);
      expect(f.sendBrowser.mock.calls.map((call) => call[1])).not.toContainEqual(
        expect.objectContaining({ type: 'desktop.direct.settled' })
      );
    } finally {
      f.coordinator.close();
      vi.useRealTimers();
    }
  });
  it('correlates a cleanup-confirmed Node rejection before prepared with the request', async () => {
    const f = fixture();
    await f.coordinator.handleBrowser(identity, prepare);
    const command = f.sendNode.mock.calls[0]![1];
    if (command.type !== 'desktop.direct.prepare') throw new Error('unexpected command');
    await f.coordinator.onNodeEvent('node-a', 'generation-a', {
      type: 'desktop.direct.closed',
      attachmentId: command.attachmentId,
      nodeGeneration: 'generation-a',
      code: 'DESKTOP_TOPOLOGY_UNAVAILABLE'
    });
    expect(f.sendBrowser).toHaveBeenCalledWith(
      identity.workbenchConnectionId,
      expect.objectContaining({
        type: 'desktop.direct.error',
        requestId: prepare.requestId,
        code: 'DESKTOP_TOPOLOGY_UNAVAILABLE',
        settled: true
      })
    );
    f.coordinator.close();
  });
  it('distinguishes a definite preflight rejection from ambiguous Node submission', async () => {
    const safe = fixture();
    safe.authorize.mockResolvedValueOnce(false);
    await safe.coordinator.handleBrowser(identity, prepare);
    expect(safe.sendBrowser).toHaveBeenCalledWith(
      identity.workbenchConnectionId,
      expect.objectContaining({ type: 'desktop.direct.error', settled: true })
    );
    safe.coordinator.close();
    const unknown = fixture();
    unknown.sendNode.mockImplementationOnce(() => {
      throw new Error('ambiguous');
    });
    await unknown.coordinator.handleBrowser(identity, prepare);
    const error = unknown.sendBrowser.mock.calls
      .map((call) => call[1])
      .find((message) => message.type === 'desktop.direct.error');
    expect(error).toBeDefined();
    expect(error).not.toHaveProperty('settled');
    unknown.coordinator.close();
  });
  it('retries a lost close report without accepting another Node generation', async () => {
    vi.useFakeTimers();
    const f = fixture();
    try {
      await f.coordinator.handleBrowser(identity, prepare);
      const command = f.sendNode.mock.calls[0]![1];
      if (command.type !== 'desktop.direct.prepare') throw new Error('unexpected command');
      const attachmentId = command.attachmentId;
      await f.coordinator.handleBrowser(identity, { type: 'desktop.direct.cancel', attachmentId });
      expect(f.admission.get(attachmentId)?.phase).toBe('CLOSING');
      expect(f.sendBrowser).toHaveBeenCalledWith(identity.workbenchConnectionId, {
        type: 'desktop.direct.closed',
        attachmentId,
        code: 'DESKTOP_CANCELLED'
      });
      expect(
        f.sendBrowser.mock.calls.some(([, message]) => message.type === 'desktop.direct.settled')
      ).toBe(false);
      const initial = f.sendNode.mock.calls.length;
      await vi.advanceTimersByTimeAsync(1_000);
      expect(f.sendNode.mock.calls.length).toBe(initial + 1);
      expect(f.sendNode).toHaveBeenLastCalledWith('node-a', {
        type: 'desktop.direct.cancel',
        attachmentId,
        code: 'DESKTOP_CANCELLED'
      });
      await f.coordinator.onNodeEvent('node-a', 'generation-new', {
        type: 'desktop.direct.closed',
        attachmentId,
        nodeGeneration: 'generation-new',
        code: 'DESKTOP_CANCELLED'
      });
      expect(f.admission.countNode('node-a')).toBe(1);
      expect(
        f.sendBrowser.mock.calls.some(([, message]) => message.type === 'desktop.direct.settled')
      ).toBe(false);
      await f.coordinator.onNodeEvent('node-a', 'generation-a', {
        type: 'desktop.direct.closed',
        attachmentId,
        nodeGeneration: 'generation-a',
        code: 'DESKTOP_CANCELLED'
      });
      expect(f.admission.countNode('node-a')).toBe(0);
      expect(f.sendBrowser).toHaveBeenCalledWith(identity.workbenchConnectionId, {
        type: 'desktop.direct.settled',
        attachmentId,
        code: 'DESKTOP_CANCELLED'
      });
      const settled = f.sendNode.mock.calls.length;
      await vi.advanceTimersByTimeAsync(2_000);
      expect(f.sendNode.mock.calls.length).toBe(settled);
    } finally {
      f.coordinator.close();
      vi.useRealTimers();
    }
  });

  it('binds the grant to the ready transport and holds its slot until Node cleanup', async () => {
    const f = fixture();
    try {
      await f.coordinator.handleBrowser(identity, prepare);
      expect(f.authorize).toHaveBeenCalledWith(identity.userId, prepare.nodeId, prepare.mode);
      const command = f.sendNode.mock.calls[0]![1];
      expect(command.type).toBe('desktop.direct.prepare');
      if (command.type !== 'desktop.direct.prepare') throw new Error('unexpected command');
      expect(command).toMatchObject({
        ...fingerprints,
        workbenchConnectionId: identity.workbenchConnectionId
      });
      const attachmentId = command.attachmentId;
      await f.coordinator.onNodeEvent('node-a', 'generation-a', {
        nodeGeneration: 'generation-a',
        type: 'desktop.direct.ready',
        attachmentId,
        phase: 'PREPARED'
      });
      expect(f.sendBrowser).toHaveBeenCalledWith(
        identity.workbenchConnectionId,
        expect.objectContaining({
          type: 'desktop.direct.prepared',
          attachmentId,
          grant: command.grant
        })
      );
      await f.coordinator.handleBrowser(identity, { type: 'desktop.ready', attachmentId });
      await Promise.all([
        f.coordinator.onNodeEvent('node-a', 'generation-a', {
          nodeGeneration: 'generation-a',
          type: 'desktop.direct.ready',
          attachmentId,
          phase: 'OPEN'
        }),
        f.coordinator.onNodeEvent('node-a', 'generation-a', {
          nodeGeneration: 'generation-a',
          type: 'desktop.direct.ready',
          attachmentId,
          phase: 'ATTACHED'
        }),
        f.coordinator.onNodeEvent('node-a', 'generation-a', {
          nodeGeneration: 'generation-a',
          type: 'desktop.direct.ready',
          attachmentId,
          phase: 'ACTIVE'
        })
      ]);
      expect(f.admission.get(attachmentId)?.phase).toBe('ACTIVE');
      await f.coordinator.handleBrowser(identity, { type: 'desktop.direct.cancel', attachmentId });
      expect(f.admission.get(attachmentId)?.phase).toBe('CLOSING');
      expect(f.admission.countNode('node-a')).toBe(1);
      await f.coordinator.onNodeEvent('node-a', 'old-generation', {
        nodeGeneration: 'old-generation',
        type: 'desktop.direct.closed',
        attachmentId,
        code: 'DESKTOP_CLOSED'
      });
      expect(f.admission.countNode('node-a')).toBe(1);
      await f.coordinator.onNodeEvent('node-a', 'generation-a', {
        nodeGeneration: 'generation-a',
        type: 'desktop.direct.closed',
        attachmentId,
        code: 'DESKTOP_CLOSED'
      });
      expect(f.admission.countNode('node-a')).toBe(0);
    } finally {
      f.coordinator.close();
    }
  });

  it('cannot resurrect an async prepare after page revocation', async () => {
    const f = fixture();
    let resume!: (value: number) => void;
    f.preflight.mockImplementationOnce(
      () =>
        new Promise<number>((resolve) => {
          resume = resolve;
        })
    );
    try {
      const pending = f.coordinator.handleBrowser(identity, prepare);
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
        const pending = f.coordinator.handleBrowser(identity, prepare);
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
          expect.objectContaining({ type: 'desktop.direct.prepare' })
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
      await f.coordinator.handleBrowser(identity, prepare);
      const firstCommand = f.sendNode.mock.calls[0]![1];
      if (firstCommand.type !== 'desktop.direct.prepare') throw new Error('unexpected command');
      f.preflight.mockImplementationOnce(() => new Promise((resolve) => (resume = resolve)));
      const pending = f.coordinator.handleBrowser(second, {
        ...prepare,
        requestId: 'second',
        transportSessionId: 'transport-b'
      });
      await vi.waitFor(() => expect(resume).toBeDefined());
      f.coordinator.revokeConnection(identity.workbenchConnectionId);
      resume(4);
      await pending;
      expect(f.sendNode).toHaveBeenCalledWith(
        'node-a',
        expect.objectContaining({
          type: 'desktop.direct.cancel',
          attachmentId: firstCommand.attachmentId
        })
      );
      const commands = f.sendNode.mock.calls.map(([, message]) => message);
      const prepares = commands.filter((message) => message.type === 'desktop.direct.prepare');
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
        const pending = f.coordinator.handleBrowser(identity, prepare);
        await vi.waitFor(() => expect(resume).toBeDefined());
        if (scope === 'connection') f.coordinator.revokeConnection(identity.workbenchConnectionId);
        if (scope === 'session') f.coordinator.revokeSession(identity.sessionHash);
        if (scope === 'user') f.coordinator.revokeUser(identity.userId);
        if (scope === 'node') f.coordinator.revokeNode(prepare.nodeId);
        if (scope === 'generation') f.coordinator.retireOtherGenerations(prepare.nodeId, 'new');
        if (scope === 'shutdown') f.coordinator.close();
        resume(4);
        await pending;
        expect(f.sendNode).not.toHaveBeenCalled();
        expect(f.admission.countNode(prepare.nodeId)).toBe(0);
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
      const pending = f.coordinator.handleBrowser(identity, prepare);
      await vi.waitFor(() => expect(resume).toBeDefined());
      f.coordinator.revokeUser(identity.userId);
      resume(true);
      await pending;
      expect(f.sendNode).not.toHaveBeenCalled();
      expect(f.admission.countNode(prepare.nodeId)).toBe(0);
    } finally {
      f.coordinator.close();
    }
  });

  it('retries cleanup after page disconnect until the same generation acknowledges or is replaced', async () => {
    vi.useFakeTimers();
    const f = fixture();
    try {
      await f.coordinator.handleBrowser(identity, prepare);
      const command = f.sendNode.mock.calls[0]![1];
      if (command.type !== 'desktop.direct.prepare') throw new Error('unexpected command');
      f.coordinator.revokeConnection(identity.workbenchConnectionId);
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
        f.sendBrowser.mock.calls.some(([, message]) => message.type === 'desktop.direct.settled')
      ).toBe(false);
    } finally {
      f.coordinator.close();
      vi.useRealTimers();
    }
  });

  it('preserves the Node replacement reason while retaining the slot for cleanup', async () => {
    const f = fixture();
    try {
      await f.coordinator.handleBrowser(identity, prepare);
      const sent = f.sendNode.mock.calls[0]![1];
      expect(sent.type).toBe('desktop.direct.prepare');
      f.coordinator.revokeNode('node-a', 'NODE_CONNECTION_REPLACED');
      expect(f.sendNode).toHaveBeenLastCalledWith(
        'node-a',
        expect.objectContaining({
          type: 'desktop.direct.cancel',
          code: 'NODE_CONNECTION_REPLACED'
        })
      );
      expect(f.admission.countNode('node-a')).toBe(1);
    } finally {
      f.coordinator.close();
    }
  });

  it('allows concurrent preparations without a fixed attachment quota', async () => {
    const f = fixture();
    const resolvers: Array<(value: number) => void> = [];
    f.preflight.mockImplementation(() => new Promise<number>((resolve) => resolvers.push(resolve)));
    try {
      const requests = Array.from({ length: 5 }, (_, index) =>
        f.coordinator.handleBrowser(identity, { ...prepare, requestId: `request-${index}` })
      );
      await vi.waitFor(() => expect(resolvers).toHaveLength(5));
      expect(f.admission.countNode('node-a')).toBe(5);
      expect(f.preflight).toHaveBeenCalledTimes(5);
      for (const resolve of resolvers) resolve(4);
      await Promise.all(requests);
      expect(f.sendNode).toHaveBeenCalledTimes(5);
    } finally {
      f.coordinator.close();
    }
  });

  it('does not dispatch if asynchronous preflight finishes after the OPEN deadline', async () => {
    const f = fixture();
    let resume!: (limit: number) => void;
    f.preflight.mockImplementationOnce(
      () =>
        new Promise<number>((resolve) => {
          resume = resolve;
        })
    );
    try {
      const pending = f.coordinator.handleBrowser(identity, prepare);
      await vi.waitFor(() => expect(resume).toBeDefined());
      f.advance(15_000);
      resume(4);
      await pending;
      expect(f.sendNode).not.toHaveBeenCalled();
      expect(f.admission.countNode('node-a')).toBe(0);
    } finally {
      f.coordinator.close();
    }
  });

  it('preserves structured preflight errors without exposing the upstream message', async () => {
    const f = fixture();
    f.preflight.mockRejectedValueOnce(
      new NodeRequestError(
        { error: 'DESKTOP_TOPOLOGY_UNAVAILABLE', message: 'private detail' },
        'request-upstream',
        'node'
      )
    );
    try {
      await f.coordinator.handleBrowser(identity, prepare);
      expect(f.admission.countNode('node-a')).toBe(0);
      expect(f.sendNode).not.toHaveBeenCalled();
      expect(f.sendBrowser).toHaveBeenCalledWith(
        identity.workbenchConnectionId,
        expect.objectContaining({
          type: 'desktop.direct.error',
          code: 'DESKTOP_TOPOLOGY_UNAVAILABLE',
          message: 'The desktop attachment could not be prepared.'
        })
      );
    } finally {
      f.coordinator.close();
    }
  });

  it('leaves relay ownership alone and releases a definitely unsent reservation', async () => {
    const f = fixture();
    const relay = {
      ...identity,
      attachmentId: 'relay-id',
      requestId: 'relay-request',
      nodeId: 'node-a',
      nodeGeneration: 'generation-a',
      desktopGeneration: 'desktop-a',
      topologyRevision: 1,
      mode: 'VIEW',
      path: 'RELAY'
    } as const;
    f.admission.reserve(relay, 1_000);
    f.sendNode.mockReturnValueOnce(false);
    try {
      await f.coordinator.handleBrowser(identity, prepare);
      expect(f.admission.countNode('node-a')).toBe(1);
      f.coordinator.revokeSession(identity.sessionHash);
      expect(f.admission.get('relay-id')?.phase).toBe('RESERVED');
    } finally {
      f.coordinator.close();
    }
  });

  it('fences invalid phase transitions and retains the slot until a cleanup event', async () => {
    const f = fixture();
    try {
      await f.coordinator.handleBrowser(identity, prepare);
      const command = f.sendNode.mock.calls[0]![1];
      if (command.type !== 'desktop.direct.prepare') throw new Error('unexpected command');
      await f.coordinator.onNodeEvent('node-a', 'generation-a', {
        nodeGeneration: 'generation-a',
        type: 'desktop.direct.ready',
        attachmentId: command.attachmentId,
        phase: 'ACTIVE'
      });
      expect(f.admission.get(command.attachmentId)?.phase).toBe('CLOSING');
      expect(f.sendNode).toHaveBeenLastCalledWith(
        'node-a',
        expect.objectContaining({
          type: 'desktop.direct.cancel',
          code: 'DESKTOP_PROTOCOL_ERROR'
        })
      );
      expect(f.admission.countNode('node-a')).toBe(1);
    } finally {
      f.coordinator.close();
    }
  });

  it('fences a changed transport fingerprint and ambiguous command submission', async () => {
    const f = fixture();
    try {
      await f.coordinator.handleBrowser(identity, prepare);
      const command = f.sendNode.mock.calls[0]![1];
      if (command.type !== 'desktop.direct.prepare') throw new Error('unexpected command');
      f.transport.mockReturnValue({ ...fingerprints, nodeFingerprint: 'replaced' });
      await f.coordinator.onNodeEvent('node-a', 'generation-a', {
        nodeGeneration: 'generation-a',
        type: 'desktop.direct.ready',
        attachmentId: command.attachmentId,
        phase: 'PREPARED'
      });
      expect(f.admission.get(command.attachmentId)?.phase).toBe('CLOSING');

      f.transport.mockReturnValue(fingerprints);
      f.sendNode.mockImplementationOnce(() => {
        throw new Error('submission uncertain');
      });
      await f.coordinator.handleBrowser(identity, { ...prepare, requestId: 'request-next' });
      expect(f.admission.countNode('node-a')).toBe(2);
      expect(f.sendNode).toHaveBeenLastCalledWith(
        'node-a',
        expect.objectContaining({
          type: 'desktop.direct.cancel',
          code: 'NODE_OFFLINE'
        })
      );
    } finally {
      f.coordinator.close();
    }
  });

  it('bounds queued Node lifecycle events while authorization is stalled', async () => {
    const f = fixture();
    try {
      await f.coordinator.handleBrowser(identity, prepare);
      const command = f.sendNode.mock.calls[0]![1];
      if (command.type !== 'desktop.direct.prepare') throw new Error('unexpected command');
      let release!: (allowed: boolean) => void;
      f.authorize.mockImplementationOnce(
        () =>
          new Promise<boolean>((resolve) => {
            release = resolve;
          })
      );
      const event = {
        type: 'desktop.direct.ready',
        nodeGeneration: 'generation-a',
        attachmentId: command.attachmentId,
        phase: 'PREPARED'
      } as const;
      const pending = Array.from({ length: 5 }, () =>
        f.coordinator.onNodeEvent('node-a', 'generation-a', event)
      );
      expect(f.admission.get(command.attachmentId)?.phase).toBe('CLOSING');
      await vi.waitFor(() => expect(release).toBeDefined());
      release(true);
      await Promise.all(pending);
      expect(f.sendBrowser).not.toHaveBeenCalledWith(
        identity.workbenchConnectionId,
        expect.objectContaining({ type: 'desktop.direct.prepared' })
      );
    } finally {
      f.coordinator.close();
    }
  });

  it('does not deliver a stale grant if Node closes while authorization is pending', async () => {
    const f = fixture();
    try {
      await f.coordinator.handleBrowser(identity, prepare);
      const command = f.sendNode.mock.calls[0]![1];
      if (command.type !== 'desktop.direct.prepare') throw new Error('unexpected command');
      let resume!: (allowed: boolean) => void;
      f.authorize.mockImplementationOnce(
        () =>
          new Promise<boolean>((resolve) => {
            resume = resolve;
          })
      );
      const pending = f.coordinator.onNodeEvent('node-a', 'generation-a', {
        nodeGeneration: 'generation-a',
        type: 'desktop.direct.ready',
        attachmentId: command.attachmentId,
        phase: 'PREPARED'
      });
      await vi.waitFor(() => expect(resume).toBeDefined());
      await f.coordinator.onNodeEvent('node-a', 'generation-a', {
        nodeGeneration: 'generation-a',
        type: 'desktop.direct.closed',
        attachmentId: command.attachmentId,
        code: 'DESKTOP_BACKEND_CLOSED'
      });
      resume(true);
      await pending;
      expect(f.admission.countNode('node-a')).toBe(0);
      expect(f.sendBrowser).not.toHaveBeenCalledWith(
        identity.workbenchConnectionId,
        expect.objectContaining({ type: 'desktop.direct.prepared' })
      );
    } finally {
      f.coordinator.close();
    }
  });
});
