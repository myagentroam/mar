import { describe, expect, it, vi } from 'vitest';
import type { TerminalDirectNodeCommand, TerminalDirectServerMessage } from '@myagentroam/protocol';
import { TerminalDirectCoordinator } from '../../src/terminal-direct-coordinator.js';
import { NodeRequestError } from '../../src/node-request-channel.js';

const identity = { userId: 7, sessionHash: 'session-7', workbenchConnectionId: 'page-12345678' };
const request = {
  type: 'terminal.direct.prepare',
  requestId: 'request-1234',
  nodeId: 'node-a',
  nodeGeneration: 'generation-1234',
  transportSessionId: 'transport-1234',
  terminalId: 'terminal-a',
  workspaceId: 'workspace-a',
  afterSequence: 4,
  readonly: false
} as const;

function fixture() {
  let now = 1_000_000;
  let permitted = true;
  const transport = vi.fn(() => ({
    browserFingerprint: `sha-256 ${'AA:'.repeat(31)}AA`,
    nodeFingerprint: `sha-256 ${'BB:'.repeat(31)}BB`
  }));
  const authorize = vi.fn(async () => permitted);
  const preflight = vi.fn(async () => undefined);
  const sendNode = vi.fn((_id: string, _message: TerminalDirectNodeCommand) => true);
  const sendBrowser = vi.fn(
    async (_id: string, _message: TerminalDirectServerMessage) => 'delivered' as const
  );
  const coordinator = new TerminalDirectCoordinator({
    transport: { terminalTransport: transport },
    authorize,
    preflight,
    sendNode,
    sendBrowser,
    now: () => now
  });
  return {
    coordinator,
    transport,
    authorize,
    preflight,
    sendNode,
    sendBrowser,
    advance: (ms: number) => (now += ms),
    deny: () => (permitted = false)
  };
}

describe('Terminal direct coordinator', () => {
  it.each([false, true])('attaches once per direct session, readonly=%s', async (readonly) => {
    const f = fixture();
    try {
      await f.coordinator.handleBrowser(identity, { ...request, readonly });
      const prepare = f.sendNode.mock.calls[0]![1] as Extract<
        TerminalDirectNodeCommand,
        { type: 'terminal.direct.prepare' }
      >;
      await f.coordinator.onNodeReady('node-a', prepare.directSessionId);
      f.coordinator.onNodeAttached('wrong-node', prepare.directSessionId);
      f.coordinator.onNodeAttached('node-a', prepare.directSessionId);
      f.coordinator.onNodeAttached('node-a', prepare.directSessionId);
      expect(f.sendBrowser).toHaveBeenCalledTimes(1);
      expect(f.sendBrowser).toHaveBeenCalledWith(
        'page-12345678',
        expect.objectContaining({ type: 'terminal.direct.prepared' })
      );
    } finally {
      f.coordinator.close();
    }
  });

  it('preflights without taking a writer and delivers the grant only after Node confirms readiness', async () => {
    const f = fixture();
    try {
      await f.coordinator.handleBrowser(identity, request);
      expect(f.preflight).toHaveBeenCalledWith('node-a', 'terminal-a', 'workspace-a', identity);
      expect(f.sendBrowser).not.toHaveBeenCalled();
      const prepare = f.sendNode.mock.calls[0]![1] as Extract<
        TerminalDirectNodeCommand,
        { type: 'terminal.direct.prepare' }
      >;
      expect(prepare).toMatchObject({
        type: 'terminal.direct.prepare',
        terminalId: 'terminal-a',
        afterSequence: 4,
        transportSessionId: 'transport-1234',
        readonly: false
      });
      await f.coordinator.onNodeReady('different-node', prepare.directSessionId);
      expect(f.sendBrowser).not.toHaveBeenCalled();
      await f.coordinator.onNodeReady('node-a', prepare.directSessionId);
      expect(f.sendBrowser).toHaveBeenCalledWith(
        'page-12345678',
        expect.objectContaining({
          type: 'terminal.direct.prepared',
          grant: prepare.grant,
          directSessionId: prepare.directSessionId
        })
      );
      expect(f.coordinator.sessionCount(identity.sessionHash)).toBe(1);
    } finally {
      f.coordinator.close();
    }
  });

  it('refuses unauthorized prepare and does not emit a Node command or grant', async () => {
    const f = fixture();
    try {
      f.deny();
      await f.coordinator.handleBrowser(identity, request);
      expect(f.preflight).not.toHaveBeenCalled();
      expect(f.sendNode).not.toHaveBeenCalled();
      expect(f.sendBrowser).toHaveBeenCalledWith(
        identity.workbenchConnectionId,
        expect.objectContaining({ type: 'terminal.direct.error', code: 'TERMINAL_NOT_AUTHORIZED' })
      );
    } finally {
      f.coordinator.close();
    }
  });

  it('classifies only structured preflight errors, never untrusted message text', async () => {
    const f = fixture();
    try {
      f.preflight.mockRejectedValueOnce(
        new NodeRequestError(
          { error: 'TERMINAL_WORKSPACE_MISMATCH', message: 'The workspace does not match.' },
          'request-1234'
        )
      );
      await f.coordinator.handleBrowser(identity, request);
      expect(f.sendBrowser).toHaveBeenCalledWith(
        identity.workbenchConnectionId,
        expect.objectContaining({ code: 'TERMINAL_WORKSPACE_MISMATCH' })
      );
      f.preflight.mockRejectedValueOnce(new Error('TERMINAL_WORKSPACE_MISMATCH'));
      await f.coordinator.handleBrowser(identity, request);
      expect(f.sendBrowser).toHaveBeenLastCalledWith(
        identity.workbenchConnectionId,
        expect.objectContaining({ code: 'TERMINAL_DIRECT_UNAVAILABLE' })
      );
      expect(f.sendNode).not.toHaveBeenCalled();
    } finally {
      f.coordinator.close();
    }
  });

  it('rejects a forged transport and closes a lease when authority is revoked', async () => {
    const f = fixture();
    try {
      f.transport.mockReturnValueOnce(undefined as never);
      await f.coordinator.handleBrowser(identity, request);
      expect(f.sendNode).not.toHaveBeenCalled();
      expect(f.sendBrowser).toHaveBeenCalledWith(
        identity.workbenchConnectionId,
        expect.objectContaining({ code: 'TERMINAL_DIRECT_UNAVAILABLE' })
      );
      await f.coordinator.handleBrowser(identity, request);
      const prepare = f.sendNode.mock.calls[0]![1] as Extract<
        TerminalDirectNodeCommand,
        { type: 'terminal.direct.prepare' }
      >;
      await f.coordinator.onNodeReady('node-a', prepare.directSessionId);
      f.deny();
      await f.coordinator.handleBrowser(identity, {
        type: 'terminal.direct.heartbeat',
        directSessionId: prepare.directSessionId
      });
      expect(f.sendNode).toHaveBeenCalledWith(
        'node-a',
        expect.objectContaining({
          type: 'terminal.direct.cancel',
          directSessionId: prepare.directSessionId
        })
      );
      expect(f.coordinator.sessionCount(identity.sessionHash)).toBe(0);
    } finally {
      f.coordinator.close();
    }
  });

  it('releases a prepared Node grant if the browser cannot receive it', async () => {
    const f = fixture();
    try {
      f.sendBrowser.mockResolvedValue('unavailable' as never);
      await f.coordinator.handleBrowser(identity, request);
      const prepare = f.sendNode.mock.calls[0]![1] as Extract<
        TerminalDirectNodeCommand,
        { type: 'terminal.direct.prepare' }
      >;
      await f.coordinator.onNodeReady('node-a', prepare.directSessionId);
      expect(f.coordinator.sessionCount(identity.sessionHash)).toBe(0);
      expect(f.sendNode).toHaveBeenCalledWith(
        'node-a',
        expect.objectContaining({
          type: 'terminal.direct.cancel',
          directSessionId: prepare.directSessionId,
          code: 'TERMINAL_DIRECT_CONTROL_UNAVAILABLE'
        })
      );
    } finally {
      f.coordinator.close();
    }
  });

  it('rechecks the attachment cap after concurrent Node preflights', async () => {
    const f = fixture();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.preflight.mockImplementation(async () => {
      await gate;
      return undefined;
    });
    try {
      const attempts = Array.from({ length: 11 }, (_, index) =>
        f.coordinator.handleBrowser(identity, {
          ...request,
          requestId: `request-${String(index).padStart(8, '0')}`
        })
      );
      await vi.waitFor(() => expect(f.preflight).toHaveBeenCalledTimes(11));
      release();
      await Promise.all(attempts);
      expect(f.coordinator.sessionCount(identity.sessionHash)).toBe(10);
      expect(f.sendNode).toHaveBeenCalledTimes(10);
      expect(f.sendBrowser).toHaveBeenCalledWith(
        identity.workbenchConnectionId,
        expect.objectContaining({
          type: 'terminal.direct.error',
          code: 'TERMINAL_RELAY_LIMIT_REACHED'
        })
      );
    } finally {
      release?.();
      f.coordinator.close();
    }
  });

  it('does not renew a canceled attachment after an in-flight authorization completes', async () => {
    const f = fixture();
    try {
      await f.coordinator.handleBrowser(identity, request);
      const prepare = f.sendNode.mock.calls[0]![1] as Extract<
        TerminalDirectNodeCommand,
        { type: 'terminal.direct.prepare' }
      >;
      let release!: (allowed: boolean) => void;
      const pending = new Promise<boolean>((resolve) => {
        release = resolve;
      });
      f.authorize.mockImplementationOnce(async () => pending);
      const heartbeat = f.coordinator.handleBrowser(identity, {
        type: 'terminal.direct.heartbeat',
        directSessionId: prepare.directSessionId
      });
      await vi.waitFor(() => expect(f.authorize).toHaveBeenCalledTimes(3));
      await f.coordinator.handleBrowser(identity, {
        type: 'terminal.direct.cancel',
        directSessionId: prepare.directSessionId
      });
      release(true);
      await heartbeat;
      expect(f.sendNode.mock.calls.map(([, message]) => message.type)).toEqual([
        'terminal.direct.prepare',
        'terminal.direct.cancel'
      ]);
    } finally {
      f.coordinator.close();
    }
  });
});
