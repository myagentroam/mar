import {
  browserUsePreferenceSchema,
  createEnvelope,
  type NodeEnvelope
} from '@myagentroam/protocol';
import type { BrowserSessionKey } from './browser-session-service.js';

/** Checks current account preference and workspace access on the authenticated connection. */
export class BrowserUseControl {
  private supported = false;
  private readonly pending = new Map<string, (enabled: boolean) => void>();

  constructor(private readonly send: (envelope: NodeEnvelope) => void) {}

  setFeatures(features: unknown): void {
    const browserUse = (features as { browserUse?: { apiVersion?: unknown } } | undefined)
      ?.browserUse;
    this.supported = browserUse?.apiVersion === 1;
  }

  disconnect(): void {
    this.supported = false;
    for (const settle of this.pending.values()) settle(false);
  }

  handle(envelope: NodeEnvelope): boolean {
    if (envelope.type !== 'browser.use.result') return false;
    const result = browserUsePreferenceSchema.safeParse(envelope.payload);
    if (envelope.replyTo)
      this.pending.get(envelope.replyTo)?.(result.success && result.data.enabled);
    return true;
  }

  allowed(scope: BrowserSessionKey, signal: AbortSignal): Promise<boolean> {
    if (!this.supported || signal.aborted) return Promise.resolve(false);
    const envelope = createEnvelope('browser.use.check', scope);
    return new Promise((resolve) => {
      const abort = () => settle(false);
      const settle = (enabled: boolean) => {
        clearTimeout(timer);
        signal.removeEventListener('abort', abort);
        this.pending.delete(envelope.id);
        resolve(enabled);
      };
      const timer = setTimeout(abort, 5_000);
      timer.unref();
      signal.addEventListener('abort', abort, { once: true });
      this.pending.set(envelope.id, settle);
      try {
        this.send(envelope);
      } catch {
        settle(false);
      }
    });
  }
}
