import { createInterface } from 'node:readline/promises';

export class TerminalInputClosed extends Error {
  constructor() {
    super('Terminal input is closed.');
  }
}

/** One interactive transaction at a time per terminal, including multi-question requests. */
export class TerminalInput {
  #terminal: ReturnType<typeof createInterface> | undefined;
  #tail: Promise<void> = Promise.resolve();
  #lines: string[] = [];
  #waiter: { resolve: (line: string) => void; reject: (reason: unknown) => void } | undefined;
  #closed = false;

  constructor(private readonly create: () => ReturnType<typeof createInterface>) {}

  run<T>(
    signal: AbortSignal | undefined,
    work: (ask: (prompt: string) => Promise<string>) => Promise<T>
  ): Promise<T> {
    const operation = this.#tail.then(async () => {
      signal?.throwIfAborted();
      return work((prompt) => this.#ask(prompt, signal));
    });
    this.#tail = operation.then(
      () => undefined,
      () => undefined
    );
    if (!signal) return operation;
    return new Promise<T>((resolve, reject) => {
      const aborted = () => reject(signal.reason);
      if (signal.aborted) aborted();
      else signal.addEventListener('abort', aborted, { once: true });
      operation.then(resolve, reject).finally(() => signal.removeEventListener('abort', aborted));
    });
  }

  #ask(prompt: string, signal: AbortSignal | undefined): Promise<string> {
    signal?.throwIfAborted();
    if (this.#closed) {
      const line = this.#lines.shift();
      return line === undefined ? Promise.reject(new TerminalInputClosed()) : Promise.resolve(line);
    }
    if (!this.#terminal) {
      this.#terminal = this.create();
      this.#terminal.on('line', (line) => {
        const waiter = this.#waiter;
        if (waiter) {
          this.#waiter = undefined;
          waiter.resolve(line);
        } else this.#lines.push(line);
      });
      this.#terminal.on('close', () => {
        this.#closed = true;
        const waiter = this.#waiter;
        this.#waiter = undefined;
        waiter?.reject(new TerminalInputClosed());
      });
    }
    this.#terminal.setPrompt(prompt);
    this.#terminal.prompt();
    const line = this.#lines.shift();
    if (line !== undefined) return Promise.resolve(line);
    return new Promise<string>((resolve, reject) => {
      const finish = (callback: () => void) => {
        signal?.removeEventListener('abort', abort);
        callback();
      };
      const abort = () => {
        this.#waiter = undefined;
        finish(() => reject(signal!.reason));
      };
      this.#waiter = {
        resolve: (value) => finish(() => resolve(value)),
        reject: (error) => finish(() => reject(error))
      };
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
    });
  }

  close(): void {
    this.#closed = true;
    this.#lines = [];
    this.#terminal?.close();
  }
}
