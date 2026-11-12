import {
  remoteDesktopRelayBrowserAttachSchema,
  remoteDesktopRelayNodeAttachSchema
} from '@myagentroam/protocol';
import { WebSocket, type RawData } from 'ws';
import type { RemoteDesktopRelayPairing } from './remote-desktop-relay-pairing.js';

interface BrowserIdentity {
  readonly userId: number;
  readonly sessionHash: string;
}

/** Authenticates a bounded first frame, then transfers socket ownership to the pairing owner. */
export class RemoteDesktopRelaySockets {
  readonly #pending = new Set<() => void>();
  #closed = false;

  constructor(
    private readonly options: {
      readonly pairing: Pick<RemoteDesktopRelayPairing, 'attachBrowser' | 'attachNode'>;
      /** The HTTP upgrade already validated Origin and the browser session. */
      readonly ownsPage: (identity: BrowserIdentity, connectionId: string) => boolean;
      readonly authenticateNode: (
        nodeId: string,
        credential: string
      ) => Promise<{ readonly id: string; readonly disabled: boolean } | undefined>;
      /** Must come from the currently authenticated control connection, not the relay frame. */
      readonly currentNodeGeneration: (nodeId: string) => string | undefined;
    }
  ) {}

  attachBrowser(socket: WebSocket, identity: BrowserIdentity): void {
    this.#accept(socket, async (raw, handoff) => {
      const parsed = remoteDesktopRelayBrowserAttachSchema.safeParse(raw);
      if (!parsed.success || !this.options.ownsPage(identity, parsed.data.workbenchConnectionId))
        return false;
      return handoff(() =>
        this.options.pairing.attachBrowser(
          parsed.data.attachmentId,
          parsed.data.ticket,
          { ...identity, workbenchConnectionId: parsed.data.workbenchConnectionId },
          socket
        )
      );
    });
  }

  attachNode(socket: WebSocket): void {
    this.#accept(socket, async (raw, handoff) => {
      const parsed = remoteDesktopRelayNodeAttachSchema.safeParse(raw);
      if (!parsed.success) return false;
      const { nodeId, nodeGeneration, attachmentId, ticket, credential } = parsed.data;
      if (this.options.currentNodeGeneration(nodeId) !== nodeGeneration) return false;
      const node = await this.options.authenticateNode(nodeId, credential);
      if (
        !node ||
        node.disabled ||
        node.id !== nodeId ||
        this.options.currentNodeGeneration(nodeId) !== nodeGeneration ||
        socket.readyState !== WebSocket.OPEN
      )
        return false;
      return handoff(() =>
        this.options.pairing.attachNode(attachmentId, ticket, nodeId, nodeGeneration, socket)
      );
    });
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const cancel of [...this.#pending]) cancel();
  }

  #accept(
    socket: WebSocket,
    authenticate: (frame: unknown, handoff: (attach: () => boolean) => boolean) => Promise<boolean>
  ): void {
    if (this.#closed || socket.readyState !== WebSocket.OPEN) {
      this.#terminate(socket);
      return;
    }
    let done = false;
    const cleanup = () => {
      clearTimeout(timer);
      this.#pending.delete(fail);
      socket.off('message', first);
      socket.off('message', unexpected);
      socket.off('close', fail);
      socket.off('error', fail);
    };
    const fail = () => {
      if (done) return;
      done = true;
      cleanup();
      this.#terminate(socket);
    };
    const unexpected = () => fail();
    const handoff = (attach: () => boolean): boolean => {
      if (done) return false;
      done = true;
      cleanup();
      try {
        if (attach()) return true;
      } catch {
        /* Deny without disclosing authentication details. */
      }
      this.#terminate(socket);
      return false;
    };
    const first = (data: RawData, binary: boolean) => {
      socket.off('message', first);
      socket.pause();
      socket.on('message', unexpected);
      const size = Array.isArray(data)
        ? data.reduce((sum, part) => sum + part.byteLength, 0)
        : data.byteLength;
      if (binary || size > 8192) return fail();
      let frame: unknown;
      try {
        frame = JSON.parse(
          (Array.isArray(data)
            ? Buffer.concat(data, size)
            : Buffer.from(data instanceof ArrayBuffer ? new Uint8Array(data) : data)
          ).toString('utf8')
        );
      } catch {
        return fail();
      }
      void authenticate(frame, handoff).then((accepted) => {
        if (done) return;
        if (!accepted) fail();
      }, fail);
    };
    const timer = setTimeout(fail, 5000);
    timer.unref();
    this.#pending.add(fail);
    socket.on('message', first);
    socket.on('close', fail);
    socket.on('error', fail);
  }

  #terminate(socket: WebSocket): void {
    if (socket.readyState === WebSocket.CLOSED) return;
    const ignoreError = () => {};
    socket.on('error', ignoreError);
    socket.once('close', () => socket.off('error', ignoreError));
    socket.terminate();
  }
}
