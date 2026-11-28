import { shallowRef } from 'vue';
import {
  browserAttachmentOpenSchema,
  browserDownloadPageSchema,
  type BrowserAttachmentMessage,
  type BrowserCapability,
  type BrowserContextOptions,
  type BrowserControlRequest,
  type BrowserControlResponse,
  type BrowserDownloadInfo,
  type BrowserFindOperation,
  type BrowserFindResult,
  type BrowserProfileCommand,
  type BrowserPictureMode,
  type BrowserPictureQuality,
  type BrowserTabSnapshot
} from '@myagentroam/protocol';
import { browserStreamGrant } from '@myagentroam/protocol/browser-stream';
import { BrowserRecordLink } from './browser-record-link.js';
import { createUuid } from '../util/uuid.js';
import { BrowserAttachmentClient, type BrowserStreamSample } from './browser-attachment-client.js';
import type { BrowserDrawnView } from './browser-viewport.js';
import { uploadBrowserFiles } from './browser-upload.js';
import type { WorkbenchHttpService } from './workbench-http-service.js';
import { ApiError } from '../util/api-error.js';
import type { OpenWorkbenchNodeStream } from './workbench-node-connection-service.js';
import { downloadWorkspaceFileToBrowser } from './workspace-direct-download-stream-service.js';
import { receiveFileDownloadBody } from './workspace-download-stream.js';

type Scope = { nodeId: string; workspaceId: string };
export type BrowserDestination = { url: string } | { htmlPath: string };
type Request = BrowserControlRequest['request'];
type Path = 'ice' | 'relay';
type Connection = {
  selection?: { id: string; finish: (text: string) => void };
  find?: { id: string; finish: (result?: BrowserFindResult) => void };
  contextMenu?: { id: string; finish: (options?: BrowserContextOptions) => void };
  scope: Scope;
  canvas: HTMLCanvasElement;
  viewportElement: HTMLElement;
  capability: WorkbenchBrowserCapability;
  attempt: number;
  browserId?: string;
  retried?: true;
  controlLost?: true;
  attachmentId?: string;
  data?: BrowserAttachmentClient;
  opening?: AbortController;
  deadline?: ReturnType<typeof setTimeout>;
  renew?: ReturnType<typeof setTimeout>;
  presence?: AbortController;
  upload?: AbortController;
};

/** Owns the page's Browser control RPCs and one visible attachment. The Node
 * owns browser/tab/Profile state; neither the transport nor the view restores it. */
export function createWorkbenchBrowserService(options: {
  send(message: BrowserControlRequest): boolean;
  connectionId(): string | undefined;
  http?: WorkbenchHttpService['request'];
  openStream?: OpenWorkbenchNodeStream;
  activeDownloadWorker?: () => Promise<ServiceWorker | undefined>;
}) {
  const pending = new Map<string, (message: BrowserControlResponse) => void>();
  const snapshot = shallowRef<BrowserTabSnapshot>();
  const frame = shallowRef<BrowserDrawnView>();
  const tabIcons = shallowRef(new Map<string, { url: string; png: string }>());
  const path = shallowRef<Path>();
  const pictureMode = shallowRef<BrowserPictureMode>('auto');
  const pictureQuality = shallowRef<BrowserPictureQuality>();
  const streamSample = shallowRef<BrowserStreamSample>();
  const status = shallowRef<'idle' | 'connecting' | 'ready' | 'failed'>('idle');
  const uploadStatus = shallowRef<'sending' | 'finishing' | 'canceling'>();
  const visibleBrowserId = shallowRef<string>();
  const error = shallowRef<string>();
  const destination = shallowRef<{ scope: Scope; target: BrowserDestination }>();
  let current: Connection | undefined;
  let cleanup: Promise<unknown> = Promise.resolve();
  let admission: Promise<unknown> = Promise.resolve();

  function request(command: Request): Promise<unknown> {
    const requestId = createUuid();
    return new Promise((resolve, reject) => {
      const finish = (message: BrowserControlResponse) => {
        clearTimeout(deadline);
        pending.delete(requestId);
        if (message.error) reject(new Error(message.error));
        else resolve(message.result);
      };
      const deadline = setTimeout(
        () => finish({ type: 'browser.response', requestId, error: 'BROWSER_OUTCOME_UNKNOWN' }),
        30_000
      );
      pending.set(requestId, finish);
      try {
        if (options.send({ type: 'browser.request', requestId, request: command })) return;
      } catch {
        /* The socket stopped accepting writes. */
      }
      finish({ type: 'browser.response', requestId, error: 'BROWSER_CONTROL_DISCONNECTED' });
    });
  }

  function handle(message: BrowserControlResponse): void {
    pending.get(message.requestId)?.(message);
  }

  function release(id: string): Promise<unknown> {
    return request({ action: 'release', attachmentId: id }).catch(() => undefined);
  }

  function stop(connection: Connection): void {
    connection.attempt++;
    const { attachmentId } = connection;
    delete connection.attachmentId;
    connection.selection?.finish('');
    connection.find?.finish();
    connection.contextMenu?.finish();
    connection.upload?.abort();
    uploadStatus.value = undefined;
    clearTimeout(connection.deadline);
    clearTimeout(connection.renew);
    connection.presence?.abort();
    delete connection.presence;
    connection.data?.close();
    tabIcons.value = new Map();
    streamSample.value = undefined;
    connection.opening?.abort();
    if (attachmentId) {
      const releaseOld = release(attachmentId);
      cleanup = Promise.all([cleanup, releaseOld]).then(() => undefined);
    }
    delete connection.data;
    delete connection.opening;
  }

  function hide(): void {
    const old = current;
    current = undefined;
    if (old) stop(old);
    visibleBrowserId.value = undefined;
    snapshot.value = frame.value = path.value = error.value = undefined;
    status.value = 'idle';
  }

  function fail(connection: Connection, code: string): void {
    if (current !== connection) return;
    stop(connection);
    snapshot.value = frame.value = path.value = undefined;
    status.value = 'failed';
    error.value = code;
  }

  function disconnected(): void {
    for (const [requestId, finish] of pending)
      finish({ type: 'browser.response', requestId, error: 'BROWSER_OUTCOME_UNKNOWN' });
    if (!current || status.value === 'failed') return;
    if (current.browserId && !current.retried) current.controlLost = true;
    fail(current, 'BROWSER_CONTROL_DISCONNECTED');
  }

  function controlReady(): void {
    const connection = current;
    if (!connection?.controlLost || !options.connectionId()) return;
    delete connection.controlLost;
    connection.retried = true;
    error.value = undefined;
    status.value = 'connecting';
    void attach(connection, connection.capability);
  }

  function recoverAttachment(
    connection: Connection,
    capability: WorkbenchBrowserCapability,
    route: Path,
    code: string
  ): void {
    if (current !== connection || status.value === 'failed') return;
    if (
      !connection.retried &&
      connection.browserId &&
      options.connectionId() &&
      (code === 'BROWSER_DISCONNECTED' ||
        code === 'BROWSER_LINK_UNAVAILABLE' ||
        code === 'BROWSER_NO_FRAME' ||
        code === 'BROWSER_LEASE_ENDED' ||
        code === 'BROWSER_LEASE_EXPIRED' ||
        (route === 'ice' && code === 'BROWSER_ICE_UNAVAILABLE'))
    ) {
      connection.retried = true;
      status.value = 'connecting';
      snapshot.value = frame.value = path.value = error.value = undefined;
      stop(connection);
      void attach(connection, capability);
    } else fail(connection, code);
  }

  async function attach(
    connection: Connection,
    capability: WorkbenchBrowserCapability
  ): Promise<void> {
    if (current !== connection || !connection.browserId) return;
    if (!options.openStream) return fail(connection, 'BROWSER_LINK_UNAVAILABLE');
    const { scope, canvas, viewportElement, browserId } = connection;
    const attempt = ++connection.attempt;
    const opening = new AbortController();
    connection.opening = opening;
    let route: Path = 'relay';
    const active = () => current === connection && connection.attempt === attempt;
    let stream;
    try {
      stream = await options.openStream(
        scope.nodeId,
        {
          kind: 'browser-rfb',
          prepare: async (transportId, signal) => {
            if (transportId !== undefined && !capability.ice) return undefined;
            const next = admission.then(async () => {
              await cleanup;
              signal.throwIfAborted();
              try {
                const grant = browserAttachmentOpenSchema.parse(
                  await request({
                    action: 'attach',
                    ...scope,
                    browserId,
                    ...(transportId !== undefined && { transportId })
                  })
                );
                if (!active() || signal.aborted) {
                  await release(grant.attachmentId);
                  signal.throwIfAborted();
                  return undefined;
                }
                route = transportId === undefined ? 'relay' : 'ice';
                connection.attachmentId = grant.attachmentId;
                return browserStreamGrant(grant);
              } catch (error) {
                if (
                  transportId !== undefined &&
                  error instanceof Error &&
                  error.message === 'BROWSER_ICE_UNAVAILABLE'
                )
                  return undefined;
                throw error;
              }
            });
            admission = next.catch(() => undefined);
            return next;
          }
        },
        opening.signal
      );
    } catch (cause) {
      if (!active()) return;
      const code =
        cause instanceof Error && cause.message.startsWith('BROWSER_')
          ? cause.message
          : 'BROWSER_DISCONNECTED';
      return recoverAttachment(connection, capability, route, code);
    }
    const attachmentId = connection.attachmentId;
    if (!active() || !attachmentId) {
      stream.close();
      return;
    }
    delete connection.opening;
    const attachedHere = () => active() && connection.attachmentId === attachmentId;
    const linkFailed = (code: string) => {
      if (attachedHere()) recoverAttachment(connection, capability, route, code);
    };
    const awaitPicture = () => {
      clearTimeout(connection.deadline);
      connection.deadline = setTimeout(() => linkFailed('BROWSER_NO_FRAME'), 10_000);
    };
    const reportPresence = () => {
      if (attachedHere() && connection.presence && document.visibilityState === 'visible')
        connection.data?.send({ type: 'presence' });
    };
    const renew = async () => {
      reportPresence();
      try {
        await request({ action: 'renew', attachmentId });
        if (current === connection && connection.attachmentId === attachmentId)
          connection.renew = setTimeout(() => void renew(), 5_000);
      } catch (cause) {
        if (connection.attachmentId === attachmentId) {
          const code = cause instanceof Error ? cause.message : 'BROWSER_LEASE_ENDED';
          // An unacknowledged renewal is just as unsafe to keep using as an expired lease.
          linkFailed(code === 'BROWSER_OUTCOME_UNKNOWN' ? 'BROWSER_LEASE_ENDED' : code);
        }
      }
    };
    awaitPicture();
    connection.data = new BrowserAttachmentClient(new BrowserRecordLink(stream), canvas, {
      ...(capability.resizeViewport && { viewportElement }),
      downloadManagement: capability.downloadManagement === true,
      tabControls: capability.tabControls === true,
      agentActivity: capability.agentActivity === true,
      ...(capability.tabIcons && {
        tabIcon({ tabId, url, png }) {
          if (
            attachedHere() &&
            snapshot.value?.tabs.some((tab) => tab.id === tabId && tab.url === url && !tab.loading)
          )
            tabIcons.value = new Map(tabIcons.value).set(tabId, { url, png });
        }
      }),
      attached() {
        if (!attachedHere()) return;
        pictureQuality.value = undefined;
        if (pictureMode.value !== 'auto')
          connection.data?.send({ type: 'quality', mode: pictureMode.value });
        path.value = route;
        if (capability.foregroundPresence && typeof document !== 'undefined') {
          connection.presence = new AbortController();
          document.addEventListener('visibilitychange', reportPresence, {
            signal: connection.presence.signal
          });
          reportPresence();
        }
        connection.renew = setTimeout(() => void renew(), 5_000);
      },
      snapshot(value) {
        if (!attachedHere()) return;
        if (snapshot.value?.viewVersion !== value.viewVersion) {
          if (status.value === 'ready' && frame.value?.viewVersion === snapshot.value?.viewVersion)
            awaitPicture();
          connection.selection?.finish('');
          connection.find?.finish();
          connection.contextMenu?.finish();
        }
        const currentIcons = tabIcons.value;
        const retained = [...currentIcons].filter(([id, { url }]) =>
          value.tabs.some((tab) => tab.id === id && tab.url === url && !tab.loading)
        );
        if (retained.length !== currentIcons.size) tabIcons.value = new Map(retained);
        snapshot.value = value;
      },
      selection(id, text) {
        if (attachedHere() && connection.selection?.id === id) connection.selection.finish(text);
      },
      find({ id, result }) {
        if (attachedHere() && connection.find?.id === id) connection.find.finish(result);
      },
      contextMenu({ id, options }) {
        if (attachedHere() && connection.contextMenu?.id === id)
          connection.contextMenu.finish(options);
      },
      frame(value) {
        if (!attachedHere()) return;
        clearTimeout(connection.deadline);
        // A decoded picture ends this outage. A later, independent outage has
        // its own retry; a replacement that never paints cannot loop.
        delete connection.retried;
        frame.value = value;
        status.value = 'ready';
      },
      quality(value) {
        if (attachedHere()) pictureQuality.value = value;
      },
      sample(value) {
        if (attachedHere()) streamSample.value = value;
      },
      downloadProgress: capability.downloadProgress === true,
      failed(code) {
        if (attachedHere()) error.value = code;
      },
      ended: linkFailed
    });
  }

  async function show(
    scope: Scope,
    capability: WorkbenchBrowserCapability,
    canvas: HTMLCanvasElement,
    operation:
      | { action: 'lookup' }
      | { action: 'open'; preserveLogin: boolean }
      | { action: 'resume'; browserId: string },
    viewportElement: HTMLElement
  ): Promise<void> {
    hide();
    const connection: Connection = { scope, canvas, viewportElement, capability, attempt: 0 };
    current = connection;
    status.value = 'connecting';
    try {
      if (!capability.vnc) return fail(connection, 'BROWSER_VNC_UNAVAILABLE');
      if (current !== connection) return;
      const browserId =
        operation.action === 'resume'
          ? operation.browserId
          : (
              (await request({ action: 'resource', ...scope, command: operation })) as {
                browserId?: string;
              }
            ).browserId;
      if (current !== connection) return;
      if (!browserId) {
        status.value = 'idle';
        return;
      }
      connection.browserId = browserId;
      visibleBrowserId.value = browserId;
      await attach(connection, capability);
    } catch (cause) {
      fail(connection, cause instanceof Error ? cause.message : 'BROWSER_FAILED');
    }
  }

  async function closeBrowser(): Promise<boolean> {
    const old = current;
    if (!old?.browserId) return false;
    try {
      await request({
        action: 'resource',
        ...old.scope,
        command: { action: 'close', browserId: old.browserId }
      });
      if (current !== old) return false;
      hide();
      return true;
    } catch (cause) {
      if (current === old) error.value = cause instanceof Error ? cause.message : 'BROWSER_FAILED';
      return false;
    }
  }

  function send(message: Exclude<BrowserAttachmentMessage, { type: 'ack' }>): boolean {
    if (!current?.data?.send(message)) return false;
    if (message.type !== 'input') error.value = undefined;
    return true;
  }

  function copySelection(): Promise<string> {
    const connection = current;
    const viewVersion = frame.value?.viewVersion;
    if (!connection || !viewVersion) return Promise.resolve('');
    connection.selection?.finish('');
    return new Promise((resolve) => {
      const id = createUuid();
      const timer = setTimeout(() => finish(''), 5000);
      const finish = (text: string): void => {
        clearTimeout(timer);
        delete connection.selection;
        resolve(text);
      };
      connection.selection = { id, finish };
      if (!send({ type: 'selection.copy', id, viewVersion })) finish('');
    });
  }

  function findInPage(
    viewVersion: number,
    operation: BrowserFindOperation
  ): Promise<BrowserFindResult | undefined> {
    const connection = current;
    if (!connection || snapshot.value?.viewVersion !== viewVersion)
      return Promise.resolve(undefined);
    connection.find?.finish();
    return new Promise((resolve) => {
      const id = createUuid();
      const timer = setTimeout(() => finish(), 5000);
      const finish = (result?: BrowserFindResult): void => {
        clearTimeout(timer);
        delete connection.find;
        resolve(result);
      };
      connection.find = { id, finish };
      if (!send({ type: 'find.update', id, viewVersion, operation })) finish();
    });
  }

  function queryContextMenu(
    viewVersion: number,
    point?: { x: number; y: number }
  ): Promise<(BrowserContextOptions & { id: string; viewVersion: number }) | undefined> {
    const connection = current;
    if (!connection || frame.value?.viewVersion !== viewVersion) return Promise.resolve(undefined);
    connection.contextMenu?.finish();
    return new Promise((resolve) => {
      const id = createUuid();
      const timer = setTimeout(() => finish(), 5_000);
      const finish = (options?: BrowserContextOptions): void => {
        clearTimeout(timer);
        delete connection.contextMenu;
        resolve(options && { ...options, id, viewVersion });
      };
      connection.contextMenu = { id, finish };
      if (!send({ type: 'context.open', id, viewVersion, ...(point && { point }) })) finish();
    });
  }

  async function upload(chooserId: string, files?: readonly File[]): Promise<void> {
    const connection = current;
    const connectionId = options.connectionId();
    const attachmentId = connection?.attachmentId;
    if (
      !options.http ||
      !connectionId ||
      !attachmentId ||
      !connection ||
      snapshot.value?.fileChooser?.id !== chooserId ||
      (files && connection.upload) ||
      uploadStatus.value === 'finishing' ||
      uploadStatus.value === 'canceling'
    )
      return;
    connection.upload?.abort();
    const controller = new AbortController();
    connection.upload = controller;
    uploadStatus.value = files ? 'sending' : 'canceling';
    error.value = undefined;
    try {
      await uploadBrowserFiles(options.http, connectionId, { attachmentId, chooserId }, files, {
        signal: controller.signal,
        openStream: (issueTicket, signal) => {
          if (!options.openStream) throw new Error('NODE_CONNECTION_UNAVAILABLE');
          return options.openStream(
            connection.scope.nodeId,
            { kind: 'browser-file-upload', issueTicket },
            signal
          );
        },
        finishing: () => {
          if (connection.upload === controller && !controller.signal.aborted)
            uploadStatus.value = 'finishing';
        }
      });
    } catch (cause) {
      if (current === connection && !controller.signal.aborted)
        error.value =
          cause instanceof ApiError
            ? cause.code
            : cause instanceof Error
              ? cause.message
              : 'BROWSER_UPLOAD_FAILED';
    } finally {
      if (connection.upload === controller) {
        delete connection.upload;
        if (current === connection) uploadStatus.value = undefined;
      }
    }
  }

  function downloadTarget(): { attachmentId: string; connectionId: string } | undefined {
    const attachmentId = current?.attachmentId;
    const connectionId = options.connectionId();
    if (attachmentId && connectionId && status.value === 'ready')
      return { attachmentId, connectionId };
  }

  async function downloads(offset: number, signal: AbortSignal) {
    const target = downloadTarget();
    if (!options.http || !target) throw new Error('BROWSER_LEASE_ENDED');
    return browserDownloadPageSchema.parse(
      await options.http(
        `/api/browser/downloads?${new URLSearchParams({
          ...target,
          offset: String(offset),
          ...(snapshot.value?.startedDownloadCount !== undefined && { progress: '1' })
        })}`,
        { signal }
      )
    );
  }

  async function changeDownload(
    action: 'cancel' | 'delete' | 'workspace',
    id: string,
    path?: string
  ): Promise<void> {
    const target = downloadTarget();
    if (!options.http || !target) throw new Error('BROWSER_LEASE_ENDED');
    await options.http(
      `/api/browser/downloads/${action}?${new URLSearchParams({ connectionId: target.connectionId })}`,
      {
        method: 'POST',
        body: JSON.stringify({
          attachmentId: target.attachmentId,
          command: { action, id, ...(path !== undefined && { path }) }
        })
      }
    );
  }

  function downloadTargetKey(): string | undefined {
    const target = downloadTarget();
    if (target) return `${target.connectionId}:${target.attachmentId}`;
  }

  async function saveDownload({ id, name, size, state }: BrowserDownloadInfo): Promise<void> {
    const target = downloadTarget();
    const nodeId = current?.scope.nodeId;
    const { http, openStream, activeDownloadWorker } = options;
    if (!target || !nodeId || !http || !openStream) throw new Error('BROWSER_LEASE_ENDED');
    if (state !== 'ready' || size === undefined) throw new Error('BROWSER_DOWNLOAD_NOT_READY');
    const { connectionId, attachmentId } = target;
    const url = `/api/browser/downloads/stream-ticket?${new URLSearchParams({ connectionId })}`;
    // Use the list metadata for the sink; start the ticket lifetime only when a path can use it.
    const issueTicket = async (signal: AbortSignal) => {
      signal.throwIfAborted();
      const grant = await http<{ ticket: string; name: string; size: number; nodeId: string }>(
        url,
        {
          method: 'POST',
          body: JSON.stringify({ attachmentId, id }),
          signal
        }
      );
      if (grant.nodeId !== nodeId || grant.name !== name || grant.size !== size)
        throw new Error('NODE_RESPONSE_INVALID');
      return grant.ticket;
    };
    // The Server binds admission to the live Browser instance; hiding its picture does not stop an admitted save.
    await downloadWorkspaceFileToBrowser({
      fileName: name,
      size,
      ...(activeDownloadWorker === undefined ? {} : { activeWorker: activeDownloadWorker }),
      download: (sink, cancellation = new AbortController().signal) =>
        receiveFileDownloadBody(
          () => openStream(nodeId, { kind: 'browser-file-download', issueTicket }, cancellation),
          sink,
          size,
          cancellation
        )
    });
  }

  return {
    snapshot,
    frame,
    tabIcons,
    path,
    streamSample,
    pictureMode,
    pictureQuality,
    selectPictureMode(mode: BrowserPictureMode) {
      pictureMode.value = mode;
      current?.data?.send({ type: 'quality', mode });
    },
    status,
    uploadStatus,
    error,
    destination,
    openDestination: (scope: Scope, target: BrowserDestination) => {
      destination.value = { scope, target };
    },
    clearDestination: () => {
      destination.value = undefined;
    },
    send,
    copySelection,
    findInPage,
    queryContextMenu,
    upload,
    downloads,
    cancelDownload: (id: string) => changeDownload('cancel', id),
    deleteDownload: (id: string) => changeDownload('delete', id),
    saveDownloadToWorkspace: (id: string, path: string) => changeDownload('workspace', id, path),
    downloadTargetKey,
    saveDownload,
    hide,
    show,
    handle,
    disconnected,
    controlReady,
    closeBrowser,
    browserId: () => visibleBrowserId.value,
    profile: ({ nodeId, workspaceId }: Scope, command: BrowserProfileCommand) =>
      request({ action: 'profile', nodeId, workspaceId, command })
  };
}

export type WorkbenchBrowserService = ReturnType<typeof createWorkbenchBrowserService>;
export type WorkbenchBrowserCapability = BrowserCapability & {
  resizeViewport?: boolean;
  vnc?: boolean;
  downloadProgress?: boolean;
  tabIcons?: boolean;
  nativeTouch?: boolean;
  contextMenu?: boolean;
  find?: boolean;
  downloadManagement?: boolean;
  tabControls?: boolean;
  downloadWorkspace?: boolean;
  agentActivity?: boolean;
  foregroundPresence?: boolean;
};
