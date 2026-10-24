import {
  addModelCredentialProviders,
  closeModelAdapters,
  resolveAgentModels
} from './model-runtime.js';
import type { ResolvedModelConfiguration } from './model-runtime.js';
import { createSessionOpener, type SessionRuntime } from './session.js';

import { MarAgentError } from '../error.js';
import { ExtensionManager } from '../extensions/manager.js';
import { createExtensionModels } from './extension-models.js';
import { negotiateHost } from '../host/contracts.js';
import { toolCallers } from '../tools/callers.js';
import { AnthropicMessagesAdapter } from '../model/anthropic-messages.js';
import { type MarAgentModelConfiguration } from '../model/configuration.js';
import type { ModelAdapter } from '../model/contracts.js';
import { OpenAiResponsesAdapter } from '../model/openai-responses.js';
import { JsonlSessionStore } from '../session/store/jsonl-store.js';
import type { SessionStore } from '../session/store/contracts.js';
import type {
  CreateMarAgentOptions,
  CreateSessionInput,
  ExecutionResult,
  MarAgent
} from './types.js';

interface InternalCreateMarAgentOptions extends CreateMarAgentOptions {
  readonly adapterFactory?: (configuration: MarAgentModelConfiguration) => ModelAdapter;
}

/** Validate models before Host negotiation and expose only built-in protocol adapters. */
export async function createMarAgent(options: CreateMarAgentOptions): Promise<MarAgent> {
  if (Object.hasOwn(options, 'adapterFactory'))
    throw new MarAgentError(
      'MAR_AGENT_MODEL_CONFIG_INVALID',
      'Custom model adapters are not supported.'
    );
  return createMarAgentWithAdapter(options);
}

/** Package-internal seam for deterministic adapter tests; not a package export. */
export async function createMarAgentWithAdapter(
  options: InternalCreateMarAgentOptions
): Promise<MarAgent> {
  const resolvedModels = resolveAgentModels(options.models);
  let { models, defaultModelId } = resolvedModels;
  let modelGeneration = 0;
  const { credentialProviders } = resolvedModels;
  const description = negotiateHost(await options.host.describe());
  if (description.mode !== options.mode)
    throw new MarAgentError('MAR_AGENT_HOST_INCOMPATIBLE', 'Host mode does not match Agent mode.');
  if (options.sessionStore === null)
    throw new MarAgentError('MAR_AGENT_SESSION_STORE_INVALID', 'Session store must not be null.');
  const ownsStore = options.sessionStore === undefined;
  const store: SessionStore =
    options.sessionStore ?? (await JsonlSessionStore.open(description.homeDirectory));
  const active = new Map<string, AbortController>();
  const activeExecutionAdapters = new Set<ModelAdapter>();
  const executionResults = new Map<string, Promise<ExecutionResult>>();
  const sessionRuntimes = new Map<string, SessionRuntime>();
  const sessionWriterOwner = {};
  let disposed = false;
  let disposal: Promise<void> | undefined;
  const sessionLifecycles = new Map<
    string,
    { readonly kind: 'clear' | 'delete'; readonly pending: Promise<void> }
  >();
  const assertSessionAdmission = (sessionId?: string): void => {
    if (disposed) throw new MarAgentError('MAR_AGENT_DISPOSED', 'Agent is disposed.');
    if (sessionId !== undefined && sessionLifecycles.has(sessionId))
      throw new MarAgentError('MAR_AGENT_SESSION_CLOSING', 'Session is closing.');
  };
  const trackSessionLifecycle = (
    sessionId: string,
    kind: 'clear' | 'delete',
    operation: () => Promise<void>
  ): Promise<void> => {
    if (disposed)
      return Promise.reject(new MarAgentError('MAR_AGENT_DISPOSED', 'Agent is disposed.'));
    const current = sessionLifecycles.get(sessionId);
    if (current)
      return current.kind === kind
        ? current.pending
        : Promise.reject(new MarAgentError('MAR_AGENT_SESSION_CLOSING', 'Session is closing.'));
    const completion = Promise.withResolvers<void>();
    const pending = completion.promise.finally(() => sessionLifecycles.delete(sessionId));
    // Register before any lifecycle callback can yield or re-enter the SDK.
    sessionLifecycles.set(sessionId, { kind, pending });
    void pending.catch(() => undefined);
    try {
      completion.resolve(operation());
    } catch (error) {
      completion.reject(error);
    }
    return pending;
  };
  let reconfiguration: Promise<void> | undefined;
  const createAdapter = (
    modelId: string,
    configuredModels: ReadonlyMap<string, ResolvedModelConfiguration> = models
  ): ModelAdapter => {
    const configuration = configuredModels.get(modelId);
    if (!configuration)
      throw new MarAgentError('MAR_AGENT_MODEL_DISABLED', 'Selected model is unavailable.');
    return (
      options.adapterFactory?.(configuration) ??
      (configuration.protocol === 'OPENAI_RESPONSES'
        ? new OpenAiResponsesAdapter(configuration)
        : new AnthropicMessagesAdapter(configuration))
    );
  };
  const activeSessionIds = (): ReadonlySet<string> =>
    new Set([...active.keys()].map((key) => key.slice(0, key.indexOf(':'))));
  const extensions = new ExtensionManager({
    ...(options.host.extensionPorts === undefined
      ? {}
      : { hostPorts: options.host.extensionPorts }),
    extensions: options.runtimeExtensions ?? [],
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
      (snapshot, call) => {
        const snapshots = sessionRuntimes.get(call.sessionId)?.requestSnapshots;
        if (!snapshots)
          throw new MarAgentError(
            'MAR_AGENT_MODEL_SNAPSHOT_INVALID',
            'Request snapshot is unavailable.'
          );
        return snapshots.resolve(snapshot);
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
        throw new MarAgentError(
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
    const activeAdapters = new Set<ModelAdapter>();
    for (const [candidateSessionId, runtime] of sessionRuntimes)
      if (candidateSessionId !== sessionId && activeSessionIds().has(candidateSessionId))
        for (const adapter of runtime.adapters.values()) activeAdapters.add(adapter);
    return activeAdapters;
  };
  const settings: Pick<CreateMarAgentOptions, 'workspaceMapping' | 'systemInstruction'> = {
    ...(options.workspaceMapping === undefined
      ? {}
      : { workspaceMapping: options.workspaceMapping }),
    ...(options.systemInstruction === undefined
      ? {}
      : { systemInstruction: options.systemInstruction })
  };
  const openSession = createSessionOpener({
    host: options.host,
    description,
    settings,
    store,
    extensions,
    registry: {
      active,
      activeExecutionAdapters,
      executionResults,
      sessionRuntimes,
      sessionWriterOwner
    },
    hasCustomAdapters: options.adapterFactory !== undefined,
    modelState: () => ({ models, defaultModelId, generation: modelGeneration }),
    createAdapter,
    activeAdaptersExcept,
    assertSessionAdmission,
    assertCanStart: (sessionId) => {
      assertSessionAdmission(sessionId);
      if (reconfiguration)
        throw new MarAgentError(
          'MAR_AGENT_EXECUTION_ACTIVE',
          'Models are being reconfigured for the next execution.'
        );
    }
  });
  return {
    extensionDiagnostics: () => extensions.diagnostics(),
    createSession: async (input: CreateSessionInput) => {
      assertSessionAdmission();
      return openSession((await store.createSession(input)).id, input.workspace);
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
    clearSession: (id) =>
      trackSessionLifecycle(id, 'clear', async () => {
        const runtime = sessionRuntimes.get(id);
        if ([...active.keys()].some((key) => key.startsWith(`${id}:`)))
          throw new MarAgentError(
            'MAR_AGENT_EXECUTION_ACTIVE',
            'A session cannot be cleared while an execution is active.'
          );
        await extensions.endSession(id, 'clear');
        extensions.retireSession(id);
        await completeAgentCleanup([
          () => extensions.clearSession(id),
          () => runtime?.inputs?.retire(),
          () => runtime?.subagents?.dispose(),
          () => closeModelAdapters(runtime === undefined ? [] : [...runtime.adapters.values()]),
          () => {
            // Existing SDK Session handles share this runtime and remain usable after clear.
            if (runtime) {
              runtime.adapters.clear();
              runtime.adapterGeneration = modelGeneration;
              delete runtime.todo;
              delete runtime.subagents;
              delete runtime.subagentsOpening;
              delete runtime.contextualWorldState;
              delete runtime.inputs;
              delete runtime.requestSnapshots;
            }
          },
          () => options.host.disposeSessionResources?.(id),
          () => store.clearSession(id)
        ]);
      }),
    setSystemInstruction: (systemInstruction) => {
      if (disposed) throw new MarAgentError('MAR_AGENT_DISPOSED', 'Agent is disposed.');
      if (systemInstruction === undefined) delete settings.systemInstruction;
      else settings.systemInstruction = systemInstruction;
    },
    reconfigureModels: async (input) => {
      if (disposed) throw new MarAgentError('MAR_AGENT_DISPOSED', 'Agent is disposed.');
      if (reconfiguration)
        throw new MarAgentError(
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
        throw new MarAgentError(
          'MAR_AGENT_EXECUTION_ACTIVE',
          'Models cannot be reconfigured while a main execution is active.'
        );
      const activeAdapters = new Set<ModelAdapter>(activeExecutionAdapters);
      for (const [sessionId, runtime] of sessionRuntimes)
        if (activeSessions.has(sessionId))
          for (const adapter of runtime.adapters.values()) activeAdapters.add(adapter);
      const inactiveRuntimes = [...sessionRuntimes].flatMap(([sessionId, runtime]) =>
        activeSessions.has(sessionId) ? [] : [runtime]
      );
      const completion = Promise.withResolvers<void>();
      reconfiguration = completion.promise;
      void completion.promise.catch(() => undefined);
      let interruptedByDisposal = false;
      try {
        const reconfigurationCommits = new Map<ModelAdapter, () => void>();
        for (const runtime of inactiveRuntimes)
          for (const [modelId, adapter] of runtime.adapters) {
            if (activeAdapters.has(adapter)) continue;
            const configuration = next.models.get(modelId);
            const commit =
              configuration === undefined ? undefined : adapter.prepareReconfigure?.(configuration);
            if (commit !== undefined) reconfigurationCommits.set(adapter, commit);
          }
        const retainedAdapters = new Set(reconfigurationCommits.keys());
        const adapters = [
          ...new Set(inactiveRuntimes.flatMap((runtime) => [...runtime.adapters.values()]))
        ].filter((adapter) => !activeAdapters.has(adapter) && !retainedAdapters.has(adapter));
        for (const runtime of inactiveRuntimes) {
          for (const [modelId, adapter] of runtime.adapters)
            if (!retainedAdapters.has(adapter)) runtime.adapters.delete(modelId);
        }
        await closeModelAdapters(adapters);
        if (disposed) {
          interruptedByDisposal = true;
          throw new MarAgentError('MAR_AGENT_DISPOSED', 'Agent is disposed.');
        }
        for (const commit of reconfigurationCommits.values()) commit();
        models = next.models;
        defaultModelId = next.defaultModelId;
        modelGeneration++;
        for (const provider of next.credentialProviders) credentialProviders.add(provider);
        for (const runtime of inactiveRuntimes) {
          runtime.adapterGeneration = modelGeneration;
        }
        const liveProviders = new Set(next.credentialProviders);
        for (const adapter of activeExecutionAdapters)
          addModelCredentialProviders(liveProviders, adapter.configuration);
        for (const runtime of sessionRuntimes.values())
          for (const adapter of runtime.adapters.values())
            addModelCredentialProviders(liveProviders, adapter.configuration);
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
    deleteSession: (id) =>
      trackSessionLifecycle(id, 'delete', async () => {
        const sessionIds = await store.sessionTree(id);
        const sessionIdSet = new Set(sessionIds);
        const executionKeys = [...active.keys()].filter((key) =>
          sessionIdSet.has(key.slice(0, key.indexOf(':')))
        );
        for (const key of executionKeys) active.get(key)?.abort();
        await Promise.all(
          sessionIds.map((sessionId) => extensions.endSession(sessionId, 'other', false))
        );
        for (const sessionId of sessionIds) extensions.retireSession(sessionId);
        const runtimes = sessionIds.flatMap((sessionId) => {
          const runtime = sessionRuntimes.get(sessionId);
          sessionRuntimes.delete(sessionId);
          return runtime === undefined ? [] : [runtime];
        });
        await completeAgentCleanup([
          ...sessionIds.map((sessionId) => () => extensions.clearSession(sessionId)),
          ...runtimes.map((runtime) => () => runtime.inputs?.retire()),
          ...runtimes.map((runtime) => () => runtime.subagents?.dispose()),
          () =>
            Promise.allSettled(
              executionKeys.flatMap((key) => {
                const result = executionResults.get(key);
                return result === undefined ? [] : [result];
              })
            ),
          () => closeModelAdapters(runtimes.flatMap((runtime) => [...runtime.adapters.values()])),
          ...sessionIds.map((sessionId) => () => options.host.disposeSessionResources?.(sessionId)),
          () => store.delete(id)
        ]);
      }),
    dispose: () => {
      if (disposal) return disposal;
      disposed = true;
      for (const controller of active.values()) controller.abort();
      // Explicit end observers finish in a separate lifecycle frame before Session retirement.
      const extensionDisposal = extensions.dispose();
      void extensionDisposal.catch(() => undefined);
      const runtimes = [...sessionRuntimes.values()];
      const pendingReconfiguration = reconfiguration;
      disposal = completeAgentCleanup([
        async () => {
          const results = await Promise.allSettled(
            [...sessionLifecycles.values()].map(({ pending }) => pending)
          );
          const failure = results.find((result) => result.status === 'rejected');
          if (failure?.status === 'rejected') throw failure.reason;
        },
        () => extensionDisposal,
        ...runtimes.map((runtime) => () => runtime.inputs?.retire()),
        ...runtimes.map((runtime) => () => runtime.subagents?.dispose()),
        () => Promise.allSettled([...executionResults.values()]),
        () => pendingReconfiguration,
        () => closeModelAdapters(runtimes.flatMap((runtime) => [...runtime.adapters.values()])),
        () =>
          completeAgentCleanup([...credentialProviders].map((provider) => () => provider.close())),
        () => options.host.dispose(),
        () => (ownsStore ? store.close() : undefined)
      ]);
      return disposal;
    }
  };
}

/** Finish independent cleanup steps and preserve the first authoritative failure. */
async function completeAgentCleanup(
  steps: readonly (() => unknown | Promise<unknown>)[]
): Promise<void> {
  let failed = false;
  let failure: unknown;
  for (const step of steps) {
    try {
      await step();
    } catch (error) {
      if (!failed) failure = error;
      failed = true;
    }
  }
  if (failed) throw failure;
}
