import { describe, expect, it, vi } from 'vitest';
import type { RemoteDesktopDirectNodeCommand } from '@myagentroam/protocol';
import type { RTCPeerConnection as NodeRTCPeerConnection } from 'node-datachannel/polyfill';
import { DirectDesktopService } from '../../src/remote-desktop/direct-desktop-service.js';
import { RelayDesktopService } from '../../src/remote-desktop/relay-desktop-service.js';
import { DesktopAttachmentRegistry } from '../../src/remote-desktop/desktop-service-core.js';
import type { RemoteDesktopAttachment } from '../../src/remote-desktop/remote-desktop-attachment.js';

const fingerprint = `sha-256 ${'AA:'.repeat(31)}AA`;
const command: Extract<RemoteDesktopDirectNodeCommand, { type: 'desktop.direct.prepare' }> = {
  type: 'desktop.direct.prepare',
  attachmentId: 'attachment-1',
  transportSessionId: 'transport-1',
  workbenchConnectionId: 'workbench-1',
  nodeGeneration: 'generation-1',
  desktopGeneration: 'desktop-1',
  topologyRevision: 1,
  mode: 'VIEW',
  grant: '0123456789abcdef'.repeat(4),
  browserFingerprint: fingerprint,
  nodeFingerprint: fingerprint,
  openExpiresAt: 16_000,
  expiresAt: 31_000
};

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function fixture(slots?: DesktopAttachmentRegistry) {
  let now = 1_000;
  let current = true;
  const opened = deferred();
  const cleaned = deferred();
  const channel = {
    readyState: 'connecting',
    bufferedAmount: 0,
    onmessage: null as ((event: { data: unknown }) => void) | null,
    onclose: null as (() => void) | null,
    onerror: null as (() => void) | null,
    send: vi.fn(),
    close: vi.fn()
  };
  const peer = { createDataChannel: vi.fn(() => channel), sctp: { maxMessageSize: 65_536 } };
  const emit = vi.fn(() => true);
  const close = vi.fn(() => cleaned.promise);
  const open = vi.fn(() => opened.promise);
  let attached!: () => void;
  const createAttachment = vi.fn((_command, stream, callbacks) => {
    stream.on('error', () => {});
    attached = callbacks.attached;
    return { open, close } as unknown as RemoteDesktopAttachment;
  });
  const service = new DirectDesktopService({
    ...(slots === undefined ? {} : { registry: slots }),
    nodeGeneration: () => 'generation-1',
    peer: () => (current ? (peer as unknown as NodeRTCPeerConnection) : undefined),
    isCurrent: () => current,
    createAttachment,
    emit,
    now: () => now
  });
  const message = () =>
    channel.onmessage?.({
      data: JSON.stringify({
        type: 'OPEN',
        attachmentId: command.attachmentId,
        grant: command.grant
      })
    });
  return {
    service,
    channel,
    peer,
    emit,
    open,
    close,
    opened,
    cleaned,
    createAttachment,
    message,
    attached: () => attached(),
    setNow: (value: number) => {
      now = value;
    },
    invalidate: () => {
      current = false;
    }
  };
}

describe('Direct desktop Node lifecycle', () => {
  it('shares attachment identity with Relay without a fixed count or false cleanup', async () => {
    const slots = new DesktopAttachmentRegistry();
    const f = fixture(slots);
    const events = vi.fn(() => true);
    const connect = vi.fn(
      () =>
        ({
          readyState: 0,
          terminate: vi.fn(),
          onmessage: null,
          onclose: null,
          onerror: null,
          onopen: null
        }) as unknown as import('ws').WebSocket
    );
    const relay = new RelayDesktopService({
      registry: slots,
      nodeId: 'node-a',
      nodeGeneration: () => 'generation-1',
      now: () => 1000,
      connect,
      credential: () => 'test',
      isCurrent: () => true,
      createAttachment: vi.fn(),
      emit: events
    });
    const relayPrepare = {
      type: 'desktop.relay.prepare',
      attachmentId: command.attachmentId,
      workbenchConnectionId: command.workbenchConnectionId,
      nodeGeneration: command.nodeGeneration,
      desktopGeneration: command.desktopGeneration,
      topologyRevision: command.topologyRevision,
      mode: command.mode,
      grant: command.grant,
      ticket: 't'.repeat(32),
      openExpiresAt: command.openExpiresAt,
      expiresAt: command.expiresAt
    };
    try {
      f.service.handle(command);
      relay.handle(relayPrepare);
      relay.handle({
        type: 'desktop.relay.cancel',
        attachmentId: command.attachmentId,
        code: 'DESKTOP_CLOSED'
      });
      expect(connect).not.toHaveBeenCalled();
      expect(events).not.toHaveBeenCalled();
      for (let i = 2; i <= 4; i++)
        relay.handle({ ...relayPrepare, attachmentId: `attachment-${i}` });
      expect(connect).toHaveBeenCalledTimes(3);
      relay.handle({ ...relayPrepare, attachmentId: 'attachment-5' });
      expect(connect).toHaveBeenCalledTimes(4);
      f.service.handle({
        type: 'desktop.direct.cancel',
        attachmentId: command.attachmentId,
        code: 'DESKTOP_CLOSED'
      });
      await vi.waitFor(() =>
        expect(f.emit).toHaveBeenCalledWith(
          expect.objectContaining({ type: 'desktop.direct.closed' })
        )
      );
      relay.handle({ ...relayPrepare, attachmentId: 'attachment-6' });
      expect(connect).toHaveBeenCalledTimes(5);
    } finally {
      f.service.dispose();
      relay.dispose();
    }
  });

  it('replies idempotently to a repeated cancellation after native cleanup', async () => {
    const f = fixture();
    f.service.handle(command);
    f.channel.readyState = 'open';
    f.message();
    f.attached();
    f.service.handle({
      type: 'desktop.direct.cancel',
      attachmentId: command.attachmentId,
      code: 'DESKTOP_CANCELLED'
    });
    f.cleaned.resolve();
    await vi.waitFor(() =>
      expect(f.emit).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'desktop.direct.closed' })
      )
    );
    f.emit.mockClear();
    f.service.handle({
      type: 'desktop.direct.cancel',
      attachmentId: command.attachmentId,
      code: 'DESKTOP_CANCELLED'
    });
    expect(f.emit).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'desktop.direct.closed', nodeGeneration: 'generation-1' })
    );
    expect(f.close).toHaveBeenCalledOnce();
    f.service.dispose();
  });

  it('does not accept OPEN on a locally created channel before it is actually open', async () => {
    const f = fixture();
    f.service.handle(command);
    expect(f.peer.createDataChannel).toHaveBeenCalledWith('mar-desktop-attachment-1', {
      ordered: true
    });
    f.message();
    expect(f.createAttachment).not.toHaveBeenCalled();
    await vi.waitFor(() =>
      expect(f.emit).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'desktop.direct.closed' })
      )
    );
    f.service.dispose();
  });

  it('requires both Node RFB initialization and browser ready and waits for cleanup on invalidation', async () => {
    const f = fixture();
    f.service.handle(command);
    f.channel.readyState = 'open';
    f.message();
    expect(f.open).toHaveBeenCalledOnce();
    f.attached();
    f.service.handle({ type: 'desktop.ready', attachmentId: command.attachmentId });
    expect(f.emit).not.toHaveBeenCalledWith(expect.objectContaining({ phase: 'ACTIVE' }));
    f.opened.resolve();
    await vi.waitFor(() =>
      expect(f.emit).toHaveBeenCalledWith(expect.objectContaining({ phase: 'ACTIVE' }))
    );
    f.service.invalidate('DESKTOP_TOPOLOGY_UNAVAILABLE');
    expect(f.close).toHaveBeenCalledOnce();
    expect(f.emit).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'desktop.direct.closed' })
    );
    f.cleaned.resolve();
    await vi.waitFor(() =>
      expect(f.emit).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'desktop.direct.closed',
          code: 'DESKTOP_TOPOLOGY_UNAVAILABLE'
        })
      )
    );
    f.service.dispose();
  });

  it('does not open a stale topology or an expired OPEN window', async () => {
    const f = fixture();
    f.service.handle(command);
    f.channel.readyState = 'open';
    f.setNow(16_000);
    f.message();
    expect(f.createAttachment).not.toHaveBeenCalled();
    await vi.waitFor(() =>
      expect(f.emit).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'desktop.direct.closed' })
      )
    );
    f.service.dispose();
  });

  it('does not start an attachment after the bound transport is replaced', async () => {
    const f = fixture();
    f.service.handle(command);
    f.channel.readyState = 'open';
    f.invalidate();
    f.message();
    expect(f.createAttachment).not.toHaveBeenCalled();
    await vi.waitFor(() =>
      expect(f.emit).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'desktop.direct.closed' })
      )
    );
    f.service.dispose();
  });

  it('retains the attachment until native cleanup succeeds, including after a failed attempt', async () => {
    const f = fixture();
    f.close.mockRejectedValueOnce(new Error('native cleanup failed')).mockResolvedValueOnce();
    f.service.handle(command);
    f.channel.readyState = 'open';
    f.message();
    f.attached();
    f.opened.resolve();
    f.service.handle({
      type: 'desktop.direct.cancel',
      attachmentId: command.attachmentId,
      code: 'DESKTOP_CANCELLED'
    });
    await vi.waitFor(() => expect(f.close).toHaveBeenCalledOnce());
    await Promise.resolve();
    expect(f.emit).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'desktop.direct.closed' })
    );
    f.service.handle({
      type: 'desktop.direct.cancel',
      attachmentId: command.attachmentId,
      code: 'DESKTOP_CANCELLED'
    });
    await vi.waitFor(() =>
      expect(f.emit).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'desktop.direct.closed' })
      )
    );
    expect(f.close).toHaveBeenCalledTimes(2);
    f.service.dispose();
  });

  it('cannot extend the setup deadline by refreshing the attachment lease', async () => {
    const f = fixture();
    f.service.handle(command);
    f.channel.readyState = 'open';
    f.message();
    f.attached();
    f.setNow(15_999);
    f.service.handle({
      type: 'desktop.direct.heartbeat',
      attachmentId: command.attachmentId,
      expiresAt: 45_999
    });
    f.setNow(16_000);
    f.service.handle({ type: 'desktop.ready', attachmentId: command.attachmentId });
    f.opened.resolve();
    await vi.waitFor(() => expect(f.close).toHaveBeenCalledOnce());
    expect(f.emit).not.toHaveBeenCalledWith(expect.objectContaining({ phase: 'ACTIVE' }));
    f.cleaned.resolve();
    await vi.waitFor(() =>
      expect(f.emit).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'desktop.direct.closed' })
      )
    );
    f.service.dispose();
  });

  it('caps the OPEN window locally even if the Server clock is far ahead', async () => {
    const f = fixture();
    f.service.handle({ ...command, openExpiresAt: 3_600_000, expiresAt: 3_600_000 });
    f.channel.readyState = 'open';
    f.setNow(16_000);
    f.message();
    expect(f.createAttachment).not.toHaveBeenCalled();
    await vi.waitFor(() =>
      expect(f.emit).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'desktop.direct.closed' })
      )
    );
    f.service.dispose();
  });

  it('continues native cleanup retries after disposal instead of abandoning the owner', async () => {
    vi.useFakeTimers();
    try {
      const f = fixture();
      f.close.mockRejectedValueOnce(new Error('cleanup pending')).mockResolvedValueOnce();
      f.service.handle(command);
      f.channel.readyState = 'open';
      f.message();
      f.attached();
      f.opened.resolve();
      f.service.dispose();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(f.close).toHaveBeenCalledTimes(2);
      expect(f.emit).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'desktop.direct.closed' })
      );
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('waits for native cleanup on shutdown without treating a lost closed event as cleanup failure', async () => {
    const slots = new DesktopAttachmentRegistry();
    const f = fixture(slots);
    f.service.handle(command);
    f.channel.readyState = 'open';
    f.message();
    f.attached();
    f.opened.resolve();
    f.emit.mockReturnValue(false);
    let finished = false;
    const shutdown = f.service.shutdown(AbortSignal.timeout(5_000)).then(() => {
      finished = true;
    });
    await Promise.resolve();
    expect(f.close).toHaveBeenCalledOnce();
    expect(finished).toBe(false);
    expect(slots.has(command.attachmentId)).toBe(true);
    f.cleaned.resolve();
    await shutdown;
    expect(finished).toBe(true);
    // Native cleanup and Server receipt are distinct: keep retry ownership and quota.
    expect(slots.has(command.attachmentId)).toBe(true);
    f.emit.mockReturnValue(true);
    f.service.handle({
      type: 'desktop.direct.cancel',
      attachmentId: command.attachmentId,
      code: 'DESKTOP_CLOSED'
    });
    expect(slots.has(command.attachmentId)).toBe(false);
  });

  it('reports bounded shutdown failure while retaining the native cleanup owner', async () => {
    const slots = new DesktopAttachmentRegistry();
    const f = fixture(slots);
    f.service.handle(command);
    f.channel.readyState = 'open';
    f.message();
    f.attached();
    f.opened.resolve();
    const controller = new AbortController();
    const shutdown = f.service.shutdown(controller.signal);
    controller.abort();
    await expect(shutdown).rejects.toMatchObject({ code: 'DESKTOP_NATIVE_CLEANUP_TIMEOUT' });
    expect(slots.has(command.attachmentId)).toBe(true);
    expect(f.emit).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'desktop.direct.closed' })
    );
    f.cleaned.resolve();
    await vi.waitFor(() => expect(slots.has(command.attachmentId)).toBe(false));
  });

  it('suspends admission until native cleanup, retaining undelivered close ownership on resume', async () => {
    const slots = new DesktopAttachmentRegistry();
    const f = fixture(slots);
    try {
      f.service.handle(command);
      f.channel.readyState = 'open';
      f.message();
      f.attached();
      f.opened.resolve();
      f.emit.mockReturnValue(false);
      const controller = new AbortController();
      const pending = f.service.suspend(controller.signal);
      expect(f.close).toHaveBeenCalledOnce();
      expect(f.service.resume()).toBe(false);
      f.service.handle({ ...command, attachmentId: 'attachment-2' });
      expect(f.peer.createDataChannel).toHaveBeenCalledOnce();
      controller.abort();
      await expect(pending).rejects.toMatchObject({ code: 'DESKTOP_NATIVE_CLEANUP_TIMEOUT' });
      expect(f.service.resume()).toBe(false);
      f.cleaned.resolve();
      await vi.waitFor(() => expect(f.service.resume()).toBe(true));
      expect(slots.has(command.attachmentId)).toBe(true);
      f.emit.mockReturnValue(true);
      f.service.handle({
        type: 'desktop.direct.cancel',
        attachmentId: command.attachmentId,
        code: 'DESKTOP_CLOSED'
      });
      expect(slots.has(command.attachmentId)).toBe(false);
      f.service.handle({ ...command, attachmentId: 'attachment-3' });
      expect(f.peer.createDataChannel).toHaveBeenCalledTimes(2);
    } finally {
      f.service.dispose();
    }
  });
});
