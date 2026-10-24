<script setup lang="ts">
import { marIcon } from '../../util/mar-icons.js';

import githubMarkdownLightThemeUrl from 'github-markdown-css/github-markdown-light.css?url';
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { ElMessageBox } from '../../service/MessageBoxService.js';
import { createScopedHttpService } from '../../service/ScopedHttpService.js';
import type { createSessionShareAccessService } from '../../service/SessionShareAccessService.js';
import { createSessionShareClientService } from '../../service/SessionShareClientService.js';
import { createFilePreviewWindowInteractionService } from '../../service/FilePreviewWindowInteractionService.js';
import WorkspaceTextFilePage from './WorkspaceTextFilePage.vue';
import WorkspaceFormatFilePage from './WorkspaceFormatFilePage.vue';
import WorkspaceFileTabs from './WorkspaceFileTabs.vue';
import FilePreviewLoading from './FilePreviewLoading.vue';
import MarkdownFilePreview from './MarkdownFilePreview.vue';
import { markdownPreviewPreferenceService } from '../../service/MarkdownPreviewPreferenceService.js';
import { translate } from '../../service/LocalePreferenceService.js';
import { createStandaloneWorkspaceDirectTransferService } from '../../service/StandaloneWorkspaceDirectTransferService.js';
import { createStandaloneFileWindowService } from '../../service/StandaloneFileWindowService.js';
import { directFileContentRevision } from '../../service/WorkspaceDirectFileReadService.js';
import { readFilePreview, readFilePreviewObject } from '../../service/FilePreviewReadService.js';
import {
  revokeWorkspaceDirectObjectUrl,
  triggerBrowserFileDownload
} from '../../service/WorkspaceDirectObjectUrlService.js';
import {
  decodeFilePreviewText,
  filePreviewKind,
  shouldReadTextFilePreview,
  type FilePreviewKind,
  usesRawFilePreview
} from '../../util/file-preview.js';
import { isHtmlFile, isMarkdownFile } from '../../util/file-preview.js';
import { fileSizeLabel } from '../../util/file-presentation.js';
import {
  workspaceFileTabIdentity,
  workspaceFileTabName,
  type WorkspaceFileTab
} from '../../util/workspace-file-tab.js';
import type { DirtyTextDraft } from './WorkspaceTextFilePage.vue';

interface FileRead {
  readonly path: string;
  readonly size?: number;
  readonly encoding: 'utf-8' | 'base64';
  readonly content: string;
  readonly truncated: boolean;
  readonly nextOffset: number | null;
  readonly revision?: string;
}

const props = defineProps<{
  share?: {
    access: ReturnType<typeof createSessionShareAccessService>;
    intent: URLSearchParams;
    embedded: boolean;
  };
}>();
const emit = defineEmits<{ close: [] }>();
const query = new URLSearchParams(props.share?.intent ?? location.search);
const shareAccess = props.share?.access;
if (shareAccess !== undefined) {
  const target = shareAccess.session.value!.share;
  query.set('nodeId', target.nodeId);
  query.set('workspaceId', target.workspaceId);
  query.delete('write');
  query.delete('source');
  query.delete('worktreePath');
  query.delete('repositoryPath');
}
const fileTarget = {
  ...(query.has('repositoryPath') ? { repositoryPath: query.get('repositoryPath')! } : {}),
  ...(query.has('worktreePath') ? { worktreePath: query.get('worktreePath')! } : {})
};
const shareClient =
  shareAccess === undefined
    ? undefined
    : createSessionShareClientService(shareAccess, shareAccess.session.value!.share);
const standaloneWindows = createStandaloneFileWindowService(
  undefined,
  shareAccess === undefined ? 'workbench' : `share:${shareAccess.session.value!.share.id}`
);
const markdownPreviewMode = !query.has('repositoryPath') && query.get('markdownPreview') === '1';
const htmlPreviewMode = !query.has('repositoryPath') && query.get('htmlPreview') === '1';
const renderedPreviewMode = markdownPreviewMode || htmlPreviewMode;
const hostedMode = query.get('source') === 'hosted';
const storageScope =
  shareAccess === undefined ? '' : `:share:${shareAccess.session.value!.share.id}`;
const STANDALONE_TABS_KEY = 'mar.standalone-file-tabs.v1' + storageScope;
const STANDALONE_DRAFTS_KEY = 'mar.standalone-file-drafts.v1' + storageScope;
interface StandaloneFileTab extends WorkspaceFileTab {
  readonly url: string;
}
const standaloneTabs = ref<readonly StandaloneFileTab[]>([]);
const activeStandaloneTabId = ref<number>();
const standaloneFileTabs = ref<{ captureDirtyDrafts(): readonly unknown[] }>();
const dirtyDrafts = ref<readonly DirtyTextDraft[]>(restoreDirtyDrafts());
const file = ref<FileRead>();
const standaloneRoot = ref<HTMLElement>();
const errorKey = ref('');
const error = computed(() => (errorKey.value === '' ? '' : translate(errorKey.value)));
const contentUrl = ref<string>();
const htmlUrl = ref<string>();
const htmlTrusted = ref(false);
const objectUrl = ref<string>();
const loading = ref(true);
const htmlFrameLoaded = ref(false);
const downloading = ref(false);
const csrfToken = ref(
  shareAccess === undefined ? (sessionStorage.getItem('mar.user.csrf-token') ?? '') : ''
);
const writeEnabled =
  shareAccess === undefined && query.get('write') === '1' && Object.keys(fileTarget).length === 0;
const http =
  shareClient ??
  createScopedHttpService({
    csrfToken: () => csrfToken.value,
    renewCsrfToken: renewCsrfToken
  });
const preference = markdownPreviewPreferenceService().preference;
const watermarkStyle = computed(() => ({
  backgroundImage: `url("data:image/svg+xml,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="360" height="240"><defs><pattern id="watermark" width="360" height="240" patternUnits="userSpaceOnUse" patternTransform="rotate(-30)"><text x="0" y="120" fill="#000" fill-opacity=".12" font-family="serif" font-size="22">${escapeXml(preference.value.watermarkText)}</text></pattern></defs><rect width="100%" height="100%" fill="url(#watermark)"/></svg>`
  )}")`
}));
const line = Number(query.get('line')) || undefined;
const column = Number(query.get('column')) || undefined;
const kind = computed<FilePreviewKind>(() => {
  if (file.value === undefined) return 'unsupported';
  return filePreviewKind(file.value.path, file.value.encoding);
});
let directTransfer: ReturnType<typeof createStandaloneWorkspaceDirectTransferService> | undefined;
let directIdentity: { readonly revision: string; readonly size: number } | undefined;
let directReadStarted = false;
let directTextDecoder = new TextDecoder('utf-8', { fatal: true });

function restoreStandaloneTabs(): void {
  if (renderedPreviewMode) return;
  const nodeId = query.get('nodeId');
  const workspaceId = query.get('workspaceId');
  const path = query.get('path');
  if (nodeId === null || workspaceId === null || path === null) return;
  let restored: StandaloneFileTab[] = [];
  try {
    const value = props.share?.embedded
      ? []
      : (JSON.parse(sessionStorage.getItem(STANDALONE_TABS_KEY) ?? '[]') as unknown);
    if (Array.isArray(value)) restored = value.filter(isStandaloneFileTab);
  } catch {
    restored = [];
  }
  const kind = shouldReadTextFilePreview(path, query.get('mimeType') ?? '')
    ? 'WORKTREE_TEXT'
    : 'WORKTREE_PREVIEW';
  const intent = {
    kind,
    nodeId,
    workspaceId,
    path,
    repositoryPath: query.get('repositoryPath') ?? '',
    worktreePath: query.get('worktreePath') ?? '',
    ...(query.has('repositoryPath') ? { gitFile: true } : {}),
    ...(Number(query.get('line')) > 0 ? { targetLine: Number(query.get('line')) } : {}),
    ...(Number(query.get('column')) > 0 ? { targetColumn: Number(query.get('column')) } : {})
  } as const;
  const identity = workspaceFileTabIdentity(intent);
  const existing = restored.find((tab) => tab.identity === identity);
  const current: StandaloneFileTab =
    existing === undefined
      ? {
          ...intent,
          id: Math.max(0, ...restored.map((tab) => tab.id)) + 1,
          identity,
          fileName: workspaceFileTabName(path),
          url: location.href
        }
      : { ...existing, ...intent, url: location.href };
  standaloneTabs.value = [...restored.filter((tab) => tab.identity !== identity), current].slice(
    -20
  );
  activeStandaloneTabId.value = current.id;
  persistStandaloneTabs();
}

function restoreDirtyDrafts(): readonly DirtyTextDraft[] {
  try {
    const value = JSON.parse(sessionStorage.getItem(STANDALONE_DRAFTS_KEY) ?? '[]') as unknown;
    return Array.isArray(value) ? value.filter(isDirtyTextDraft) : [];
  } catch {
    return [];
  }
}

function isStandaloneFileTab(value: unknown): value is StandaloneFileTab {
  if (typeof value !== 'object' || value === null) return false;
  const tab = value as Partial<StandaloneFileTab>;
  if (
    !Number.isSafeInteger(tab.id) ||
    (tab.kind !== 'WORKTREE_TEXT' && tab.kind !== 'WORKTREE_PREVIEW') ||
    typeof tab.identity !== 'string' ||
    typeof tab.nodeId !== 'string' ||
    typeof tab.workspaceId !== 'string' ||
    typeof tab.path !== 'string' ||
    typeof tab.fileName !== 'string' ||
    typeof tab.url !== 'string'
  )
    return false;
  try {
    const url = new URL(tab.url, location.href);
    return (
      url.origin === location.origin &&
      url.pathname === location.pathname &&
      url.searchParams.get('standaloneFile') === '1' &&
      url.searchParams.get('markdownPreview') !== '1'
    );
  } catch {
    return false;
  }
}

function isDirtyTextDraft(value: unknown): value is DirtyTextDraft {
  if (typeof value !== 'object' || value === null) return false;
  const draft = value as Partial<DirtyTextDraft>;
  return (
    typeof draft.tabIdentity === 'string' &&
    typeof draft.path === 'string' &&
    typeof draft.content === 'string' &&
    typeof draft.expectedRevision === 'string'
  );
}

function persistStandaloneTabs(): void {
  if (!renderedPreviewMode && !props.share?.embedded)
    sessionStorage.setItem(STANDALONE_TABS_KEY, JSON.stringify(standaloneTabs.value));
}

function activateStandaloneTab(id: number): void {
  const tab = standaloneTabs.value.find((candidate) => candidate.id === id);
  if (tab === undefined || id === activeStandaloneTabId.value) return;
  captureDirtyDrafts();
  location.replace(tab.url);
}

function closeStandaloneTab(id: number): void {
  const index = standaloneTabs.value.findIndex((tab) => tab.id === id);
  if (index < 0) return;
  const remaining = standaloneTabs.value.filter((tab) => tab.id !== id);
  const closedTab = standaloneTabs.value[index]!;
  standaloneTabs.value = remaining;
  consumeDirtyDraft(closedTab.identity);
  persistStandaloneTabs();
  if (remaining.length === 0) {
    close();
    return;
  }
  if (id !== activeStandaloneTabId.value) return;
  const target = remaining[Math.min(index, remaining.length - 1)];
  if (target !== undefined) location.replace(target.url);
}

function captureDirtyDrafts(): void {
  const captured = standaloneFileTabs.value?.captureDirtyDrafts().filter(isDirtyTextDraft) ?? [];
  if (captured.length === 0) return;
  const identities = new Set(captured.map((draft) => draft.tabIdentity));
  dirtyDrafts.value = [
    ...dirtyDrafts.value.filter((draft) => !identities.has(draft.tabIdentity)),
    ...captured
  ];
  sessionStorage.setItem(STANDALONE_DRAFTS_KEY, JSON.stringify(dirtyDrafts.value));
}

async function canCloseUnmountedTab(id: number): Promise<boolean> {
  const tab = standaloneTabs.value.find((candidate) => candidate.id === id);
  if (tab === undefined || !dirtyDrafts.value.some((draft) => draft.tabIdentity === tab.identity))
    return true;
  try {
    await ElMessageBox.confirm(
      translate('fileEditor.unsavedMessage'),
      translate('fileEditor.unsavedTitle'),
      { closeIcon: marIcon('close'), icon: marIcon('warning'), type: 'warning' }
    );
    return true;
  } catch {
    return false;
  }
}

function closeStandaloneTabs(): void {
  standaloneTabs.value = [];
  dirtyDrafts.value = [];
  persistStandaloneTabs();
  sessionStorage.removeItem(STANDALONE_DRAFTS_KEY);
  close();
}

function consumeDirtyDraft(tabIdentity: string): void {
  dirtyDrafts.value = dirtyDrafts.value.filter((draft) => draft.tabIdentity !== tabIdentity);
  sessionStorage.setItem(STANDALONE_DRAFTS_KEY, JSON.stringify(dirtyDrafts.value));
}

restoreStandaloneTabs();

onMounted(async () => {
  if (renderedPreviewMode) windowInteraction.mount();
  else window.addEventListener('mar-before-standalone-navigation', captureDirtyDrafts);
  window.addEventListener('online', handleNetworkChange);
  window.addEventListener('offline', handleNetworkChange);
  const nodeId = query.get('nodeId');
  const workspaceId = query.get('workspaceId');
  const path = query.get('path');
  if (nodeId === null || workspaceId === null || path === null) {
    errorKey.value = 'generated.standaloneFilePreviewPage.theFilePreviewURLIsInvalid';
    return;
  }
  if (!hostedMode && shareAccess === undefined)
    directTransfer = createStandaloneWorkspaceDirectTransferService({
      nodeId,
      workspaceId,
      ...fileTarget
    });
  document.title = `${path.split('/').at(-1) ?? path} · MyAgentRoam`;
  if (htmlPreviewMode) {
    loading.value = true;
    htmlFrameLoaded.value = false;
    if (!hostedMode && isHtmlFile(path) && Object.keys(fileTarget).length === 0) {
      try {
        const result = await http.request<{ readonly url: string }>('/api/html-preview/grants', {
          method: 'POST',
          body: JSON.stringify({ nodeId, workspaceId, path })
        });
        htmlUrl.value = result.url;
        htmlTrusted.value = new URL(result.url).hostname === location.hostname;
      } catch {
        errorKey.value = 'htmlPreview.unavailable';
      }
    } else {
      errorKey.value = 'htmlPreview.unavailable';
    }
    loading.value = false;
    return;
  }
  await loadFile();
});

async function loadFile(serverOnly = false): Promise<void> {
  const nodeId = query.get('nodeId');
  const workspaceId = query.get('workspaceId');
  const path = query.get('path');
  if (nodeId === null || workspaceId === null || path === null) return;
  loading.value = true;
  errorKey.value = '';
  directIdentity = undefined;
  directReadStarted = false;
  if (objectUrl.value !== undefined) revokeWorkspaceDirectObjectUrl(objectUrl.value);
  objectUrl.value = undefined;
  const textPreview = shouldReadTextFilePreview(path);
  file.value = {
    path,
    encoding: textPreview ? 'utf-8' : 'base64',
    content: '',
    truncated: false,
    nextOffset: null
  };
  contentUrl.value = undefined;
  if (hostedMode) {
    await loadHostedFile(nodeId, path);
    return;
  }
  try {
    directTextDecoder = new TextDecoder('utf-8', { fatal: true });
    if (usesRawFilePreview(path) && query.get('rawContent') === '1') {
      const directObject = serverOnly
        ? undefined
        : await readFilePreviewObject(path, async () => directTransfer?.objectUrl(path));
      if (directObject !== undefined) {
        objectUrl.value = directObject.url;
        file.value = {
          path,
          size: directObject.size,
          encoding: 'base64',
          content: '',
          truncated: false,
          nextOffset: null,
          revision: directObject.revision
        };
        contentUrl.value = directObject.url;
        return;
      }
      const metadata = await readRange(nodeId, workspaceId, path, 0, false, 1);
      file.value = {
        path,
        ...(metadata.size === undefined ? {} : { size: metadata.size }),
        encoding: 'base64',
        content: '',
        truncated: false,
        nextOffset: null
      };
      contentUrl.value = rawContentUrl(nodeId, workspaceId, path);
      return;
    }
    const first = await readFilePreview((limit) =>
      readRange(nodeId, workspaceId, path, 0, !serverOnly, limit)
    );
    if (first.encoding === 'base64') {
      if (objectUrl.value !== undefined) revokeWorkspaceDirectObjectUrl(objectUrl.value);
      file.value = { ...first, content: '', truncated: false, nextOffset: null };
      if (filePreviewKind(path, 'base64') === 'unsupported') return;
      const directObject = serverOnly
        ? undefined
        : await readFilePreviewObject(path, async () => directTransfer?.objectUrl(path));
      objectUrl.value = directObject?.url;
      if (directObject !== undefined) {
        contentUrl.value = objectUrl.value;
        return;
      }
      contentUrl.value = rawContentUrl(nodeId, workspaceId, path);
    } else {
      file.value = {
        ...first,
        truncated: first.nextOffset !== null,
        nextOffset: first.nextOffset
      };
    }
  } catch {
    if (!serverOnly && directReadStarted) {
      await loadFile(true);
      return;
    }
    errorKey.value = 'generated.standaloneFilePreviewPage.unableToReadTheFileCheckYour';
  } finally {
    loading.value = false;
  }
}

async function loadHostedFile(nodeId: string, path: string): Promise<void> {
  const conversationId = query.get('conversationId');
  const fileId = query.get('fileId');
  const mimeType = query.get('mimeType') ?? '';
  let size = Number(query.get('size'));
  if (
    conversationId === null ||
    query.get('workspaceId') !== conversationId ||
    fileId === null ||
    !Number.isSafeInteger(size) ||
    size < 0
  ) {
    errorKey.value = 'generated.standaloneFilePreviewPage.theFilePreviewURLIsInvalid';
    loading.value = false;
    return;
  }
  const url = `/api/nodes/${encodeURIComponent(nodeId)}/hosted-conversations/${encodeURIComponent(conversationId)}/files/${encodeURIComponent(fileId)}/content`;
  const textPreview = shouldReadTextFilePreview(path, mimeType);
  file.value = {
    path,
    size,
    encoding: textPreview ? 'utf-8' : 'base64',
    content: '',
    truncated: false,
    nextOffset: null
  };
  if (!textPreview) {
    contentUrl.value = url;
    loading.value = false;
    return;
  }
  try {
    if (size === 0) {
      const metadata = await fetch(url, { credentials: 'same-origin', method: 'HEAD' });
      if (!metadata.ok) throw new Error(`REQUEST_FAILED_${metadata.status}`);
      const length = metadata.headers.get('content-length');
      if (length === null || !Number.isSafeInteger(Number(length)) || Number(length) < 0)
        throw new Error('NODE_RESPONSE_INVALID');
      size = Number(length);
      if (size === 0) {
        file.value = {
          path,
          size,
          encoding: 'utf-8',
          content: '',
          truncated: false,
          nextOffset: null
        };
        return;
      }
    }
    file.value = await readFilePreview(async (limit): Promise<FileRead> => {
      const response = await fetch(url, {
        credentials: 'same-origin',
        headers: { Range: `bytes=0-${limit - 1}` }
      });
      if (!response.ok) throw new Error(`REQUEST_FAILED_${response.status}`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      const total = response.headers.get('content-range')?.match(/\/(\d+)$/u)?.[1];
      const readSize = total === undefined ? size : Number(total);
      if (!Number.isSafeInteger(readSize) || readSize < 0) throw new Error('NODE_RESPONSE_INVALID');
      const decoded = decodeFilePreviewText(bytes, bytes.byteLength >= readSize);
      return {
        path,
        size: readSize,
        encoding: decoded === undefined ? 'base64' : 'utf-8',
        content: decoded ?? '',
        truncated: decoded !== undefined && bytes.byteLength < readSize,
        nextOffset: decoded !== undefined && bytes.byteLength < readSize ? bytes.byteLength : null
      };
    });
    if (file.value.encoding === 'base64') contentUrl.value = url;
  } catch {
    errorKey.value = 'generated.standaloneFilePreviewPage.unableToReadTheFileCheckYour';
  } finally {
    loading.value = false;
  }
}

async function renewCsrfToken(): Promise<string> {
  const response = await fetch('/api/auth/csrf', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: '{}'
  });
  if (!response.ok) throw new Error('CSRF_INVALID');
  const result = (await response.json()) as { readonly csrfToken?: unknown };
  if (typeof result.csrfToken !== 'string') throw new Error('CSRF_TOKEN_INVALID');
  csrfToken.value = result.csrfToken;
  sessionStorage.setItem('mar.user.csrf-token', result.csrfToken);
  return result.csrfToken;
}

async function saveFile(content: string, expectedRevision: string): Promise<string> {
  const nodeId = query.get('nodeId');
  const workspaceId = query.get('workspaceId');
  const path = query.get('path');
  if (nodeId === null || workspaceId === null || path === null)
    throw new Error('FILE_WRITE_INVALID');
  const result = await http.request<{
    readonly file?: { readonly revision?: unknown; readonly size?: unknown };
  }>(`/api/workspaces/${encodeURIComponent(workspaceId)}/files/write`, {
    method: 'PUT',
    body: JSON.stringify({ nodeId, path, content, expectedRevision })
  });
  if (
    typeof result.file?.revision !== 'string' ||
    typeof result.file.size !== 'number' ||
    !Number.isSafeInteger(result.file.size) ||
    result.file.size < 0
  )
    throw new Error('NODE_RESPONSE_INVALID');
  if (file.value !== undefined)
    file.value = { ...file.value, content, revision: result.file.revision, size: result.file.size };
  return result.file.revision;
}

onBeforeUnmount(() => {
  if (renderedPreviewMode) windowInteraction.dispose();
  else window.removeEventListener('mar-before-standalone-navigation', captureDirtyDrafts);
  window.removeEventListener('online', handleNetworkChange);
  window.removeEventListener('offline', handleNetworkChange);
  directTransfer?.close();
  if (objectUrl.value !== undefined) revokeWorkspaceDirectObjectUrl(objectUrl.value);
});

async function download(): Promise<void> {
  if (file.value === undefined) return;
  downloading.value = true;
  try {
    const nodeId = query.get('nodeId');
    const workspaceId = query.get('workspaceId');
    const path = query.get('path');
    if (nodeId === null || workspaceId === null || path === null) return;
    if (hostedMode) {
      const conversationId = query.get('conversationId');
      const fileId = query.get('fileId');
      if (conversationId === null || fileId === null) return;
      const anchor = document.createElement('a');
      anchor.href = `/api/nodes/${encodeURIComponent(nodeId)}/hosted-conversations/${encodeURIComponent(conversationId)}/files/${encodeURIComponent(fileId)}/content?download=1`;
      anchor.download = path.split('/').at(-1) ?? 'download';
      anchor.click();
      return;
    }
    if (objectUrl.value?.startsWith('blob:')) {
      triggerBrowserFileDownload(objectUrl.value, path.split('/').at(-1) ?? 'download');
      return;
    }
    const result = await directTransfer?.download(path);
    if (result !== undefined && result !== 'UNAVAILABLE') return;
    const anchor = document.createElement('a');
    anchor.href = rawContentUrl(nodeId, workspaceId, path, true);
    anchor.download = file.value.path.split('/').at(-1) ?? 'download';
    anchor.click();
  } finally {
    downloading.value = false;
  }
}

function handleNetworkChange(): void {
  directTransfer?.networkChanged();
}

async function readRange(
  nodeId: string,
  workspaceId: string,
  path: string,
  offset: number,
  allowDirect = true,
  limit = 512 * 1024
): Promise<FileRead> {
  const direct = allowDirect
    ? await directTransfer?.readRange(path, offset, limit, directIdentity)
    : undefined;
  if (direct !== undefined) {
    directReadStarted = true;
    directIdentity = {
      revision: direct.revision,
      size: direct.size
    };
    const revision = await directFileContentRevision(direct);
    if (offset === 0) directTextDecoder = new TextDecoder('utf-8', { fatal: true });
    const content = decodeFilePreviewText(
      direct.bytes,
      direct.nextOffset === null,
      directTextDecoder
    );
    if (content !== undefined) {
      return {
        path,
        size: direct.size,
        encoding: 'utf-8',
        content,
        truncated: direct.nextOffset !== null,
        nextOffset: direct.nextOffset,
        ...(revision === undefined ? {} : { revision })
      };
    }
    directIdentity = undefined;
    directTextDecoder = new TextDecoder('utf-8', { fatal: true });
    return {
      path,
      size: direct.size,
      encoding: 'base64',
      content: '',
      truncated: direct.nextOffset !== null,
      nextOffset: direct.nextOffset,
      ...(revision === undefined ? {} : { revision })
    };
  }
  if (allowDirect && directReadStarted) throw new Error('DIRECT_FILE_READ_FAILED');
  const parameters = new URLSearchParams({
    nodeId,
    path,
    offset: String(offset),
    limit: String(limit),
    ...fileTarget
  });
  let body: { readonly file?: FileRead };
  if (shareClient !== undefined)
    body = await shareClient.request(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/files/read?${parameters.toString()}`
    );
  else {
    const response = await fetch(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/files/read?${parameters.toString()}`,
      { credentials: 'same-origin' }
    );
    if (!response.ok) throw new Error(`REQUEST_FAILED_${response.status}`);
    body = (await response.json()) as { readonly file?: FileRead };
  }
  if (
    body.file === undefined ||
    (body.file.encoding !== 'utf-8' && body.file.encoding !== 'base64') ||
    (body.file.nextOffset !== null && !Number.isSafeInteger(body.file.nextOffset))
  )
    throw new Error('NODE_RESPONSE_INVALID');
  return body.file;
}

function escapeXml(value: string): string {
  return value.replace(/[&<>]/g, (character) =>
    character === '&' ? '&amp;' : character === '<' ? '&lt;' : '&gt;'
  );
}

function close(): void {
  if (props.share?.embedded) {
    emit('close');
    return;
  }
  window.close();
}

function closeRenderedPreview(): boolean {
  close();
  // Release the Back guard even if the browser refuses to close a manual tab.
  return true;
}
const windowInteraction = createFilePreviewWindowInteractionService({
  isOpen: () => renderedPreviewMode,
  closeWindow: closeRenderedPreview,
  closeTab: closeRenderedPreview
});

function bindHtmlFrame(event: Event): void {
  htmlFrameLoaded.value = true;
  if (event.target instanceof HTMLIFrameElement) windowInteraction.bindFrame(event.target);
}

function workspaceResourceUrl(path: string): string {
  const nodeId = query.get('nodeId');
  const workspaceId = query.get('workspaceId');
  return nodeId === null || workspaceId === null ? '' : rawContentUrl(nodeId, workspaceId, path);
}

function openMarkdown(path: string): void {
  const nodeId = query.get('nodeId');
  const workspaceId = query.get('workspaceId');
  if (nodeId === null || workspaceId === null) return;
  const parameters = new URLSearchParams({
    standaloneFile: '1',
    ...(isMarkdownFile(path) ? { markdownPreview: '1' } : { rawContent: '1' }),
    nodeId,
    workspaceId,
    path
  });
  const url = `${shareAccess === undefined ? '/console' : '/share/' + encodeURIComponent(shareAccess.session.value!.share.id)}?${parameters.toString()}`;
  if (shareAccess !== undefined) standaloneWindows.open(url);
  else location.assign(url);
}

function openHtml(path: string): void {
  const nodeId = query.get('nodeId');
  const workspaceId = query.get('workspaceId');
  if (nodeId === null || workspaceId === null) return;
  const parameters = new URLSearchParams({
    standaloneFile: '1',
    htmlPreview: '1',
    nodeId,
    workspaceId,
    path
  });
  if (
    standaloneWindows.open(
      `${shareAccess === undefined ? '/console' : '/share/' + encodeURIComponent(shareAccess.session.value!.share.id)}?${parameters.toString()}`
    ) === undefined
  )
    errorKey.value = 'htmlPreview.unavailable';
}

function rawContentUrl(
  nodeId: string,
  workspaceId: string,
  path: string,
  download = false
): string {
  const parameters = new URLSearchParams({
    nodeId,
    path,
    ...(download ? { download: '1' } : {}),
    ...fileTarget
  });
  const url = `/api/workspaces/${encodeURIComponent(workspaceId)}/files/content?${parameters.toString()}`;
  return shareClient?.resourceUrl(url) ?? url;
}
</script>

<template>
  <Teleport v-if="markdownPreviewMode" to="head">
    <link rel="stylesheet" :href="githubMarkdownLightThemeUrl" />
  </Teleport>
  <main v-if="renderedPreviewMode" ref="standaloneRoot" class="standalone-file-preview">
    <p v-if="error" class="standalone-error">{{ error }}</p>
    <template v-else-if="htmlPreviewMode">
      <header class="standalone-markdown-header html-preview-header">
        <code v-tooltip="query.get('path') ?? ''">{{ query.get('path') }}</code>
        <small v-if="htmlUrl">{{
          translate(htmlTrusted ? 'htmlPreview.trustedWarning' : 'htmlPreview.isolatedWarning')
        }}</small>
      </header>
      <div class="standalone-preview-body">
        <FilePreviewLoading
          v-if="loading || (htmlUrl && !htmlFrameLoaded)"
          variant="page"
          overlay
        />
        <iframe
          v-if="htmlUrl"
          class="html-preview-frame"
          :src="htmlUrl"
          :title="query.get('path') ?? ''"
          sandbox="allow-scripts allow-same-origin"
          referrerpolicy="no-referrer"
          @load="bindHtmlFrame"
        />
      </div>
    </template>
    <template v-else-if="markdownPreviewMode">
      <header class="standalone-markdown-header">
        <code v-tooltip="query.get('path') ?? file?.path ?? ''">{{
          query.get('path') ?? file?.path
        }}</code
        ><small v-if="file?.size !== undefined">{{ fileSizeLabel(file.size ?? 0) }}</small>
      </header>
      <div class="standalone-preview-body">
        <FilePreviewLoading v-if="loading" variant="page" overlay />
        <main v-else-if="file && isMarkdownFile(file.path)" class="markdown-preview-page">
          <MarkdownFilePreview
            :content="file.content"
            :path="file.path"
            :resource-url="workspaceResourceUrl"
            standard-style
            @open-file="openMarkdown"
          />
          <div
            v-if="preference.watermarkEnabled && preference.watermarkText"
            class="markdown-watermark"
            :style="watermarkStyle"
            aria-hidden="true"
          />
        </main>
      </div>
    </template>
  </main>
  <WorkspaceFileTabs
    v-else
    ref="standaloneFileTabs"
    :tabs="standaloneTabs"
    :active-tab-id="activeStandaloneTabId"
    :can-close-unmounted-tab="canCloseUnmountedTab"
    @activate="activateStandaloneTab"
    @close="closeStandaloneTab"
    @close-all="closeStandaloneTabs"
    v-slot="{ tab, active, registerPageHandle, requestClose }"
  >
    <p v-if="active && error" class="standalone-error">{{ error }}</p>
    <WorkspaceTextFilePage
      v-else-if="active && file && kind === 'text'"
      :ref="registerPageHandle"
      :active="active"
      :file="file"
      :kind="kind"
      :loading="loading"
      :downloading="downloading"
      :target-line="line"
      :target-column="column"
      :write-enabled="writeEnabled"
      :html="isHtmlFile(file.path) && Object.keys(fileTarget).length === 0"
      :markdown="!query.has('repositoryPath') && isMarkdownFile(file.path)"
      :markdown-resource-url="workspaceResourceUrl"
      :save-file="saveFile"
      :tab-identity="tab.identity"
      :initial-dirty-draft="
        dirtyDrafts.find((draft) => draft.tabIdentity === tab.identity && draft.path === tab.path)
      "
      @close="requestClose"
      @download="download"
      @open-html-preview="openHtml(file.path)"
      @open-markdown-preview="openMarkdown(file.path)"
      @dirty-draft-applied="consumeDirtyDraft"
    />
    <WorkspaceFormatFilePage
      v-else-if="active && file"
      :ref="registerPageHandle"
      :active="active"
      :file="file"
      :content-url="contentUrl"
      :kind="kind"
      :loading="loading"
      :downloading="downloading"
      @close="requestClose"
      @download="download"
    />
  </WorkspaceFileTabs>
</template>

<style scoped>
.standalone-file-preview {
  /* Rendered previews keep their light appearance independently of the console. */
  --mar-color-brand-text: #0969da;
  --mar-color-danger-text: #cf222e;
  --mar-scrollbar-thumb: #afb8c1;
  display: flex;
  height: 100dvh;
  min-height: 0;
  flex-direction: column;
  align-items: center;
  justify-content: flex-start;
  overflow: auto;
  padding: 0;
  background: #fff;
  color: #1f2328;
  color-scheme: light;
}

.standalone-error {
  margin: 0;
  padding: 24px;
  color: var(--mar-color-danger-text);
  font-size: var(--mar-font-size-body);
}

.standalone-preview-body {
  position: relative;
  isolation: isolate;
  display: flex;
  min-width: 0;
  min-height: 0;
  flex: 1;
  flex-direction: column;
  align-self: stretch;
}

.standalone-preview-body :deep(.file-preview-loading.is-overlay) {
  background: #fff;
}

.standalone-markdown-header {
  display: flex;
  width: min(210mm, 100%);
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  padding: 0.6rem 1rem;
  border-bottom: 1px solid #d0d7de;
  background: #f6f8fa;
  color: #57606a;
  font-size: var(--mar-font-size-meta);
}
.standalone-markdown-header code {
  min-width: 0;
  overflow: hidden;
  color: inherit;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.standalone-markdown-header small {
  flex: none;
  font-variant-numeric: tabular-nums;
}
.html-preview-header {
  width: 100%;
  box-sizing: border-box;
}
.html-preview-header small {
  flex: 1;
  text-align: right;
  white-space: normal;
}
.html-preview-frame {
  width: 100%;
  flex: 1;
  min-height: 0;
  border: 0;
  background: white;
}
.markdown-preview-page {
  position: relative;
  isolation: isolate;
  box-sizing: border-box;
  width: min(210mm, 100%);
  min-height: 297mm;
  margin: 0 auto;
  padding: 6mm 18mm 18mm;
  background: #fff;
}
.markdown-watermark {
  position: absolute;
  z-index: 0;
  inset: 0;
  background-repeat: repeat;
  background-position: 0 0;
  pointer-events: none;
}
.markdown-preview-page :deep(.markdown-file-preview) {
  position: relative;
  z-index: 1;
}
.markdown-preview-page :deep(.markdown-body) {
  background-color: transparent;
  color: #1f2328;
  color-scheme: light;
}
.markdown-preview-page :deep(.markdown-body > :first-child) {
  margin-top: 0;
}
@media print {
  @page {
    size: A4;
    margin: 0;
  }
  :global(html),
  :global(body),
  :global(#app) {
    height: auto !important;
    min-height: 0 !important;
    overflow: visible !important;
    background: #fff !important;
    color-scheme: light;
  }
  .standalone-file-preview {
    display: block;
    height: auto;
    min-height: 0;
    overflow: visible;
    padding: 0;
    background: #fff;
  }
  .standalone-markdown-header {
    display: none;
  }
  .markdown-preview-page {
    width: 210mm;
    min-height: 297mm;
    margin: 0;
    padding: 18mm;
    box-shadow: none;
  }
  .markdown-watermark {
    position: absolute;
    z-index: 0;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }
}
</style>
