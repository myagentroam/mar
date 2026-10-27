import { AgentError } from '@myagentroam/agent';
import {
  createEnvelope,
  runtimeCredentialResolveRequestSchema,
  runtimeCredentialResolveResponseSchema,
  type NodeEnvelope,
  type RuntimeCredentialResolveRequest,
  type RuntimeCredentialResolveResponse
} from '@myagentroam/protocol';

interface RuntimeCredentialControlServiceOptions {
  readonly send: (envelope: NodeEnvelope) => void;
  readonly timeoutMs?: number;
}

interface PendingResolution {
  readonly generation: number;
  readonly resolve: (response: RuntimeCredentialResolveResponse) => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
  readonly cleanup: () => void;
}

const DEFAULT_TIMEOUT_MS = 15_000;

/** Correlates the closed runtime-credential exchange on the authenticated control connection. */
export class RuntimeCredentialControlService {
  readonly #pending = new Map<string, PendingResolution>();
  readonly #timeoutMs: number;
  #generation = 0;
  #connected = false;
  #closed = false;

  constructor(private readonly options: RuntimeCredentialControlServiceOptions) {
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  connected(): void {
    this.#rejectPending('MAR_AGENT_RUNTIME_CREDENTIAL_CONNECTION_INVALID');
    this.#generation++;
    this.#connected = true;
  }

  disconnected(): void {
    this.#connected = false;
    this.#generation++;
    this.#rejectPending('MAR_AGENT_RUNTIME_CREDENTIAL_CONNECTION_INVALID');
  }

  handle(envelope: NodeEnvelope): boolean {
    if (envelope.type !== 'credential.response') return false;
    if (envelope.replyTo === undefined) return true;
    const pending = this.#pending.get(envelope.replyTo);
    if (pending === undefined || pending.generation !== this.#generation) return true;
    const parsed = runtimeCredentialResolveResponseSchema.safeParse(envelope.payload);
    if (!parsed.success) {
      pending.reject(
        new AgentError(
          'MAR_AGENT_RUNTIME_CREDENTIAL_RESPONSE_INVALID',
          'The runtime credential response is invalid.'
        )
      );
      return true;
    }
    pending.resolve(parsed.data);
    return true;
  }

  resolve(
    request: RuntimeCredentialResolveRequest,
    signal?: AbortSignal
  ): Promise<RuntimeCredentialResolveResponse> {
    if (this.#closed)
      return Promise.reject(
        new AgentError(
          'MAR_AGENT_RUNTIME_CREDENTIAL_CONTROL_CLOSED',
          'The runtime credential control service is closed.'
        )
      );
    if (!this.#connected)
      return Promise.reject(
        new AgentError(
          'MAR_AGENT_RUNTIME_CREDENTIAL_CONNECTION_INVALID',
          'The runtime credential control connection is unavailable.'
        )
      );
    const parsed = runtimeCredentialResolveRequestSchema.parse(request);
    const envelope = createEnvelope('credential.resolve', parsed);
    const generation = this.#generation;
    return new Promise((resolve, reject) => {
      const settle = (
        action: (value: RuntimeCredentialResolveResponse | Error) => void,
        value: RuntimeCredentialResolveResponse | Error
      ) => {
        const pending = this.#pending.get(envelope.id);
        if (pending === undefined) return;
        this.#pending.delete(envelope.id);
        clearTimeout(pending.timer);
        pending.cleanup();
        action(value);
      };
      const abort = () =>
        settle(
          (error) => reject(error),
          new AgentError(
            'MAR_AGENT_RUNTIME_CREDENTIAL_PROVIDER_CLOSED',
            'The runtime credential provider is closed.'
          )
        );
      const timer = setTimeout(
        () =>
          settle(
            (error) => reject(error),
            new AgentError(
              'MAR_AGENT_RUNTIME_CREDENTIAL_REQUEST_TIMEOUT',
              'The runtime credential request timed out.'
            )
          ),
        this.#timeoutMs
      );
      timer.unref();
      this.#pending.set(envelope.id, {
        generation,
        resolve: (response) =>
          settle((value) => resolve(value as RuntimeCredentialResolveResponse), response),
        reject: (error) => settle((value) => reject(value), error),
        timer,
        cleanup: () => signal?.removeEventListener('abort', abort)
      });
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
      else
        try {
          this.options.send(envelope);
        } catch (error) {
          settle(
            (cause) => reject(cause),
            new AgentError(
              'MAR_AGENT_RUNTIME_CREDENTIAL_REQUEST_SEND_FAILED',
              'The runtime credential request could not be sent.',
              { cause: error }
            )
          );
        }
    });
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#connected = false;
    this.#generation++;
    this.#rejectPending('MAR_AGENT_RUNTIME_CREDENTIAL_CONTROL_CLOSED');
  }

  #rejectPending(code: string): void {
    for (const pending of [...this.#pending.values()])
      pending.reject(
        new AgentError(code, 'The runtime credential control connection is no longer valid.')
      );
  }
}
