import type { NodeEnvelope } from '@myagentroam/protocol';
import type { RunnerInteractionService } from './runner-interaction-service.js';

interface RunnerChannelMessageServiceOptions {
  readonly interactions: RunnerInteractionService;
  readonly send: (type: string, payload: unknown, replyTo?: string) => void;
}

/** Validates shared-control channel messages before delivery to a Runner. */
export class RunnerChannelMessageService {
  constructor(private readonly options: RunnerChannelMessageServiceOptions) {}

  handle(envelope: NodeEnvelope): void {
    const payload = envelope.payload as {
      sessionId?: unknown;
      id?: unknown;
      senderId?: unknown;
      token?: unknown;
      content?: unknown;
    };
    if (
      typeof payload.sessionId !== 'string' ||
      typeof payload.id !== 'string' ||
      typeof payload.senderId !== 'string' ||
      typeof payload.token !== 'string' ||
      typeof payload.content !== 'string'
    ) {
      this.options.send('error', { code: 'MESSAGE_INVALID' }, envelope.id);
      return;
    }
    const delivery = this.options.interactions.deliverChannel(
      'claude-code',
      payload.sessionId,
      payload.id,
      payload.senderId,
      payload.token,
      payload.content
    );
    this.options.send('ack', { type: envelope.type, delivery }, envelope.id);
  }
}
