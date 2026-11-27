import { createUuid } from '../util/uuid.js';
import { unboundAccountStorage } from './account-storage-service.js';
import type { WorkspaceTarget } from '../model/workbench.js';
import { computed, ref, watch, type Ref } from 'vue';
import { translate } from './locale-preference-service.js';
import { errorCode } from '../util/api-error.js';
import { errorMessage } from '../util/error-presentation.js';
import { workspaceFileSha256 } from '../util/workspace-file-checksum.js';

export interface WorkspaceUploadRequest {
  readonly file: File;
  readonly directory: string;
  readonly overwrite: boolean;
}

export interface WorkspaceUploadTask extends Omit<WorkspaceUploadRequest, 'file'> {
  file?: File;
  readonly id: string;
  readonly nodeId: string;
  readonly workspaceId: string;
  readonly name: string;
  readonly size: number;
  uploadId?: string;
  receivedBytes: number;
  status: 'QUEUED' | 'UPLOADING' | 'COMPLETED' | 'FAILED' | 'CANCELLED' | 'INTERRUPTED';
  error?: string;
  cancelled: boolean;
  cleanupUnconfirmed?: boolean;
}

interface StoredWorkspaceUploadTask {
  readonly recoveryOwner?: string;
  readonly id: string;
  readonly nodeId: string;
  readonly workspaceId: string;
  readonly directory: string;
  readonly name: string;
  readonly size: number;
  readonly overwrite: boolean;
  readonly uploadId?: string;
  readonly receivedBytes: number;
  readonly status: 'QUEUED' | 'UPLOADING' | 'FAILED' | 'INTERRUPTED';
  readonly error?: string;
  readonly cleanupUnconfirmed?: boolean;
}

interface WorkspaceUploadOptions {
  readonly storage?: Storage;
  readonly workspaceTarget: Readonly<Ref<WorkspaceTarget | undefined>>;
  readonly request: <T>(path: string, init?: RequestInit) => Promise<T>;
  readonly onFilesChanged: () => void;
  readonly onTaskChanged?: (task: WorkspaceUploadTask) => void;
  readonly sendBody: ReturnType<
    typeof import('./workspace-file-stream-client.js').createWorkspaceFileStreamClient
  >['upload'];
}

const STORAGE_KEY = 'mar.workspace-upload-tasks';
const MAX_CONCURRENT_UPLOADS = 2;

interface RecoveryReceiver {
  receive(expected: StoredWorkspaceUploadTask, failed: WorkspaceUploadTask): void;
}

// Only live restored owners are registered here; disposed owners never resume subscriptions.
const recoveryReceivers = new Map<string, RecoveryReceiver>();

function matchesRecoveryEntry(value: unknown, expected: StoredWorkspaceUploadTask): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const entry = value as StoredWorkspaceUploadTask;
  // Restoring changes presentation, not the upload attempt or its recovery ownership.
  return (
    JSON.stringify(
      entry.status === 'INTERRUPTED' ? { ...entry, status: expected.status } : entry
    ) === JSON.stringify(expected)
  );
}

export function parseStoredWorkspaceUploads(value: unknown): WorkspaceUploadTask[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): WorkspaceUploadTask[] => {
    if (
      typeof item !== 'object' ||
      item === null ||
      typeof item.id !== 'string' ||
      typeof item.nodeId !== 'string' ||
      typeof item.workspaceId !== 'string' ||
      typeof item.directory !== 'string' ||
      typeof item.name !== 'string' ||
      !Number.isSafeInteger(item.size) ||
      item.size < 0 ||
      typeof item.overwrite !== 'boolean' ||
      !Number.isSafeInteger(item.receivedBytes) ||
      item.receivedBytes < 0 ||
      item.receivedBytes > item.size ||
      (item.uploadId !== undefined && typeof item.uploadId !== 'string') ||
      (item.cleanupUnconfirmed !== undefined && typeof item.cleanupUnconfirmed !== 'boolean')
    )
      return [];
    return [
      {
        id: item.id,
        nodeId: item.nodeId,
        workspaceId: item.workspaceId,
        directory: item.directory,
        name: item.name,
        size: item.size,
        overwrite: item.overwrite,
        ...(typeof item.uploadId === 'string' ? { uploadId: item.uploadId } : {}),
        receivedBytes: item.receivedBytes,
        status: 'INTERRUPTED',
        ...(typeof item.error === 'string' ? { error: item.error } : {}),
        cancelled: false,
        cleanupUnconfirmed: item.cleanupUnconfirmed === true
      }
    ];
  });
}

/** Owns local transfers and refresh recovery, using the storage bound by the page root.
 * Account cleanup cancels local ownership and discards recovery; page disposal keeps
 * its existing recovery behavior. Authentication and account selection stay outside.
 */
export function createWorkspaceUploadService(options: WorkspaceUploadOptions) {
  let storage =
    options.storage ??
    (typeof window === 'undefined' ? unboundAccountStorage : window.sessionStorage);
  const tasks = ref<WorkspaceUploadTask[]>([]);
  const recoveryInput = ref<HTMLInputElement>();
  const pendingRecoveryId = ref<string>();
  const bodyRequests = new Map<string, AbortController>();
  const sourceDigests = new WeakMap<File, string>();
  const cancellations = new Map<string, Promise<boolean>>();
  const committing = new Set<string>();
  const disposedRecoveryEntries = new Map<string, StoredWorkspaceUploadTask>();
  const recoveryOwner = createUuid();
  const recoveryGenerations = new Map<string, string>();
  const recoveryReceiver: RecoveryReceiver = { receive: receiveCleanupFailure };
  let closed = false;

  const activeCount = computed(
    () =>
      tasks.value.filter((task) => task.status === 'QUEUED' || task.status === 'UPLOADING').length
  );
  const progress = computed(() => {
    const total = tasks.value.reduce((sum, task) => sum + task.size, 0);
    if (total === 0) return tasks.value.length === 0 ? 0 : 100;
    return Math.min(
      100,
      Math.round(
        (tasks.value.reduce((sum, task) => sum + Math.min(task.receivedBytes, task.size), 0) /
          total) *
          100
      )
    );
  });

  function storedTask(task: WorkspaceUploadTask): StoredWorkspaceUploadTask {
    return {
      recoveryOwner: recoveryGenerations.get(task.id) ?? recoveryOwner,
      id: task.id,
      nodeId: task.nodeId,
      workspaceId: task.workspaceId,
      directory: task.directory,
      name: task.name,
      size: task.size,
      overwrite: task.overwrite,
      ...(task.uploadId === undefined ? {} : { uploadId: task.uploadId }),
      receivedBytes: task.receivedBytes,
      cleanupUnconfirmed: task.cleanupUnconfirmed === true,
      status: task.status as StoredWorkspaceUploadTask['status'],
      ...(task.error === undefined ? {} : { error: task.error })
    };
  }

  function persist(): StoredWorkspaceUploadTask[] {
    const stored: StoredWorkspaceUploadTask[] = tasks.value.flatMap((task) => {
      if (!['QUEUED', 'UPLOADING', 'FAILED', 'INTERRUPTED'].includes(task.status)) return [];
      return [storedTask(task)];
    });
    try {
      if (stored.length === 0) storage.removeItem(STORAGE_KEY);
      else storage.setItem(STORAGE_KEY, JSON.stringify(stored));
    } catch {
      // sessionStorage supports refresh recovery only; Node timeouts still clean temporary files.
    }
    return stored;
  }

  function retainDisposedCleanupFailure(task: WorkspaceUploadTask): void {
    const expected = disposedRecoveryEntries.get(task.id);
    if (!closed || expected === undefined) return;
    disposedRecoveryEntries.delete(task.id);
    const receiver = recoveryReceivers.get(task.id);
    if (receiver !== undefined) {
      receiver.receive(expected, task);
      return;
    }
    try {
      const current: unknown = JSON.parse(storage.getItem(STORAGE_KEY) ?? '[]');
      if (!Array.isArray(current)) return;
      // Patch only the unchanged recovery entry, never an old owner's entire snapshot.
      const index = current.findIndex((entry) => matchesRecoveryEntry(entry, expected));
      if (index === -1) return;
      current[index] = {
        ...current[index],
        uploadId: task.uploadId,
        receivedBytes: task.receivedBytes,
        status: 'FAILED',
        cleanupUnconfirmed: true,
        error: task.error
      };
      storage.setItem(STORAGE_KEY, JSON.stringify(current));
    } catch {
      // Unavailable recovery storage cannot guarantee remote cleanup; Node TTL remains the fallback.
    }
  }

  function receiveCleanupFailure(
    expected: StoredWorkspaceUploadTask,
    failed: WorkspaceUploadTask
  ): void {
    if (closed) return;
    const task = tasks.value.find((item) => item.id === expected.id);
    if (task?.status !== 'INTERRUPTED' || !matchesRecoveryEntry(storedTask(task), expected)) return;
    // Merge recovery metadata into the current owner, never publish old page callbacks or drain.
    Object.assign(task, {
      uploadId: failed.uploadId,
      receivedBytes: failed.receivedBytes,
      cleanupUnconfirmed: true,
      error: failed.error
    });
    persist();
  }

  function releaseRecoveryReceivers(): void {
    for (const id of recoveryGenerations.keys()) {
      if (recoveryReceivers.get(id) === recoveryReceiver) recoveryReceivers.delete(id);
    }
  }

  function invalidateRecovery(task: WorkspaceUploadTask): void {
    recoveryGenerations.set(task.id, createUuid());
  }

  function restore(): void {
    if (closed) return;
    releaseRecoveryReceivers();
    recoveryGenerations.clear();
    try {
      const stored: unknown = JSON.parse(storage.getItem(STORAGE_KEY) ?? '[]');
      tasks.value = parseStoredWorkspaceUploads(stored);
      for (const task of tasks.value) {
        const original = Array.isArray(stored)
          ? stored.find((entry) => entry?.id === task.id)
          : undefined;
        recoveryGenerations.set(
          task.id,
          typeof original?.recoveryOwner === 'string' ? original.recoveryOwner : recoveryOwner
        );
        recoveryReceivers.set(task.id, recoveryReceiver);
      }
      // Preserve restore-only lineage; an actual user mutation invalidates it synchronously.
      persist();
    } catch {
      storage.removeItem(STORAGE_KEY);
    }
  }

  function changed(task: WorkspaceUploadTask): void {
    if (closed || !tasks.value.some((item) => item.id === task.id)) return;
    options.onTaskChanged?.(task);
  }

  function statusLabel(task: WorkspaceUploadTask): string {
    if (task.status === 'UPLOADING') return translate('generated.workspaceUploadService.uploading');
    if (task.status === 'QUEUED') return translate('generated.workspaceUploadService.queued');
    if (task.status === 'COMPLETED') return translate('generated.workspaceUploadService.completed');
    if (task.status === 'CANCELLED') return translate('generated.workspaceUploadService.canceled');
    if (task.status === 'INTERRUPTED')
      return translate('generated.workspaceUploadService.interrupted');
    return translate('generated.workspaceUploadService.failed');
  }

  function queue(uploads: readonly WorkspaceUploadRequest[]): void {
    if (closed) return;
    const nodeId = options.workspaceTarget.value?.nodeId;
    const workspaceId = options.workspaceTarget.value?.workspaceId;
    if (nodeId === undefined || workspaceId === undefined) return;
    tasks.value.push(
      ...uploads.map((upload) => ({
        ...upload,
        id: createUuid(),
        nodeId,
        workspaceId,
        name: upload.file.name,
        size: upload.file.size,
        receivedBytes: 0,
        status: 'QUEUED' as const,
        cancelled: false
      }))
    );
    for (const task of tasks.value.slice(-uploads.length)) changed(task);
    void drain();
  }

  async function drain(): Promise<void> {
    while (
      !closed &&
      tasks.value.filter((task) => task.status === 'UPLOADING').length < MAX_CONCURRENT_UPLOADS
    ) {
      const next = tasks.value.find((task) => task.status === 'QUEUED');
      if (next === undefined) return;
      next.status = 'UPLOADING';
      changed(next);
      void upload(next).finally(() => void drain());
    }
  }

  async function upload(task: WorkspaceUploadTask): Promise<void> {
    const owner = storage;
    try {
      if (task.file === undefined) throw new Error('UPLOAD_SOURCE_REQUIRED');
      const source = task.file;
      const uploadController = new AbortController();
      bodyRequests.set(task.id, uploadController);
      const sha256 =
        sourceDigests.get(source) ?? (await workspaceFileSha256(source, uploadController.signal));
      sourceDigests.set(source, sha256);
      if (closed || task.cancelled || owner !== storage) return;
      let stagedPath: string | undefined;
      if (task.uploadId !== undefined) {
        try {
          const current = await options.request<{
            upload: {
              readonly receivedBytes: number;
              readonly size: number;
              readonly path: string;
            };
          }>(
            `/api/workspaces/${encodeURIComponent(task.workspaceId)}/uploads/${encodeURIComponent(task.uploadId)}?nodeId=${encodeURIComponent(task.nodeId)}`
          );
          if (current.upload.size !== task.size) throw new Error('UPLOAD_SOURCE_MISMATCH');
          stagedPath = current.upload.path;
          task.receivedBytes = current.upload.receivedBytes;
        } catch (error) {
          if (errorCode(error) !== 'UPLOAD_NOT_FOUND') throw error;
          delete task.uploadId;
          task.receivedBytes = 0;
        }
      }
      if (closed || task.cancelled) return;
      if (task.uploadId === undefined) {
        const created = await options.request<{
          upload: {
            readonly uploadId: string;
            readonly receivedBytes: number;
            readonly size: number;
            readonly path: string;
          };
        }>(`/api/workspaces/${encodeURIComponent(task.workspaceId)}/uploads`, {
          method: 'POST',
          body: JSON.stringify({
            nodeId: task.nodeId,
            directory: task.directory,
            name: task.name,
            size: task.size,
            overwrite: task.overwrite,
            sha256
          })
        });
        if (owner !== storage) return;
        task.uploadId = created.upload.uploadId;
        stagedPath = created.upload.path;
        task.receivedBytes = created.upload.receivedBytes;
        if (closed || task.cancelled) {
          await cancel(task);
          return;
        }
      }
      if (typeof stagedPath !== 'string') throw new Error('NODE_RESPONSE_INVALID');
      await options.sendBody({
        nodeId: task.nodeId,
        descriptor: {
          direction: 'UPLOAD',
          uploadId: task.uploadId,
          resource: {
            kind: 'WORKSPACE_FILE',
            workspaceId: task.workspaceId,
            path: stagedPath
          },
          fileName: task.name,
          size: task.size,
          sha256,
          overwrite: task.overwrite
        },
        file: source,
        signal: uploadController.signal,
        onProgress: (offset) => {
          task.receivedBytes = offset;
        }
      });
      if (closed || task.cancelled) throw new Error('UPLOAD_CANCELLED');
      committing.add(task.id);
      const completed = await options.request<{ upload: { readonly receivedBytes: number } }>(
        `/api/workspaces/${encodeURIComponent(task.workspaceId)}/uploads/${encodeURIComponent(task.uploadId)}/complete`,
        { method: 'POST', body: JSON.stringify({ nodeId: task.nodeId }) }
      );
      task.receivedBytes = completed.upload.receivedBytes;
      delete task.uploadId;
      task.status = 'COMPLETED';
      if (!closed && owner === storage) options.onFilesChanged();
      changed(task);
    } catch (error) {
      // Explicit cancellation is settled by the staging cleanup result, not the local abort.
      if (task.cancelled) return;
      task.status = closed ? 'INTERRUPTED' : 'FAILED';
      task.error = errorMessage(error);
      changed(task);
    } finally {
      bodyRequests.delete(task.id);
      committing.delete(task.id);
    }
  }

  async function cancel(task: WorkspaceUploadTask, remote = true): Promise<boolean> {
    // Once complete has been submitted, only its authoritative response can settle this task.
    if (committing.has(task.id) || task.status === 'COMPLETED') return false;
    const pending = cancellations.get(task.id);
    if (pending !== undefined) return pending;
    if (!closed) invalidateRecovery(task);
    // A cancellation before create returns owns no remote identity yet. Do not cache it:
    // the in-flight create still has to hand its late identity back to this cleanup path.
    const cancellation = cancelUpload(task, remote);
    if (task.uploadId === undefined) return cancellation;
    cancellations.set(task.id, cancellation);
    try {
      return await cancellation;
    } finally {
      cancellations.delete(task.id);
    }
  }

  async function cancelUpload(task: WorkspaceUploadTask, remote = true): Promise<boolean> {
    if ((task.status === 'COMPLETED' || task.status === 'CANCELLED') && task.uploadId === undefined)
      return true;
    task.cancelled = true;
    bodyRequests.get(task.id)?.abort();
    // Account teardown only aborts local transport. Do not send an old identity's
    // cleanup through a cookie that may now belong to another user.
    if (!remote) return true;
    if (task.uploadId !== undefined) {
      try {
        await options.request(
          `/api/workspaces/${encodeURIComponent(task.workspaceId)}/uploads/${encodeURIComponent(task.uploadId)}/cancel`,
          { method: 'POST', body: JSON.stringify({ nodeId: task.nodeId }) }
        );
      } catch (error) {
        if (errorCode(error) !== 'UPLOAD_NOT_FOUND') {
          task.cleanupUnconfirmed = true;
          task.error = errorMessage(error);
          task.status = 'FAILED';
          retainDisposedCleanupFailure(task);
          changed(task);
          return false;
        }
      }
      delete task.uploadId;
    }
    task.cleanupUnconfirmed = false;
    task.status = 'CANCELLED';
    changed(task);
    return true;
  }

  async function retry(task: WorkspaceUploadTask): Promise<void> {
    if (closed) return;
    if (task.status !== 'FAILED' && task.status !== 'INTERRUPTED') return;
    if (task.file === undefined) {
      pendingRecoveryId.value = task.id;
      recoveryInput.value?.click();
      return;
    }
    const resume = !task.cancelled && !task.cleanupUnconfirmed;
    if (!resume && task.uploadId !== undefined && !(await cancel(task))) return;
    if (closed) return;
    invalidateRecovery(task);
    task.cancelled = false;
    if (!resume) {
      delete task.uploadId;
      task.receivedBytes = 0;
    }
    delete task.error;
    task.status = 'QUEUED';
    changed(task);
    void drain();
  }

  function recover(event: Event): void {
    if (closed) return;
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    const task = tasks.value.find((item) => item.id === pendingRecoveryId.value);
    input.value = '';
    pendingRecoveryId.value = undefined;
    if (file === undefined || task === undefined) return;
    invalidateRecovery(task);
    if (file.name !== task.name || file.size !== task.size) {
      task.error = translate('generated.workspaceUploadService.selectTheOriginalFileWithTheSame');
      changed(task);
      return;
    }
    task.file = file;
    task.cancelled = false;
    delete task.error;
    task.status = 'QUEUED';
    changed(task);
    void drain();
  }

  function remove(task: WorkspaceUploadTask): void {
    void cancel(task).catch(() => undefined);
    task.status = 'CANCELLED';
    changed(task);
    tasks.value = tasks.value.filter((item) => item.id !== task.id);
  }

  function dispose(): void {
    if (closed) return;
    closed = true;
    stopPersisting();
    for (const stored of persist()) disposedRecoveryEntries.set(stored.id, stored);
    releaseRecoveryReceivers();
    // Keep the recovery snapshot, but never let this old owner overwrite a new page.
    // A submitted complete is authoritative; cancelling it cannot promise rollback.
    for (const task of tasks.value) {
      if (task.status === 'UPLOADING' && task.uploadId !== undefined && !committing.has(task.id))
        void cancel(task);
    }
    for (const request of bodyRequests.values()) request.abort();
    bodyRequests.clear();
  }

  const stopPersisting = watch(
    tasks,
    () => {
      persist();
    },
    { deep: true }
  );

  return {
    bindStorage: (next: Storage) => {
      storage = next;
    },
    // End local task ownership without closing the reusable service or undoing accepted commits.
    clear: () => {
      for (const task of tasks.value) void cancel(task, false);
      releaseRecoveryReceivers();
      recoveryGenerations.clear();
      pendingRecoveryId.value = undefined;
      tasks.value = [];
      persist();
    },
    tasks,
    recoveryInput,
    activeCount,
    progress,
    restore,
    statusLabel,
    queue,
    cancel,
    retry,
    recover,
    remove,
    dispose
  };
}

export interface WorkbenchUploadsView {
  cancelWorkspaceUpload: (task: WorkspaceUploadTask) => Promise<boolean>;
  deleteWorkspaceUpload: (task: WorkspaceUploadTask) => void;
  recoverWorkspaceUpload: (event: Event) => void;
  retryWorkspaceUpload: (task: WorkspaceUploadTask) => Promise<void>;
  workspaceUploadRecoveryInput: HTMLInputElement | undefined;
  workspaceUploadStatusLabel: (task: WorkspaceUploadTask) => string;
  workspaceUploadTasks: WorkspaceUploadTask[];
}
