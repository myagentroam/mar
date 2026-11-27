import { randomUUID } from 'node:crypto';
import type { NodeStreamHandler } from '@myagentroam/protocol/node-stream-mux';

/** Holds short-lived, one-use Relay grants; callers supply the authorized business handler. */
export class NodeStreamGrants {
  private readonly pending = new Map<
    string,
    { kind: string; handler: NodeStreamHandler; expiry: NodeJS.Timeout; binding?: string }
  >();
  private readonly active = new Map<string, () => void>();

  issue(kind: string, handler: NodeStreamHandler, binding?: string): string {
    const grant = randomUUID();
    const expiry = setTimeout(() => this.pending.delete(grant), 15_000);
    expiry.unref();
    this.pending.set(grant, { kind, handler, expiry, ...(binding !== undefined && { binding }) });
    return grant;
  }

  consume(
    kind: string,
    grant: string,
    direct?: { binding: string; signal: AbortSignal }
  ): NodeStreamHandler | undefined {
    const entry = this.pending.get(grant);
    if (entry?.kind !== kind || entry.binding !== direct?.binding || direct?.signal.aborted)
      return undefined;
    this.pending.delete(grant);
    clearTimeout(entry.expiry);
    if (direct === undefined) return entry.handler;
    const scope = new AbortController();
    this.active.set(grant, () => scope.abort());
    const forget = () => this.active.delete(grant);
    direct.signal.addEventListener('abort', forget, { once: true });
    return async (stream, signal) => {
      const revoke = () => stream.reset('RESOURCE_DENIED');
      try {
        if (scope.signal.aborted) return revoke();
        scope.signal.addEventListener('abort', revoke, { once: true });
        await entry.handler(stream, signal);
      } finally {
        scope.signal.removeEventListener('abort', revoke);
        direct.signal.removeEventListener('abort', forget);
        forget();
      }
    };
  }

  revoke(grant: string): void {
    const pending = this.pending.get(grant);
    if (pending) clearTimeout(pending.expiry);
    this.pending.delete(grant);
    this.active.get(grant)?.();
  }

  clear(): void {
    for (const { expiry } of this.pending.values()) clearTimeout(expiry);
    this.pending.clear();
    for (const revoke of this.active.values()) revoke();
    this.active.clear();
  }
}
