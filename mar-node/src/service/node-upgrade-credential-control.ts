import { createEnvelope, type NodeEnvelope } from '@myagentroam/protocol';

/** One short-lived request over the authenticated Node control connection. */
export class NodeUpgradeCredentialControl {
  private pending:
    | {
        id: string;
        resolve(token: string): void;
        reject(error: Error): void;
        timer: NodeJS.Timeout;
      }
    | undefined;
  private available = false;

  constructor(private readonly send: (envelope: NodeEnvelope) => void) {}

  setFeatures(payload: unknown): void {
    const features = payload as { nodeUpgradeProgress?: { apiVersion?: unknown } } | undefined;
    this.available = features?.nodeUpgradeProgress?.apiVersion === 1;
  }

  disconnect(): void {
    this.available = false;
    if (this.pending) {
      clearTimeout(this.pending.timer);
      this.pending.reject(new Error('NODE_UPGRADE_CREDENTIAL_UNAVAILABLE'));
      this.pending = undefined;
    }
  }

  handle(envelope: NodeEnvelope): boolean {
    if (envelope.type !== 'node.upgrade.credential.response') return false;
    const pending = this.pending;
    if (!pending || pending.id !== envelope.replyTo) return true;
    this.pending = undefined;
    clearTimeout(pending.timer);
    const payload = envelope.payload as { token?: unknown } | null;
    if (typeof payload?.token !== 'string' || !/^[A-Za-z0-9_-]{43}$/u.test(payload.token))
      pending.reject(new Error('NODE_UPGRADE_CREDENTIAL_REJECTED'));
    else pending.resolve(payload.token);
    return true;
  }

  request(attemptId: string): Promise<string> {
    if (!this.available || this.pending)
      return Promise.reject(new Error('NODE_UPGRADE_CREDENTIAL_UNAVAILABLE'));
    const envelope = createEnvelope('node.upgrade.credential.request', { attemptId });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending = undefined;
        reject(new Error('NODE_UPGRADE_CREDENTIAL_UNAVAILABLE'));
      }, 15_000);
      this.pending = { id: envelope.id, resolve, reject, timer };
      try {
        this.send(envelope);
      } catch {
        clearTimeout(timer);
        this.pending = undefined;
        reject(new Error('NODE_UPGRADE_CREDENTIAL_UNAVAILABLE'));
      }
    });
  }
}
