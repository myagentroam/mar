import {
  createEnvelope,
  scheduledRunAuthorizeRequestSchema,
  scheduledRunAuthorizeResponseSchema,
  restartRunAuthorizeRequestSchema,
  type RestartRunAuthorizeRequest,
  type NodeEnvelope,
  type ScheduledRunAuthorizeRequest,
  type ScheduledRunAuthorizeResponse
} from '@myagentroam/protocol';

interface Pending {
  readonly generation: number;
  readonly resolve: (value: ScheduledRunAuthorizeResponse) => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
}

export class RunAuthorizationControl {
  readonly #pending = new Map<string, Pending>();
  #generation = 0;
  #connected = false;
  #closed = false;

  constructor(
    private readonly send: (envelope: NodeEnvelope) => void,
    private readonly purpose: 'schedule' | 'restart' = 'schedule'
  ) {}

  private code(suffix: string): string {
    return `${this.purpose.toUpperCase()}_${suffix}`;
  }

  connected(): void {
    this.disconnected();
    this.#connected = true;
  }

  disconnected(): void {
    this.#connected = false;
    this.#generation++;
    for (const pending of [...this.#pending.values()])
      pending.reject(new Error(this.code('SERVER_UNAVAILABLE')));
  }

  close(): void {
    this.#closed = true;
    this.disconnected();
  }

  handle(envelope: NodeEnvelope): boolean {
    if (envelope.type !== `${this.purpose}.authorize.response`) return false;
    const pending =
      envelope.replyTo === undefined ? undefined : this.#pending.get(envelope.replyTo);
    if (pending === undefined || pending.generation !== this.#generation) return true;
    const parsed = scheduledRunAuthorizeResponseSchema.safeParse(envelope.payload);
    if (!parsed.success) pending.reject(new Error(this.code('AUTH_RESPONSE_INVALID')));
    else pending.resolve(parsed.data);
    return true;
  }

  authorize(
    request: ScheduledRunAuthorizeRequest | RestartRunAuthorizeRequest
  ): Promise<Extract<ScheduledRunAuthorizeResponse, { context: unknown }>['context']> {
    if (!this.#connected || this.#closed)
      return Promise.reject(new Error(this.code('SERVER_UNAVAILABLE')));
    const envelope = createEnvelope(
      `${this.purpose}.authorize`,
      (this.purpose === 'schedule'
        ? scheduledRunAuthorizeRequestSchema
        : restartRunAuthorizeRequestSchema
      ).parse(request)
    );
    return new Promise((resolve, reject) => {
      const settle = (action: () => void) => {
        const pending = this.#pending.get(envelope.id);
        if (pending === undefined) return;
        this.#pending.delete(envelope.id);
        clearTimeout(pending.timer);
        action();
      };
      const timer = setTimeout(
        () => settle(() => reject(new Error(this.code('AUTH_TIMEOUT')))),
        15_000
      );
      timer.unref();
      this.#pending.set(envelope.id, {
        generation: this.#generation,
        timer,
        resolve: (response) =>
          settle(() => {
            if ('error' in response) reject(new Error(response.error.code));
            else resolve(response.context);
          }),
        reject: (error) => settle(() => reject(error))
      });
      try {
        this.send(envelope);
      } catch {
        settle(() => reject(new Error(this.code('SERVER_UNAVAILABLE'))));
      }
    });
  }
}
