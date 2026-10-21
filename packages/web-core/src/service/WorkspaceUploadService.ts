import type { WorkspaceTarget } from '../model/workbench.js';
import { computed, ref, watch, type Ref } from 'vue';
import { translate } from './LocalePreferenceService.js';
import { errorCode } from '../util/api-error.js';
import { errorMessage } from '../util/error-presentation.js';
import type { DirectTransferDescriptor } from '@myagentroam/protocol';
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
  transport?: 'DIRECT' | 'SERVER';
  directFallback?: boolean;
  directCleanupPending?: boolean;
  cleanupUnconfirmed?: boolean;
}

interface StoredWorkspaceUploadTask {
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
  readonly directCleanupPending?: boolean;
  readonly cleanupUnconfirmed?: boolean;
}

interface WorkspaceUploadOptions {
  readonly workspaceTarget: Readonly<Ref<WorkspaceTarget | undefined>>;
  readonly csrfToken: Ref<string>;
  readonly request: <T>(path: string, init?: RequestInit) => Promise<T>;
  readonly renewCsrfToken: () => Promise<string>;
  readonly onFilesChanged: () => void;
  readonly onTaskChanged?: (task: WorkspaceUploadTask) => void;
  readonly direct?: {
    readonly generation: (nodeId: string) => string | undefined;
    readonly upload: (input: {
      readonly nodeId: string;
      readonly nodeGeneration: string;
      readonly descriptor: DirectTransferDescriptor;
      readonly file: File;
      readonly onProgress: (offset: number) => void;
      readonly signal: AbortSignal;
    }) => Promise<void>;
  };
}

const STORAGE_KEY = 'mar.workspace-upload-tasks';
const CHUNK_BYTES = 512 * 1024;
const MAX_CONCURRENT_UPLOADS = 2;

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
      (item.directCleanupPending !== undefined && typeof item.directCleanupPending !== 'boolean') ||
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
        directCleanupPending:
          item.directCleanupPending === true ||
          (item.directCleanupPending === undefined && item.uploadId === undefined),
        cleanupUnconfirmed: item.cleanupUnconfirmed === true
      }
    ];
  });
}

export function createWorkspaceUploadService(options: WorkspaceUploadOptions) {
  const tasks = ref<WorkspaceUploadTask[]>([]);
  const recoveryInput = ref<HTMLInputElement>();
  const pendingRecoveryId = ref<string>();
  const activeRequests = new Map<string, XMLHttpRequest>();
  const directRequests = new Map<string, AbortController>();
  const cancellations = new Map<string, Promise<boolean>>();
  const committing = new Set<string>();
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

  function persist(): void {
    const stored: StoredWorkspaceUploadTask[] = tasks.value.flatMap((task) => {
      if (!['QUEUED', 'UPLOADING', 'FAILED', 'INTERRUPTED'].includes(task.status)) return [];
      return [
        {
          id: task.id,
          nodeId: task.nodeId,
          workspaceId: task.workspaceId,
          directory: task.directory,
          name: task.name,
          size: task.size,
          overwrite: task.overwrite,
          ...(task.uploadId === undefined ? {} : { uploadId: task.uploadId }),
          receivedBytes: task.receivedBytes,
          directCleanupPending: task.directCleanupPending === true,
          cleanupUnconfirmed: task.cleanupUnconfirmed === true,
          status: task.status as StoredWorkspaceUploadTask['status'],
          ...(task.error === undefined ? {} : { error: task.error })
        }
      ];
    });
    try {
      if (stored.length === 0) window.sessionStorage.removeItem(STORAGE_KEY);
      else window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
    } catch {
      // sessionStorage supports refresh recovery only; Node timeouts still clean temporary files.
    }
  }

  function restore(): void {
    if (closed) return;
    try {
      tasks.value = parseStoredWorkspaceUploads(
        JSON.parse(window.sessionStorage.getItem(STORAGE_KEY) ?? '[]') as unknown
      );
    } catch {
      window.sessionStorage.removeItem(STORAGE_KEY);
    }
  }

  function changed(task: WorkspaceUploadTask): void {
    if (closed || !tasks.value.some((item) => item.id === task.id)) return;
    options.onTaskChanged?.(task);
  }

  function statusLabel(task: WorkspaceUploadTask): string {
    if (task.status === 'UPLOADING') {
      if (task.transport === 'DIRECT')
        return translate('generated.workspaceUploadService.uploadingDirect');
      if (task.transport === 'SERVER' && task.directFallback === true)
        return translate('generated.workspaceUploadService.uploadingServerFallback');
      if (task.transport === 'SERVER')
        return translate('generated.workspaceUploadService.uploadingServer');
      return translate('generated.workspaceUploadService.uploading');
    }
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
        id: crypto.randomUUID(),
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
    try {
      if (task.file === undefined) throw new Error('UPLOAD_SOURCE_REQUIRED');
      const generation = options.direct?.generation(task.nodeId);
      const retainedDirectUpload = task.directCleanupPending === true;
      if (retainedDirectUpload && task.uploadId === undefined && generation === undefined)
        throw new Error('DIRECT_UNAVAILABLE');
      if (task.uploadId === undefined && generation !== undefined) {
        const directController = new AbortController();
        directRequests.set(task.id, directController);
        let uploadRequested = false;
        try {
          task.transport = 'DIRECT';
          changed(task);
          const path =
            task.directory === '.' || task.directory === ''
              ? task.name
              : `${task.directory.replace(/\/+$/u, '')}/${task.name}`;
          const sha256 = await workspaceFileSha256(task.file);
          if (closed || task.cancelled) throw new Error('UPLOAD_CANCELLED');
          uploadRequested = true;
          task.directCleanupPending = true;
          await options.direct!.upload({
            nodeId: task.nodeId,
            nodeGeneration: generation,
            descriptor: {
              direction: 'UPLOAD',
              resource: { kind: 'WORKSPACE_FILE', workspaceId: task.workspaceId, path },
              fileName: task.name,
              size: task.size,
              sha256,
              overwrite: task.overwrite
            },
            file: task.file,
            onProgress: (offset) => {
              task.receivedBytes = offset;
            },
            signal: directController.signal
          });
          if (task.cancelled) throw new Error('UPLOAD_CANCELLED');
          task.directCleanupPending = false;
          task.cleanupUnconfirmed = false;
          task.receivedBytes = task.size;
          task.status = 'COMPLETED';
          if (!closed) options.onFilesChanged();
          changed(task);
          return;
        } catch (error) {
          const code = errorCode(error);
          if (closed || task.cancelled || code === 'UPLOAD_CANCELLED') throw error;
          if (retainedDirectUpload) throw error;
          if (
            uploadRequested &&
            code !== 'DIRECT_UNAVAILABLE' &&
            code !== 'DIRECT_TRANSFER_INVALID' &&
            code !== 'DIRECT_TRANSFER_UNAVAILABLE' &&
            code !== 'DIRECT_PREPARE_TIMEOUT' &&
            code !== 'DIRECT_SESSION_LIMIT_REACHED' &&
            code !== 'DIRECT_TRANSFER_GRANT_INVALID'
          )
            throw error;
          task.receivedBytes = 0;
          task.directCleanupPending = false;
          task.transport = 'SERVER';
          task.directFallback = true;
          changed(task);
        } finally {
          directRequests.delete(task.id);
        }
      }
      if (closed || task.cancelled) return;
      task.transport = 'SERVER';
      if (task.uploadId !== undefined) {
        try {
          const current = await options.request<{
            upload: { readonly receivedBytes: number; readonly size: number };
          }>(
            `/api/workspaces/${encodeURIComponent(task.workspaceId)}/uploads/${encodeURIComponent(task.uploadId)}?nodeId=${encodeURIComponent(task.nodeId)}`
          );
          if (current.upload.size !== task.size) throw new Error('UPLOAD_SOURCE_MISMATCH');
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
          };
        }>(`/api/workspaces/${encodeURIComponent(task.workspaceId)}/uploads`, {
          method: 'POST',
          body: JSON.stringify({
            nodeId: task.nodeId,
            directory: task.directory,
            name: task.name,
            size: task.size,
            overwrite: task.overwrite
          })
        });
        task.uploadId = created.upload.uploadId;
        task.receivedBytes = created.upload.receivedBytes;
        if (closed || task.cancelled) {
          await cancel(task);
          return;
        }
      }
      while (task.receivedBytes < task.size) {
        if (closed || task.cancelled) throw new Error('UPLOAD_CANCELLED');
        const offset = task.receivedBytes;
        const chunk = task.file.slice(offset, Math.min(task.size, offset + CHUNK_BYTES));
        const result = await uploadChunk(task, offset, chunk);
        task.receivedBytes = result.receivedBytes;
      }
      if (closed || task.cancelled) throw new Error('UPLOAD_CANCELLED');
      committing.add(task.id);
      const completed = await options.request<{ upload: { readonly receivedBytes: number } }>(
        `/api/workspaces/${encodeURIComponent(task.workspaceId)}/uploads/${encodeURIComponent(task.uploadId)}/complete`,
        { method: 'POST', body: JSON.stringify({ nodeId: task.nodeId }) }
      );
      task.receivedBytes = completed.upload.receivedBytes;
      task.status = 'COMPLETED';
      if (!closed) options.onFilesChanged();
      changed(task);
    } catch (error) {
      if (task.cancelled || errorCode(error) === 'UPLOAD_CANCELLED') {
        task.status = task.directCleanupPending || task.cleanupUnconfirmed ? 'FAILED' : 'CANCELLED';
        if (task.directCleanupPending) task.cleanupUnconfirmed = true;
        changed(task);
        return;
      }
      task.status = closed ? 'INTERRUPTED' : 'FAILED';
      task.error = errorMessage(error);
      changed(task);
    } finally {
      activeRequests.delete(task.id);
      directRequests.delete(task.id);
      committing.delete(task.id);
    }
  }

  async function uploadChunk(
    task: WorkspaceUploadTask,
    offset: number,
    chunk: Blob
  ): Promise<{ readonly receivedBytes: number }> {
    let lastError: unknown;
    let renewedCsrfToken = false;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (closed || task.cancelled) throw new Error('UPLOAD_CANCELLED');
      try {
        return await new Promise<{ readonly receivedBytes: number }>((resolve, reject) => {
          const xhr = new XMLHttpRequest();
          activeRequests.set(task.id, xhr);
          xhr.open(
            'POST',
            `/api/workspaces/${encodeURIComponent(task.workspaceId)}/uploads/${encodeURIComponent(task.uploadId ?? '')}/chunks?nodeId=${encodeURIComponent(task.nodeId)}&offset=${offset}`
          );
          xhr.withCredentials = true;
          xhr.setRequestHeader('content-type', 'application/octet-stream');
          xhr.setRequestHeader('x-csrf-token', options.csrfToken.value);
          xhr.upload.onprogress = (event) => {
            if (event.lengthComputable)
              task.receivedBytes = Math.min(task.size, offset + event.loaded);
          };
          xhr.onerror = () => reject(new Error('UPLOAD_NETWORK_FAILED'));
          xhr.onabort = () => reject(new Error('UPLOAD_CANCELLED'));
          xhr.onload = () => {
            if (xhr.status < 200 || xhr.status >= 300) {
              let code: string | undefined;
              try {
                code = (JSON.parse(xhr.responseText) as { error?: { code?: string } }).error?.code;
              } catch {
                code = undefined;
              }
              reject(new Error(code ?? `REQUEST_FAILED_${xhr.status}`));
              return;
            }
            try {
              const body = JSON.parse(xhr.responseText) as { upload?: { receivedBytes?: unknown } };
              if (!Number.isSafeInteger(body.upload?.receivedBytes))
                throw new Error('NODE_RESPONSE_INVALID');
              resolve({ receivedBytes: body.upload?.receivedBytes as number });
            } catch (error) {
              reject(error);
            }
          };
          xhr.send(chunk);
        });
      } catch (error) {
        lastError = error;
        if (closed || task.cancelled) throw error;
        if (errorCode(error) === 'CSRF_INVALID') {
          if (renewedCsrfToken) throw error;
          renewedCsrfToken = true;
          await options.renewCsrfToken();
        }
        task.receivedBytes = offset;
      }
    }
    throw lastError instanceof Error ? lastError : new Error('UPLOAD_CHUNK_FAILED');
  }

  async function cancel(task: WorkspaceUploadTask): Promise<boolean> {
    const pending = cancellations.get(task.id);
    if (pending !== undefined) return pending;
    // A cancellation before create returns owns no remote identity yet. Do not cache it:
    // the in-flight create still has to hand its late identity back to this cleanup path.
    const cancellation = cancelUpload(task);
    if (task.uploadId === undefined) return cancellation;
    cancellations.set(task.id, cancellation);
    try {
      return await cancellation;
    } finally {
      cancellations.delete(task.id);
    }
  }

  async function cancelUpload(task: WorkspaceUploadTask): Promise<boolean> {
    if (
      (task.status === 'COMPLETED' || task.status === 'CANCELLED') &&
      task.uploadId === undefined &&
      !task.directCleanupPending
    )
      return true;
    task.cancelled = true;
    directRequests.get(task.id)?.abort();
    activeRequests.get(task.id)?.abort();
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
          changed(task);
          return false;
        }
      }
      delete task.uploadId;
    }
    if (task.directCleanupPending) {
      task.cleanupUnconfirmed = true;
      task.status = 'FAILED';
      changed(task);
      return false;
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
    if (task.uploadId !== undefined && !(await cancel(task))) return;
    if (closed) return;
    task.cancelled = false;
    delete task.uploadId;
    task.receivedBytes = 0;
    delete task.error;
    delete task.directFallback;
    delete task.transport;
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
    persist();
    // Keep the recovery snapshot, but never let this old owner overwrite a new page.
    // A submitted complete is authoritative; cancelling it cannot promise rollback.
    for (const task of tasks.value) {
      if (task.status === 'UPLOADING' && task.uploadId !== undefined && !committing.has(task.id))
        void cancel(task);
    }
    for (const request of directRequests.values()) request.abort();
    directRequests.clear();
    for (const request of activeRequests.values()) request.abort();
    activeRequests.clear();
  }

  const stopPersisting = watch(
    tasks,
    () => {
      persist();
    },
    { deep: true }
  );

  return {
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
