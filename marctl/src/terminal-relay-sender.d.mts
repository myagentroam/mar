interface RelaySocket {
  readonly readyState: number;
  readonly bufferedAmount?: number;
  send(value: string, callback: (error?: Error) => void): void;
}

export class TerminalRelaySender {
  constructor(
    socket: RelaySocket,
    options?: {
      readonly onPendingChange?: (keys: ReadonlySet<string>) => void;
    }
  );
  send(value: string, key?: string): Promise<void>;
  cancel(key: string): void;
  close(error?: Error): void;
}
