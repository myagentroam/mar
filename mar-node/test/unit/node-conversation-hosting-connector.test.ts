import type { ConversationHostingLifecycleService } from '../../src/service/conversation-hosting-lifecycle-service.js';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  ConversationTemplateDraft,
  NodeCapabilities
} from '../../../packages/protocol/src/index.js';
import { createEnvelope } from '../../../packages/protocol/src/index.js';
import { NodeConnector } from '../../src/connector.js';
import { loadNodeConfig, saveNodeConfig, type NodeConfig } from '../../src/config.js';
import { NodeDatabase } from '../../src/database.js';
import { NodeMetrics } from '../../src/operational.js';
import { NodeConnectionLifecycleService } from '../../src/service/node-connection-lifecycle-service.js';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});

describe('Node conversation hosting connector integration', () => {
  it('initializes the private store, projects capability and routes template operations', async () => {
    const directory = await temporaryDirectory();
    const workspace = join(directory, 'workspace');
    const dataDirectory = join(directory, 'data');
    await mkdir(workspace, { recursive: true });
    await writeFile(join(workspace, 'instructions.md'), 'inspect me');
    const database = new NodeDatabase(join(directory, 'node-runtime.sqlite'), 'node-1');
    database.saveWorkspace({
      id: 'workspace-1',
      path: workspace,
      kind: 'DIRECTORY',
      gitSummary: null
    });
    const connector = new NodeConnector({
      reconnect: false,
      database,
      capabilities: baseCapabilities(),
      conversationHostingProbe: async () => ({ available: true, version: '0.11.1' }),
      config: {
        serverUrl: 'http://server.test',
        allowedRoots: [workspace],
        dataDirectory,
        conversationHosting: { enabled: true, storeDirectory: 'hosted-conversations' },
        nodeId: 'node-1',
        credential: 'test'
      }
    });

    await initializeConversationHosting(connector);

    expect(readCapabilities(connector).conversationHosting).toEqual({
      state: 'AVAILABLE',
      apiVersion: 1,
      sandboxBackend: 'BUBBLEWRAP',
      sandboxPolicyVersion: 1,
      acceptsNewConversations: true,
      supportsExistingConversations: true,
      capacity: 'AVAILABLE'
    });
    await expect(
      execute(connector, 'conversation.template.source.inspect', {
        mode: 'DRAFT_TEST',
        draft: draft()
      })
    ).resolves.toMatchObject({
      valid: false,
      code: 'CONVERSATION_TEMPLATE_SOURCE_INVALID'
    });
    await expect(
      execute(connector, 'conversation.hosted.list', {
        limit: 20,
        __requestUserId: 7
      })
    ).resolves.toEqual({ items: [], nextCursor: null });
    await expect(
      execute(connector, 'conversation.hosting.storage.inspect', {})
    ).resolves.toMatchObject({
      storage: {
        capacity: 'AVAILABLE',
        acceptsNewConversations: true,
        automaticCleanupInactiveDays: 60
      }
    });
    connector.stop();
  });

  it('routes hosted conversation file delete through the operation router', async () => {
    const directory = await temporaryDirectory();
    const database = new NodeDatabase(join(directory, 'node-runtime.sqlite'), 'node-1');
    const connector = new NodeConnector({
      reconnect: false,
      database,
      capabilities: baseCapabilities(),
      conversationHostingProbe: async () => ({ available: true, version: '0.11.1' }),
      config: {
        serverUrl: 'http://server.test',
        allowedRoots: [],
        dataDirectory: join(directory, 'data'),
        conversationHosting: { enabled: true, storeDirectory: 'hosted-conversations' },
        nodeId: 'node-1',
        credential: 'test'
      }
    });
    await initializeConversationHosting(connector);

    await expect(
      execute(connector, 'conversation.hosted.file.delete', {
        conversationId: 'missing-conversation',
        fileId: 'missing-file',
        __requestUserId: 7
      })
    ).rejects.toThrow('HOSTED_CONVERSATION_NOT_AUTHORIZED');
    connector.stop();
  });

  it('projects disabled capability and rejects hosting operations when not configured', async () => {
    const directory = await temporaryDirectory();
    const database = new NodeDatabase(join(directory, 'node-runtime.sqlite'), 'node-1');
    const connector = new NodeConnector({
      reconnect: false,
      database,
      capabilities: baseCapabilities(),
      conversationHostingProbe: async () => ({ available: true, version: '0.11.1' }),
      config: {
        serverUrl: 'http://server.test',
        allowedRoots: [],
        dataDirectory: join(directory, 'data'),
        nodeId: 'node-1',
        credential: 'test'
      }
    });

    await initializeConversationHosting(connector);

    expect(readCapabilities(connector).conversationHosting).toEqual({
      state: 'DISABLED',
      apiVersion: 1,
      acceptsNewConversations: false,
      supportsExistingConversations: false,
      capacity: 'AVAILABLE'
    });
    await expect(
      execute(connector, 'conversation.template.publish.status', {
        templateId: 'template-1',
        jobId: 'job-1'
      })
    ).rejects.toThrow('CONVERSATION_HOSTING_UNAVAILABLE');
    await expect(
      execute(connector, 'conversation.hosted.list', {
        limit: 20,
        __requestUserId: 7
      })
    ).rejects.toThrow('CONVERSATION_HOSTING_UNAVAILABLE');
    connector.stop();
  });

  it('persists and hot-enables hosting with safe defaults, reports capability, and stays idempotent', async () => {
    const directory = await temporaryDirectory();
    const configPath = join(directory, 'mar-node.json');
    const config: NodeConfig = {
      serverUrl: 'http://server.test',
      allowedRoots: [],
      dataDirectory: 'data',
      nodeId: 'node-1',
      credential: 'test'
    };
    await saveNodeConfig(config, configPath);
    const database = new NodeDatabase(join(directory, 'node-runtime.sqlite'), 'node-1');
    const connector = new NodeConnector({
      reconnect: false,
      database,
      config,
      configPath,
      capabilities: baseCapabilities(),
      conversationHostingProbe: async () => ({ available: true, version: '0.11.1' })
    });
    await initializeConversationHosting(connector);
    const sent: Array<{
      readonly type: string;
      readonly replyTo?: string;
      readonly payload: unknown;
    }> = [];
    (connector as unknown as { socket: unknown }).socket = {
      readyState: 1,
      OPEN: 1,
      send(raw: string) {
        sent.push(JSON.parse(raw) as { type: string; payload: unknown });
      },
      close() {}
    };
    const initialize = vi.spyOn(
      (connector as unknown as { conversationHosting: ConversationHostingLifecycleService })
        .conversationHosting,
      'initialize'
    );

    const requestId = 'conversation-hosting-enable-request';
    const now = Date.now();
    (connector as unknown as { handleMessage(raw: string): void }).handleMessage(
      JSON.stringify(
        createEnvelope(
          'node.request',
          {
            operation: 'conversation.hosting.enable',
            data: { enabled: true },
            userAuthorization: {
              userId: 7,
              sessionHash: 'a'.repeat(43),
              nodeId: 'node-1',
              operation: 'conversation.hosting.enable',
              requestId,
              issuedAt: now,
              expiresAt: now + 15_000
            }
          },
          { id: requestId }
        )
      )
    );
    await vi.waitFor(() =>
      expect(sent).toContainEqual(
        expect.objectContaining({
          type: 'node.response',
          replyTo: requestId,
          payload: {
            result: expect.objectContaining({
              capability: expect.objectContaining({ state: 'AVAILABLE' })
            })
          }
        })
      )
    );

    expect((await loadNodeConfig(configPath)).conversationHosting).toEqual({
      enabled: true,
      storeDirectory: 'hosted-conversations',
      inactiveRetentionDays: 60
    });
    expect(readCapabilities(connector).conversationHosting?.state).toBe('AVAILABLE');
    expect(sent).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'capabilities',
          payload: expect.objectContaining({
            conversationHosting: expect.objectContaining({ state: 'AVAILABLE' })
          })
        })
      ])
    );
    await expect(
      execute(connector, 'conversation.hosted.list', {
        limit: 20,
        __requestUserId: 7
      })
    ).resolves.toEqual({ items: [], nextCursor: null });
    await expect(
      execute(connector, 'conversation.hosting.enable', { enabled: true })
    ).resolves.toMatchObject({ capability: { state: 'AVAILABLE' } });
    expect(initialize).toHaveBeenCalledOnce();
    connector.stop();
  });

  it('persists disablement, releases hosting operations, and preserves private hosting paths', async () => {
    const directory = await temporaryDirectory();
    const configPath = join(directory, 'mar-node.json');
    const config: NodeConfig = {
      serverUrl: 'http://server.test',
      allowedRoots: [],
      dataDirectory: 'data',
      conversationHosting: {
        enabled: true,
        storeDirectory: 'hosted-conversations',
        inactiveRetentionDays: 45
      },
      nodeId: 'node-1',
      credential: 'test'
    };
    await saveNodeConfig(config, configPath);
    const connector = new NodeConnector({
      reconnect: false,
      database: new NodeDatabase(join(directory, 'node-runtime.sqlite'), 'node-1'),
      config,
      configPath,
      capabilities: baseCapabilities(),
      conversationHostingProbe: async () => ({ available: true, version: '0.11.1' })
    });

    await initializeConversationHosting(connector);
    await expect(execute(connector, 'conversation.hosting.disable', {})).resolves.toEqual({
      capability: {
        state: 'DISABLED',
        apiVersion: 1,
        acceptsNewConversations: false,
        supportsExistingConversations: false,
        capacity: 'AVAILABLE'
      }
    });
    expect(await loadNodeConfig(configPath)).toMatchObject({
      conversationHosting: {
        enabled: false,
        storeDirectory: 'hosted-conversations',
        inactiveRetentionDays: 45
      }
    });
    await expect(
      execute(connector, 'conversation.hosted.list', { limit: 20, __requestUserId: 7 })
    ).rejects.toThrow('CONVERSATION_HOSTING_UNAVAILABLE');
    connector.stop();
  });

  it('rejects extra enablement fields without changing private config', async () => {
    const directory = await temporaryDirectory();
    const configPath = join(directory, 'mar-node.json');
    const config: NodeConfig = {
      serverUrl: 'http://server.test',
      allowedRoots: [],
      dataDirectory: 'data',
      nodeId: 'node-1',
      credential: 'test'
    };
    await saveNodeConfig(config, configPath);
    const connector = new NodeConnector({
      reconnect: false,
      database: new NodeDatabase(join(directory, 'node-runtime.sqlite'), 'node-1'),
      config,
      configPath,
      capabilities: baseCapabilities()
    });

    await expect(
      execute(connector, 'conversation.hosting.enable', { enabled: true, extra: true })
    ).rejects.toThrow('CONVERSATION_HOSTING_ENABLE_INPUT_INVALID');
    expect((await loadNodeConfig(configPath)).conversationHosting).toBeUndefined();
    connector.stop();
  });

  it('persists enablement and publishes unavailable capability when the sandbox probe throws', async () => {
    const directory = await temporaryDirectory();
    const configPath = join(directory, 'mar-node.json');
    const config: NodeConfig = {
      serverUrl: 'http://server.test',
      allowedRoots: [],
      dataDirectory: 'data',
      nodeId: 'node-1',
      credential: 'test'
    };
    await saveNodeConfig(config, configPath);
    const connector = new NodeConnector({
      reconnect: false,
      database: new NodeDatabase(join(directory, 'node-runtime.sqlite'), 'node-1'),
      config,
      configPath,
      capabilities: baseCapabilities(),
      conversationHostingProbe: async () => {
        throw new Error('SANDBOX_EXECUTION_FAILED');
      }
    });
    const sent: Array<{ readonly type: string; readonly payload: unknown }> = [];
    (connector as unknown as { socket: unknown }).socket = {
      readyState: 1,
      OPEN: 1,
      send(raw: string) {
        sent.push(JSON.parse(raw) as { type: string; payload: unknown });
      },
      close() {}
    };

    await expect(
      execute(connector, 'conversation.hosting.enable', { enabled: true })
    ).resolves.toEqual({
      capability: {
        state: 'UNAVAILABLE',
        apiVersion: 1,
        acceptsNewConversations: false,
        supportsExistingConversations: false,
        capacity: 'AVAILABLE',
        reasonCode: 'SANDBOX_EXECUTION_FAILED'
      }
    });
    expect((await loadNodeConfig(configPath)).conversationHosting?.enabled).toBe(true);
    expect(sent).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'capabilities',
          payload: expect.objectContaining({
            conversationHosting: expect.objectContaining({
              state: 'UNAVAILABLE',
              reasonCode: 'SANDBOX_EXECUTION_FAILED'
            })
          })
        })
      ])
    );
    connector.stop();
  });

  it('rejects management enablement on Windows without changing private config', async () => {
    const directory = await temporaryDirectory();
    const configPath = join(directory, 'mar-node.json');
    const config: NodeConfig = {
      serverUrl: 'http://server.test',
      allowedRoots: [],
      dataDirectory: 'data',
      nodeId: 'node-1',
      credential: 'test'
    };
    await saveNodeConfig(config, configPath);
    const database = new NodeDatabase(join(directory, 'node-runtime.sqlite'), 'node-1');
    const connector = new NodeConnector({
      reconnect: false,
      database,
      config,
      configPath,
      capabilities: { ...baseCapabilities(), platform: 'windows' }
    });

    await expect(
      execute(connector, 'conversation.hosting.enable', { enabled: true })
    ).rejects.toThrow('CONVERSATION_HOSTING_PLATFORM_UNSUPPORTED');
    expect((await loadNodeConfig(configPath)).conversationHosting).toBeUndefined();
    connector.stop();
  });

  it('reports configured hosting as unavailable when the sandbox health probe fails', async () => {
    const directory = await temporaryDirectory();
    const database = new NodeDatabase(join(directory, 'node-runtime.sqlite'), 'node-1');
    const connector = new NodeConnector({
      reconnect: false,
      database,
      capabilities: baseCapabilities(),
      conversationHostingProbe: async () => ({
        available: false,
        reasonCode: 'SANDBOX_UNAVAILABLE'
      }),
      config: {
        serverUrl: 'http://server.test',
        allowedRoots: [],
        dataDirectory: join(directory, 'data'),
        conversationHosting: { enabled: true, storeDirectory: 'hosted-conversations' },
        nodeId: 'node-1',
        credential: 'test'
      }
    });

    await initializeConversationHosting(connector);

    expect(readCapabilities(connector).conversationHosting).toEqual({
      state: 'UNAVAILABLE',
      apiVersion: 1,
      acceptsNewConversations: false,
      supportsExistingConversations: false,
      capacity: 'AVAILABLE',
      reasonCode: 'SANDBOX_UNAVAILABLE'
    });
    connector.stop();
  });

  it('accepts an authorized fixed template operation through the Node control envelope', async () => {
    const directory = await temporaryDirectory();
    const workspace = join(directory, 'workspace');
    await mkdir(workspace, { recursive: true });
    await writeFile(join(workspace, 'instructions.md'), 'inspect me');
    const database = new NodeDatabase(join(directory, 'node-runtime.sqlite'), 'node-1');
    database.saveWorkspace({
      id: 'workspace-1',
      path: workspace,
      kind: 'DIRECTORY',
      gitSummary: null
    });
    const connector = new NodeConnector({
      reconnect: false,
      database,
      capabilities: baseCapabilities(),
      conversationHostingProbe: async () => ({ available: true, version: '0.11.1' }),
      config: {
        serverUrl: 'http://server.test',
        allowedRoots: [workspace],
        dataDirectory: join(directory, 'data'),
        conversationHosting: { enabled: true, storeDirectory: 'hosted-conversations' },
        nodeId: 'node-1',
        credential: 'test'
      }
    });
    await initializeConversationHosting(connector);
    const sent: Array<{ readonly type: string; readonly payload: unknown }> = [];
    (connector as unknown as { socket: unknown }).socket = {
      readyState: 1,
      OPEN: 1,
      send(raw: string) {
        sent.push(JSON.parse(raw) as { type: string; payload: unknown });
      },
      close() {}
    };
    const requestId = 'template-inspect-request';
    const now = Date.now();

    (connector as unknown as { handleMessage(raw: string): void }).handleMessage(
      JSON.stringify(
        createEnvelope(
          'node.request',
          {
            operation: 'conversation.template.source.inspect',
            data: { mode: 'DRAFT_TEST', draft: draft() },
            userAuthorization: {
              userId: 7,
              sessionHash: 'a'.repeat(43),
              nodeId: 'node-1',
              operation: 'conversation.template.source.inspect',
              requestId,
              issuedAt: now,
              expiresAt: now + 15_000
            }
          },
          { id: requestId }
        )
      )
    );

    await vi.waitFor(() =>
      expect(sent).toContainEqual(
        expect.objectContaining({
          type: 'node.response',
          payload: {
            result: expect.objectContaining({
              valid: false,
              code: 'CONVERSATION_TEMPLATE_SOURCE_INVALID'
            })
          }
        })
      )
    );
    connector.stop();
  });

  it('keeps SQLite open until an active hosted cleanup drain completes', async () => {
    const directory = await temporaryDirectory();
    const database = new NodeDatabase(join(directory, 'node-runtime.sqlite'), 'node-1');
    const connector = new NodeConnector({
      reconnect: false,
      database,
      capabilities: baseCapabilities(),
      config: {
        serverUrl: 'http://server.test',
        allowedRoots: [],
        dataDirectory: join(directory, 'data'),
        nodeId: 'node-1',
        credential: 'test'
      }
    });
    let releaseDrain!: () => void;
    const drain = new Promise<void>((resolve) => {
      releaseDrain = resolve;
    });
    (
      connector as unknown as {
        conversationHosting: { resources: unknown };
      }
    ).conversationHosting.resources = {
      maintenance: { dispose: () => drain },
      service: { dispose() {} },
      runtime: { async dispose() {} },
      operations: {}
    };
    const close = vi.spyOn(database, 'close');

    const stopping = connector.stop();
    const repeatedStopping = connector.stop();
    const closedBeforeDrain = close.mock.calls.length;
    releaseDrain();
    await Promise.all([stopping, repeatedStopping]);

    expect(closedBeforeDrain).toBe(0);
    expect(repeatedStopping).toBe(stopping);
    expect(close).toHaveBeenCalledOnce();
  });

  it('waits for hosted runtime disposal even when no cleanup drain is active', async () => {
    const directory = await temporaryDirectory();
    const database = new NodeDatabase(join(directory, 'node-runtime.sqlite'), 'node-1');
    const connector = new NodeConnector({
      reconnect: false,
      database,
      capabilities: baseCapabilities(),
      config: {
        serverUrl: 'http://server.test',
        allowedRoots: [],
        dataDirectory: join(directory, 'data'),
        nodeId: 'node-1',
        credential: 'test'
      }
    });
    let releaseRuntime!: () => void;
    const runtimeDrain = new Promise<void>((resolve) => {
      releaseRuntime = resolve;
    });
    const dispose = vi.fn(() => runtimeDrain);
    (
      connector as unknown as {
        conversationHosting: { resources: unknown };
      }
    ).conversationHosting.resources = {
      runtime: { dispose },
      service: { dispose() {} },
      maintenance: { async dispose() {} },
      operations: {}
    };
    const close = vi.spyOn(database, 'close');

    let stopped = false;
    const stopping = connector.stop().then(() => {
      stopped = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    const stoppedBeforeRuntime = stopped;
    const closedBeforeRuntime = close.mock.calls.length;
    releaseRuntime();
    await stopping;

    expect(dispose).toHaveBeenCalledOnce();
    expect(stoppedBeforeRuntime).toBe(false);
    expect(closedBeforeRuntime).toBe(0);
    expect(close).toHaveBeenCalledOnce();
  });

  it('waits for upload cleanup and Goal MCP closure before completing stop', async () => {
    const directory = await temporaryDirectory();
    const database = new NodeDatabase(join(directory, 'node-runtime.sqlite'), 'node-1');
    const connector = new NodeConnector({
      reconnect: false,
      database,
      capabilities: baseCapabilities(),
      config: {
        serverUrl: 'http://server.test',
        allowedRoots: [],
        dataDirectory: join(directory, 'data'),
        nodeId: 'node-1',
        credential: 'test'
      }
    });
    let releaseUploads!: () => void;
    let releaseGoalMcp!: () => void;
    const uploadDrain = new Promise<void>((resolve) => {
      releaseUploads = resolve;
    });
    const goalMcpDrain = new Promise<void>((resolve) => {
      releaseGoalMcp = resolve;
    });
    const internals = connector as unknown as {
      workspaceUploadService: { shutdown(): Promise<void> };
      goalMcpBridge: { close(): Promise<void> };
    };
    const shutdown = vi
      .spyOn(internals.workspaceUploadService, 'shutdown')
      .mockReturnValue(uploadDrain);
    const closeGoalMcp = vi.spyOn(internals.goalMcpBridge, 'close').mockReturnValue(goalMcpDrain);
    const closeDatabase = vi.spyOn(database, 'close');

    let settled = false;
    const stopping = connector.stop().then(() => {
      settled = true;
    });
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(settled).toBe(false);
      expect(closeDatabase).not.toHaveBeenCalled();
      releaseUploads();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(settled).toBe(false);
      expect(closeDatabase).not.toHaveBeenCalled();
    } finally {
      releaseUploads();
      releaseGoalMcp();
      await stopping;
    }
    expect(shutdown).toHaveBeenCalledOnce();
    expect(closeGoalMcp).toHaveBeenCalledOnce();
    expect(closeDatabase).toHaveBeenCalledOnce();
  });

  it('waits for hosted cleanup drain before exiting for a supervised upgrade', async () => {
    const directory = await temporaryDirectory();
    const database = new NodeDatabase(join(directory, 'node-runtime.sqlite'), 'node-1');
    const connector = new NodeConnector({
      reconnect: false,
      database,
      capabilities: baseCapabilities(),
      config: {
        serverUrl: 'http://server.test',
        allowedRoots: [],
        dataDirectory: join(directory, 'data'),
        nodeId: 'node-1',
        credential: 'test'
      }
    });
    let releaseDrain!: () => void;
    const drain = new Promise<void>((resolve) => {
      releaseDrain = resolve;
    });
    const dispose = vi.fn(() => drain);
    (
      connector as unknown as {
        conversationHosting: { resources: unknown };
      }
    ).conversationHosting.resources = {
      maintenance: { dispose },
      service: { dispose() {} },
      runtime: { async dispose() {} },
      operations: {}
    };
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

    (
      connector as unknown as {
        upgradeCoordinator: { request(data: unknown): unknown };
      }
    ).upgradeCoordinator.request({ targetVersion: '0.9.27' });
    await vi.waitFor(() => expect(dispose).toHaveBeenCalledOnce());
    await new Promise<void>((resolve) => setImmediate(resolve));
    const exitedBeforeDrain = exit.mock.calls.length;
    releaseDrain();
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(75));
    exit.mockRestore();

    expect(exitedBeforeDrain).toBe(0);
  });
});

describe('Node conversation hosting registration lifecycle', () => {
  it('preserves hosting config and initializes it before reporting the registered connection', async () => {
    const directory = await temporaryDirectory();
    const configPath = join(directory, 'mar-node.json');
    let config: NodeConfig | undefined = {
      serverUrl: 'http://server.test',
      allowedRoots: [],
      dataDirectory: 'data',
      conversationHosting: { enabled: true, storeDirectory: 'hosted-conversations' },
      registrationToken: 'registration-token'
    };
    const onRegistered = vi.fn(async () => undefined);
    const control = { send: vi.fn() };
    const terminal = { connect: vi.fn() };
    const service = new NodeConnectionLifecycleService({
      config: () => config,
      setConfig: (next) => {
        config = next;
      },
      configPath,
      capabilities: baseCapabilities,
      detectCapabilities: baseCapabilities,
      capabilitiesProvided: true,
      stopped: () => false,
      setCapabilities: () => undefined,
      control: control as never,
      terminal: terminal as never,
      metrics: new NodeMetrics(),
      heartbeatMs: 60_000,
      refreshMs: 60_000,
      onRegistered
    });

    await service.register('node-registered', 'credential');

    expect((await loadNodeConfig(configPath)).conversationHosting).toEqual({
      enabled: true,
      storeDirectory: 'hosted-conversations',
      inactiveRetentionDays: 60
    });
    expect(onRegistered).toHaveBeenCalledOnce();
    expect(control.send.mock.invocationCallOrder[0]).toBeGreaterThan(
      onRegistered.mock.invocationCallOrder[0]!
    );
    service.stop();
  });
});

function baseCapabilities(): NodeCapabilities {
  return {
    platform: 'linux',
    architecture: 'x64',
    nodeAppVersion: '0.9.26',
    nodeVersion: process.version,
    codex: { available: false },
    claudeCode: { available: false },
    openCode: { available: false },
    marAgent: { available: true, version: '0.9.26' }
  };
}

function draft(): ConversationTemplateDraft {
  return {
    templateId: 'template-1',
    nodeId: 'node-1',
    workspaceId: 'workspace-1',
    revision: 1,
    name: 'Research',
    description: 'Research template',
    allowedModels: [{ modelId: 'model-1', name: 'Model One' }],
    defaultModelId: 'model-1',
    mcpIds: [],
    networkMode: 'NONE',
    quotas: {
      maxStorageBytes: 1_000_000,
      maxUploadBytes: 100_000
    },
    updatedAt: 1_900
  };
}

async function initializeConversationHosting(connector: NodeConnector): Promise<void> {
  const target = connector as unknown as {
    conversationHosting: ConversationHostingLifecycleService;
    capabilities: NodeCapabilities;
  };
  await target.conversationHosting.initialize();
  target.capabilities = await target.conversationHosting.project(target.capabilities);
}

function readCapabilities(connector: NodeConnector): NodeCapabilities {
  return (connector as unknown as { capabilities: NodeCapabilities }).capabilities;
}

async function execute(
  connector: NodeConnector,
  operation: string,
  data: unknown
): Promise<unknown> {
  return (
    connector as unknown as {
      executeNodeOperation(operation: string, data: unknown): Promise<unknown>;
    }
  ).executeNodeOperation(operation, data);
}

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'mar-node-conversation-connector-'));
  directories.push(path);
  return path;
}
