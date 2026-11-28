import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { ServerDatabase } from '../../ee/server/src/database.js';
import { createTestNodeControl } from '../support/create-test-node-control.js';

describe('upgrade-only Node connection admission', () => {
  it('stops waiting for Relay as soon as the current control connection reports an old version', async () => {
    const database = new ServerDatabase(':memory:');
    const user = { userId: database.getAdmin().id, sessionHash: 'test-session' };
    const token = database.createNodeRegistrationToken(user.userId).token;
    const identity = database.registerNode(token, { metadata: '{}' })!;
    const control = createTestNodeControl(database, async () => true);
    const node = new AdmissionSocket();
    const pending = new AdmissionSocket();
    const after = new AdmissionSocket();
    try {
      control.attach(node.websocket);
      node.receive('authenticate', { nodeId: identity.nodeId, credential: identity.credential });
      await vi.waitFor(() => expect(control.isNodeConnected(identity.nodeId)).toBe(true));
      control.attachClientRelay(pending.websocket, identity.nodeId, user);
      expect(pending.close).not.toHaveBeenCalled();
      expect(pending.send).not.toHaveBeenCalled();

      node.receive('capabilities', {
        platform: 'linux',
        architecture: 'x64',
        nodeVersion: 'v24',
        nodeAppVersion: '0.11.37',
        codex: { available: false },
        claudeCode: { available: false }
      });
      await vi.waitFor(() => expect(node.send).toHaveBeenCalledTimes(2));
      expect(control.isNodeConnected(identity.nodeId)).toBe(true);
      expect(control.isNodeUpgradeOnly(identity.nodeId)).toBe(true);
      expect(control.upgradeCapabilities(identity.nodeId)?.nodeAppVersion).toBe('0.11.37');
      expect(pending.close).toHaveBeenCalledExactlyOnceWith(4004, 'NODE_OFFLINE');

      control.attachClientRelay(after.websocket, identity.nodeId, user);
      expect(after.close).toHaveBeenCalledExactlyOnceWith(4004, 'NODE_OFFLINE');
      expect(after.send).not.toHaveBeenCalled();
    } finally {
      control.close();
      database.close();
    }
  });

  it.each([3] as const)(
    'authorizes, correlates and cancels an upgrade on wire v%i without admitting business',
    async (version) => {
      const database = new ServerDatabase(':memory:');
      const token = database.createNodeRegistrationToken(database.getAdmin().id).token;
      const identity = database.registerNode(token, {
        metadata: JSON.stringify({
          platform: 'linux',
          architecture: 'x64',
          nodeVersion: 'v24.0.0',
          nodeAppVersion: '0.11.37',
          codex: { available: false },
          claudeCode: { available: false },
          supervisedUpgrade: true
        })
      })!;
      const authorize = vi.fn(async () => true);
      const control = createTestNodeControl(database, authorize);
      const sent: Array<{
        version: number;
        id: string;
        type: string;
        payload: { operation?: string };
      }> = [];
      const socket = {
        OPEN: 1,
        readyState: 1,
        send: (text: string) => sent.push(JSON.parse(text)),
        close: vi.fn()
      };
      const internal = control as unknown as {
        handleMessage(
          socket: unknown,
          raw: string,
          setId: (id: string) => void,
          getId: () => string | undefined
        ): Promise<void>;
      };
      let nodeId: string | undefined;
      const receive = (type: string, payload: unknown, replyTo?: string) =>
        internal.handleMessage(
          socket,
          JSON.stringify({
            version,
            id: `incoming-${sent.length}`,
            type,
            payload,
            ...(replyTo === undefined ? {} : { replyTo })
          }),
          (id) => {
            nodeId = id;
          },
          () => nodeId
        );
      const user = { userId: database.getAdmin().id, sessionHash: 'test-session' };
      try {
        await receive('authenticate', { nodeId: identity.nodeId, credential: identity.credential });
        expect(nodeId).toBe(identity.nodeId);
        await expect(
          control.requestNode(identity.nodeId, 'workspace.list', {}, user)
        ).rejects.toThrow('NODE_UPGRADE_REQUIRED');
        expect(authorize).not.toHaveBeenCalled();
        const upgrade = control.requestNode(
          identity.nodeId,
          'node.upgrade.request',
          { targetVersion: '0.11.39' },
          user
        );
        await vi.waitFor(() =>
          expect(sent.some((frame) => frame.payload?.operation === 'node.upgrade.request')).toBe(
            true
          )
        );
        const request = sent.find((frame) => frame.payload?.operation === 'node.upgrade.request')!;
        expect(request.version).toBe(version);
        await receive('node.response', { result: { state: 'WAITING_FOR_RUNS' } }, request.id);
        await expect(upgrade).resolves.toEqual({ state: 'WAITING_FOR_RUNS' });
        const cancel = control.requestNode(identity.nodeId, 'node.upgrade.cancel', {}, user);
        await vi.waitFor(() =>
          expect(sent.some((frame) => frame.payload?.operation === 'node.upgrade.cancel')).toBe(
            true
          )
        );
        const cancellation = sent.find(
          (frame) => frame.payload?.operation === 'node.upgrade.cancel'
        )!;
        expect(cancellation.version).toBe(version);
        await receive('node.response', { result: { cancelled: true } }, cancellation.id);
        await expect(cancel).resolves.toEqual({ cancelled: true });
        expect(authorize).toHaveBeenCalledTimes(2);
        authorize.mockResolvedValue(false);
        await expect(
          control.requestNode(identity.nodeId, 'node.upgrade.cancel', {}, user)
        ).rejects.toThrow('NODE_ACCESS_DENIED');
        expect(
          sent.filter((frame) => frame.payload?.operation === 'node.upgrade.cancel')
        ).toHaveLength(1);
        authorize.mockResolvedValue(true);
        const pending = control.requestNode(identity.nodeId, 'node.upgrade.cancel', {}, user);
        await vi.waitFor(() =>
          expect(
            sent.filter((frame) => frame.payload?.operation === 'node.upgrade.cancel')
          ).toHaveLength(2)
        );
        const pendingResult = expect(pending).rejects.toThrow('NODE_CONNECTION_REPLACED');
        const replacement = { OPEN: 1, readyState: 1, send: vi.fn(), close: vi.fn() };
        let replacementId: string | undefined;
        await internal.handleMessage(
          replacement,
          JSON.stringify({
            version,
            id: 'replacement',
            type: 'authenticate',
            payload: { nodeId: identity.nodeId, credential: identity.credential }
          }),
          (id) => {
            replacementId = id;
          },
          () => replacementId
        );
        expect(replacementId).toBe(identity.nodeId);
        await pendingResult;
        const revoked = control.requestNode(identity.nodeId, 'node.upgrade.cancel', {}, user);
        await vi.waitFor(() => expect(replacement.send).toHaveBeenCalledTimes(2));
        const revokedResult = expect(revoked).rejects.toThrow('NODE_OFFLINE');
        control.closeNode(identity.nodeId, 4003, 'NODE_REVOKED');
        await revokedResult;
      } finally {
        control.close();
        database.close();
      }
    }
  );
});

class AdmissionSocket extends EventEmitter {
  readonly OPEN = 1;
  readyState = this.OPEN;
  readonly send = vi.fn();
  readonly ping = vi.fn();
  readonly close = vi.fn((_code: number, _reason: string) => this.terminate());

  get websocket(): Parameters<ReturnType<typeof createTestNodeControl>['attach']>[0] {
    return this as unknown as Parameters<ReturnType<typeof createTestNodeControl>['attach']>[0];
  }

  receive(type: string, payload: unknown): void {
    this.emit('message', Buffer.from(JSON.stringify({ version: 3, id: type, type, payload })));
  }

  terminate(): void {
    if (this.readyState !== this.OPEN) return;
    this.readyState = 3;
    this.emit('close');
  }
}
