import {
  createEnvelope,
  notificationChannelsRequestSchema,
  notificationChannelsResponseSchema,
  type NotificationChannelsRequest,
  type NotificationChannelsResult,
  mailNotificationRequestSchema,
  mailNotificationResponseSchema,
  type MailNotificationRequest,
  type NodeEnvelope
} from '@myagentroam/protocol';

interface Pending {
  readonly generation: number;
  readonly resolve: (value?: NotificationChannelsResult) => void;
  readonly channel: string;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
}

export class MailNotificationControl {
  private readonly pending = new Map<string, Pending>();
  private generation = 0;
  private connectedToServer = false;
  private closed = false;
  private channelsAvailable = false;

  supportsChannels(): boolean {
    return this.channelsAvailable && this.connectedToServer && !this.closed;
  }

  setFeatures(payload: unknown): void {
    const features = payload as { notificationChannels?: { apiVersion?: unknown } } | undefined;
    this.channelsAvailable = features?.notificationChannels?.apiVersion === 1;
  }

  constructor(private readonly sendEnvelope: (envelope: NodeEnvelope) => void) {}

  connected(): void {
    this.disconnected();
    this.connectedToServer = true;
  }

  disconnected(): void {
    this.connectedToServer = false;
    this.channelsAvailable = false;
    this.generation++;
    for (const pending of [...this.pending.values()])
      pending.reject(new Error('MAIL_DELIVERY_UNCERTAIN'));
  }

  close(): void {
    this.closed = true;
    this.disconnected();
  }

  handle(envelope: NodeEnvelope): boolean {
    if (!['mail.notification.response', 'notification.channels.response'].includes(envelope.type))
      return false;
    const pending = envelope.replyTo === undefined ? undefined : this.pending.get(envelope.replyTo);
    if (
      pending === undefined ||
      pending.generation !== this.generation ||
      pending.channel !== envelope.type
    )
      return true;
    if (envelope.type === 'notification.channels.response') {
      const result = notificationChannelsResponseSchema.safeParse(envelope.payload);
      if (!result.success) pending.reject(new Error('NOTIFICATION_RESPONSE_INVALID'));
      else if ('error' in result.data) pending.reject(new Error(result.data.error.code));
      else pending.resolve(result.data);
      return true;
    }
    const parsed = mailNotificationResponseSchema.safeParse(envelope.payload);
    if (!parsed.success) pending.reject(new Error('MAIL_RESPONSE_INVALID'));
    else if ('error' in parsed.data) pending.reject(new Error(parsed.data.error.code));
    else pending.resolve();
    return true;
  }

  request(input: MailNotificationRequest): Promise<void> {
    return this.requestEnvelope(
      createEnvelope('mail.notification.send', mailNotificationRequestSchema.parse(input))
    ).then(() => undefined);
  }

  notification(input: NotificationChannelsRequest): Promise<NotificationChannelsResult> {
    if (!this.supportsChannels()) return Promise.reject(new Error('NOTIFICATION_UNSUPPORTED'));
    return this.requestEnvelope(
      createEnvelope('notification.channels.send', notificationChannelsRequestSchema.parse(input))
    ).then((result) => {
      if (result === undefined) throw new Error('NOTIFICATION_RESPONSE_INVALID');
      if (result.callId !== input.callId) throw new Error('NOTIFICATION_RESPONSE_INVALID');
      return result;
    });
  }

  private requestEnvelope(envelope: NodeEnvelope): Promise<NotificationChannelsResult | undefined> {
    if (!this.connectedToServer || this.closed)
      return Promise.reject(new Error('MAIL_SERVER_UNAVAILABLE'));
    return new Promise((resolve, reject) => {
      const settle = (action: () => void) => {
        const pending = this.pending.get(envelope.id);
        if (pending === undefined) return;
        clearTimeout(pending.timer);
        this.pending.delete(envelope.id);
        action();
      };
      const timer = setTimeout(
        () => settle(() => reject(new Error('MAIL_DELIVERY_UNCERTAIN'))),
        30_000
      );
      timer.unref();
      this.pending.set(envelope.id, {
        generation: this.generation,
        channel:
          envelope.type === 'mail.notification.send'
            ? 'mail.notification.response'
            : 'notification.channels.response',
        resolve: (result) => settle(() => resolve(result)),
        reject: (error) => settle(() => reject(error)),
        timer
      });
      try {
        this.sendEnvelope(envelope);
      } catch {
        settle(() => reject(new Error('MAIL_SERVER_UNAVAILABLE')));
      }
    });
  }
}
