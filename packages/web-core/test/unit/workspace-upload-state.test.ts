import { nextTick, ref } from 'vue';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { composerEnUS, composerZhCN } from '../../src/i18n/composer.js';
import { notificationsEnUS, notificationsZhCN } from '../../src/i18n/notifications.js';
import { errorPresentationEnUS, errorPresentationZhCN } from '../../src/i18n/error-presentation.js';
import { workspaceFileSha256 } from '../../src/util/workspace-file-checksum.js';
import { createWorkbenchNotificationService } from '../../src/service/WorkbenchNotificationService.js';
import {
  createWorkspaceUploadService,
  parseStoredWorkspaceUploads
} from '../../src/service/WorkspaceUploadService';

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
    renewCsrfToken = async () => 'token'
  ) {
    const storage = new Map<string, string>();
    vi.stubGlobal('window', {
      sessionStorage: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value),
        removeItem: (key: string) => storage.delete(key)
      }
    });
    const workspaceTarget = ref({ nodeId: 'node-1', workspaceId: 'workspace-1' });
    const onFilesChanged = vi.fn();
    const onTaskChanged = vi.fn();
    const options = {
      workspaceTarget,
      csrfToken: ref('token'),
      request: request as Parameters<typeof createWorkspaceUploadService>[0]['request'],
      renewCsrfToken,
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

  it('closes create gates and the queue on disposal without publishing or overwriting a new owner', async () => {
    const create = gate<void>();
    let created = 0;
    const request = vi.fn(async (path: string) => {
      if (path.endsWith('/uploads')) {
        const uploadId = `upload-${++created}`;
        await create.promise;
        return { upload: { uploadId, receivedBytes: 0, size: 0 } };
      }
      return { upload: { receivedBytes: 0 } };
    });
    const { service, options, storage, onFilesChanged, onTaskChanged } = lifecycleFixture(request);
    service.queue([emptyUpload('one'), emptyUpload('two'), emptyUpload('queued')]);
    expect(created).toBe(2);
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
          return { upload: { uploadId: 'late-id', receivedBytes: 0, size: 0 } };
        }
        if (path.endsWith('/cancel')) await cleanup.promise;
        return {};
      });
      const { service, storage, onFilesChanged } = lifecycleFixture(request);
      service.queue([emptyUpload()]);
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
      return { upload: { uploadId: 'late-id', receivedBytes: 0, size: 0 } };
    });
    const { service, storage } = lifecycleFixture(request);
    service.queue([emptyUpload()]);
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
          return { upload: { uploadId: 'late-id', receivedBytes: 0, size: 0 } };
        }
        await cleanup.promise;
        if (failCleanup) throw new Error('UPLOAD_NETWORK_FAILED');
        return {};
      });
      const { service, options, storage, onFilesChanged, onTaskChanged } =
        lifecycleFixture(request);
      service.queue([emptyUpload()]);
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
          return { upload: { uploadId: 'late-id', receivedBytes: 0, size: 0 } };
        }
        await cleanup.promise;
        if (failCleanup) throw new Error('UPLOAD_NETWORK_FAILED');
        return {};
      });
      const { service, options, storage, onTaskChanged, onFilesChanged } =
        lifecycleFixture(request);
      service.queue([emptyUpload()]);
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

  it('does not roll back or publish completion already submitted before disposal', async () => {
    const complete = gate<void>();
    const request = vi.fn(async (path: string) => {
      if (path.endsWith('/complete')) await complete.promise;
      return { upload: { uploadId: 'committing', receivedBytes: 0, size: 0 } };
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
        return { upload: { uploadId, receivedBytes: 0, size: 0 } };
      }
      return { upload: { receivedBytes: 0 } };
    });
    const { service, workspaceTarget, onFilesChanged } = lifecycleFixture(request);
    service.queue([emptyUpload('one'), emptyUpload('two'), emptyUpload('three')]);
    expect(started).toBe(2);
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

  it('keeps a failed direct task and a stable cleanup warning when cancellation cannot confirm cleanup', async () => {
    const directUpload = vi.fn(async () => {
      throw new Error('DIRECT_CHANNEL_CLOSED');
    });
    const request = vi.fn();
    const service = createWorkspaceUploadService({
      workspaceTarget: ref({ nodeId: 'node-1', workspaceId: 'workspace-1' } as never),
      csrfToken: ref('token'),
      request,
      renewCsrfToken: async () => 'token',
      onFilesChanged: vi.fn(),
      direct: { generation: () => 'generation-1', upload: directUpload }
    });
    service.queue([{ file: new File(['abc'], 'file.txt'), directory: '.', overwrite: false }]);
    await vi.waitFor(() => expect(service.tasks.value[0]?.status).toBe('FAILED'));
    const task = service.tasks.value[0]!;
    expect(await service.cancel(task)).toBe(false);
    expect(service.tasks.value).toContain(task);
    expect(task.cleanupUnconfirmed).toBe(true);
    expect(task.status).toBe('FAILED');
    expect(request).not.toHaveBeenCalled();
    expect(
      parseStoredWorkspaceUploads([{ ...task, file: undefined }])[0]?.directCleanupPending
    ).toBe(true);
    expect(errorPresentationEnUS.errors.UPLOAD_CLEANUP_UNCONFIRMED).toContain('task has been kept');
    expect(errorPresentationZhCN.errors.UPLOAD_CLEANUP_UNCONFIRMED).toContain('任务已保留');
  });

  it('keeps a task when cancellation fails and still allows its local record to be removed', async () => {
    const request = vi.fn(async () => {
      throw new Error('UPLOAD_NETWORK_FAILED');
    });
    const service = createWorkspaceUploadService({
      workspaceTarget: ref(undefined),
      csrfToken: ref('token'),
      request,
      renewCsrfToken: async () => 'token',
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

  it('removes a failed direct task and its notification even when remote cleanup is unconfirmed', async () => {
    const notifications = createWorkbenchNotificationService(ref(undefined));
    const request = vi.fn();
    const service = createWorkspaceUploadService({
      workspaceTarget: ref({ nodeId: 'node-1', workspaceId: 'workspace-1' } as never),
      csrfToken: ref('token'),
      request,
      renewCsrfToken: async () => 'token',
      onFilesChanged: vi.fn(),
      onTaskChanged: notifications.recordUpload,
      direct: {
        generation: () => 'generation-1',
        upload: async () => {
          throw new Error('UPLOAD_NOT_FOUND');
        }
      }
    });
    try {
      service.queue([{ file: new File(['abc'], 'file.txt'), directory: '.', overwrite: false }]);
      await vi.waitFor(() => expect(service.tasks.value[0]?.status).toBe('FAILED'));
      const task = service.tasks.value[0]!;
      expect(task.directCleanupPending).toBe(true);
      expect(notifications.notifications.value).toHaveLength(1);
      await service.remove(task);
      expect(service.tasks.value).toEqual([]);
      expect(notifications.notifications.value).toEqual([]);
      expect(request).not.toHaveBeenCalled();
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
            directCleanupPending: true,
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
        csrfToken: ref('token'),
        request,
        renewCsrfToken: async () => 'token',
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
        await vi.waitFor(() => expect(task.cleanupUnconfirmed).toBe(true));
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
      return { upload: { uploadId: 'upload-1', receivedBytes: 0, size: 0 } } as never;
    });
    const onFilesChanged = vi.fn();
    const service = createWorkspaceUploadService({
      workspaceTarget: ref({ nodeId: 'node-1', workspaceId: 'workspace-1' } as never),
      csrfToken: ref('token'),
      request,
      renewCsrfToken: async () => 'token',
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
        '/api/workspaces/workspace-1/uploads/upload-1/complete',
        '/api/workspaces/workspace-1/uploads/upload-1/cancel'
      ]);
    } finally {
      completeUpload();
      service.dispose();
      notifications.dispose();
    }
  });

  it('never relays a retry while a prior direct upload may still exist', async () => {
    let available = true;
    const request = vi.fn();
    const service = createWorkspaceUploadService({
      workspaceTarget: ref({ nodeId: 'node-1', workspaceId: 'workspace-1' } as never),
      csrfToken: ref('token'),
      request,
      renewCsrfToken: async () => 'token',
      onFilesChanged: vi.fn(),
      direct: {
        generation: () => (available ? 'generation-1' : undefined),
        upload: async () => {
          throw new Error('DIRECT_CHANNEL_CLOSED');
        }
      }
    });
    service.queue([{ file: new File(['abc'], 'file.txt'), directory: '.', overwrite: false }]);
    await vi.waitFor(() => expect(service.tasks.value[0]?.status).toBe('FAILED'));
    available = false;
    await service.retry(service.tasks.value[0]!);
    await vi.waitFor(() => expect(service.tasks.value[0]?.status).toBe('FAILED'));
    expect(service.tasks.value[0]?.directCleanupPending).toBe(true);
    expect(request).not.toHaveBeenCalled();
  });

  it.each([
    ['', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
    ['abc', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad']
  ])('hashes the complete file with SHA-256 (%s)', async (text, expected) => {
    expect(await workspaceFileSha256(new Blob([text!]))).toBe(expected);
  });

  it('keeps relay fallback available when hashing fails before a direct request', async () => {
    const file = new File([], 'empty.txt');
    vi.spyOn(file, 'arrayBuffer').mockRejectedValue(new Error('Web Crypto unavailable'));
    const directUpload = vi.fn(async () => undefined);
    const request = vi.fn(async () => ({ upload: { uploadId: 'upload-1', receivedBytes: 0 } }));
    const service = createWorkspaceUploadService({
      workspaceTarget: ref({ nodeId: 'node-1', workspaceId: 'workspace-1' } as never),
      csrfToken: ref('token'),
      request: request as never,
      renewCsrfToken: async () => 'token',
      onFilesChanged: vi.fn(),
      direct: { generation: () => 'generation-1', upload: directUpload }
    });
    service.queue([{ file, directory: '.', overwrite: false }]);
    await vi.waitFor(() => expect(service.tasks.value[0]?.status).toBe('COMPLETED'));
    expect(directUpload).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledTimes(2);
    expect(service.tasks.value[0]?.transport).toBe('SERVER');
  });

  it.each(['cancel', 'dispose'] as const)(
    'does not start a direct upload after %s while hashing the file',
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
        csrfToken: ref('token'),
        request: request as never,
        renewCsrfToken: async () => 'token',
        onFilesChanged: vi.fn(),
        direct: { generation: () => 'generation-1', upload: directUpload }
      });
      service.queue([{ file, directory: '.', overwrite: true }]);
      if (action === 'cancel') await service.cancel(service.tasks.value[0]!);
      else service.dispose();
      finishHash(new TextEncoder().encode('original').buffer);
      await vi.waitFor(() => expect(service.tasks.value[0]?.status).not.toBe('UPLOADING'));
      await new Promise((resolve) => setImmediate(resolve));
      expect(service.tasks.value[0]?.status).toBe('CANCELLED');
      expect(directUpload).not.toHaveBeenCalled();
      expect(request).not.toHaveBeenCalled();
      service.dispose();
    }
  );

  it.each(['cancel', 'dispose'] as const)(
    'does not retry a chunk after %s during CSRF renewal',
    async (action) => {
      const renewal = gate<void>();
      const renewCsrfToken = vi.fn(async () => {
        await renewal.promise;
        return 'renewed';
      });
      const sends = vi.fn();
      class RejectedChunk {
        upload = {};
        status = 403;
        responseText = JSON.stringify({ error: { code: 'CSRF_INVALID' } });
        onload?: () => void;
        onabort?: () => void;
        open() {}
        setRequestHeader() {}
        send() {
          sends();
          this.onload?.();
        }
        abort() {
          this.onabort?.();
        }
      }
      vi.stubGlobal('XMLHttpRequest', RejectedChunk);
      const request = vi.fn(async (path: string) =>
        path.endsWith('/uploads')
          ? { upload: { uploadId: 'chunk-id', receivedBytes: 0, size: 1 } }
          : { cancelled: true }
      );
      const { service } = lifecycleFixture(request, renewCsrfToken);
      try {
        service.queue([{ file: new File(['x'], 'chunk.txt'), directory: '.', overwrite: false }]);
        await vi.waitFor(() => expect(renewCsrfToken).toHaveBeenCalledOnce());
        if (action === 'cancel') await service.cancel(service.tasks.value[0]!);
        else service.dispose();
        renewal.resolve();
        await vi.waitFor(() => expect(service.tasks.value[0]!.status).toBe('CANCELLED'));
        await nextTick();
        expect(sends).toHaveBeenCalledOnce();
        expect(request.mock.calls.map(([path]) => path)).toEqual([
          '/api/workspaces/workspace-1/uploads',
          '/api/workspaces/workspace-1/uploads/chunk-id/cancel'
        ]);
      } finally {
        renewal.resolve();
        service.dispose();
        vi.unstubAllGlobals();
      }
    }
  );

  it('describes the active Server transport without repeating direct unavailability', () => {
    expect(notificationsEnUS.generated.workspaceUploadService.uploadingServerFallback).toBe(
      notificationsEnUS.generated.workspaceUploadService.uploadingServer
    );
    expect(notificationsZhCN.generated.workspaceUploadService.uploadingServerFallback).toBe(
      notificationsZhCN.generated.workspaceUploadService.uploadingServer
    );
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

  it('does not relay-fallback after a direct upload has begun and includes the complete file digest', async () => {
    const directUpload = vi.fn(async (input: { descriptor: { sha256: string } }) => {
      const digest = await globalThis.crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode('original')
      );
      expect(input.descriptor.sha256).toBe(
        [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
      );
      throw new Error('DIRECT_CHANNEL_CLOSED');
    });
    let requestCount = 0;
    const request = async <T>(_path: string, _init?: RequestInit): Promise<T> => {
      requestCount += 1;
      return {} as T;
    };
    const service = createWorkspaceUploadService({
      workspaceTarget: ref({ nodeId: 'node-1', workspaceId: 'workspace-1' } as never),
      csrfToken: ref('token'),
      request,
      renewCsrfToken: async () => 'token',
      onFilesChanged: vi.fn(),
      direct: { generation: () => 'generation-1', upload: directUpload as never }
    });
    service.queue([{ file: new File(['original'], 'same.txt'), directory: '.', overwrite: true }]);
    await vi.waitFor(() => expect(service.tasks.value[0]?.status).toBe('FAILED'));
    expect(directUpload).toHaveBeenCalledOnce();
    expect(requestCount).toBe(0);
  });
});
