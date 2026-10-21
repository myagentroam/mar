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
