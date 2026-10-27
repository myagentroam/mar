import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { JsonlSessionStore } from '../../src/session/store/index.js';
import { readToolResultResource } from '../../src/session/tool-result-resources.js';
import { ApplyPatchTool } from '../../src/tools/local/apply-patch.js';
import {
  withToolResultExtensions,
  failedToolResultExtensions
} from '../../src/tools/result-extensions.js';
import { WorkspacePathResolver } from '../../src/tools/shared/path-resolver.js';
import { activeSessionDirectory } from '../support/jsonl-session-path.js';

const resourceGate = vi.hoisted(() => ({ path: '', entered: () => {}, resume: Promise.resolve() }));
vi.mock('node:fs/promises', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...fs,
    readFile: async (...args: Parameters<typeof fs.readFile>) => {
      if (args[0] === resourceGate.path) {
        resourceGate.entered();
        await resourceGate.resume;
      }
      return fs.readFile(...args);
    }
  };
});

describe('immutable tool resource storage', () => {
  async function fixture(
    run: (store: JsonlSessionStore, sessionId: string, folder: string) => Promise<void>
  ) {
    const home = await mkdtemp(join(tmpdir(), 'mar-diff-storage-'));
    const store = await JsonlSessionStore.open(home);
    try {
      const session = await store.createSession({ workspace: home });
      await run(
        store,
        session.id,
        join(await activeSessionDirectory(home, session.id), 'tool_results')
      );
    } finally {
      await store.close();
      await rm(home, { recursive: true, force: true });
    }
  }
  const payload = (diff: Awaited<ReturnType<JsonlSessionStore['writeToolResultResource']>>) => ({
    toolName: 'apply_patch',
    callId: randomUUID(),
    resultExtensions: [
      {
        type: 'file_changes' as const,
        version: 1 as const,
        entries: [
          {
            changeId: randomUUID(),
            path: 'file',
            change: 'added' as const,
            additions: 1,
            deletions: 0,
            diff
          }
        ]
      }
    ]
  });

  it('checks the owning record once while reading a resource', async () => {
    await fixture(async (store, sessionId, folder) => {
      const diff = await store.writeToolResultResource(sessionId, 'one record lookup');
      const record = await store.append(sessionId, {
        type: 'tool.completed',
        payload: payload(diff)
      });
      const readRecord = vi.fn(async () => record);
      const page = await readToolResultResource(
        join(folder, '..'),
        sessionId,
        { resourceRef: diff.resourceRef },
        readRecord
      );
      expect(page.content).toBe('one record lookup');
      expect(readRecord).toHaveBeenCalledTimes(1);
      expect(readRecord).toHaveBeenCalledWith(record.sequence);
    });
  });

  it('holds the Store read pin across resource bytes while clear waits', async () => {
    await fixture(async (store, sessionId, folder) => {
      const diff = await store.writeToolResultResource(sessionId, 'read before clear');
      await store.append(sessionId, { type: 'tool.completed', payload: payload(diff) });
      const entered = Promise.withResolvers<void>();
      const resume = Promise.withResolvers<void>();
      resourceGate.path = join(folder, `${diff.resourceRef}.diff`);
      resourceGate.entered = entered.resolve;
      resourceGate.resume = resume.promise;
      const reading = store.readToolResultResource(sessionId, { resourceRef: diff.resourceRef });
      let clearing: Promise<unknown> | undefined;
      try {
        await entered.promise;
        clearing = store.clearSession(sessionId);
        const gate = join(folder, '../../../..', '.read-pins', `${sessionId}.lock`);
        await vi.waitFor(async () => expect((await stat(gate)).isFile()).toBe(true));
        resume.resolve();
        expect((await reading).content).toBe('read before clear');
        await clearing;
      } finally {
        resourceGate.path = '';
        resume.resolve();
        await Promise.allSettled([reading, ...(clearing ? [clearing] : [])]);
      }
    });
  });

  it('paginates UTF-8 without changing content, validates cursors and rejects cross-Session reads', async () => {
    await fixture(async (store, sessionId) => {
      const text = 'a'.repeat(1023) + '你好\n'.repeat(800);
      const diff = await store.writeToolResultResource(sessionId, text);
      await store.append(sessionId, { type: 'tool.completed', payload: payload(diff) });
      let content = '',
        cursor: string | undefined;
      do {
        const page = await store.readToolResultResource(sessionId, {
          resourceRef: diff.resourceRef,
          maxBytes: 1024,
          ...(cursor ? { cursor } : {})
        });
        content += page.content;
        cursor = page.nextCursor;
        expect(Buffer.byteLength(page.content)).toBeLessThanOrEqual(1024);
      } while (cursor);
      expect(content).toBe(text);
      await expect(
        store.readToolResultResource(sessionId, {
          resourceRef: diff.resourceRef,
          cursor: 'invalid'
        })
      ).rejects.toMatchObject({ code: 'MAR_AGENT_TOOL_RESOURCE_INPUT_INVALID' });
      const other = await store.createSession({ workspace: '/another' });
      await expect(
        store.readToolResultResource(other.id, { resourceRef: diff.resourceRef })
      ).rejects.toMatchObject({ code: 'MAR_AGENT_TOOL_RESOURCE_NOT_FOUND' });
    });
  });

  it.each(['invalid', 'directory'])(
    'downgrades %s locators without reporting a failed file operation',
    async (kind) => {
      await fixture(async (store, sessionId, folder) => {
        const diff = await store.writeToolResultResource(sessionId, '+changed\n');
        const path = join(folder, `${diff.resourceRef}.json`);
        if (kind === 'directory') await mkdir(path);
        else await writeFile(path, '{}');
        const event = payload(diff);
        const record = await store.append(sessionId, { type: 'tool.completed', payload: event });
        expect(record.type).toBe('tool.completed');
        expect(event.resultExtensions[0]!.entries[0]!.diff).toEqual({
          status: 'unavailable',
          reason: 'storage-failed'
        });
      });
    }
  );

  it('accepts an existing binding only when committed history owns the same resource', async () => {
    await fixture(async (store, sessionId) => {
      const diff = await store.writeToolResultResource(sessionId, '+changed\n');
      const event = payload(diff);
      await store.append(sessionId, { type: 'tool.completed', payload: event });
      await store.append(sessionId, {
        type: 'tool.completed',
        payload: { toolName: 'code_exec', data: { calls: [event] } }
      });
      expect(
        (await store.readToolResultResource(sessionId, { resourceRef: diff.resourceRef })).content
      ).toBe('+changed\n');
    });
  });

  it.each(['+new\n', '+longer text\n'])(
    'reads trusted tool resource bytes without comparing stored size or checksum (%j)',
    async (text) => {
      await fixture(async (store, sessionId, folder) => {
        const diff = await store.writeToolResultResource(sessionId, '+old\n');
        await store.append(sessionId, { type: 'tool.completed', payload: payload(diff) });
        await writeFile(join(folder, `${diff.resourceRef}.diff`), text);
        expect(
          (await store.readToolResultResource(sessionId, { resourceRef: diff.resourceRef })).content
        ).toBe(text);
      });
    }
  );

  it('continues paging trusted tool resource bytes after their stored size changes', async () => {
    await fixture(async (store, sessionId, folder) => {
      const diff = await store.writeToolResultResource(sessionId, '+old\n');
      await store.append(sessionId, { type: 'tool.completed', payload: payload(diff) });
      const text = '+longer text\n';
      await writeFile(join(folder, `${diff.resourceRef}.diff`), text);
      let cursor: string | undefined;
      let content = '';
      do {
        const page = await store.readToolResultResource(sessionId, {
          resourceRef: diff.resourceRef,
          maxBytes: 4,
          ...(cursor === undefined ? {} : { cursor })
        });
        content += page.content;
        cursor = page.nextCursor;
      } while (cursor !== undefined);
      expect(content).toBe(text);
    });
  });

  it('cleans orphan resources on the next exclusive lease while retaining committed evidence', async () => {
    await fixture(async (store, sessionId, folder) => {
      const saved = await store.writeToolResultResource(sessionId, '+saved\n');
      await store.append(sessionId, { type: 'tool.completed', payload: payload(saved) });
      const orphan = await store.writeToolResultResource(sessionId, '+orphan\n');
      const bad: Record<string, unknown> = payload(orphan);
      bad.circular = bad;
      await expect(
        store.append(sessionId, { type: 'tool.completed', payload: bad })
      ).rejects.toThrow();
      const release = await store.acquireSessionLease(sessionId);
      await release();
      expect((await readdir(folder)).sort()).toEqual(
        [`${saved.resourceRef}.diff`, `${saved.resourceRef}.json`].sort()
      );
    });
  });

  it('retains committed evidence when a wrapper exceeds the aggregate entry budget', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mar-diff-wrapper-budget-'));
    try {
      const tool = new ApplyPatchTool(new WorkspacePathResolver(home));
      let failure: unknown;
      try {
        await withToolResultExtensions(undefined, async () => {
          for (let batch = 0; batch < 3; batch++) {
            const patches = Array.from(
              { length: 100 },
              (_, index) => `*** Add File: ${batch}-${index}\n+value`
            );
            await tool.execute(`*** Begin Patch\n${patches.join('\n')}\n*** End Patch`);
          }
          return { content: '' };
        });
      } catch (error) {
        failure = error;
      }
      expect(failure).toMatchObject({ code: 'MAR_AGENT_TOOL_OUTPUT_LIMIT' });
      expect(failedToolResultExtensions(failure)?.[0]?.entries).toHaveLength(200);
      expect(await readdir(home)).toHaveLength(200);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('rejects excessive descriptor paths before performing any file changes', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mar-diff-budget-'));
    try {
      const tool = new ApplyPatchTool(new WorkspacePathResolver(home));
      const patches = Array.from(
        { length: 100 },
        (_, index) => `*** Add File: ${index}-${'界'.repeat(8000)}\n+value`
      );
      await expect(
        tool.execute(`*** Begin Patch\n${patches.join('\n')}\n*** End Patch`)
      ).rejects.toMatchObject({ code: 'MAR_AGENT_TOOL_OUTPUT_LIMIT' });
      expect(await readdir(home)).toEqual([]);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
