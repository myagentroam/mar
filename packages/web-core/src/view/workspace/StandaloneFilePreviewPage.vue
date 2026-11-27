<script setup lang="ts">
import type { ComposerQuoteTarget } from '../../model/composer-quote.js';
import { marIcon } from '@myagentroam/mar-ui/icons';
import { isComposerAttachmentResourcePath } from '@myagentroam/protocol';

import githubMarkdownLightThemeUrl from 'github-markdown-css/github-markdown-light.css?url';
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { MarMessageBox } from '../../service/message-box-service.js';
import { createScopedHttpService } from '../../service/scoped-http-service.js';
import type { createSessionShareAccessService } from '../../service/session-share-access-service.js';
import { createSessionShareClientService } from '../../service/session-share-client-service.js';
import { createFilePreviewWindowInteractionService } from '../../service/file-preview-window-interaction-service.js';
import WorkspaceTextFilePage from './WorkspaceTextFilePage.vue';
import WorkspaceFormatFilePage from './WorkspaceFormatFilePage.vue';
import WorkspaceFileTabs from './WorkspaceFileTabs.vue';
import FilePreviewLoading from './FilePreviewLoading.vue';
import HtmlPreviewFrame from './HtmlPreviewFrame.vue';
import { createHtmlPreviewService } from '../../service/html-preview-service.js';
import { filePreviewErrorMessage } from '../../util/error-presentation.js';
import MarkdownFilePreview from './MarkdownFilePreview.vue';
import { markdownPreviewPreferenceService } from '../../service/markdown-preview-preference-service.js';
import { translate } from '../../service/locale-preference-service.js';
import { createStandaloneWorkspaceDirectTransferService } from '../../service/standalone-workspace-direct-transfer-service.js';
import { createWorkbenchNodeConnectionService } from '../../service/workbench-node-connection-service.js';
import { createHostedFileDownloadService } from '../../service/hosted-file-download-service.js';
import { usePwaApplicationService } from '../../service/pwa-application-service.js';
import { createStandaloneFileWindowService } from '../../service/standalone-file-window-service.js';
import { directFileContentRevision } from '../../service/workspace-direct-file-read-service.js';
import {
  readFilePreview,
  usesNativeHttpFilePreview
} from '../../service/file-preview-read-service.js';
import { revokeWorkspaceDirectObjectUrl } from '../../service/workspace-direct-object-url-service.js';
import {
  decodeFilePreviewContent,
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
import type { DirtyTextDraft } from '../../model/workspace-file-workbench.js';

const pwaApplication = usePwaApplicationService();

interface FileRead {
  readonly path: string;
  readonly size?: number;
  readonly encoding: 'utf-8' | 'base64';
  readonly previewEncoding?: string;
  readonly content: string;
  readonly truncated: boolean;
  readonly nextOffset: number | null;
  readonly revision?: string;
}

const props = defineProps<{
  readonly quoteTarget?: ComposerQuoteTarget | undefined;
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
const downloadFailure = ref<unknown>();
const contentUrl = ref<string>();
const objectUrl = ref<string>();
const loading = ref(true);
const downloading = ref(false);
const csrfToken = ref(
  shareAccess === undefined ? (sessionStorage.getItem('mar.user.csrf-token') ?? '') : ''
);
const writeEnabled =
  shareAccess === undefined &&
  query.get('write') === '1' &&
  Object.keys(fileTarget).length === 0 &&
  !isComposerAttachmentResourcePath(query.get('path') ?? '');
const http =
  shareClient ??
  createScopedHttpService({
    csrfToken: () => csrfToken.value,
    renewCsrfToken: renewCsrfToken
  });
const hostedLifetime = new AbortController();
const hostedConnections =
  hostedMode && shareAccess === undefined
    ? createWorkbenchNodeConnectionService({ http })
    : undefined;
const hostedFiles =
  hostedConnections === undefined
    ? undefined
    : createHostedFileDownloadService({
        http,
        openStream: hostedConnections.openStream,
        activeWorker: pwaApplication.activeWorker
      });
const htmlPreview = createHtmlPreviewService(http);
const htmlState = htmlPreview.state;
const error = computed(() =>
  htmlState.value.error !== undefined
    ? filePreviewErrorMessage(htmlState.value.error, query.get('path') ?? '')
    : errorKey.value === ''
      ? ''
      : translate(errorKey.value)
);
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

function workspaceTransfer() {
  const nodeId = query.get('nodeId');
  const workspaceId = query.get('workspaceId');
  if (nodeId === null || workspaceId === null) throw new Error('NODE_CONNECTION_UNAVAILABLE');
  // Native HTTP previews do not warm a connection; a file-stream operation owns that decision.
  return (directTransfer ??= createStandaloneWorkspaceDirectTransferService({
    nodeId,
    workspaceId,
    activeDownloadWorker: pwaApplication.activeWorker,
    ...(shareAccess !== undefined && { fileStreams: shareAccess.fileStreams }),
    http,
    ...fileTarget
  }));
}

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
    await MarMessageBox.confirm(
      translate('fileEditor.unsavedMessage'),
      translate('fileEditor.unsavedTitle'),
      { icon: marIcon('warning'), type: 'warning' }
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
  if (htmlPreviewMode) {
    loading.value = true;
    if (!hostedMode && isHtmlFile(path) && Object.keys(fileTarget).length === 0) {
      await htmlPreview.open({ nodeId, workspaceId, path });
    } else {
      errorKey.value = 'htmlPreview.unavailable';
    }
    loading.value = false;
    return;
  }
  await loadFile();
});

async function loadFile(): Promise<void> {
  const nodeId = query.get('nodeId');
  const workspaceId = query.get('workspaceId');
  const path = query.get('path');
  if (nodeId === null || workspaceId === null || path === null) return;
  loading.value = true;
  errorKey.value = '';
  directIdentity = undefined;
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
    // Keep native image caching and player Range requests on their original URLs.
    if (usesNativeHttpFilePreview(path)) {
      contentUrl.value = rawContentUrl(nodeId, workspaceId, path);
      return;
    }
    if (usesRawFilePreview(path)) {
      const preview = await readFileObject(path);
      file.value = {
        path,
        size: preview.size,
        encoding: 'base64',
        content: '',
        truncated: false,
        nextOffset: null,
        revision: preview.revision
      };
      return;
    }
    const first = await readFilePreview((limit) => readRange(path, limit));
    if (first.encoding === 'base64') {
      if (objectUrl.value !== undefined) revokeWorkspaceDirectObjectUrl(objectUrl.value);
      file.value = { ...first, content: '', truncated: false, nextOffset: null };
      if (filePreviewKind(path, 'base64') === 'unsupported') return;
      await readFileObject(path);
    } else {
      file.value = {
        ...first,
        truncated: first.nextOffset !== null,
        nextOffset: first.nextOffset
      };
    }
  } catch {
    errorKey.value = 'generated.standaloneFilePreviewPage.unableToReadTheFileCheckYour';
  } finally {
    loading.value = false;
  }
}

async function readFileObject(path: string) {
  const preview = await workspaceTransfer().objectUrl(path);
  objectUrl.value = contentUrl.value = preview.url;
  return preview;
}

async function loadHostedFile(nodeId: string, path: string): Promise<void> {
  const conversationId = query.get('conversationId');
  const fileId = query.get('fileId');
  const mimeType = query.get('mimeType') ?? '';
  const size = Number(query.get('size'));
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
  if (usesNativeHttpFilePreview(path)) {
    contentUrl.value = url;
    loading.value = false;
    return;
  }
  try {
    if (hostedFiles === undefined) throw new Error('NODE_CONNECTION_UNAVAILABLE');
    const signal = hostedLifetime.signal;
    const snapshot = await hostedFiles.describe({ nodeId, conversationId, fileId }, signal);
    signal.throwIfAborted();
    const revision = `${snapshot.updatedAt}-${snapshot.size}`;
    if (!textPreview) {
      file.value = { ...file.value, size: snapshot.size, revision };
      objectUrl.value = await hostedFiles.objectUrl(nodeId, snapshot, signal);
      contentUrl.value = objectUrl.value;
      return;
    }
    file.value = await readFilePreview(async (limit): Promise<FileRead> => {
      const bytes = await hostedFiles.readRange(nodeId, snapshot, 0, limit, signal);
      const readSize = snapshot.size;
      const decoded = decodeFilePreviewContent(bytes, path, bytes.byteLength >= readSize, mimeType);
      return {
        path,
        size: readSize,
        revision,
        ...decoded,
        truncated: decoded.encoding === 'utf-8' && bytes.byteLength < readSize,
        nextOffset:
          decoded.encoding === 'utf-8' && bytes.byteLength < readSize ? bytes.byteLength : null
      };
    });
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
  if (
    nodeId === null ||
    workspaceId === null ||
    path === null ||
    file.value?.previewEncoding !== undefined
  )
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
  hostedLifetime.abort();
  hostedConnections?.reset();
  htmlPreview.release();
  if (renderedPreviewMode) windowInteraction.dispose();
  else window.removeEventListener('mar-before-standalone-navigation', captureDirtyDrafts);
  window.removeEventListener('online', handleNetworkChange);
  window.removeEventListener('offline', handleNetworkChange);
  directTransfer?.close();
  if (objectUrl.value !== undefined) revokeWorkspaceDirectObjectUrl(objectUrl.value);
});

async function download(): Promise<void> {
  if (file.value === undefined) return;
  downloadFailure.value = undefined;
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
      if (hostedFiles === undefined) throw new Error('NODE_CONNECTION_UNAVAILABLE');
      await hostedFiles.download({ nodeId, conversationId, fileId }, hostedLifetime.signal);
      return;
    }
    await workspaceTransfer().download(path);
  } catch (failure) {
    if (!(failure instanceof DOMException && failure.name === 'AbortError'))
      downloadFailure.value = failure;
  } finally {
    downloading.value = false;
  }
}

function handleNetworkChange(): void {
  directTransfer?.networkChanged();
}

async function readRange(path: string, limit: number): Promise<FileRead> {
  const direct = await workspaceTransfer().readRange(path, 0, limit, directIdentity);
  directIdentity = {
    revision: direct.revision,
    size: direct.size
  };
  const decoded = decodeFilePreviewContent(direct.bytes, path, direct.nextOffset === null);
  const revision =
    writeEnabled && decoded.encoding === 'utf-8' && decoded.previewEncoding === undefined
      ? await directFileContentRevision(direct)
      : undefined;
  return {
    path,
    size: direct.size,
    ...decoded,
    truncated: direct.nextOffset !== null,
    nextOffset: direct.nextOffset,
    ...(revision === undefined ? {} : { revision })
  };
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

function bindHtmlFrame(frame: HTMLIFrameElement): void {
  windowInteraction.bindFrame(frame);
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

function rawContentUrl(nodeId: string, workspaceId: string, path: string): string {
  const parameters = new URLSearchParams({
    nodeId,
    path,
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
      </header>
      <HtmlPreviewFrame
        class="standalone-html-preview-body"
        :url="htmlState.url"
        :loading="loading || htmlState.loading"
        :title="query.get('path') ?? ''"
        @load="bindHtmlFrame"
      />
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
    :presentation="props.share?.embedded ? 'overlay' : 'window'"
    :tabs="standaloneTabs"
    :active-tab-id="activeStandaloneTabId"
    :can-close-unmounted-tab="canCloseUnmountedTab"
    @activate="activateStandaloneTab"
    @close="closeStandaloneTab"
    @close-all="closeStandaloneTabs"
    v-slot="{ tab, active, registerPageHandle, requestClose, requestCloseAll }"
  >
    <p v-if="active && downloadFailure" class="standalone-error" role="alert">
      {{ filePreviewErrorMessage(downloadFailure, file?.path ?? '') }}
    </p>
    <p v-if="active && error" class="standalone-error">{{ error }}</p>
    <WorkspaceTextFilePage
      :quote-target="props.quoteTarget"
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
      @quoted="requestCloseAll"
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
  --mar-bg-page: #fff;
  --mar-text-secondary: #57606a;
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
  background: var(--mar-bg-page);
  color: #1f2328;
  color-scheme: light;
}

.standalone-error {
  margin: 0;
  padding: 24px;
  color: var(--mar-color-danger-text);
  font-size: var(--mar-font-size-body);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
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
.standalone-html-preview-body {
  align-self: stretch;
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
