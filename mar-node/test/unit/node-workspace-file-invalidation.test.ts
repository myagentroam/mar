import { execFile as execFileCallback } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NodeConnector } from '../../src/connector.js';
import { NodeDatabase } from '../../src/database.js';
import type { WorkspaceChangeService } from '../../src/workspace/workspace-change-service.js';
import type { WorkspaceCodeNavigationService } from '../../src/workspace/workspace-code-navigation-service.js';
import { WorkspaceFileService } from '../../src/workspace/workspace-file-service.js';
import type { WorkspaceUploadService } from '../../src/workspace/workspace-upload-service.js';
import type { WorkspaceWatchService } from '../../src/workspace/workspace-watch-service.js';
import type { WorkspaceWorkbenchService } from '../../src/workspace/workspace-workbench-service.js';
import { executeNodeOperation } from './support/node-connector.js';

const execFile = promisify(execFileCallback);
const cleanups: (() => Promise<unknown>)[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function fileIndexes(service: WorkspaceFileService): Map<string, unknown> {
  return (service as unknown as { fileIndexes: Map<string, unknown> }).fileIndexes;
}

describe('Workspace successful file mutation invalidation', () => {
  it.each(['write', 'mutate'] as const)(
    'delegates the entire %s invalidation to its callback without disposing twice',
    async (action) => {
      const root = await temporaryDirectory();
      await writeFile(join(root, 'tracked.txt'), 'before');
      const workspace = {
        id: 'workspace',
        path: root,
        kind: 'DIRECTORY' as const,
        gitSummary: null
      };
      const callback = vi.fn((id: string) => files.dispose(id));
      const files = new WorkspaceFileService(callback);
      cleanups.push(async () => files.dispose());
      await files.search(workspace, { query: 'tracked' });
      const dispose = vi.spyOn(files, 'dispose');
      const file = (await files.read(workspace, { path: 'tracked.txt' })) as { revision: string };

      if (action === 'write') {
        await files.write(workspace, {
          path: 'tracked.txt',
          content: 'after',
          expectedRevision: file.revision
        });
      } else {
        await files.mutate(workspace, { action: 'CREATE_FILE', path: 'new.txt' });
      }

      expect(callback).toHaveBeenCalledExactlyOnceWith(workspace.id);
      expect(dispose).toHaveBeenCalledExactlyOnceWith(workspace.id);
      expect(fileIndexes(files).has(workspace.id)).toBe(false);
    }
  );

  it.each(['write', 'create', 'move', 'delete', 'upload', 'direct upload', 'restore'] as const)(
    'runs the real Connector %s wiring once in order and isolates other Workspaces',
    async (action) => {
      const fixture = await connectorFixture();
      const { operation, workspace, other, internals, events, root } = fixture;
      if (action === 'write') {
        const result = (await operation('workspace.file.read', { path: 'tracked.txt' })) as {
          file: { revision: string };
        };
        await operation('workspace.file.write', {
          path: 'tracked.txt',
          content: 'saved',
          expectedRevision: result.file.revision
        });
        expect(await readFile(join(root, 'tracked.txt'), 'utf8')).toBe('saved');
      } else if (action === 'create') {
        await operation('workspace.files.mutate', { action: 'CREATE_FILE', path: 'new.txt' });
        expect(await readFile(join(root, 'new.txt'), 'utf8')).toBe('');
      } else if (action === 'move') {
        await operation('workspace.files.mutate', {
          action: 'MOVE',
          path: 'tracked.txt',
          destination: 'moved.txt'
        });
        expect(await readFile(join(root, 'moved.txt'), 'utf8')).toBe('changed');
      } else if (action === 'delete') {
        await operation('workspace.files.mutate', { action: 'DELETE', path: 'tracked.txt' });
        await expect(readFile(join(root, 'tracked.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
      } else if (action === 'upload') {
        const uploadId = await fixture.upload('uploaded.txt', 'payload');
        expect(events).toEqual([]);
        await operation('workspace.files.upload.complete', { uploadId });
        expect(await readFile(join(root, 'uploaded.txt'), 'utf8')).toBe('payload');
      } else if (action === 'direct upload') {
        const bytes = Buffer.from('direct payload');
        const upload = await internals.workspaceUploadService.createDirect(workspace, {
          path: 'direct.txt',
          size: bytes.length,
          overwrite: false,
          sha256: createHash('sha256').update(bytes).digest('hex')
        });
        await internals.workspaceUploadService.writeDirect(upload.uploadId, bytes);
        expect(events).toEqual([]);
        await internals.workspaceUploadService.completeDirect(upload.uploadId, bytes.length);
        expect(await readFile(join(root, 'direct.txt'), 'utf8')).toBe('direct payload');
      } else {
        await expect(
          operation('workspace.change.restore', {
            path: 'tracked.txt',
            state: 'UNSTAGED'
          })
        ).resolves.toEqual({ restored: true });
        expect(await readFile(join(root, 'tracked.txt'), 'utf8')).toBe('base');
      }

      expect(events).toEqual(expectedEvents(workspace.id));
      expect(fileIndexes(internals.workspaceFileService).has(workspace.id)).toBe(false);
      expect(fileIndexes(internals.workspaceFileService).get(other.id)).toBe(fixture.otherIndex);
      expect(internals.workspaceChangeService.revision(workspace.id)).toBe(fixture.revision + 1);
      expect(internals.workspaceChangeService.revision(other.id)).toBe(fixture.otherRevision);
      expect(await internals.workspaceChangeService.current(other)).toBe(fixture.otherChanges);
      expect(await internals.workspaceChangeService.current(workspace)).not.toBe(fixture.changes);
      const target =
        action === 'create'
          ? 'new.txt'
          : action === 'move'
            ? 'moved.txt'
            : action === 'upload'
              ? 'uploaded.txt'
              : action === 'direct upload'
                ? 'direct.txt'
                : 'tracked.txt';
      const names = await operation('workspace.files.search', { query: target });
      expect(names).toMatchObject({
        files: { entries: action === 'delete' ? [] : [expect.objectContaining({ path: target })] }
      });
      expect(events).toEqual(expectedEvents(workspace.id));
    }
  );

  it('does not invalidate on ordinary reads, failed writes/mutations, or uncommitted uploads', async () => {
    const fixture = await connectorFixture();
    const { operation, events, internals, workspace, root } = fixture;
    await operation('workspace.file.read', { path: 'tracked.txt' });
    await operation('workspace.files.list', { path: 'nested' });
    await operation('workspace.files.search', { query: 'tracked' });
    await operation('workspace.changes.current');
    await expect(
      operation('workspace.file.write', {
        path: 'tracked.txt',
        content: 'wrong',
        expectedRevision: '0'.repeat(64)
      })
    ).rejects.toThrow('FILE_WRITE_CONFLICT');
    await expect(
      operation('workspace.files.mutate', {
        action: 'CREATE_FILE',
        path: 'tracked.txt'
      })
    ).rejects.toThrow('FILE_ALREADY_EXISTS');
    const incomplete = await fixture.upload('incomplete.txt', '', 1);
    await expect(
      operation('workspace.files.upload.complete', { uploadId: incomplete })
    ).rejects.toThrow('UPLOAD_INCOMPLETE');
    await operation('workspace.files.upload.cancel', { uploadId: incomplete });
    const collision = await fixture.upload('collision.txt', 'payload');
    await writeFile(join(root, 'collision.txt'), 'keep');
    await expect(
      operation('workspace.files.upload.complete', { uploadId: collision })
    ).rejects.toThrow('UPLOAD_TARGET_EXISTS');
    await operation('workspace.files.upload.cancel', { uploadId: collision });
    const direct = await internals.workspaceUploadService.createDirect(workspace, {
      path: 'corrupt.txt',
      size: 1,
      overwrite: false,
      sha256: '0'.repeat(64)
    });
    await internals.workspaceUploadService.writeDirect(direct.uploadId, Buffer.from('x'));
    await expect(
      internals.workspaceUploadService.completeDirect(direct.uploadId, 1)
    ).rejects.toThrow('DIRECT_INTEGRITY_FAILED');
    await expect(
      operation('workspace.change.restore', {
        path: 'tracked.txt',
        state: 'UNTRACKED'
      })
    ).rejects.toThrow('GIT_CHANGE_RESTORE_UNAVAILABLE');
    expect(await readFile(join(root, 'tracked.txt'), 'utf8')).toBe('changed');
    expect(await readFile(join(root, 'collision.txt'), 'utf8')).toBe('keep');
    expect(events).toEqual([]);
    expect(fileIndexes(internals.workspaceFileService).get(workspace.id)).toBe(fixture.index);
    expect(await internals.workspaceChangeService.current(workspace)).toBe(fixture.changes);
  });

  it('invalidates caches without creating topic work for an unsubscribed Workspace', async () => {
    const { operation, internals, workspace, events } = await connectorFixture();
    internals.workspaceWatchService.clear(workspace.id);
    await operation('workspace.files.mutate', {
      action: 'CREATE_DIRECTORY',
      path: 'new-directory'
    });
    expect(events).toEqual(expectedEvents(workspace.id).slice(0, 3));
  });

  it('publishes committed Files and Changes through the existing Connector snapshot pipeline only to the affected Workspace', async () => {
    const { operation, internals, workspace, other } = await connectorFixture();
    const workbench = internals.workspaceWorkbenchService;
    vi.mocked(workbench.invalidateTopic).mockRestore();
    const send = vi.spyOn(internals, 'send');
    await operation('workspace.files.mutate', { action: 'CREATE_FILE', path: 'published.txt' });
    await Promise.all([
      workbench.ensureTopicSnapshot(workspace.id, 'files'),
      workbench.ensureTopicSnapshot(workspace.id, 'changes')
    ]);
    expect(send).toHaveBeenCalledWith(
      'watch.event',
      expect.objectContaining({
        type: 'watch.workspace.snapshot',
        workspaceId: workspace.id,
        topic: 'files',
        payload: expect.objectContaining({
          files: expect.objectContaining({
            entries: expect.arrayContaining([expect.objectContaining({ path: 'published.txt' })])
          })
        })
      })
    );
    expect(send).toHaveBeenCalledWith(
      'watch.event',
      expect.objectContaining({
        type: 'watch.workspace.snapshot',
        workspaceId: workspace.id,
        topic: 'changes',
        payload: expect.objectContaining({
          changes: expect.arrayContaining([
            expect.objectContaining({ path: 'published.txt', state: 'UNTRACKED' })
          ])
        })
      })
    );
    expect(send).toHaveBeenCalledTimes(2);
    expect(send).not.toHaveBeenCalledWith(
      'watch.event',
      expect.objectContaining({ workspaceId: other.id })
    );
  });
});

interface ConnectorInternals {
  send(type: string, payload: unknown): void;
  workspaceFileService: WorkspaceFileService;
  workspaceUploadService: WorkspaceUploadService;
  workspaceChangeService: WorkspaceChangeService;
  workspaceWatchService: WorkspaceWatchService;
  workspaceWorkbenchService: WorkspaceWorkbenchService;
}

function expectedEvents(id: string): string[] {
  return ['index', 'navigation', 'changes', 'files topic', 'changes topic'].map(
    (stage) => `${id}:${stage}`
  );
}

async function connectorFixture() {
  const directory = await temporaryDirectory();
  const root = join(directory, 'workspace');
  const otherRoot = join(directory, 'other');
  for (const path of [root, otherRoot]) {
    await mkdir(join(path, 'nested'), { recursive: true });
    await execFile('git', ['init', '-b', 'main'], { cwd: path });
    await writeFile(join(path, 'tracked.txt'), 'base');
    await execFile('git', ['add', 'tracked.txt'], { cwd: path });
    await execFile(
      'git',
      ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'fixture'],
      { cwd: path }
    );
  }
  await writeFile(join(root, 'tracked.txt'), 'changed');
  const database = new NodeDatabase(':memory:', 'node-file-invalidation');
  const workspace = database.saveWorkspace({ path: root, kind: 'GIT_WORKSPACE', gitSummary: null });
  const other = database.saveWorkspace({
    path: otherRoot,
    kind: 'GIT_WORKSPACE',
    gitSummary: null
  });
  const connector = new NodeConnector({ reconnect: false, database });
  cleanups.push(() => connector.stop());
  const internals = connector as unknown as ConnectorInternals;
  const operation = (name: string, input: Record<string, unknown> = {}) =>
    executeNodeOperation(connector, name, { workspaceId: workspace.id, ...input });
  for (const entry of [workspace, other]) {
    await internals.workspaceFileService.search(entry, { query: 'tracked' });
    internals.workspaceWatchService.create(
      entry.id,
      `watch-${entry.id}`,
      'session',
      `connection-${entry.id}`,
      'generation',
      {
        sessions: false,
        files: { path: '.' },
        changes: true
      }
    );
  }
  const changes = await internals.workspaceChangeService.current(workspace);
  const otherChanges = await internals.workspaceChangeService.current(other);
  const index = fileIndexes(internals.workspaceFileService).get(workspace.id);
  const otherIndex = fileIndexes(internals.workspaceFileService).get(other.id);
  const revision = internals.workspaceChangeService.revision(workspace.id);
  const otherRevision = internals.workspaceChangeService.revision(other.id);
  const events: string[] = [];
  const files = internals.workspaceFileService;
  const dispose = files.dispose.bind(files);
  vi.spyOn(files, 'dispose').mockImplementation((id) => {
    events.push(`${id}:index`);
    dispose(id);
  });
  const workbench = internals.workspaceWorkbenchService;
  const { codeNavigation } = workbench as unknown as {
    codeNavigation: WorkspaceCodeNavigationService;
  };
  const invalidateNavigation = codeNavigation.invalidate.bind(codeNavigation);
  vi.spyOn(codeNavigation, 'invalidate').mockImplementation((id) => {
    events.push(`${id}:navigation`);
    invalidateNavigation(id);
  });
  const changeService = internals.workspaceChangeService;
  const invalidateChanges = changeService.invalidate.bind(changeService);
  vi.spyOn(changeService, 'invalidate').mockImplementation((id) => {
    events.push(`${id}:changes`);
    invalidateChanges(id);
  });
  // Keep real owners and active leases; isolate only the asynchronous snapshot reader.
  vi.spyOn(workbench, 'invalidateTopic').mockImplementation(async (id, topic) => {
    events.push(`${id}:${topic} topic`);
  });
  const upload = async (name: string, payload: string, size = Buffer.byteLength(payload)) => {
    const result = (await operation('workspace.files.upload.create', {
      name,
      size,
      overwrite: false
    })) as { upload: { uploadId: string } };
    const uploadId = result.upload.uploadId;
    if (payload.length > 0)
      await operation('workspace.files.upload.chunk', {
        uploadId,
        offset: 0,
        dataBase64: Buffer.from(payload).toString('base64')
      });
    return uploadId;
  };
  return {
    root,
    operation,
    workspace,
    other,
    internals,
    events,
    index,
    otherIndex,
    changes,
    otherChanges,
    revision,
    otherRevision,
    upload
  };
}

async function temporaryDirectory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'mar-file-invalidation-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  return root;
}
