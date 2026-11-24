import {
  browserAttachmentMessageSchema,
  type BrowserAttachmentEvent,
  type BrowserAttachmentOpen,
  type BrowserAttachmentPrepare,
  type BrowserAttachmentRoute,
  type BrowserDownloadRequest,
  type BrowserUpload
} from '@myagentroam/protocol';
import { BrowserAttachment, type BrowserAttachmentEncoder } from './browser-attachment.js';
import { BROWSER_CAPTURE_QUALITY } from './browser-video-config.js';
import type { BrowserSessionService } from './browser-session-service.js';
import type { BrowserTabs } from './browser-tabs.js';

export interface BrowserAttachmentChannel {
  sendControl(event: BrowserAttachmentEvent): void;
  sendFrame(chunk: Uint8Array, signal: AbortSignal): Promise<void>;
  close(code: string): void;
}

type Entry = {
  grant: BrowserAttachmentPrepare;
  expiresAt: number;
  channel?: BrowserAttachmentChannel;
  attachment?: BrowserAttachment;
  ownsBorrow?: true;
  opening?: Promise<void>;
  closing?: Promise<void>;
};

/** Owns Node-side leases and one-shot admission for both data paths. Accepts
 * preparation only from the authenticated Node control connection. Transport
 * adapters attest the route but do not grant access or manage the browser.
 */
export class BrowserAttachmentService {
  private readonly entries = new Map<string, Entry>();
  private readonly timer: ReturnType<typeof setInterval>;
  private stopped = false;

  constructor(
    private readonly options: {
      sessions: Pick<BrowserSessionService<BrowserTabs>, 'lookup' | 'pin'>;
      encoder: (hd: boolean) => Promise<BrowserAttachmentEncoder>;
      failed: (error: unknown) => void;
    }
  ) {
    this.timer = setInterval(() => {
      for (const [id, entry] of this.entries) {
        if (entry.expiresAt <= Date.now())
          void this.revoke(id, 'BROWSER_LEASE_EXPIRED').catch(options.failed);
      }
    }, 500);
    this.timer.unref();
  }

  prepare(grant: BrowserAttachmentPrepare): void {
    if (this.stopped || this.entries.has(grant.attachmentId) || grant.expiresAt <= Date.now()) {
      throw new Error('BROWSER_INVALID_PREPARATION');
    }
    if (this.options.sessions.lookup(grant) !== grant.browserId)
      throw new Error('BROWSER_SESSION_ENDED');
    this.entries.set(grant.attachmentId, { grant, expiresAt: grant.expiresAt });
  }

  async open(
    open: BrowserAttachmentOpen,
    route: BrowserAttachmentRoute,
    channel: BrowserAttachmentChannel
  ): Promise<void> {
    const entry = this.entries.get(open.attachmentId);
    if (
      !entry ||
      entry.opening ||
      entry.closing ||
      entry.expiresAt <= Date.now() ||
      entry.grant.ticket !== open.ticket ||
      !this.matchesRoute(entry.grant.route, route)
    ) {
      throw new Error('BROWSER_INVALID_GRANT');
    }
    entry.channel = channel;
    const hd = entry.grant.route.type === 'ice' && open.hd === true;
    entry.opening = Promise.resolve().then(() => this.activate(entry, channel, hd));
    try {
      await entry.opening;
    } catch (error) {
      await this.revoke(open.attachmentId, 'BROWSER_ATTACH_FAILED');
      throw error;
    }
  }

  receive(id: string, channel: BrowserAttachmentChannel, data: unknown): void {
    const entry = this.entries.get(id);
    if (!entry || entry.closing || entry.channel !== channel) return;
    if (entry.expiresAt <= Date.now()) {
      void this.revoke(id, 'BROWSER_LEASE_EXPIRED').catch(this.options.failed);
      return;
    }
    const message = browserAttachmentMessageSchema.safeParse(data);
    if (!entry.attachment || !message.success) {
      void this.revoke(id, 'BROWSER_INVALID_MESSAGE').catch(this.options.failed);
      return;
    }
    entry.attachment.receive(message.data);
  }

  renew(id: string, expiresAt: number): boolean {
    const entry = this.entries.get(id);
    if (!entry || entry.closing || entry.expiresAt <= Date.now() || expiresAt <= Date.now())
      return false;
    entry.expiresAt = Math.max(entry.expiresAt, expiresAt);
    return true;
  }

  upload(userId: number, request: BrowserUpload): Promise<void> {
    const attachment = this.fileAttachment(userId, request.attachmentId);
    return attachment
      ? attachment.upload(request)
      : Promise.reject(new Error('BROWSER_LEASE_ENDED'));
  }

  download(userId: number, request: BrowserDownloadRequest): Promise<unknown> {
    const attachment = this.fileAttachment(userId, request.attachmentId);
    return attachment
      ? attachment.download(request)
      : Promise.reject(new Error('BROWSER_LEASE_ENDED'));
  }

  private fileAttachment(userId: number, id: string): BrowserAttachment | undefined {
    const entry = this.entries.get(id);
    if (entry?.grant.userId === userId && !entry.closing && entry.expiresAt > Date.now())
      return entry.attachment;
  }

  disconnected(id: string, channel: BrowserAttachmentChannel): Promise<void> {
    return this.entries.get(id)?.channel === channel
      ? this.revoke(id, 'BROWSER_DISCONNECTED')
      : Promise.resolve();
  }

  revoke(id: string, code: string): Promise<void> {
    const entry = this.entries.get(id);
    if (!entry) return Promise.resolve();
    if (entry.closing) return entry.closing;
    const disposal = entry.attachment?.close();
    entry.closing = Promise.resolve().then(async () => {
      try {
        entry.channel?.close(code);
      } finally {
        try {
          if (disposal) await disposal;
          else {
            await entry.opening?.catch(() => undefined);
            await entry.attachment?.close();
          }
        } finally {
          this.entries.delete(id);
        }
      }
    });
    return entry.closing;
  }

  async shutdown(): Promise<void> {
    this.stopped = true;
    clearInterval(this.timer);
    await this.disconnect('BROWSER_STOPPED');
  }

  disconnect(code: string): Promise<void> {
    return this.revokeAll([...this.entries.keys()], code);
  }

  async revokeBrowser(browserId: string): Promise<void> {
    const ids = [...this.entries]
      .filter(([, entry]) => entry.grant.browserId === browserId)
      .map(([id]) => id);
    await this.revokeAll(ids, 'BROWSER_SESSION_ENDED');
  }

  private async revokeAll(ids: string[], code: string): Promise<void> {
    const results = await Promise.allSettled(ids.map((id) => this.revoke(id, code)));
    for (const result of results)
      if (result.status === 'rejected') this.options.failed(result.reason);
  }

  private async activate(
    entry: Entry,
    channel: BrowserAttachmentChannel,
    hd: boolean
  ): Promise<void> {
    const grant = entry.grant;
    const prior = [...this.entries.values()].find(
      (candidate) =>
        candidate !== entry && candidate.ownsBorrow && candidate.grant.browserId === grant.browserId
    );
    if (prior) {
      if (
        prior.grant.attachmentId !== grant.replaces ||
        prior.grant.sessionId !== grant.sessionId ||
        prior.grant.connectionId !== grant.connectionId ||
        !prior.attachment
      )
        throw new Error('BROWSER_ATTACHMENT_BUSY');
      const closing = this.revoke(prior.grant.attachmentId, 'BROWSER_ATTACHMENT_REPLACED');
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          closing,
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => reject(new Error('BROWSER_HANDOFF_TIMEOUT')), 3_000);
            timer.unref();
          })
        ]);
      } finally {
        clearTimeout(timer);
      }
    }
    if (entry.closing || entry.expiresAt <= Date.now()) throw new Error('BROWSER_LEASE_EXPIRED');
    const borrow = this.options.sessions.pin(grant, grant.browserId);
    entry.ownsBorrow = true;
    let encoder: BrowserAttachmentEncoder | undefined;
    try {
      encoder = await this.options.encoder(hd);
      if (entry.closing || entry.expiresAt <= Date.now()) throw new Error('BROWSER_LEASE_EXPIRED');
      channel.sendControl({ type: 'ATTACHED', ...(encoder.hd && { hd: true }) });
      entry.attachment = new BrowserAttachment(borrow, {
        quality: BROWSER_CAPTURE_QUALITY,
        encoder,
        sendFrame: (chunk, signal) => channel.sendFrame(chunk, signal),
        sendControl: (event) => channel.sendControl(event),
        failed: (code) => void this.revoke(grant.attachmentId, code).catch(this.options.failed),
        deadlineMs: 5_000
      });
    } catch (error) {
      try {
        await encoder?.close();
      } finally {
        borrow.release();
      }
      throw error;
    }
  }

  private matchesRoute(wanted: BrowserAttachmentRoute, actual: BrowserAttachmentRoute): boolean {
    return wanted.type === 'relay'
      ? actual.type === 'relay'
      : actual.type === 'ice' &&
          wanted.transportId === actual.transportId &&
          wanted.fingerprint === actual.fingerprint;
  }
}
