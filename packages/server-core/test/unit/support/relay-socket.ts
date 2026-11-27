import { decodeTerminalMessage, encodeTerminalMessage } from '@myagentroam/protocol';
import { EventEmitter } from 'node:events';
import { vi } from 'vitest';

export class RelaySocket extends EventEmitter {
  readyState = 1;
  OPEN = 1;
  bufferedAmount = 0;
  sent: Record<string, unknown>[] = [];
  send(raw: string, completed?: (error?: Error | null) => void) {
    this.sent.push(JSON.parse(raw));
    completed?.(null);
  }
  close = vi.fn(() => {
    this.readyState = 3;
    this.emit('close');
  });
  receive(message: unknown) {
    this.emit('message', Buffer.from(JSON.stringify(message)), false);
  }
}

export class TerminalRelaySocket extends RelaySocket {
  override send(raw: string | Uint8Array, completed?: (error?: Error | null) => void) {
    if (typeof raw === 'string') throw new Error('Expected a binary Terminal frame');
    this.sent.push(decodeTerminalMessage(raw));
    completed?.(null);
  }

  override receive(message: object) {
    this.emit('message', Buffer.from(encodeTerminalMessage(message)), true);
  }
}
