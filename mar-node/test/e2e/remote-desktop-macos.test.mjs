import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

// Explicit native capture acceptance; never sends keyboard or pointer input.
const enabled =
  process.platform === 'darwin' && process.env.MAR_TEST_MACOS_DESKTOP_EXCLUSIVE === '1';
test(
  'macVNC captures selected displays independently and matches their physical framebuffers',
  {
    skip: enabled
      ? false
      : 'Requires an exclusively allocated interactive macOS desktop with two displays.',
    timeout: 45_000
  },
  async () => {
    const dist = resolve(
      process.env.MAR_TEST_NODE_DIST ?? resolve(import.meta.dirname, '../../dist')
    );
    const load = (name) => import(pathToFileURL(resolve(dist, 'remote-desktop', name)).href);
    const { macosManagedDesktopBinaries } = await load('macos-managed-binaries.js');
    const { MacosRemoteDesktopRuntime } = await load('macos-remote-desktop-runtime.js');
    const { MacVncManagedProcess } = await load('macvnc-managed-process.js');
    const binaries = await macosManagedDesktopBinaries();
    assert(binaries, 'Requires the packaged macVNC backend and topology helper.');
    const signal = AbortSignal.timeout(35_000);
    const backends = [];
    const connections = [];
    let runtime;
    try {
      runtime = await MacosRemoteDesktopRuntime.start(
        { ...binaries, maxPixels: 67_108_864, fence() {} },
        signal
      );
      const primary = runtime.describe();
      assert(
        primary.selectableDisplays?.length >= 2,
        'This regression requires two active displays.'
      );
      const raw = JSON.parse(
        (await promisify(execFile)(binaries.topologyBinary, [], { encoding: 'utf8', signal }))
          .stdout
      );
      const descriptions = [];
      for (const display of primary.selectableDisplays.slice(0, 2)) {
        const description = runtime.describe({ displayId: display.displayId });
        descriptions.push(description);
        const displayIndex = raw.displays.findIndex(
          (screen) => `display_${screen.id}` === display.displayId
        );
        assert(displayIndex >= 0);
        const backend = await MacVncManagedProcess.start(
          { ...binaries, displayIndex, onUnexpectedExit() {} },
          signal
        );
        backends.push(backend);
        const connection = await backend.connect(67_108_864, signal);
        connections.push(connection);
        assert.deepEqual(description.framebuffer, {
          width: connection.init.width,
          height: connection.init.height
        });
        assert.equal(description.displays[0].displayId, display.displayId);
      }
      assert.notEqual(descriptions[0].desktopGeneration, descriptions[1].desktopGeneration);
      const stillOpen = await backends[0].connect(67_108_864, signal);
      connections.push(stillOpen);
      assert.deepEqual(descriptions[0].framebuffer, {
        width: stillOpen.init.width,
        height: stillOpen.init.height
      });
      assert.deepEqual(runtime.describe(), primary);
    } finally {
      connections.forEach((connection) => connection.socket.destroy());
      await Promise.allSettled([
        ...backends.map((backend) => backend.stop()),
        runtime?.dispose()
      ]).then((results) => {
        for (const result of results) if (result.status === 'rejected') throw result.reason;
      });
    }
  }
);
