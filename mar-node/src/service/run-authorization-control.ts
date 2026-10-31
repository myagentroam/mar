import {
  createEnvelope,
  scheduledRunAuthorizeRequestSchema,
  executionPrepareResponseSchema,
  executionPrepareRequestSchema,
  type ExecutionPrepareRequest,
  type NodeEnvelope,
  type ScheduledRunAuthorizeRequest,
  type ExecutionPrepareResponse
} from '@myagentroam/protocol';

interface Pending {
  readonly generation: number;
  readonly responseType: string;
  readonly prefix: string;
  readonly resolve: (value: ExecutionPrepareResponse) => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
}

export class RunAuthorizationControl {
  readonly #pending = new Map<string, Pending>();
  #generation = 0;
  #connected = false;
  #closed = false;

  constructor(private readonly send: (envelope: NodeEnvelope) => void) {}

  connected(): void {
    this.disconnected();
    this.#connected = true;
  }

  disconnected(): void {
    this.#connected = false;
    this.#generation++;
    for (const pending of [...this.#pending.values()])
      pending.reject(new Error(`${pending.prefix}_SERVER_UNAVAILABLE`));
  }

  close(): void {
    this.#closed = true;
    this.disconnected();
  }

  handle(envelope: NodeEnvelope): boolean {
    if (
      envelope.type !== 'schedule.authorize.response' &&
      envelope.type !== 'execution.prepare.response'
    )
      return false;
    const pending =
      envelope.replyTo === undefined ? undefined : this.#pending.get(envelope.replyTo);
    if (
      pending === undefined ||
      pending.generation !== this.#generation ||
      pending.responseType !== envelope.type
    )
      return true;
    const parsed = executionPrepareResponseSchema.safeParse(envelope.payload);
    if (!parsed.success) pending.reject(new Error(`${pending.prefix}_AUTH_RESPONSE_INVALID`));
    else pending.resolve(parsed.data);
    return true;
  }

  authorize(
    request: ScheduledRunAuthorizeRequest
  ): Promise<Extract<ExecutionPrepareResponse, { context: unknown }>['context']> {
    return this.request(
      'schedule.authorize',
      scheduledRunAuthorizeRequestSchema.parse({ ...request, executionResources: 1 }),
      'SCHEDULE'
    );
  }

  prepare(
    request: ExecutionPrepareRequest
  ): Promise<Extract<ExecutionPrepareResponse, { context: unknown }>['context']> {
    return this.request(
      'execution.prepare',
      executionPrepareRequestSchema.parse(request),
      'EXECUTION'
    );
  }

  private request(
    type: string,
    request: unknown,
    prefix: string
  ): Promise<Extract<ExecutionPrepareResponse, { context: unknown }>['context']> {
    if (!this.#connected || this.#closed)
      return Promise.reject(new Error(`${prefix}_SERVER_UNAVAILABLE`));
    const envelope = createEnvelope(type, request);
    return new Promise((resolve, reject) => {
      const settle = (action: () => void) => {
        const pending = this.#pending.get(envelope.id);
        if (pending === undefined) return;
        this.#pending.delete(envelope.id);
        clearTimeout(pending.timer);
        action();
      };
      const timer = setTimeout(
        () => settle(() => reject(new Error(`${prefix}_AUTH_TIMEOUT`))),
        15_000
      );
      timer.unref();
      this.#pending.set(envelope.id, {
        generation: this.#generation,
        responseType: `${type}.response`,
        prefix,
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
        settle(() => reject(new Error(`${prefix}_SERVER_UNAVAILABLE`)));
      }
    });
  }
}
