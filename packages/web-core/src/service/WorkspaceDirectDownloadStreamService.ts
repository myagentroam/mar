export type WorkspaceDirectDownloadResult = 'COMPLETED' | 'UNAVAILABLE' | 'CANCELLED' | 'FAILED';

export interface WorkspaceDirectDownloadStream {
  readonly sink: {
    write(bytes: Uint8Array): Promise<void>;
    close(): Promise<void>;
    abort(): Promise<void>;
  };
  readonly signal: AbortSignal;
  started(): boolean;
  cancelled(): boolean;
}

const DOWNLOAD_PATH = '/__mar_direct_download__/';
const CONTROL_TIMEOUT_MS = 5_000;
const BACKPRESSURE_TIMEOUT_MS = 30_000;

export async function createWorkspaceDirectDownloadStream(
  fileName: string,
  size: number
): Promise<WorkspaceDirectDownloadStream> {
  const worker = await activeServiceWorker();
  if (worker === undefined) throw new Error('DIRECT_DOWNLOAD_STREAM_UNAVAILABLE');
  const channel = new MessageChannel();
  const id = crypto.randomUUID().replaceAll('-', '');
  const abortController = new AbortController();
  let created = false;
  let downloadStarted = false;
  let streamClosed = false;
  let wasCancelled = false;
  let downloadFrame: HTMLIFrameElement | undefined;
  let credits = 0;
  const creditWaiters: Array<() => void> = [];

  const createdPromise = new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      channel.port1.postMessage({ type: 'abort' });
      channel.port1.close();
      reject(new Error('DIRECT_DOWNLOAD_STREAM_TIMEOUT'));
    }, CONTROL_TIMEOUT_MS);
    channel.port1.onmessage = (event: MessageEvent<unknown>) => {
      const value = event.data as { readonly type?: unknown; readonly reason?: unknown };
      if (value.type === 'created') {
        created = true;
        clearTimeout(timeout);
        resolve();
        return;
      }
      if (value.type === 'pull') {
        credits += 1;
        creditWaiters.shift()?.();
        return;
      }
      if (value.type === 'cancel') {
        wasCancelled = value.reason === 'DIRECT_DOWNLOAD_CANCELLED';
        abortController.abort(
          new DOMException(
            typeof value.reason === 'string' ? value.reason : 'Direct download cancelled',
            'AbortError'
          )
        );
        removeDownloadFrame();
        return;
      }
      if (value.type === 'finished') removeDownloadFrame(1_000);
    };
  });
  worker.postMessage(
    {
      type: 'direct-download.create',
      id,
      fileName,
      size
    },
    [channel.port2]
  );
  await createdPromise;

  function startDownload(): void {
    if (downloadStarted) return;
    downloadStarted = true;
    const frameName = `mar-direct-download-${id}`;
    const frame = document.createElement('iframe');
    frame.name = frameName;
    frame.style.display = 'none';
    document.body.append(frame);
    downloadFrame = frame;
    const anchor = document.createElement('a');
    anchor.href = `${DOWNLOAD_PATH}${id}`;
    anchor.target = frameName;
    anchor.style.display = 'none';
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
  }

  function removeDownloadFrame(delay = 0): void {
    const frame = downloadFrame;
    downloadFrame = undefined;
    if (frame !== undefined) setTimeout(() => frame.remove(), delay);
  }

  async function waitForCredit(): Promise<void> {
    if (credits > 0) {
      credits -= 1;
      return;
    }
    await new Promise<void>((resolve, reject) => {
      let waiter: () => void;
      const timeout = setTimeout(() => {
        const index = creditWaiters.indexOf(waiter);
        if (index >= 0) creditWaiters.splice(index, 1);
        const error = new Error('DIRECT_DOWNLOAD_BACKPRESSURE_TIMEOUT');
        abortController.abort(error);
        reject(error);
      }, BACKPRESSURE_TIMEOUT_MS);
      const onAbort = () => {
        const index = creditWaiters.indexOf(waiter);
        if (index >= 0) creditWaiters.splice(index, 1);
        clearTimeout(timeout);
        reject(abortController.signal.reason);
      };
      abortController.signal.addEventListener('abort', onAbort, { once: true });
      waiter = () => {
        clearTimeout(timeout);
        abortController.signal.removeEventListener('abort', onAbort);
        resolve();
      };
      creditWaiters.push(waiter);
    });
    credits -= 1;
  }

  return {
    signal: abortController.signal,
    started: () => downloadStarted,
    cancelled: () => wasCancelled,
    sink: {
      async write(bytes) {
        if (streamClosed || !created) throw new Error('DIRECT_DOWNLOAD_STREAM_CLOSED');
        startDownload();
        await waitForCredit();
        const buffer = bytes.buffer.slice(
          bytes.byteOffset,
          bytes.byteOffset + bytes.byteLength
        ) as ArrayBuffer;
        channel.port1.postMessage({ type: 'chunk', bytes: buffer }, [buffer]);
      },
      async close() {
        if (streamClosed) return;
        streamClosed = true;
        startDownload();
        channel.port1.postMessage({ type: 'close' });
      },
      async abort() {
        if (streamClosed) return;
        streamClosed = true;
        channel.port1.postMessage({ type: 'abort' });
        channel.port1.close();
        removeDownloadFrame();
      }
    }
  };
}

async function activeServiceWorker(): Promise<ServiceWorker | undefined> {
  if (!('serviceWorker' in navigator)) return undefined;
  const container = navigator.serviceWorker;
  if (container.controller !== null) return container.controller;
  await container.register('/service-worker.js', { scope: '/' }).catch(() => undefined);
  await container.ready.catch(() => undefined);
  if (container.controller !== null) return container.controller;
  return new Promise<ServiceWorker | undefined>((resolve) => {
    const timeout = setTimeout(() => {
      container.removeEventListener('controllerchange', changed);
      resolve(undefined);
    }, CONTROL_TIMEOUT_MS);
    const changed = () => {
      if (container.controller === null) return;
      clearTimeout(timeout);
      container.removeEventListener('controllerchange', changed);
      resolve(container.controller);
    };
    container.addEventListener('controllerchange', changed);
  });
}
