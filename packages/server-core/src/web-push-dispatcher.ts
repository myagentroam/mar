import type { PushDeliveryResult } from '@myagentroam/protocol';
import type { StoredWebPushClient, WebPushClients } from './web-push-clients.js';
import { validWebPushEndpoint } from './web-push-clients.js';
import type { WebPushConfiguration, WebPushDeliveryKeys } from './web-push-configuration.js';
import type { StoredWorkbenchNotification } from './workbench-notification-service.js';

export interface WebPushTransportInput extends WebPushDeliveryKeys {
  readonly subscription: {
    readonly endpoint: string;
    readonly keys: { readonly p256dh: string; readonly auth: string };
  };
  readonly payload: string;
  readonly ttl: number;
  readonly signal: AbortSignal;
}
export type WebPushTransport = (
  input: WebPushTransportInput
) => Promise<{ readonly statusCode: number }>;
export function emptyPushResult(
  status: PushDeliveryResult['status'],
  reason: string
): PushDeliveryResult {
  return {
    status,
    reason,
    eligible: 0,
    attempted: 0,
    accepted: 0,
    skipped: 0,
    failed: 0,
    uncertain: 0
  };
}

export interface WebPushProjection {
  readonly account: string;
  readonly locale?: 'zh-CN' | 'en-US';
  readonly notification: Pick<
    StoredWorkbenchNotification,
    'id' | 'title' | 'message' | 'read' | 'expiresAt'
  >;
}

/** Best-effort fan-out only. The caller owns notification persistence and authorization. */
export class WebPushDispatcher {
  private readonly queue: {
    readonly userId: number;
    readonly id: string;
    readonly key: string;
    readonly authorize: () => Promise<boolean>;
    readonly settle?: (result: PushDeliveryResult) => void;
  }[] = [];
  private readonly pending = new Set<string>();
  private readonly active = new Set<AbortController>();
  private flushing: Promise<void> | undefined;
  private closed = false;
  constructor(
    private readonly input: {
      readonly configuration: Pick<WebPushConfiguration, 'delivery'>;
      readonly clients: Pick<WebPushClients, 'eligible' | 'expire'>;
      readonly online: (userId: number) => boolean;
      /** Resolve the current, still-authorized projection independently before every send. */
      readonly resolve: (userId: number, id: string) => Promise<WebPushProjection | undefined>;
      readonly transport: WebPushTransport;
      readonly now?: () => number;
      readonly report?: (code: 'WEB_PUSH_DISPATCH_FAILED' | 'WEB_PUSH_TRANSPORT_FAILED') => void;
    }
  ) {}

  enqueue(
    userId: number,
    id: string,
    authorize: () => Promise<boolean>,
    settle?: (result: PushDeliveryResult) => void
  ): 'queued' | 'skipped_online' | 'duplicate' | 'queue_full' | 'closed' {
    if (this.closed) return 'closed';
    if (this.input.online(userId)) return 'skipped_online';
    const key = `${userId}:${id}`;
    if (this.pending.has(key)) return 'duplicate';
    if (this.pending.size >= 128) return 'queue_full';
    this.pending.add(key);
    this.queue.push({ userId, id, key, authorize, ...(settle === undefined ? {} : { settle }) });
    void this.flush();
    return 'queued';
  }

  dispatch(
    userId: number,
    id: string,
    authorize: () => Promise<boolean>
  ): Promise<PushDeliveryResult> {
    return new Promise((resolve) => {
      const result = this.enqueue(userId, id, authorize, resolve);
      if (result !== 'queued')
        resolve(
          emptyPushResult(
            result === 'skipped_online' ? 'suppressed' : 'uncertain',
            result === 'skipped_online' ? 'WEB_PUSH_ONLINE' : 'WEB_PUSH_QUEUE_UNAVAILABLE'
          )
        );
    });
  }

  flush(): Promise<void> {
    if (this.flushing === undefined) {
      this.flushing = Promise.all([this.work(), this.work()])
        .then(() => undefined)
        .finally(() => {
          this.flushing = undefined;
          if (!this.closed && this.queue.length > 0) void this.flush();
        });
    }
    return this.flushing;
  }

  close(): void {
    this.closed = true;
    for (const queued of this.queue.splice(0)) {
      this.pending.delete(queued.key);
      queued.settle?.(emptyPushResult('uncertain', 'WEB_PUSH_SHUTDOWN'));
    }
    for (const controller of this.active) controller.abort();
  }

  private async work(): Promise<void> {
    while (!this.closed) {
      const job = this.queue.shift();
      if (job === undefined) return;
      try {
        const result = await this.fanOut(job.userId, job.id, job.authorize);
        job.settle?.(result);
      } catch {
        this.input.report?.('WEB_PUSH_DISPATCH_FAILED');
        job.settle?.(emptyPushResult('uncertain', 'WEB_PUSH_DISPATCH_FAILED'));
      } finally {
        this.pending.delete(job.key);
      }
    }
  }

  private async fanOut(
    userId: number,
    id: string,
    authorize: () => Promise<boolean>
  ): Promise<PushDeliveryResult> {
    const counts = { eligible: 0, attempted: 0, accepted: 0, skipped: 0, failed: 0, uncertain: 0 };
    let reason = 'WEB_PUSH_NO_CLIENTS';
    const deadline = Date.now() + 15_000;
    const snapshots = await this.input.clients.eligible(userId);
    counts.eligible = snapshots.length;
    if (counts.eligible > 0) reason = 'WEB_PUSH_INELIGIBLE';
    for (const snapshot of snapshots) {
      try {
        if (this.closed || Date.now() >= deadline || this.input.online(userId)) {
          reason = this.closed
            ? 'WEB_PUSH_SHUTDOWN'
            : this.input.online(userId)
              ? 'WEB_PUSH_ONLINE'
              : 'WEB_PUSH_BUDGET_EXHAUSTED';
          break;
        }
        const keys = await this.input.configuration.delivery();
        if (keys === undefined) {
          reason = 'WEB_PUSH_DISABLED';
          break;
        }
        const current = (await this.input.clients.eligible(userId, snapshot.subscriptionId)).find(
          (client) =>
            client.subscriptionId === snapshot.subscriptionId &&
            client.bindingVersion === snapshot.bindingVersion &&
            client.subscription.endpoint === snapshot.subscription.endpoint
        );
        if (current === undefined || !validWebPushEndpoint(current.subscription.endpoint)) continue;
        const projection = await this.input.resolve(userId, id);
        const now = this.input.now?.() ?? Date.now();
        if (
          projection === undefined ||
          projection.notification.read ||
          projection.notification.expiresAt <= now
        )
          continue;
        const notice = projection.notification;
        const ttl = Math.min(3600, Math.floor((notice.expiresAt - now) / 1000));
        if (ttl < 1) continue;
        const payload = JSON.stringify({
          title: [...notice.title].slice(0, 160).join(''),
          body: [...notice.message].slice(0, 300).join(''),
          expiresAt: notice.expiresAt,
          locale: projection.locale ?? 'en-US',
          data: {
            type: 'mar.workbench.notification',
            account: projection.account,
            id: notice.id,
            subscriptionId: current.subscriptionId,
            bindingVersion: current.bindingVersion
          }
        });
        if (
          Buffer.byteLength(payload) > 3500 ||
          !(await authorize()) ||
          this.closed ||
          this.input.online(userId)
        )
          continue;
        counts.attempted++;
        const controller = new AbortController();
        this.active.add(controller);
        let timeout: ReturnType<typeof setTimeout> | undefined;
        try {
          const result = await Promise.race([
            this.input.transport({
              ...keys,
              payload,
              ttl,
              signal: controller.signal,
              subscription: current.subscription
            }),
            new Promise<never>((_resolve, reject) => {
              timeout = setTimeout(() => {
                controller.abort();
                reject(new Error('WEB_PUSH_TRANSPORT_FAILED'));
              }, 5_000);
            })
          ]);
          if (result.statusCode >= 200 && result.statusCode < 300) counts.accepted++;
          else {
            counts.failed++;
            if (result.statusCode === 404 || result.statusCode === 410) await this.expire(current);
            else this.input.report?.('WEB_PUSH_TRANSPORT_FAILED');
          }
        } catch (error) {
          const status =
            error !== null && typeof error === 'object' && 'statusCode' in error
              ? error.statusCode
              : undefined;
          if (typeof status === 'number') {
            counts.failed++;
            if (status === 404 || status === 410) await this.expire(current);
          } else counts.uncertain++;
          this.input.report?.('WEB_PUSH_TRANSPORT_FAILED');
        } finally {
          clearTimeout(timeout);
          this.active.delete(controller);
        }
      } catch {
        reason = 'WEB_PUSH_RECHECK_FAILED';
        this.input.report?.('WEB_PUSH_DISPATCH_FAILED');
      }
    }
    if (this.input.online(userId)) reason = 'WEB_PUSH_ONLINE';
    counts.skipped = counts.eligible - counts.attempted;
    const status =
      counts.accepted > 0
        ? counts.accepted === counts.eligible
          ? 'accepted'
          : 'partial'
        : counts.uncertain > 0
          ? 'uncertain'
          : counts.failed > 0
            ? 'failed'
            : reason === 'WEB_PUSH_ONLINE'
              ? 'suppressed'
              : 'skipped';
    return { ...counts, status, ...(counts.attempted === 0 ? { reason } : {}) };
  }

  private async expire(client: StoredWebPushClient): Promise<void> {
    try {
      await this.input.clients.expire({
        subscriptionId: client.subscriptionId,
        bindingVersion: client.bindingVersion,
        endpoint: client.subscription.endpoint
      });
    } catch {
      this.input.report?.('WEB_PUSH_DISPATCH_FAILED');
    }
  }
}
