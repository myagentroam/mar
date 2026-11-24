import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { mkdir, readFile, readdir, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser } from 'playwright';
import { z } from 'zod';

export const browserAgentActionSchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('describe') }),
  z.strictObject({ action: z.literal('acquire') }),
  z.strictObject({ action: z.literal('select'), tabId: z.string().uuid() }),
  z.strictObject({ action: z.literal('release') })
]);
export type BrowserAgentAction = z.infer<typeof browserAgentActionSchema>;
export type BrowserAgentExecution = {
  cliScope: string;
  signal: AbortSignal;
  allowed: (signal: AbortSignal) => Promise<boolean>;
};

let registry: string | undefined;

function privateRegistry(): string {
  if (registry !== undefined) return registry;
  const path = mkdtempSync(join(tmpdir(), 'mar-pw-registry-'));
  // Playwright bind registers even explicit local endpoints. Keep them out of
  // the public discovery directory used by other Playwright CLI invocations.
  process.env.PWTEST_SERVER_REGISTRY = path;
  process.once('exit', () => {
    try {
      rmSync(path, { recursive: true, force: true });
    } catch {
      // The process can no longer serve these endpoints.
    }
  });
  registry = path;
  return path;
}

/** Owns exactly one revocable Playwright transport for a live Browser Aside.
 * Web attachment and browser process lifetimes are owned elsewhere. */
export class BrowserAgentAccess {
  private lease:
    | {
        execution: BrowserAgentExecution;
        id: string;
        stop: AbortController;
        ready: Promise<void>;
        revoke: () => Promise<void>;
      }
    | undefined;

  constructor(
    private readonly browser: () => Browser | null,
    private readonly changed: () => void,
    private readonly failed: (error: unknown) => void
  ) {}

  get active(): boolean {
    return this.lease !== undefined && !this.lease.stop.signal.aborted;
  }

  get engaged(): boolean {
    return this.lease !== undefined;
  }

  async acquire(
    execution: BrowserAgentExecution,
    retain: () => () => void,
    checkControl: () => void
  ): Promise<string> {
    execution.signal.throwIfAborted();
    while (this.lease?.stop.signal.aborted) await this.lease.revoke();
    execution.signal.throwIfAborted();
    checkControl();
    const existing = this.lease;
    if (existing) {
      if (existing.execution !== execution) throw new Error('BROWSER_USE_BUSY');
      await existing.ready;
      if (existing.stop.signal.aborted) throw new Error('BROWSER_USE_HUMAN_CONTROL');
      return existing.id;
    }
    const browser = this.browser();
    if (!browser) throw new Error('BROWSER_USE_ACCESS_FAILED');
    const releaseHold = retain();
    const id = randomUUID();
    const root = join(tmpdir(), `mpw-${execution.cliScope}`);
    const resource = join(root, `shared-${id}`);
    const stop = new AbortController();
    const abort = () => stop.abort();
    execution.signal.addEventListener('abort', abort, { once: true });
    let bindAttempted = false;
    const start = async () => {
      if (!(await execution.allowed(stop.signal))) throw new Error('BROWSER_USE_DISABLED');
      stop.signal.throwIfAborted();
      const directory = privateRegistry();
      bindAttempted = true;
      const { endpoint } = await browser.bind(id, { host: '127.0.0.1', port: 0 });
      // Pass the descriptor title to Playwright, not its bearer URL on process argv.
      await mkdir(root, { recursive: true, mode: 0o700 });
      await mkdir(resource, { mode: 0o700 });
      for (const name of await readdir(directory)) {
        const candidate = join(directory, name);
        const contents = await readFile(candidate, 'utf8').catch(() => '');
        if (contents.includes(JSON.stringify(endpoint))) {
          stop.signal.throwIfAborted();
          await rename(candidate, join(resource, name));
          return;
        }
      }
      throw new Error('BROWSER_USE_ACCESS_FAILED');
    };
    const ready = start();
    let revoking: Promise<void> | undefined;
    const revoke = () =>
      (revoking ??= (async () => {
        await ready.catch(() => undefined);
        await rm(resource, { recursive: true, force: true }).catch(this.failed);
        if (bindAttempted && browser.isConnected()) {
          try {
            await browser.unbind();
          } catch {
            if (browser.isConnected()) {
              // If the transport cannot be revoked normally, close the browser.
              await browser.close().catch(() => undefined);
              // Retain the lease and hold until closure is confirmed. Later
              // release calls or the disconnect event can complete cleanup.
              if (browser.isConnected()) throw new Error('BROWSER_USE_REVOKE_FAILED');
            }
          }
        }
        execution.signal.removeEventListener('abort', abort);
        browser.off('disconnected', disconnected);
        this.lease = undefined;
        releaseHold();
        this.changed();
      })().finally(() => {
        revoking = undefined;
      }));
    const revokeInBackground = () => void revoke().catch(this.failed);
    const disconnected = () => {
      if (stop.signal.aborted) revokeInBackground();
      else stop.abort();
    };
    this.lease = { execution, id, stop, ready, revoke };
    stop.signal.addEventListener('abort', revokeInBackground, { once: true });
    browser.once('disconnected', disconnected);
    try {
      await ready;
      if (stop.signal.aborted) throw new Error('BROWSER_USE_HUMAN_CONTROL');
      this.changed();
      this.recheck(execution, stop);
      return id;
    } catch (error) {
      await this.release(execution);
      throw error;
    }
  }

  has(execution: BrowserAgentExecution): boolean {
    return this.active && this.lease?.execution === execution;
  }

  async release(execution?: BrowserAgentExecution): Promise<void> {
    const lease = this.lease;
    if (!lease || (execution && lease.execution !== execution)) return;
    lease.stop.abort();
    await lease.revoke();
  }

  private recheck(execution: BrowserAgentExecution, stop: AbortController): void {
    if (stop.signal.aborted) return;
    const cancel = () => clearTimeout(timer);
    const timer = setTimeout(async () => {
      stop.signal.removeEventListener('abort', cancel);
      const allowed = await execution.allowed(stop.signal).catch(() => false);
      if (stop.signal.aborted) return;
      if (!allowed) await this.release(execution).catch(this.failed);
      else this.recheck(execution, stop);
    }, 3_000);
    timer.unref();
    stop.signal.addEventListener('abort', cancel, { once: true });
  }
}
