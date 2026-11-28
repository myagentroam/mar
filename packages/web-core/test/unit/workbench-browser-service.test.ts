import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import type {
  BrowserAttachmentOpen,
  BrowserControlRequest,
  BrowserTabSnapshot,
  BrowserUpload
} from '@myagentroam/protocol';
import { parseBrowserStreamGrant } from '@myagentroam/protocol/browser-stream';
import { NodeStream } from '@myagentroam/protocol/node-stream';
import type { OpenWorkbenchNodeStream } from '../../src/service/workbench-node-connection-service.js';
import { createWorkbenchBrowserService } from '../../src/service/workbench-browser-service.js';
import type { WorkbenchHttpService } from '../../src/service/workbench-http-service.js';
import { downloadWorkspaceFileToBrowser } from '../../src/service/workspace-direct-download-stream-service.js';

vi.mock('../../src/service/workspace-direct-download-stream-service.js', () => ({
  downloadWorkspaceFileToBrowser: vi.fn()
}));

const mock = vi.hoisted(() => ({
  send: vi.fn(() => true),
  open: undefined as BrowserAttachmentOpen | undefined,
  snapshot: undefined as ((value: BrowserTabSnapshot) => void) | undefined,
  frame: undefined as
    ((value: { viewVersion: number; width: number; height: number }) => void) | undefined,
  ended: undefined as ((code: string) => void) | undefined,
  attached: undefined as (() => void) | undefined
}));

vi.mock('../../src/service/browser-attachment-client.js', () => ({
  BrowserAttachmentClient: class {
    constructor(
      _link: unknown,
      _canvas: unknown,
      callbacks: {
        snapshot: (value: BrowserTabSnapshot) => void;
        frame: NonNullable<typeof mock.frame>;
        ended: (code: string) => void;
        attached: () => void;
      }
    ) {
      mock.snapshot = callbacks.snapshot;
      mock.frame = callbacks.frame;
      mock.ended = callbacks.ended;
      mock.attached = callbacks.attached;
    }
    send = mock.send;
    close() {}
  }
}));

function fixtureStream(transport?: string | (() => string | undefined)): OpenWorkbenchNodeStream {
  return async (_node, request, signal) => {
    if (request.kind !== 'browser-rfb') throw new Error('Unexpected fixture stream');
    const grant = await request.prepare(
      typeof transport === 'function' ? transport() : transport,
      signal
    );
    if (!grant) throw new Error('Browser fixture refused to attach');
    mock.open = parseBrowserStreamGrant(grant);
    return {} as NodeStream;
  };
}

afterEach(() => {
  vi.useRealTimers();
  mock.send.mockClear();
  vi.unstubAllGlobals();
});

it.each([true, undefined])(
  'reports presence only for a visible, active attachment (capability: %s)',
  async (supported) => {
    vi.useFakeTimers();
    vi.stubGlobal('window', { location: { origin: 'https://workbench.test' } });
    vi.stubGlobal('WebSocket', class {});
    const document = Object.assign(new EventTarget(), { visibilityState: 'visible' });
    vi.stubGlobal('document', document);
    const requests: BrowserControlRequest['request'][] = [];
    const service = createWorkbenchBrowserService({
      connectionId: () => 'workbench',
      openStream: fixtureStream(),
      send({ requestId, request }) {
        requests.push(request);
        queueMicrotask(() =>
          service.handle({
            type: 'browser.response',
            requestId,
            ...(request.action === 'attach' && {
              result: { type: 'OPEN', attachmentId: randomUUID(), ticket: 'A'.repeat(32) }
            })
          })
        );
        return true;
      }
    });
    await service.show(
      { nodeId: 'n', workspaceId: 'w' },
      {
        apiVersion: 1,
        vnc: true,
        ice: false,
        nodeGeneration: 'g',
        ...(supported && { foregroundPresence: true })
      },
      {} as HTMLCanvasElement,
      { action: 'resume', browserId: 'browser' },
      {} as HTMLElement
    );
    expect(mock.send).not.toHaveBeenCalled();
    mock.attached!();
    mock.frame!({ viewVersion: 1, width: 800, height: 600 });
    expect(mock.send).toHaveBeenCalledTimes(supported ? 1 : 0);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(mock.send).toHaveBeenCalledTimes(supported ? 2 : 0);
    document.visibilityState = 'hidden';
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(mock.send).toHaveBeenCalledTimes(supported ? 2 : 0);
    expect(requests.filter(({ action }) => action === 'renew')).toHaveLength(2);
    document.visibilityState = 'visible';
    document.dispatchEvent(new Event('visibilitychange'));
    expect(mock.send).toHaveBeenCalledTimes(supported ? 3 : 0);
    if (supported) expect(mock.send).toHaveBeenLastCalledWith({ type: 'presence' });
    service.hide();
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(mock.send).toHaveBeenCalledTimes(supported ? 3 : 0);
    expect(requests.filter(({ action }) => action === 'renew')).toHaveLength(2);
  }
);

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
    openStream: fixtureStream(() =>
      requests.filter(({ action }) => action === 'attach').length === 0 ? 'direct' : undefined
    ),
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
      { apiVersion: 1, vnc: true, ice: true, nodeGeneration: 'g' },
      {} as HTMLCanvasElement,
      { action: 'resume', browserId: 'same-browser' },
      {} as HTMLElement
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
      openStream: fixtureStream(() =>
        transition === 'fallback' && requests.length > 0 ? undefined : 'transport'
      )
    });
    const scope = { nodeId: 'node', workspaceId: 'workspace' };
    const capability = {
      apiVersion: 1,
      vnc: true,
      ice: true,
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
    const first = service.show(scope, capability, view, resume, view);
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    attached(0, firstId);
    await first;
    expect(mock.open?.rfb).toBe(true);
    if (transition !== 'reopen') mock.ended!('BROWSER_DISCONNECTED');
    const next =
      transition === 'fallback' ? undefined : service.show(scope, capability, view, resume, view);
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
      expect(mock.open?.rfb).toBe(true);
    } else {
      expect(requests[2]?.request).not.toHaveProperty('transportId');
      await vi.waitFor(() => expect(mock.open?.attachmentId).toBe(nextId));
      expect(mock.open?.rfb).toBe(true);
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
    openStream: fixtureStream('transport'),
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
    { apiVersion: 1, vnc: true, ice: true, nodeGeneration: 'generation' },
    {} as HTMLCanvasElement,
    { action: 'resume', browserId: 'browser' },
    {} as HTMLElement
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
      openStream: fixtureStream('transport'),
      http: http as WorkbenchHttpService['request']
    });
    const attachmentId = randomUUID();
    const id = randomUUID();
    const opening = service.show(
      { nodeId: 'node', workspaceId: 'workspace' },
      { apiVersion: 1, vnc: true, ice: true, nodeGeneration: 'generation' },
      {} as HTMLCanvasElement,
      { action: 'resume', browserId: 'browser' },
      {} as HTMLElement
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

it.each(['unchanged', 'changed'] as const)(
  'signs only after the sink and cold path are ready (download metadata %s)',
  async (metadata) => {
    const sinkReady = Promise.withResolvers<void>();
    const pathReady = Promise.withResolvers<void>();
    const preparingPath = Promise.withResolvers<void>();
    const sink = {
      write: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
      abort: vi.fn(async () => {})
    };
    const download = { id: randomUUID(), name: 'report.bin', size: 1, state: 'ready' } as const;
    const attachmentId = randomUUID();
    const start = Date.now();
    let time = start;
    let issuedAt: number | undefined;
    const http = vi.fn(async () => {
      issuedAt = time;
      return {
        ticket: 'fresh-ticket',
        nodeId: 'node',
        name: download.name,
        size: metadata === 'changed' ? 2 : download.size
      };
    });
    const opened = vi.fn();
    const downloadToBrowser = vi.mocked(downloadWorkspaceFileToBrowser);
    downloadToBrowser.mockImplementationOnce(async ({ fileName, size, download: receive }) => {
      expect({ fileName, size }).toEqual({ fileName: download.name, size: download.size });
      await sinkReady.promise;
      await receive(sink);
      return 'COMPLETED';
    });
    const service = createWorkbenchBrowserService({
      connectionId: () => 'workbench',
      http: http as WorkbenchHttpService['request'],
      async openStream(node, request, signal) {
        if (request.kind === 'browser-rfb') return fixtureStream()(node, request, signal);
        if (request.kind !== 'browser-file-download') throw new Error('Unexpected stream');
        preparingPath.resolve();
        await pathReady.promise;
        const ticket = await request.issueTicket(signal);
        if (issuedAt === undefined || time - issuedAt >= 15_000) throw new Error('Ticket expired');
        opened(ticket);
        const stream = new NodeStream(
          1,
          async () => {},
          () => {}
        );
        stream.receive({ type: 'DATA', streamId: 1, bytes: Uint8Array.of(42) });
        stream.receive({ type: 'FIN', streamId: 1 });
        return stream;
      },
      send({ requestId, request }) {
        queueMicrotask(() =>
          service.handle({
            type: 'browser.response',
            requestId,
            ...(request.action === 'attach' && {
              result: { type: 'OPEN', attachmentId, ticket: 'A'.repeat(32) }
            })
          })
        );
        return true;
      }
    });
    await service.show(
      { nodeId: 'node', workspaceId: 'workspace' },
      { apiVersion: 1, vnc: true, ice: false, nodeGeneration: 'generation' },
      {} as HTMLCanvasElement,
      { action: 'resume', browserId: 'browser' },
      {} as HTMLElement
    );
    mock.frame!({ viewVersion: 1, width: 800, height: 600 });
    try {
      const result = service.saveDownload(download).then(
        () => undefined,
        (error: unknown) => error
      );
      expect(http).not.toHaveBeenCalled();
      time += 4_000;
      sinkReady.resolve();
      await preparingPath.promise;
      expect(http).not.toHaveBeenCalled();
      time += 12_000;
      pathReady.resolve();
      if (metadata === 'changed')
        expect(await result).toMatchObject({ message: 'NODE_RESPONSE_INVALID' });
      else expect(await result).toBeUndefined();
      expect(issuedAt).toBe(start + 16_000);
      expect(http).toHaveBeenCalledExactlyOnceWith(
        '/api/browser/downloads/stream-ticket?connectionId=workbench',
        {
          method: 'POST',
          body: JSON.stringify({ attachmentId, id: download.id }),
          signal: expect.any(AbortSignal)
        }
      );
      if (metadata === 'unchanged') {
        expect(opened).toHaveBeenCalledExactlyOnceWith('fresh-ticket');
        expect(sink.write).toHaveBeenCalledExactlyOnceWith(Uint8Array.of(42));
        expect(sink.close).toHaveBeenCalledOnce();
      } else {
        expect(opened).not.toHaveBeenCalled();
        expect(sink.abort).toHaveBeenCalledOnce();
      }
    } finally {
      service.hide();
    }
  }
);
