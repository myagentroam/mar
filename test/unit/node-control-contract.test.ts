import { testNodeBrokerServices } from '../support/node-broker-services.js';
import { describe, expect, it, vi } from 'vitest';
import {
  NODE_PROTOCOL_VERSION,
  createEnvelope,
  workbenchNodeOperationSchema
} from '../../packages/protocol/src/index.js';
import { ServerDatabase } from '../../ee/server/src/database.js';
import type { AuditEvent as AuditInput } from '../../packages/server-core/src/audit.js';
import { createTestNodeControl } from '../support/create-test-node-control.js';
import { createTestNodeMessageProjector } from '../../packages/server-core/test/unit/support/node-message-projector.js';
import { NodeRequestBroker } from '../../ee/server/src/service/node-request-broker.js';
import { TerminalRelayService } from '../../packages/server-core/src/terminal-relay-service.js';
import { WorkbenchRelayService } from '../../packages/server-core/src/workbench-relay-service.js';
import { DirectTransferCoordinator } from '../../packages/server-core/src/direct-transfer-coordinator.js';
import { TerminalDirectCoordinator } from '../../packages/server-core/src/terminal-direct-coordinator.js';
import { publicNode } from '../../ee/server/src/util/http-request.js';
import {
  LARGE_TRAFFIC_FRAME_BYTES,
  ServerTrafficMetrics
} from '../../ee/server/src/service/server-traffic-metrics.js';

import { registerOwnedNode } from './support/node-control-fixture.js';

describe('Node controlled relay contract', () => {
  it('releases constructed relay and identity timers if composition fails', () => {
    vi.useFakeTimers();
    const failure = new Error('RELAY_ASSEMBLY_FAILED');
    const setup = vi.spyOn(WorkbenchRelayService.prototype, 'setTerminalDirectHandler');
    setup.mockImplementationOnce(() => {
      throw failure;
    });
    try {
      expect(() =>
        createTestNodeControl({} as Parameters<typeof createTestNodeControl>[0], async () => true)
      ).toThrow(failure);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      setup.mockRestore();
      vi.useRealTimers();
    }
  });
  it('preserves assembly and cleanup failures while closing remaining owners', () => {
    vi.useFakeTimers();
    const failure = new Error('RELAY_ASSEMBLY_FAILED');
    const cleanupFailure = new Error('DIRECT_CLOSE_FAILED');
    const setup = vi.spyOn(WorkbenchRelayService.prototype, 'setTerminalDirectHandler');
    setup.mockImplementationOnce(() => {
      throw failure;
    });
    const originalClose = DirectTransferCoordinator.prototype.close;
    const close = vi.spyOn(DirectTransferCoordinator.prototype, 'close');
    close.mockImplementationOnce(function (this: DirectTransferCoordinator) {
      // Release the timer before injecting the cleanup failure.
      originalClose.call(this);
      throw cleanupFailure;
    });
    try {
      let error: unknown;
      try {
        createTestNodeControl({} as Parameters<typeof createTestNodeControl>[0], async () => true);
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(AggregateError);
      expect((error as AggregateError).errors).toEqual([failure, cleanupFailure]);
      expect((error as AggregateError).cause).toBe(failure);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      setup.mockRestore();
      close.mockRestore();
      vi.useRealTimers();
    }
  });
  it('Server rejects retired reconcile messages through the existing authenticated unknown-message path', async () => {
    const database = new ServerDatabase(':memory:');
    const runtimeCredentials = {
      activateNodeConnection: vi.fn(),
      deactivateNodeConnection: vi.fn(),
      resolve: vi.fn()
    };
    const control = createTestNodeControl(
      database,
      (userId, nodeId) => database.userOwnsNode(userId, nodeId),
      undefined,
      undefined,
      runtimeCredentials
    );
    const registered = database.registerNode(
      database.createNodeRegistrationToken(database.getAdmin().id).token,
      { metadata: '{}' }
    )!;
    const sent: Array<{ type: string; payload: unknown; replyTo?: string }> = [];
    const socket = {
      readyState: 1,
      OPEN: 1,
      send: (raw: string) => sent.push(JSON.parse(raw)),
      close: vi.fn()
    };
    const internal = control as unknown as {
      handleMessage(
        socket: unknown,
        raw: string,
        setNodeId: (id: string) => void,
        getNodeId: () => string | undefined
      ): Promise<void>;
    };
    let nodeId: string | undefined;
    const receive = async (type: string, payload: unknown) => {
      const envelope = createEnvelope(type, payload);
      await internal.handleMessage(
        socket,
        JSON.stringify(envelope),
        (id) => {
          nodeId = id;
        },
        () => nodeId
      );
      return envelope.id;
    };
    try {
      await receive('authenticate', {
        nodeId: registered.nodeId,
        credential: registered.credential
      });
      expect(control.isNodeConnected(registered.nodeId)).toBe(true);
      await receive('capabilities', {
        platform: 'linux',
        architecture: 'x64',
        nodeAppVersion: '0.11.38',
        nodeVersion: 'v24',
        codex: { available: false },
        claudeCode: { available: false }
      });
      const before = await control.listNodes();
      for (const [type, payload] of [
        ['runs.reconcile', { runIds: ['active-run', 'unknown-run'] }],
        ['lease.reconcile', { runId: 'active-run', known: false }],
        ['lease.reconcile', { runId: 'unknown-run', known: true }],
        ['lease.reconcile', {}],
        ['unknown.control.message', {}]
      ] as const) {
        const id = await receive(type, payload);
        expect(sent.filter((message) => message.replyTo === id)).toMatchObject([
          { type: 'error', payload: { code: 'MESSAGE_TYPE_UNKNOWN' } }
        ]);
        expect(await control.listNodes()).toEqual(before);
      }
      const heartbeatId = await receive('heartbeat', {});
      expect(sent.filter((message) => message.replyTo === heartbeatId)).toMatchObject([
        { type: 'ack', payload: { type: 'heartbeat' } }
      ]);
      expect(control.isNodeConnected(registered.nodeId)).toBe(true);
      const relay = vi.spyOn(TerminalRelayService.prototype, 'disconnectNode');
      const direct = vi.spyOn(DirectTransferCoordinator.prototype, 'revokeNode');
      const terminalDirect = vi.spyOn(TerminalDirectCoordinator.prototype, 'revokeNode');
      const pending = control.requestNode(
        registered.nodeId,
        'workspace.list',
        {},
        { userId: database.getAdmin().id, sessionHash: 'fixture' }
      );
      const rejected = expect(pending).rejects.toThrow('NODE_UPGRADE_REQUIRED');
      await vi.waitFor(() =>
        expect(sent.some((message) => message.type === 'node.request')).toBe(true)
      );
      await receive('capabilities', {
        platform: 'linux',
        architecture: 'x64',
        nodeAppVersion: '0.11.36',
        nodeVersion: 'v24',
        codex: { available: false },
        claudeCode: { available: false },
        marAgentRuntimeCredentials: { apiVersion: 1, websocket: true, httpVersions: ['1.1'] }
      });
      expect(control.isNodeUpgradeOnly(registered.nodeId)).toBe(true);
      expect(control.runtimeCredentialCapability(registered.nodeId)).toBeUndefined();
      expect(relay).toHaveBeenCalledWith(registered.nodeId);
      expect(direct).toHaveBeenCalledWith(registered.nodeId, 'DIRECT_NODE_OFFLINE');
      expect(terminalDirect).toHaveBeenCalledWith(registered.nodeId, 'NODE_OFFLINE');
      expect(runtimeCredentials.deactivateNodeConnection).toHaveBeenCalledWith(registered.nodeId);
      await rejected;
    } finally {
      control.close();
      database.close();
    }
  });

  it.each(['start', 'status', 'ack', 'cancel'])(
    'ChatGPT login %s uses authorized internal relay only and is not a public Workbench operation',
    async (action) => {
      const operation = `chatgpt.login.${action}`;
      expect(workbenchNodeOperationSchema.safeParse(operation).success).toBe(false);
      const database = {
        audit: vi.fn(async () => undefined),
        userCanRequestNode: vi.fn(async () => true)
      };
      const sent: Array<{ id: string; payload: unknown }> = [];
      const socket = {
        readyState: 1,
        OPEN: 1,
        send(raw: string) {
          sent.push(JSON.parse(raw));
        }
      };
      const broker = new NodeRequestBroker(
        database as never,
        database.userCanRequestNode,
        () => socket as never,
        { allows: () => true, encode: (_socket, envelope) => envelope },
        testNodeBrokerServices()
      );
      try {
        const pending = broker.request(
          'node-a',
          operation,
          { attemptId: 'login-1' },
          { userId: 7, sessionHash: 'session-hash' }
        );
        await vi.waitFor(() => expect(sent).toHaveLength(1));
        broker.resolve(
          'node-a',
          createEnvelope(
            'node.response',
            { result: { status: 'PENDING' } },
            { replyTo: sent[0]!.id }
          )
        );
        await expect(pending).resolves.toEqual({ status: 'PENDING' });
        database.userCanRequestNode.mockResolvedValueOnce(false);
        await expect(
          broker.request('node-a', operation, {}, { userId: 7, sessionHash: 'session-hash' })
        ).rejects.toThrow('NODE_ACCESS_DENIED');
        expect(sent).toHaveLength(1);
      } finally {
        broker.close();
      }
    }
  );

  it('Server targets Session Watch realtime frames and records delivery failures', async () => {
    const log = vi.fn();
    const sendWatchEvent = vi.fn(async () => 'delivered' as const);
    const sendInvalid = vi.fn();
    const projector = createTestNodeMessageProjector({
      relay: {} as never,
      send: vi.fn(),
      sendInvalid,
      sendWatchEvent,
      log
    });
    const socket = {} as never;

    projector.project(
      'node-watch-log',
      socket,
      createEnvelope('watch.event', {
        type: 'watch.failed',
        workbenchConnectionId: 'connection-watch-log',
        watchType: 'session',
        watchId: 'session-watch-log',
        nodeGeneration: 'generation-watch-log',
        nodeId: 'node-watch-log',
        workspaceId: 'workspace-watch-log',
        sessionId: 'session-watch-log',
        code: 'NATIVE_TRANSCRIPT_UNAVAILABLE',
        message: 'Session watch snapshot failed.'
      })
    );
    expect(sendInvalid).not.toHaveBeenCalled();

    await vi.waitFor(() =>
      expect(log).toHaveBeenCalledWith('workbench.watch.failed.relayed', {
        nodeId: 'node-watch-log',
        workspaceId: 'workspace-watch-log',
        sessionId: 'session-watch-log',
        workbenchConnectionId: 'connection-watch-log',
        watchId: 'session-watch-log',
        watchType: 'session',
        code: 'NATIVE_TRANSCRIPT_UNAVAILABLE',
        delivery: 'delivered'
      })
    );

    sendWatchEvent.mockClear();
    projector.project(
      'node-watch-log',
      socket,
      createEnvelope('watch.event', {
        type: 'watch.session.event',
        workbenchConnectionId: 'connection-watch-log',
        watchId: 'session-watch-log',
        nodeGeneration: 'generation-watch-log',
        nodeId: 'node-watch-log',
        workspaceId: 'workspace-watch-log',
        sessionId: 'session-watch-log',
        expiresAt: Date.now() + 45_000,
        event: { sequence: 7, category: 'run', payload: { run: { id: 'run-watch-log' } } }
      })
    );
    expect(sendInvalid).not.toHaveBeenCalled();
    await vi.waitFor(() =>
      expect(sendWatchEvent).toHaveBeenCalledWith(
        'connection-watch-log',
        expect.objectContaining({ type: 'watch.session.event', sessionId: 'session-watch-log' })
      )
    );
  });

  it('Server retains per-second traffic and aggregates channels and backpressure every ten seconds', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-26T03:00:00.000Z'));
    const log = vi.fn();
    const metrics = new ServerTrafficMetrics(log);
    metrics.record('node', 'in', 128);
    metrics.record('workbench', 'out', LARGE_TRAFFIC_FRAME_BYTES);
    metrics.backpressure('workbench', 2 * 1024 * 1024);
    vi.advanceTimersByTime(10_000);

    const snapshot = metrics.snapshot();
    expect(snapshot.samples).toHaveLength(10);
    expect(snapshot.samples[0]).toMatchObject({
      inBytes: 128,
      outBytes: LARGE_TRAFFIC_FRAME_BYTES,
      largeFrames: 1,
      backpressureEvents: 1,
      maxBufferedBytes: 2 * 1024 * 1024
    });
    expect(log).toHaveBeenCalledWith('server.traffic.large-frame', {
      channel: 'workbench',
      direction: 'out',
      bytes: LARGE_TRAFFIC_FRAME_BYTES
    });
    expect(log).toHaveBeenCalledWith('server.traffic.backpressure', {
      channel: 'workbench',
      bufferedBytes: 2 * 1024 * 1024
    });
    expect(log).toHaveBeenCalledWith(
      'server.traffic.summary',
      expect.objectContaining({
        intervalSeconds: 10,
        inBytes: 128,
        outBytes: LARGE_TRAFFIC_FRAME_BYTES,
        largeFrames: 1,
        backpressureEvents: 1
      })
    );
    vi.advanceTimersByTime(51_000);
    expect(metrics.snapshot().samples).toHaveLength(60);
    metrics.close();
    vi.useRealTimers();
  });

  it('A new control connection for the same Node closes the old connection and stays online', async () => {
    const database = new ServerDatabase(':memory:');
    const control = createTestNodeControl(database, (userId, nodeId) =>
      database.userOwnsNode(userId, nodeId)
    );
    const broadcast = vi.spyOn(
      (control as unknown as { workbenchRelay: { broadcast(message: object): void } })
        .workbenchRelay,
      'broadcast'
    );
    const newSocket = {
      readyState: 1,
      OPEN: 1,
      send: vi.fn(),
      close: vi.fn()
    };
    const registered = database.registerNode(
      database.createNodeRegistrationToken(database.getAdmin().id).token,
      { metadata: '{}' }
    );
    expect(registered).toBeDefined();
    const authenticatedNodeId = await (
      control as unknown as {
        authenticate(socket: typeof newSocket, envelope: unknown): Promise<string | undefined>;
      }
    ).authenticate(
      newSocket,
      createEnvelope('authenticate', {
        nodeId: registered!.nodeId,
        credential: registered!.credential
      })
    );
    expect(authenticatedNodeId).toBe(registered!.nodeId);

    const actualOldClose = vi.fn();
    (control as unknown as { sockets: Map<string, typeof newSocket> }).sockets.set(
      registered!.nodeId,
      { ...newSocket, close: actualOldClose }
    );
    const replacement = { ...newSocket, send: vi.fn(), close: vi.fn() };
    await (
      control as unknown as {
        authenticate(socket: typeof replacement, envelope: unknown): Promise<string | undefined>;
      }
    ).authenticate(
      replacement,
      createEnvelope('authenticate', {
        nodeId: registered!.nodeId,
        credential: registered!.credential
      })
    );
    expect(actualOldClose).toHaveBeenCalledWith(4000, 'NODE_CONNECTION_REPLACED');
    expect(broadcast).toHaveBeenCalledWith({
      type: 'node',
      nodeId: registered!.nodeId,
      connected: true,
      reason: 'CONNECTION_REPLACED'
    });
    expect(broadcast).toHaveBeenCalledTimes(2);
    expect(
      (control as unknown as { sockets: Map<string, unknown> }).sockets.get(registered!.nodeId)
    ).toBe(replacement);
    control.close();
    database.close();
  });

  it('Only the current control connection determines Node online state without database persistence', async () => {
    const database = new ServerDatabase(':memory:');
    const control = createTestNodeControl(database, (userId, nodeId) =>
      database.userOwnsNode(userId, nodeId)
    );
    const registered = database.registerNode(
      database.createNodeRegistrationToken(database.getAdmin().id).token,
      { metadata: '{}' }
    );
    if (registered === undefined) throw new Error('NODE_FIXTURE_REGISTRATION_FAILED');
    const nodeId = registered.nodeId;

    await expect(control.listNodes()).resolves.toEqual([
      expect.objectContaining({ id: nodeId, connected: false })
    ]);
    expect(control.isNodeConnected(nodeId)).toBe(false);

    const socket = { readyState: 1, OPEN: 1, send: vi.fn(), close: vi.fn(), terminate: vi.fn() };
    await (
      control as unknown as {
        authenticate(candidate: typeof socket, envelope: unknown): Promise<string | undefined>;
      }
    ).authenticate(
      socket,
      createEnvelope('authenticate', {
        nodeId,
        credential: registered.credential
      })
    );
    expect(control.isNodeConnected(nodeId)).toBe(true);
    await expect(control.listNodes()).resolves.toEqual([
      expect.objectContaining({ id: nodeId, connected: true })
    ]);

    control.close();
    database.close();
  });

  it('Missing heartbeats terminate half-open control connections after 45 seconds', async () => {
    vi.useFakeTimers();
    const database = new ServerDatabase(':memory:');
    const control = createTestNodeControl(database, (userId, nodeId) =>
      database.userOwnsNode(userId, nodeId)
    );
    const registered = database.registerNode(
      database.createNodeRegistrationToken(database.getAdmin().id).token,
      { metadata: '{}' }
    );
    if (registered === undefined) throw new Error('NODE_FIXTURE_REGISTRATION_FAILED');
    const nodeId = registered.nodeId;
    const credential = registered.credential;

    const socket = { readyState: 1, OPEN: 1, send: vi.fn(), close: vi.fn(), terminate: vi.fn() };
    const authenticatedNodeId = await (
      control as unknown as {
        authenticate(candidate: typeof socket, envelope: unknown): Promise<string | undefined>;
      }
    ).authenticate(socket, createEnvelope('authenticate', { nodeId, credential }));
    expect(authenticatedNodeId).toBe(nodeId);
    expect(control.isNodeConnected(nodeId)).toBe(true);

    // 44s without heartbeat: sweep keeps the connection alive.
    await vi.advanceTimersByTimeAsync(44_000);
    expect(socket.terminate).not.toHaveBeenCalled();
    expect(control.isNodeConnected(nodeId)).toBe(true);

    // Beyond the 45s timeout, the next sweep terminates the half-open socket.
    await vi.advanceTimersByTimeAsync(16_000);
    expect(socket.terminate).toHaveBeenCalledTimes(1);

    control.close();
    database.close();
    vi.useRealTimers();
  });

  it('Server accepts only the current Node protocol version', async () => {
    const database = new ServerDatabase(':memory:');
    const control = createTestNodeControl(database, (userId, nodeId) =>
      database.userOwnsNode(userId, nodeId)
    );
    const sent: unknown[] = [];
    const socket = {
      readyState: 1,
      OPEN: 1,
      send(raw: string) {
        sent.push(JSON.parse(raw));
      }
    };
    (
      control as unknown as {
        handleMessage(
          socket: { readonly readyState: number; readonly OPEN: number; send(raw: string): void },
          raw: string,
          setNodeId: (nodeId: string) => void,
          getNodeId: () => string | undefined
        ): Promise<void>;
      }
    ).handleMessage(
      socket,
      JSON.stringify({
        version: NODE_PROTOCOL_VERSION + 1,
        id: 'legacy',
        type: 'register',
        payload: {}
      }),
      () => undefined,
      () => undefined
    );
    await vi.waitFor(() =>
      expect(sent).toContainEqual(
        expect.objectContaining({
          type: 'error',
          payload: expect.objectContaining({
            code: 'PROTOCOL_VERSION_UNSUPPORTED',
            message: 'Protocol version is unsupported.'
          })
        })
      )
    );
    database.close();
  });

  it('Server persists and projects Node-reported MAR Agent, dynamic credential, and conversation-hosting capabilities', async () => {
    const database = new ServerDatabase(':memory:');
    const control = createTestNodeControl(database, (userId, nodeId) =>
      database.userOwnsNode(userId, nodeId)
    );
    const registration = database.createNodeRegistrationToken(database.getAdmin().id);
    const socket = { readyState: 1, OPEN: 1, send: vi.fn(), close: vi.fn() };

    let nodeId: string | undefined;
    await (
      control as unknown as {
        handleMessage(
          socket: unknown,
          raw: string,
          setId: (id: string) => void,
          getId: () => string | undefined
        ): Promise<void>;
      }
    ).handleMessage(
      socket,
      JSON.stringify(
        createEnvelope('register', {
          registrationToken: registration.token,
          capabilities: {
            platform: 'linux',
            architecture: 'x64',
            nodeAppVersion: '0.11.38',
            nodeVersion: 'v24.15.0',
            codex: { available: true },
            claudeCode: { available: true },
            openCode: { available: true },
            marAgent: { available: true, version: '0.9.16' },
            marAgentRuntimeCredentials: {
              apiVersion: 1,
              websocket: true,
              httpVersions: ['1.1', '2']
            },
            conversationHosting: {
              state: 'AVAILABLE',
              apiVersion: 1,
              sandboxBackend: 'BUBBLEWRAP',
              sandboxPolicyVersion: 1,
              acceptsNewConversations: true,
              supportsExistingConversations: true,
              capacity: 'AVAILABLE'
            }
          }
        })
      ),
      (id) => {
        nodeId = id;
      },
      () => nodeId
    );

    expect(nodeId).toBeDefined();
    expect(JSON.parse(database.listNodes()[0]!.metadata)).toMatchObject({
      marAgent: { available: true, version: '0.9.16' },
      marAgentRuntimeCredentials: {
        apiVersion: 1,
        websocket: true,
        httpVersions: ['1.1', '2']
      },
      conversationHosting: {
        state: 'AVAILABLE',
        acceptsNewConversations: true,
        supportsExistingConversations: true
      }
    });
    const [node] = await control.listNodes();
    expect(node).toBeDefined();
    expect(publicNode(node!)).toMatchObject({
      capabilities: {
        marAgent: { available: true, version: '0.9.16' },
        marAgentRuntimeCredentials: {
          apiVersion: 1,
          websocket: true,
          httpVersions: ['1.1', '2']
        },
        conversationHosting: {
          state: 'AVAILABLE',
          acceptsNewConversations: true,
          supportsExistingConversations: true
        }
      }
    });
    control.close();
    database.close();
  });

  it('Server rejects operations outside the allowlist before sending', async () => {
    const database = new ServerDatabase(':memory:');
    const control = createTestNodeControl(database, (userId, nodeId) =>
      database.userOwnsNode(userId, nodeId)
    );
    await expect(
      control.requestNode('node-a', 'shell.execute', {}, { userId: 1, sessionHash: 'a'.repeat(43) })
    ).rejects.toThrow('OPERATION_UNSUPPORTED');
    database.close();
  });

  it('Node relay preserves bounded error details and correlated upstream request IDs', async () => {
    const database = {
      audit: vi.fn(async () => undefined),
      userCanRequestNode: vi.fn(async () => true)
    };
    const sent: Array<{ id: string; payload: unknown }> = [];
    const socket = {
      readyState: 1,
      OPEN: 1,
      send(raw: string) {
        sent.push(JSON.parse(raw) as { id: string; payload: unknown });
      }
    };
    const broker = new NodeRequestBroker(
      database as never,
      database.userCanRequestNode,
      () => socket as never,
      { allows: () => true, encode: (_socket, envelope) => envelope },
      testNodeBrokerServices()
    );

    const pending = broker.request(
      'node-a',
      'workspace.list',
      {},
      { userId: 7, sessionHash: 'session-hash' }
    );
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    broker.resolve(
      'node-a',
      createEnvelope(
        'node.response',
        {
          error: 'INTERNAL_ERROR',
          message: 'An internal error occurred.',
          details: 'Git exited with status 128 while reading repository references.'
        },
        { replyTo: sent[0]!.id }
      )
    );

    await expect(pending).rejects.toMatchObject({
      message: 'INTERNAL_ERROR',
      publicMessage: 'An internal error occurred.',
      publicDetails: 'Git exited with status 128 while reading repository references.',
      upstreamRequestId: sent[0]!.id
    });
    broker.close();
  });

  it('Dedicated hosted relay does not require a Node grant while ordinary Node operations still do', async () => {
    const database = {
      audit: vi.fn(async () => undefined),
      userCanRequestNode: vi.fn(async () => false)
    };
    const sent: Array<{ id: string; payload: unknown }> = [];
    const socket = {
      readyState: 1,
      OPEN: 1,
      send(raw: string) {
        sent.push(JSON.parse(raw) as { id: string; payload: unknown });
      }
    };
    const broker = new NodeRequestBroker(
      database as never,
      database.userCanRequestNode,
      () => socket as never,
      { allows: () => true, encode: (_socket, envelope) => envelope },
      testNodeBrokerServices()
    );
    const user = { userId: 7, sessionHash: 'session-hash' };

    const hosted = broker.requestHostedConversation(
      'node-hosted',
      'conversation.hosted.get',
      { conversationId: 'conversation-1' },
      user
    );
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    broker.resolve(
      'node-hosted',
      createEnvelope(
        'node.response',
        { result: { conversation: { id: 'conversation-1' } } },
        { replyTo: sent[0]!.id }
      )
    );

    await expect(hosted).resolves.toEqual({ conversation: { id: 'conversation-1' } });
    expect(database.userCanRequestNode).not.toHaveBeenCalled();
    const history = broker.requestHostedConversation(
      'node-hosted',
      'conversation.hosted.history',
      { conversationId: 'conversation-1', limit: 10 },
      user
    );
    await vi.waitFor(() => expect(sent).toHaveLength(2));
    broker.resolve(
      'node-hosted',
      createEnvelope(
        'node.response',
        { result: { turns: [], nextCursor: null } },
        { replyTo: sent[1]!.id }
      )
    );
    await expect(history).resolves.toEqual({ turns: [], nextCursor: null });
    await expect(broker.request('node-hosted', 'workspace.list', {}, user)).rejects.toThrow(
      'NODE_ACCESS_DENIED'
    );
    expect(database.userCanRequestNode).toHaveBeenCalledWith(
      7,
      'node-hosted',
      'workspace.list',
      {},
      undefined
    );
    await expect(
      broker.requestHostedConversation('node-hosted', 'workspace.list', {}, user)
    ).rejects.toThrow('OPERATION_UNSUPPORTED');
    broker.close();
  });

  it('Targeted Hosted Watch uses template authorization without falling back to Node grants', async () => {
    const database = {
      userCanRequestNode: vi.fn(async () => false)
    };
    const authorizeHostedConversation = vi
      .fn()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    const relay = new WorkbenchRelayService({
      authorizeNodeRequest: database.userCanRequestNode,
      authorizeHostedConversation
    } as never);
    const sent: Array<Record<string, unknown>> = [];
    const handlers = new Map<string, (value: string, isBinary?: boolean) => void>();
    const browser = {
      readyState: 1,
      OPEN: 1,
      bufferedAmount: 0,
      send(raw: string) {
        sent.push(JSON.parse(raw) as Record<string, unknown>);
      },
      close: vi.fn(),
      on(event: string, handler: (value: string, isBinary?: boolean) => void) {
        handlers.set(event, handler);
      }
    };
    relay.attach(browser as never, { userId: 7, sessionHash: 'session-hash' });
    handlers.get('message')?.(JSON.stringify({ type: 'resume' }), false);
    await vi.waitFor(() =>
      expect(sent).toContainEqual(expect.objectContaining({ type: 'workbench.ready' }))
    );
    const connectionId = String(
      sent.find((message) => message['type'] === 'workbench.ready')?.['workbenchConnectionId']
    );
    const message = {
      type: 'watch.event',
      event: {
        type: 'watch.hosted-conversation.event',
        workbenchConnectionId: connectionId,
        watchId: 'watch-hosted-1',
        nodeGeneration: 'generation-hosted',
        nodeId: 'node-hosted',
        templateId: 'template-1',
        conversationId: 'conversation-1',
        expiresAt: Date.now() + 45_000,
        event: {
          sequence: 1,
          category: 'hosted-conversation',
          payload: { conversationId: 'conversation-1', kind: 'run' }
        }
      }
    };

    await expect(relay.sendConnection(connectionId, message)).resolves.toBe('delivered');
    await expect(relay.sendConnection(connectionId, message)).resolves.toBe(
      'authorization-revoked'
    );
    expect(authorizeHostedConversation).toHaveBeenNthCalledWith(1, 7, 'node-hosted', 'template-1');
    expect(database.userCanRequestNode).not.toHaveBeenCalled();
    relay.close();
  });

  it('uses the supplied Node request policy even when the user owns the Node', async () => {
    const database = new ServerDatabase(':memory:');
    const nodeId = registerOwnedNode(database);
    const authorize = vi.fn(async () => false);
    const control = createTestNodeControl(database, authorize);
    try {
      expect(database.userOwnsNode(1, nodeId)).toBe(true);
      await expect(
        control.requestNode(nodeId, 'workspace.list', {}, { userId: 1, sessionHash: 'session' })
      ).rejects.toThrow('NODE_ACCESS_DENIED');
      expect(authorize).toHaveBeenCalledWith(1, nodeId, 'workspace.list', {}, undefined);
    } finally {
      control.close();
      database.close();
    }
  });

  it('Synchronous Node request send failures immediately remove correlation records', async () => {
    vi.useFakeTimers();
    const database = new ServerDatabase(':memory:');
    const nodeId = registerOwnedNode(database);
    const socket = {
      readyState: 1,
      OPEN: 1,
      send() {
        throw new Error('SOCKET_SEND_FAILED');
      }
    };
    const broker = new NodeRequestBroker(
      database,
      (userId, nodeId) => database.userOwnsNode(userId, nodeId),
      () => socket as never,
      { allows: () => true, encode: (_socket, envelope) => envelope },
      testNodeBrokerServices()
    );
    await expect(
      broker.request(nodeId, 'workspace.list', {}, { userId: 1, sessionHash: 'a'.repeat(43) })
    ).rejects.toThrow('SOCKET_SEND_FAILED');
    await vi.advanceTimersByTimeAsync(15_000);
    broker.close();
    vi.useRealTimers();
    database.close();
  });

  it('Server measures slow Node relay round trips with a monotonic clock, independent of remote clocks', async () => {
    vi.useFakeTimers();
    const log = vi.fn();
    const database = {
      userCanRequestNode: vi.fn(async () => true)
    };
    const sent: Array<{ id: string }> = [];
    const socket = {
      readyState: 1,
      OPEN: 1,
      send(raw: string) {
        sent.push(JSON.parse(raw) as { id: string });
      }
    };
    const broker = new NodeRequestBroker(
      database as never,
      database.userCanRequestNode,
      () => socket as never,
      { allows: () => true, encode: (_socket, envelope) => envelope },
      testNodeBrokerServices(),
      log
    );
    const pending = broker.request(
      'node-a',
      'session.list',
      { workspaceId: 'workspace-a' },
      { userId: 2, sessionHash: 'session', workspaceId: 'workspace-a' }
    );
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    await vi.advanceTimersByTimeAsync(300);
    broker.resolve(
      'node-a',
      createEnvelope('node.response', { result: {} }, { replyTo: sent[0]!.id })
    );
    await pending;

    expect(log).toHaveBeenCalledWith('node.relay.request.completed', {
      nodeId: 'node-a',
      operation: 'session.list',
      requestId: sent[0]!.id,
      durationMs: expect.any(Number)
    });
    expect((log.mock.calls[0]?.[1] as { durationMs: number }).durationMs).toBeGreaterThanOrEqual(
      300
    );
    broker.close();
    vi.useRealTimers();
  });

  it('Workspace authorization context carries from list results into subsequent Session requests', async () => {
    const authorizationContexts: Array<string | undefined> = [];
    const database = {
      userCanRequestNode: vi.fn(
        async (
          _userId: number,
          _nodeId: string,
          _operation: string,
          _data: unknown,
          workspaceId?: string
        ) => {
          authorizationContexts.push(workspaceId);
          return workspaceId === 'workspace-a';
        }
      )
    };
    const sent: Array<{ id: string }> = [];
    const socket = {
      readyState: 1,
      OPEN: 1,
      send(raw: string) {
        sent.push(JSON.parse(raw) as { id: string });
      }
    };
    const broker = new NodeRequestBroker(
      database as never,
      database.userCanRequestNode,
      () => socket as never,
      { allows: () => true, encode: (_socket, envelope) => envelope },
      testNodeBrokerServices()
    );
    const user = { userId: 2, sessionHash: 'session', workspaceId: 'workspace-a' };
    const list = broker.request('node-a', 'session.list', { workspaceId: 'workspace-a' }, user);
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    broker.resolve(
      'node-a',
      createEnvelope(
        'node.response',
        {
          result: { sessions: [{ id: 'session-a', workspaceId: 'workspace-a', runner: 'codex' }] }
        },
        { replyTo: sent[0]!.id }
      )
    );
    await list;

    const get = broker.request(
      'node-a',
      'session.get',
      { sessionId: 'session-a' },
      { userId: 2, sessionHash: 'session' }
    );
    await vi.waitFor(() => expect(sent).toHaveLength(2));
    broker.resolve(
      'node-a',
      createEnvelope('node.response', { result: {} }, { replyTo: sent[1]!.id })
    );
    await get;
    expect(authorizationContexts).toEqual(['workspace-a', 'workspace-a']);
    broker.close();
  });

  it('Session messages are excluded from generic relay audit content', async () => {
    const audit = vi.fn(async () => undefined);
    const database = {
      audit,
      userCanRequestNode: vi.fn(async () => true)
    };
    const sent: Array<{ id: string }> = [];
    const socket = {
      readyState: 1,
      OPEN: 1,
      send(raw: string) {
        sent.push(JSON.parse(raw) as { id: string });
      }
    };
    const broker = new NodeRequestBroker(
      database as never,
      database.userCanRequestNode,
      () => socket as never,
      { allows: () => true, encode: (_socket, envelope) => envelope },
      testNodeBrokerServices()
    );
    const pending = broker.request(
      'node-a',
      'session.message',
      {
        workspaceId: 'workspace-a',
        sessionId: 'session-a',
        clientMessageId: 'message-a',
        message: '不得写入审计的正文'
      },
      { userId: 2, sessionHash: 'session' }
    );
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    broker.resolve(
      'node-a',
      createEnvelope('node.response', { result: { accepted: true } }, { replyTo: sent[0]!.id })
    );
    await pending;

    expect(audit).not.toHaveBeenCalled();
    broker.close();
  });

  it.each(['workspace.file.write', 'workspace.files.mutate'])(
    'Organization relay writes use stable business event types and operation metadata: %s',
    async (operation) => {
      const audit = vi.fn<(input: AuditInput) => Promise<void>>(async () => undefined);
      const database = {
        audit,
        userCanRequestNode: vi.fn(async () => true)
      };
      const sent: Array<{ id: string }> = [];
      const socket = {
        readyState: 1,
        OPEN: 1,
        send(raw: string) {
          sent.push(JSON.parse(raw) as { id: string });
        }
      };
      const broker = new NodeRequestBroker(
        database as never,
        database.userCanRequestNode,
        () => socket as never,
        { allows: () => true, encode: (_socket, envelope) => envelope },
        testNodeBrokerServices()
      );
      const pending = broker.request(
        'node-a',
        operation,
        {
          workspaceId: 'workspace-a',
          path: '/private/not-an-audit-action',
          action: 'DELETE',
          content: '不得写入审计的文件正文'
        },
        { userId: 2, sessionHash: 'session', workspaceId: 'workspace-a' }
      );
      await vi.waitFor(() => expect(sent).toHaveLength(1));
      broker.resolve(
        'node-a',
        createEnvelope('node.response', { result: { accepted: true } }, { replyTo: sent[0]!.id })
      );
      await pending;

      await vi.waitFor(() => expect(audit).toHaveBeenCalledTimes(1));
      const event = audit.mock.calls[0]![0];
      expect(event.eventType).toBe(operation);
      expect(JSON.parse(event.metadata!)).toMatchObject({ action: operation });
      if (operation === 'workspace.files.mutate')
        expect(JSON.parse(event.metadata!)).toMatchObject({ mutation: 'DELETE' });
      expect(event.metadata).not.toContain('POST /api/');
      expect(JSON.stringify(audit.mock.calls)).not.toContain('不得写入审计的文件正文');
      broker.close();
    }
  );

  it('keeps Node-returned session names for later Run audits without auditing reads', async () => {
    const audit = vi.fn<(input: AuditInput) => Promise<void>>(async () => undefined);
    const sent: Array<{ id: string }> = [];
    const socket = {
      readyState: 1,
      OPEN: 1,
      send: (raw: string) => sent.push(JSON.parse(raw) as { id: string })
    };
    const broker = new NodeRequestBroker(
      { audit } as never,
      async () => true,
      () => socket as never,
      { allows: () => true, encode: (_socket, envelope) => envelope },
      testNodeBrokerServices()
    );
    const user = { userId: 2, sessionHash: 'session', workspaceId: 'workspace-a' };
    const read = broker.request('node-a', 'session.get', { sessionId: 'session-a' }, user);
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    broker.resolve(
      'node-a',
      createEnvelope(
        'node.response',
        {
          result: {
            session: {
              id: 'session-a',
              runner: 'codex',
              customTitle: 'Historical session',
              workspaceId: 'workspace-a'
            }
          }
        },
        { replyTo: sent[0]!.id }
      )
    );
    await read;
    expect(audit).not.toHaveBeenCalled();
    const run = broker.request('node-a', 'run.get', { runId: 'run-a' }, user);
    await vi.waitFor(() => expect(sent).toHaveLength(2));
    broker.resolve(
      'node-a',
      createEnvelope(
        'node.response',
        { result: { run: { id: 'run-a', sessionId: 'session-a', workspaceId: 'workspace-a' } } },
        { replyTo: sent[1]!.id }
      )
    );
    await run;
    expect(audit).not.toHaveBeenCalled();
    const content = broker.request(
      'node-a',
      'session.events.read',
      { sessionId: 'session-a' },
      user
    );
    await vi.waitFor(() => expect(sent).toHaveLength(3));
    broker.resolve(
      'node-a',
      createEnvelope(
        'node.response',
        {
          result: {
            events: [
              {
                input: {
                  sessionId: 'session-a',
                  conversationTitle: 'Tool body must not become a title',
                  runId: 'run-a'
                }
              }
            ]
          }
        },
        { replyTo: sent[2]!.id }
      )
    );
    await content;
    expect(audit).not.toHaveBeenCalled();
    const interrupt = broker.request(
      'node-a',
      'run.interrupt',
      { runId: 'run-a', customTitle: 'Untrusted request title' },
      user
    );
    await vi.waitFor(() => expect(sent).toHaveLength(4));
    broker.resolve(
      'node-a',
      createEnvelope('node.response', { result: { accepted: true } }, { replyTo: sent[3]!.id })
    );
    await interrupt;
    await vi.waitFor(() => expect(audit).toHaveBeenCalledOnce());
    expect(audit.mock.calls[0]?.[0]).toMatchObject({
      targetType: 'RUN',
      targetId: 'run-a',
      agentSessionId: 'session-a',
      workspaceId: 'workspace-a'
    });
    expect(JSON.parse(String(audit.mock.calls[0]?.[0]?.metadata))).toMatchObject({
      sessionName: 'Historical session'
    });
    expect(JSON.stringify(audit.mock.calls)).not.toContain('Untrusted request title');
    broker.close();
  });

  it('does not let relay audit failures change the underlying Node result', async () => {
    const audit = vi.fn<(input: AuditInput) => Promise<void>>(async () => {
      throw new Error('AUDIT_UNAVAILABLE');
    });
    const database = {
      audit,
      userCanRequestNode: vi.fn(async () => true)
    };
    const sent: Array<{ id: string }> = [];
    const socket = {
      readyState: 1,
      OPEN: 1,
      send(raw: string) {
        sent.push(JSON.parse(raw) as { id: string });
      }
    };
    const broker = new NodeRequestBroker(
      database as never,
      database.userCanRequestNode,
      () => socket as never,
      { allows: () => true, encode: (_socket, envelope) => envelope },
      testNodeBrokerServices()
    );
    const pending = broker.request(
      'node-a',
      'run.cancel',
      { workspaceId: 'workspace-a', runId: 'run-a' },
      { userId: 2, sessionHash: 'session', workspaceId: 'workspace-a' }
    );
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    broker.resolve(
      'node-a',
      createEnvelope(
        'node.response',
        { error: 'NODE_ACCESS_DENIED', message: 'Node denied the run control.' },
        { replyTo: sent[0]!.id }
      )
    );

    await expect(pending).rejects.toMatchObject({ message: 'NODE_ACCESS_DENIED' });
    await vi.waitFor(() => expect(audit).toHaveBeenCalledTimes(1));
    expect(audit.mock.calls[0]?.[0]).toMatchObject({
      eventType: 'run.cancel',
      result: 'DENIED',
      errorCode: 'NODE_ACCESS_DENIED'
    });
    expect(JSON.parse(String(audit.mock.calls[0]?.[0]?.metadata))).toMatchObject({
      action: 'run.cancel'
    });
    broker.close();
  });

  it('Closing the user session releases Node terminal attachments without establishing Browser relay', async () => {
    const database = new ServerDatabase(':memory:');
    let resolveAuthorization!: (value: unknown) => void;
    const relay = new TerminalRelayService({
      database,
      authorizeNodeRequest: (userId, nodeId) => database.userOwnsNode(userId, nodeId),
      requestNode: () =>
        new Promise((resolve) => {
          resolveAuthorization = resolve;
        })
    });
    const terminalSent: unknown[] = [];
    const terminalClosed: string[] = [];
    const terminal = {
      readyState: 1,
      OPEN: 1,
      send(raw: string) {
        terminalSent.push(JSON.parse(raw));
      },
      close(_code: number, reason: string) {
        terminalClosed.push(reason);
      }
    };
    (relay as unknown as { sockets: Map<string, typeof terminal> }).sockets.set('node-a', terminal);
    const browserClosed: string[] = [];
    const browser = {
      readyState: 1,
      OPEN: 1,
      CLOSING: 2,
      bufferedAmount: 0,
      send() {},
      close(_code: number, reason: string) {
        browserClosed.push(reason);
      },
      on() {},
      once() {}
    };
    const user = { userId: 1, sessionHash: 'a'.repeat(43) };
    const ticket = relay.createTicket({ nodeId: 'node-a', terminalId: 'terminal-a', user });
    relay.attachBrowser(browser as never, ticket.ticket, user);
    relay.closeSession(user.sessionHash);
    resolveAuthorization({
      attachment: {
        attachmentId: 'attachment-a',
        terminalId: 'terminal-a',
        latestSequence: 7,
        frames: []
      }
    });
    await vi.waitFor(() =>
      expect(terminalSent).toEqual([
        {
          type: 'attach',
          ticket: ticket.ticket,
          terminalId: 'terminal-a',
          attachmentId: 'attachment-a',
          latestSequence: 7
        },
        { type: 'detach', ticket: ticket.ticket }
      ])
    );
    expect(browserClosed).toEqual([]);
    expect((relay as unknown as { relays: Map<string, unknown> }).relays.size).toBe(0);
    const handleNodeMessage = (
      relay as unknown as {
        handleNodeMessage(
          socket: typeof terminal,
          raw: string,
          getNodeId: () => string | undefined,
          setNodeId: (nodeId: string) => void
        ): Promise<void>;
      }
    ).handleNodeMessage.bind(relay);
    await handleNodeMessage(
      terminal,
      JSON.stringify({
        type: 'detach',
        ticket: ticket.ticket,
        reason: 'TERMINAL_ATTACH_FAILED'
      }),
      () => 'node-a',
      () => undefined
    );
    const detachedBrowser = {
      ...browser,
      close(_code: number, reason: string) {
        browserClosed.push(reason);
      }
    };
    (
      relay as unknown as {
        relays: Map<
          string,
          {
            ticket: string;
            nodeId: string;
            terminalId: string;
            userSessionHash: string;
            userId: number;
            readonly: boolean;
            browser: typeof detachedBrowser;
          }
        >;
      }
    ).relays.set('active-ticket', {
      ticket: 'active-ticket',
      nodeId: 'node-a',
      terminalId: 'terminal-a',
      userSessionHash: user.sessionHash,
      userId: user.userId,
      readonly: false,
      browser: detachedBrowser
    });
    await handleNodeMessage(
      terminal,
      JSON.stringify({
        type: 'detach',
        ticket: 'active-ticket',
        reason: 'TERMINAL_ATTACH_FAILED'
      }),
      () => 'node-a',
      () => undefined
    );
    expect(browserClosed).toEqual(['TERMINAL_ATTACH_FAILED']);
    expect(terminalSent.at(-1)).toEqual({ type: 'detach', ticket: 'active-ticket' });
    expect(terminalClosed).toEqual([]);
    relay.close();
    database.close();
  });

  it('Resource authorization changes close revoked Terminal relays while preserving authorized Workspace relays', async () => {
    const database = {
      userCanRequestNode: vi.fn(
        async (
          _userId: number,
          _nodeId: string,
          _operation: string,
          _data: unknown,
          workspaceId?: string
        ) => workspaceId === 'workspace-allowed'
      )
    };
    const relay = new TerminalRelayService({
      database: database as never,
      authorizeNodeRequest: database.userCanRequestNode,
      requestNode: vi.fn()
    });
    const terminalSent: unknown[] = [];
    const terminal = {
      readyState: 1,
      OPEN: 1,
      send(raw: string) {
        terminalSent.push(JSON.parse(raw));
      }
    };
    const closed: string[] = [];
    const browser = (name: string) => ({
      readyState: 1,
      OPEN: 1,
      CLOSING: 2,
      close(_code: number, reason: string) {
        closed.push(`${name}:${reason}`);
      }
    });
    (relay as unknown as { sockets: Map<string, typeof terminal> }).sockets.set('node-a', terminal);
    const allowed = {
      ticket: 'allowed',
      nodeId: 'node-a',
      terminalId: 'terminal-allowed',
      userSessionHash: 'a'.repeat(43),
      userId: 2,
      workspaceId: 'workspace-allowed',
      readonly: false,
      browser: browser('allowed')
    };
    const denied = {
      ...allowed,
      ticket: 'denied',
      terminalId: 'terminal-denied',
      workspaceId: 'workspace-denied',
      browser: browser('denied')
    };
    const relays = (relay as unknown as { relays: Map<string, typeof allowed> }).relays;
    relays.set(allowed.ticket, allowed);
    relays.set(denied.ticket, denied);

    await relay.revalidateAuthorizations();

    expect([...relays.keys()]).toEqual(['allowed']);
    expect(closed).toEqual(['denied:TERMINAL_AUTHORIZATION_REVOKED']);
    expect(terminalSent).toEqual([{ type: 'close', ticket: 'denied' }]);
    expect(database.userCanRequestNode).toHaveBeenCalledWith(
      2,
      'node-a',
      'terminal.attach.authorize',
      {},
      'workspace-denied'
    );
  });

  it('Only the target Node can answer correlated requests and unanswered requests time out', async () => {
    vi.useFakeTimers();
    const database = new ServerDatabase(':memory:');
    const registered = database.registerNode(database.createNodeRegistrationToken(1).token, {
      metadata: JSON.stringify({
        platform: 'linux',
        architecture: 'x64',
        nodeAppVersion: '0.11.38',
        nodeVersion: 'v24',
        codex: { available: false },
        claudeCode: { available: false }
      })
    })!;
    const nodeId = registered.nodeId;
    const control = createTestNodeControl(database, (userId, nodeId) =>
      database.userOwnsNode(userId, nodeId)
    );
    const sent: unknown[] = [];
    const socket = {
      readyState: 1,
      OPEN: 1,
      send(raw: string) {
        sent.push(JSON.parse(raw));
      }
    };
    let authenticated: string | undefined;
    await (
      control as unknown as {
        handleMessage(
          socket: unknown,
          raw: string,
          setId: (id: string) => void,
          getId: () => string | undefined
        ): Promise<void>;
      }
    ).handleMessage(
      socket,
      JSON.stringify(createEnvelope('authenticate', { nodeId, credential: registered.credential })),
      (id) => {
        authenticated = id;
      },
      () => authenticated
    );
    await (
      control as unknown as {
        handleMessage(
          socket: unknown,
          raw: string,
          setId: (id: string) => void,
          getId: () => string | undefined
        ): Promise<void>;
      }
    ).handleMessage(
      socket,
      JSON.stringify(
        createEnvelope('capabilities', {
          platform: 'linux',
          architecture: 'x64',
          nodeAppVersion: '0.11.38',
          nodeVersion: 'v24',
          codex: { available: false },
          claudeCode: { available: false }
        })
      ),
      (id) => {
        authenticated = id;
      },
      () => authenticated
    );
    sent.length = 0;
    const request = control.requestNode(
      nodeId,
      'workspace.list',
      {},
      {
        userId: 1,
        sessionHash: 'a'.repeat(43)
      }
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(sent).toHaveLength(1);
    const envelope = sent[0] as { id: string };
    (
      control as unknown as {
        resolveNodeRequest(nodeId: string, value: ReturnType<typeof createEnvelope>): void;
      }
    ).resolveNodeRequest(
      'node-b',
      createEnvelope('node.response', { result: { workspaces: [] } }, { replyTo: envelope.id })
    );
    const rejected = expect(request).rejects.toThrow('NODE_REQUEST_TIMEOUT');
    await vi.advanceTimersByTimeAsync(15_000);
    await rejected;
    vi.useRealTimers();
    database.close();
  });
});
