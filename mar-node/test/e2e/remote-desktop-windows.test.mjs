import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

// Opt-in native integration: owns only its VNC backend and never sends desktop input.
const enabled =
  process.platform === 'win32' && process.env.MAR_TEST_WINDOWS_DESKTOP_EXCLUSIVE === '1';

test(
  'Windows monitor topology matches the physical pixels of the managed VNC framebuffer',
  {
    skip: enabled ? false : 'Requires an exclusively allocated interactive Windows desktop.',
    timeout: 30_000
  },
  async () => {
    const dist = resolve(
      process.env.MAR_TEST_NODE_DIST ?? resolve(import.meta.dirname, '../../dist')
    );
    const load = (name) => import(pathToFileURL(resolve(dist, 'remote-desktop', name)).href);
    const { windowsManagedDesktopBinaries } = await load('windows-managed-binaries.js');
    const { WindowsRemoteDesktopRuntime } = await load('windows-remote-desktop-runtime.js');
    const { UltraVncManagedProcess } = await load('ultravnc-managed-process.js');
    const binaries = await windowsManagedDesktopBinaries();
    assert(binaries, 'Requires the packaged Windows UltraVNC backend.');
    const signal = AbortSignal.timeout(20_000);
    let runtime;
    let backend;
    let connection;
    try {
      runtime = await WindowsRemoteDesktopRuntime.start(
        { ...binaries, maxPixels: 67_108_864, fence() {} },
        signal
      );
      backend = await UltraVncManagedProcess.start({ ...binaries, onUnexpectedExit() {} }, signal);
      connection = await backend.connect(67_108_864, signal);
      const description = runtime.describe();
      assert.deepEqual(description.framebuffer, {
        width: connection.init.width,
        height: connection.init.height
      });
      assert(description.displays.length > 0);
      for (const display of description.displays) {
        assert.equal(display.nativeBounds.width, display.framebufferBounds.width);
        assert.equal(display.nativeBounds.height, display.framebufferBounds.height);
      }
    } finally {
      connection?.socket.destroy();
      try {
        await backend?.stop();
      } finally {
        await runtime?.dispose();
      }
    }
  }
);
