import {
  mailNotificationRequestSchema,
  type MailNotificationResponse,
  type NodeEnvelope
} from '@myagentroam/protocol';
import type { MailNotificationService } from './mail-notification-service.js';

export async function resolveMailNotification(input: {
  readonly nodeId: string;
  readonly envelope: NodeEnvelope;
  readonly isCurrentConnection: () => boolean;
  readonly service: Pick<MailNotificationService, 'send'> | undefined;
  readonly respond: (payload: MailNotificationResponse) => void;
}): Promise<void> {
  const failure = (code: string): MailNotificationResponse => ({
    error: {
      code,
      message:
        code === 'MAIL_RECIPIENT_NOT_CONFIGURED'
          ? 'The initiating account has no valid email address. Configure an account email or specify recipientEmail.'
          : 'The notification email could not be sent.'
    }
  });
  if (!input.isCurrentConnection()) {
    input.respond(failure('MAIL_SERVER_UNAVAILABLE'));
    return;
  }
  const parsed = mailNotificationRequestSchema.safeParse(input.envelope.payload);
  if (!parsed.success) {
    input.respond(failure('MAIL_INPUT_INVALID'));
    return;
  }
  if (input.service === undefined) {
    input.respond(failure('MAIL_NOT_CONFIGURED'));
    return;
  }
  try {
    await input.service.send(input.nodeId, parsed.data);
    input.respond(
      input.isCurrentConnection() ? { accepted: true } : failure('MAIL_DELIVERY_UNCERTAIN')
    );
  } catch (error) {
    const code =
      error instanceof Error && /^MAIL_[A-Z0-9_]+$/u.test(error.message)
        ? error.message
        : 'MAIL_DELIVERY_UNCERTAIN';
    input.respond(failure(code));
  }
}
