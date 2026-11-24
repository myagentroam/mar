import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import type {
  BrowserAttachmentOpen,
  BrowserControlRequest,
  BrowserTabSnapshot,
  BrowserUpload
} from '@myagentroam/protocol';
import { createWorkbenchBrowserService } from '../../src/service/workbench-browser-service.js';
import type { WorkbenchHttpService } from '../../src/service/workbench-http-service.js';

const mock = vi.hoisted(() => ({
  open: undefined as BrowserAttachmentOpen | undefined,
  supportsBrowserVideo: vi.fn(async (_hd?: boolean) => true),
  snapshot: undefined as ((value: BrowserTabSnapshot) => void) | undefined,
  frame: undefined as
    ((value: { viewVersion: number; width: number; height: number }) => void) | undefined,
  ended: undefined as ((code: string) => void) | undefined,
  attached: undefined as (() => void) | undefined
}));

vi.mock('../../src/service/browser-attachment-client.js', () => ({
  supportsBrowserVideo: mock.supportsBrowserVideo,
  BrowserAttachmentClient: class {
    constructor(
      _link: unknown,
      _canvas: unknown,
      open: BrowserAttachmentOpen,
      callbacks: {
        snapshot: (value: BrowserTabSnapshot) => void;
        frame: NonNullable<typeof mock.frame>;
        ended: (code: string) => void;
        attached: () => void;
      }
    ) {
      mock.open = open;
      mock.snapshot = callbacks.snapshot;
      mock.frame = callbacks.frame;
      mock.ended = callbacks.ended;
      mock.attached = callbacks.attached;
    }
    close() {}
  }
}));

afterEach(() => {
  vi.useRealTimers();
  mock.supportsBrowserVideo.mockReset();
  mock.supportsBrowserVideo.mockResolvedValue(true);
  vi.unstubAllGlobals();
});

it.each([
  'first-frame timeout',
  'view change timeout',
  'lease expiration',
  'control reconnect'
] as const)('reattaches once to the same browser after %s', async (failure) => {
  vi.useFakeTimers();
  vi.stubGlobal('window', { location: { origin: 'https://workbench.test' } });
  vi.stubGlobal('WebSocket', class {});
  const requests: BrowserControlRequest['request'][] = [];
  const service = createWorkbenchBrowserService({
    connectionId: () => 'workbench',
    acquire: () => ({
      transportSessionId: 'direct',
      createChannel: () => ({}) as RTCDataChannel,
      release() {}
    }),
    send({ requestId, request }) {
      requests.push(request);
      queueMicrotask(() =>
        service.handle({
          type: 'browser.response',
          requestId,
          ...(request.action === 'attach' && {
            result: { type: 'OPEN', attachmentId: randomUUID(), ticket: 'A'.repeat(32) }
          }),
          ...(request.action === 'renew' &&
            failure === 'lease expiration' && { error: 'BROWSER_LEASE_EXPIRED' })
        })
      );
      return true;
    }
  });
  try {
    await service.show(
      { nodeId: 'n', workspaceId: 'w' },
      { apiVersion: 1, ice: true, nodeGeneration: 'g' },
      {} as HTMLCanvasElement,
      { action: 'resume', browserId: 'same-browser' }
    );
    if (failure !== 'first-frame timeout') {
      mock.attached!();
      mock.snapshot!({ tabs: [], viewVersion: 1 });
      mock.frame!({ viewVersion: 1, width: 800, height: 600 });
    }
    if (failure === 'view change timeout') {
      mock.snapshot!({ tabs: [], viewVersion: 2 });
      await vi.advanceTimersByTimeAsync(6_000);
      expect(requests.filter(({ action }) => action === 'attach')).toHaveLength(1);
      mock.snapshot!({ tabs: [], viewVersion: 3 });
    }
    // A subsequent failure from the old attachment must not consume the retry.
    const oldEnded = mock.ended!;
    if (failure === 'control reconnect') {
      service.disconnected();
      expect(service.status.value).toBe('failed');
      expect(service.browserId()).toBe('same-browser');
      expect(requests.filter(({ action }) => action === 'attach')).toHaveLength(1);
      service.controlReady();
      service.controlReady();
      await vi.advanceTimersByTimeAsync(0);
    } else {
      await vi.advanceTimersByTimeAsync(
        failure === 'lease expiration' ? 5_000 : failure === 'view change timeout' ? 4_000 : 10_000
      );
    }
    expect(service.status.value).toBe('connecting');
    expect(requests.filter(({ action }) => action === 'attach')).toEqual([
      {
        action: 'attach',
        nodeId: 'n',
        workspaceId: 'w',
        browserId: 'same-browser',
        transportId: 'direct'
      },
      { action: 'attach', nodeId: 'n', workspaceId: 'w', browserId: 'same-browser' }
    ]);
    oldEnded('BROWSER_DISCONNECTED');
    expect(service.status.value).toBe('connecting');
    if (failure === 'control reconnect') {
      mock.attached!();
      mock.snapshot!({ tabs: [], viewVersion: 1 });
      mock.frame!({ viewVersion: 1, width: 800, height: 600 });
      expect(service.status.value).toBe('ready');
      service.disconnected();
      service.controlReady();
      await vi.advanceTimersByTimeAsync(0);
      expect(service.status.value).toBe('connecting');
      expect(requests.filter(({ action }) => action === 'attach')).toHaveLength(3);
      mock.ended!('BROWSER_DISCONNECTED');
      expect(service.status.value).toBe('failed');
      expect(requests.map(({ action }) => action)).toEqual([
        'attach',
        'release',
        'attach',
        'release',
        'attach',
        'release'
      ]);
      return;
    }
    mock.ended!('BROWSER_DISCONNECTED');
    expect(service.status.value).toBe('failed');
    expect(requests.filter(({ action }) => action === 'attach')).toHaveLength(2);
    expect(requests.map(({ action }) => action)).toEqual(
      failure === 'lease expiration' || failure === 'view change timeout'
        ? ['attach', 'renew', 'release', 'attach', 'release']
        : ['attach', 'release', 'attach', 'release']
    );
  } finally {
    service.hide();
  }
});

it.each(['reopen', 'fallback', 'reopen during fallback'] as const)(
  'waits for the old browser writer to release before %s',
  async (transition) => {
    const requests: BrowserControlRequest[] = [];
    const service = createWorkbenchBrowserService({
      send: (request) => {
        requests.push(request);
        return true;
      },
      connectionId: () => 'workbench',
      acquire: () => ({
        transportSessionId: 'transport',
        createChannel: () => ({}) as RTCDataChannel,
        release() {}
      })
    });
    const scope = { nodeId: 'node', workspaceId: 'workspace' };
    const capability = {
      apiVersion: 1,
      ice: true,
      hd: transition !== 'reopen',
      nodeGeneration: 'generation'
    } as const;
    const view = {} as HTMLCanvasElement;
    const firstId = randomUUID();
    const nextId = randomUUID();
    const resume = { action: 'resume', browserId: 'browser' } as const;
    const reply = (index: number, result?: unknown) =>
      service.handle({
        type: 'browser.response',
        requestId: requests[index]!.requestId,
        result
      });
    const attached = (index: number, attachmentId: string) =>
      reply(index, {
        type: 'OPEN',
        attachmentId,
        ticket: 'A'.repeat(32)
      });
    const first = service.show(scope, capability, view, resume);
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    attached(0, firstId);
    await first;
    if (capability.hd) expect(mock.open?.hd).toBe(true);
    else expect(mock.open).not.toHaveProperty('hd');
    const relaySocket = vi.fn(class {});
    if (transition === 'fallback') {
      vi.stubGlobal('window', { location: { origin: 'https://workbench.test' } });
      vi.stubGlobal('WebSocket', relaySocket);
    }
    if (transition !== 'reopen') mock.ended!('BROWSER_DISCONNECTED');
    if (transition === 'reopen during fallback') {
      mock.supportsBrowserVideo.mockImplementation(async (hd) => hd !== true);
    }
    const next =
      transition === 'fallback' ? undefined : service.show(scope, capability, view, resume);
    expect(requests[1]?.request).toEqual({ action: 'release', attachmentId: firstId });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(requests).toHaveLength(2);
    reply(1);
    await vi.waitFor(() => expect(requests).toHaveLength(3));
    expect(requests[2]?.request).toMatchObject({
      action: 'attach',
      ...scope,
      browserId: 'browser'
    });
    attached(2, nextId);
    if (next) {
      expect(requests[2]?.request).toHaveProperty('transportId', 'transport');
      await next;
      expect(mock.open).not.toHaveProperty('hd');
    } else {
      expect(requests[2]?.request).not.toHaveProperty('transportId');
      await vi.waitFor(() => expect(relaySocket).toHaveBeenCalledOnce());
      expect(mock.open).not.toHaveProperty('hd');
    }
    service.hide();
    reply(3);
  }
);

it('holds the upload state until cancellation settles, not until the aborted upload settles', async () => {
  const requests: BrowserControlRequest[] = [];
  const canceled = Promise.withResolvers<unknown>();
  const sent: BrowserUpload[] = [];
  const service = createWorkbenchBrowserService({
    send: (request) => {
      requests.push(request);
      return true;
    },
    connectionId: () => 'workbench',
    acquire: () => ({
      transportSessionId: 'transport',
      createChannel: () => ({}) as RTCDataChannel,
      release() {}
    }),
    http: ((_path, init) => {
      const request = JSON.parse(init!.body as string) as BrowserUpload;
      sent.push(request);
      return request.command.action === 'cancel'
        ? canceled.promise
        : new Promise((_resolve, reject) => {
            init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), {
              once: true
            });
          });
    }) as WorkbenchHttpService['request']
  });
  const opening = service.show(
    { nodeId: 'node', workspaceId: 'workspace' },
    { apiVersion: 1, ice: true, nodeGeneration: 'generation' },
    {} as HTMLCanvasElement,
    { action: 'resume', browserId: 'browser' }
  );
  await vi.waitFor(() => expect(requests).toHaveLength(1));
  service.handle({
    type: 'browser.response',
    requestId: requests[0]!.requestId,
    result: { type: 'OPEN', attachmentId: randomUUID(), ticket: 'A'.repeat(32) }
  });
  await opening;
  const id = randomUUID();
  mock.snapshot!({ tabs: [], viewVersion: 1, fileChooser: { id, multiple: false } });
  const file = new File(['text'], 'upload.txt');
  const uploading = service.upload(id, [file]);
  expect(service.uploadStatus.value).toBe('sending');
  const cancel = service.upload(id);
  await uploading;
  expect(service.uploadStatus.value).toBe('canceling');
  await service.upload(id, [file]);
  expect(sent.map(({ command }) => command.action)).toEqual(['begin', 'cancel']);
  canceled.resolve({});
  await cancel;
  expect(service.uploadStatus.value).toBeUndefined();
  service.hide();
  service.handle({ type: 'browser.response', requestId: requests[1]!.requestId });
});

it.each(['cancel', 'delete', 'workspace'] as const)(
  'sends the download %s action in both the URL and body',
  async (action) => {
    const requests: BrowserControlRequest[] = [];
    const http = vi.fn(async () => ({}));
    const service = createWorkbenchBrowserService({
      send: (request) => {
        requests.push(request);
        return true;
      },
      connectionId: () => 'workbench',
      acquire: () => ({
        transportSessionId: 'transport',
        createChannel: () => ({}) as RTCDataChannel,
        release() {}
      }),
      http: http as WorkbenchHttpService['request']
    });
    const attachmentId = randomUUID();
    const id = randomUUID();
    const opening = service.show(
      { nodeId: 'node', workspaceId: 'workspace' },
      { apiVersion: 1, ice: true, nodeGeneration: 'generation' },
      {} as HTMLCanvasElement,
      { action: 'resume', browserId: 'browser' }
    );
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    service.handle({
      type: 'browser.response',
      requestId: requests[0]!.requestId,
      result: { type: 'OPEN', attachmentId, ticket: 'A'.repeat(32) }
    });
    await opening;
    mock.frame!({ viewVersion: 1, width: 800, height: 600 });
    try {
      if (action === 'cancel') await service.cancelDownload(id);
      else if (action === 'delete') await service.deleteDownload(id);
      else await service.saveDownloadToWorkspace(id, 'reports/result.txt');
      expect(http).toHaveBeenCalledExactlyOnceWith(
        `/api/browser/downloads/${action}?connectionId=workbench`,
        {
          method: 'POST',
          body: JSON.stringify({
            attachmentId,
            command: { action, id, ...(action === 'workspace' && { path: 'reports/result.txt' }) }
          })
        }
      );
    } finally {
      service.hide();
      service.handle({ type: 'browser.response', requestId: requests[1]!.requestId });
    }
  }
);
