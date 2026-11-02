import {
  createEnvelope,
  marctlExecutionCredentialRequestSchema,
  marctlExecutionCredentialResponseSchema,
  type MarctlExecutionCredentialRequest,
  type NodeEnvelope
} from '@myagentroam/protocol';

/** Correlates private credential exchanges on the authenticated Node connection. */
export class MarctlExecutionCredentialControl {
  private readonly pending = new Map<
    string,
    {
      resolve(token: string): void;
      reject(error: Error): void;
      timer: NodeJS.Timeout;
    }
  >();
  private available = false;
  private connectedToServer = false;

  constructor(private readonly send: (envelope: NodeEnvelope) => void) {}

  setFeatures(payload: unknown): void {
    const features = payload as
      { marctlExecutionCredential?: { apiVersion?: unknown } } | undefined;
    this.available = features?.marctlExecutionCredential?.apiVersion === 2;
  }

  connected(): void {
    this.connectedToServer = true;
  }

  disconnected(): void {
    this.connectedToServer = false;
    this.available = false;
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error('MARCTL_EXECUTION_AUTHORIZATION_UNAVAILABLE'));
    }
    this.pending.clear();
  }

  handle(envelope: NodeEnvelope): boolean {
    if (envelope.type !== 'marctl.execution-credential.response') return false;
    const entry = envelope.replyTo ? this.pending.get(envelope.replyTo) : undefined;
    if (!entry) return true;
    this.pending.delete(envelope.replyTo!);
    clearTimeout(entry.timer);
    const response = marctlExecutionCredentialResponseSchema.safeParse(envelope.payload);
    if (!response.success || 'error' in response.data)
      entry.reject(new Error('MARCTL_EXECUTION_AUTHORIZATION_INVALID'));
    else entry.resolve(response.data.token);
    return true;
  }

  request(input: MarctlExecutionCredentialRequest): Promise<string> {
    if (!this.connectedToServer || !this.available)
      return Promise.reject(new Error('MARCTL_EXECUTION_AUTHORIZATION_UNAVAILABLE'));
    const request = marctlExecutionCredentialRequestSchema.safeParse(input);
    if (!request.success)
      return Promise.reject(new Error('MARCTL_EXECUTION_AUTHORIZATION_INVALID'));
    const envelope = createEnvelope('marctl.execution-credential.request', request.data);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(envelope.id);
        reject(new Error('MARCTL_EXECUTION_AUTHORIZATION_UNAVAILABLE'));
      }, 15_000);
      this.pending.set(envelope.id, { resolve, reject, timer });
      try {
        this.send(envelope);
      } catch {
        clearTimeout(timer);
        this.pending.delete(envelope.id);
        reject(new Error('MARCTL_EXECUTION_AUTHORIZATION_UNAVAILABLE'));
      }
    });
  }
}
