import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createInterface, type Interface as ReadlineInterface } from 'node:readline';
import { terminateProcessTree } from '../process-tree.js';
import { ComputerUseError } from './contracts.js';
import {
  MAX_IMAGE_BYTES,
  MAX_IMAGES,
  PYTHON_CLEANUP_SOURCE,
  PYTHON_WORKER_SOURCE
} from './worker-source.js';

const MAX_TEXT_BYTES = 1024 * 1024;

export class PythonWorker {
  readonly #exited: Promise<void>;
  readonly #pending = new Map<
    string,
    {
      readonly resolve: (value: WorkerResult) => void;
      readonly reject: (error: unknown) => void;
    }
  >();
  #stderr = '';
  #closed = false;
  #closePromise: Promise<void> | undefined;
  #requestStarted = false;

  private constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly lines: ReadlineInterface,
    private readonly directory: string
  ) {
    this.#exited = new Promise((resolveExit) => this.child.once('close', () => resolveExit()));
    this.lines.on('line', (line) => this.#handleLine(line));
    this.child.stderr.on('data', (chunk: Buffer) => {
      this.#stderr = boundedText(`${this.#stderr}${chunk.toString('utf8')}`);
    });
    this.child.once('exit', (code, signal) => {
      const error = new ComputerUseError(
        'COMPUTER_WORKER_EXITED',
        `Computer Use worker exited (${code ?? signal ?? 'unknown'}).${this.#stderr ? ` ${this.#stderr}` : ''}`
      );
      for (const pending of this.#pending.values()) pending.reject(error);
      this.#pending.clear();
    });
  }

  get startedRequest(): boolean {
    return this.#requestStarted;
  }

  static async start(
    runtimeExecutable: string,
    onStarting: (worker: PythonWorker) => void
  ): Promise<PythonWorker> {
    const directory = await mkdtemp(resolve(tmpdir(), 'mar-computer-use-'));
    const script = resolve(directory, 'worker.py');
    let child: ChildProcessWithoutNullStreams;
    try {
      await writeFile(script, PYTHON_WORKER_SOURCE, { encoding: 'utf8', mode: 0o600 });
      child = spawn(runtimeExecutable, ['-u', script], {
        cwd: directory,
        env: minimalWorkerEnvironment(),
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        detached: process.platform !== 'win32'
      });
    } catch (error) {
      try {
        await rm(directory, { recursive: true, force: true });
      } catch (cleanup) {
        throw new ComputerUseError(
          'COMPUTER_CLEANUP_FAILED',
          'Computer Use worker startup cleanup failed.',
          {
            cause: new AggregateError([error, cleanup])
          }
        );
      }
      throw error;
    }
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    const worker = new PythonWorker(child, lines, directory);
    try {
      onStarting(worker);
    } catch (error) {
      try {
        await worker.close();
      } catch (cleanup) {
        throw new ComputerUseError(
          'COMPUTER_CLEANUP_FAILED',
          'Computer Use worker handoff cleanup failed.',
          {
            cause: new AggregateError([error, cleanup])
          }
        );
      }
      throw error;
    }
    await waitForWorkerReady(lines, child);
    return worker;
  }

  execute(code: string, timeoutMs: number, signal: AbortSignal): Promise<WorkerResult> {
    this.#requestStarted = false;
    if (this.#closed)
      return Promise.reject(
        new ComputerUseError('COMPUTER_WORKER_EXITED', 'Computer Use worker is closed.')
      );
    const id = randomUUID();
    return new Promise<WorkerResult>((resolve, reject) => {
      let settled = false;
      const finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener('abort', abort);
        this.#pending.delete(id);
        callback();
      };
      const abort = () =>
        finish(() =>
          reject(
            new ComputerUseError(
              'COMPUTER_EXECUTION_CANCELLED',
              'Computer Use execution cancelled.'
            )
          )
        );
      const timer = setTimeout(
        () =>
          finish(() =>
            reject(
              new ComputerUseError(
                'COMPUTER_EXECUTION_TIMEOUT',
                'Computer Use execution timed out.'
              )
            )
          ),
        timeoutMs
      );
      if (signal.aborted) {
        abort();
        return;
      }
      this.#requestStarted = true;
      this.#pending.set(id, {
        resolve: (value) => finish(() => resolve(value)),
        reject: (error) => finish(() => reject(error))
      });
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) {
        abort();
        return;
      }
      this.child.stdin.write(`${JSON.stringify({ id, code })}\n`, (error) => {
        if (error !== null && error !== undefined)
          finish(() =>
            reject(
              new ComputerUseError('COMPUTER_WORKER_WRITE_FAILED', 'Worker request failed.', {
                cause: error
              })
            )
          );
      });
    });
  }

  close(): Promise<void> {
    if (this.#closePromise !== undefined) return this.#closePromise;
    this.#closed = true;
    this.#closePromise = (async () => {
      this.lines.close();
      this.child.stdin.end();
      if (this.child.exitCode === null && this.child.signalCode === null)
        await terminateProcessTree(this.child).catch(() => this.child.kill('SIGKILL'));
      if (!(await this.#waitForExit(2_000))) {
        try {
          if (process.platform !== 'win32' && this.child.pid !== undefined)
            process.kill(-this.child.pid, 'SIGKILL');
          else this.child.kill('SIGKILL');
        } catch {
          this.child.kill('SIGKILL');
        }
        if (!(await this.#waitForExit(2_000)))
          throw new ComputerUseError(
            'COMPUTER_WORKER_EXIT_FAILED',
            'Computer Use worker did not exit.'
          );
      }
      if (this.child.pid !== undefined)
        await runWorkerCleanup(this.child.spawnfile, this.directory);
      await rm(this.directory, { recursive: true, force: true });
    })();
    return this.#closePromise;
  }

  #waitForExit(timeoutMs: number): Promise<boolean> {
    return new Promise((resolveWait) => {
      const timer = setTimeout(() => resolveWait(false), timeoutMs);
      void this.#exited.then(() => {
        clearTimeout(timer);
        resolveWait(true);
      });
    });
  }

  #handleLine(line: string): void {
    let value: unknown;
    try {
      value = JSON.parse(line) as unknown;
    } catch {
      return;
    }
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return;
    const message = value as WorkerMessage;
    if (message.type === 'ready') return;
    const pending = typeof message.id === 'string' ? this.#pending.get(message.id) : undefined;
    if (pending === undefined) return;
    if (message.type === 'result') {
      try {
        pending.resolve({
          logs: Array.isArray(message.logs)
            ? message.logs
                .filter((value): value is string => typeof value === 'string')
                .map((value) => boundedText(value))
            : [],
          images: parseWorkerImages(message.images)
        });
      } catch (error) {
        pending.reject(error);
      }
      return;
    }
    if (message.type !== 'error') return;
    pending.reject(
      new ComputerUseError(
        'COMPUTER_PYTHON_FAILED',
        typeof message.error === 'string' ? boundedText(message.error) : 'Python execution failed.'
      )
    );
  }
}

function parseWorkerImages(
  value: unknown
): { readonly mimeType: string; readonly dataBase64: string }[] {
  if (!Array.isArray(value) || value.length > MAX_IMAGES)
    throw new ComputerUseError('COMPUTER_IMAGE_INVALID', 'Worker returned invalid images.');
  return value.map((candidate) => {
    if (
      candidate === null ||
      typeof candidate !== 'object' ||
      (candidate as Record<string, unknown>)['mimeType'] !== 'image/png' ||
      typeof (candidate as Record<string, unknown>)['dataBase64'] !== 'string'
    )
      throw new ComputerUseError('COMPUTER_IMAGE_INVALID', 'Worker returned an invalid image.');
    const dataBase64 = (candidate as Record<string, unknown>)['dataBase64'] as string;
    if (dataBase64.length > Math.ceil((MAX_IMAGE_BYTES * 4) / 3) + 4)
      throw new ComputerUseError(
        'COMPUTER_IMAGE_TOO_LARGE',
        'Worker image exceeds the size limit.'
      );
    const bytes = Buffer.from(dataBase64, 'base64');
    if (
      bytes.length === 0 ||
      bytes.length > MAX_IMAGE_BYTES ||
      !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    )
      throw new ComputerUseError('COMPUTER_IMAGE_INVALID', 'Worker returned an invalid PNG image.');
    return { mimeType: 'image/png', dataBase64 };
  });
}

interface WorkerResult {
  readonly logs: string[];
  readonly images: { readonly mimeType: string; readonly dataBase64: string }[];
}

type WorkerMessage =
  | { readonly type: 'ready' }
  | {
      readonly type: 'result';
      readonly id: string;
      readonly logs?: unknown;
      readonly images?: unknown;
    }
  | { readonly type: 'error'; readonly id: string; readonly error?: unknown };

async function waitForWorkerReady(
  lines: ReadlineInterface,
  child: ChildProcessWithoutNullStreams
): Promise<void> {
  await new Promise<void>((resolveReady, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new ComputerUseError('COMPUTER_WORKER_START_FAILED', 'Worker start timed out.'));
    }, 10_000);
    const line = (value: string) => {
      try {
        if ((JSON.parse(value) as WorkerMessage).type !== 'ready') return;
      } catch {
        return;
      }
      cleanup();
      resolveReady();
    };
    const exit = () => {
      cleanup();
      reject(new ComputerUseError('COMPUTER_WORKER_START_FAILED', 'Worker exited during startup.'));
    };
    const failed = (error: Error) => {
      cleanup();
      reject(
        new ComputerUseError('COMPUTER_WORKER_START_FAILED', 'Worker could not start.', {
          cause: error
        })
      );
    };
    const cleanup = () => {
      clearTimeout(timeout);
      lines.off('line', line);
      child.off('exit', exit);
      child.off('error', failed);
    };
    lines.on('line', line);
    child.once('exit', exit);
    child.once('error', failed);
  });
}

async function runWorkerCleanup(executable: string, directory: string): Promise<void> {
  const child = spawn(executable, ['-c', PYTHON_CLEANUP_SOURCE], {
    cwd: directory,
    env: minimalWorkerEnvironment(),
    detached: process.platform !== 'win32',
    stdio: 'ignore',
    windowsHide: true
  });
  await new Promise<void>((resolveCleanup, reject) => {
    let timedOut = false;
    let forceTimer: ReturnType<typeof setTimeout> | undefined;
    const timer = setTimeout(() => {
      timedOut = true;
      void terminateProcessTree(child).catch(() => child.kill('SIGKILL'));
      forceTimer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(
          new ComputerUseError(
            'COMPUTER_CLEANUP_FAILED',
            'Computer Use cleanup process did not exit.'
          )
        );
      }, 2_000);
    }, 5_000);
    const finish = (error?: Error) => {
      clearTimeout(timer);
      if (forceTimer !== undefined) clearTimeout(forceTimer);
      if (error !== undefined) reject(error);
      else resolveCleanup();
    };
    child.once('close', (code) => {
      if (timedOut || code !== 0)
        finish(
          new ComputerUseError('COMPUTER_CLEANUP_FAILED', 'Computer Use cleanup process failed.')
        );
      else finish();
    });
    child.once('error', (error) =>
      finish(
        new ComputerUseError(
          'COMPUTER_CLEANUP_FAILED',
          'Computer Use cleanup process could not start.',
          { cause: error }
        )
      )
    );
  });
}

function minimalWorkerEnvironment(): NodeJS.ProcessEnv {
  const keys = [
    'PATH',
    'SystemRoot',
    'WINDIR',
    'TEMP',
    'TMP',
    'TMPDIR',
    'HOME',
    'USERPROFILE',
    'DISPLAY',
    'XAUTHORITY',
    'LANG',
    'LC_ALL'
  ];
  const environment: NodeJS.ProcessEnv = {};
  for (const key of keys) {
    const value = process.env[key];
    if (value !== undefined) environment[key] = value;
  }
  return environment;
}

function boundedText(value: string): string {
  const bytes = Buffer.from(value);
  return bytes.length <= MAX_TEXT_BYTES
    ? value
    : `${bytes.subarray(0, MAX_TEXT_BYTES).toString('utf8')}\n[truncated]`;
}
