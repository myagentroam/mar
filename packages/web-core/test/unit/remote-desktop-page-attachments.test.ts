import { describe, expect, it, vi } from 'vitest';
import { createRemoteDesktopPageAttachments } from '../../src/service/remote-desktop-page-attachments.js';
import { RemoteDesktopClientError } from '../../src/service/remote-desktop-client-core.js';
import type { RemoteDesktopChannel } from '../../src/service/remote-desktop-channel.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function attachment() {
  const settlement = deferred<boolean>();
  return {
    settlement,
    channel: {} as RemoteDesktopChannel,
    ready: vi.fn(),
    close: vi.fn(() => settlement.promise)
  };
}
function fixture() {
  const direct = { attach: vi.fn(), close: vi.fn() };
  const relay = { attach: vi.fn(), close: vi.fn() };
  const service = createRemoteDesktopPageAttachments({ direct, relay });
  const target = {
    nodeId: 'node',
    nodeGeneration: 'node-generation',
    desktopGeneration: 'desktop-generation',
    topologyRevision: 1,
    mode: 'CONTROL' as const,
    signal: new AbortController().signal,
    onDisconnected: vi.fn()
  };
  return { direct, relay, service, target };
}

describe('remote desktop page attachment ownership', () => {
  it('fences immediately and waits for actual settlement before switching path or mode', async () => {
    const f = fixture();
    const old = attachment();
    const next = attachment();
    f.direct.attach.mockResolvedValueOnce(old).mockResolvedValueOnce(undefined);
    f.relay.attach.mockResolvedValueOnce(next);
    const previous = await f.service.select(f.target);
    const switching = f.service.select({ ...f.target, mode: 'VIEW' });
    expect(old.close).toHaveBeenCalledOnce();
    previous.ready();
    expect(old.ready).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(f.relay.attach).not.toHaveBeenCalled();
    old.settlement.resolve(true);
    const replacement = await switching;
    expect(f.relay.attach).toHaveBeenCalledOnce();
    expect(await previous.close()).toBe(true);
    replacement.ready();
    expect(next.ready).toHaveBeenCalledOnce();
    const end = replacement.close();
    next.settlement.resolve(true);
    expect(await end).toBe(true);
    expect(await f.service.close()).toBe(true);
  });
  it('never switches or falls back when settlement is unknown', async () => {
    const f = fixture();
    const old = attachment();
    f.direct.attach.mockResolvedValue(old);
    await f.service.select(f.target);
    const switching = f.service.select({ ...f.target, mode: 'VIEW' });
    old.settlement.resolve(false);
    await expect(switching).rejects.toMatchObject({ code: 'DESKTOP_CONTROL_UNAVAILABLE' });
    await expect(f.service.select(f.target)).rejects.toMatchObject({
      code: 'DESKTOP_CONTROL_UNAVAILABLE'
    });
    expect(f.direct.attach).toHaveBeenCalledOnce();
    expect(f.relay.attach).not.toHaveBeenCalled();
    expect(await f.service.close()).toBe(false);
  });
  it('treats a synchronous close failure as unknown instead of opening the other path', async () => {
    const f = fixture();
    const old = attachment();
    old.close.mockImplementation(() => {
      throw new Error('socket close failure');
    });
    f.direct.attach.mockResolvedValueOnce(old);
    await f.service.select(f.target);
    await expect(f.service.select(f.target)).rejects.toMatchObject({
      code: 'DESKTOP_CONTROL_UNAVAILABLE'
    });
    expect(f.relay.attach).not.toHaveBeenCalled();
    expect(await f.service.close()).toBe(false);
  });
  it('falls back only for a settled transport failure, never an unavailable topology', async () => {
    const f = fixture();
    const failure = new RemoteDesktopClientError('DESKTOP_TRANSPORT_ERROR');
    failure.settlement = Promise.resolve(true);
    failure.confirmedCode = 'DESKTOP_TRANSPORT_ERROR';
    const relay = attachment();
    f.direct.attach.mockRejectedValueOnce(failure);
    f.relay.attach.mockResolvedValueOnce(relay);
    const handle = await f.service.select(f.target);
    const end = handle.close();
    relay.settlement.resolve(true);
    expect(await end).toBe(true);
    const unavailable = new RemoteDesktopClientError('DESKTOP_TOPOLOGY_UNAVAILABLE');
    unavailable.settlement = Promise.resolve(true);
    f.direct.attach.mockRejectedValueOnce(unavailable);
    await expect(f.service.select(f.target)).rejects.toMatchObject({ code: 'DESKTOP_TOPOLOGY_UNAVAILABLE' });
    expect(f.relay.attach).toHaveBeenCalledOnce();
    expect(await f.service.close()).toBe(true);
  });
  it('does not misclassify a data-first close after the confirmed topology error', async () => {
    const f = fixture();
    const confirmation = deferred<boolean>();
    const failure = new RemoteDesktopClientError('DESKTOP_TRANSPORT_ERROR');
    failure.settlement = confirmation.promise;
    f.direct.attach.mockRejectedValueOnce(failure);
    const pending = f.service.select(f.target);
    await Promise.resolve();
    failure.confirmedCode = 'DESKTOP_TOPOLOGY_UNAVAILABLE';
    confirmation.resolve(true);
    await expect(pending).rejects.toMatchObject({ code: 'DESKTOP_TOPOLOGY_UNAVAILABLE' });
    expect(f.relay.attach).not.toHaveBeenCalled();
    expect(await f.service.close()).toBe(true);
  });
  it('aborts an opening attempt and does not let its unknown outcome authorize a replacement', async () => {
    const f = fixture();
    const settlement = deferred<boolean>();
    const failure = new RemoteDesktopClientError('DESKTOP_CONTROL_UNAVAILABLE');
    failure.settlement = settlement.promise;
    f.direct.attach.mockImplementation(
      (input) =>
        new Promise((_resolve, reject) => {
          input.signal.addEventListener('abort', () => reject(failure), { once: true });
        })
    );
    const first = f.service.select(f.target);
    await vi.waitFor(() => expect(f.direct.attach).toHaveBeenCalledOnce());
    const second = f.service.select(f.target);
    settlement.resolve(false);
    await expect(first).rejects.toBe(failure);
    await expect(second).rejects.toMatchObject({ code: 'DESKTOP_CONTROL_UNAVAILABLE' });
    expect(f.direct.attach).toHaveBeenCalledOnce();
    expect(f.relay.attach).not.toHaveBeenCalled();
    expect(await f.service.close()).toBe(false);
  });
});
