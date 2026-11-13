import { describe, expect, it, vi } from 'vitest';
import type WebSocket from 'ws';
import type { RTCPeerConnection } from 'node-datachannel/polyfill';
import { DirectDesktopService } from '../../src/remote-desktop/direct-desktop-service.js';
import { RelayDesktopService } from '../../src/remote-desktop/relay-desktop-service.js';
import {
  DesktopAttachmentRegistry,
  type DesktopPrepare
} from '../../src/remote-desktop/desktop-service-core.js';
import type { DesktopByteStream } from '../../src/remote-desktop/desktop-byte-stream.js';

type Path = 'DIRECT' | 'RELAY';
const fingerprint = `sha-256 ${'AA:'.repeat(31)}AA`;

function fixture(registry: DesktopAttachmentRegistry, path: Path, attachmentId: string) {
  let current = true;
  let release = () => {};
  let cleanup = Promise.resolve();
  const channel = {
    readyState: path === 'DIRECT' ? 'open' : 1,
    bufferedAmount: 0,
    onmessage: null as ((event: { data: unknown }) => void) | null,
    onopen: null,
    onclose: null,
    onerror: null,
    send: vi.fn(),
    close: vi.fn(),
    terminate: vi.fn()
  };
  const close = vi.fn();
  const createAttachment = vi.fn(
    (_command: DesktopPrepare, stream: DesktopByteStream, callbacks: { attached(): void }) => {
      stream.on('error', () => {});
      close.mockImplementation(() => {
        stream.destroy();
        return cleanup;
      });
      return {
        open: async () => callbacks.attached(),
        close
      };
    }
  );
  const emit = vi.fn(() => true);
  const peer = {
    createDataChannel: () => channel,
    sctp: { maxMessageSize: 65536 }
  } as unknown as RTCPeerConnection;
  const common = {
    registry,
    nodeGeneration: () => 'generation-1',
    isCurrent: () => current,
    now: () => 1000,
    createAttachment,
    emit
  };
  const service =
    path === 'DIRECT'
      ? new DirectDesktopService({
          ...common,
          peer: () => peer
        })
      : new RelayDesktopService({
          ...common,
          nodeId: 'node-1',
          credential: () => 'test-credential',
          connect: () => channel as unknown as WebSocket
        });
  const binding = {
    attachmentId,
    workbenchConnectionId: `page-${attachmentId}`,
    nodeGeneration: 'generation-1',
    desktopGeneration: 'desktop-1',
    topologyRevision: 1,
    mode: 'CONTROL',
    grant: 'g'.repeat(32),
    openExpiresAt: 16000,
    expiresAt: 31000
  };
  return {
    service,
    close,
    createAttachment,
    emit,
    prepare: () =>
      service.handle(
        path === 'DIRECT'
          ? {
              ...binding,
              type: 'desktop.direct.prepare',
              transportSessionId: 'transport-1',
              browserFingerprint: fingerprint,
              nodeFingerprint: fingerprint
            }
          : { ...binding, type: 'desktop.relay.prepare', ticket: 't'.repeat(32) }
      ),
    open: (grant = binding.grant) =>
      channel.onmessage?.({ data: JSON.stringify({ type: 'OPEN', attachmentId, grant }) }),
    invalidate: () => {
      current = false;
    },
    deferCleanup: () => {
      cleanup = new Promise<void>((resolve) => (release = resolve));
    },
    release: () => release(),
    shutdown: () => service.shutdown(AbortSignal.timeout(1000))
  };
}

describe('Remote desktop connection takeover', () => {
  it.each<[Path, Path]>([
    ['DIRECT', 'DIRECT'],
    ['RELAY', 'RELAY'],
    ['DIRECT', 'RELAY'],
    ['RELAY', 'DIRECT']
  ])(
    'replaces an open %s attachment only after the new %s OPEN is valid',
    async (oldPath, newPath) => {
      const registry = new DesktopAttachmentRegistry();
      const old = fixture(registry, oldPath, 'attachment-old');
      const next = fixture(registry, newPath, 'attachment-next');
      old.deferCleanup();
      try {
        old.prepare();
        old.open();
        await Promise.resolve();
        next.prepare();
        expect(old.close).not.toHaveBeenCalled();
        next.open();
        expect(old.close).toHaveBeenCalledOnce();
        expect(next.createAttachment).toHaveBeenCalledOnce();
        expect(old.close.mock.invocationCallOrder[0]).toBeLessThan(
          next.createAttachment.mock.invocationCallOrder[0]!
        );
        expect(old.emit).not.toHaveBeenCalledWith(
          expect.objectContaining({ type: `desktop.${oldPath.toLowerCase()}.closed` })
        );
        old.release();
        await vi.waitFor(() =>
          expect(old.emit).toHaveBeenCalledWith(
            expect.objectContaining({
              type: `desktop.${oldPath.toLowerCase()}.closed`,
              code: 'DESKTOP_CONNECTION_REPLACED'
            })
          )
        );
        expect(next.close).not.toHaveBeenCalled();
      } finally {
        old.release();
        await Promise.all([old.shutdown(), next.shutdown()]);
      }
    }
  );

  it.each(['grant', 'topology'] as const)(
    'does not replace a valid attachment after an invalid %s',
    async (reason) => {
      const registry = new DesktopAttachmentRegistry();
      const old = fixture(registry, 'DIRECT', 'attachment-old');
      const next = fixture(registry, 'RELAY', 'attachment-next');
      try {
        old.prepare();
        old.open();
        next.prepare();
        if (reason === 'topology') next.invalidate();
        next.open(reason === 'grant' ? 'invalid-grant' : undefined);
        expect(old.close).not.toHaveBeenCalled();
        expect(next.createAttachment).not.toHaveBeenCalled();
      } finally {
        await Promise.all([old.shutdown(), next.shutdown()]);
      }
    }
  );

  it('keeps pending connections eligible and isolates other Node registries', async () => {
    const registry = new DesktopAttachmentRegistry();
    const first = fixture(registry, 'DIRECT', 'attachment-first');
    const pending = fixture(registry, 'RELAY', 'attachment-pending');
    const otherNode = fixture(new DesktopAttachmentRegistry(), 'DIRECT', 'attachment-other');
    try {
      pending.prepare();
      first.prepare();
      first.open();
      otherNode.prepare();
      otherNode.open();
      expect(pending.createAttachment).not.toHaveBeenCalled();
      pending.open();
      expect(pending.createAttachment).toHaveBeenCalledOnce();
      expect(first.close).toHaveBeenCalledOnce();
      expect(otherNode.close).not.toHaveBeenCalled();
    } finally {
      await Promise.all([first.shutdown(), pending.shutdown(), otherNode.shutdown()]);
    }
  });
});
