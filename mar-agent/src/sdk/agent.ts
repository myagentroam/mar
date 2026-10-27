import { addModelCredentialProviders, resolveAgentModels } from './model-runtime.js';
import type { ResolvedModelConfiguration } from './model-runtime.js';
import { createSessionOpener } from './session.js';
import { SessionRuntime } from './session-runtime.js';
import { SessionRegistry } from './session-registry.js';
import { SessionMaintenanceCoordinator, completeAgentCleanup } from './session-maintenance.js';

import { AgentError } from '../error.js';
import { ExtensionManager } from '../extensions/manager.js';
import { extensionToolRuntime } from './extension-tool-runtime.js';
import { ExtensionStore } from '../extensions/store.js';
import { createExtensionModels } from './extension-models.js';
import { negotiateHost } from '../host/contracts.js';
import { toolCallers } from '../tools/callers.js';
import { AnthropicMessagesAdapter } from '../model/anthropic-messages.js';
import {
  type AgentModelConfiguration,
  type ModelCredentialProvider
} from '../model/configuration.js';
import type { ModelAdapter } from '../model/contracts.js';
import { OpenAiResponsesAdapter } from '../model/openai-responses.js';
import { JsonlSessionStore } from '../session/store/jsonl/jsonl-store.js';
import type { SessionStore } from '../session/store/contracts.js';
import type { CreateAgentOptions, CreateSessionInput, Agent } from './types.js';

/** Validate models before Host negotiation and expose only built-in protocol adapters. */
export async function createAgent(options: CreateAgentOptions): Promise<Agent> {
  if (Object.hasOwn(options, 'adapterFactory'))
    throw new AgentError(
      'MAR_AGENT_MODEL_CONFIG_INVALID',
      'Custom model adapters are not supported.'
    );
  return createAgentWithAdapter(options);
}

/** Package-internal seam for deterministic adapter tests; not a package export. */
export async function createAgentWithAdapter(
  options: CreateAgentOptions,
  adapterFactory?: (configuration: AgentModelConfiguration) => ModelAdapter
): Promise<Agent> {
  const resolvedModels = resolveAgentModels(options.models);
  let { models, defaultModelId } = resolvedModels;
  let modelGeneration = 0;
  const { credentialProviders } = resolvedModels;
  let retainedExtensionProviders:
    { revision: string | undefined; providers: typeof credentialProviders } | undefined;
  const description = negotiateHost(await options.host.describe());
  if (description.mode !== options.mode)
    throw new AgentError('MAR_AGENT_HOST_INCOMPATIBLE', 'Host mode does not match Agent mode.');
  if (options.sessionStore === null)
    throw new AgentError('MAR_AGENT_SESSION_STORE_INVALID', 'Session store must not be null.');
  const ownsStore = options.sessionStore === undefined;
  const store: SessionStore =
    options.sessionStore ?? (await JsonlSessionStore.open(description.homeDirectory));
  // The same adapter can be borrowed concurrently by Execution and Extension operations.
  const activeExecutionAdapters = new Map<ModelAdapter, number>();
  const activeAdapterReferences = {
    add(adapter: ModelAdapter) {
      activeExecutionAdapters.set(adapter, (activeExecutionAdapters.get(adapter) ?? 0) + 1);
    },
    delete(adapter: ModelAdapter) {
      const references = activeExecutionAdapters.get(adapter);
      if (references === undefined) return;
      if (references === 1) activeExecutionAdapters.delete(adapter);
      else activeExecutionAdapters.set(adapter, references - 1);
    }
  };
  const sessionRuntimes = new SessionRegistry<SessionRuntime>();
  const sessionWriterOwner = {};
  let disposed = false;
  let disposal: Promise<void> | undefined;
  let maintenanceCoordinator: SessionMaintenanceCoordinator;
  const assertSessionAdmission = (sessionId?: string): void =>
    maintenanceCoordinator.assertAdmission(sessionId);
  let reconfiguration: Promise<void> | undefined;
  const createAdapter = (
    modelId: string,
    configuredModels: ReadonlyMap<string, ResolvedModelConfiguration> = models
  ): ModelAdapter => {
    const configuration = configuredModels.get(modelId);
    if (!configuration)
      throw new AgentError('MAR_AGENT_MODEL_DISABLED', 'Selected model is unavailable.');
    return (
      adapterFactory?.(configuration) ??
      (configuration.protocol === 'OPENAI_RESPONSES'
        ? new OpenAiResponsesAdapter(configuration)
        : new AnthropicMessagesAdapter(configuration))
    );
  };
  const activeSessionIds = (): ReadonlySet<string> =>
    new Set(
      [...sessionRuntimes].flatMap(([id, runtime]) =>
        runtime.activeExecutionId === undefined ? [] : [id]
      )
    );
  const extensions = new ExtensionManager({
    toolRuntime: extensionToolRuntime,
    store: (directory, run) => new ExtensionStore(directory).bind(run),
    ...(options.host.extensionPorts === undefined
      ? {}
      : { hostPorts: options.host.extensionPorts }),
    extensions: options.extensions ?? [],
    capabilities: [
      'tools',
      'prompts',
      'commands',
      'clock',
      'services',
      'hooks',
      'observability',
      'models',
      'data.state',
      'data.checkpoint',
      'data.store',
      'session',
      'agents',
      'settings',
      ...(options.host.extensionPorts?.environment ? ['environment'] : []),
      ...(options.host.extensionPorts?.files ? ['files'] : []),
      ...(options.host.extensionPorts?.network ? ['network'] : []),
      ...(options.host.extensionPorts?.mcp ? ['mcp'] : []),
      ...(options.host.extensionPorts?.processes ? ['processes'] : [])
    ],
    models: createExtensionModels(
      () => ({ models, defaultModelId }),
      createAdapter,
      activeAdapterReferences,
      (snapshot, call) => {
        const runtime = sessionRuntimes.get(call.sessionId);
        if (!runtime)
          throw new AgentError(
            'MAR_AGENT_MODEL_SNAPSHOT_INVALID',
            'Request snapshot is unavailable.'
          );
        return runtime.resolveRequest(snapshot);
      },
      options.host.modelUsage === undefined
        ? undefined
        : (usage, call) =>
            options.host.modelUsage!({
              ...usage,
              sessionId: call.sessionId,
              ...(call.executionId === undefined ? {} : { executionId: call.executionId }),
              purpose: 'other',
              agentRole:
                sessionRuntimes.get(call.sessionId)?.sourceType === 'subagent' ? 'subagent' : 'root'
            })
    ),
    sessionBackend: (id) => sessionRuntimes.get(id)?.sessionBackend,
    agentsBackend: (id) => sessionRuntimes.get(id)?.agentsBackend,
    scheduleTool: (id) => (definition, run) => {
      const schedule = sessionRuntimes.get(id)?.scheduleTool;
      if (!schedule)
        throw new AgentError(
          'MAR_AGENT_TOOL_NOT_AVAILABLE',
          'Session tool scheduler is unavailable.'
        );
      return schedule(definition, run);
    },
    baseTools: (id, context) => {
      const execution = sessionRuntimes.get(id)?.execution?.toolSources;
      if (context?.executionId && execution?.executionId === context.executionId)
        return execution.bindings;
      return (options.host.extensionPorts?.tools?.catalog(id, context?.executionId) ?? []).map(
        (source) => ({
          definition: {
            ...source.definition,
            allowedCallers: [
              ...toolCallers({
                ...source.definition,
                allowedCallers:
                  source.definition.allowedCallers ??
                  (source.mcp ? ['direct', 'programmatic'] : ['direct'])
              })
            ]
          },
          source: source.source,
          ...(source.mcp === undefined ? {} : { mcp: source.mcp }),
          ...(source.available === undefined ? {} : { available: source.available.bind(source) }),
          invoke: source.execute.bind(source)
        })
      );
    },
    allowTool: (id, name, definition) => {
      const runtime = sessionRuntimes.get(id);
      return !(runtime?.sourceType === 'subagent' && definition?.agentScope === 'ROOT_ONLY');
    },
    checkpoint: {
      read: async (extensionId, key, call) => {
        call.signal.throwIfAborted();
        return store.readExtensionCheckpoint(call.sessionId, extensionId, key);
      },
      write: (extensionId, key, value, expectedRevision, call) =>
        store.writeExtensionCheckpoint(call.sessionId, extensionId, key, value, expectedRevision, {
          owner: sessionWriterOwner,
          signal: call.signal,
          ...(call.executionId ? { executionId: call.executionId } : {}),
          ...(call.turnId ? { turnId: call.turnId } : {})
        })
    },
    busyExcept: (sessionId) => [...activeSessionIds()].some((id) => id !== sessionId)
  });
  const activeAdaptersExcept = (sessionId: string): ReadonlySet<ModelAdapter> => {
    const activeAdapters = new Set<ModelAdapter>(activeExecutionAdapters.keys());
    for (const [candidateSessionId, runtime] of sessionRuntimes)
      if (candidateSessionId !== sessionId && activeSessionIds().has(candidateSessionId))
        runtime.collectActiveModelAdapters(activeAdapters);
    return activeAdapters;
  };
  const settings: Pick<CreateAgentOptions, 'workspaceMapping' | 'systemInstruction'> = {
    ...(options.workspaceMapping === undefined
      ? {}
      : { workspaceMapping: options.workspaceMapping }),
    ...(options.systemInstruction === undefined
      ? {}
      : { systemInstruction: options.systemInstruction })
  };
  maintenanceCoordinator = new SessionMaintenanceCoordinator(
    store,
    sessionRuntimes,
    extensions,
    options.host,
    sessionWriterOwner,
    () => disposed,
    () => modelGeneration
  );
  const openSession = createSessionOpener({
    host: options.host,
    description,
    settings,
    store,
    extensions,
    agentResources: {
      activeExecutionAdapters: activeAdapterReferences,
      sessionRuntimes,
      sessionWriterOwner
    },
    hasCustomAdapters: adapterFactory !== undefined,
    modelState: () => ({ models, defaultModelId, generation: modelGeneration }),
    createAdapter,
    activeAdaptersExcept,
    openEpoch: (sessionId) => maintenanceCoordinator.epoch(sessionId),
    canPublishSession: (sessionId, epoch) => maintenanceCoordinator.canPublish(sessionId, epoch),
    assertSessionAdmission,
    assertCanStart: (sessionId) => {
      assertSessionAdmission(sessionId);
      if (reconfiguration)
        throw new AgentError(
          'MAR_AGENT_EXECUTION_ACTIVE',
          'Models are being reconfigured for the next execution.'
        );
    }
  });
  return {
    extensionDiagnostics: () => extensions.diagnostics(),
    createSession: async (input: CreateSessionInput) => {
      assertSessionAdmission();
      return sessionRuntimes.trackOpen(undefined, async () =>
        openSession((await store.createSession(input)).id, input.workspace)
      );
    },
    openSession: (id) => openSession(id),
    listSessions: async (input) => {
      assertSessionAdmission();
      return store.list(input);
    },
    getSession: async (id) => {
      assertSessionAdmission();
      return store.getSession(id);
    },
    setSessionTitle: async (id, title, input) => {
      assertSessionAdmission();
      return store.updateTitle(
        id,
        title,
        { ...input, automatic: input?.automatic ?? false },
        sessionWriterOwner
      );
    },
    clearSession: (id) => maintenanceCoordinator.clear(id),
    setSystemInstruction: (systemInstruction) => {
      if (disposed) throw new AgentError('MAR_AGENT_DISPOSED', 'Agent is disposed.');
      if (systemInstruction === undefined) delete settings.systemInstruction;
      else settings.systemInstruction = systemInstruction;
    },
    reconfigureModels: async (input) => {
      if (disposed) throw new AgentError('MAR_AGENT_DISPOSED', 'Agent is disposed.');
      if (reconfiguration)
        throw new AgentError(
          'MAR_AGENT_EXECUTION_ACTIVE',
          'Models are already being reconfigured for the next execution.'
        );
      const next = resolveAgentModels(input.models, input.defaultModelId);
      const activeSessions = activeSessionIds();
      if (
        [...activeSessions].some(
          (sessionId) => sessionRuntimes.get(sessionId)?.sourceType !== 'subagent'
        )
      )
        throw new AgentError(
          'MAR_AGENT_EXECUTION_ACTIVE',
          'Models cannot be reconfigured while a main execution is active.'
        );
      const activeAdapters = new Set<ModelAdapter>(activeExecutionAdapters.keys());
      for (const [sessionId, runtime] of sessionRuntimes)
        if (activeSessions.has(sessionId)) runtime.collectActiveModelAdapters(activeAdapters);
      const inactiveRuntimes = [...sessionRuntimes].flatMap(([sessionId, runtime]) =>
        activeSessions.has(sessionId) ? [] : [runtime]
      );
      const completion = Promise.withResolvers<void>();
      reconfiguration = completion.promise;
      void completion.promise.catch(() => undefined);
      let interruptedByDisposal = false;
      try {
        const commitSessionGeneration = await SessionRuntime.stageModelReconfiguration(
          inactiveRuntimes,
          next.models,
          activeAdapters,
          () => {
            if (disposed) {
              interruptedByDisposal = true;
              throw new AgentError('MAR_AGENT_DISPOSED', 'Agent is disposed.');
            }
          }
        );
        // The final admission check and all committed state changes share one synchronous turn.
        commitSessionGeneration(modelGeneration + 1);
        if (extensions.hasReferences() || activeSessions.size > 0) {
          if (
            !retainedExtensionProviders ||
            retainedExtensionProviders.revision !== extensions.revision
          ) {
            const providers = new Set<ModelCredentialProvider>();
            for (const configuration of models.values())
              addModelCredentialProviders(providers, configuration);
            // A pending composition retains its original providers, not every intermediate catalog.
            retainedExtensionProviders = { revision: extensions.revision, providers };
          }
        } else {
          retainedExtensionProviders = undefined;
        }
        models = next.models;
        defaultModelId = next.defaultModelId;
        modelGeneration++;
        for (const provider of next.credentialProviders) credentialProviders.add(provider);
        const liveProviders = new Set(next.credentialProviders);
        for (const provider of retainedExtensionProviders?.providers ?? [])
          liveProviders.add(provider);
        for (const adapter of activeExecutionAdapters.keys())
          addModelCredentialProviders(liveProviders, adapter.configuration);
        for (const runtime of sessionRuntimes.values())
          runtime.collectModelCredentialProviders(liveProviders);
        const obsoleteProviders = [...credentialProviders].filter(
          (provider) => !liveProviders.has(provider)
        );
        const providerCloseResults = await Promise.allSettled(
          obsoleteProviders.map(async (provider) => provider.close())
        );
        for (const [index, result] of providerCloseResults.entries())
          if (result.status === 'fulfilled') credentialProviders.delete(obsoleteProviders[index]!);
      } catch (error) {
        if (!interruptedByDisposal) completion.reject(error);
        throw error;
      } finally {
        completion.resolve();
        if (reconfiguration === completion.promise) reconfiguration = undefined;
      }
    },
    deleteSession: (id) => maintenanceCoordinator.delete(id),
    dispose: () => {
      if (disposal) return disposal;
      disposed = true;
      for (const runtime of sessionRuntimes.values()) runtime.cancelExecutions();
      // Explicit end observers finish in a separate lifecycle frame before Session retirement.
      const runtimes = [...sessionRuntimes.values()];
      const pendingReconfiguration = reconfiguration;
      disposal = completeAgentCleanup([
        () => sessionRuntimes.whenIdle(),
        () => maintenanceCoordinator.join(),
        () => extensions.dispose(),
        ...runtimes.map((runtime) => () => runtime.retireInputs()),
        ...runtimes.map((runtime) => () => runtime.disposeSubagents()),
        () => Promise.all(runtimes.map((runtime) => runtime.joinExecutions())),
        () => pendingReconfiguration,
        () => SessionRuntime.closeModelAdapters(runtimes),
        () =>
          completeAgentCleanup([...credentialProviders].map((provider) => () => provider.close())),
        () => options.host.dispose(),
        () => (ownsStore ? store.close() : undefined)
      ]);
      return disposal;
    }
  };
}
