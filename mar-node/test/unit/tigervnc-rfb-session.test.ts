import { Duplex } from 'node:stream';
import type { Socket } from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import { TigerVncRfbSession } from '../../src/remote-desktop/tigervnc-rfb-session.js';
import type { TigerVncManagedProcess } from '../../src/remote-desktop/tigervnc-managed-process.js';

class Peer extends Duplex {
  readonly writes: Buffer[] = [];
  override _read(): void {}
  override _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void
  ): void {
    this.writes.push(Buffer.from(chunk));
    callback();
  }
}

const banner = Buffer.from('RFB 003.008\n');
const key = Buffer.from([4, 1, 0, 0, 0, 0, 0, 97]);
const setup = (shared = 1) => Buffer.concat([banner, Buffer.from([1, shared])]);

function fixture(mode: 'VIEW' | 'CONTROL' = 'CONTROL') {
  const frontend = new Peer();
  const socket = new Peer();
  const init = Buffer.alloc(24);
  init.writeUInt16BE(800, 0);
  init.writeUInt16BE(600, 2);
  let receipt!: () => void;
  const ack = new Promise<void>((resolve) => (receipt = resolve));
  const wait = vi.fn(() => ack);
  const backend = {
    connect: vi.fn(async () => ({
      socket: socket as unknown as Socket,
      init: { width: 800, height: 600, serverInit: init }
    })),
    cleanup: { issue: vi.fn(() => ({ registration: Buffer.alloc(24, 42), wait })) }
  } as unknown as Pick<TigerVncManagedProcess, 'connect' | 'cleanup'>;
  const onFailure = vi.fn();
  const onAttached = vi.fn();
  let topology = true;
  let control = true;
  const options = {
    frontend,
    backend,
    mode,
    maxPixels: 1_000_000,
    isCurrentTopology: () => topology,
    isControlOwner: () => control,
    onAttached,
    onFailure
  };
  return {
    frontend,
    socket,
    init,
    receipt,
    wait,
    onFailure,
    onAttached,
    options,
    setTopology: (v: boolean) => (topology = v),
    setControl: (v: boolean) => (control = v)
  };
}

describe('TigerVNC RFB attachment session', () => {
  it('uses standard RFB release and closes the backend when no native ticket is available', async () => {
    const f = fixture();
    const options = { ...f.options, backend: { connect: f.options.backend.connect } };
    const opening = TigerVncRfbSession.open(options, AbortSignal.timeout(5_000));
    f.frontend.push(Buffer.concat([setup(), key, Buffer.from([5, 1, 0, 9, 0, 12])]));
    const session = await opening;
    await vi.waitFor(() => expect(f.socket.writes).toContainEqual(key));
    await session.close(AbortSignal.timeout(5_000));
    expect(f.socket.writes).toContainEqual(
      Buffer.concat([Buffer.from([4, 0, 0, 0, 0, 0, 0, 97]), Buffer.from([5, 0, 0, 9, 0, 12])])
    );
    expect(f.socket.writes).not.toContainEqual(Buffer.alloc(24, 42));
    expect(f.socket.destroyed).toBe(true);
    expect(f.wait).not.toHaveBeenCalled();
  });

  it('reclaims a standard attachment even when the backend has already failed', async () => {
    const f = fixture();
    const options = { ...f.options, backend: { connect: f.options.backend.connect } };
    const opening = TigerVncRfbSession.open(options, AbortSignal.timeout(5_000));
    f.frontend.push(Buffer.concat([setup(), key]));
    const session = await opening;
    await vi.waitFor(() => expect(f.socket.writes).toContainEqual(key));
    f.socket.destroy();
    await vi.waitFor(() => expect(f.onFailure).toHaveBeenCalled());
    await expect(session.close(AbortSignal.timeout(5_000))).resolves.toBeUndefined();
    expect(f.socket.closed).toBe(true);
  });

  it('announces ATTACHED before the client starts RFB without requiring a native ticket', async () => {
    const f = fixture();
    f.onAttached.mockImplementation(() => {
      expect(f.socket.writes).toEqual([]);
      expect(f.frontend.writes).toEqual([]);
      f.frontend.push(setup());
    });
    const session = await TigerVncRfbSession.open(f.options, AbortSignal.timeout(5_000));
    expect(f.onAttached).toHaveBeenCalledOnce();
    expect(f.frontend.writes[0]).toEqual(banner);
    await session.close(AbortSignal.timeout(5_000));
    expect(f.wait).not.toHaveBeenCalled();
  });

  it('bridges both directions and releases held input before closing without a native receipt', async () => {
    const f = fixture();
    const opening = TigerVncRfbSession.open(f.options, AbortSignal.timeout(5_000));
    f.frontend.push(Buffer.concat([setup(), key]));
    const session = await opening;
    await vi.waitFor(() => expect(f.socket.writes).toContainEqual(key));
    expect(f.socket.writes[0]).toEqual(key);
    f.socket.push(Buffer.from([0, 1, 2]));
    await vi.waitFor(() => expect(f.frontend.writes).toContainEqual(Buffer.from([0, 1, 2])));
    await session.close(AbortSignal.timeout(5_000));
    expect(f.frontend.destroyed).toBe(true);
    expect(f.socket.destroyed).toBe(true);
    expect(f.socket.writes).toContainEqual(Buffer.from([4, 0, 0, 0, 0, 0, 0, 97]));
    expect(f.wait).not.toHaveBeenCalled();
    expect(f.onFailure).not.toHaveBeenCalled();
  });

  it('synchronously fences both streams before the backend closes', async () => {
    const f = fixture('VIEW');
    const opening = TigerVncRfbSession.open(f.options, AbortSignal.timeout(5_000));
    f.frontend.push(setup());
    const session = await opening;
    const writesBefore = f.frontend.writes.length;
    session.fence();
    expect(f.frontend.destroyed).toBe(true);
    f.socket.push(Buffer.from([42, 43]));
    expect(f.frontend.writes).toHaveLength(writesBefore);
    await session.close(AbortSignal.timeout(5_000));
    expect(f.socket.closed).toBe(true);
  });

  it('fences and closes a VIEW attachment that attempts input', async () => {
    const f = fixture('VIEW');
    const opening = TigerVncRfbSession.open(f.options, AbortSignal.timeout(5_000));
    f.frontend.push(Buffer.concat([setup(), key]));
    const session = await opening;
    await vi.waitFor(() =>
      expect(f.onFailure).toHaveBeenCalledExactlyOnceWith('DESKTOP_INPUT_DENIED')
    );
    expect(f.socket.writes).not.toContainEqual(key);
    await session.close(AbortSignal.timeout(5_000));
    expect(f.socket.closed).toBe(true);
    expect(f.onFailure).toHaveBeenCalledOnce();
  });

  it('rejects exclusive frontend setup after closing the backend', async () => {
    const f = fixture();
    const opening = TigerVncRfbSession.open(f.options, AbortSignal.timeout(5_000));
    const rejected = expect(opening).rejects.toMatchObject({ code: 'DESKTOP_RFB_INVALID' });
    f.frontend.push(setup(0));
    await rejected;
    expect(f.socket.closed).toBe(true);
  });

  it('reclaims the backend after setup rejection without a native receipt', async () => {
    const f = fixture();
    const opening = TigerVncRfbSession.open(f.options, AbortSignal.timeout(5_000));
    f.frontend.push(setup(0));
    await expect(opening).rejects.toMatchObject({ code: 'DESKTOP_RFB_INVALID' });
    expect(f.socket.closed).toBe(true);
    expect(f.wait).not.toHaveBeenCalled();
  });

  it('refuses activation when topology becomes stale during frontend setup', async () => {
    const f = fixture();
    const opening = TigerVncRfbSession.open(f.options, AbortSignal.timeout(5_000));
    const rejected = expect(opening).rejects.toMatchObject({
      code: 'DESKTOP_TOPOLOGY_UNAVAILABLE'
    });
    await vi.waitFor(() => expect(f.onAttached).toHaveBeenCalledOnce());
    f.setTopology(false);
    f.frontend.push(setup());
    await rejected;
    expect(f.socket.closed).toBe(true);
  });

  it('fences actual input if control ownership changes', async () => {
    const f = fixture();
    const opening = TigerVncRfbSession.open(f.options, AbortSignal.timeout(5_000));
    f.frontend.push(setup());
    const session = await opening;
    f.setControl(false);
    f.frontend.push(key);
    await vi.waitFor(() =>
      expect(f.onFailure).toHaveBeenCalledExactlyOnceWith('DESKTOP_CONTROL_LOST')
    );
    expect(f.socket.writes).not.toContainEqual(key);
    f.receipt();
    await session.close(AbortSignal.timeout(5_000));
  });

  it('rejects input after the confirmed topology becomes stale', async () => {
    const f = fixture();
    const opening = TigerVncRfbSession.open(f.options, AbortSignal.timeout(5_000));
    f.frontend.push(setup());
    const session = await opening;
    f.setTopology(false);
    f.frontend.push(key);
    await vi.waitFor(() =>
      expect(f.onFailure).toHaveBeenCalledExactlyOnceWith('DESKTOP_CONTROL_LOST')
    );
    expect(f.socket.writes).not.toContainEqual(key);
    f.receipt();
    await session.close(AbortSignal.timeout(5_000));
  });

  it('automatically fences and cleans its own backend after frontend EOF', async () => {
    const f = fixture();
    const opening = TigerVncRfbSession.open(f.options, AbortSignal.timeout(5_000));
    f.frontend.push(setup());
    const session = await opening;
    f.frontend.push(null);
    await vi.waitFor(() =>
      expect(f.onFailure).toHaveBeenCalledExactlyOnceWith('DESKTOP_TRANSPORT_ERROR')
    );
    await session.close(AbortSignal.timeout(5_000));
    expect(f.socket.destroyed).toBe(true);
  });

  it('preserves a backend failure during frontend setup after connection cleanup', async () => {
    const f = fixture();
    const opening = TigerVncRfbSession.open(f.options, AbortSignal.timeout(5_000));
    const rejected = expect(opening).rejects.toMatchObject({ code: 'DESKTOP_TRANSPORT_ERROR' });
    await vi.waitFor(() => expect(f.onAttached).toHaveBeenCalledOnce());
    f.socket.emit('error', new Error('private backend detail'));
    await rejected;
    expect(f.frontend.destroyed).toBe(true);
  });
});
