import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { ApplyPatchTool, applyPatchToolDefinition } from '../../src/tools/local/apply-patch.js';
import { ReadTool, readToolDefinition } from '../../src/tools/local/read.js';
import { WorkspacePathResolver } from '../../src/tools/shared/path-resolver.js';
import { scheduleToolCallBatch } from '../../src/tools/scheduler.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve };
}

it('queues a whole patch per tool instance while another safe tool can run', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mar-patch-fifo-'));
  const entered = deferred();
  const resume = deferred();
  const otherRan = deferred();
  await writeFile(join(root, 'unrelated'), 'readable\n');
  const read = new ReadTool(new WorkspacePathResolver(root));
  const patch = new ApplyPatchTool(new WorkspacePathResolver(root), {
    rename: async (source, target) => {
      if (target === join(root, 'first')) {
        entered.resolve();
        await resume.promise;
      }
      await rename(source, target);
    }
  });
  try {
    const first = patch.execute('*** Begin Patch\n*** Add File: first\n+one\n*** End Patch');
    await entered.promise;
    let invalidSettled = false;
    const invalid = patch.execute('not a patch').then(
      () => {
        invalidSettled = true;
        return 'resolved';
      },
      () => {
        invalidSettled = true;
        return 'rejected';
      }
    );
    let secondDone = false;
    let readText: string | undefined;
    const calls = scheduleToolCallBatch(
      [{ name: 'apply_patch' }, { name: 'read' }],
      [applyPatchToolDefinition, readToolDefinition],
      async (call) => {
        if (call.name === 'read') {
          readText = (await read.execute({ reads: [{ path: 'unrelated' }] })).results[0]?.text;
          otherRan.resolve();
          return;
        }
        await patch.execute('*** Begin Patch\n*** Add File: second\n+two\n*** End Patch');
        expect(invalidSettled).toBe(true);
        secondDone = true;
      }
    );
    await otherRan.promise;
    expect(readText).toBe('readable\n');
    expect(invalidSettled).toBe(false);
    expect(secondDone).toBe(false);
    await expect(readFile(join(root, 'second'))).rejects.toMatchObject({ code: 'ENOENT' });
    resume.resolve();
    await Promise.all([first, calls]);
    expect(await invalid).toBe('rejected');
    expect(await readFile(join(root, 'first'), 'utf8')).toBe('one\n');
    expect(await readFile(join(root, 'second'), 'utf8')).toBe('two\n');
  } finally {
    resume.resolve();
    await rm(root, { recursive: true, force: true });
  }
});

it('releases the queue after a failed Move has rolled both files back', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mar-patch-fifo-failure-'));
  const entered = deferred();
  const resume = deferred();
  await writeFile(join(root, 'source'), 'source\n');
  await writeFile(join(root, 'target'), 'original\n');
  let failed = false;
  const patch = new ApplyPatchTool(new WorkspacePathResolver(root), {
    rename: async (source, target) => {
      if (!failed && source.endsWith('.tmp') && target === join(root, 'target')) {
        failed = true;
        entered.resolve();
        await resume.promise;
        throw new Error('injected failure');
      }
      await rename(source, target);
    }
  });
  try {
    const failure = expect(
      patch.execute(
        '*** Begin Patch\n*** Update File: source\n*** Move to: target\n@@\n-source\n+changed\n*** End Patch'
      )
    ).rejects.toThrow('injected failure');
    await entered.promise;
    const update = patch.execute(
      '*** Begin Patch\n*** Update File: target\n@@\n-original\n+updated\n*** End Patch'
    );
    resume.resolve();
    await failure;
    await update;
    expect(await readFile(join(root, 'source'), 'utf8')).toBe('source\n');
    expect(await readFile(join(root, 'target'), 'utf8')).toBe('updated\n');
  } finally {
    resume.resolve();
    await rm(root, { recursive: true, force: true });
  }
});

it('does not write a patch cancelled while queued and continues processing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mar-patch-fifo-cancel-'));
  const entered = deferred();
  const resume = deferred();
  const patch = new ApplyPatchTool(new WorkspacePathResolver(root), {
    rename: async (source, target) => {
      if (target === join(root, 'first')) {
        entered.resolve();
        await resume.promise;
      }
      await rename(source, target);
    }
  });
  try {
    const first = patch.execute('*** Begin Patch\n*** Add File: first\n+one\n*** End Patch');
    await entered.promise;
    const controller = new AbortController();
    const cancelled = expect(
      patch.execute(
        '*** Begin Patch\n*** Add File: cancelled\n+bad\n*** End Patch',
        controller.signal
      )
    ).rejects.toMatchObject({ name: 'AbortError' });
    controller.abort();
    const last = patch.execute('*** Begin Patch\n*** Add File: last\n+ok\n*** End Patch');
    resume.resolve();
    await first;
    await cancelled;
    await last;
    await expect(readFile(join(root, 'cancelled'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(join(root, 'last'), 'utf8')).toBe('ok\n');
  } finally {
    resume.resolve();
    await rm(root, { recursive: true, force: true });
  }
});
