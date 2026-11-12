import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { unavailableCapabilities } from '../../src/capabilities.js';
import { NodeConnector } from '../../src/connector.js';
import * as binaries from '../../src/remote-desktop/linux-managed-binaries.js';
import { X11RemoteDesktopRuntime } from '../../src/remote-desktop/x11-remote-desktop-runtime.js';

const resources = { binaryPath: '/fixture/x0vncserver', topologyBinary: '/fixture/x11-topology' };
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'mar-desktop-recovery-'));
  vi.stubEnv('DISPLAY', ':101');
  const connector = new NodeConnector({ reconnect: false, capabilities: unavailableCapabilities(),
    config: { serverUrl: 'http://127.0.0.1:1', allowedRoots: [], dataDirectory: directory,
      nodeId: 'node-recovery', credential: 'fixture-credential' } });
  return {
    connector,
    internal: connector as unknown as { initializeDesktopRuntime(): Promise<void>; desktopRuntime?: X11RemoteDesktopRuntime },
    async cleanup() {
      await connector.stop();
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
      await rm(directory, { recursive: true, force: true });
    }
  };
}

it('retires an unavailable runtime and rediscovers only after its cleanup succeeds', async () => {
  const f = await fixture();
  const describe = vi.fn(() => ({ desktopGeneration: 'old', topologyRevision: 1 }));
  const dispose = vi.fn().mockRejectedValueOnce(new Error('cleanup incomplete')).mockResolvedValue(undefined);
  const old = { describe, dispose } as unknown as X11RemoteDesktopRuntime;
  const next = { describe: () => ({ desktopGeneration: 'new', topologyRevision: 1 }), dispose: vi.fn() } as unknown as X11RemoteDesktopRuntime;
  vi.spyOn(binaries, 'linuxManagedDesktopBinaries').mockResolvedValue(resources);
  const start = vi.spyOn(X11RemoteDesktopRuntime, 'start').mockResolvedValueOnce(old).mockResolvedValueOnce(next);
  try {
    await f.internal.initializeDesktopRuntime();
    describe.mockImplementation(() => { throw new Error('helper unavailable'); });
    await f.internal.initializeDesktopRuntime();
    expect(f.internal.desktopRuntime).toBe(old);
    expect(start).toHaveBeenCalledTimes(1);
    await f.internal.initializeDesktopRuntime();
    expect(f.internal.desktopRuntime).toBe(next);
    expect(start).toHaveBeenCalledTimes(2);
  } finally { await f.cleanup(); }
});

it('does not start a helper after stop while binary discovery is pending', async () => {
  const f = await fixture();
  let release!: (value: typeof resources) => void;
  vi.spyOn(binaries, 'linuxManagedDesktopBinaries').mockReturnValue(new Promise((resolve) => { release = resolve; }));
  const start = vi.spyOn(X11RemoteDesktopRuntime, 'start');
  const pending = f.internal.initializeDesktopRuntime();
  try {
    await f.connector.stop();
    release(resources);
    await pending;
    expect(start).not.toHaveBeenCalled();
  } finally { release(resources); await pending; await f.cleanup(); }
});

it('joins and disposes an already-starting helper before stop completes', async () => {
  const f = await fixture();
  let release!: (value: X11RemoteDesktopRuntime) => void;
  const dispose = vi.fn(async () => {});
  vi.spyOn(binaries, 'linuxManagedDesktopBinaries').mockResolvedValue(resources);
  const start = vi.spyOn(X11RemoteDesktopRuntime, 'start').mockReturnValue(new Promise((resolve) => { release = resolve; }));
  const pending = f.internal.initializeDesktopRuntime();
  try {
    await vi.waitFor(() => expect(start).toHaveBeenCalledOnce());
    let stopped = false;
    const stopping = f.connector.stop().then(() => { stopped = true; });
    await Promise.resolve();
    expect(stopped).toBe(false);
    release({ dispose } as unknown as X11RemoteDesktopRuntime);
    await stopping;
    await pending;
    expect(dispose).toHaveBeenCalledOnce();
    expect(f.internal.desktopRuntime).toBeUndefined();
  } finally { await f.cleanup(); }
});
