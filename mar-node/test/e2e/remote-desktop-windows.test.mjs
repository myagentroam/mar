import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { promisify } from 'node:util';

// Opt-in native integration: owns only its VNC backend and never sends desktop input.
const enabled =
  process.platform === 'win32' && process.env.MAR_TEST_WINDOWS_DESKTOP_EXCLUSIVE === '1';

async function assertLoopbackOnly(port) {
  assert(Number.isInteger(port), 'The authenticated RFB connection must have a peer port.');
  // Scope the check to the backend serving this connection, not other VNC processes.
  const query = `
$ErrorActionPreference = 'Stop'
$tcp = @(Get-NetTCPConnection -State Listen)
$rfb = @($tcp | Where-Object { $_.LocalAddress -eq '127.0.0.1' -and $_.LocalPort -eq ${port} })
if ($rfb.Count -ne 1) { throw 'Expected one IPv4 loopback RFB listener.' }
$owner = $rfb[0].OwningProcess
$udp = @(Get-NetUDPEndpoint | Where-Object { $_.OwningProcess -eq $owner })
@{
  tcp = @($tcp | Where-Object { $_.OwningProcess -eq $owner } | Select-Object LocalAddress, LocalPort)
  udp = @($udp | Select-Object LocalAddress, LocalPort)
} | ConvertTo-Json -Depth 3 -Compress`;
  const { stdout } = await promisify(execFile)(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', query],
    { timeout: 10_000, windowsHide: true }
  );
  const endpoints = JSON.parse(stdout);
  assert.deepEqual(endpoints.tcp, [{ LocalAddress: '127.0.0.1', LocalPort: port }]);
  assert.deepEqual(endpoints.udp, [], 'The managed VNC server must not open a UDP endpoint.');
}

test(
  'Windows managed VNC uses only TCP loopback and matches the physical monitor topology',
  {
    skip: enabled ? false : 'Requires an exclusively allocated interactive Windows desktop.',
    timeout: 40_000
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
      await assertLoopbackOnly(connection.socket.remotePort);
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
