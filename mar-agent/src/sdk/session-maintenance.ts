import { AgentError } from '../error.js';
import type { ExtensionManager } from '../extensions/manager.js';
import type { AgentHost } from '../host/contracts.js';
import type { SessionStore } from '../session/store/contracts.js';
import { closeModelAdapters } from './model-runtime.js';
import type { SessionRegistry } from './session-registry.js';
import type { SessionRuntime } from './session-runtime.js';

/** Agent-level maintenance admission and tree cleanup, sharing the Agent writer owner. */
export class SessionMaintenanceCoordinator {
  readonly #epochs = new Map<string, number>();
  readonly #operations = new Map<
    string,
    { kind: 'clear' | 'delete'; signature: string; pending: Promise<void> }
  >();
  readonly #treeAdmissions = new Map<string, number>();

  constructor(
    private readonly store: SessionStore,
    private readonly registry: SessionRegistry<SessionRuntime>,
    private readonly extensions: ExtensionManager,
    private readonly host: AgentHost,
    private readonly writerOwner: object,
    private readonly disposed: () => boolean,
    private readonly generation: () => number
  ) {}

  epoch(id: string): number {
    return this.#epochs.get(id) ?? 0;
  }

  canPublish(id: string, epoch: number): boolean {
    return !this.disposed() && !this.#treeAdmissions.has(id) && this.epoch(id) === epoch;
  }

  assertAdmission(id?: string): void {
    if (this.disposed()) throw new AgentError('MAR_AGENT_DISPOSED', 'Agent is disposed.');
    if (id !== undefined && (this.#operations.has(id) || this.#treeAdmissions.has(id)))
      throw new AgentError('MAR_AGENT_SESSION_CLOSING', 'Session is closing.');
  }

  async join(): Promise<void> {
    const results = await Promise.allSettled(
      [...this.#operations.values()].map(({ pending }) => pending)
    );
    const failure = results.find((result) => result.status === 'rejected');
    if (failure?.status === 'rejected') throw failure.reason;
  }

  clear(id: string): Promise<void> {
    return this.#track(id, 'clear', async () => {
      if (this.registry.get(id)?.activeExecutionId !== undefined)
        throw new AgentError(
          'MAR_AGENT_EXECUTION_ACTIVE',
          'A session cannot be cleared while an execution is active.'
        );
      const maintenance = await this.store.acquireSessionMaintenance(id, 'clear', this.writerOwner);
      this.#invalidate([id]);
      let failed = false;
      try {
        let runtime: SessionRuntime | undefined;
        await completeAgentCleanup([
          () => this.registry.whenIdle([id]),
          () => {
            runtime = this.registry.get(id);
          },
          () => this.extensions.endSession(id, 'clear'),
          () => this.extensions.retireSession(id),
          () => this.extensions.clearSession(id),
          () => runtime?.retireInputs(),
          () =>
            closeModelAdapters(
              runtime === undefined
                ? []
                : runtime
                    .takeAdaptersForClose()
                    .filter(
                      (adapter) =>
                        ![...this.registry].some(
                          ([otherId, other]) => otherId !== id && other.hasModelAdapter(adapter)
                        )
                    )
            ),
          () => runtime?.resetAfterClear(this.generation()),
          () => this.host.disposeSessionResources?.(id),
          () => this.store.clearSession(id, maintenance)
        ]);
      } catch (error) {
        failed = true;
        throw error;
      } finally {
        try {
          await maintenance.release();
        } catch (error) {
          if (!failed) throw error;
        }
      }
    });
  }

  delete(id: string): Promise<void> {
    return this.deleteMembers([id]);
  }

  deleteMembers(members: readonly string[]): Promise<void> {
    const requestedIds = [...members];
    if (
      requestedIds.length === 0 ||
      requestedIds.some((id) => typeof id !== 'string' || id.length === 0) ||
      new Set(requestedIds).size !== requestedIds.length
    )
      return Promise.reject(
        new AgentError('MAR_AGENT_SESSION_INVALID', 'Invalid Session maintenance members.')
      );
    requestedIds.sort();
    const id = requestedIds[0]!;
    const signature = JSON.stringify(requestedIds);
    return this.#track(
      id,
      'delete',
      async () => {
        const maintenance = await this.store.acquireSessionMaintenance(
          id,
          'delete',
          this.writerOwner,
          requestedIds
        );
        let failed = false;
        const ids = maintenance.sessionIds;
        for (const sessionId of ids)
          this.#treeAdmissions.set(sessionId, (this.#treeAdmissions.get(sessionId) ?? 0) + 1);
        try {
          this.#invalidate(ids);
          let runtimes: SessionRuntime[] = [];
          await completeAgentCleanup([
            () => this.registry.whenIdle(ids),
            () => {
              runtimes = ids.flatMap((sessionId) => {
                const runtime = this.registry.get(sessionId);
                return runtime ? [runtime] : [];
              });
              for (const runtime of runtimes) runtime.cancelExecutions();
            },
            async () => {
              let failure: { error: unknown } | undefined;
              await Promise.all(
                ids.map(async (sessionId) => {
                  try {
                    await this.extensions.endSession(sessionId, 'other', false);
                  } catch (error) {
                    failure ??= { error };
                  }
                })
              );
              if (failure) throw failure.error;
            },
            ...ids.map((sessionId) => () => this.extensions.retireSession(sessionId)),
            ...ids.map((sessionId) => () => this.extensions.clearSession(sessionId)),
            () => completeAgentCleanup(runtimes.map((runtime) => () => runtime.retireInputs())),
            () => Promise.all(runtimes.map((runtime) => runtime.joinExecutions())),
            () => {
              for (const sessionId of ids) {
                const runtime = this.registry.get(sessionId);
                if (runtime) this.registry.unregister(sessionId, runtime);
              }
            },
            () =>
              closeModelAdapters(
                runtimes
                  .flatMap((runtime) => runtime.takeAdaptersForClose())
                  .filter(
                    (adapter) =>
                      ![...this.registry.values()].some((other) => other.hasModelAdapter(adapter))
                  )
              ),
            ...ids.map((sessionId) => () => this.host.disposeSessionResources?.(sessionId)),
            () => this.store.delete(id, maintenance)
          ]);
        } catch (error) {
          failed = true;
          throw error;
        } finally {
          try {
            await maintenance.release();
          } catch (error) {
            if (!failed) throw error;
          } finally {
            for (const sessionId of ids) {
              const count = this.#treeAdmissions.get(sessionId)!;
              if (count === 1) this.#treeAdmissions.delete(sessionId);
              else this.#treeAdmissions.set(sessionId, count - 1);
            }
          }
        }
      },
      signature
    );
  }

  #invalidate(ids: readonly string[]): void {
    for (const id of ids) this.#epochs.set(id, this.epoch(id) + 1);
  }

  #track(
    id: string,
    kind: 'clear' | 'delete',
    operation: () => Promise<void>,
    signature = ''
  ): Promise<void> {
    if (this.disposed())
      return Promise.reject(new AgentError('MAR_AGENT_DISPOSED', 'Agent is disposed.'));
    const current = this.#operations.get(id);
    if (current)
      return current.kind === kind && current.signature === signature
        ? current.pending
        : Promise.reject(new AgentError('MAR_AGENT_SESSION_CLOSING', 'Session is closing.'));
    if (this.#treeAdmissions.has(id))
      return Promise.reject(new AgentError('MAR_AGENT_SESSION_CLOSING', 'Session is closing.'));
    const completion = Promise.withResolvers<void>();
    const pending = completion.promise.finally(() => this.#operations.delete(id));
    this.#operations.set(id, { kind, signature, pending });
    void pending.catch(() => undefined);
    try {
      completion.resolve(operation());
    } catch (error) {
      completion.reject(error);
    }
    return pending;
  }
}

/** Complete all independent stages, reporting the first authoritative failure. */
export async function completeAgentCleanup(
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
