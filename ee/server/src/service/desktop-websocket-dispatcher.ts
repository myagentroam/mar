import type { IncomingMessage } from 'node:http';
import { WebSocketServer } from 'ws';

/** Routes marked desktop upgrades through a bounded server without adding an upgrade listener. */
export class DesktopWebSocketDispatcher {
  readonly #marked = new WeakSet<IncomingMessage>();
  readonly #desktop = new WebSocketServer({
    noServer: true,
    maxPayload: 16_384,
    perMessageDeflate: false
  });
  readonly #original: WebSocketServer['handleUpgrade'];
  readonly #dispatch: WebSocketServer['handleUpgrade'];
  #closed = false;

  constructor(private readonly shared: WebSocketServer) {
    this.#original = shared.handleUpgrade;
    this.#dispatch = (request, socket, head, callback) => {
      if (this.#marked.has(request)) this.#desktop.handleUpgrade(request, socket, head, callback);
      else this.#original.call(this.shared, request, socket, head, callback);
    };
    shared.handleUpgrade = this.#dispatch;
  }

  mark(request: IncomingMessage): void {
    if (this.#closed) throw new Error('Desktop WebSocket dispatcher is closed.');
    this.#marked.add(request);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    if (this.shared.handleUpgrade === this.#dispatch) this.shared.handleUpgrade = this.#original;
    for (const client of this.#desktop.clients) client.terminate();
    await new Promise<void>((resolve, reject) =>
      this.#desktop.close((error) => (error ? reject(error) : resolve()))
    );
  }
}
