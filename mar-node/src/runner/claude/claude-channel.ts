import { randomUUID } from 'node:crypto';

import type { ChannelDelivery } from '../contracts.js';

export interface ClaudeChannelMessage {
  readonly id: string;
  readonly senderId: string;
  readonly token: string;
  readonly content: string;
}

export interface ClaudeChannelReceipt {
  readonly messageId: string;
  readonly result: Exclude<ChannelDelivery, 'PENDING_RECEIPT'>;
}

/**
 * Per-session authorization and receipt bookkeeping for a Channel MCP plugin.
 * A transport may acknowledge only that it wrote an event; callers must wait
 * for acknowledge() before displaying a steering success.
 */
export class ClaudeChannelGate {
  private readonly allowedSenders: ReadonlySet<string>;
  private readonly deliveries = new Map<string, ChannelDelivery>();

  constructor(
    readonly sessionId: string,
    readonly token: string = randomUUID(),
    senders: readonly string[] = ['admin'],
    private readonly expiresAt = Date.now() + 10 * 60_000,
    private readonly now: () => number = Date.now
  ) {
    this.allowedSenders = new Set(senders);
  }

  accept(message: ClaudeChannelMessage): ChannelDelivery {
    if (
      message.token !== this.token ||
      !this.allowedSenders.has(message.senderId) ||
      this.now() >= this.expiresAt ||
      message.content.length === 0
    ) {
      return 'REJECTED';
    }
    const previous = this.deliveries.get(message.id);
    if (previous !== undefined) return previous;
    this.deliveries.set(message.id, 'PENDING_RECEIPT');
    return 'PENDING_RECEIPT';
  }

  acknowledge(receipt: ClaudeChannelReceipt): ChannelDelivery {
    const previous = this.deliveries.get(receipt.messageId);
    if (previous !== 'PENDING_RECEIPT') return 'REJECTED';
    this.deliveries.set(receipt.messageId, receipt.result);
    return receipt.result;
  }

  delivery(messageId: string): ChannelDelivery | undefined {
    return this.deliveries.get(messageId);
  }
}
