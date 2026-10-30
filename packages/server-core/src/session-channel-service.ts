import { serializeComposerTag, type ChannelOrigin } from '@myagentroam/protocol';
import type {
  SessionInputContext,
  SessionInputService,
  SessionMessageInput
} from './session-input-service.js';

export type ChannelExecutionContext = SessionInputContext;
export interface ChannelMessageInput {
  readonly origin: ChannelOrigin;
  readonly message: SessionMessageInput;
}

/** Adapters resolve access and execution identity; this entry only attaches provenance. */
export class SessionChannelService {
  constructor(
    private readonly sessions: Pick<
      SessionInputService,
      'submitMessage' | 'interrupt' | 'executeCommand'
    >
  ) {}

  async submitMessage(
    context: ChannelExecutionContext,
    input: ChannelMessageInput
  ): Promise<unknown> {
    const tag = serializeComposerTag('mar_channel', input.origin);
    return this.sessions.submitMessage(context, {
      ...input.message,
      content: input.message.content.length === 0 ? tag : tag + '\n' + input.message.content
    });
  }

  interrupt(context: ChannelExecutionContext): Promise<unknown> {
    return this.sessions.interrupt(context);
  }

  executeCommand(
    context: ChannelExecutionContext,
    input: { commandId: string; input: string; modelId?: string }
  ): Promise<unknown> {
    return this.sessions.executeCommand(context, input);
  }
}
