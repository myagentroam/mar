import { isComposerAttachmentResourcePath } from '@myagentroam/protocol';
import { readonly, ref, shallowRef } from 'vue';
import type { ScopedHttpService } from './scoped-http-service.js';
import type {
  WorkspaceFilePreviewContent,
  WorkspaceFilePreviewTarget,
  WorkspaceFilePreviewTransfers
} from '../model/workspace-file-preview.js';
import {
  directFileContentRevision,
  type WorkspaceDirectFileIdentity
} from './workspace-direct-file-read-service.js';
import {
  decodeFilePreviewRead,
  readFilePreview,
  readFilePreviewObject
} from './file-preview-read-service.js';
import {
  revokeWorkspaceDirectObjectUrl,
  triggerBrowserFileDownload
} from './workspace-direct-object-url-service.js';
import {
  binaryFilePreviewKind,
  decodeFilePreviewContent,
  shouldReadTextFilePreview,
  TEXT_FILE_PREVIEW_LIMIT_BYTES,
  usesRawFilePreview
} from '../util/file-preview.js';
import { errorCode } from '../util/api-error.js';

interface FileRead {
  readonly encoding: 'utf-8' | 'base64';
  readonly previewEncoding?: string;
  readonly size: number;
  readonly content: string;
  readonly nextOffset: number | null;
  readonly revision?: string;
}

export function workspaceFilePreviewUrl(
  target: WorkspaceFilePreviewTarget,
  download = false
): string {
  const parameters = new URLSearchParams({ nodeId: target.nodeId, path: target.path });
  const history = target.history;
  const repositoryPath = history?.repositoryPath ?? target.repositoryPath;
  if (repositoryPath !== undefined && (history === undefined || repositoryPath !== ''))
    parameters.set('repositoryPath', repositoryPath);
  if (target.worktreePath !== undefined) parameters.set('worktreePath', target.worktreePath);
  for (const name of history?.refs ?? []) parameters.append('refs', name);
  if (download) parameters.set('download', '1');
  const base = `/api/workspaces/${encodeURIComponent(target.workspaceId)}`;
  return `${base}${history === undefined ? '/files/content' : `/git/commits/${encodeURIComponent(history.commit)}/files/content`}?${parameters}`;
}

export function createWorkspaceFilePreviewService(input: {
  readonly http: ScopedHttpService;
  readonly transfers: () => WorkspaceFilePreviewTransfers;
  readonly onFailure: (error: unknown, target: WorkspaceFilePreviewTarget) => void;
  readonly onWritten: (target: WorkspaceFilePreviewTarget) => void | Promise<void>;
  readonly fetchContent?: typeof fetch;
}) {
  function createPage() {
    return {
      target: shallowRef<WorkspaceFilePreviewTarget>(),
      fileContent: shallowRef<WorkspaceFilePreviewContent>(),
      contentUrl: ref<string>(),
      loading: ref(false),
      downloading: ref(false),
      operation: 0
    };
  }
  const pages = new Map<number, ReturnType<typeof createPage>>();
  function internalPage(id: number) {
    let page = pages.get(id);
    if (page === undefined) {
      page = createPage();
      pages.set(id, page);
    }
    return page;
  }
  function page(id: number) {
    const state = internalPage(id);
    return {
      target: readonly(state.target),
      fileContent: readonly(state.fileContent),
      contentUrl: readonly(state.contentUrl),
      loading: readonly(state.loading),
      downloading: readonly(state.downloading)
    };
  }
  function releaseUrl(state: ReturnType<typeof createPage>) {
    if (state.contentUrl.value?.startsWith('blob:'))
      revokeWorkspaceDirectObjectUrl(state.contentUrl.value);
    state.contentUrl.value = undefined;
  }
  function close(id: number) {
    const state = pages.get(id);
    if (state === undefined) return;
    state.operation += 1;
    state.loading.value = false;
    state.downloading.value = false;
    releaseUrl(state);
    pages.delete(id);
  }
  function reset() {
    for (const id of pages.keys()) close(id);
  }

  async function open(
    id: number,
    target: WorkspaceFilePreviewTarget,
    options: {
      readonly size?: number;
      readonly textPreview?: boolean;
      readonly serverOnly?: boolean;
    } = {}
  ): Promise<WorkspaceFilePreviewContent | undefined> {
    const state = internalPage(id);
    const operation = ++state.operation;
    const current = () => pages.get(id) === state && state.operation === operation;
    const fixedTarget = {
      ...target,
      ...(target.history === undefined
        ? {}
        : { history: { ...target.history, refs: [...target.history.refs] } })
    };
    target = fixedTarget;
    const transfers = { ...input.transfers() };
    state.target.value = fixedTarget;
    state.downloading.value = false;
    releaseUrl(state);
    const textPreview = options.textPreview ?? shouldReadTextFilePreview(target.path);
    state.fileContent.value = {
      path: target.path,
      ...(options.size === undefined ? {} : { size: options.size }),
      encoding: textPreview ? 'utf-8' : 'base64',
      content: '',
      truncated: false
    };
    state.loading.value = true;
    try {
      if (fixedTarget.history !== undefined) {
        const history = fixedTarget.history;
        const fallback = workspaceFilePreviewUrl(fixedTarget);
        if (textPreview) {
          const direct = await transfers.directGitFileReadRange?.(
            history.commit,
            target.path,
            history.repositoryPath,
            history.refs,
            0,
            TEXT_FILE_PREVIEW_LIMIT_BYTES
          );
          if (!current()) return;
          let bytes: Uint8Array<ArrayBuffer>, size: number;
          if (direct !== undefined) {
            bytes = direct.bytes;
            size = direct.size;
          } else {
            const response = await (input.fetchContent ?? fetch)(fallback, {
              credentials: 'same-origin',
              headers: { range: `bytes=0-${TEXT_FILE_PREVIEW_LIMIT_BYTES - 1}` }
            });
            if (!response.ok) throw new Error(`REQUEST_FAILED_${response.status}`);
            bytes = new Uint8Array(await response.arrayBuffer());
            const total = response.headers.get('content-range')?.match(/\/(\d+)$/u)?.[1];
            size = total === undefined ? bytes.byteLength : Number(total);
          }
          if (!Number.isSafeInteger(size) || size < bytes.byteLength)
            throw new Error('NODE_RESPONSE_INVALID');
          const decoded = decodeFilePreviewContent(bytes, target.path, bytes.byteLength === size);
          if (current())
            state.fileContent.value = {
              path: target.path,
              size,
              ...decoded,
              truncated: decoded.encoding === 'utf-8' && bytes.byteLength < size
            };
          return current() ? state.fileContent.value : undefined;
        }
        if (binaryFilePreviewKind(target.path) === 'unsupported') return state.fileContent.value;
        const size = await historyFileSize(fixedTarget, transfers).catch(() => undefined);
        if (!current()) return;
        state.fileContent.value = {
          path: target.path,
          ...(size === undefined ? {} : { size }),
          encoding: 'base64',
          content: '',
          truncated: false
        };
        const direct = await readFilePreviewObject(target.path, async () =>
          transfers.directGitFileObjectUrl?.(
            history.commit,
            target.path,
            history.repositoryPath,
            history.refs
          )
        );
        if (!current()) {
          if (direct?.startsWith('blob:')) revokeWorkspaceDirectObjectUrl(direct);
          return;
        }
        state.contentUrl.value = direct ?? fallback;
        return state.fileContent.value;
      }
      if (usesRawFilePreview(target.path)) {
        const direct = options.serverOnly
          ? undefined
          : await readFilePreviewObject(target.path, async () =>
              transfers.directFileObjectUrl?.(
                target.path,
                target.worktreePath,
                target.repositoryPath
              )
            );
        if (!current()) {
          if (direct?.startsWith('blob:')) revokeWorkspaceDirectObjectUrl(direct);
          return;
        }
        state.contentUrl.value = direct ?? workspaceFilePreviewUrl(fixedTarget);
        return state.fileContent.value;
      }
      let directStarted = false;
      let identity: WorkspaceDirectFileIdentity | undefined;
      async function read(limit: number, allowDirect: boolean): Promise<FileRead> {
        const direct = allowDirect
          ? await transfers.directFileReadRange?.(
              target.path,
              0,
              limit,
              target.worktreePath,
              identity,
              target.repositoryPath
            )
          : undefined;
        if (direct !== undefined) {
          directStarted = true;
          identity = { revision: direct.revision, size: direct.size };
          const revision = await directFileContentRevision(direct);
          const decoded = decodeFilePreviewContent(
            direct.bytes,
            target.path,
            direct.nextOffset === null
          );
          return {
            ...decoded,
            size: direct.size,
            nextOffset: direct.nextOffset,
            ...(revision === undefined ? {} : { revision })
          };
        }
        if (allowDirect && directStarted) throw new Error('DIRECT_FILE_READ_FAILED');
        const parameters = new URLSearchParams({
          nodeId: target.nodeId,
          path: target.path,
          offset: '0',
          limit: String(limit)
        });
        if (target.repositoryPath !== undefined)
          parameters.set('repositoryPath', target.repositoryPath);
        if (target.worktreePath !== undefined) parameters.set('worktreePath', target.worktreePath);
        const result = await input.http.request(
          `/api/workspaces/${encodeURIComponent(target.workspaceId)}/files/read?${parameters}`
        );
        if (!isFileRead(result)) throw new Error('NODE_RESPONSE_INVALID');
        return decodeFilePreviewRead(result.file, target.path);
      }
      let result: FileRead;
      try {
        result = await readFilePreview((limit) => read(limit, !options.serverOnly), current);
      } catch (error) {
        if (!directStarted || options.serverOnly || !current()) throw error;
        identity = undefined;
        result = await readFilePreview((limit) => read(limit, false), current);
      }
      if (!current()) return;
      state.fileContent.value = {
        path: target.path,
        size: result.size,
        encoding: result.encoding,
        ...(result.previewEncoding === undefined
          ? {}
          : { previewEncoding: result.previewEncoding }),
        content: result.encoding === 'base64' ? '' : result.content,
        truncated: result.encoding !== 'base64' && result.nextOffset !== null,
        ...(result.revision === undefined ? {} : { revision: result.revision })
      };
      return state.fileContent.value;
    } catch (error) {
      if (!current()) return;
      if (errorCode(error) === 'FILE_TOO_LARGE')
        state.fileContent.value = {
          path: target.path,
          ...(options.size === undefined ? {} : { size: options.size }),
          encoding: 'base64',
          content: '',
          truncated: false
        };
      else input.onFailure(error, fixedTarget);
    } finally {
      if (current()) state.loading.value = false;
    }
  }

  async function historyFileSize(
    target: WorkspaceFilePreviewTarget,
    transfers: WorkspaceFilePreviewTransfers
  ): Promise<number> {
    const history = target.history!;
    const direct = await transfers.directGitFileReadRange?.(
      history.commit,
      target.path,
      history.repositoryPath,
      history.refs,
      0,
      1
    );
    if (direct !== undefined) return direct.size;
    const response = await (input.fetchContent ?? fetch)(workspaceFilePreviewUrl(target), {
      credentials: 'same-origin',
      headers: { range: 'bytes=0-0' }
    });
    if (!response.ok) throw new Error(`REQUEST_FAILED_${response.status}`);
    const total = response.headers.get('content-range')?.match(/\/(\d+)$/u)?.[1];
    const size = Number(total ?? response.headers.get('content-length'));
    if (!Number.isSafeInteger(size) || size < 0) throw new Error('NODE_RESPONSE_INVALID');
    return size;
  }

  async function save(id: number, content: string, expectedRevision: string): Promise<string> {
    const state = pages.get(id);
    const target = state?.target.value;
    const original = state?.fileContent.value;
    if (
      state === undefined ||
      state.loading.value ||
      target === undefined ||
      original === undefined ||
      original.encoding !== 'utf-8' ||
      original.previewEncoding !== undefined ||
      original.truncated ||
      original.revision === undefined ||
      target.history !== undefined ||
      target.repositoryPath !== undefined ||
      target.worktreePath !== undefined ||
      isComposerAttachmentResourcePath(target.path)
    )
      throw new Error('FILE_WRITE_INVALID');
    const operation = state.operation;
    const result = await input.http.request<{
      readonly file?: { readonly revision?: unknown; readonly size?: unknown };
    }>(`/api/workspaces/${encodeURIComponent(target.workspaceId)}/files/write`, {
      method: 'PUT',
      body: JSON.stringify({ nodeId: target.nodeId, path: target.path, content, expectedRevision })
    });
    const revision = result.file?.revision,
      size = result.file?.size;
    if (
      typeof revision !== 'string' ||
      typeof size !== 'number' ||
      !Number.isSafeInteger(size) ||
      size < 0
    )
      throw new Error('NODE_RESPONSE_INVALID');
    if (
      pages.get(id) === state &&
      state.operation === operation &&
      state.fileContent.value === original
    )
      state.fileContent.value = { ...original, content, revision, size };
    // Writing has succeeded. Refresh failures must never turn it into a retryable write failure.
    try {
      void Promise.resolve(input.onWritten(target)).catch(() => undefined);
    } catch {
      /* Refresh owns its diagnostics; the write has already succeeded. */
    }
    return revision;
  }

  async function checkReadable(target: WorkspaceFilePreviewTarget): Promise<void> {
    const parameters = new URLSearchParams({
      nodeId: target.nodeId,
      path: target.path,
      offset: '0',
      limit: '1'
    });
    const result = await input.http.request(
      `/api/workspaces/${encodeURIComponent(target.workspaceId)}/files/read?${parameters}`
    );
    if (!isFileRead(result)) throw new Error('NODE_RESPONSE_INVALID');
  }

  async function download(id: number): Promise<void> {
    const state = pages.get(id),
      target = state?.target.value;
    if (state === undefined || target === undefined) return;
    const transfers = input.transfers(),
      url = state.contentUrl.value,
      operation = state.operation;
    state.downloading.value = true;
    try {
      if (url?.startsWith('blob:')) {
        triggerBrowserFileDownload(url, target.path.split('/').at(-1) ?? 'download');
        return;
      }
      await downloadTarget(target, transfers);
    } finally {
      if (pages.get(id) === state && operation === state.operation) state.downloading.value = false;
    }
  }
  async function downloadTarget(
    target: WorkspaceFilePreviewTarget,
    transfers = input.transfers()
  ): Promise<void> {
    target = {
      ...target,
      ...(target.history === undefined
        ? {}
        : { history: { ...target.history, refs: [...target.history.refs] } })
    };
    transfers = { ...transfers };
    const history = target.history;
    const direct =
      history === undefined
        ? await transfers.directFileDownload?.(
            target.path,
            target.worktreePath,
            target.repositoryPath
          )
        : await transfers.directGitFileDownload?.(
            history.commit,
            target.path,
            history.repositoryPath,
            history.refs
          );
    if (direct !== undefined && direct !== 'UNAVAILABLE') return;
    triggerBrowserFileDownload(
      workspaceFilePreviewUrl(target, true),
      target.path.split('/').at(-1) ?? 'download'
    );
  }
  return { page, open, save, checkReadable, download, downloadTarget, close, reset };
}

function isFileRead(value: unknown): value is { readonly file: FileRead } {
  if (typeof value !== 'object' || value === null || !('file' in value)) return false;
  const file = value.file as Partial<FileRead> | null;
  return (
    typeof file === 'object' &&
    file !== null &&
    (file.encoding === 'utf-8' || file.encoding === 'base64') &&
    typeof file.size === 'number' &&
    Number.isSafeInteger(file.size) &&
    file.size >= 0 &&
    typeof file.content === 'string' &&
    (file.nextOffset === null || Number.isSafeInteger(file.nextOffset))
  );
}
