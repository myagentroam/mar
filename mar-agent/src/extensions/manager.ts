import { AgentError } from '../error.js';
import type { ExtensionToolRuntime } from './tool-runtime.js';
import type {
  AgentExtensionContext,
  ExtensionCapabilitySnapshot,
  ExtensionDiagnostic,
  ExtensionSnapshot,
  ExtensionSource,
  AgentExtension
} from './contracts.js';
import { ExtensionOperations, type ExtensionOperationContext } from './operation.js';
import { ExtensionResourceScope } from './resources.js';
import { ExtensionServices } from './services.js';
import { ExtensionSession } from './session.js';
import type { ExtensionToolBinding } from './tools.js';
import type { ExtensionModelsBackend } from './models.js';
import type { ExtensionCheckpointBackend, ExtensionStoreBackend } from './data.js';
import type { ExtensionSessionBackend } from './session-input.js';
import { coreSettingsBinding, settingsCapabilities } from './settings.js';
import type { AgentHostExtensionPorts } from './host-ports.js';

export interface ExtensionManagerOptions {
  readonly toolRuntime: ExtensionToolRuntime;
  readonly hostPorts?: AgentHostExtensionPorts;
  readonly extensions: readonly AgentExtension[] | ExtensionSource;
  readonly capabilities: readonly string[];
  readonly busyExcept: (sessionId: string) => boolean;
  readonly baseTools?: (
    sessionId: string,
    context?: Pick<ExtensionOperationContext, 'executionId'>
  ) => readonly ExtensionToolBinding[];
  readonly models?: ExtensionModelsBackend;
  readonly checkpoint?: ExtensionCheckpointBackend;
  readonly store?: ExtensionStoreBackend;
  readonly sessionBackend?: (sessionId: string) => ExtensionSessionBackend | undefined;
  readonly allowTool?: (
    sessionId: string,
    name: string,
    definition?: ExtensionToolBinding['definition']
  ) => boolean;
  readonly scheduleTool?: (sessionId: string) => ExtensionSession['scheduleTool'];
}

/** Agent admission coordinates a single composition generation, never parallel replacement loops. */
export class ExtensionManager {
  readonly operations = new ExtensionOperations();
  readonly #diagnostics: ExtensionDiagnostic[] = [];
  readonly #sessions = new Map<string, ExtensionSession>();
  readonly #epochs = new Map<string, number>();
  readonly #controller = new AbortController();
  #agentServices = new ExtensionServices('agent');
  #agentScopes: ExtensionResourceScope[] = [];
  #setupFailures = new Set<string>();
  #strictSetupFailure = false;
  readonly #strictSessions = new Set<string>();
  readonly #cleanupFailedSessions = new Set<string>();
  #cleanupFailed = false;
  #snapshot: ExtensionSnapshot | undefined;
  #orders: Record<'agent' | 'session', ReturnType<typeof ordered>> = {
    agent: { extensions: [], failures: [] },
    session: { extensions: [], failures: [] }
  };
  #tail: Promise<unknown> = Promise.resolve();
  #disposal: Promise<void> | undefined;
  readonly #endings = new WeakMap<ExtensionSession, Promise<void>>();
  readonly capabilities: ExtensionCapabilitySnapshot;

  constructor(readonly options: ExtensionManagerOptions) {
    const capabilities = Object.freeze([...new Set(options.capabilities)]);
    this.capabilities = Object.freeze({
      has: (id: string) => capabilities.includes(id),
      list: () => capabilities
    });
  }

  diagnostics(): readonly ExtensionDiagnostic[] {
    return [...this.#diagnostics];
  }
  session(id: string): ExtensionSession | undefined {
    return this.#sessions.get(id);
  }
  get revision(): string | undefined {
    return this.#snapshot?.revision;
  }
  hasReferences(): boolean {
    return [...this.#sessions.values()].some((session) => session.hasReferences);
  }

  prepare(
    sessionId: string,
    signal: AbortSignal,
    baseTools?: readonly ExtensionToolBinding[],
    refresh = true
  ): Promise<ExtensionSession> {
    const loadingSignal = AbortSignal.any([signal, this.#controller.signal]);
    // A retiring owner may join a child whose admission would otherwise queue behind disposal.
    if (loadingSignal.aborted) return Promise.reject(loadingSignal.reason);
    if (this.#sessions.get(sessionId)?.isEnding)
      return Promise.reject(new AgentError('MAR_AGENT_SESSION_CLOSING', 'Session is closing.'));
    return this.#serial(async () => {
      loadingSignal.throwIfAborted();
      if (this.#sessions.get(sessionId)?.isEnding)
        throw new AgentError('MAR_AGENT_SESSION_CLOSING', 'Session is closing.');
      if (this.#cleanupFailed || this.#cleanupFailedSessions.has(sessionId))
        throw new AgentError(
          'MAR_AGENT_EXTENSION_CLEANUP_FAILED',
          'Retired extension resources did not clean up.'
        );
      const source = this.options.extensions;
      const resolved =
        !refresh && this.#snapshot
          ? this.#snapshot
          : Array.isArray(source)
            ? { revision: 'static', extensions: source }
            : await (source as ExtensionSource).resolve({ signal: loadingSignal });
      loadingSignal.throwIfAborted();
      this.#validateSnapshot(resolved);
      if (!this.#snapshot || this.#snapshot.revision !== resolved.revision) {
        if (this.#snapshot && (this.options.busyExcept(sessionId) || this.hasReferences())) {
          this.#diagnose({
            code: 'MAR_AGENT_EXTENSION_UPDATE_PENDING',
            sessionId,
            revision: resolved.revision
          });
        } else {
          const orders = {
            agent: ordered(resolved.extensions, 'agent'),
            session: ordered(resolved.extensions, 'session')
          };
          await this.#retire();
          loadingSignal.throwIfAborted();
          this.#snapshot = {
            revision: resolved.revision,
            extensions: resolved.extensions.map((extension) =>
              Object.freeze({
                ...extension,
                bindings: Object.freeze({ ...(extension.bindings ?? {}) })
              })
            )
          };
          this.#orders = orders;
          try {
            await this.#setup(loadingSignal);
          } catch (error) {
            if (loadingSignal.aborted) {
              await this.#retire();
              this.#snapshot = undefined;
            }
            throw error;
          }
        }
      }
      if (this.#strictSetupFailure)
        throw new AgentError(
          'MAR_AGENT_EXTENSION_COMPOSITION_FAILED',
          'Required extension initialization failed.'
        );
      let session = this.#sessions.get(sessionId);
      if (!session) {
        session = new ExtensionSession(
          this.options.toolRuntime,
          sessionId,
          this.#epochs.get(sessionId) ?? 0,
          this.#agentServices,
          this.operations,
          this.capabilities,
          (diagnostic) => this.#diagnose(diagnostic),
          (context) => this.options.baseTools?.(sessionId, context) ?? [],
          this.options.models,
          this.options.checkpoint,
          this.options.sessionBackend?.(sessionId),
          this.options.hostPorts,
          (name, definition) => this.options.allowTool?.(sessionId, name, definition) ?? true,
          this.options.scheduleTool?.(sessionId),
          this.options.store
        );
        this.#sessions.set(sessionId, session);
        try {
          await this.#attach(session, loadingSignal, baseTools);
        } catch (error) {
          if (loadingSignal.aborted) {
            await session.dispose();
            this.#sessions.delete(sessionId);
          }
          throw error;
        }
      }
      if (this.#strictSessions.has(sessionId))
        throw new AgentError(
          'MAR_AGENT_EXTENSION_COMPOSITION_FAILED',
          'Required Session extension initialization failed.'
        );
      return session;
    });
  }

  clearSession(id: string): Promise<void> {
    this.retireSession(id);
    return this.#serial(async () => {
      try {
        await this.#sessions.get(id)?.dispose();
      } catch (error) {
        this.#cleanupFailedSessions.add(id);
        this.#diagnose({ code: 'MAR_AGENT_EXTENSION_CLEANUP_FAILED', sessionId: id });
        throw error;
      }
      this.#sessions.delete(id);
      this.#strictSessions.delete(id);
      this.#epochs.set(id, (this.#epochs.get(id) ?? 0) + 1);
    });
  }

  async endSession(id: string, reason: 'clear' | 'other', resumable = true): Promise<void> {
    const session = this.#sessions.get(id);
    if (!session) return;
    const previous = this.#endings.get(session);
    if (previous) return previous;
    session.isEnding = true;
    const controller = new AbortController();
    const ending = Promise.resolve().then(async () => {
      try {
        await this.operations.enter(
          {
            sessionId: id,
            sessionEpoch: session.epoch,
            actor: 'sdk',
            entry: 'native-api',
            signal: controller.signal
          },
          (call) => session.hooks.emit('session.ending', { sessionId: id, reason, resumable }, call)
        );
      } finally {
        controller.abort();
      }
    });
    this.#endings.set(session, ending);
    return ending;
  }

  retireSession(id: string): void {
    this.#sessions.get(id)?.retire();
  }

  dispose(): Promise<void> {
    if (this.#disposal) return this.#disposal;
    this.#controller.abort();
    const endings: Promise<void>[] = [];
    for (const [id, session] of this.#sessions) {
      if (session.hooks.hasObservers('session.ending')) endings.push(this.endSession(id, 'other'));
      else session.retire();
    }
    for (const scope of this.#agentScopes) scope.retire();
    this.#disposal = (async () => {
      await Promise.all(endings);
      for (const id of this.#sessions.keys()) this.retireSession(id);
      await this.#serial(() => this.#retire());
    })();
    return this.#disposal;
  }

  async #setup(signal: AbortSignal): Promise<void> {
    for (const extension of this.#orders.agent.failures) {
      this.#setupFailures.add(extension.id);
      this.#strictSetupFailure ||= extension.failurePolicy === 'fail-composition';
      this.#diagnose({
        code: 'MAR_AGENT_EXTENSION_DEPENDENCY_CYCLE',
        extensionId: extension.id,
        revision: this.#snapshot!.revision
      });
    }
    for (const extension of this.#orders.agent.extensions) {
      const scope = new ExtensionResourceScope();
      try {
        this.#check(extension, 'agent', this.#agentServices);
        const context: AgentExtensionContext = {
          ...(extension.dataDirectory === undefined
            ? {}
            : {
                data: {
                  store: this.options.store!(extension.dataDirectory, (operation) =>
                    scope.run(operation)
                  )
                }
              }),
          resources: scope,
          services: this.#agentServices.bind(scope),
          capabilities: settingsCapabilities(
            this.capabilities,
            coreSettingsBinding(extension.bindings) !== undefined
          ),
          bindings: extension.bindings ?? {},
          observability: {
            log: (message) =>
              this.#diagnose({
                code: 'MAR_AGENT_EXTENSION_LOG',
                extensionId: extension.id,
                message: message.slice(0, 1000)
              })
          }
        };
        await ExtensionResourceScope.initialize(async () => {
          const release = await extension.setup?.(context);
          if (release) scope.effect(() => release);
          await scope.ready();
        });
        this.#checkProvides(extension, 'agent', this.#agentServices, scope);
        signal.throwIfAborted();
        this.#agentScopes.push(scope);
      } catch (error) {
        this.#setupFailures.add(extension.id);
        this.#strictSetupFailure ||= extension.failurePolicy === 'fail-composition';
        this.#diagnose({
          code: failureCode(error),
          extensionId: extension.id,
          revision: this.#snapshot!.revision
        });
        try {
          await scope.dispose();
        } catch (cleanupError) {
          this.#agentScopes.push(scope);
          this.#cleanupFailed = true;
          this.#diagnose({
            code: 'MAR_AGENT_EXTENSION_CLEANUP_FAILED',
            extensionId: extension.id,
            revision: this.#snapshot!.revision
          });
          throw cleanupError;
        }
        signal.throwIfAborted();
      }
    }
    for (const scope of this.#agentScopes) scope.activate();
  }

  async #attach(
    session: ExtensionSession,
    signal: AbortSignal,
    baseTools?: readonly ExtensionToolBinding[]
  ): Promise<void> {
    for (const extension of this.#orders.session.failures) {
      if (extension.failurePolicy === 'fail-composition') this.#strictSessions.add(session.id);
      this.#diagnose({
        code: 'MAR_AGENT_EXTENSION_DEPENDENCY_CYCLE',
        extensionId: extension.id,
        sessionId: session.id,
        revision: this.#snapshot!.revision
      });
    }
    for (const extension of this.#orders.session.extensions) {
      if (this.#setupFailures.has(extension.id)) continue;
      const scope = new ExtensionResourceScope();
      try {
        this.#check(extension, 'session', session.services, session.capabilities);
        await ExtensionResourceScope.initialize(async () => {
          const release = await extension.attachSession?.(session.context(extension, scope));
          if (release) scope.effect(() => release);
          await scope.ready();
        });
        this.#checkProvides(extension, 'session', session.services, scope);
        session.capture(undefined, true, baseTools);
        signal.throwIfAborted();
        session.scopes.push(scope);
      } catch (error) {
        if (extension.failurePolicy === 'fail-composition') this.#strictSessions.add(session.id);
        this.#diagnose({
          code: failureCode(error),
          extensionId: extension.id,
          sessionId: session.id,
          revision: this.#snapshot!.revision
        });
        try {
          await scope.dispose();
        } catch (cleanupError) {
          session.scopes.push(scope);
          this.#cleanupFailedSessions.add(session.id);
          this.#diagnose({
            code: 'MAR_AGENT_EXTENSION_CLEANUP_FAILED',
            extensionId: extension.id,
            sessionId: session.id,
            revision: this.#snapshot!.revision
          });
          throw cleanupError;
        }
        signal.throwIfAborted();
      }
    }
    session.activate();
  }

  #check(
    extension: AgentExtension,
    scope: 'agent' | 'session',
    services: ExtensionServices,
    availableCapabilities: ExtensionCapabilitySnapshot = this.capabilities
  ): void {
    if (extension.apiVersion !== '1.0')
      throw new AgentError(
        'MAR_AGENT_EXTENSION_API_INCOMPATIBLE',
        'Extension API version is incompatible.'
      );
    const capabilities = settingsCapabilities(
      availableCapabilities,
      coreSettingsBinding(extension.bindings) !== undefined
    );
    if (extension.requires?.some((requirement) => !capabilities.has(requirement.id)))
      throw new AgentError(
        'MAR_AGENT_EXTENSION_DEPENDENCY_MISSING',
        'Required capability is unavailable.'
      );
    if (scope === 'agent' && !extension.setup) return;
    for (const dependency of extension.serviceDependencies ?? []) {
      if (scope === 'agent' && dependency.key.scope !== 'agent') continue;
      if (scope === 'session' && dependency.key.scope === 'agent' && extension.setup) continue;
      if (dependency.key.scope === scope || scope === 'session') {
        if (!dependency.optional && !services.has(dependency.key))
          throw new AgentError(
            'MAR_AGENT_EXTENSION_DEPENDENCY_MISSING',
            'Required service is unavailable.'
          );
      }
    }
  }

  #checkProvides(
    extension: AgentExtension,
    scope: 'agent' | 'session',
    services: ExtensionServices,
    owner: ExtensionResourceScope
  ): void {
    if (
      extension.provides?.some(
        (declaration) =>
          declaration.key.scope === scope && !services.hasOwned(declaration.key, owner)
      )
    )
      throw new AgentError(
        'MAR_AGENT_EXTENSION_DEPENDENCY_MISSING',
        'Declared service was not provided.'
      );
  }

  #validateSnapshot(snapshot: ExtensionSnapshot): void {
    if (
      !snapshot ||
      typeof snapshot.revision !== 'string' ||
      !snapshot.revision ||
      !Array.isArray(snapshot.extensions) ||
      snapshot.extensions.some(
        (extension) => !extension || typeof extension.id !== 'string' || !extension.id.trim()
      ) ||
      new Set(snapshot.extensions.map((extension) => extension.id)).size !==
        snapshot.extensions.length
    )
      throw new AgentError(
        'MAR_AGENT_EXTENSION_SOURCE_INVALID',
        'Extension snapshot is inconsistent.'
      );
  }

  async #retire(): Promise<void> {
    for (const session of this.#sessions.values()) session.retire();
    for (const scope of this.#agentScopes) scope.retire();
    let failures = 0;
    for (const session of this.#sessions.values()) {
      try {
        await session.dispose();
      } catch {
        failures++;
      }
    }
    for (const scope of [...this.#agentScopes].reverse()) {
      try {
        await scope.dispose();
      } catch {
        failures++;
      }
    }
    if (failures) {
      this.#cleanupFailed = true;
      this.#diagnose({ code: 'MAR_AGENT_EXTENSION_CLEANUP_FAILED' });
      throw new AgentError('MAR_AGENT_EXTENSION_CLEANUP_FAILED', 'Composition cleanup failed.', {
        details: { failures }
      });
    }
    this.#sessions.clear();
    this.#agentScopes = [];
    this.#agentServices = new ExtensionServices('agent');
    this.#setupFailures.clear();
    this.#strictSetupFailure = false;
    this.#strictSessions.clear();
    this.#snapshot = undefined;
  }

  #diagnose(diagnostic: ExtensionDiagnostic): void {
    this.#diagnostics.push(Object.freeze({ ...diagnostic }));
    if (this.#diagnostics.length > 200) this.#diagnostics.shift();
  }

  #serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(operation);
    this.#tail = result.catch(() => undefined);
    return result;
  }
}

function failureCode(error: unknown): string {
  return error instanceof AgentError ? error.code : 'MAR_AGENT_EXTENSION_INITIALIZATION_FAILED';
}

/** Declared providers precede consumers; array order remains the tiebreaker for unrelated items. */
function ordered(
  extensions: readonly AgentExtension[],
  scope: 'agent' | 'session'
): { extensions: readonly AgentExtension[]; failures: readonly AgentExtension[] } {
  const providers = new Map<string, AgentExtension[]>();
  for (const extension of extensions)
    for (const declaration of extension.provides ?? []) {
      if (declaration.key.scope !== scope) continue;
      const entries = providers.get(declaration.key.id) ?? [];
      if (!declaration.intent || declaration.intent === 'provide') entries.unshift(extension);
      else entries.push(extension);
      providers.set(declaration.key.id, entries);
    }
  const dependencies = new Map(
    extensions.map((extension) => [extension, new Set<AgentExtension>()])
  );
  for (const entries of providers.values())
    for (let index = 1; index < entries.length; index++)
      dependencies.get(entries[index]!)!.add(entries[index - 1]!);
  for (const extension of extensions)
    for (const dependency of extension.serviceDependencies ?? []) {
      if (dependency.key.scope !== scope || dependency.optional) continue;
      const provider = providers.get(dependency.key.id)?.at(-1);
      if (provider && provider !== extension) dependencies.get(extension)!.add(provider);
    }
  const result: AgentExtension[] = [];
  const visiting = new Set<AgentExtension>();
  const visited = new Set<AgentExtension>();
  const failed = new Set<AgentExtension>();
  const visit = (extension: AgentExtension): boolean => {
    if (visited.has(extension)) return !failed.has(extension);
    if (visiting.has(extension)) {
      failed.add(extension);
      return false;
    }
    visiting.add(extension);
    for (const dependency of dependencies.get(extension)!)
      if (!visit(dependency)) failed.add(extension);
    visiting.delete(extension);
    visited.add(extension);
    if (!failed.has(extension)) result.push(extension);
    return !failed.has(extension);
  };
  for (const extension of extensions) visit(extension);
  return { extensions: result, failures: extensions.filter((extension) => failed.has(extension)) };
}
