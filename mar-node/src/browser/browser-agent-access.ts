import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser } from 'playwright';
import WebSocket, { WebSocketServer } from 'ws';
import { z } from 'zod';
import { browserCliRoot } from './browser-cli-scope.js';

export const browserAgentActionSchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('describe') }),
  z.strictObject({ action: z.literal('select'), tabId: z.string().uuid() })
]);
export type BrowserAgentAction = z.infer<typeof browserAgentActionSchema>;
export type BrowserAgentExecution = {
  cliScope: string;
  signal: AbortSignal;
  allowed: (signal: AbortSignal) => Promise<boolean>;
};

let registry: string | undefined;

function privateRegistry(): string {
  if (registry !== undefined) return registry;
  const path = mkdtempSync(join(tmpdir(), 'mar-pw-registry-'));
  // Playwright bind publishes a descriptor even for explicit endpoints.
  process.env.PWTEST_SERVER_REGISTRY = path;
  process.once('exit', () => {
    try {
      rmSync(path, { recursive: true, force: true });
    } catch {
      // The process can no longer serve these endpoints.
    }
  });
  registry = path;
  return path;
}

type Resource = { resourceId: string; endpointFile: string };
type Access = {
  ready: Promise<Resource>;
  stop: AbortController;
  closed: Promise<void>;
  connected: () => boolean;
};
type Binding = { endpoint: string; descriptor: Record<string, unknown> };

/** Publishes per-Execution connections to one native Playwright server. Revoking
 * a connection does not change the browser, its tabs, or other clients. */
export class BrowserAgentAccess {
  private binding: Promise<Binding> | undefined;
  private readonly resources = new Map<BrowserAgentExecution, Access>();
  private closed = false;

  constructor(
    private readonly browser: () => Browser | null,
    private readonly activity: () => boolean,
    private readonly failed: (error: unknown) => void
  ) {}

  hasClients(): boolean {
    return [...this.resources.values()].some((access) => access.connected());
  }

  async describe(execution: BrowserAgentExecution): Promise<Resource> {
    execution.signal.throwIfAborted();
    if (this.closed) throw new Error('BROWSER_SESSION_ENDED');
    const existing = this.resources.get(execution);
    if (existing && !existing.stop.signal.aborted) return existing.ready;
    if (existing) await existing.closed;
    execution.signal.throwIfAborted();
    if (this.closed) throw new Error('BROWSER_SESSION_ENDED');
    if (existing) return this.describe(execution);

    const stop = new AbortController();
    const abort = () => stop.abort();
    execution.signal.addEventListener('abort', abort, { once: true });
    const resourceId = randomUUID();
    const dir = join(browserCliRoot(execution.cliScope), `shared-${resourceId}`);
    const endpointFile = join(dir, 'endpoint');
    const secretPath = `/${randomUUID()}`;
    let server: WebSocketServer | undefined;
    const ready = (async () => {
      if (!(await execution.allowed(stop.signal))) throw new Error('BROWSER_USE_DISABLED');
      stop.signal.throwIfAborted();
      const upstream = await (this.binding ??= this.bind().catch((error: unknown) => {
        this.binding = undefined;
        throw error;
      }));
      stop.signal.throwIfAborted();
      const proxy = (server = new WebSocketServer({
        host: '127.0.0.1',
        port: 0,
        path: secretPath
      }));
      proxy.on('error', () => {
        stop.abort();
        this.failed(new Error('BROWSER_USE_ACCESS_FAILED'));
      });
      proxy.on('connection', (socket, request) => {
        if (stop.signal.aborted) return socket.terminate();
        // Keep the transport native; forward Playwright's handshake metadata.
        const headers = Object.fromEntries(
          Object.entries(request.headers).filter(
            ([name]) => name.startsWith('x-playwright-') || name === 'user-agent'
          )
        );
        const remote = new WebSocket(upstream.endpoint, { headers });
        const end = () => {
          socket.terminate();
          remote.terminate();
        };
        socket.on('error', end).on('close', end);
        remote.on('error', end).on('close', end);
        socket.pause();
        remote.once('open', () => socket.resume());
        let firstMessage = true;
        socket.on('message', (data, binary) => {
          // Exclude the handshake without decoding every subsequent command.
          const initializing = firstMessage && isInitialize(data.toString());
          firstMessage = false;
          if (!initializing && !this.activity()) return end();
          if (remote.readyState === WebSocket.OPEN) remote.send(data, { binary });
        });
        remote.on('message', (data, binary) => {
          if (socket.readyState === WebSocket.OPEN) socket.send(data, { binary });
        });
      });
      await once(proxy, 'listening', { signal: stop.signal });
      const address = proxy.address();
      if (!address || typeof address !== 'object') throw new Error('BROWSER_USE_ACCESS_FAILED');
      const endpoint = `ws://127.0.0.1:${address.port}${secretPath}`;
      const servers = join(dir, 'servers');
      await mkdir(dir, { mode: 0o700 });
      await mkdir(servers);
      await writeFile(
        join(servers, resourceId),
        JSON.stringify({
          ...upstream.descriptor,
          title: resourceId,
          endpoint
        })
      );
      await writeFile(endpointFile, endpoint, { mode: 0o600 });
      stop.signal.throwIfAborted();
      return { resourceId, endpointFile };
    })();
    const closed = (async () => {
      await once(stop.signal, 'abort');
      // Wait for publication to settle, then remove the descriptor. Terminate
      // clients synchronously once cancellation is observed.
      if (server) for (const socket of server.clients) socket.terminate();
      await ready.catch(() => undefined);
      const proxy = server;
      if (proxy) await new Promise<void>((resolve) => proxy.close(() => resolve()));
      await rm(dir, { recursive: true, force: true }).catch(() =>
        this.failed(new Error('BROWSER_USE_ACCESS_FAILED'))
      );
      execution.signal.removeEventListener('abort', abort);
      this.resources.delete(execution);
    })();
    this.resources.set(execution, {
      ready,
      stop,
      closed,
      connected: () => !stop.signal.aborted && !!server?.clients.size
    });
    void ready.catch(abort);
    void this.recheck(execution, stop);
    return ready;
  }

  async close(): Promise<void> {
    this.closed = true;
    await Promise.all(
      [...this.resources.values()].map(({ stop, closed }) => {
        stop.abort();
        return closed;
      })
    );
  }

  private async bind(): Promise<Binding> {
    const browser = this.browser();
    if (!browser) throw new Error('BROWSER_USE_ACCESS_FAILED');
    const directory = privateRegistry();
    const title = randomUUID();
    try {
      const { endpoint } = await browser.bind(title, { host: '127.0.0.1', port: 0 });
      for (const name of await readdir(directory)) {
        const path = join(directory, name);
        const contents = await readFile(path, 'utf8').catch(() => '');
        if (!contents.includes(JSON.stringify(title))) continue;
        const descriptor = JSON.parse(contents) as Record<string, unknown>;
        if (descriptor.title !== title || descriptor.endpoint !== endpoint) continue;
        // Playwright keeps registry entries for persistent profiles after their
        // browser closes. Its native endpoint does not need the registry entry.
        await rm(path, { force: true }).catch(() =>
          this.failed(new Error('BROWSER_USE_ACCESS_FAILED'))
        );
        return { endpoint, descriptor };
      }
      throw new Error('BROWSER_USE_ACCESS_FAILED');
    } catch (error) {
      // Playwright may have started listening before publishing the descriptor.
      // Release that listener so the next lookup can bind the same browser.
      await browser.unbind().catch(() => this.failed(new Error('BROWSER_USE_ACCESS_FAILED')));
      throw error;
    }
  }

  private async recheck(execution: BrowserAgentExecution, stop: AbortController): Promise<void> {
    const cancel = () => clearTimeout(timer);
    const timer = setTimeout(async () => {
      stop.signal.removeEventListener('abort', cancel);
      if (!(await execution.allowed(stop.signal).catch(() => false))) stop.abort();
      if (!stop.signal.aborted) void this.recheck(execution, stop);
    }, 3_000);
    timer.unref();
    stop.signal.addEventListener('abort', cancel, { once: true });
  }
}

function isInitialize(message: string): boolean {
  try {
    const call = JSON.parse(message) as { method?: string; guid?: string } | null;
    return call?.method === 'initialize' && call.guid === '';
  } catch {
    return false;
  }
}
