import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NodeCapabilities } from '../../../packages/protocol/src/index.js';
import type { NodeConfig } from '../../src/config.js';
import { ConversationHostingLifecycleService } from '../../src/service/conversation-hosting-lifecycle-service.js';
import { ConversationHostingMaintenanceService } from '../../src/service/conversation-hosting-maintenance-service.js';
import { ConversationTemplateNodeService } from '../../src/service/conversation-template-node-service.js';
import { HostedConversationNodeService } from '../../src/service/hosted-conversation-node-service.js';
import { HostedConversationStore } from '../../src/service/hosted-conversation-store.js';
import { MarAgentHostedConversationRuntime } from '../../src/runner/mar-agent/hosted-conversation-runtime.js';

vi.mock('../../src/service/hosted-conversation-store.js', () => ({
  HostedConversationStore: vi.fn(function HostedConversationStoreMock() {})
}));
vi.mock('../../src/service/conversation-template-node-service.js', () => ({
  ConversationTemplateNodeService: vi.fn(function ConversationTemplateNodeServiceMock() {})
}));
vi.mock('../../src/service/hosted-conversation-node-service.js', () => ({
  HostedConversationNodeService: vi.fn(function HostedConversationNodeServiceMock() {})
}));
vi.mock('../../src/service/conversation-hosting-maintenance-service.js', () => ({
  ConversationHostingMaintenanceService: vi.fn(
    function ConversationHostingMaintenanceServiceMock() {}
  )
}));
vi.mock('../../src/runner/mar-agent/hosted-conversation-runtime.js', () => ({
  MarAgentHostedConversationRuntime: vi.fn(function MarAgentHostedConversationRuntimeMock() {})
}));

const directories: string[] = [];

beforeEach(() => {
  vi.resetAllMocks();
});

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

describe('ConversationHostingLifecycleService', () => {
  it.each([false, true])(
    'awaits hosted disposal before runtime disposal (partial=%s)',
    async (partial) => {
      const gate = deferred<void>();
      const start = deferred<void>();
      const fixture = await lifecycleFixture([
        partial ? { failMaintenanceStart: true, maintenanceStartGate: start.promise } : {}
      ]);
      const initialization = fixture.lifecycle.initialize();
      await vi.waitFor(() => expect(fixture.generations).toHaveLength(1));
      const generation = fixture.generations[0]!;
      generation.hostedDispose.mockImplementation(() => gate.promise);
      if (!partial) await initialization;
      start.resolve();
      const closing = partial ? initialization : fixture.lifecycle.dispose();
      await vi.waitFor(() => expect(generation.hostedDispose).toHaveBeenCalledOnce());
      expect(generation.runtimeDispose).not.toHaveBeenCalled();
      gate.resolve();
      await closing;
      expect(generation.runtimeDispose).toHaveBeenCalledOnce();
      expect(fixture.lifecycle.handler('conversation.hosted.list')).toBeUndefined();
    }
  );

  it('releases runtime even when hosted disposal fails', async () => {
    const fixture = await lifecycleFixture();
    await fixture.lifecycle.initialize();
    fixture.generations[0]!.hostedDispose.mockRejectedValue(new Error('HOSTED_DISPOSE_FAILED'));
    await expect(fixture.lifecycle.dispose()).rejects.toThrow('HOSTED_DISPOSE_FAILED');
    expect(fixture.generations[0]!.runtimeDispose).toHaveBeenCalledOnce();
  });

  it('retains the initialization failure when partial cleanup also fails', async () => {
    const start = deferred<void>();
    const fixture = await lifecycleFixture([
      { failMaintenanceStart: true, maintenanceStartGate: start.promise }
    ]);
    const initialization = fixture.lifecycle.initialize();
    await vi.waitFor(() => expect(fixture.generations).toHaveLength(1));
    const generation = fixture.generations[0]!;
    generation.maintenanceDispose.mockRejectedValue(new Error('MAINTENANCE_DISPOSE_FAILED'));
    generation.hostedDispose.mockRejectedValue(new Error('HOSTED_DISPOSE_FAILED'));
    start.resolve();
    await initialization;
    expect(generation.runtimeDispose).toHaveBeenCalledOnce();
    await expect(fixture.lifecycle.project(fixture.capabilities)).resolves.toMatchObject({
      conversationHosting: { state: 'UNAVAILABLE', reasonCode: 'MAINTENANCE_START_FAILED' }
    });
  });

  it('publishes all hosting handlers after initialization and projects ready capability', async () => {
    const fixture = await lifecycleFixture();

    await fixture.lifecycle.initialize();

    expect(fixture.lifecycle.handler('conversation.template.source.inspect')).toBe(
      fixture.generations[0]!.templateHandler
    );
    expect(fixture.lifecycle.handler('conversation.hosted.list')).toBe(
      fixture.generations[0]!.hostedHandler
    );
    expect(fixture.lifecycle.handler('conversation.hosting.storage.inspect')).toBe(
      fixture.generations[0]!.maintenanceHandler
    );
    await expect(fixture.lifecycle.project(fixture.capabilities)).resolves.toMatchObject({
      conversationHosting: {
        state: 'AVAILABLE',
        acceptsNewConversations: true,
        supportsExistingConversations: true,
        capacity: 'AVAILABLE'
      }
    });
  });

  it('keeps partial initialization private and releases it when maintenance startup fails', async () => {
    const fixture = await lifecycleFixture([{}, { failMaintenanceStart: true }]);
    await fixture.lifecycle.initialize();
    const previousHandler = fixture.lifecycle.handler('conversation.hosted.list');
    expect(previousHandler).toBeDefined();

    await fixture.lifecycle.initialize();

    expect(fixture.lifecycle.handler('conversation.hosted.list')).not.toBe(previousHandler);
    expect(fixture.lifecycle.handler('conversation.template.source.inspect')).toBeUndefined();
    expect(fixture.lifecycle.handler('conversation.hosted.list')).toBeUndefined();
    expect(fixture.lifecycle.handler('conversation.hosting.storage.inspect')).toBeUndefined();
    await expect(fixture.lifecycle.project(fixture.capabilities)).resolves.toMatchObject({
      conversationHosting: { state: 'UNAVAILABLE', acceptsNewConversations: false }
    });
    expect(fixture.generations[0]!.maintenanceDispose).toHaveBeenCalledOnce();
    expect(fixture.generations[0]!.hostedDispose).toHaveBeenCalledOnce();
    expect(fixture.generations[0]!.runtimeDispose).toHaveBeenCalledOnce();
    expect(fixture.generations[1]!.maintenanceDispose).toHaveBeenCalledOnce();
    expect(fixture.generations[1]!.hostedDispose).toHaveBeenCalledOnce();
    expect(fixture.generations[1]!.runtimeDispose).toHaveBeenCalledOnce();
  });

  it('replaces disabled resources on reinitialization and keeps resume bound to its original handler', async () => {
    const fixture = await lifecycleFixture();
    await fixture.lifecycle.initialize();
    const originalHandler = fixture.lifecycle.handler('conversation.hosted.list');
    const resumeOriginal = fixture.lifecycle.prepareForDisable();

    await fixture.lifecycle.initialize();
    const replacementHandler = fixture.lifecycle.handler('conversation.hosted.list');
    const resumeReplacement = fixture.lifecycle.prepareForDisable();

    expect(replacementHandler).toBe(fixture.generations[1]!.hostedHandler);
    expect(replacementHandler).not.toBe(originalHandler);
    expect(fixture.generations[0]!.maintenanceDispose).toHaveBeenCalledOnce();
    resumeOriginal?.();
    expect(fixture.generations[1]!.accepting).toBe(false);
    resumeReplacement?.();
    expect(fixture.generations[1]!.accepting).toBe(true);
  });

  it('waits for in-flight initialization on dispose and never publishes its late resources', async () => {
    const startGate = deferred<void>();
    const fixture = await lifecycleFixture([{ maintenanceStartGate: startGate.promise }]);
    const initialization = fixture.lifecycle.initialize();
    await vi.waitFor(() => expect(fixture.generations[0]?.maintenanceStart).toHaveBeenCalledOnce());

    let disposed = false;
    const disposal = fixture.lifecycle.dispose().then(() => {
      disposed = true;
    });
    await Promise.resolve();
    expect(disposed).toBe(false);
    expect(fixture.lifecycle.handler('conversation.hosted.list')).toBeUndefined();

    startGate.resolve();
    await Promise.all([initialization, disposal]);

    expect(fixture.lifecycle.handler('conversation.template.source.inspect')).toBeUndefined();
    expect(fixture.lifecycle.handler('conversation.hosted.list')).toBeUndefined();
    expect(fixture.lifecycle.handler('conversation.hosting.storage.inspect')).toBeUndefined();
    expect(fixture.generations[0]!.maintenanceDispose).toHaveBeenCalledOnce();
    expect(fixture.generations[0]!.hostedDispose).toHaveBeenCalledOnce();
    expect(fixture.generations[0]!.runtimeDispose).toHaveBeenCalledOnce();
  });

  it('ignores capacity completed by a replaced resource when projecting the current capability', async () => {
    const oldCapacity = deferred<{ readonly capacity: 'FULL' }>();
    const fixture = await lifecycleFixture([
      { capacityGate: oldCapacity.promise },
      { capacity: { capacity: 'AVAILABLE' } }
    ]);
    await fixture.lifecycle.initialize();
    const oldProjection = fixture.lifecycle.project(fixture.capabilities);
    await vi.waitFor(() => expect(fixture.generations[0]!.storageCapacity).toHaveBeenCalledOnce());

    await fixture.lifecycle.initialize();
    oldCapacity.resolve({ capacity: 'FULL' });

    await expect(oldProjection).resolves.toMatchObject({
      conversationHosting: {
        state: 'AVAILABLE',
        acceptsNewConversations: true,
        capacity: 'AVAILABLE'
      }
    });
  });
});

interface GenerationPlan {
  readonly failMaintenanceStart?: boolean;
  readonly maintenanceStartGate?: Promise<void>;
  readonly capacity?: { readonly capacity: 'AVAILABLE' | 'HIGH' | 'FULL' };
  readonly capacityGate?: Promise<{ readonly capacity: 'AVAILABLE' | 'HIGH' | 'FULL' }>;
}

interface Generation {
  readonly templateHandler: () => Promise<string>;
  readonly hostedHandler: () => Promise<string>;
  readonly maintenanceHandler: () => Promise<string>;
  readonly maintenanceStart: ReturnType<typeof vi.fn>;
  readonly storageCapacity: ReturnType<typeof vi.fn>;
  readonly maintenanceDispose: ReturnType<typeof vi.fn>;
  readonly hostedDispose: ReturnType<typeof vi.fn>;
  readonly runtimeDispose: ReturnType<typeof vi.fn>;
  accepting: boolean;
}

async function lifecycleFixture(plans: readonly GenerationPlan[] = []) {
  const directory = await mkdtemp(join(tmpdir(), 'mar-node-hosting-lifecycle-'));
  directories.push(directory);
  const generations: Generation[] = [];
  const generationByStore = new WeakMap<object, Generation>();
  let constructing: Generation | undefined;
  const storeInstances: object[] = [];

  vi.mocked(HostedConversationStore).mockImplementation(function createStore() {
    const generation = createGeneration();
    const store = {
      initialize: vi.fn(async () => undefined),
      rebuildConversationIndex: vi.fn(async () => undefined)
    };
    generationByStore.set(store, generation);
    storeInstances.push(store);
    generations.push(generation);
    constructing = generation;
    return store;
  } as never);

  vi.mocked(ConversationTemplateNodeService).mockImplementation(
    function createTemplateService(input: { store: object }) {
      const generation = generationByStore.get(input.store);
      if (!generation) throw new Error('TEST_GENERATION_NOT_FOUND');
      return {
        recoverInterruptedPublications: vi.fn(async () => undefined),
        operations: vi.fn(() => ({
          'conversation.template.source.inspect': generation.templateHandler
        }))
      } as never;
    } as never
  );

  vi.mocked(MarAgentHostedConversationRuntime).mockImplementation(function createRuntime() {
    if (!constructing) throw new Error('TEST_GENERATION_NOT_FOUND');
    return { dispose: constructing.runtimeDispose } as never;
  } as never);

  vi.mocked(HostedConversationNodeService).mockImplementation(function createHostedService(input: {
    store: object;
  }) {
    const generation = generationByStore.get(input.store);
    if (!generation) throw new Error('TEST_GENERATION_NOT_FOUND');
    return {
      dispose: generation.hostedDispose,
      prepareForDisable: vi.fn(() => {
        generation.accepting = false;
        return () => {
          generation.accepting = true;
        };
      }),
      operations: vi.fn(() => ({ 'conversation.hosted.list': generation.hostedHandler }))
    } as never;
  } as never);

  vi.mocked(ConversationHostingMaintenanceService).mockImplementation(
    function createMaintenance(input: { store: object }) {
      const generation = generationByStore.get(input.store);
      if (!generation) throw new Error('TEST_GENERATION_NOT_FOUND');
      const plan = plans[storeInstances.indexOf(input.store)] ?? {};
      generation.maintenanceStart.mockImplementation(async () => {
        await plan.maintenanceStartGate;
        if (plan.failMaintenanceStart) throw new Error('MAINTENANCE_START_FAILED');
      });
      generation.storageCapacity.mockImplementation(async () => {
        if (plan.capacityGate) return plan.capacityGate;
        return plan.capacity ?? { capacity: 'AVAILABLE' };
      });
      return {
        start: generation.maintenanceStart,
        dispose: generation.maintenanceDispose,
        storageCapacity: generation.storageCapacity,
        operations: vi.fn(() => ({
          'conversation.hosting.storage.inspect': generation.maintenanceHandler
        }))
      } as never;
    } as never
  );

  const config: NodeConfig = {
    serverUrl: 'http://node.test',
    allowedRoots: [],
    dataDirectory: join(directory, 'data'),
    nodeId: 'node-1',
    conversationHosting: { enabled: true, storeDirectory: 'hosted-conversations' }
  };
  const capabilities = {
    platform: 'linux',
    nodeAppVersion: '0.10.1',
    marAgent: { available: true }
  } as NodeCapabilities;
  const lifecycle = new ConversationHostingLifecycleService({
    config: () => config,
    configPath: undefined,
    database: () => ({}) as never,
    capabilities: () => capabilities,
    probe: async () => ({ available: true, version: 'test' }),
    runtime: {} as never,
    host: {} as never
  });
  return { lifecycle, generations, capabilities };
}

function createGeneration(): Generation {
  return {
    templateHandler: vi.fn(async () => 'template'),
    hostedHandler: vi.fn(async () => 'hosted'),
    maintenanceHandler: vi.fn(async () => 'maintenance'),
    maintenanceStart: vi.fn(),
    storageCapacity: vi.fn(),
    maintenanceDispose: vi.fn(async () => undefined),
    hostedDispose: vi.fn(),
    runtimeDispose: vi.fn(async () => undefined),
    accepting: true
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
