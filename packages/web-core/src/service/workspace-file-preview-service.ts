import type { WorkspaceDirectFileIdentity } from '../model/workspace-direct-file.js';
import { isComposerAttachmentResourcePath } from '@myagentroam/protocol';
import { readonly, ref, shallowRef } from 'vue';
import type { createWorkspaceFileAccessService } from './workspace-file-access-service.js';
import type {
  WorkspaceFilePreviewContent,
  WorkspaceFilePreviewTarget
} from '../model/workspace-file-preview.js';
import { directFileContentRevision } from './workspace-direct-file-read-service.js';
import { readFilePreview, usesNativeHttpFilePreview } from './file-preview-read-service.js';
import { revokeWorkspaceDirectObjectUrl } from './workspace-direct-object-url-service.js';
import {
  decodeFilePreviewContent,
  shouldReadTextFilePreview,
  usesRawFilePreview
} from '../util/file-preview.js';
import { apiErrorFromResponse, errorCode } from '../util/api-error.js';

type WorkspaceFileAccess = ReturnType<
  ReturnType<typeof createWorkspaceFileAccessService>['forWorkspace']
>;

interface FileRead {
  readonly encoding: 'utf-8' | 'base64';
  readonly previewEncoding?: string;
  readonly size: number;
  readonly content: string;
  readonly nextOffset: number | null;
  readonly revision?: string;
}

export function createWorkspaceFilePreviewService(input: {
  readonly access: (target: WorkspaceFilePreviewTarget) => WorkspaceFileAccess;
  readonly onWritten: (target: WorkspaceFilePreviewTarget) => void | Promise<void>;
}) {
  function createPage() {
    return {
      target: shallowRef<WorkspaceFilePreviewTarget>(),
      fileContent: shallowRef<WorkspaceFilePreviewContent>(),
      contentUrl: ref<string>(),
      loading: ref(false),
      error: shallowRef<unknown>(),
      downloading: ref(false),
      readController: undefined as AbortController | undefined,
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
      error: readonly(state.error),
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
    state.readController?.abort();
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
    } = {}
  ): Promise<WorkspaceFilePreviewContent | undefined> {
    const state = internalPage(id);
    state.readController?.abort();
    const readController = new AbortController();
    state.readController = readController;
    const operation = ++state.operation;
    const current = () => pages.get(id) === state && state.operation === operation;
    const fixedTarget = {
      ...target,
      ...(target.history === undefined
        ? {}
        : { history: { ...target.history, refs: [...target.history.refs] } })
    };
    target = fixedTarget;
    const transfers = { ...input.access(target) };
    state.target.value = fixedTarget;
    state.downloading.value = false;
    releaseUrl(state);
    const nativePreview = usesNativeHttpFilePreview(target.path);
    const textPreview =
      !nativePreview && (options.textPreview ?? shouldReadTextFilePreview(target.path));
    state.fileContent.value = {
      path: target.path,
      ...(options.size === undefined ? {} : { size: options.size }),
      encoding: textPreview ? 'utf-8' : 'base64',
      content: '',
      truncated: false
    };
    state.loading.value = true;
    state.error.value = undefined;
    try {
      // Native media retains HTTP caching and playback; file body reads have no HTTP fallback.
      if (nativePreview) {
        if (target.history !== undefined) {
          const size = await readHttpPreviewSize(
            fixedTarget,
            transfers,
            readController.signal
          ).catch(() => undefined);
          if (!current()) return;
          if (size !== undefined) state.fileContent.value = { ...state.fileContent.value, size };
        }
        state.contentUrl.value = transfers.contentUrl(fixedTarget);
        return state.fileContent.value;
      }
      if (usesRawFilePreview(target.path) && !(target.history !== undefined && textPreview)) {
        const { url, size } = await transfers.readPreviewObject(fixedTarget, readController.signal);
        if (!current()) {
          if (url !== undefined) revokeWorkspaceDirectObjectUrl(url);
          return;
        }
        state.contentUrl.value = url;
        state.fileContent.value = { ...state.fileContent.value, size };
        return state.fileContent.value;
      }
      if (target.history !== undefined && !textPreview) return state.fileContent.value;
      let identity: WorkspaceDirectFileIdentity | undefined;
      const result = await readFilePreview(async (limit) => {
        const range = await transfers.readPreviewRange(
          fixedTarget,
          limit,
          identity,
          readController.signal
        );
        readController.signal.throwIfAborted();
        identity = { revision: range.revision, size: range.size };
        const decoded = decodeFilePreviewContent(
          range.bytes,
          target.path,
          range.nextOffset === null
        );
        const revision =
          target.history === undefined && !isComposerAttachmentResourcePath(target.path)
            ? await directFileContentRevision(range)
            : undefined;
        return {
          ...decoded,
          size: range.size,
          nextOffset: range.nextOffset,
          ...(revision === undefined ? {} : { revision })
        };
      }, current);
      if (!current()) return;
      state.fileContent.value = previewContent(target.path, result);
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
      else state.error.value = error;
    } finally {
      if (current()) {
        state.loading.value = false;
        state.readController = undefined;
      }
    }
  }

  async function readHttpPreviewSize(
    target: WorkspaceFilePreviewTarget,
    transfers: Pick<WorkspaceFileAccess, 'fetchFile'>,
    signal: AbortSignal
  ): Promise<number | undefined> {
    signal.throwIfAborted();
    const response = await transfers.fetchFile(target, {
      method: 'HEAD',
      signal,
      headers: { range: 'bytes=0-0' }
    });
    if (!response.ok) return undefined;
    // A partial response's content-length is the range length, not the file size.
    const total =
      response.status === 206
        ? response.headers.get('content-range')?.match(/\/(\d+)$/u)?.[1]
        : response.headers.get('content-length');
    if (total === null || total === undefined) return undefined;
    const size = Number(total);
    return Number.isSafeInteger(size) && size >= 0 ? size : undefined;
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
    const result = await input.access(target).write(target.path, content, expectedRevision);
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
    const result = await input.access(target).read(target, 1);
    if (!isFileRead(result)) throw new Error('NODE_RESPONSE_INVALID');
  }

  async function download(id: number): Promise<void> {
    const state = pages.get(id),
      target = state?.target.value;
    if (state === undefined || target === undefined) return;
    const operation = state.operation;
    state.downloading.value = true;
    try {
      // A preview URL represents a displayed snapshot, not an explicit file download.
      await downloadTarget(target);
    } finally {
      if (pages.get(id) === state && operation === state.operation) state.downloading.value = false;
    }
  }
  async function downloadTarget(
    target: WorkspaceFilePreviewTarget,
    transfers = input.access(target)
  ): Promise<void> {
    target = {
      ...target,
      ...(target.history === undefined
        ? {}
        : { history: { ...target.history, refs: [...target.history.refs] } })
    };
    transfers = { ...transfers };
    const history = target.history;
    // Native preview URLs are not a fallback for explicit file downloads.
    if (history === undefined) {
      await transfers.directFileDownload(target.path, target.worktreePath, target.repositoryPath);
    } else {
      await transfers.directGitFileDownload(
        history.commit,
        target.path,
        history.repositoryPath,
        history.refs
      );
    }
  }
  return { page, open, save, checkReadable, download, downloadTarget, close, reset };
}

function previewContent(path: string, result: FileRead): WorkspaceFilePreviewContent {
  return {
    path,
    size: result.size,
    encoding: result.encoding,
    ...(result.previewEncoding === undefined ? {} : { previewEncoding: result.previewEncoding }),
    content: result.encoding === 'base64' ? '' : result.content,
    truncated: result.encoding !== 'base64' && result.nextOffset !== null,
    ...(result.revision === undefined ? {} : { revision: result.revision })
  };
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
