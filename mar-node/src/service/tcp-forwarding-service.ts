import type { Socket } from 'node:net';
import type { NodeStream } from '@myagentroam/protocol/node-stream';
import type { NodeStreamHandler, NodeStreamOpen } from '@myagentroam/protocol/node-stream-mux';
import {
  decodeTcpForward,
  tcpForwardAdmission,
  tcpForwardControlKind,
  tcpForwardDataAdmission,
  tcpForwardDataKind,
  tcpForwardMaxConnections,
  tcpForwardSetupMs,
  writeTcpForwardNotice
} from '@myagentroam/protocol/tcp-forward';
import {
  bridgeForwardSocket,
  connectForwardSocket,
  listenForwardSocket
} from '@myagentroam/marctl/src/tcp-forward-socket.mjs';

type Admission = ReturnType<typeof tcpForwardAdmission.parse>;

/** Owns Node TCP sockets. Only the authenticated Server Relay can supply admissions. */
export class TcpForwardingService {
  private readonly registrations = new Map<string, ForwardRegistration>();

  accept({ kind, grant }: NodeStreamOpen): NodeStreamHandler | undefined {
    if (kind === tcpForwardControlKind) {
      const input = decodeTcpForward(tcpForwardAdmission, grant);
      if (input !== undefined) return (stream, signal) => this.register(input, stream, signal);
    } else if (kind === tcpForwardDataKind) {
      const input = decodeTcpForward(tcpForwardDataAdmission, grant);
      const owner = input === undefined ? undefined : this.registrations.get(input.id);
      if (input !== undefined && owner !== undefined)
        return (stream, signal) => owner.connect(input.connection, stream, signal);
    }
    return undefined;
  }

  private async register(input: Admission, stream: NodeStream, signal: AbortSignal) {
    if (this.registrations.has(input.id)) {
      stream.reset('TCP_FORWARD_CONTROL_INVALID');
      return;
    }
    const owner = new ForwardRegistration(input, stream, signal);
    this.registrations.set(input.id, owner);
    try {
      await owner.run();
    } finally {
      this.registrations.delete(input.id);
    }
  }
}

class ForwardRegistration {
  private readonly pending = new Map<number, Socket>();
  private readonly scope = new AbortController();
  private readonly signal: AbortSignal;
  private connections = 0;
  private lastId = 0;
  private notices: Promise<void> = Promise.resolve();

  constructor(
    private readonly input: Admission,
    private readonly control: NodeStream,
    signal: AbortSignal
  ) {
    this.signal = AbortSignal.any([signal, this.scope.signal]);
  }

  async run() {
    try {
      if (this.input.direction === 'reverse') {
        const server = await listenForwardSocket(this.input, this.signal, (socket) =>
          this.acceptSocket(socket)
        );
        server.on('error', () => this.control.reset('TCP_FORWARD_LISTEN_FAILED'));
      }
      this.notices = this.control.write(writeTcpForwardNotice(0));
      await this.notices;
      for await (const _bytes of this.control) {
        this.control.reset('TCP_FORWARD_CONTROL_INVALID');
        return;
      }
      await this.control.endWrite();
    } catch {
      if (!this.signal.aborted) this.control.reset('TCP_FORWARD_LISTEN_FAILED');
    } finally {
      this.scope.abort();
    }
  }

  async connect(id: number, stream: NodeStream, signal: AbortSignal) {
    const lifetime = AbortSignal.any([this.signal, signal]);
    if (this.input.direction === 'reverse') {
      const socket = this.pending.get(id);
      if (socket === undefined || lifetime.aborted) {
        stream.reset('TCP_FORWARD_CONNECTION_UNAVAILABLE');
        return;
      }
      this.pending.delete(id);
      socket.setTimeout(0);
      await bridgeForwardSocket(socket, stream, lifetime);
      return;
    }
    if (id !== 0 || this.connections >= tcpForwardMaxConnections || lifetime.aborted) {
      stream.reset('TCP_FORWARD_CONNECTION_UNAVAILABLE');
      return;
    }
    this.connections++;
    try {
      const socket = await connectForwardSocket(this.input, lifetime);
      await bridgeForwardSocket(socket, stream, lifetime);
    } catch {
      stream.reset('TCP_FORWARD_TARGET_UNAVAILABLE');
    } finally {
      this.connections--;
    }
  }

  private acceptSocket(socket: Socket) {
    if (
      this.signal.aborted ||
      this.connections >= tcpForwardMaxConnections ||
      this.lastId === 0xffffffff
    ) {
      socket.destroy();
      return;
    }
    const id = ++this.lastId;
    this.pending.set(id, socket);
    this.connections++;
    const abort = () => socket.destroy();
    this.signal.addEventListener('abort', abort, { once: true });
    socket.setTimeout(tcpForwardSetupMs, abort);
    const notice = (this.notices = this.notices
      .then(async () => {
        if (this.pending.has(id)) await this.control.write(writeTcpForwardNotice(id));
      })
      .catch(() => this.scope.abort()));
    socket.once('close', () => {
      this.pending.delete(id);
      this.signal.removeEventListener('abort', abort);
      // Retain the slot until a queued announcement has also settled.
      void notice.then(() => this.connections--);
    });
  }
}
