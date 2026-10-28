import { setImmediate as nextTurn } from 'node:timers/promises';
import { EventEmitter } from 'node:events';
import type { WebSocket } from 'ws';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { gate, ready, setup, teardown } from './support/server-notification-close-fixture.js';
import { mysql } from './support/server-notification-pools.js';
import { DirectTransferCoordinator } from '@myagentroam/server-core/direct-transfer-coordinator';
import { TerminalDirectCoordinator } from '@myagentroam/server-core/terminal-direct-coordinator';
import { NodeRequestBroker } from '../../src/service/node-request-broker.js';
import { MysqlServerDatabase } from '../../src/mysql/server-database.js';
import { ModelUsageStore } from '@myagentroam/server-core/model-usage-store';
import * as modelComposition from '../../src/composition/server-models.js';
import { NodeControl } from '../../src/node-control.js';
import type { ServerApplication } from '../../src/app.js';
import { MailNotificationService } from '@myagentroam/server-core/mail-notification-service';
import { RuntimeCredentialService } from '@myagentroam/server-core/runtime-credential-service';
import { createEnvelope } from '@myagentroam/protocol';

vi.mock('../../src/mysql/connection.js', async () => {
  const { mysql } = await import('./support/server-notification-pools.js');
  return mysql;
});

beforeEach(setup);
afterEach(teardown);

describe('Server notification dependency close order', () => {
  it.each(['resolve', 'reject'] as const)(
    'waits for an admitted runtime credential operation to %s before closing either pool',
    async (outcome) => {
      const { app, pending, control } = await ready();
      const active = gate();
      const started = gate();
      vi.spyOn(RuntimeCredentialService.prototype, 'resolve').mockImplementation(async () => {
        started.release();
        await active.promise;
        mysql.events.push('credential-operation-settled');
        if (outcome === 'reject') throw new Error('CREDENTIAL_STORAGE_UNAVAILABLE');
        return {
          error: {
            code: 'MAR_AGENT_RUNTIME_CREDENTIAL_CONNECTION_INVALID',
            message: 'The Node control connection is no longer valid.',
            recoverable: false
          }
        };
      });
      vi.spyOn(MysqlServerDatabase.prototype, 'authenticateNode').mockResolvedValue({
        id: 'node-1',
        ownerUserId: 1,
        displayName: null,
        registeredAddress: 'unknown',
        metadata: '{}',
        disabled: false,
        lastHeartbeatAt: null
      });
      vi.spyOn(MysqlServerDatabase.prototype, 'updateNodeHeartbeat').mockResolvedValue(undefined);
      const emitter = new EventEmitter();
      const socket = Object.assign(emitter, {
        OPEN: 1,
        readyState: 1,
        send: vi.fn((_data: string) => undefined),
        close() {
          this.readyState = 3;
          emitter.emit('close');
        }
      });
      control.attach(socket as unknown as WebSocket);
      socket.emit(
        'message',
        JSON.stringify(createEnvelope('authenticate', { nodeId: 'node-1', credential: 'fixture' }))
      );
      await vi.waitFor(() => expect(control.isNodeConnected('node-1')).toBe(true));
      socket.emit(
        'message',
        JSON.stringify(
          createEnvelope('capabilities', {
            platform: 'linux',
            architecture: 'x64',
            nodeVersion: 'v24',
            nodeAppVersion: '0.11.38',
            codex: { available: false },
            claudeCode: { available: false },
            marAgentRuntimeCredentials: { apiVersion: 1, websocket: true, httpVersions: ['1.1'] }
          })
        )
      );
      await vi.waitFor(() =>
        expect(
          socket.send.mock.calls.some(([raw]) => JSON.parse(raw).payload?.type === 'capabilities'),
          JSON.stringify(socket.send.mock.calls)
        ).toBe(true)
      );
      socket.emit(
        'message',
        JSON.stringify(
          createEnvelope('credential.resolve', {
            ticket: {
              userId: 1,
              credentialId: 'credential-1',
              nodeId: 'node-1',
              workspaceId: 'workspace-1',
              runtimeScopeId: 'scope-1',
              allowedModelIds: ['model-1'],
              issuedAt: 1,
              expiresAt: 60_001,
              nonce: 'fixture',
              signature: 'a'.repeat(64)
            },
            modelId: 'model-1',
            runtimeScopeId: 'scope-1',
            executionId: 'run-1',
            reason: 'REQUEST'
          })
        )
      );
      await started.promise;
      const heartbeat = createEnvelope('heartbeat', {});
      socket.emit('message', JSON.stringify(heartbeat));
      await vi.waitFor(() =>
        expect(
          socket.send.mock.calls.some(([raw]) => JSON.parse(raw).replyTo === heartbeat.id)
        ).toBe(true)
      );
      const closing = app.close();
      pending.release();
      await nextTurn();
      expect(mysql.events).not.toContain('pool-close');
      active.release();
      await closing;
      expect(mysql.events.indexOf('credential-operation-settled')).toBeLessThan(
        mysql.events.indexOf('pool-close')
      );
      expect(mysql.events.filter((event) => event === 'pool-close')).toHaveLength(2);
      expect(
        socket.send.mock.calls.some(([raw]) => JSON.parse(raw).type === 'credential.response')
      ).toBe(false);
    }
  );

  it('waits for an admitted registration transaction before closing the pool', async () => {
    const { app, pending, control } = await ready();
    const active = gate();
    const started = gate();
    vi.spyOn(MysqlServerDatabase.prototype, 'registerNode').mockImplementation(async () => {
      started.release();
      await active.promise;
      mysql.events.push('registration-settled');
      return { nodeId: 'node-1', credential: 'fixture-credential' };
    });
    const emitter = new EventEmitter();
    const socket = Object.assign(emitter, {
      OPEN: 1,
      readyState: 1,
      send: vi.fn(),
      close() {
        this.readyState = 3;
        emitter.emit('close');
      }
    });
    control.attach(socket as unknown as WebSocket);
    socket.emit(
      'message',
      JSON.stringify(
        createEnvelope('register', {
          registrationToken: 'fixture',
          capabilities: {
            platform: 'linux',
            architecture: 'x64',
            nodeVersion: 'v24',
            nodeAppVersion: '0.11.38',
            codex: { available: false },
            claudeCode: { available: false }
          }
        })
      )
    );
    await started.promise;
    const closing = app.close();
    pending.release();
    await nextTurn();
    expect(mysql.events).not.toContain('pool-close');
    active.release();
    await closing;
    expect(mysql.events.indexOf('registration-settled')).toBeLessThan(
      mysql.events.indexOf('pool-close')
    );
    expect(control.isNodeConnected('node-1')).toBe(false);
    expect(socket.send).not.toHaveBeenCalled();
  });
  it('drains admitted usage before pool close without acknowledging a replacement connection', async () => {
    const { app, pending, control } = await ready();
    const active = gate();
    const started = gate();
    vi.spyOn(ModelUsageStore.prototype, 'consume').mockImplementation(async () => {
      started.release();
      await active.promise;
      mysql.events.push('usage-result-written');
      return { apiVersion: 1, results: [] };
    });
    vi.spyOn(MysqlServerDatabase.prototype, 'authenticateNode').mockResolvedValue({
      id: 'node-1',
      ownerUserId: 1,
      displayName: null,
      registeredAddress: 'unknown',
      metadata: '{}',
      disabled: false,
      lastHeartbeatAt: null
    });
    vi.spyOn(MysqlServerDatabase.prototype, 'updateNodeHeartbeat').mockResolvedValue(undefined);
    const createSocket = () => {
      const emitter = new EventEmitter();
      const socket = Object.assign(emitter, {
        OPEN: 1,
        readyState: 1,
        send: vi.fn((_data: string) => undefined),
        close() {
          this.readyState = 3;
          emitter.emit('close');
        }
      });
      control.attach(socket as unknown as WebSocket);
      socket.emit(
        'message',
        JSON.stringify(createEnvelope('authenticate', { nodeId: 'node-1', credential: 'fixture' }))
      );
      return socket;
    };
    const old = createSocket();
    await vi.waitFor(() => expect(control.isNodeConnected('node-1')).toBe(true));
    old.emit(
      'message',
      JSON.stringify(
        createEnvelope('capabilities', {
          platform: 'linux',
          architecture: 'x64',
          nodeVersion: 'v24',
          nodeAppVersion: '0.11.38',
          codex: { available: false },
          claudeCode: { available: false }
        })
      )
    );
    await vi.waitFor(() =>
      expect(
        old.send.mock.calls.some(([raw]) => JSON.parse(raw).payload?.type === 'capabilities')
      ).toBe(true)
    );
    const scopeId = '8e1668db-88e7-4a28-9ccd-cda8814a4e73';
    old.emit(
      'message',
      JSON.stringify(
        createEnvelope('usage.batch', {
          apiVersion: 1,
          entries: [
            {
              grant: { scopeId, token: 'fixture' },
              record: {
                schemaVersion: 1,
                recordId: 'record',
                requestId: 'request',
                revision: 1,
                scopeId,
                runner: 'mar-agent',
                sessionId: 'session',
                runId: 'run',
                purpose: 'conversation',
                agentRole: 'root',
                startedAt: 1,
                state: 'running'
              }
            }
          ]
        })
      )
    );
    await started.promise;
    const replacement = createSocket();
    await vi.waitFor(() => expect(replacement.send).toHaveBeenCalled());
    const closing = app.close();
    pending.release();
    await nextTurn();
    expect(mysql.events).not.toContain('pool-close');
    active.release();
    await closing;
    expect(mysql.events.indexOf('usage-result-written')).toBeLessThan(
      mysql.events.indexOf('pool-close')
    );
    expect(replacement.send.mock.calls.some(([raw]) => JSON.parse(raw).type === 'usage.ack')).toBe(
      false
    );
    expect(old.send.mock.calls.some(([raw]) => JSON.parse(raw).type === 'usage.ack')).toBe(false);
  });
  it('drains an admitted mail request and its result write before closing the pools', async () => {
    const { app, pending, control } = await ready();
    const active = gate();
    const started = gate();
    const sender = vi
      .spyOn(MailNotificationService.prototype, 'send')
      .mockImplementation(async () => {
        started.release();
        await active.promise;
        mysql.events.push('mail-result-written');
      });
    vi.spyOn(MysqlServerDatabase.prototype, 'authenticateNode').mockResolvedValue({
      id: 'node-1',
      ownerUserId: 1,
      displayName: null,
      registeredAddress: 'unknown',
      metadata: '{}',
      disabled: false,
      lastHeartbeatAt: null
    });
    vi.spyOn(MysqlServerDatabase.prototype, 'updateNodeHeartbeat').mockResolvedValue(undefined);
    const emitter = new EventEmitter();
    const socket = Object.assign(emitter, {
      OPEN: 1,
      readyState: 1,
      send: vi.fn((_data: string) => undefined),
      close() {
        this.readyState = 3;
        emitter.emit('close');
      }
    });
    control.attach(socket as unknown as WebSocket);
    socket.emit(
      'message',
      JSON.stringify(
        createEnvelope('authenticate', {
          nodeId: 'node-1',
          credential: 'fixture'
        })
      )
    );
    await vi.waitFor(() => expect(control.isNodeConnected('node-1')).toBe(true));
    socket.emit(
      'message',
      JSON.stringify(
        createEnvelope('capabilities', {
          platform: 'linux',
          architecture: 'x64',
          nodeVersion: 'v24',
          nodeAppVersion: '0.11.38',
          codex: { available: false },
          claudeCode: { available: false }
        })
      )
    );
    await vi.waitFor(() =>
      expect(
        socket.send.mock.calls.some(
          ([raw]) => JSON.parse(String(raw)).payload?.type === 'capabilities'
        )
      ).toBe(true)
    );
    socket.emit(
      'message',
      JSON.stringify(
        createEnvelope('mail.notification.send', {
          executionId: 'run-1',
          sessionId: 'session-1',
          workspaceId: 'workspace-1',
          userId: 1,
          source: 'MANUAL',
          callId: '8e1668db-88e7-4a28-9ccd-cda8814a4e73',
          message: 'Done',
          templateId: ''
        })
      )
    );
    await started.promise;
    const closing = app.close();
    pending.release();
    await nextTurn();
    expect(mysql.events).not.toContain('pool-close');
    active.release();
    await closing;
    expect(sender).toHaveBeenCalledOnce();
    expect(mysql.events.indexOf('mail-result-written')).toBeLessThan(
      mysql.events.indexOf('pool-close')
    );
  });

  it('releases constructed Node owners and both pools if later assembly fails', async () => {
    const failure = new Error('MODEL_ASSEMBLY_FAILED');
    vi.spyOn(modelComposition, 'composeServerModels').mockImplementationOnce(() => {
      throw failure;
    });
    await expect(ready()).rejects.toBe(failure);
    expect(mysql.events.filter((event) => event === 'pool-close')).toHaveLength(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('retains assembly and cleanup errors while still closing both pools', async () => {
    const failure = new Error('MODEL_ASSEMBLY_FAILED');
    const cleanupFailure = new Error('NODE_CLEANUP_FAILED');
    vi.spyOn(modelComposition, 'composeServerModels').mockImplementationOnce(() => {
      throw failure;
    });
    const closeNode = NodeControl.prototype.close;
    vi.spyOn(NodeControl.prototype, 'close').mockImplementationOnce(function (this: NodeControl) {
      closeNode.call(this);
      throw cleanupFailure;
    });
    const result = await ready().catch((error: unknown) => error);
    expect(result).toBeInstanceOf(AggregateError);
    expect((result as AggregateError).errors).toEqual([failure, cleanupFailure]);
    expect((result as AggregateError).cause).toBe(failure);
    expect(mysql.events.filter((event) => event === 'pool-close')).toHaveLength(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('retains a Node cleanup failure while releasing the database', async () => {
    const { app, pending, control } = await ready();
    const failure = new Error('node close failed');
    const closeNode = control.close.bind(control);
    const close = vi.spyOn(control, 'close').mockImplementationOnce(() => {
      closeNode();
      throw failure;
    });
    const closing = app.shutdown();
    pending.release();
    await expect(closing).rejects.toBe(failure);
    expect(close).toHaveBeenCalledTimes(1);
    expect(mysql.events.filter((event) => event === 'pool-close')).toHaveLength(2);
  });
  it('releases constructed resources after database initialization fails', async () => {
    const failure = new Error('INITIALIZE_FAILED');
    vi.mocked(MysqlServerDatabase.prototype.initialize).mockRejectedValueOnce(failure);
    let app: ServerApplication | undefined;
    await expect(
      ready((instance) => {
        app = instance;
      })
    ).rejects.toBe(failure);
    expect(app).toBeDefined();
    await app!.shutdown();
    expect(mysql.events.filter((event) => event === 'pool-close')).toHaveLength(2);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('initializes the database before starting model usage maintenance', async () => {
    const cleanup = vi.spyOn(ModelUsageStore.prototype, 'cleanup').mockResolvedValue(undefined);
    const { app, pending } = await ready();
    expect(MysqlServerDatabase.prototype.initialize).toHaveBeenCalledOnce();
    expect(cleanup).toHaveBeenCalledOnce();
    expect(
      vi.mocked(MysqlServerDatabase.prototype.initialize).mock.invocationCallOrder[0]!
    ).toBeLessThan(cleanup.mock.invocationCallOrder[0]!);
    pending.release();
    await app.close();
  });
  it('closes the application even if listener connection cleanup throws', async () => {
    const { app, pending } = await ready();
    const failure = new Error('LISTENER_CLOSE_FAILED');
    vi.spyOn(app.server, 'closeAllConnections').mockImplementationOnce(() => {
      throw failure;
    });
    const closing = app.shutdown();
    pending.release();
    await expect(closing).rejects.toBe(failure);
    expect(mysql.events.filter((event) => event === 'pool-close')).toHaveLength(2);
  });
  it('continues closing Node and database owners after a Node cleanup failure', async () => {
    const { app, pending } = await ready();
    const failure = new Error('DIRECT_CLOSE_FAILED');
    vi.spyOn(DirectTransferCoordinator.prototype, 'close').mockImplementationOnce(() => {
      throw failure;
    });
    const terminalClose = vi.spyOn(TerminalDirectCoordinator.prototype, 'close');
    const brokerClose = vi.spyOn(NodeRequestBroker.prototype, 'close');
    const closing = app.shutdown();
    pending.release();
    await expect(closing).rejects.toBe(failure);
    expect(terminalClose).toHaveBeenCalledOnce();
    expect(brokerClose).toHaveBeenCalledOnce();
    expect(mysql.events.filter((event) => event === 'pool-close')).toHaveLength(2);
  });
  it('drains admitted Node projections before closing their database', async () => {
    const { app, pending, control } = await ready();
    const projection = gate();
    const started = gate();
    const work = control.messageProjector.enqueueSessionProjection('node-1', async () => {
      started.release();
      await projection.promise;
    });
    await started.promise;
    const closing = app.close();
    pending.release();
    await nextTurn();
    expect(mysql.events).not.toContain('pool-close');
    projection.release();
    await work;
    await closing;
    expect(mysql.events.filter((event) => event === 'pool-close')).toHaveLength(2);
  });
  it.each(['close', 'shutdown'] as const)(
    '%s stops tasks and drains an in-flight Push before closing either pool',
    async (entry) => {
      const { app, pending, transport, warnings, dispatcher } = await ready();
      let closed = false;
      const operation = app[entry]();
      const closing = operation.then(() => {
        closed = true;
      });
      if (entry === 'shutdown') expect(app.shutdown()).toBe(operation);
      await nextTurn();
      expect(closed).toBe(false);
      expect(mysql.events).toEqual(['transport-start', 'transport-abort']);
      expect(vi.getTimerCount()).toBe(0);
      expect(dispatcher.enqueue(1, 'late-notice', async () => true)).toBe('closed');
      pending.release();
      await closing;
      expect(mysql.events).toEqual([
        'transport-start',
        'transport-abort',
        'transport-settle',
        'expire-sql',
        'pool-close',
        'pool-close'
      ]);
      expect(warnings).not.toHaveBeenCalled();
      expect(transport).toHaveBeenCalledOnce();
      await app[entry]();
      expect(mysql.pools.map((pool) => pool.end.mock.calls.length)).toEqual([1, 1]);
    }
  );

  it('stops Push admission and aborts active transport before HTTP draining completes', async () => {
    const draining = gate();
    const entered = gate();
    const { app, pending, transport, dispatcher } = await ready((instance) => {
      instance.addHook('preClose', async () => {
        entered.release();
        await draining.promise;
      });
    });
    const closing = app.close();
    await entered.promise;
    expect(mysql.events).toEqual(['transport-start', 'transport-abort']);
    expect(dispatcher.enqueue(1, 'late-notice', async () => true)).toBe('closed');
    pending.release();
    draining.release();
    await closing;
    expect(transport).toHaveBeenCalledOnce();
  });
});
