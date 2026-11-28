import { describe, expect, it, vi } from 'vitest';
import { DirectTransferCoordinator } from '../../src/direct-transfer-coordinator.js';

const fingerprintA = `sha-256 ${'AA:'.repeat(31)}AA`;
const fingerprintB = `sha-256 ${'BB:'.repeat(31)}BB`;
const identity = { userId: 7, sessionHash: 'session', workbenchConnectionId: 'connection' };

function fixture(authorizeTransport?: (userId: number, nodeId: string) => Promise<boolean>) {
  const sendNode = vi.fn((_nodeId: string, _type: string, _payload: unknown) => true);
  const sendBrowser = vi.fn(
    async (_connectionId: string, _message: unknown) => 'delivered' as const
  );
  const authorize = vi.fn(async () => true);
  const ownsPage = vi.fn(() => true);
  let now = 1_000_000;
  const audit = vi.fn(async (_event: unknown) => undefined);
  const coordinator = new DirectTransferCoordinator({
    audits: { audit },
    authorize,
    ownsPage,
    ...(authorizeTransport === undefined ? {} : { authorizeTransport }),
    sendNode,
    sendBrowser,
    now: () => now,
    randomId: (() => {
      let id = 0;
      return () => `session-${(++id).toString().padStart(4, '0')}`;
    })()
  });
  return {
    coordinator,
    audit,
    authorize,
    ownsPage,
    sendNode,
    sendBrowser,
    advance: (ms: number) => (now += ms)
  };
}

async function prepareTransport(f: ReturnType<typeof fixture>) {
  await f.coordinator.handleBrowserMessage(identity, {
    type: 'direct.prepare',
    requestId: 'request-transport',
    nodeId: 'node',
    nodeGeneration: 'generation',
    purpose: 'TRANSPORT'
  });
  const prepared = f.sendBrowser.mock.calls.find(
    ([, message]) => (message as { type?: string }).type === 'direct.prepared'
  )![1] as { directSessionId: string };
  return prepared.directSessionId;
}

async function connectTransport(f: ReturnType<typeof fixture>, transportSessionId: string) {
  await f.coordinator.handleBrowserMessage(identity, {
    type: 'direct.signal',
    directSessionId: transportSessionId,
    signal: { kind: 'OFFER', sdp: 'v=0\r\n', fingerprint: fingerprintA }
  });
  f.coordinator.handleNodeMessage('node', {
    type: 'direct.signal',
    directSessionId: transportSessionId,
    signal: { kind: 'ANSWER', sdp: 'v=0\r\n', fingerprint: fingerprintB }
  });
  await f.coordinator.handleBrowserMessage(identity, {
    type: 'direct.connected',
    directSessionId: transportSessionId
  });
  f.coordinator.handleNodeMessage('node', {
    type: 'direct.connected',
    directSessionId: transportSessionId
  });
  await vi.waitFor(() =>
    expect(f.sendBrowser).toHaveBeenCalledWith(
      'connection',
      expect.objectContaining({ type: 'direct.opened', directSessionId: transportSessionId })
    )
  );
}

describe('Workspace direct transfer coordinator', () => {
  it('allows a separately authorized transport without authorizing Workspace file transfers', async () => {
    const authorizeTransport = vi.fn(async () => true);
    const f = fixture(authorizeTransport);
    f.authorize.mockResolvedValue(false);
    try {
      const transportSessionId = await prepareTransport(f);
      await connectTransport(f, transportSessionId);
      await f.coordinator.handleBrowserMessage(identity, {
        type: 'direct.prepare',
        requestId: 'request-transfer',
        nodeId: 'node',
        nodeGeneration: 'generation',
        purpose: 'TRANSFER',
        transportSessionId,
        transfer: {
          direction: 'UPLOAD',
          uploadId: '54b92a04-ee89-4393-8bc9-ccc6d132b9b0',
          resource: { kind: 'WORKSPACE_FILE', workspaceId: 'workspace', path: 'file' },
          fileName: 'file',
          size: 1,
          sha256: 'a'.repeat(64)
        }
      });
      expect(f.authorize).toHaveBeenCalledWith(identity.userId, 'node', 'workspace');
      expect(f.sendBrowser).toHaveBeenLastCalledWith(
        'connection',
        expect.objectContaining({
          type: 'direct.error',
          code: 'DIRECT_TRANSFER_NOT_AUTHORIZED'
        })
      );
      expect(authorizeTransport).toHaveBeenCalledWith(identity.userId, 'node');
    } finally {
      f.coordinator.close();
    }
  });
  it('borrows only a ready transport belonging to the same page and Node generation', async () => {
    const f = fixture();
    try {
      const id = await prepareTransport(f);
      expect(f.coordinator.authorizedTransport(identity, id, 'node', 'generation')).toBeUndefined();
      await connectTransport(f, id);
      expect(f.coordinator.authorizedTransport(identity, id, 'node', 'generation')).toEqual({
        browserFingerprint: fingerprintA,
        nodeFingerprint: fingerprintB
      });
      expect(
        f.coordinator.authorizedTransport(
          { ...identity, workbenchConnectionId: 'other-page' },
          id,
          'node',
          'generation'
        )
      ).toBeUndefined();
      expect(
        f.coordinator.authorizedTransport(identity, id, 'node', 'old-generation')
      ).toBeUndefined();
      f.coordinator.revokeNode('node', 'NODE_OFFLINE');
      expect(f.coordinator.authorizedTransport(identity, id, 'node', 'generation')).toBeUndefined();
    } finally {
      f.coordinator.close();
    }
  });

  it('retains an ICE carrier on login invalidation but removes it from new admission', async () => {
    const f = fixture();
    try {
      const id = await prepareTransport(f);
      await connectTransport(f, id);
      f.sendNode.mockClear();

      f.coordinator.revokeConnection(identity.workbenchConnectionId, 'DIRECT_USER_SESSION_CLOSED');

      expect(f.coordinator.authorizedTransport(identity, id, 'node', 'generation')).toBeUndefined();
      expect(f.sendNode).not.toHaveBeenCalled();

      f.coordinator.revokeNode('node', 'NODE_OFFLINE');
      expect(f.sendNode).toHaveBeenCalledWith(
        'node',
        'direct.cancel',
        expect.objectContaining({ directSessionId: id })
      );
    } finally {
      f.coordinator.close();
    }
  });

  it('does not create a transport if the page loses ownership during authorization', async () => {
    const { promise, resolve } = Promise.withResolvers<boolean>();
    const authorizeTransport = vi.fn(() => promise);
    const f = fixture(authorizeTransport);
    try {
      const pending = f.coordinator.handleBrowserMessage(identity, {
        type: 'direct.prepare',
        requestId: 'request-transport',
        nodeId: 'node',
        nodeGeneration: 'generation',
        purpose: 'TRANSPORT'
      });
      expect(authorizeTransport).toHaveBeenCalledOnce();
      f.ownsPage.mockReturnValue(false);
      f.coordinator.revokeConnection(identity.workbenchConnectionId, 'DIRECT_USER_SESSION_CLOSED');
      resolve(true);
      await pending;
      expect(f.sendNode).not.toHaveBeenCalled();
      expect(f.sendBrowser).not.toHaveBeenCalled();
    } finally {
      f.coordinator.close();
    }
  });

  it('keeps a confirmed ordinary download and its carrier while revoking a still-unused grant', async () => {
    const authorizeTransport = vi.fn(async () => true);
    const f = fixture(authorizeTransport);
    try {
      const transportSessionId = await prepareTransport(f);
      await connectTransport(f, transportSessionId);
      const prepare = (requestId: string) =>
        f.coordinator.handleBrowserMessage(identity, {
          type: 'direct.prepare',
          requestId,
          nodeId: 'node',
          nodeGeneration: 'generation',
          purpose: 'TRANSFER',
          transportSessionId,
          transfer: {
            direction: 'DOWNLOAD',
            resource: { kind: 'WORKSPACE_FILE', workspaceId: 'workspace', path: 'file' },
            fileName: 'file',
            size: 1,
            revision: 'revision'
          }
        });
      const grant = () => f.sendNode.mock.calls.at(-1)![2] as { directSessionId: string };
      await prepare('active');
      const active = grant().directSessionId;
      f.coordinator.handleNodeMessage('node', {
        type: 'direct.opened',
        directSessionId: active,
        offset: 0
      });
      await prepare('pending');
      const pending = grant().directSessionId;
      f.authorize.mockResolvedValue(false);
      authorizeTransport.mockResolvedValue(false);
      f.sendNode.mockClear();
      await f.coordinator.revalidateAuthorizations({ nodeId: 'node', workspaceId: 'other' });
      expect(f.sendNode).not.toHaveBeenCalled();
      await f.coordinator.revalidateAuthorizations({ nodeId: 'node', workspaceId: 'workspace' });
      expect(f.sendNode).toHaveBeenCalledExactlyOnceWith(
        'node',
        'direct.cancel',
        expect.objectContaining({
          directSessionId: pending,
          code: 'DIRECT_TRANSFER_NOT_AUTHORIZED'
        })
      );
      for (const directSessionId of [transportSessionId, active])
        await f.coordinator.handleBrowserMessage(identity, {
          type: 'direct.heartbeat',
          directSessionId
        });
      expect(
        f.sendNode.mock.calls
          .slice(1)
          .map(([, type, payload]) => [
            type,
            (payload as { directSessionId: string }).directSessionId
          ])
      ).toEqual([
        ['direct.heartbeat', transportSessionId],
        ['direct.heartbeat', active]
      ]);
      await prepare('denied');
      expect(f.sendBrowser).toHaveBeenLastCalledWith(
        'connection',
        expect.objectContaining({
          requestId: 'denied',
          code: 'DIRECT_TRANSFER_NOT_AUTHORIZED'
        })
      );
    } finally {
      f.coordinator.close();
    }
  });
  it.each(['UPLOAD', 'DOWNLOAD'] as const)(
    'only audits completed Composer uploads, direction=%s',
    async (direction) => {
      const f = fixture();
      const transportSessionId = await prepareTransport(f);
      try {
        await connectTransport(f, transportSessionId);
        await f.coordinator.handleBrowserMessage(identity, {
          type: 'direct.prepare',
          requestId: 'request-audit',
          nodeId: 'node',
          nodeGeneration: 'generation',
          purpose: 'TRANSFER',
          transportSessionId,
          transfer: {
            resource: { kind: 'WORKSPACE_FILE', workspaceId: 'workspace', path: 'file.txt' },
            fileName: 'file.txt',
            size: 12,
            ...(direction === 'DOWNLOAD'
              ? { direction: 'DOWNLOAD' as const, revision: 'a'.repeat(64) }
              : {
                  direction: 'UPLOAD' as const,
                  sha256: 'a'.repeat(64),
                  composerAttachment: { id: 'attachment-one', mime: 'application/octet-stream' }
                })
          }
        });
        const transfer = f.sendNode.mock.calls.find(
          ([, type, payload]) =>
            type === 'direct.prepare' && (payload as { purpose?: string }).purpose === 'TRANSFER'
        )![2] as { directSessionId: string };
        expect(f.audit).not.toHaveBeenCalled();
        f.coordinator.handleNodeMessage('node', {
          type: 'direct.complete',
          directSessionId: transfer.directSessionId,
          size: 12
        });
        f.coordinator.handleNodeMessage('node', {
          type: 'direct.complete',
          directSessionId: transfer.directSessionId,
          size: 12
        });
        if (direction === 'DOWNLOAD') expect(f.audit).not.toHaveBeenCalled();
        else
          expect(f.audit).toHaveBeenCalledExactlyOnceWith(
            expect.objectContaining({
              eventType: 'workspace.files.upload.complete',
              actorUserId: 7,
              workspaceId: 'workspace',
              targetType: 'WORKSPACE',
              metadata: JSON.stringify({
                action: 'workspace.files.upload.complete',
                relativePath: 'file.txt',
                fileName: 'file.txt',
                sizeBytes: 12
              })
            })
          );
      } finally {
        f.coordinator.close();
      }
    }
  );

  it('keeps transport signaling separate and reuses one transport for duplicate prepare', async () => {
    const f = fixture();
    const transportSessionId = await prepareTransport(f);
    expect(f.authorize).toHaveBeenCalledWith(7, 'node', undefined);
    expect(f.sendNode).toHaveBeenCalledWith(
      'node',
      'direct.prepare',
      expect.objectContaining({ purpose: 'TRANSPORT', directSessionId: transportSessionId })
    );

    await f.coordinator.handleBrowserMessage(identity, {
      type: 'direct.prepare',
      requestId: 'request-transport-again',
      nodeId: 'node',
      nodeGeneration: 'generation',
      purpose: 'TRANSPORT'
    });
    expect(f.sendNode.mock.calls.filter(([, type]) => type === 'direct.prepare')).toHaveLength(1);
    expect(f.sendBrowser).toHaveBeenCalledWith(
      'connection',
      expect.objectContaining({
        type: 'direct.prepared',
        requestId: 'request-transport-again',
        directSessionId: transportSessionId
      })
    );
    f.coordinator.close();
  });

  it('rejects a transfer until its referenced transport is fully connected', async () => {
    const f = fixture();
    const transportSessionId = await prepareTransport(f);
    await f.coordinator.handleBrowserMessage(identity, {
      type: 'direct.prepare',
      requestId: 'request-transfer',
      nodeId: 'node',
      nodeGeneration: 'generation',
      purpose: 'TRANSFER',
      transportSessionId,
      transfer: {
        direction: 'UPLOAD',
        uploadId: '54b92a04-ee89-4393-8bc9-ccc6d132b9b0',
        resource: { kind: 'WORKSPACE_FILE', workspaceId: 'workspace', path: 'large.bin' },
        fileName: 'large.bin',
        size: 12,
        sha256: 'a'.repeat(64)
      }
    });
    expect(f.sendBrowser).toHaveBeenLastCalledWith(
      'connection',
      expect.objectContaining({ type: 'direct.error', code: 'DIRECT_TRANSFER_UNAVAILABLE' })
    );
    expect(f.sendNode.mock.calls.filter(([, type]) => type === 'direct.prepare')).toHaveLength(1);
    f.coordinator.close();
  });

  it('prepares and grants each transfer against transport fingerprints without new signaling', async () => {
    const f = fixture();
    const transportSessionId = await prepareTransport(f);
    await connectTransport(f, transportSessionId);
    f.sendNode.mockClear();

    await f.coordinator.handleBrowserMessage(identity, {
      type: 'direct.prepare',
      requestId: 'request-transfer',
      nodeId: 'node',
      nodeGeneration: 'generation',
      purpose: 'TRANSFER',
      transportSessionId,
      transfer: {
        direction: 'DOWNLOAD',
        resource: { kind: 'WORKSPACE_FILE', workspaceId: 'workspace', path: 'large.bin' },
        fileName: 'large.bin',
        revision: 'revision-1',
        size: 12,
        range: { offset: 4, length: 4 }
      }
    });

    const transferPrepare = f.sendNode.mock.calls.find(
      ([, type]) => type === 'direct.prepare'
    )![2] as {
      directSessionId: string;
    };
    expect(f.sendNode).toHaveBeenCalledWith(
      'node',
      'direct.prepare',
      expect.objectContaining({ purpose: 'TRANSFER', transportSessionId })
    );
    expect(f.sendNode).toHaveBeenCalledWith(
      'node',
      'direct.grant',
      expect.objectContaining({
        directSessionId: transferPrepare.directSessionId,
        transportSessionId,
        browserFingerprint: fingerprintA,
        nodeFingerprint: fingerprintB
      })
    );
    expect(f.sendNode.mock.calls.some(([, type]) => type === 'direct.signal')).toBe(false);
    f.coordinator.close();
  });

  it('closes child transfers when transport is revoked but leaves transport alive after transfer completion', async () => {
    const f = fixture();
    const transportSessionId = await prepareTransport(f);
    await connectTransport(f, transportSessionId);
    await f.coordinator.handleBrowserMessage(identity, {
      type: 'direct.prepare',
      requestId: 'request-transfer',
      nodeId: 'node',
      nodeGeneration: 'generation',
      purpose: 'TRANSFER',
      transportSessionId,
      transfer: {
        direction: 'UPLOAD',
        uploadId: '54b92a04-ee89-4393-8bc9-ccc6d132b9b0',
        resource: { kind: 'WORKSPACE_FILE', workspaceId: 'workspace', path: 'large.bin' },
        fileName: 'large.bin',
        size: 12,
        sha256: 'a'.repeat(64)
      }
    });
    const transfer = f.sendNode.mock.calls.find(
      ([, type, payload]) =>
        type === 'direct.prepare' && (payload as { purpose?: string }).purpose === 'TRANSFER'
    )![2] as { directSessionId: string };
    f.coordinator.handleNodeMessage('node', {
      type: 'direct.complete',
      directSessionId: transfer.directSessionId,
      size: 12
    });
    f.sendNode.mockClear();
    await f.coordinator.handleBrowserMessage(identity, {
      type: 'direct.heartbeat',
      directSessionId: transportSessionId
    });
    expect(f.sendNode).toHaveBeenCalledWith(
      'node',
      'direct.heartbeat',
      expect.objectContaining({ directSessionId: transportSessionId })
    );
    f.coordinator.revokeConnection('connection', 'DIRECT_PAGE_CONNECTION_CLOSED');
    expect(f.sendNode).toHaveBeenCalledWith(
      'node',
      'direct.cancel',
      expect.objectContaining({ directSessionId: transportSessionId })
    );
  });

  it('rejects non-host and more than thirty-two transport candidates', async () => {
    const f = fixture();
    const first = await prepareTransport(f);
    await f.coordinator.handleBrowserMessage(identity, {
      type: 'direct.signal',
      directSessionId: first,
      signal: {
        kind: 'CANDIDATE',
        candidate: {
          candidate: 'candidate:1 1 udp 1 203.0.113.10 50000 typ srflx',
          sdpMid: '0',
          sdpMLineIndex: 0
        }
      }
    });
    expect(f.sendNode).toHaveBeenCalledWith(
      'node',
      'direct.cancel',
      expect.objectContaining({
        directSessionId: first,
        code: 'DIRECT_TRANSFER_CANDIDATE_REJECTED'
      })
    );

    const second = await prepareTransport(f);
    for (let index = 0; index < 33; index += 1)
      await f.coordinator.handleBrowserMessage(identity, {
        type: 'direct.signal',
        directSessionId: second,
        signal: {
          kind: 'CANDIDATE',
          candidate: {
            candidate: `candidate:${index} 1 udp 1 192.168.1.${index + 1} 50000 typ host`,
            sdpMid: '0',
            sdpMLineIndex: 0
          }
        }
      });
    expect(f.sendNode).toHaveBeenCalledWith(
      'node',
      'direct.cancel',
      expect.objectContaining({
        directSessionId: second,
        code: 'DIRECT_TRANSFER_CANDIDATE_REJECTED'
      })
    );
    f.coordinator.close();
  });
});
