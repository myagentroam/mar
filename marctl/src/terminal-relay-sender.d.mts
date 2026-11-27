interface RelaySocket {
  readonly readyState: number;
  readonly bufferedAmount?: number;
  send(value: Uint8Array, callback: (error?: Error) => void): void;
}

export class TerminalRelaySender {
  constructor(
    socket: RelaySocket,
    options?: {
      readonly onPendingChange?: (keys: ReadonlySet<string>) => void;
    }
  );
  send(value: Uint8Array, key?: string): Promise<void>;
  cancel(key: string): void;
  close(error?: Error): void;
}
