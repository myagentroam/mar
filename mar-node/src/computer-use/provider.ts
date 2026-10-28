import {
  ComputerUseError,
  type ComputerUseConfiguration,
  type ComputerUseInput,
  type ComputerUseTaskResult,
  type ComputerUseWaitInput,
  type ComputerUseSupport
} from './contracts.js';
import { ComputerUseControlIndicator } from './indicator.js';
import { probeComputerUse } from './probe.js';
import {
  ComputerUseDesktopLeaseService,
  ComputerUseSessionResources,
  type ControlIndicator
} from './session.js';

export interface ComputerUseBinding {
  call(input: ComputerUseInput, signal: AbortSignal): Promise<ComputerUseTaskResult>;
  wait(input: ComputerUseWaitInput, signal: AbortSignal): Promise<ComputerUseTaskResult>;
  close(): Promise<void>;
}

export class ComputerUseProvider {
  readonly #lease: ComputerUseDesktopLeaseService;
  readonly #probe: (configuration: ComputerUseConfiguration) => Promise<ComputerUseSupport>;
  readonly #showControlIndicator: (runtimeExecutable: string) => Promise<ControlIndicator>;
  readonly #sessions = new Map<
    string,
    {
      readonly runtimeExecutable: string;
      readonly session: ComputerUseSessionResources;
    }
  >();
  readonly #pendingBinds = new Map<string, Set<{ released: boolean }>>();
  #supportKey: string | undefined;
  #supportPromise: Promise<ComputerUseSupport> | undefined;
  #disposed = false;
  #resetPromise: Promise<void> | undefined;
  #resetFailure: Error | undefined;

  constructor(
    private readonly configuration:
      ComputerUseConfiguration | (() => ComputerUseConfiguration | undefined),
    options: {
      readonly lease?: ComputerUseDesktopLeaseService;
      readonly probe?: (configuration: ComputerUseConfiguration) => Promise<ComputerUseSupport>;
      readonly showControlIndicator?: (runtimeExecutable: string) => Promise<ControlIndicator>;
    } = {}
  ) {
    this.#lease = options.lease ?? new ComputerUseDesktopLeaseService();
    this.#probe = options.probe ?? probeComputerUse;
    this.#showControlIndicator = options.showControlIndicator ?? ComputerUseControlIndicator.show;
  }

  support(): Promise<ComputerUseSupport> {
    const configuration = this.#configuration();
    return configuration === undefined
      ? probeComputerUse({ enabled: false, runtimeExecutable: '' })
      : this.#support(configuration);
  }

  async bind(input: {
    readonly runId: string;
    readonly sessionId: string;
    readonly mode: 'run' | 'plan' | 'compact';
    readonly enabled: boolean;
    readonly modelSupportsImages: boolean;
    readonly signal?: AbortSignal;
  }): Promise<ComputerUseBinding | undefined> {
    if (this.#disposed || this.#resetPromise !== undefined || this.#resetFailure !== undefined)
      throw new ComputerUseError('COMPUTER_UNAVAILABLE', 'Computer Use provider is closed.');
    const token = { released: false };
    const pending = this.#pendingBinds.get(input.sessionId) ?? new Set();
    pending.add(token);
    this.#pendingBinds.set(input.sessionId, pending);
    try {
      const configuration = this.#configuration();
      if (
        configuration?.enabled !== true ||
        !input.enabled ||
        input.mode !== 'run' ||
        !input.modelSupportsImages
      )
        return undefined;
      const support = await this.#support(configuration);
      if (!support.available) return undefined;
      this.#assertBindingAvailable(token);
      let retained = this.#sessions.get(input.sessionId);
      if (
        retained !== undefined &&
        retained.runtimeExecutable !== configuration.runtimeExecutable
      ) {
        await this.#destroySession(input.sessionId, retained);
        this.#assertBindingAvailable(token);
        retained = undefined;
      }
      const entry = retained ?? {
        runtimeExecutable: configuration.runtimeExecutable,
        session: new ComputerUseSessionResources(
          configuration.runtimeExecutable,
          this.#lease,
          this.#showControlIndicator,
          async () => {
            const current = await this.#probe(configuration);
            if (!current.available)
              throw new ComputerUseError(
                current.reasonCode ?? 'COMPUTER_UNAVAILABLE',
                'The interactive desktop is no longer available.'
              );
          }
        )
      };
      if (retained === undefined) this.#sessions.set(input.sessionId, entry);
      entry.session.attach(input.runId, input.signal);
      let closed = false;
      let closing: Promise<void> | undefined;
      const close = (): Promise<void> => {
        if (closing !== undefined) return closing;
        closed = true;
        closing = entry.session.detach(input.runId);
        return closing;
      };
      entry.session.setBindingClose(close);
      return {
        call: (executionInput, signal) => {
          if (closed || this.#sessions.get(input.sessionId) !== entry)
            return Promise.reject(
              new ComputerUseError('COMPUTER_UNAVAILABLE', 'Computer Use binding is closed.')
            );
          return entry.session.call(executionInput, signal);
        },
        wait: (waitInput, signal) => {
          if (closed || this.#sessions.get(input.sessionId) !== entry)
            return Promise.reject(
              new ComputerUseError('COMPUTER_UNAVAILABLE', 'Computer Use binding is closed.')
            );
          return entry.session.wait(waitInput, signal);
        },
        close
      };
    } finally {
      pending.delete(token);
      if (pending.size === 0) this.#pendingBinds.delete(input.sessionId);
    }
  }

  async releaseSession(sessionId: string): Promise<void> {
    for (const token of this.#pendingBinds.get(sessionId) ?? []) token.released = true;
    const entry = this.#sessions.get(sessionId);
    if (entry !== undefined) await this.#destroySession(sessionId, entry);
  }

  reset(): Promise<void> {
    if (this.#resetPromise !== undefined) return this.#resetPromise;
    if (this.#resetFailure !== undefined) return Promise.reject(this.#resetFailure);
    this.#supportKey = undefined;
    this.#supportPromise = undefined;
    for (const pending of this.#pendingBinds.values())
      for (const token of pending) token.released = true;
    const reset = (async () => {
      const results = await Promise.allSettled(
        [...this.#sessions.entries()].map(([sessionId, entry]) =>
          this.#destroySession(sessionId, entry)
        )
      );
      const failures = results.filter(
        (result): result is PromiseRejectedResult => result.status === 'rejected'
      );
      if (failures.length > 0)
        throw new ComputerUseError('COMPUTER_CLEANUP_FAILED', 'Computer Use cleanup failed.', {
          cause: new AggregateError(failures.map((failure) => failure.reason))
        });
    })();
    this.#resetPromise = reset;
    void reset.then(
      () => {
        this.#resetPromise = undefined;
      },
      (error: unknown) => {
        this.#resetFailure =
          error instanceof Error
            ? error
            : new Error('Computer Use cleanup failed.', { cause: error });
        this.#resetPromise = undefined;
      }
    );
    return reset;
  }

  async dispose(): Promise<void> {
    this.#disposed = true;
    await this.reset();
  }

  #configuration(): ComputerUseConfiguration | undefined {
    return typeof this.configuration === 'function' ? this.configuration() : this.configuration;
  }

  #assertBindingAvailable(token: { released: boolean }): void {
    if (!this.#disposed && !token.released) return;
    throw new ComputerUseError(
      'COMPUTER_UNAVAILABLE',
      'Computer Use Session resources were released while binding.'
    );
  }

  #support(configuration: ComputerUseConfiguration): Promise<ComputerUseSupport> {
    const key = `${configuration.enabled}:${configuration.runtimeExecutable}`;
    if (this.#supportKey !== key) {
      this.#supportKey = key;
      this.#supportPromise = this.#probe(configuration);
    }
    return this.#supportPromise!;
  }

  async #destroySession(
    sessionId: string,
    entry: {
      readonly session: ComputerUseSessionResources;
    }
  ): Promise<void> {
    if (this.#sessions.get(sessionId) !== entry) return;
    await entry.session.close();
    if (this.#sessions.get(sessionId) === entry) this.#sessions.delete(sessionId);
  }
}
