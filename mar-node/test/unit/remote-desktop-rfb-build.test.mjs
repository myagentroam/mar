import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Writable } from 'node:stream';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const nodeRoot = fileURLToPath(new URL('../../', import.meta.url));
const require = createRequire(import.meta.url);

test('compiled RFB gate initializes its limits and forwards a framebuffer request', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mar-rfb-build-'));
  try {
    const config = join(directory, 'tsconfig.json');
    await writeFile(
      config,
      JSON.stringify({
        extends: join(nodeRoot, 'tsconfig.json'),
        compilerOptions: {
          outDir: join(directory, 'dist'),
          types: ['node'],
          typeRoots: [dirname(dirname(require.resolve('@types/node/package.json')))]
        },
        files: [join(nodeRoot, 'src/remote-desktop/rfb-client-gate.ts')],
        include: []
      })
    );
    await writeFile(join(directory, 'package.json'), JSON.stringify({ type: 'module' }));
    execFileSync(process.execPath, [require.resolve('typescript/bin/tsc'), '-p', config], {
      timeout: 20_000,
      stdio: 'inherit'
    });
    const { RfbClientGate } = await import(
      pathToFileURL(join(directory, 'dist/remote-desktop/rfb-client-gate.js')).href
    );
    assert.equal(RfbClientGate.maxClipboardBytes, 1024 * 1024);
    assert.equal(RfbClientGate.maxFrameBytes, 1024 * 1024 + 8);
    const writes = [];
    const backend = new Writable({
      write(chunk, _encoding, callback) {
        writes.push(Buffer.from(chunk));
        callback();
      }
    });
    const gate = new RfbClientGate(backend, 'VIEW', () => false, assert.fail);
    try {
      const request = Buffer.from([3, 0, 0, 0, 0, 0, 0, 2, 0, 2]);
      gate.receive(request);
      assert.deepEqual(writes, [request]);
      assert.deepEqual(await gate.fence(), { keys: [], buttons: 0, x: 0, y: 0 });
    } finally {
      gate.dispose();
      backend.destroy();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
