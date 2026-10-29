import { closeImageCredentialProviders } from './runtime-model-factory.js';
import { nodeLog } from '../../operational.js';
import {
  createSessionRuntime,
  reconfigureSessionRuntime,
  releaseSessionRuntime,
  resolveMarAgentHostRuntimeConfiguration,
  sessionHostFingerprint,
  HOST_CONFIGURATION_CATEGORIES,
  type HostConfigurationCategory,
  type MarAgentRuntimeRequest,
  type MarAgentRuntimeResources,
  type MarAgentSessionRuntime
} from './session-runtime.js';

export interface MarAgentRunLifetime {
  readonly runId: string;
  readonly signal: AbortSignal;
  readonly cancel: () => void;
  readonly settled: Promise<void>;
}

export interface MarAgentRuntimeUse {
  readonly runtime: MarAgentSessionRuntime;
  assertUsable(): void;
  terminal(): void;
}

interface Entry {
  readonly aliases: Set<string>;
  readonly users: Set<MarAgentRunLifetime>;
  runtime?: MarAgentSessionRuntime;
  current?: MarAgentRunLifetime;
  acquisition?: Promise<MarAgentRuntimeUse>;
  idleTimer?: NodeJS.Timeout;
  release?: { reason: ReleaseReason; result: Promise<void> };
}

type ReleaseReason =
  | 'controller_disposed'
  | 'session_released'
  | 'admission_released'
  | 'host_configuration_changed'
  | 'idle_expired';

export class MarAgentSessionRuntimeRegistry {
  readonly #entries = new Map<string, Entry>();
  #disposed = false;
  #disposePromise?: Promise<void>;

  constructor(
    private readonly resources: MarAgentRuntimeResources,
    private readonly promote: (sessionId: string, nativeId: string) => void,
    private readonly releaseComputerSession: (sessionId: string) => Promise<void>
  ) {}

  findRuntime(alias: string): MarAgentSessionRuntime | undefined {
    const entry = this.#entries.get(alias);
    return entry?.release === undefined ? entry?.runtime : undefined;
  }

  acquire(
    input: MarAgentRuntimeRequest,
    lifetime: MarAgentRunLifetime
  ): Promise<MarAgentRuntimeUse> {
    if (this.#disposed) return Promise.reject(new Error('MAR_AGENT_RUN_CONTROLLER_DISPOSED'));
    const aliases = new Set([input.sessionId, input.externalSessionId ?? input.sessionId]);
    const entries = new Set(
      [...aliases].flatMap((alias) => {
        const entry = this.#entries.get(alias);
        return entry === undefined ? [] : [entry];
      })
    );
    if (entries.size > 1) return Promise.reject(new Error('MAR_AGENT_SESSION_RUNTIME_ACTIVE'));
    const entry = entries.values().next().value ?? {
      aliases: new Set<string>(),
      users: new Set<MarAgentRunLifetime>()
    };
    if (entry.release !== undefined) {
      const release = entry.release;
      if (release.reason !== 'idle_expired')
        return Promise.reject(new Error('MAR_AGENT_SESSION_RUNTIME_RELEASED'));
      return release.result.then(() => {
        if (release.reason !== 'idle_expired')
          throw new Error('MAR_AGENT_SESSION_RUNTIME_RELEASED');
        return this.acquire(input, lifetime);
      });
    }
    if (entry.current !== undefined || entry.acquisition !== undefined)
      return Promise.reject(new Error('MAR_AGENT_SESSION_RUNTIME_ACTIVE'));
    for (const alias of aliases) this.#addAlias(entry, alias);
    this.#clearTimer(entry);
    entry.current = lifetime;
    entry.users.add(lifetime);
    void lifetime.settled.then(() => entry.users.delete(lifetime));
    // Publish the acquisition before any dependency can synchronously reenter.
    const acquisition = Promise.resolve().then(async () => {
      let uncommitted: MarAgentSessionRuntime | undefined;
      try {
        this.#assertUsable(entry, lifetime);
        const configuration = await resolveMarAgentHostRuntimeConfiguration(
          input.secretEnvironment
        );
        this.#assertUsable(entry, lifetime);
        const fingerprint = sessionHostFingerprint(input, configuration);
        const existing = entry.runtime;
        if (existing !== undefined && existing.fingerprint.value === fingerprint.value) {
          await reconfigureSessionRuntime(existing, input, this.resources.modelFactory);
          this.#assertUsable(entry, lifetime);
          nodeLog('runner.mar-agent.runtime.reused', {
            runtimeId: existing.runtimeId,
            sessionId: existing.session.id,
            runId: input.runId
          });
        } else {
          let nativeId = input.externalSessionId;
          if (existing !== undefined) {
            nativeId = existing.session.id;
            await Promise.all(
              [...entry.users].filter((user) => user !== lifetime).map((user) => user.settled)
            );
            this.#assertUsable(entry, lifetime);
            delete entry.runtime;
            await this.#destroyRuntime(
              existing,
              entry.aliases,
              'host_configuration_changed',
              undefined,
              HOST_CONFIGURATION_CATEGORIES.filter(
                (category) =>
                  existing.fingerprint.categories[category] !== fingerprint.categories[category]
              )
            );
            this.#assertUsable(entry, lifetime);
          }
          const request =
            nativeId === undefined ? input : { ...input, externalSessionId: nativeId };
          let created: MarAgentSessionRuntime | undefined;
          created = await createSessionRuntime(
            request,
            nativeId ?? input.sessionId,
            fingerprint,
            configuration,
            this.resources,
            () =>
              created !== undefined && entry.runtime === created && entry.release === undefined
                ? entry.current?.runId
                : undefined
          );
          uncommitted = created;
          this.#addAlias(entry, uncommitted.session.id);
          nodeLog('runner.mar-agent.runtime.created', {
            runtimeId: uncommitted.runtimeId,
            sessionId: uncommitted.session.id,
            runId: input.runId
          });
          if (input.externalSessionId === undefined)
            this.promote(input.sessionId, uncommitted.session.id);
          this.#assertUsable(entry, lifetime);
          entry.runtime = uncommitted;
          uncommitted = undefined;
        }
        const runtime = entry.runtime!;
        return {
          runtime,
          assertUsable: () => this.#assertUsable(entry, lifetime),
          terminal: () => this.#terminal(entry, lifetime)
        };
      } catch (error) {
        if (uncommitted !== undefined) {
          nodeLog('runner.mar-agent.runtime.releasing', {
            runtimeId: uncommitted.runtimeId,
            sessionId: uncommitted.session.id,
            reason: 'admission_released',
            runId: input.runId
          });
          // No Execution was bound: do not release another Entry's Session resources
          // if alias registration failed because the SDK returned an existing identity.
          try {
            await releaseSessionRuntime(uncommitted);
          } catch {
            this.#logCleanupFailure(uncommitted.session.id);
          } finally {
            await closeImageCredentialProviders(uncommitted.models);
          }
        }
        entry.users.delete(lifetime);
        if (entry.current === lifetime) delete entry.current;
        throw error;
      } finally {
        delete entry.acquisition;
        if (entry.release === undefined && entry.current === undefined) {
          if (entry.runtime === undefined) this.#remove(entry);
          else this.#schedule(entry);
        }
      }
    });
    entry.acquisition = acquisition;
    return acquisition;
  }

  releaseSession(alias: string): Promise<void> {
    const existing = this.#entries.get(alias);
    if (existing?.release !== undefined) {
      existing.release.reason = 'session_released';
      return existing.release.result;
    }
    if (this.#disposed) return this.#disposePromise!;
    const entry = existing ?? { aliases: new Set([alias]), users: new Set<MarAgentRunLifetime>() };
    if (existing === undefined) this.#entries.set(alias, entry);
    return this.#release(entry, 'session_released');
  }

  dispose(): Promise<void> {
    if (this.#disposePromise !== undefined) return this.#disposePromise;
    this.#disposed = true;
    this.#disposePromise = Promise.resolve().then(async () => {
      const results = await Promise.allSettled(
        [...new Set(this.#entries.values())].map((entry) =>
          this.#release(entry, 'controller_disposed')
        )
      );
      const failure = results.find((result) => result.status === 'rejected');
      if (failure?.status === 'rejected') throw failure.reason;
    });
    return this.#disposePromise;
  }

  #assertUsable(entry: Entry, lifetime: MarAgentRunLifetime): void {
    lifetime.signal.throwIfAborted();
    if (this.#disposed) throw new Error('MAR_AGENT_RUN_CONTROLLER_DISPOSED');
    if (entry.release !== undefined || entry.current !== lifetime)
      throw new Error('MAR_AGENT_SESSION_RUNTIME_RELEASED');
  }

  #addAlias(entry: Entry, alias: string): void {
    const existing = this.#entries.get(alias);
    if (existing !== undefined && existing !== entry)
      throw new Error('MAR_AGENT_SESSION_RUNTIME_ACTIVE');
    entry.aliases.add(alias);
    this.#entries.set(alias, entry);
  }

  #terminal(entry: Entry, lifetime: MarAgentRunLifetime): void {
    if (entry.current !== lifetime) return;
    delete entry.current;
    this.#schedule(entry);
  }

  #clearTimer(entry: Entry): void {
    if (entry.idleTimer === undefined) return;
    clearTimeout(entry.idleTimer);
    delete entry.idleTimer;
  }

  #schedule(entry: Entry): void {
    if (
      entry.runtime === undefined ||
      entry.current !== undefined ||
      entry.acquisition !== undefined ||
      entry.release !== undefined ||
      entry.idleTimer !== undefined ||
      this.#disposed
    )
      return;
    const timer = setTimeout(() => {
      if (entry.idleTimer !== timer || entry.current !== undefined || entry.release !== undefined)
        return;
      const sessionId = entry.runtime?.session.id;
      void this.#release(entry, 'idle_expired').catch(() => this.#logCleanupFailure(sessionId));
    }, this.resources.resourceIdleTtlMs);
    entry.idleTimer = timer;
    timer.unref();
  }

  #release(entry: Entry, reason: ReleaseReason): Promise<void> {
    if (entry.release !== undefined) return entry.release.result;
    this.#clearTimer(entry);
    const runId = entry.current?.runId;
    const result = Promise.resolve().then(async () => {
      try {
        for (const user of entry.users) user.cancel();
        await entry.acquisition?.catch(() => undefined);
        await Promise.all([...entry.users].map((user) => user.settled));
        const runtime = entry.runtime;
        delete entry.runtime;
        if (runtime !== undefined)
          await this.#destroyRuntime(runtime, entry.aliases, reason, runId);
        else await this.#releaseComputerAliases(entry.aliases);
      } finally {
        this.#remove(entry);
      }
    });
    entry.release = { reason, result };
    return result;
  }

  async #releaseComputerAliases(aliases: ReadonlySet<string>): Promise<void> {
    const results = await Promise.allSettled(
      [...aliases].map((alias) => this.releaseComputerSession(alias))
    );
    const failure = results.find((result) => result.status === 'rejected');
    if (failure?.status === 'rejected') throw failure.reason;
  }

  async #destroyRuntime(
    runtime: MarAgentSessionRuntime,
    aliases: ReadonlySet<string>,
    reason: ReleaseReason,
    runId?: string,
    changedCategories: readonly HostConfigurationCategory[] = []
  ): Promise<void> {
    try {
      nodeLog('runner.mar-agent.runtime.releasing', {
        runtimeId: runtime.runtimeId,
        sessionId: runtime.session.id,
        reason,
        ...(runId === undefined ? {} : { runId }),
        ...(changedCategories.length === 0 ? {} : { changedCategories })
      });
    } catch {
      // Resource release must not depend on a writable diagnostic sink.
    }
    const results = await Promise.allSettled([
      this.#releaseComputerAliases(new Set([...aliases, runtime.session.id]))
    ]);
    results.push(...(await Promise.allSettled([releaseSessionRuntime(runtime)])));
    const failures = results.filter((result) => result.status === 'rejected');
    if (failures.length > 0) this.#logCleanupFailure(runtime.session.id);
    if (failures[0]?.status === 'rejected') throw failures[0].reason;
  }

  #remove(entry: Entry): void {
    for (const alias of entry.aliases)
      if (this.#entries.get(alias) === entry) this.#entries.delete(alias);
  }

  #logCleanupFailure(sessionId: string | undefined): void {
    try {
      nodeLog('runner.mar-agent.runtime.cleanup_failed', {
        sessionId,
        code: 'MAR_AGENT_RUNTIME_CLEANUP_FAILED'
      });
    } catch {
      // Keep the original cleanup error when the diagnostic sink is unavailable.
    }
  }
}
