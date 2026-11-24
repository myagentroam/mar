import { BROWSER_CONTROL_MAX_BYTES, browserAttachmentOpenSchema } from '@myagentroam/protocol';
import { WebSocket } from 'ws';
import type {
  BrowserAttachmentCoordinator,
  BrowserAttachmentIdentity
} from './browser-attachment-coordinator.js';
import { BrowserRelayPair } from './browser-relay-pair.js';

type Pending = { socket: WebSocket; discard(): void };

/** Owns relay socket pairing only. An authenticated Node presents a lease ID;
 * an authenticated Workbench socket proves its grant on its first message.
 * The coordinator owns authorization and expiry; the pair owns forwarding. */
export class BrowserRelayService {
  private readonly pending = new Map<string, Pending>();
  private readonly pairs = new Map<string, BrowserRelayPair>();

  constructor(
    private readonly leases: Pick<
      BrowserAttachmentCoordinator,
      'relayBrowser' | 'relayNode' | 'release'
    >,
    private readonly failed: (error: unknown) => void
  ) {}

  node(id: string, nodeId: string, generation: string, socket: WebSocket): boolean {
    if (
      !this.leases.relayNode(id, nodeId, generation) ||
      this.pending.has(id) ||
      this.pairs.has(id) ||
      socket.readyState !== WebSocket.OPEN
    )
      return false;
    const discard = () => {
      this.pending.delete(id);
      socket.off('close', discard);
      socket.off('error', discard);
      socket.off('message', unexpected);
    };
    const unexpected = () => {
      discard();
      socket.terminate();
    };
    socket.once('close', discard);
    socket.once('error', unexpected);
    socket.once('message', unexpected);
    this.pending.set(id, { socket, discard });
    return true;
  }

  async browser(
    identity: BrowserAttachmentIdentity,
    socket: WebSocket,
    text: string
  ): Promise<boolean> {
    if (Buffer.byteLength(text) > BROWSER_CONTROL_MAX_BYTES) return false;
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      return false;
    }
    const open = browserAttachmentOpenSchema.safeParse(value);
    if (!open.success || !(await this.leases.relayBrowser(identity, open.data))) return false;
    const id = open.data.attachmentId;
    const waiting = this.pending.get(id);
    if (
      !waiting ||
      socket.readyState !== WebSocket.OPEN ||
      waiting.socket.readyState !== WebSocket.OPEN
    )
      return false;
    waiting.discard();
    const pair = new BrowserRelayPair(socket, waiting.socket, () => {
      this.pairs.delete(id);
      // Closing a socket also releases its authenticated attachment lease.
      void this.leases.release(identity, id).catch(this.failed);
    });
    this.pairs.set(id, pair);
    pair.start(text);
    return true;
  }

  close(id: string): void {
    const waiting = this.pending.get(id);
    if (waiting) {
      waiting.discard();
      waiting.socket.terminate();
    }
    this.pairs.get(id)?.close();
  }
}
