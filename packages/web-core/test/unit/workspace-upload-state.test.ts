import { createHash } from 'node:crypto';
import { nextTick, ref } from 'vue';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { composerEnUS, composerZhCN } from '../../src/i18n/composer.js';
import { errorPresentationEnUS, errorPresentationZhCN } from '../../src/i18n/error-presentation.js';
import { workspaceFileSha256 } from '../../src/util/workspace-file-checksum.js';
import { createWorkbenchNotificationService } from '../../src/service/workbench-notification-service.js';
import { createAccountStorage } from '../../src/service/account-storage-service.js';
import {
  createWorkspaceUploadService,
  parseStoredWorkspaceUploads
} from '../../src/service/workspace-upload-service';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('Web Workspace Upload State', () => {
  function gate<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((release) => (resolve = release));
    return { promise, resolve };
  }

  function lifecycleFixture(
    request: ReturnType<typeof vi.fn>,
    sendBody: Parameters<typeof createWorkspaceUploadService>[0]['sendBody'] = async () => {}
  ) {
    const storage = new Map<string, string>();
    vi.stubGlobal(
      'window',
      Object.assign(new EventTarget(), {
        sessionStorage: {
          getItem: (key: string) => storage.get(key) ?? null,
          setItem: (key: string, value: string) => storage.set(key, value),
          removeItem: (key: string) => storage.delete(key)
        }
      })
    );
    const workspaceTarget = ref({ nodeId: 'node-1', workspaceId: 'workspace-1' });
    const onFilesChanged = vi.fn();
    const onTaskChanged = vi.fn();
    const options = {
      workspaceTarget,
      request: request as Parameters<typeof createWorkspaceUploadService>[0]['request'],
      sendBody,
      onFilesChanged,
      onTaskChanged
    };
    const service = createWorkspaceUploadService(options);
    return { service, options, storage, workspaceTarget, onFilesChanged, onTaskChanged };
  }

  const emptyUpload = (name = 'empty.txt') => ({
    file: new File([], name),
    directory: '.',
    overwrite: false
  });

  it('reuses the staging ID after stream loss without issuing an HTTP body request', async () => {
    const staged = { uploadId: 'upload-1', path: 'canonical/file.bin', receivedBytes: 0, size: 3 };
    const request = vi.fn(async (path: string) => {
      if (path.endsWith('/uploads')) return { upload: staged };
      if (path.endsWith('/complete')) return { upload: { ...staged, receivedBytes: 3 } };
      if (path.includes('/uploads/upload-1?')) return { upload: { ...staged, receivedBytes: 1 } };
      throw new Error('UNEXPECTED_REQUEST');
    });
    const calls: string[] = [];
    const service = createWorkspaceUploadService({
      workspaceTarget: ref({ nodeId: 'node-1', workspaceId: 'workspace-1' }),
      request: request as Parameters<typeof createWorkspaceUploadService>[0]['request'],
      async sendBody({ descriptor, onProgress }) {
        if (descriptor.direction !== 'UPLOAD') throw new Error('Unexpected stream');
        expect(descriptor.resource.path).toBe(staged.path);
        calls.push(descriptor.uploadId!);
        if (calls.length === 1) {
          onProgress?.(1);
          throw new Error('NODE_STREAM_DISCONNECTED');
        }
        onProgress?.(3);
      },
      onFilesChanged() {}
    });
    service.queue([{ file: new File(['abc'], 'file.bin'), directory: '.', overwrite: false }]);
    await vi.waitFor(() => expect(service.tasks.value[0]?.status).toBe('FAILED'));
    expect(request).toHaveBeenCalledTimes(1);
    await service.retry(service.tasks.value[0]!);
    await vi.waitFor(() => expect(service.tasks.value[0]?.status).toBe('COMPLETED'));
    expect(calls).toEqual(['upload-1', 'upload-1']);
    expect(request.mock.calls.map(([path]) => path.split('?')[0])).toEqual([
      '/api/workspaces/workspace-1/uploads',
      '/api/workspaces/workspace-1/uploads/upload-1',
      '/api/workspaces/workspace-1/uploads/upload-1/complete'
    ]);
    service.dispose();
  });

  it('hashes large upload sources in bounded slices', async () => {
    const bytes = new Uint8Array(512 * 1024 + 61).map((_, index) => index % 251);
    const file = new File([bytes], 'large.bin');
    const readFull = vi.spyOn(file, 'arrayBuffer');
    expect(await workspaceFileSha256(file)).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(readFull).not.toHaveBeenCalled();
  });

  it('clears account uploads through cancellation without closing the reusable owner or reviving recovery', async () => {
    const oldCreate = gate<void>();
    let created = 0;
    const request = vi.fn(async (path: string) => {
      if (path.endsWith('/uploads')) {
        const uploadId = `upload-${++created}`;
        if (created === 1) await oldCreate.promise;
        return { upload: { uploadId, path: 'canonical.txt', receivedBytes: 0, size: 0 } };
      }
      return { upload: { receivedBytes: 0 } };
    });
    const f = lifecycleFixture(request);
    f.service.bindStorage(createAccountStorage(window.sessionStorage, 1));
    f.service.queue([emptyUpload('old.txt')]);
    await vi.waitFor(() => expect(created).toBe(1));
    await nextTick();
    expect(f.storage.has('mar.account.v1.1.mar.workspace-upload-tasks')).toBe(true);
    f.service.clear();
    expect(f.storage.has('mar.account.v1.1.mar.workspace-upload-tasks')).toBe(false);
    f.service.bindStorage(createAccountStorage(window.sessionStorage, 2));
    f.service.restore();
    expect(f.service.tasks.value).toEqual([]);
    f.service.queue([emptyUpload('new.txt')]);
    await vi.waitFor(() => expect(f.service.tasks.value[0]?.status).toBe('COMPLETED'));
    f.onFilesChanged.mockClear();
    f.onTaskChanged.mockClear();
    oldCreate.resolve();
    await nextTick();
    await nextTick();
    expect(f.service.tasks.value.map((task) => task.name)).toEqual(['new.txt']);
    expect(f.onFilesChanged).not.toHaveBeenCalled();
    expect(f.onTaskChanged).not.toHaveBeenCalled();
    expect(request.mock.calls.some(([path]) => path.endsWith('/cancel'))).toBe(false);
    expect(f.storage.has('mar.account.v1.1.mar.workspace-upload-tasks')).toBe(false);
    f.service.dispose();
  });

  it('closes create gates and the queue on disposal without publishing or overwriting a new owner', async () => {
    const create = gate<void>();
    let created = 0;
    const request = vi.fn(async (path: string) => {
      if (path.endsWith('/uploads')) {
        const uploadId = `upload-${++created}`;
        await create.promise;
        return { upload: { uploadId, path: 'canonical.txt', receivedBytes: 0, size: 0 } };
      }
      return { upload: { receivedBytes: 0 } };
    });
    const { service, options, storage, onFilesChanged, onTaskChanged } = lifecycleFixture(request);
    service.queue([emptyUpload('one'), emptyUpload('two'), emptyUpload('queued')]);
    await vi.waitFor(() => expect(created).toBe(2));
    service.dispose();
    const snapshot = JSON.parse(storage.get('mar.workspace-upload-tasks')!);
    expect(snapshot).toHaveLength(3);
    onTaskChanged.mockClear();
    const restored = createWorkspaceUploadService(options);
    restored.restore();
    restored.remove(restored.tasks.value[0]!);
    await nextTick();
    const newSnapshot = storage.get('mar.workspace-upload-tasks');
    onTaskChanged.mockClear();
    create.resolve();
    await vi.waitFor(() =>
      expect(request.mock.calls.filter(([path]) => path.endsWith('/cancel'))).toHaveLength(2)
    );
    await nextTick();
    expect(created).toBe(2);
    expect(request.mock.calls.some(([path]) => path.endsWith('/complete'))).toBe(false);
    expect(onFilesChanged).not.toHaveBeenCalled();
    expect(onTaskChanged).not.toHaveBeenCalled();
    expect(storage.get('mar.workspace-upload-tasks')).toBe(newSnapshot);
    const count = service.tasks.value.length;
    service.queue([emptyUpload('rejected')]);
    service.restore();
    await service.retry(service.tasks.value[0]!);
    service.dispose();
    await nextTick();
    expect(service.tasks.value).toHaveLength(count);
    expect(storage.get('mar.workspace-upload-tasks')).toBe(newSnapshot);
    restored.dispose();
  });

  it.each(['cancel', 'remove'] as const)(
    'cleans a late create exactly once after %s without reviving its record',
    async (action) => {
      const create = gate<void>();
      const cleanup = gate<void>();
      const request = vi.fn(async (path: string) => {
        if (path.endsWith('/uploads')) {
          await create.promise;
          return {
            upload: { uploadId: 'late-id', path: 'canonical.txt', receivedBytes: 0, size: 0 }
          };
        }
        if (path.endsWith('/cancel')) await cleanup.promise;
        return {};
      });
      const { service, storage, onFilesChanged } = lifecycleFixture(request);
      service.queue([emptyUpload()]);
      await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
      const task = service.tasks.value[0]!;
      if (action === 'cancel') expect(await service.cancel(task)).toBe(true);
      else service.remove(task);
      create.resolve();
      await vi.waitFor(() =>
        expect(request.mock.calls.filter(([path]) => path.endsWith('/cancel'))).toHaveLength(1)
      );
      const repeated = service.cancel(task);
      cleanup.resolve();
      expect(await repeated).toBe(true);
      await nextTick();
      expect(request.mock.calls.map(([path]) => path)).toEqual([
        '/api/workspaces/workspace-1/uploads',
        '/api/workspaces/workspace-1/uploads/late-id/cancel'
      ]);
      expect(task.status).toBe('CANCELLED');
      expect(onFilesChanged).not.toHaveBeenCalled();
      expect(service.tasks.value).toHaveLength(action === 'remove' ? 0 : 1);
      expect(storage.has('mar.workspace-upload-tasks')).toBe(false);
      service.dispose();
    }
  );

  it('retains a late upload identity and the existing warning if cleanup fails', async () => {
    const create = gate<void>();
    const request = vi.fn(async (path: string) => {
      if (path.endsWith('/cancel')) throw new Error('UPLOAD_NETWORK_FAILED');
      await create.promise;
      return { upload: { uploadId: 'late-id', path: 'canonical.txt', receivedBytes: 0, size: 0 } };
    });
    const { service, storage } = lifecycleFixture(request);
    service.queue([emptyUpload()]);
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
    const task = service.tasks.value[0]!;
    expect(await service.cancel(task)).toBe(true);
    create.resolve();
    await vi.waitFor(() => expect(task.cleanupUnconfirmed).toBe(true));
    await nextTick();
    expect(task).toMatchObject({
      status: 'FAILED',
      uploadId: 'late-id',
      error: 'UPLOAD_NETWORK_FAILED'
    });
    expect(JSON.parse(storage.get('mar.workspace-upload-tasks')!)[0]).toMatchObject({
      uploadId: 'late-id',
      cleanupUnconfirmed: true
    });
    expect(request).toHaveBeenCalledTimes(2);
    service.dispose();
  });

  it.each(['unclaimed', 'other-record', 'modified', 'removed'] as const)(
    'retains disposed late cleanup failures only for an unchanged recovery record: %s',
    async (ownership) => {
      const create = gate<void>();
      const cleanup = gate<void>();
      let failCleanup = true;
      const request = vi.fn(async (path: string) => {
        if (path.endsWith('/uploads')) {
          await create.promise;
          return {
            upload: { uploadId: 'late-id', path: 'canonical.txt', receivedBytes: 0, size: 0 }
          };
        }
        await cleanup.promise;
        if (failCleanup) throw new Error('UPLOAD_NETWORK_FAILED');
        return {};
      });
      const { service, options, storage, onFilesChanged, onTaskChanged } =
        lifecycleFixture(request);
      service.queue([emptyUpload()]);
      await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
      const task = service.tasks.value[0]!;
      service.dispose();
      create.resolve();
      await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
      const nextOwner = createWorkspaceUploadService(options);
      if (ownership === 'modified' || ownership === 'removed') {
        nextOwner.restore();
        if (ownership === 'modified') nextOwner.tasks.value[0]!.error = 'new-owner-change';
        else nextOwner.remove(nextOwner.tasks.value[0]!);
        await nextTick();
      }
      let sibling: unknown;
      if (ownership === 'other-record') {
        const current = JSON.parse(storage.get('mar.workspace-upload-tasks')!);
        // Another record can change without transferring ownership of this task's snapshot.
        sibling = { ...current[0], id: 'other-task', name: 'other.txt', error: 'newer-record' };
        storage.set('mar.workspace-upload-tasks', JSON.stringify([...current, sibling]));
      }
      const nextSnapshot = storage.get('mar.workspace-upload-tasks');
      onTaskChanged.mockClear();
      cleanup.resolve();
      await vi.waitFor(() => expect(task.status).toBe('FAILED'));
      await nextTick();
      expect(task).toMatchObject({ uploadId: 'late-id', cleanupUnconfirmed: true });
      expect(onFilesChanged).not.toHaveBeenCalled();
      expect(onTaskChanged).not.toHaveBeenCalled();
      expect(request.mock.calls.map(([path]) => path)).toEqual([
        '/api/workspaces/workspace-1/uploads',
        '/api/workspaces/workspace-1/uploads/late-id/cancel'
      ]);
      if (ownership === 'modified' || ownership === 'removed') {
        expect(storage.get('mar.workspace-upload-tasks')).toBe(nextSnapshot);
        expect(nextOwner.tasks.value).toHaveLength(ownership === 'removed' ? 0 : 1);
        if (ownership === 'modified')
          expect(nextOwner.tasks.value[0]).toMatchObject({ error: 'new-owner-change' });
      } else {
        const stored = JSON.parse(storage.get('mar.workspace-upload-tasks')!);
        expect(stored[0]).toMatchObject({
          uploadId: 'late-id',
          cleanupUnconfirmed: true,
          error: 'UPLOAD_NETWORK_FAILED'
        });
        if (ownership === 'other-record') expect(stored[1]).toEqual(sibling);
        nextOwner.restore();
        expect(nextOwner.tasks.value[0]).toMatchObject({
          status: 'INTERRUPTED',
          uploadId: 'late-id',
          cleanupUnconfirmed: true,
          error: 'UPLOAD_NETWORK_FAILED'
        });
        failCleanup = false;
        expect(await nextOwner.cancel(nextOwner.tasks.value[0]!)).toBe(true);
        expect(request.mock.calls.at(-1)![0]).toBe(
          '/api/workspaces/workspace-1/uploads/late-id/cancel'
        );
      }
      nextOwner.dispose();
    }
  );

  it.each(['restored', 'restored-twice', 'restored-then-disposed'] as const)(
    'hands late cleanup failures across a restore-only handoff: %s',
    async (handoff) => {
      const create = gate<void>();
      const cleanup = gate<void>();
      let failCleanup = true;
      const request = vi.fn(async (path: string) => {
        if (path.endsWith('/uploads')) {
          await create.promise;
          return {
            upload: { uploadId: 'late-id', path: 'canonical.txt', receivedBytes: 0, size: 0 }
          };
        }
        await cleanup.promise;
        if (failCleanup) throw new Error('UPLOAD_NETWORK_FAILED');
        return {};
      });
      const { service, options, storage, onTaskChanged, onFilesChanged } =
        lifecycleFixture(request);
      service.queue([emptyUpload()]);
      await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
      const oldTask = service.tasks.value[0]!;
      service.dispose();
      create.resolve();
      await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
      let current = createWorkspaceUploadService(options);
      current.restore();
      if (handoff !== 'restored') {
        current.dispose();
        if (handoff === 'restored-twice') {
          current = createWorkspaceUploadService(options);
          current.restore();
        }
      }
      await nextTick();
      onTaskChanged.mockClear();
      cleanup.resolve();
      await vi.waitFor(() => expect(oldTask.status).toBe('FAILED'));
      await nextTick();
      expect(JSON.parse(storage.get('mar.workspace-upload-tasks')!)[0]).toMatchObject({
        uploadId: 'late-id',
        cleanupUnconfirmed: true,
        error: 'UPLOAD_NETWORK_FAILED'
      });
      if (handoff === 'restored-then-disposed') {
        current = createWorkspaceUploadService(options);
        current.restore();
      }
      expect(current.tasks.value[0]).toMatchObject({
        status: 'INTERRUPTED',
        uploadId: 'late-id',
        cleanupUnconfirmed: true,
        error: 'UPLOAD_NETWORK_FAILED'
      });
      expect(onTaskChanged).not.toHaveBeenCalled();
      expect(onFilesChanged).not.toHaveBeenCalled();
      failCleanup = false;
      expect(await current.cancel(current.tasks.value[0]!)).toBe(true);
      expect(request.mock.calls.map(([path]) => path)).toEqual([
        '/api/workspaces/workspace-1/uploads',
        '/api/workspaces/workspace-1/uploads/late-id/cancel',
        '/api/workspaces/workspace-1/uploads/late-id/cancel'
      ]);
      current.dispose();
    }
  );

  it.each(['active', 'disposed'] as const)(
    'does not patch a %s new owner that resumes the same task back into an identical create state',
    async (ownerState) => {
      const create = gate<void>();
      const cleanup = gate<void>();
      const resumedCreate = gate<void>();
      let creates = 0;
      const request = vi.fn(async (path: string) => {
        if (path.endsWith('/uploads')) {
          const attempt = ++creates;
          await (attempt === 1 ? create.promise : resumedCreate.promise);
          return {
            upload: {
              uploadId: attempt === 1 ? 'late-id' : 'resumed-id',
              path: 'canonical.txt',
              receivedBytes: 0,
              size: 0
            }
          };
        }
        if (path.endsWith('/late-id/cancel')) {
          await cleanup.promise;
          throw new Error('UPLOAD_NETWORK_FAILED');
        }
        return {};
      });
      const { service, options, storage } = lifecycleFixture(request);
      service.queue([emptyUpload()]);
      await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
      const task = service.tasks.value[0]!;
      service.dispose();
      create.resolve();
      await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
      const nextOwner = createWorkspaceUploadService(options);
      nextOwner.restore();
      await nextOwner.retry(nextOwner.tasks.value[0]!);
      nextOwner.recover({
        target: { files: [new File([], task.name)], value: 'selected' }
      } as unknown as Event);
      await vi.waitFor(() => expect(creates).toBe(2));
      if (ownerState === 'disposed') nextOwner.dispose();
      const snapshot = storage.get('mar.workspace-upload-tasks');
      cleanup.resolve();
      await vi.waitFor(() => expect(task.status).toBe('FAILED'));
      expect(storage.get('mar.workspace-upload-tasks')).toBe(snapshot);
      nextOwner.dispose();
      resumedCreate.resolve();
      await vi.waitFor(() => expect(nextOwner.tasks.value[0]!.status).toBe('CANCELLED'));
    }
  );

  it('lets a submitted complete settle successfully even when Cancel is clicked before its response', async () => {
    const complete = gate<void>();
    const request = vi.fn(async (path: string) => {
      if (path.endsWith('/uploads'))
        return { upload: { uploadId: 'upload-1', path: 'file.txt', receivedBytes: 0 } };
      expect(path).toBe('/api/workspaces/workspace-1/uploads/upload-1/complete');
      await complete.promise;
      return { upload: { receivedBytes: 3 } };
    });
    const { service, onFilesChanged } = lifecycleFixture(request);
    try {
      service.queue([{ file: new File(['abc'], 'file.txt'), directory: '.', overwrite: false }]);
      await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
      const task = service.tasks.value[0]!;
      await expect(service.cancel(task)).resolves.toBe(false);
      expect(task.status).toBe('UPLOADING');
      complete.resolve();
      await vi.waitFor(() => expect(task.status).toBe('COMPLETED'));
      await expect(service.cancel(task)).resolves.toBe(false);
      expect(onFilesChanged).toHaveBeenCalledOnce();
      expect(request).toHaveBeenCalledTimes(2);
    } finally {
      complete.resolve();
      service.dispose();
    }
  });

  it('does not roll back or publish completion already submitted before disposal', async () => {
    const complete = gate<void>();
    const request = vi.fn(async (path: string) => {
      if (path.endsWith('/complete')) await complete.promise;
      return {
        upload: { uploadId: 'committing', path: 'canonical.txt', receivedBytes: 0, size: 0 }
      };
    });
    const { service, storage, onFilesChanged, onTaskChanged } = lifecycleFixture(request);
    service.queue([emptyUpload()]);
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    const task = service.tasks.value[0]!;
    service.dispose();
    const snapshot = storage.get('mar.workspace-upload-tasks');
    onTaskChanged.mockClear();
    complete.resolve();
    await vi.waitFor(() => expect(task.status).toBe('COMPLETED'));
    await nextTick();
    expect(request).toHaveBeenCalledTimes(2);
    expect(onFilesChanged).not.toHaveBeenCalled();
    expect(onTaskChanged).not.toHaveBeenCalled();
    expect(storage.get('mar.workspace-upload-tasks')).toBe(snapshot);
  });

  it('keeps the original Workspace and concurrency limit across ordinary selection changes', async () => {
    const create = gate<void>();
    let started = 0;
    const request = vi.fn(async (path: string, _init?: RequestInit) => {
      if (path.endsWith('/uploads')) {
        const uploadId = `upload-${++started}`;
        await create.promise;
        return { upload: { uploadId, path: 'canonical.txt', receivedBytes: 0, size: 0 } };
      }
      return { upload: { receivedBytes: 0 } };
    });
    const { service, workspaceTarget, onFilesChanged } = lifecycleFixture(request);
    service.queue([emptyUpload('one'), emptyUpload('two'), emptyUpload('three')]);
    await vi.waitFor(() => expect(started).toBe(2));
    workspaceTarget.value = { nodeId: 'node-2', workspaceId: 'workspace-2' };
    create.resolve();
    await vi.waitFor(() =>
      expect(service.tasks.value.every((task) => task.status === 'COMPLETED')).toBe(true)
    );
    expect(started).toBe(3);
    expect(onFilesChanged).toHaveBeenCalledTimes(3);
    expect(
      request.mock.calls.every(([path]) => path.startsWith('/api/workspaces/workspace-1/'))
    ).toBe(true);
    expect(
      request.mock.calls
        .filter(([path]) => path.endsWith('/complete'))
        .every(([, init]) => JSON.parse(init!.body as string).nodeId === 'node-1')
    ).toBe(true);
    service.dispose();
  });

  it('keeps the staging ID and a stable cleanup warning when cancellation fails', async () => {
    const request = vi.fn(async (path: string) => {
      if (path.endsWith('/uploads'))
        return { upload: { uploadId: 'upload-1', path: 'file.txt', receivedBytes: 0 } };
      throw new Error('UPLOAD_NETWORK_FAILED');
    });
    const { service, storage } = lifecycleFixture(request, async () => {
      throw new Error('NODE_STREAM_DISCONNECTED');
    });
    try {
      service.queue([{ file: new File(['abc'], 'file.txt'), directory: '.', overwrite: false }]);
      await vi.waitFor(() => expect(service.tasks.value[0]?.status).toBe('FAILED'));
      const task = service.tasks.value[0]!;
      expect(await service.cancel(task)).toBe(false);
      expect(task).toMatchObject({
        uploadId: 'upload-1',
        cleanupUnconfirmed: true,
        status: 'FAILED'
      });
      await nextTick();
      expect(
        parseStoredWorkspaceUploads(JSON.parse(storage.get('mar.workspace-upload-tasks')!))[0]
      ).toMatchObject({ uploadId: 'upload-1', cleanupUnconfirmed: true });
      expect(errorPresentationEnUS.errors.UPLOAD_CLEANUP_UNCONFIRMED).toContain(
        'task has been kept'
      );
      expect(errorPresentationZhCN.errors.UPLOAD_CLEANUP_UNCONFIRMED).toContain('任务已保留');
    } finally {
      service.dispose();
    }
  });

  it('keeps a task when cancellation fails and still allows its local record to be removed', async () => {
    const request = vi.fn(async () => {
      throw new Error('UPLOAD_NETWORK_FAILED');
    });
    const service = createWorkspaceUploadService({
      workspaceTarget: ref(undefined),
      request,
      sendBody: async () => {},
      onFilesChanged: vi.fn()
    });
    const [task] = parseStoredWorkspaceUploads([
      {
        id: 'task-1',
        nodeId: 'node-1',
        workspaceId: 'workspace-1',
        directory: '.',
        name: 'file.txt',
        size: 1,
        overwrite: false,
        receivedBytes: 0,
        uploadId: 'upload-1',
        status: 'FAILED'
      }
    ]);
    service.tasks.value.push(task!);
    expect(await service.cancel(service.tasks.value[0]!)).toBe(false);
    expect(service.tasks.value).toHaveLength(1);
    expect(service.tasks.value[0]?.cleanupUnconfirmed).toBe(true);
    request.mockImplementation(async () => undefined as never);
    await service.remove(service.tasks.value[0]!);
    expect(service.tasks.value).toHaveLength(0);
  });

  it('removes a failed task and its notification even when remote cleanup is unconfirmed', async () => {
    const notifications = createWorkbenchNotificationService(ref(undefined));
    const request = vi.fn(async (path: string) => {
      if (path.endsWith('/uploads'))
        return { upload: { uploadId: 'upload-1', path: 'file.txt', receivedBytes: 0 } };
      throw new Error('UPLOAD_NETWORK_FAILED');
    });
    const { options, service: unused } = lifecycleFixture(request, async () => {
      throw new Error('NODE_STREAM_DISCONNECTED');
    });
    unused.dispose();
    const service = createWorkspaceUploadService({
      ...options,
      onTaskChanged: notifications.recordUpload
    });
    try {
      service.queue([{ file: new File(['abc'], 'file.txt'), directory: '.', overwrite: false }]);
      await vi.waitFor(() => expect(service.tasks.value[0]?.status).toBe('FAILED'));
      const task = service.tasks.value[0]!;
      expect(notifications.notifications.value).toHaveLength(1);
      await service.remove(task);
      expect(service.tasks.value).toEqual([]);
      expect(notifications.notifications.value).toEqual([]);
      await vi.waitFor(() => expect(task.cleanupUnconfirmed).toBe(true));
      expect(request.mock.calls.map(([path]) => path)).toEqual([
        '/api/workspaces/workspace-1/uploads',
        '/api/workspaces/workspace-1/uploads/upload-1/cancel'
      ]);
    } finally {
      service.dispose();
      notifications.dispose();
    }
  });

  it.each(['UPLOAD_NOT_FOUND', 'UPLOAD_NETWORK_FAILED'])(
    'removes a restored task immediately and ignores a late %s cleanup response',
    async (code) => {
      const stored = new Map<string, string>();
      vi.stubGlobal(
        'window',
        Object.assign(new EventTarget(), {
          sessionStorage: {
            getItem: (key: string) => stored.get(key) ?? null,
            setItem: (key: string, value: string) => stored.set(key, value),
            removeItem: (key: string) => stored.delete(key)
          }
        })
      );
      stored.set(
        'mar.workspace-upload-tasks',
        JSON.stringify([
          {
            id: 'task-1',
            nodeId: 'node-1',
            workspaceId: 'workspace-1',
            directory: '.',
            name: 'file.txt',
            size: 1,
            overwrite: false,
            receivedBytes: 0,
            uploadId: 'expired-upload',
            status: 'FAILED'
          }
        ])
      );
      let rejectCancellation!: (error: Error) => void;
      const request = vi.fn(
        () => new Promise<never>((_resolve, reject) => (rejectCancellation = reject))
      );
      const notifications = createWorkbenchNotificationService(ref(undefined));
      const service = createWorkspaceUploadService({
        workspaceTarget: ref(undefined),
        request,
        sendBody: async () => {},
        onFilesChanged: vi.fn(),
        onTaskChanged: notifications.recordUpload
      });
      try {
        service.restore();
        const task = service.tasks.value[0]!;
        notifications.recordUpload(task);
        void service.remove(task);
        expect(service.tasks.value).toEqual([]);
        expect(notifications.notifications.value).toEqual([]);
        expect(request).toHaveBeenCalledWith(
          '/api/workspaces/workspace-1/uploads/expired-upload/cancel',
          { method: 'POST', body: JSON.stringify({ nodeId: 'node-1' }) }
        );
        await nextTick();
        expect(stored.has('mar.workspace-upload-tasks')).toBe(false);

        rejectCancellation(new Error(code));
        await vi.waitFor(() =>
          expect(task.status).toBe(code === 'UPLOAD_NOT_FOUND' ? 'CANCELLED' : 'FAILED')
        );
        expect(task.cleanupUnconfirmed).toBe(code !== 'UPLOAD_NOT_FOUND');
        expect(notifications.notifications.value).toEqual([]);
        service.restore();
        expect(service.tasks.value).toEqual([]);
      } finally {
        service.dispose();
        notifications.dispose();
      }
    }
  );

  it('does not restore a removed task or notification when an in-flight upload completes', async () => {
    const notifications = createWorkbenchNotificationService(ref(undefined));
    let completeUpload!: () => void;
    const completion = new Promise<void>((resolve) => (completeUpload = resolve));
    const request = vi.fn(async (path: string) => {
      if (path.endsWith('/complete')) await completion;
      if (path.endsWith('/cancel')) return undefined as never;
      return {
        upload: { uploadId: 'upload-1', path: 'canonical.txt', receivedBytes: 0, size: 0 }
      } as never;
    });
    const onFilesChanged = vi.fn();
    const service = createWorkspaceUploadService({
      workspaceTarget: ref({ nodeId: 'node-1', workspaceId: 'workspace-1' } as never),
      request,
      sendBody: async () => {},
      onFilesChanged,
      onTaskChanged: notifications.recordUpload
    });
    try {
      service.queue([{ file: new File([], 'file.txt'), directory: '.', overwrite: false }]);
      await vi.waitFor(() =>
        expect(request).toHaveBeenCalledWith(
          '/api/workspaces/workspace-1/uploads/upload-1/complete',
          { method: 'POST', body: JSON.stringify({ nodeId: 'node-1' }) }
        )
      );
      service.remove(service.tasks.value[0]!);
      expect(service.tasks.value).toEqual([]);
      expect(notifications.notifications.value).toEqual([]);

      completeUpload();
      await vi.waitFor(() => expect(onFilesChanged).toHaveBeenCalledOnce());
      expect(service.tasks.value).toEqual([]);
      expect(notifications.notifications.value).toEqual([]);
      expect(request.mock.calls.map(([path]) => path)).toEqual([
        '/api/workspaces/workspace-1/uploads',
        '/api/workspaces/workspace-1/uploads/upload-1/complete'
      ]);
    } finally {
      completeUpload();
      service.dispose();
      notifications.dispose();
    }
  });

  it.each([
    ['', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
    ['abc', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad']
  ])('hashes the complete file with SHA-256 (%s)', async (text, expected) => {
    expect(await workspaceFileSha256(new Blob([text!]))).toBe(expected);
  });

  it('fails before allocating a staging ID when hashing the source fails', async () => {
    const file = new File(['x'], 'file.txt');
    vi.spyOn(file, 'arrayBuffer').mockRejectedValue(new Error('Cannot read file'));
    const sendBody = vi.fn(async () => undefined);
    const request = vi.fn();
    const { service } = lifecycleFixture(request, sendBody);
    try {
      service.queue([{ file, directory: '.', overwrite: false }]);
      await vi.waitFor(() => expect(service.tasks.value[0]?.status).toBe('FAILED'));
      expect(sendBody).not.toHaveBeenCalled();
      expect(request).not.toHaveBeenCalled();
    } finally {
      service.dispose();
    }
  });

  it.each(['cancel', 'dispose'] as const)(
    'does not open a file stream after %s while hashing the file',
    async (action) => {
      vi.spyOn(globalThis.crypto.subtle, 'digest').mockResolvedValue(new ArrayBuffer(32));
      let finishHash!: (value: ArrayBuffer) => void;
      const file = new File(['original'], 'same.txt');
      vi.spyOn(file, 'arrayBuffer').mockImplementation(
        () => new Promise((resolve) => (finishHash = resolve))
      );
      const directUpload = vi.fn(async () => undefined);
      const request = vi.fn(async () => ({}));
      const service = createWorkspaceUploadService({
        workspaceTarget: ref({ nodeId: 'node-1', workspaceId: 'workspace-1' } as never),
        request: request as never,
        onFilesChanged: vi.fn(),
        sendBody: directUpload
      });
      service.queue([{ file, directory: '.', overwrite: true }]);
      if (action === 'cancel') await service.cancel(service.tasks.value[0]!);
      else service.dispose();
      finishHash(new TextEncoder().encode('original').buffer);
      await vi.waitFor(() => expect(service.tasks.value[0]?.status).not.toBe('UPLOADING'));
      await new Promise((resolve) => setImmediate(resolve));
      expect(service.tasks.value[0]?.status).toBe(
        action === 'cancel' ? 'CANCELLED' : 'INTERRUPTED'
      );
      expect(directUpload).not.toHaveBeenCalled();
      expect(request).not.toHaveBeenCalled();
      service.dispose();
    }
  );

  it.each(['cancel', 'dispose'] as const)(
    'aborts the active body stream after %s without committing or retrying',
    async (action) => {
      const body = gate<void>();
      const sendBody = vi.fn(async ({ signal }: { signal?: AbortSignal }) => {
        body.resolve();
        await new Promise<void>((_resolve, reject) =>
          signal!.addEventListener('abort', () => reject(new Error('UPLOAD_CANCELLED')), {
            once: true
          })
        );
      });
      const request = vi.fn(async (path: string) => {
        if (path.endsWith('/uploads'))
          return { upload: { uploadId: 'upload-id', path: 'file.txt', receivedBytes: 0 } };
        if (path.endsWith('/cancel')) return { cancelled: true };
        throw new Error('UNEXPECTED_REQUEST');
      });
      const { service } = lifecycleFixture(request, sendBody);
      try {
        service.queue([{ file: new File(['x'], 'file.txt'), directory: '.', overwrite: false }]);
        await body.promise;
        if (action === 'cancel') await service.cancel(service.tasks.value[0]!);
        else service.dispose();
        await vi.waitFor(() => expect(service.tasks.value[0]?.status).toBe('CANCELLED'));
        expect(sendBody).toHaveBeenCalledOnce();
        expect(request.mock.calls.map(([path]) => path)).toEqual([
          '/api/workspaces/workspace-1/uploads',
          '/api/workspaces/workspace-1/uploads/upload-id/cancel'
        ]);
      } finally {
        service.dispose();
      }
    }
  );

  it('describes the active Composer Server transport without repeating direct unavailability', () => {
    expect(composerEnUS.generated.composerAttachments.serverFallbackTransport).toBe(
      composerEnUS.generated.composerAttachments.serverTransport
    );
    expect(composerZhCN.generated.composerAttachments.serverFallbackTransport).toBe(
      composerZhCN.generated.composerAttachments.serverTransport
    );
  });

  it('Restores valid unfinished tasks as interrupted after refresh', () => {
    expect(
      parseStoredWorkspaceUploads([
        {
          id: 'upload-1',
          nodeId: 'node-1',
          workspaceId: 'workspace-1',
          directory: 'src',
          name: 'small.txt',
          size: 5,
          overwrite: false,
          uploadId: 'native-upload-1',
          receivedBytes: 2,
          status: 'UPLOADING'
        }
      ])
    ).toEqual([
      expect.objectContaining({
        id: 'upload-1',
        uploadId: 'native-upload-1',
        receivedBytes: 2,
        status: 'INTERRUPTED',
        cancelled: false
      })
    ]);
  });

  it('Ignores tasks with out-of-range progress or missing Workspace identity', () => {
    expect(
      parseStoredWorkspaceUploads([
        {
          id: 'upload-1',
          nodeId: 'node-1',
          directory: '',
          name: 'small.txt',
          size: 5,
          overwrite: false,
          receivedBytes: 6,
          status: 'UPLOADING'
        }
      ])
    ).toEqual([]);
  });

  it('uses the same digest for staging and the body and never completes a failed stream', async () => {
    const sha256 = createHash('sha256').update('original').digest('hex');
    const sendBody = vi.fn(async ({ descriptor }) => {
      expect(descriptor).toMatchObject({ sha256, uploadId: 'upload-1' });
      throw new Error('NODE_STREAM_DISCONNECTED');
    });
    const request = vi.fn(async (path: string, init?: RequestInit) => {
      expect(path).toBe('/api/workspaces/workspace-1/uploads');
      expect(JSON.parse(init!.body as string)).toMatchObject({ sha256 });
      return { upload: { uploadId: 'upload-1', path: 'same.txt', receivedBytes: 0 } };
    });
    const { service } = lifecycleFixture(request, sendBody);
    try {
      service.queue([
        { file: new File(['original'], 'same.txt'), directory: '.', overwrite: true }
      ]);
      await vi.waitFor(() => expect(service.tasks.value[0]?.status).toBe('FAILED'));
      expect(sendBody).toHaveBeenCalledOnce();
      expect(request).toHaveBeenCalledOnce();
    } finally {
      service.dispose();
    }
  });
});
