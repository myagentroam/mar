export type FakeRunnerStep =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'tool'; readonly name: string; readonly input?: unknown }
  | {
      readonly type: 'approval';
      readonly id?: string;
      readonly payload?: unknown;
      readonly timeoutMs?: number;
    }
  | { readonly type: 'success'; readonly payload?: unknown }
  | { readonly type: 'failure'; readonly code?: string }
  | { readonly type: 'long-running' }
  | { readonly type: 'disconnect' };

export type FakeRunnerStatus =
  'STARTING' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED' | 'INTERRUPTED';

export interface FakeRunnerCallbacks {
  readonly event: (eventType: string, payload: unknown, status?: FakeRunnerStatus) => void;
  readonly approval: (approvalId: string, payload: unknown, expiresAt: number) => void;
  readonly disconnect: () => void;
}

interface ActiveRun {
  readonly callbacks: FakeRunnerCallbacks;
  interrupted: boolean;
  cancelled: boolean;
  decisions: Map<string, 'APPROVED' | 'REJECTED'>;
  waiters: Map<string, (decision: 'APPROVED' | 'REJECTED' | undefined) => void>;
}

/** Test-only deterministic runner; it is never part of node capabilities. */
export class FakeRunner {
  private readonly active = new Map<string, ActiveRun>();
  constructor(private readonly now: () => number = Date.now) {}

  async start(
    runId: string,
    script: readonly FakeRunnerStep[],
    callbacks: FakeRunnerCallbacks
  ): Promise<void> {
    if (this.active.has(runId)) return;
    const active: ActiveRun = {
      callbacks,
      interrupted: false,
      cancelled: false,
      decisions: new Map(),
      waiters: new Map()
    };
    this.active.set(runId, active);
    callbacks.event('run.started', {}, 'STARTING');
    callbacks.event('run.running', {}, 'RUNNING');
    try {
      for (const step of script) {
        const stopped = this.stopped(active);
        if (stopped !== undefined) {
          callbacks.event('run.stopped', {}, stopped);
          return;
        }
        if (step.type === 'text') callbacks.event('text', { text: step.text });
        if (step.type === 'tool')
          callbacks.event('tool', { name: step.name, input: step.input ?? null });
        if (step.type === 'success') {
          callbacks.event('run.succeeded', step.payload ?? {}, 'SUCCEEDED');
          return;
        }
        if (step.type === 'failure') {
          callbacks.event('run.failed', { code: step.code ?? 'FAKE_FAILURE' }, 'FAILED');
          return;
        }
        if (step.type === 'disconnect') {
          callbacks.disconnect();
          continue;
        }
        if (step.type === 'long-running') {
          await new Promise<void>((resolve) => {
            const timer = setInterval(() => {
              if (this.stopped(active) !== undefined) {
                clearInterval(timer);
                resolve();
              }
            }, 5);
          });
          callbacks.event('run.stopped', {}, this.stopped(active) ?? 'CANCELLED');
          return;
        }
        if (step.type === 'approval') {
          const id = step.id ?? `${runId}-approval-${this.now()}`;
          const expiresAt = this.now() + (step.timeoutMs ?? 30_000);
          callbacks.approval(id, step.payload ?? {}, expiresAt);
          const decision = await this.waitForDecision(active, id, step.timeoutMs ?? 30_000);
          const stoppedAfterApproval = this.stopped(active);
          if (stoppedAfterApproval !== undefined) {
            callbacks.event('run.stopped', {}, stoppedAfterApproval);
            return;
          }
          if (decision === 'REJECTED') {
            callbacks.event('approval.rejected', { approvalId: id }, 'FAILED');
            return;
          }
          if (decision === undefined) {
            callbacks.event('approval.expired', { approvalId: id }, 'FAILED');
            return;
          }
          callbacks.event('approval.approved', { approvalId: id });
        }
      }
    } finally {
      this.active.delete(runId);
    }
  }

  decide(runId: string, approvalId: string, decision: 'APPROVED' | 'REJECTED'): boolean {
    const active = this.active.get(runId);
    if (active === undefined || active.decisions.has(approvalId)) return false;
    active.decisions.set(approvalId, decision);
    active.waiters.get(approvalId)?.(decision);
    return true;
  }

  interrupt(runId: string): boolean {
    const active = this.active.get(runId);
    if (active === undefined) return false;
    active.interrupted = true;
    this.stopWaitingForApproval(active);
    return true;
  }

  cancel(runId: string): boolean {
    const active = this.active.get(runId);
    if (active === undefined) return false;
    active.cancelled = true;
    this.stopWaitingForApproval(active);
    return true;
  }

  private stopped(active: ActiveRun): 'CANCELLED' | 'INTERRUPTED' | undefined {
    return active.cancelled ? 'CANCELLED' : active.interrupted ? 'INTERRUPTED' : undefined;
  }

  private waitForDecision(
    active: ActiveRun,
    approvalId: string,
    timeoutMs: number
  ): Promise<'APPROVED' | 'REJECTED' | undefined> {
    const prior = active.decisions.get(approvalId);
    if (prior !== undefined) return Promise.resolve(prior);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        active.waiters.delete(approvalId);
        resolve(undefined);
      }, timeoutMs);
      active.waiters.set(approvalId, (decision) => {
        clearTimeout(timer);
        active.waiters.delete(approvalId);
        resolve(decision);
      });
    });
  }

  private stopWaitingForApproval(active: ActiveRun): void {
    for (const resolve of [...active.waiters.values()]) resolve(undefined);
  }
}
