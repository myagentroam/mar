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

  it('does not start a direct upload when cancelled while hashing the file', async () => {
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
    await service.cancel(service.tasks.value[0]!);
    finishHash(new TextEncoder().encode('original').buffer);
    await vi.waitFor(() => expect(service.tasks.value[0]?.status).not.toBe('UPLOADING'));
    await new Promise((resolve) => setImmediate(resolve));
    expect(service.tasks.value[0]?.status).toBe('CANCELLED');
    expect(directUpload).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });

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
