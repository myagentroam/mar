import { randomUUID } from 'node:crypto';
import type { AuditObserver } from './audit.js';
import type { RawData, WebSocket } from 'ws';
import { terminalDataFrameSchema, type TerminalDataFrame } from '@myagentroam/protocol';
import type { NodeRequestAuthorization, UserNodeAuthorization } from './node-access-contracts.js';
import { safeErrorCode } from './http-errors.js';

const TERMINAL_TICKET_TTL_MS = 30_000;
const MAX_TERMINAL_RELAYS_PER_USER = 10;
const MAX_TERMINAL_SOCKET_BUFFERED_BYTES = 1024 * 1024;
const TERMINAL_HEARTBEAT_INTERVAL_MS = 15_000;
const TERMINAL_HEARTBEAT_TIMEOUT_MS = 45_000;
const RETIRED_TICKET_TTL_MS = 60_000;
const MAX_RETIRED_TICKETS = 1_024;

interface TerminalTicketRecord {
  readonly ticket: string;
  readonly nodeId: string;
  readonly terminalId: string;
  readonly userSessionHash: string;
  readonly userId: number;
  readonly workspaceId?: string;
  readonly afterSequence: number;
  readonly readonly: boolean;
  readonly expiresAt: number;
  readonly timer: NodeJS.Timeout;
}

interface TerminalRelayRecord {
  readonly ticket: string;
  readonly nodeId: string;
  readonly terminalId: string;
  readonly afterSequence: number;
  readonly userSessionHash: string;
  readonly userId: number;
  readonly workspaceId?: string;
  readonly readonly: boolean;
  readonly browser: WebSocket;
  initialFrames: readonly TerminalDataFrame[];
  replayIndex: number;
  pendingFrames: { readonly frame: TerminalDataFrame; readonly bytes: number }[];
  pendingBytes: number;
  writing: boolean;
  flushImmediate: NodeJS.Immediate | undefined;
  attached: boolean;
}

interface DeferredTerminalAttach {
  readonly socket: WebSocket;
  readonly ticket: TerminalTicketRecord;
  readonly onMessage: (raw: RawData, isBinary: boolean) => void;
  readonly onClose: () => void;
}

interface TerminalAttachmentResponse {
  readonly attachmentId: string;
  readonly terminalId: string;
  readonly latestSequence: number;
  readonly frames: readonly TerminalDataFrame[];
}

export interface TerminalRelayOptions {
  readonly database: Partial<AuditObserver> & {
    authenticateNode(
      nodeId: string,
      credential: string
    ):
      | { readonly id: string; readonly disabled: boolean }
      | undefined
      | Promise<{ readonly id: string; readonly disabled: boolean } | undefined>;
  };
  readonly authorizeNodeRequest: NodeRequestAuthorization;
  readonly traffic?: {
    record(channel: 'terminal', direction: 'in' | 'out', bytes: number): void;
    backpressure(channel: 'terminal', bytes: number): void;
  };
  readonly requestNode: (
    nodeId: string,
    operation: string,
    data: unknown,
    user: UserNodeAuthorization
  ) => Promise<unknown>;
}

export class TerminalRelayService {
  private directCount?: (sessionHash: string) => number;
  private closed = false;
  private readonly authenticating = new WeakSet<WebSocket>();
  private readonly sockets = new Map<string, WebSocket>();
  private readonly tickets = new Map<string, TerminalTicketRecord>();
  private readonly authorizing = new Map<string, TerminalTicketRecord>();
  private readonly deferredAttaches = new Map<string, DeferredTerminalAttach>();
  private readonly relays = new Map<string, TerminalRelayRecord>();
  private readonly retiredTickets = new Map<
    string,
    { readonly nodeId: string; expiresAt: number }
  >();
  private readonly socketActivity = new Map<WebSocket, number>();
  private readonly heartbeatTimer: NodeJS.Timeout;

  constructor(private readonly options: TerminalRelayOptions) {
    this.heartbeatTimer = setInterval(
      () => this.heartbeatSockets(),
      TERMINAL_HEARTBEAT_INTERVAL_MS
    );
    this.heartbeatTimer.unref();
  }

  attachNode(socket: WebSocket): void {
    if (this.closed) {
      socket.close(1001, 'SERVER_SHUTDOWN');
      return;
    }
    let nodeId: string | undefined;
    this.trackSocket(socket);
    socket.on('message', (raw, isBinary) => {
      const serialized = raw.toString();
      this.options.traffic?.record('terminal', 'in', Buffer.byteLength(serialized));
      if (isBinary) {
        socket.close(4002, 'TERMINAL_MESSAGE_INVALID');
        return;
      }
      void this.handleNodeMessage(
        socket,
        serialized,
        () => nodeId,
        (value) => (nodeId = value)
      ).catch(() => socket.close(1011, 'TERMINAL_AUTHENTICATION_FAILED'));
    });
    socket.on('close', () => {
      this.socketActivity.delete(socket);
      if (nodeId !== undefined && this.sockets.get(nodeId) === socket) {
        this.sockets.delete(nodeId);
        this.closeNode(nodeId, false);
      }
    });
  }

  createTicket(input: {
    readonly nodeId: string;
    readonly terminalId: string;
    readonly user: UserNodeAuthorization;
    readonly workspaceId?: string;
    readonly afterSequence?: unknown;
    readonly readonly?: unknown;
  }): {
    readonly ticket: string;
    readonly nodeId: string;
    readonly terminalId: string;
    readonly expiresAt: number;
  } {
    if (
      !isIdentifier(input.nodeId) ||
      !isIdentifier(input.terminalId) ||
      !Number.isSafeInteger(input.user.userId) ||
      input.user.userId <= 0 ||
      input.user.sessionHash.length === 0
    )
      throw new Error('TERMINAL_TICKET_INVALID');
    const afterSequence = input.afterSequence ?? 0;
    if (!Number.isSafeInteger(afterSequence) || (afterSequence as number) < 0)
      throw new Error('TERMINAL_TICKET_INVALID');
    if (input.readonly !== undefined && typeof input.readonly !== 'boolean')
      throw new Error('TERMINAL_TICKET_INVALID');
    const ticket = randomUUID();
    const expiresAt = Date.now() + TERMINAL_TICKET_TTL_MS;
    const record: TerminalTicketRecord = {
      ticket,
      nodeId: input.nodeId,
      terminalId: input.terminalId,
      userSessionHash: input.user.sessionHash,
      userId: input.user.userId,
      ...(input.workspaceId === undefined ? {} : { workspaceId: input.workspaceId }),
      afterSequence: afterSequence as number,
      readonly: input.readonly === true,
      expiresAt,
      timer: setTimeout(() => this.expireTicket(ticket), TERMINAL_TICKET_TTL_MS)
    };
    record.timer.unref();
    this.tickets.set(ticket, record);
    return { ticket, nodeId: record.nodeId, terminalId: record.terminalId, expiresAt };
  }

  attachBrowser(socket: WebSocket, ticketValue: unknown, user: UserNodeAuthorization): void {
    const attach = browserAttachRequest(ticketValue);
    const ticket = attach === undefined ? undefined : this.tickets.get(attach.ticket);
    if (
      ticket === undefined ||
      ticket.expiresAt <= Date.now() ||
      ticket.userSessionHash !== user.sessionHash
    ) {
      socket.close(4008, 'TERMINAL_TICKET_INVALID');
      return;
    }
    if (
      this.userRelayCount(user.sessionHash) +
        this.userDeferredCount(user.sessionHash) +
        (this.directCount?.(user.sessionHash) ?? 0) >=
      MAX_TERMINAL_RELAYS_PER_USER
    ) {
      socket.close(4008, 'TERMINAL_RELAY_LIMIT_REACHED');
      return;
    }
    const terminalSocket = this.sockets.get(ticket.nodeId);
    if (terminalSocket === undefined || terminalSocket.readyState !== terminalSocket.OPEN) {
      socket.close(4008, 'NODE_OFFLINE');
      return;
    }
    if (attach?.deferred === true) {
      if (this.deferredAttaches.has(ticket.ticket)) {
        socket.close(4008, 'TERMINAL_TICKET_INVALID');
        return;
      }
      const onMessage = (raw: RawData, isBinary: boolean) => {
        if (isBinary) {
          socket.close(4002, 'TERMINAL_FRAME_INVALID');
          return;
        }
        let message: unknown;
        try {
          message = JSON.parse(raw.toString());
        } catch {
          socket.close(4002, 'TERMINAL_FRAME_INVALID');
          return;
        }
        if (
          !isRecord(message) ||
          message.type !== 'activate' ||
          message.terminalId !== ticket.terminalId ||
          Object.keys(message).some((key) => !['type', 'terminalId'].includes(key))
        ) {
          socket.close(4002, 'TERMINAL_FRAME_INVALID');
          return;
        }
        this.activateDeferredAttach(ticket.ticket, socket);
      };
      const onClose = () => {
        const pending = this.deferredAttaches.get(ticket.ticket);
        if (pending?.socket === socket) this.clearDeferredAttach(pending, true);
      };
      const pending: DeferredTerminalAttach = { socket, ticket, onMessage, onClose };
      this.deferredAttaches.set(ticket.ticket, pending);
      this.trackSocket(socket);
      socket.on('message', onMessage);
      socket.once('close', onClose);
      this.sendTerminal(socket, { type: 'ready', terminalId: ticket.terminalId });
      return;
    }
    this.tickets.delete(ticket.ticket);
    clearTimeout(ticket.timer);
    this.authorizing.set(ticket.ticket, ticket);
    void this.authorizeBrowser(socket, ticket);
  }

  closeSession(sessionHash: string): void {
    this.dropTickets((record) => record.userSessionHash === sessionHash);
    this.dropAuthorizing((record) => record.userSessionHash === sessionHash);
    for (const relay of [...this.relays.values()])
      if (relay.userSessionHash === sessionHash) this.closeRelay(relay, true);
  }

  closeUser(userId: number): void {
    this.dropTickets((record) => record.userId === userId);
    this.dropAuthorizing((record) => record.userId === userId);
    for (const relay of [...this.relays.values()])
      if (relay.userId === userId) this.closeRelay(relay, true);
  }

  closeTerminal(nodeId: string, terminalId: string): void {
    for (const pending of [...this.deferredAttaches.values()])
      if (pending.ticket.nodeId === nodeId && pending.ticket.terminalId === terminalId)
        this.clearDeferredAttach(pending, true, 'TERMINAL_CLOSED');
    for (const relay of [...this.relays.values()])
      if (relay.nodeId === nodeId && relay.terminalId === terminalId) this.closeRelay(relay, true);
  }

  setDirectCoordination(input: { readonly directCount: (sessionHash: string) => number }): void {
    this.directCount = input.directCount;
  }

  countSession(sessionHash: string): number {
    return this.userRelayCount(sessionHash) + this.userDeferredCount(sessionHash);
  }

  closeAllRelays(): void {
    this.dropTickets(() => true);
    this.dropAuthorizing(() => true);
    for (const relay of [...this.relays.values()]) this.closeRelay(relay, true);
  }

  async revalidateAuthorizations(): Promise<void> {
    const authorizationChecks = new Map<string, Promise<boolean>>();
    const allowed = (record: {
      readonly userId: number;
      readonly nodeId: string;
      readonly workspaceId?: string;
    }): Promise<boolean> => {
      const key = `${record.userId}\0${record.nodeId}\0${record.workspaceId ?? ''}`;
      const existing = authorizationChecks.get(key);
      if (existing !== undefined) return existing;
      const check = Promise.resolve()
        .then(() =>
          this.options.authorizeNodeRequest(
            record.userId,
            record.nodeId,
            'terminal.attach.authorize',
            {},
            record.workspaceId
          )
        )
        .catch(() => false);
      authorizationChecks.set(key, check);
      return check;
    };
    for (const record of [...this.tickets.values()])
      if (!(await allowed(record))) this.dropTickets((candidate) => candidate === record);
    for (const record of [...this.authorizing.values()])
      if (!(await allowed(record))) this.dropAuthorizing((candidate) => candidate === record);
    for (const relay of [...this.relays.values()])
      if (!(await allowed(relay))) this.closeRelay(relay, true, 'TERMINAL_AUTHORIZATION_REVOKED');
  }

  closeNode(nodeId: string, terminate: boolean): void {
    this.dropTickets((record) => record.nodeId === nodeId);
    this.dropAuthorizing((record) => record.nodeId === nodeId);
    for (const relay of [...this.relays.values()])
      if (relay.nodeId === nodeId) this.closeRelay(relay, terminate);
  }

  disconnectNode(nodeId: string): void {
    this.closeNode(nodeId, false);
    this.sockets.get(nodeId)?.close(1001, 'NODE_OFFLINE');
    this.sockets.delete(nodeId);
  }

  shutdownNode(nodeId: string, code: number, reason: string): void {
    this.closeNode(nodeId, true);
    const socket = this.sockets.get(nodeId);
    if (socket !== undefined) {
      this.sendTerminal(socket, { type: 'shutdown' });
      socket.close(code, reason);
    }
    this.sockets.delete(nodeId);
  }

  close(): void {
    this.closed = true;
    clearInterval(this.heartbeatTimer);
    this.closeAllRelays();
    for (const socket of this.sockets.values()) {
      this.sendTerminal(socket, { type: 'shutdown' });
      socket.close(1001, 'SERVER_SHUTDOWN');
    }
    for (const socket of this.socketActivity.keys())
      if (socket.readyState === socket.OPEN) socket.close(1001, 'SERVER_SHUTDOWN');
    this.sockets.clear();
    this.socketActivity.clear();
  }

  private async authorizeBrowser(browser: WebSocket, ticket: TerminalTicketRecord): Promise<void> {
    try {
      const response = await this.options.requestNode(
        ticket.nodeId,
        'terminal.attach.authorize',
        {
          terminalId: ticket.terminalId,
          afterSequence: ticket.afterSequence,
          readonly: ticket.readonly
        },
        {
          userId: ticket.userId,
          sessionHash: ticket.userSessionHash,
          ...(ticket.workspaceId === undefined ? {} : { workspaceId: ticket.workspaceId })
        }
      );
      const attachment = terminalAttachmentResponse(response);
      const terminalSocket = this.sockets.get(ticket.nodeId);
      const authorizationActive = this.authorizing.get(ticket.ticket) === ticket;
      this.authorizing.delete(ticket.ticket);
      if (
        !authorizationActive &&
        attachment !== undefined &&
        attachment.terminalId === ticket.terminalId &&
        terminalSocket !== undefined &&
        terminalSocket.readyState === terminalSocket.OPEN
      ) {
        this.retireTicket(ticket.ticket, ticket.nodeId);
        this.sendTerminal(terminalSocket, {
          type: 'attach',
          ticket: ticket.ticket,
          terminalId: ticket.terminalId,
          attachmentId: attachment.attachmentId,
          latestSequence: attachment.latestSequence
        });
        this.sendTerminal(terminalSocket, { type: 'detach', ticket: ticket.ticket });
        return;
      }
      if (
        !authorizationActive ||
        attachment === undefined ||
        attachment.terminalId !== ticket.terminalId ||
        terminalSocket === undefined ||
        terminalSocket.readyState !== terminalSocket.OPEN
      ) {
        if (browser.readyState === browser.OPEN)
          this.sendBrowser(browser, {
            type: 'error',
            terminalId: ticket.terminalId,
            code:
              terminalSocket === undefined || terminalSocket.readyState !== terminalSocket.OPEN
                ? 'NODE_OFFLINE'
                : 'TERMINAL_ATTACH_FAILED'
          });
        browser.close(4008, 'TERMINAL_ATTACH_FAILED');
        return;
      }
      if (browser.readyState !== browser.OPEN) {
        this.retireTicket(ticket.ticket, ticket.nodeId);
        this.sendTerminal(terminalSocket, {
          type: 'attach',
          ticket: ticket.ticket,
          terminalId: ticket.terminalId,
          attachmentId: attachment.attachmentId,
          latestSequence: attachment.latestSequence
        });
        this.sendTerminal(terminalSocket, { type: 'detach', ticket: ticket.ticket });
        return;
      }
      const relay: TerminalRelayRecord = {
        ticket: ticket.ticket,
        nodeId: ticket.nodeId,
        terminalId: ticket.terminalId,
        afterSequence: ticket.afterSequence,
        userSessionHash: ticket.userSessionHash,
        userId: ticket.userId,
        ...(ticket.workspaceId === undefined ? {} : { workspaceId: ticket.workspaceId }),
        readonly: ticket.readonly,
        browser,
        initialFrames: attachment.frames,
        replayIndex: 0,
        pendingFrames: [],
        pendingBytes: 0,
        writing: false,
        flushImmediate: undefined,
        attached: false
      };
      this.relays.set(ticket.ticket, relay);
      this.trackSocket(browser);
      browser.on('message', (raw, isBinary) => {
        const serialized = raw.toString();
        this.options.traffic?.record('terminal', 'in', Buffer.byteLength(serialized));
        if (isBinary) browser.close(4002, 'TERMINAL_FRAME_INVALID');
        else this.forwardBrowserFrame(relay, serialized);
      });
      browser.once('close', () => this.detachRelay(relay));
      this.sendTerminal(terminalSocket, {
        type: 'attach',
        ticket: ticket.ticket,
        terminalId: ticket.terminalId,
        attachmentId: attachment.attachmentId,
        latestSequence: attachment.latestSequence
      });
    } catch (error) {
      this.authorizing.delete(ticket.ticket);
      if (browser.readyState === browser.OPEN)
        this.sendBrowser(browser, {
          type: 'error',
          terminalId: ticket.terminalId,
          code: safeErrorCode(error, 'TERMINAL_ATTACH_FAILED')
        });
      browser.close(4008, 'TERMINAL_ATTACH_FAILED');
    }
  }

  private activateDeferredAttach(ticketValue: string, socket: WebSocket): void {
    const pending = this.deferredAttaches.get(ticketValue);
    if (pending === undefined || pending.socket !== socket) {
      socket.close(4008, 'TERMINAL_TICKET_INVALID');
      return;
    }
    const ticket = this.tickets.get(ticketValue);
    if (ticket !== pending.ticket || ticket.expiresAt <= Date.now()) {
      this.clearDeferredAttach(pending, true, 'TERMINAL_TICKET_INVALID');
      return;
    }
    this.clearDeferredAttach(pending, true);
    this.authorizing.set(ticket.ticket, ticket);
    void this.authorizeBrowser(socket, ticket);
  }

  private forwardBrowserFrame(relay: TerminalRelayRecord, raw: string): void {
    if (this.relays.get(relay.ticket) !== relay || !relay.attached) return;
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      relay.browser.close(4002, 'TERMINAL_FRAME_INVALID');
      return;
    }
    const frame = terminalDataFrameSchema.safeParse(value);
    if (
      !frame.success ||
      frame.data.terminalId !== relay.terminalId ||
      !['input', 'resize', 'close'].includes(frame.data.type)
    ) {
      relay.browser.close(4002, 'TERMINAL_FRAME_INVALID');
      return;
    }
    const socket = this.sockets.get(relay.nodeId);
    if (
      socket === undefined ||
      socket.readyState !== socket.OPEN ||
      socket.bufferedAmount > MAX_TERMINAL_SOCKET_BUFFERED_BYTES
    ) {
      if (socket !== undefined && socket.bufferedAmount > MAX_TERMINAL_SOCKET_BUFFERED_BYTES)
        this.options.traffic?.backpressure('terminal', socket.bufferedAmount);
      this.closeRelay(relay, false);
      return;
    }
    this.sendTerminal(socket, { type: 'frame', ticket: relay.ticket, frame: frame.data });
  }

  private async handleNodeMessage(
    socket: WebSocket,
    raw: string,
    getNodeId: () => string | undefined,
    setNodeId: (nodeId: string) => void
  ): Promise<void> {
    const connectedNodeId = getNodeId();
    if (this.closed || socket.readyState !== socket.OPEN) return;
    if (connectedNodeId !== undefined && this.sockets.get(connectedNodeId) !== socket) {
      socket.close(4001, 'NODE_UNAUTHENTICATED');
      return;
    }
    let message: unknown;
    try {
      message = JSON.parse(raw);
    } catch {
      socket.close(4002, 'TERMINAL_MESSAGE_INVALID');
      return;
    }
    if (!isRecord(message) || typeof message.type !== 'string') {
      socket.close(4002, 'TERMINAL_MESSAGE_INVALID');
      return;
    }
    if (getNodeId() === undefined) {
      if (
        message.type !== 'authenticate' ||
        !isIdentifier(message.nodeId) ||
        typeof message.credential !== 'string' ||
        message.credential.length === 0 ||
        Object.keys(message).some((key) => !['type', 'nodeId', 'credential'].includes(key))
      ) {
        socket.close(4001, 'NODE_UNAUTHENTICATED');
        return;
      }
      if (this.authenticating.has(socket)) {
        socket.close(4002, 'TERMINAL_ALREADY_AUTHENTICATING');
        return;
      }
      this.authenticating.add(socket);
      let node: Awaited<ReturnType<TerminalRelayOptions['database']['authenticateNode']>>;
      try {
        node = await this.options.database.authenticateNode(message.nodeId, message.credential);
      } finally {
        this.authenticating.delete(socket);
      }
      if (this.closed || socket.readyState !== socket.OPEN || !this.socketActivity.has(socket))
        return;
      if (node === undefined || node.disabled) {
        socket.close(4001, node?.disabled ? 'NODE_DISABLED' : 'NODE_UNAUTHENTICATED');
        return;
      }
      const previous = this.sockets.get(node.id);
      if (previous !== undefined && previous !== socket) {
        this.closeNode(node.id, false);
        previous.close(4000, 'TERMINAL_SOCKET_REPLACED');
      }
      this.sockets.set(node.id, socket);
      setNodeId(node.id);
      this.sendTerminal(socket, { type: 'authenticated', nodeId: node.id });
      return;
    }
    if (
      message.type === 'detach' &&
      typeof message.ticket === 'string' &&
      message.reason === 'TERMINAL_ATTACH_FAILED' &&
      Object.keys(message).every((key) => ['type', 'ticket', 'reason'].includes(key))
    ) {
      const relay = this.relays.get(message.ticket);
      const retired = this.retiredTickets.get(message.ticket);
      if (
        relay === undefined &&
        retired !== undefined &&
        retired.nodeId === getNodeId() &&
        retired.expiresAt > Date.now()
      )
        return;
      if (relay === undefined || relay.nodeId !== getNodeId()) {
        socket.close(4002, 'TERMINAL_MESSAGE_INVALID');
        return;
      }
      this.closeRelay(relay, false, message.reason);
      return;
    }
    if (
      message.type === 'attached' &&
      typeof message.ticket === 'string' &&
      isIdentifier(message.terminalId) &&
      Object.keys(message).every((key) => ['type', 'ticket', 'terminalId'].includes(key))
    ) {
      const relay = this.relays.get(message.ticket);
      const retired = this.retiredTickets.get(message.ticket);
      if (
        relay === undefined &&
        retired !== undefined &&
        retired.nodeId === getNodeId() &&
        retired.expiresAt > Date.now()
      )
        return;
      if (
        relay === undefined ||
        relay.nodeId !== getNodeId() ||
        relay.terminalId !== message.terminalId
      ) {
        socket.close(4002, 'TERMINAL_MESSAGE_INVALID');
        return;
      }
      if (relay.browser.readyState !== relay.browser.OPEN) {
        this.detachRelay(relay);
        return;
      }
      if (relay.attached) return;
      relay.attached = true;
      this.sendBrowser(relay.browser, {
        type: 'attach',
        terminalId: relay.terminalId,
        afterSequence: relay.afterSequence
      });
      this.flushBrowserFrames(relay);
      return;
    }
    if (
      message.type !== 'frame' ||
      typeof message.ticket !== 'string' ||
      Object.keys(message).some((key) => !['type', 'ticket', 'frame'].includes(key))
    ) {
      socket.close(4002, 'TERMINAL_MESSAGE_INVALID');
      return;
    }
    const parsed = terminalDataFrameSchema.safeParse(message.frame);
    const relay = this.relays.get(message.ticket);
    const retired = this.retiredTickets.get(message.ticket);
    if (
      parsed.success &&
      relay === undefined &&
      retired !== undefined &&
      retired.nodeId === getNodeId() &&
      retired.expiresAt > Date.now() &&
      ['output', 'exit', 'error'].includes(parsed.data.type)
    )
      return;
    if (
      !parsed.success ||
      relay === undefined ||
      relay.nodeId !== getNodeId() ||
      parsed.data.terminalId !== relay.terminalId ||
      !['output', 'exit', 'error'].includes(parsed.data.type)
    ) {
      socket.close(4002, 'TERMINAL_MESSAGE_INVALID');
      return;
    }
    const bytes = Buffer.byteLength(JSON.stringify(parsed.data));
    if (relay.pendingBytes + bytes > MAX_TERMINAL_SOCKET_BUFFERED_BYTES) {
      this.endBackpressuredRelay(relay, relay.pendingBytes + bytes);
      return;
    }
    relay.pendingFrames.push({ frame: parsed.data, bytes });
    relay.pendingBytes += bytes;
    this.flushBrowserFrames(relay);
  }

  private flushBrowserFrames(relay: TerminalRelayRecord): void {
    if (
      this.relays.get(relay.ticket) !== relay ||
      !relay.attached ||
      relay.writing ||
      relay.flushImmediate !== undefined
    )
      return;
    if (relay.browser.readyState !== relay.browser.OPEN) {
      this.detachRelay(relay);
      return;
    }
    const snapshot = relay.initialFrames[relay.replayIndex];
    const frame = snapshot ?? relay.pendingFrames[0]?.frame;
    if (frame === undefined) return;
    const bytes = Buffer.byteLength(JSON.stringify(frame));
    const buffered = relay.browser.bufferedAmount + bytes;
    if (buffered > MAX_TERMINAL_SOCKET_BUFFERED_BYTES) {
      this.endBackpressuredRelay(relay, buffered);
      return;
    }
    if (snapshot !== undefined) {
      if (++relay.replayIndex === relay.initialFrames.length) {
        relay.initialFrames = [];
        relay.replayIndex = 0;
      }
    } else relay.pendingBytes -= relay.pendingFrames.shift()!.bytes;
    relay.writing = true;
    this.sendTerminal(relay.browser, frame, (error) => {
      if (this.relays.get(relay.ticket) !== relay) return;
      relay.writing = false;
      if (error) {
        this.closeRelay(relay, false, 'TERMINAL_SEND_FAILED');
        return;
      }
      if (
        frame.type === 'exit' ||
        (frame.type === 'error' &&
          ['TERMINAL_BACKPRESSURE', 'TERMINAL_FRAME_REJECTED'].includes(frame.code))
      ) {
        this.closeRelay(
          relay,
          false,
          frame.type === 'exit' ? 'TERMINAL_RELAY_CLOSED' : 'TERMINAL_RELAY_FAILED'
        );
        return;
      }
      relay.flushImmediate = setImmediate(() => {
        relay.flushImmediate = undefined;
        this.flushBrowserFrames(relay);
      });
    });
  }

  private endBackpressuredRelay(relay: TerminalRelayRecord, bytes: number): void {
    this.options.traffic?.backpressure('terminal', bytes);
    const frame: TerminalDataFrame = {
      type: 'error',
      terminalId: relay.terminalId,
      code: 'TERMINAL_BACKPRESSURE'
    };
    if (
      relay.browser.bufferedAmount + Buffer.byteLength(JSON.stringify(frame)) <=
      MAX_TERMINAL_SOCKET_BUFFERED_BYTES
    )
      this.sendBrowser(relay.browser, frame);
    this.closeRelay(relay, false, 'TERMINAL_BACKPRESSURE');
  }

  private clearBrowserFrames(relay: TerminalRelayRecord): void {
    if (relay.flushImmediate !== undefined) clearImmediate(relay.flushImmediate);
    relay.flushImmediate = undefined;
    relay.initialFrames = [];
    relay.pendingFrames = [];
    relay.pendingBytes = 0;
  }

  private dropTickets(predicate: (record: TerminalTicketRecord) => boolean): void {
    for (const [ticket, record] of this.tickets)
      if (predicate(record)) {
        const pending = this.deferredAttaches.get(ticket);
        if (pending === undefined) {
          this.tickets.delete(ticket);
          clearTimeout(record.timer);
        } else this.clearDeferredAttach(pending, true, 'TERMINAL_CLOSED');
      }
  }
  private dropAuthorizing(predicate: (record: TerminalTicketRecord) => boolean): void {
    for (const [ticket, record] of this.authorizing)
      if (predicate(record)) this.authorizing.delete(ticket);
  }
  private expireTicket(ticket: string): void {
    const record = this.tickets.get(ticket);
    if (record !== undefined) {
      const pending = this.deferredAttaches.get(ticket);
      if (pending === undefined) {
        this.tickets.delete(ticket);
        clearTimeout(record.timer);
      } else this.clearDeferredAttach(pending, true, 'TERMINAL_TICKET_INVALID');
    }
  }

  private clearDeferredAttach(
    pending: DeferredTerminalAttach,
    dropTicket: boolean,
    closeReason?: string
  ): void {
    if (this.deferredAttaches.get(pending.ticket.ticket) !== pending) return;
    this.deferredAttaches.delete(pending.ticket.ticket);
    pending.socket.removeListener('message', pending.onMessage);
    pending.socket.removeListener('close', pending.onClose);
    this.socketActivity.delete(pending.socket);
    if (dropTicket && this.tickets.get(pending.ticket.ticket) === pending.ticket) {
      this.tickets.delete(pending.ticket.ticket);
      clearTimeout(pending.ticket.timer);
    }
    if (
      closeReason !== undefined &&
      (pending.socket.readyState === pending.socket.OPEN ||
        pending.socket.readyState === pending.socket.CLOSING)
    )
      pending.socket.close(4008, closeReason);
  }
  private detachRelay(relay: TerminalRelayRecord): void {
    if (this.relays.get(relay.ticket) !== relay) return;
    this.clearBrowserFrames(relay);
    this.relays.delete(relay.ticket);
    this.retireTicket(relay.ticket, relay.nodeId);
    this.socketActivity.delete(relay.browser);
    const socket = this.sockets.get(relay.nodeId);
    if (socket !== undefined && socket.readyState === socket.OPEN)
      this.sendTerminal(socket, { type: 'detach', ticket: relay.ticket });
  }
  private closeRelay(
    relay: TerminalRelayRecord,
    terminate: boolean,
    reason = terminate ? 'TERMINAL_CLOSED' : 'TERMINAL_RELAY_CLOSED'
  ): void {
    if (this.relays.get(relay.ticket) !== relay) return;
    this.clearBrowserFrames(relay);
    this.relays.delete(relay.ticket);
    this.retireTicket(relay.ticket, relay.nodeId);
    this.socketActivity.delete(relay.browser);
    const socket = this.sockets.get(relay.nodeId);
    if (socket !== undefined && socket.readyState === socket.OPEN)
      this.sendTerminal(
        socket,
        terminate
          ? { type: 'close', ticket: relay.ticket }
          : { type: 'detach', ticket: relay.ticket }
      );
    if (
      relay.browser.readyState === relay.browser.OPEN ||
      relay.browser.readyState === relay.browser.CLOSING
    )
      relay.browser.close(1000, reason);
  }
  private userRelayCount(sessionHash: string): number {
    return [...this.relays.values()].filter((relay) => relay.userSessionHash === sessionHash)
      .length;
  }
  private userDeferredCount(sessionHash: string): number {
    return [...this.deferredAttaches.values()].filter(
      (pending) => pending.ticket.userSessionHash === sessionHash
    ).length;
  }
  private sendTerminal(
    socket: WebSocket,
    message: object,
    completed?: (error?: Error | null) => void
  ): void {
    if (socket.readyState !== socket.OPEN) return;
    try {
      const serialized = JSON.stringify(message);
      this.options.traffic?.record('terminal', 'out', Buffer.byteLength(serialized));
      if (completed === undefined) socket.send(serialized);
      else socket.send(serialized, completed);
    } catch (error) {
      completed?.(error instanceof Error ? error : new Error('TERMINAL_SEND_FAILED'));
      socket.close(1011, 'TERMINAL_SEND_FAILED');
    }
  }
  private sendBrowser(socket: WebSocket, frame: TerminalDataFrame): void {
    this.sendTerminal(socket, frame);
  }

  private retireTicket(ticket: string, nodeId: string): void {
    const now = Date.now();
    for (const [candidate, record] of this.retiredTickets)
      if (record.expiresAt <= now) this.retiredTickets.delete(candidate);
    this.retiredTickets.delete(ticket);
    this.retiredTickets.set(ticket, { nodeId, expiresAt: now + RETIRED_TICKET_TTL_MS });
    while (this.retiredTickets.size > MAX_RETIRED_TICKETS) {
      const oldest = this.retiredTickets.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.retiredTickets.delete(oldest);
    }
  }

  private trackSocket(socket: WebSocket): void {
    this.socketActivity.set(socket, Date.now());
    socket.on('pong', () => this.socketActivity.set(socket, Date.now()));
    socket.once('close', () => this.socketActivity.delete(socket));
  }

  private heartbeatSockets(): void {
    const now = Date.now();
    for (const [socket, lastActivity] of this.socketActivity) {
      if (socket.readyState !== socket.OPEN) {
        this.socketActivity.delete(socket);
        continue;
      }
      if (now - lastActivity >= TERMINAL_HEARTBEAT_TIMEOUT_MS) {
        socket.terminate();
        continue;
      }
      try {
        socket.ping();
      } catch {
        socket.terminate();
      }
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function isIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 128;
}
function browserAttachRequest(
  value: unknown
): { readonly ticket: string; readonly deferred: boolean } | undefined {
  if (typeof value === 'string') return { ticket: value, deferred: false };
  if (
    !isRecord(value) ||
    value.deferred !== true ||
    !isIdentifier(value.ticket) ||
    Object.keys(value).some((key) => !['ticket', 'deferred'].includes(key))
  )
    return undefined;
  return { ticket: value.ticket, deferred: true };
}
function terminalAttachmentResponse(value: unknown): TerminalAttachmentResponse | undefined {
  if (!isRecord(value) || !isRecord(value.attachment)) return undefined;
  const attachment = value.attachment;
  if (
    !isIdentifier(attachment.attachmentId) ||
    !isIdentifier(attachment.terminalId) ||
    !Number.isSafeInteger(attachment.latestSequence) ||
    (attachment.latestSequence as number) < 0 ||
    !Array.isArray(attachment.frames)
  )
    return undefined;
  const frames: TerminalDataFrame[] = [];
  for (const frame of attachment.frames) {
    const parsed = terminalDataFrameSchema.safeParse(frame);
    if (!parsed.success || parsed.data.terminalId !== attachment.terminalId) return undefined;
    frames.push(parsed.data);
  }
  return {
    attachmentId: attachment.attachmentId,
    terminalId: attachment.terminalId,
    latestSequence: attachment.latestSequence as number,
    frames
  };
}
