import { BROWSER_CONTROL_MAX_BYTES, BROWSER_FRAME_MESSAGE_BYTES } from '@myagentroam/protocol';
import { WebSocket, type RawData } from 'ws';

const MAX_PENDING = 128 * 1024;

/** Transfers bounded frames between the two authenticated sockets for one
 * attachment. Callers own admission, leases and finding the matching peer.
 * No decoding, commands, browser state or other sockets are owned here.
 */
export class BrowserRelayPair {
  private pendingToBrowser = 0;
  private pendingToNode = 0;
  private closed = false;

  constructor(
    private readonly browser: WebSocket,
    private readonly node: WebSocket,
    private readonly onClosed: () => void
  ) {
    browser.on('message', this.fromBrowser);
    node.on('message', this.fromNode);
    for (const socket of [browser, node]) {
      socket.on('close', this.close);
      socket.on('error', this.close);
    }
  }

  start(open: string): void {
    this.forward('pendingToNode', this.node, Buffer.from(open), false);
  }

  readonly close = (): void => {
    if (this.closed) return;
    this.closed = true;
    this.browser.off('message', this.fromBrowser);
    this.node.off('message', this.fromNode);
    for (const socket of [this.browser, this.node]) {
      socket.off('close', this.close);
      // The same idempotent handler can absorb errors during socket shutdown.
      socket.terminate();
    }
    this.onClosed();
  };

  private readonly fromBrowser = (data: RawData, binary: boolean) =>
    this.forward('pendingToNode', this.node, data, binary);
  private readonly fromNode = (data: RawData, binary: boolean) =>
    this.forward('pendingToBrowser', this.browser, data, binary);

  private forward(
    meter: 'pendingToBrowser' | 'pendingToNode',
    to: WebSocket,
    data: RawData,
    binary: boolean
  ): void {
    if (this.closed) return;
    const bytes = Array.isArray(data)
      ? data.reduce((sum, part) => sum + part.byteLength, 0)
      : data.byteLength;
    const charge = Math.max(bytes, 256);
    if (
      (binary && meter === 'pendingToNode') ||
      bytes > (binary ? BROWSER_FRAME_MESSAGE_BYTES : BROWSER_CONTROL_MAX_BYTES) ||
      this[meter] + charge > MAX_PENDING ||
      to.readyState !== WebSocket.OPEN
    ) {
      this.close();
      return;
    }
    this[meter] += charge;
    try {
      to.send(data, { binary }, (error) => {
        this[meter] -= charge;
        if (error) this.close();
      });
    } catch {
      this.close();
    }
  }
}
