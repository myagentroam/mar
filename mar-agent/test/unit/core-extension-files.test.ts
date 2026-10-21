import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LocalFileAccess } from '../../src/agent-core/host/local-file-access.js';
import { WorkspacePathResolver } from '../../src/agent-core/tools/shared/path-resolver.js';
import { ExtensionSession } from '../../src/agent-core/extensions/session.js';
import {
  ExtensionOperations,
  type CoreOperationContext
} from '../../src/agent-core/extensions/operation.js';
import { ExtensionResourceScope } from '../../src/agent-core/extensions/resources.js';
import { ExtensionServices } from '../../src/agent-core/extensions/services.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const call = (signal = new AbortController().signal): CoreOperationContext => ({
  operationId: 'files-op',
  sessionId: 'session',
  sessionEpoch: 1,
  actor: 'extension',
  entry: 'native-api',
  signal
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'mar-extension-files-'));
  roots.push(root);
  return { root, files: new LocalFileAccess(new WorkspacePathResolver(root)) };
}

describe('Native file ports', () => {
  it('preserves non-text bytes beyond model-facing read limits and returns real metadata', async () => {
    const { root, files } = await fixture();
    const bytes = Uint8Array.from({ length: 2_097_177 }, (_, index) => index % 256);
    expect(
      await files.write({ path: 'nested/raw.bin', bytes, createParents: true }, call())
    ).toEqual({ bytesWritten: bytes.byteLength });
    expect(Buffer.compare(await files.read({ path: 'nested/raw.bin' }, call()), bytes)).toBe(0);
    const info = await files.stat({ path: 'nested/raw.bin' }, call());
    expect(info).toMatchObject({
      type: 'file',
      size: bytes.byteLength,
      modifiedAtMs: expect.any(Number),
      createdAtMs: expect.any(Number)
    });
    expect(await files.list({ path: 'nested' }, call())).toEqual([
      { name: 'raw.bin', type: 'file' }
    ]);
    await files.mkdir({ path: 'second' }, call());
    await files.copy({ from: 'nested/raw.bin', to: 'second/copy.bin' }, call());
    await files.move({ from: 'second/copy.bin', to: 'second/moved.bin' }, call());
    expect(Buffer.compare(await readFile(join(root, 'second/moved.bin')), bytes)).toBe(0);
    await files.remove({ path: 'second', recursive: true }, call());
    await expect(files.stat({ path: 'second/moved.bin' }, call())).rejects.toMatchObject({
      code: 'MAR_AGENT_FILE_OPERATION_FAILED',
      details: { operation: 'stat', reason: 'ENOENT' }
    });
  });

  it('inherits Host read-only mounts and path rules without extra Core restrictions', async () => {
    const { root } = await fixture();
    const workspace = join(root, 'workspace');
    const shared = join(root, 'shared');
    await mkdir(workspace);
    await mkdir(shared);
    await writeFile(join(shared, 'value.bin'), new Uint8Array([1, 0, 255]));
    const files = new LocalFileAccess(
      new WorkspacePathResolver(workspace, {
        restrictPaths: true,
        mounts: [{ logicalPath: '/shared', physicalPath: shared, writable: false }]
      })
    );
    expect(await files.read({ path: '/shared/value.bin' }, call())).toEqual(
      new Uint8Array([1, 0, 255])
    );
    await expect(
      files.write({ path: '/shared/value.bin', bytes: new Uint8Array([7]) }, call())
    ).rejects.toThrow(/read-only/);
    await expect(files.remove({ path: '/shared/value.bin' }, call())).rejects.toThrow(/read-only/);
    await expect(
      files.move({ from: '/shared/value.bin', to: 'moved.bin' }, call())
    ).rejects.toThrow(/read-only/);
    await expect(files.read({ path: '../outside.bin' }, call())).rejects.toThrow(/outside/);
    const unrestricted = new LocalFileAccess(new WorkspacePathResolver(workspace));
    expect(await unrestricted.read({ path: '../shared/value.bin' }, call())).toEqual(
      new Uint8Array([1, 0, 255])
    );
    const controller = new AbortController();
    controller.abort();
    await expect(
      unrestricted.write(
        { path: 'cancelled.bin', bytes: new Uint8Array([1]) },
        call(controller.signal)
      )
    ).rejects.toThrow();
    await expect(readFile(join(workspace, 'cancelled.bin'))).rejects.toMatchObject({
      code: 'ENOENT'
    });
  });

  it('records each real leaf before wrapping and revokes retained API handles on retirement', async () => {
    const { root, files } = await fixture();
    await writeFile(join(root, 'replacement.bin'), new Uint8Array([3, 4]));
    const session = new ExtensionSession(
      'session',
      1,
      new ExtensionServices('agent'),
      new ExtensionOperations(),
      { has: () => true, list: () => ['files'] },
      () => {},
      undefined,
      undefined,
      undefined,
      undefined,
      { files }
    );
    const scope = new ExtensionResourceScope();
    scope.activate();
    const context = session.context({ id: 'raw-files', apiVersion: '1.0' }, scope);
    const facts: number[] = [];
    context.hooks.observe('files.completed', (fact) => {
      if (fact.operation === 'read') facts.push(fact.output[0]!);
    });
    context.hooks.observe('files.completed', (fact) => {
      if (fact.operation === 'read') fact.output[0] = 254;
    });
    context.hooks.intercept('files.read', async (_input, effective, next) => {
      expect(effective.executionId).toBeUndefined();
      expect(effective.actor).toBe('extension');
      expect(effective.entry).toBe('native-api');
      const first = await next({ path: 'replacement.bin' });
      await next({ path: 'replacement.bin' });
      return new Uint8Array([99, ...first]);
    });
    expect(await context.files!.read({ path: 'missing.bin' })).toEqual(new Uint8Array([99, 3, 4]));
    expect(facts).toEqual([3, 3]);
    const writes: number[] = [];
    context.hooks.observe('files.completed', (fact) => {
      if (fact.operation === 'write') writes.push(fact.input.bytes[0]!);
    });
    const originalWrite = files.write.bind(files);
    files.write = async (input, call) => {
      const result = await originalWrite(input, call);
      input.bytes[0] = 9;
      return result;
    };
    await context.files!.write({ path: 'write.bin', bytes: new Uint8Array([1, 2]) });
    expect(writes).toEqual([1]);
    expect(new Uint8Array(await readFile(join(root, 'write.bin')))).toEqual(new Uint8Array([1, 2]));
    await scope.dispose();
    await expect(context.files!.read({ path: 'replacement.bin' })).rejects.toThrow(/RETIRED/);
    const noPorts = new ExtensionSession(
      'legacy',
      1,
      new ExtensionServices('agent'),
      new ExtensionOperations(),
      { has: () => false, list: () => [] },
      () => {}
    );
    const legacy = new ExtensionResourceScope();
    legacy.activate();
    expect(noPorts.context({ id: 'legacy', apiVersion: '1.0' }, legacy).files).toBeUndefined();
    const partial = new ExtensionSession(
      'partial',
      1,
      new ExtensionServices('agent'),
      new ExtensionOperations(),
      { has: () => true, list: () => ['files'] },
      () => {},
      undefined,
      undefined,
      undefined,
      undefined,
      { files: {} as never }
    );
    await expect(
      partial.context({ id: 'partial', apiVersion: '1.0' }, legacy).files!.read({ path: 'missing' })
    ).rejects.toMatchObject({ code: 'MAR_AGENT_HOST_PORT_UNAVAILABLE' });
    await legacy.dispose();
  });
});
