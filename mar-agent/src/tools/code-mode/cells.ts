import { permissionStopFromError } from '../permissions.js';
import { RuntimeResourceHandles } from '../runtime-resource-handles.js';
import { AgentError, describeAgentError } from '../../error.js';
import { truncateModelText } from '../../runtime/token-budget.js';
import type {
  CodeCellEventData,
  ExecOutputSnapshot,
  ToolExecutionContext,
  ToolExecutionResult
} from '../contracts.js';
import { TOOL_EXECUTION_LIMITS as limits } from '../execution-limits.js';
import { waitForToolCondition, waitMetadata, type ToolWaitInterrupt } from '../wait.js';
import { BoundedTextOutput, renderCapturedText } from './text-output.js';
import { boundObservations, newObservationId } from './observations.js';
import { publicCodeObservations } from '../output-projection.js';
import {
  selectObservationImages,
  visibleObservation
} from '../../session/code-observation-projection.js';
import type {
  CodeObservation,
  CodeToolCallRecord
} from '../../session/code-observation-contract.js';

export interface CellOutput {
  call(value: CodeToolCallRecord): void;
  observe(value: CodeObservation, display?: CodeObservation, displayHeadTruncated?: boolean): void;
  text(value: string, originalBytes?: number): void;
  image(value: NonNullable<ToolExecutionResult['images']>[number]): void;
  yield(): void;
}

/** Keeps a failed tool call observable without discarding earlier explicit output. */
export class CodeCellExecutionError extends AgentError {
  constructor(
    error: unknown,
    readonly result: ToolExecutionResult
  ) {
    // Preserve the original chain; the public boundary summarizes its causes only once.
    const diagnostic = describeAgentError(error, 'MAR_AGENT_CODE_FAILED', undefined, false);
    super(diagnostic.code, diagnostic.message, {
      cause: error,
      ...(error instanceof AgentError ? { retryable: error.retryable } : {})
    });
  }
}
type Status = 'running' | 'completed' | 'failed' | 'cancelled';
interface Cell {
  source: import('../contracts.js').ExecutionSource;
  cellId: string;
  sessionId: string;
  executionId: string;
  controller: AbortController;
  status: Status;
  text: BoundedTextOutput;
  images: NonNullable<ToolExecutionResult['images']>[number][];
  observations: CodeObservation[];
  display?: CodeCellEventData;
  calls: Map<string, CodeToolCallRecord>;
  imageOffset: number;
  yielded: boolean;
  truncated: boolean;
  listeners: Set<() => void>;
  outputListeners: Set<(output: ExecOutputSnapshot) => void>;
  done: Promise<void>;
  result?: ToolExecutionResult;
  error?: unknown;
  terminal?: ToolExecutionResult;
  retention?: ReturnType<typeof setTimeout>;
}

/** A waiting call owns its bounded display window; delivery never delays the cell. */
function forwardCellOutput(publish: (output: ExecOutputSnapshot) => Promise<void>) {
  let stopped = false;
  let failed = false;
  let inFlight = false;
  let pending = false;
  let latest: ExecOutputSnapshot | undefined;
  // Source metadata is bounded by the cell's tool-call budget; text shares one window.
  const sources = new Map<
    string,
    {
      stdout: string;
      stderr: string;
      stdoutBytes: number;
      stderrBytes: number;
      truncated: boolean;
    }
  >();
  const trim = (channel: 'stdout' | 'stderr') => {
    let excess =
      [...sources.values()].reduce(
        (bytes, source) => bytes + Buffer.byteLength(source[channel]),
        0
      ) - limits.execProgressMaxOutputBytes;
    for (const source of sources.values()) {
      if (excess <= 0) break;
      const bytes = Buffer.from(source[channel]);
      let removed = Math.min(excess, bytes.length);
      while (removed < bytes.length && (bytes[removed]! & 0xc0) === 0x80) removed++;
      source[channel] = bytes.subarray(removed).toString('utf8');
      excess -= removed;
    }
  };
  const snapshot = (): ExecOutputSnapshot => {
    const entries = [...sources.values()];
    const stdout = entries.map((source) => source.stdout).join('');
    const stderr = entries.map((source) => source.stderr).join('');
    const stdoutDroppedBytes =
      entries.reduce((bytes, source) => bytes + source.stdoutBytes, 0) - Buffer.byteLength(stdout);
    const stderrDroppedBytes =
      entries.reduce((bytes, source) => bytes + source.stderrBytes, 0) - Buffer.byteLength(stderr);
    return {
      ...latest!,
      mode: 'snapshot',
      stdout,
      stderr,
      truncated:
        entries.some((source) => source.truncated) ||
        stdoutDroppedBytes > 0 ||
        stderrDroppedBytes > 0,
      displayOutput: {
        stdout,
        stderr,
        stdoutDroppedBytes,
        stderrDroppedBytes
      }
    };
  };
  const send = (output: ExecOutputSnapshot) => {
    inFlight = true;
    void Promise.resolve()
      .then(() => (stopped ? undefined : publish(output)))
      .catch(() => {
        failed = true;
      })
      .finally(() => {
        inFlight = false;
        if (!stopped && !failed && pending) {
          pending = false;
          send(snapshot());
        }
      });
  };
  return {
    onOutput(output: ExecOutputSnapshot) {
      if (stopped || failed) return;
      const isSnapshot = output.mode !== 'delta';
      const source = sources.get(output.processId) ?? {
        stdout: '',
        stderr: '',
        stdoutBytes: 0,
        stderrBytes: 0,
        truncated: false
      };
      if (isSnapshot) {
        source.stdout = output.stdout;
        source.stderr = output.stderr;
        source.stdoutBytes =
          Buffer.byteLength(output.stdout) + (output.displayOutput?.stdoutDroppedBytes ?? 0);
        source.stderrBytes =
          Buffer.byteLength(output.stderr) + (output.displayOutput?.stderrDroppedBytes ?? 0);
        source.truncated = output.truncated;
      } else {
        source.stdout += output.stdout;
        source.stderr += output.stderr;
        source.stdoutBytes += Buffer.byteLength(output.stdout);
        source.stderrBytes += Buffer.byteLength(output.stderr);
        source.truncated ||= output.truncated;
      }
      sources.set(output.processId, source);
      trim('stdout');
      trim('stderr');
      latest = output;
      if (inFlight) pending = true;
      else send(isSnapshot ? snapshot() : { ...output, displayOutput: snapshot().displayOutput! });
    },
    stop() {
      stopped = true;
      pending = false;
      sources.clear();
      latest = undefined;
    }
  };
}

function options(value: unknown, wait: boolean) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new AgentError('MAR_AGENT_TOOL_INPUT_INVALID', 'Code Exec options must be an object.');
  const input = value as Record<string, unknown>;
  const action = wait && input.action === null ? undefined : input.action;
  const yieldMs =
    input.yieldMs ?? (wait ? limits.codeDefaultWaitYieldMs : limits.codeDefaultYieldMs);
  if (
    !Number.isSafeInteger(yieldMs) ||
    Number(yieldMs) < 0 ||
    Number(yieldMs) > (wait ? limits.codeMaxWaitYieldMs : limits.codeMaxYieldMs) ||
    (wait && (typeof input.cellId !== 'string' || !input.cellId)) ||
    (action !== undefined && action !== 'poll' && action !== 'cancel')
  )
    throw new AgentError('MAR_AGENT_TOOL_INPUT_INVALID', 'Code Exec options are out of range.');
  return {
    cellId: input.cellId as string,
    yieldMs: Number(yieldMs),
    action: action ?? 'poll'
  };
}

/** Session-owned execution, separate from the cancellable model-tool wait. */
export class CodeCells {
  readonly #cells = new Map<string, Cell>();
  readonly #handles = new RuntimeResourceHandles('cell', (id) => this.#cells.has(id));
  #closed = false;
  readonly #disposing = new Set<string>();

  async start(
    value: unknown,
    context: ToolExecutionContext,
    run: (
      code: string,
      context: ToolExecutionContext,
      output: CellOutput
    ) => Promise<ToolExecutionResult>
  ) {
    const source =
      typeof value === 'string'
        ? value
        : value &&
            typeof value === 'object' &&
            !Array.isArray(value) &&
            Object.keys(value).length === 1 &&
            'code' in value
          ? value.code
          : undefined;
    if (
      typeof source !== 'string' ||
      !source.trim() ||
      Buffer.byteLength(source) > limits.codeMaxInputBytes
    )
      throw new AgentError(
        'MAR_AGENT_TOOL_INPUT_INVALID',
        'Code must be a nonempty bounded JavaScript string.'
      );
    let settings = options({}, false);
    const pragma = /^\/\/ @options:\s*([^\r\n]*)(?:\r?\n|$)/u.exec(source);
    if (pragma) {
      try {
        settings = options(JSON.parse(pragma[1]!), false);
      } catch (error) {
        if (error instanceof AgentError) throw error;
        throw new AgentError(
          'MAR_AGENT_TOOL_INPUT_INVALID',
          'Code Exec options must be valid JSON.'
        );
      }
    }
    context.signal.throwIfAborted();
    if (this.#closed || this.#disposing.has(context.sessionId))
      throw new AgentError('MAR_AGENT_CODE_CANCELLED', 'Code Exec resources are being released.');
    if (
      [...this.#cells.values()].filter((cell) => cell.status === 'running').length >=
      limits.codeMaxConcurrentCells
    )
      throw new AgentError(
        'MAR_AGENT_PROCESS_LIMIT',
        `The Local Host shared running-cell limit (${limits.codeMaxConcurrentCells}) was reached.`
      );
    const controller = new AbortController();
    const cell: Cell = {
      source: { kind: 'CODE', text: source.slice(0, 10_000), truncated: source.length > 10_000 },
      cellId: this.#handles.create(),
      sessionId: context.sessionId,
      executionId: context.executionId,
      controller,
      status: 'running',
      text: new BoundedTextOutput(limits.codeMaxOutputBytes),
      images: [],
      observations: [],
      calls: new Map(),
      imageOffset: 0,
      yielded: false,
      truncated: false,
      listeners: new Set(),
      outputListeners: new Set(),
      done: Promise.resolve()
    };
    this.#cells.set(cell.cellId, cell);
    const unsubscribeOutput = context.codeMode?.subscribeToolOutput?.((output) => {
      for (const listener of cell.outputListeners) listener(output);
    });
    const notify = () => {
      for (const listener of cell.listeners) listener();
    };
    let releaseSession: (() => Promise<void>) | undefined;
    let outcome: Status = 'running';
    cell.done = Promise.resolve()
      .then(async () => {
        releaseSession = await context.codeMode?.retainSession?.();
        return run(
          source,
          { ...context, signal: controller.signal, waitInterrupt: undefined },
          {
            call: (value) => cell.calls.set(value.callId, value),
            observe: (value, display = value, displayHeadTruncated = false) => {
              cell.observations.push(value);
              const observations = [...(cell.display?.observations ?? []), display];
              cell.display = publicCodeObservations(observations, {
                cellId: cell.cellId,
                status: cell.status,
                observations,
                outputSourceKnown: true,
                ...(cell.display?.outputSourceTruncated ||
                (!displayHeadTruncated &&
                  (display.type === 'value'
                    ? display.truncated === true
                    : display.result.truncated === true))
                  ? { outputSourceTruncated: true }
                  : {}),
                ...(cell.display?.outputHeadTruncated || displayHeadTruncated
                  ? { outputHeadTruncated: true }
                  : {})
              });
            },
            text: (text, originalBytes) => cell.text.append(text, originalBytes),
            image: (image) => cell.images.push(image),
            yield: () => {
              cell.yielded = true;
              notify();
            }
          }
        );
      })
      .then(
        (result) => {
          cell.result = {
            content: '',
            ...(result.data === undefined ? {} : { data: result.data })
          };
          outcome = 'completed';
        },
        (error: unknown) => {
          cell.error = error;
          outcome = controller.signal.aborted ? 'cancelled' : 'failed';
        }
      )
      .then(async () => {
        unsubscribeOutput?.();
        try {
          await context.codeMode?.onSettled?.({
            cellId: cell.cellId,
            status: outcome,
            ...(permissionStopFromError(cell.error)
              ? { permissionStop: permissionStopFromError(cell.error)! }
              : {})
          });
        } catch (error) {
          cell.error = error;
          outcome = 'failed';
        }
        try {
          await releaseSession?.();
        } catch (error) {
          cell.error = error;
          outcome = 'failed';
        }
        cell.status = outcome;
        // Terminal capacity follows completion order, not the original start order.
        this.#cells.delete(cell.cellId);
        this.#cells.set(cell.cellId, cell);
        cell.retention = setTimeout(
          () => this.#cells.delete(cell.cellId),
          limits.codeCompletedRetentionMs
        );
        cell.retention.unref();
        const completed = [...this.#cells.values()].filter(
          (entry) => entry.sessionId === cell.sessionId && entry.status !== 'running'
        );
        for (const entry of completed.slice(
          0,
          Math.max(0, completed.length - limits.codeMaxCompletedResults)
        )) {
          clearTimeout(entry.retention);
          this.#cells.delete(entry.cellId);
        }
        notify();
      });
    return this.#wait(
      cell,
      settings,
      context.signal,
      true,
      context.codeMode?.supportsImages === true,
      context.waitInterrupt
    );
  }

  async wait(value: unknown, context: ToolExecutionContext) {
    const input = options(value, true);
    context.signal.throwIfAborted();
    this.#handles.assertType(input.cellId);
    const cell = this.#cells.get(input.cellId);
    if (!cell || cell.sessionId !== context.sessionId)
      throw new AgentError(
        'MAR_AGENT_CODE_CELL_NOT_FOUND',
        'Code Exec cell is unavailable in this Session.'
      );
    if (context.onExecutionSource) await context.onExecutionSource({ ...cell.source });
    context.signal.throwIfAborted();
    if (input.action === 'cancel' && cell.status === 'running') {
      cell.controller.abort(
        new AgentError('MAR_AGENT_CODE_CANCELLED', 'Code Exec cell was terminated.')
      );
      await new Promise<void>((resolve, reject) => {
        const abort = () => reject(context.signal.reason);
        context.signal.addEventListener('abort', abort, { once: true });
        void cell.done.then(() => {
          context.signal.removeEventListener('abort', abort);
          resolve();
        });
        if (context.signal.aborted) abort();
      });
    }
    const forward =
      cell.executionId !== context.executionId &&
      input.action === 'poll' &&
      input.yieldMs > 0 &&
      context.onOutput
        ? forwardCellOutput(context.onOutput)
        : undefined;
    if (forward) cell.outputListeners.add(forward.onOutput);
    try {
      return await this.#wait(
        cell,
        input,
        context.signal,
        false,
        context.codeMode?.supportsImages === true,
        input.action === 'poll' ? context.waitInterrupt : undefined
      );
    } finally {
      if (forward) {
        cell.outputListeners.delete(forward.onOutput);
        forward.stop();
      }
    }
  }

  async #wait(
    cell: Cell,
    input: { yieldMs: number },
    signal: AbortSignal,
    initial: boolean,
    supportsImages: boolean,
    interrupt?: ToolWaitInterrupt
  ): Promise<ToolExecutionResult> {
    const outcome =
      input.yieldMs === 0
        ? undefined
        : await waitForToolCondition({
            ready: () => cell.status !== 'running' || cell.yielded,
            subscribe: (notify) => {
              cell.listeners.add(notify);
              return () => {
                cell.listeners.delete(notify);
              };
            },
            waitMs: input.yieldMs,
            signal,
            interrupt
          });
    const wait = waitMetadata(
      input.yieldMs === 0
        ? 'snapshot'
        : cell.status !== 'running'
          ? 'completion'
          : cell.yielded
            ? 'yield'
            : outcome === 'interrupted'
              ? 'interrupted'
              : 'timeout'
    );
    signal.throwIfAborted();
    if (!supportsImages && (cell.images.length || cell.terminal?.images?.length))
      throw new AgentError(
        'MAR_AGENT_INPUT_CAPABILITY_UNSUPPORTED',
        'The current model cannot receive this cell image output.'
      );
    if (cell.terminal) {
      if (cell.terminal.observations) {
        const bounded = boundObservations(cell.terminal.observations, limits.codeMaxOutputTokens);
        const visible = selectObservationImages(bounded.observations, cell.terminal.images ?? []);
        const original = cell.terminal.data as { output?: string };
        const data = {
          ...original,
          output: truncateModelText(original.output ?? '', limits.codeMaxOutputTokens).content,
          observations: visible.observations,
          cached: true,
          ...wait,
          truncated: cell.terminal.truncated === true || bounded.truncated
        };
        return {
          ...cell.terminal,
          observations: visible.observations,
          images: visible.images,
          content: JSON.stringify({
            ...data,
            output: undefined,
            calls: undefined,
            observations: visible.observations.map(visibleObservation)
          }),
          data,
          eventData: {
            ...data,
            ...cell.display,
            status: cell.status,
            cached: true,
            ...wait,
            executionSource: cell.source
          },
          truncated: data.truncated
        };
      }
      const snapshot = cell.terminal.data as { output: string };
      const bounded = truncateModelText(snapshot.output, limits.codeMaxOutputTokens);
      const data = {
        ...snapshot,
        output: bounded.content,
        truncated: cell.terminal.truncated || bounded.truncated,
        cached: true,
        ...wait
      };
      return {
        ...cell.terminal,
        data,
        eventData: { ...data, executionSource: cell.source },
        content: JSON.stringify(data),
        truncated: cell.terminal.truncated || bounded.truncated
      };
    }
    const captured = cell.text.drain();
    const images = cell.images.splice(0);
    const text = renderCapturedText(captured, images.length);
    cell.yielded = false;
    const bounded = truncateModelText(text, limits.codeMaxOutputTokens);
    const pending = cell.observations.splice(0);
    if (!pending.length && captured.text)
      pending.push({
        type: 'value',
        id: newObservationId(),
        format: 'text',
        value: captured.text,
        truncated: captured.droppedBytes > 0
      });
    const structured = boundObservations(pending, limits.codeMaxOutputTokens);
    const visible = selectObservationImages(structured.observations, images, cell.imageOffset);
    const remapped = visible.observations;
    const visibleImages = visible.images;
    cell.imageOffset += images.length;
    cell.truncated ||= captured.droppedBytes > 0 || bounded.truncated || structured.truncated;
    const error =
      cell.error === undefined
        ? undefined
        : describeAgentError(cell.error, 'MAR_AGENT_CODE_FAILED');
    const data = {
      cellId: cell.cellId,
      status: cell.status,
      ...wait,
      ...(permissionStopFromError(cell.error)
        ? { permissionStop: permissionStopFromError(cell.error)! }
        : {}),
      output: bounded.content,
      observations: remapped,
      calls: [...cell.calls.values()],
      ...(cell.result?.data as object | undefined),
      outputBytes: captured.originalBytes,
      outputDroppedBytes: captured.droppedBytes,
      truncated: cell.truncated,
      ...(error ? { error: { code: error.code, message: error.message } } : {}),
      cached: false
    };
    const result: ToolExecutionResult = {
      content: JSON.stringify({
        ...data,
        output: undefined,
        calls: undefined,
        observations: remapped.map(visibleObservation)
      }),
      calls: [...cell.calls.values()],
      observations: remapped,
      data,
      eventData: {
        ...data,
        ...cell.display,
        status: cell.status,
        executionSource: cell.source
      },
      truncated: cell.truncated || structured.truncated,
      ...(visibleImages.length ? { images: visibleImages } : {})
    };
    if (cell.status !== 'running') cell.terminal = result;
    // Keep synchronous completion compatible; retained waits always include explicit lifecycle metadata.
    if (initial && cell.status !== 'running') {
      if (cell.error !== undefined) throw new CodeCellExecutionError(cell.error, result);
      return result;
    }
    return result;
  }

  snapshot(sessionId: string) {
    return [...this.#cells.values()]
      .filter((cell) => cell.sessionId === sessionId)
      .map(({ cellId, status, executionId }) => ({ cellId, status, executionId }));
  }

  async dispose(sessionId?: string) {
    if (sessionId === undefined) this.#closed = true;
    else this.#disposing.add(sessionId);
    const cells = [...this.#cells.values()].filter(
      (cell) => sessionId === undefined || cell.sessionId === sessionId
    );
    for (const cell of cells)
      cell.controller.abort(
        new AgentError('MAR_AGENT_CODE_CANCELLED', 'Code Exec resources were released.')
      );
    await Promise.all(cells.map((cell) => cell.done));
    for (const cell of cells) {
      clearTimeout(cell.retention);
      this.#cells.delete(cell.cellId);
    }
    if (sessionId !== undefined) this.#disposing.delete(sessionId);
  }
}
