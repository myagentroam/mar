import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { PassThrough, type Stream } from 'node:stream';
import type { LocalProcessExecutor } from '@myagentroam/agent';
import { ReadBuffer, serializeMessage } from '@modelcontextprotocol/sdk/shared/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';

export interface ExecutorStdioClientTransportOptions {
  readonly processExecutor: LocalProcessExecutor;
  readonly command: string;
  readonly args?: readonly string[];
  readonly environment: NodeJS.ProcessEnv;
  readonly environmentKeys: readonly string[];
  readonly cwd: string;
  readonly owner: { readonly sessionId: string; readonly executionId: string };
  readonly maxBufferSize?: number;
}

/** MCP stdio transport whose process creation is delegated to the Host executor. */
export class ExecutorStdioClientTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  readonly #readBuffer: ReadBuffer;
  readonly #stderr = new PassThrough();
  #child: ChildProcessWithoutNullStreams | undefined;
  #closing: Promise<void> | undefined;

  constructor(private readonly options: ExecutorStdioClientTransportOptions) {
    this.#readBuffer = new ReadBuffer(
      options.maxBufferSize === undefined ? {} : { maxBufferSize: options.maxBufferSize }
    );
  }

  get stderr(): Stream {
    return this.#stderr;
  }

  get pid(): number | null {
    return this.#child?.pid ?? null;
  }

  async start(): Promise<void> {
    if (this.#child !== undefined) throw new Error('MCP_EXECUTOR_TRANSPORT_ALREADY_STARTED');
    const child = await this.options.processExecutor.spawn({
      command: this.options.command,
      ...(this.options.args === undefined ? {} : { args: this.options.args }),
      cwd: this.options.cwd,
      shell: false,
      environment: this.options.environment,
      environmentKeys: this.options.environmentKeys,
      detached: process.platform !== 'win32',
      owner: this.options.owner
    });
    this.#child = child;
    child.once('error', (error) => this.onerror?.(error));
    child.once('close', () => {
      if (this.#child === child) this.#child = undefined;
      this.onclose?.();
    });
    child.stdin.on('error', (error) => this.onerror?.(error));
    child.stdout.on('error', (error) => this.onerror?.(error));
    child.stdout.on('data', (chunk: Buffer) => {
      try {
        this.#readBuffer.append(chunk);
        this.#processReadBuffer();
      } catch (error) {
        this.onerror?.(asError(error));
        void this.close();
      }
    });
    child.stderr.pipe(this.#stderr);
  }

  async send(message: JSONRPCMessage): Promise<void> {
    const child = this.#child;
    if (child === undefined) throw new Error('MCP_EXECUTOR_TRANSPORT_NOT_CONNECTED');
    const content = serializeMessage(message);
    if (child.stdin.write(content)) return;
    await new Promise<void>((resolve, reject) => {
      const error = (value: Error) => {
        child.stdin.off('drain', resolve);
        reject(value);
      };
      child.stdin.once('error', error);
      child.stdin.once('drain', () => {
        child.stdin.off('error', error);
        resolve();
      });
    });
  }

  close(): Promise<void> {
    if (this.#closing !== undefined) return this.#closing;
    this.#closing = this.#close();
    return this.#closing;
  }

  async #close(): Promise<void> {
    const child = this.#child;
    this.#child = undefined;
    this.#readBuffer.clear();
    if (child === undefined) return;
    child.stdin.end();
    if (child.exitCode === null) await signalProcessTree(child, 'SIGTERM');
    if (!(await waitForClose(child, 2_000))) await signalProcessTree(child, 'SIGKILL');
    await waitForClose(child, 2_000);
  }

  #processReadBuffer(): void {
    while (true) {
      const message = this.#readBuffer.readMessage();
      if (message === null) return;
      this.onmessage?.(message);
    }
  }
}

async function signalProcessTree(
  child: ChildProcessWithoutNullStreams,
  signal: NodeJS.Signals
): Promise<void> {
  if (child.pid === undefined) return;
  if (process.platform !== 'win32') {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return;
    }
  }
  child.kill(signal);
}

async function waitForClose(
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number
): Promise<boolean> {
  if (child.exitCode !== null) return true;
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      new Promise<true>((resolve) => child.once('close', () => resolve(true))),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
        timer.unref();
      })
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
