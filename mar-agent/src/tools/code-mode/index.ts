import type { ClientToolDefinition } from '../contracts.js';
import type { SessionModelMessage as ModelMessage } from '../../session/model-request.js';
import { randomUUID } from 'node:crypto';
import {
  isToolPermissionFailure,
  permissionStopFromError,
  ToolPermissionStopError
} from '../permissions.js';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, sep } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { AgentError, describeAgentError } from '../../error.js';
import type { LocalProcessExecutor } from '../../process/contracts.js';

import { allowsDirectTool, allowsToolCaller } from '../callers.js';
import {
  orderToolDefinitions,
  stableToolSchema,
  stableToolDefinition
} from '../definition-projection.js';
import { CodeCells, type CellOutput } from './cells.js';
import type { CodeModeEngineFactory } from './engine.js';
import { newObservationId } from './observations.js';
import { renderObservations } from '../../session/code-observation-projection.js';
import type {
  CodeObservation,
  CodeToolCallRecord
} from '../../session/code-observation-contract.js';
import {
  parseCodeModeStateMutations,
  type CodeModeStateMutation
} from '../../session/code-state.js';
import { BoundedTextOutput, renderCapturedText } from './text-output.js';
import type { ToolCall, ToolExecutionContext, ToolExecutionResult } from '../contracts.js';
import { TOOL_EXECUTION_LIMITS as limits } from '../execution-limits.js';
import { createToolCallScheduler } from '../scheduler.js';
import { WorkspacePathResolver } from '../shared/path-resolver.js';
import { detectImageMime } from '../local/view-image.js';
import { isModelImageUrl } from '../../model/image.js';
import { structuredToolFailureData } from '../output-projection.js';
import { failedToolResultExtensions } from '../result-extensions.js';

export const codeModeToolDefinition: ClientToolDefinition = {
  name: 'code_exec',
  description: `Run JavaScript to orchestrate or compose tool calls.
- Code Mode Only by default: call the programmatic tools listed below through tools.NAME, including single-tool operations. Tools explicitly exposed in both places may also be called directly; follow each tool's calling guidance. Direct-only tools remain separate model tools and cannot be called here.
- Run independent calls concurrently with Promise.all; await sequentially when data, side effects, or failure handling require ordering.
- Complete known, bounded steps and deterministic result processing in code when this avoids a model round trip. Return to the model when interpretation or a new decision is needed; do not invent extra work to fill a cell.
- Observe only evidence needed for the next decision or verification: use observe.result for original results, observe.text for derived values, and observe.image for image values. Preserve source and failure details needed for reasoning; keep other intermediate data in the cell.
- Single-tool cells are valid. Keep loops and retries bounded, and do not blindly replay operations with side effects.
- Evaluates source in a fresh restricted ECMAScript runtime with top-level await and Promise.all. It is not Node.js or a browser. JavaScript globals do not survive between cells; bounded JSON state is available through state.
- Accepts JavaScript source text. When exposed as a freeform tool, send the source directly; when exposed with a JSON input schema, put the source in its code field. Do not add another JSON wrapper, quoted string, or markdown code fence inside the source.
- Keep embedded commands, patches and source in JSON-escaped double-quoted strings when they contain backticks or literal \${...}; escape newlines as \\n, never put literal line breaks inside single- or double-quoted JS strings. JavaScript template literals would interpolate their contents before the tool runs. Do not paste Python literals such as None into JavaScript expressions.
- Use only standard ECMAScript built-ins and the explicitly documented tools, observe, state, catalog and cell namespaces. Do not use Node.js, browser or Web APIs. Module imports, filesystem and network APIs are unavailable. Obtain external capabilities only through available tools. Use tools.exec to start managed processes when permitted; follow exec_wait's calling guidance for process control.

Tool calls:
- tools.NAME(input) returns a Promise. Pass a JavaScript value matching the current catalog inputSchema. For parameterless tools prefer tools.NAME({}); tools.NAME() is accepted only for explicitly closed empty-object schemas.
- Results use the MAR envelope: { content?: string, data?: unknown, images?: Array<{mimeType:string,dataBase64:string,url?:string,urlExpiresAt?:number}>, truncated?: boolean }. Redundant JSON content is omitted when it exactly renders data; independent text remains in content. Prefer data for programmatic results: result.data.results[0].text for read source text and result.data.exitCode/result.data.stdout for exec. content, when present, is rendered text, not raw file bytes. Use only fields documented by that tool; do not invent success or ok flags.
- Tool errors reject with code/message and may be caught, except nested Auto deny, which skips only that call and resolves with data.error/data.message. A failed cell preserves already emitted output alongside its status and error; completed tool effects are not rolled back. Inspect it before retrying completed work. Await every call; unawaited calls fail the cell. Use Promise.all for independent calls and sequential await for dependencies. Runtime preserves safe/serial barriers and Host checks.
- skill, tool_search, question, code_exec, code_exec_wait and direct-only tools cannot be called here. Load Skills directly and read their instructions before the next tool call. Use direct tool_search before a later code cell for deferred tools; the current cell's tools do not change.

Built-in namespaces:
- observe.result(result): void registers an unmodified complete tools.NAME result or caught tool error as a trusted tool_result, using the original text and all images without repeating program data. Non-original, copied or modified values are rejected. This selects evidence for the next model response, not a log and not a new model call. Prefer observe.result for inspecting tool results.
- observe.text(value): void registers text/JSON values. observe.image(value): void registers one image value when image input is supported. Both accept original tool results for compatibility and use the same complete tool_result observation path; they do not select part of an original result. Extracted single images, copies and computed summaries are value observations, never trusted tool results. Observations are returned in registration order. Only explicitly observed evidence reaches the model; registration does not prove inspection. Sources and types are runtime-assigned. No out or callable observe(value) alias exists.
- state.get(key), state.has(key), state.set(key, value), state.delete(key) access bounded session JSON state. Mutations commit atomically only when the cell succeeds; failed or cancelled cells discard them.
- catalog.tools() returns a read-only array of the tools callable in this cell, including name, description and inputSchema. It does not discover or authorize additional tools.
- await cell.sleep(ms) performs a cancellable delay up to ${limits.codeSleepMaxMs} ms.
- await cell.yield_control() returns accumulated output to the model immediately while this cell continues running.
- Optionally start source with // @options: {"yieldMs": ${limits.codeDefaultYieldMs}}. yieldMs defaults to ${limits.codeDefaultYieldMs} ms and controls this call's wait window (0..${limits.codeMaxYieldMs}), not nested tool timeouts or wait windows. A running result includes cellId (c_ plus 12 lowercase hex characters); use direct code_exec_wait for new output, completion or termination.
- waitOutcome separates snapshot, completion, timeout, and yield from the cell status. A foreground steer returns interrupted with reason=steer without stopping the cell or its internal tool waits.
- Registered cells are Session warm resources: ending or cancelling the model Execution cancels its wait, not the cell. Reuse retained cellId; do not start duplicate work. Host cleanup or explicit termination stops the cell.
- tools, observe, state, catalog and cell are frozen bindings. Do not shadow their names.

Examples (copy the JavaScript source, not the fences; use only tools available in the current directory):
Independent reads, observing the original tool results:
\`\`\`js
const [a, b] = await Promise.all([
  tools.read({ reads: [{ path: "a.txt" }] }),
  tools.read({ reads: [{ path: "b.txt" }] })
]);
observe.result(a);
observe.result(b);
\`\`\`
Inspect before a dependent edit; successful await needs no invented success flag:
\`\`\`js
const inspected = await tools.read({ reads: [{ path: "source.txt" }] });
const sourceText = inspected.data.results[0].text;
if (!sourceText?.includes("original=1")) throw new Error("Unexpected source");
const patched = await tools.apply_patch({ patch: "*** Begin Patch\\n*** Update File: source.txt\\n@@\\n original=1\\n+updated=2\\n*** End Patch" });
observe.result(patched);
\`\`\``,
  inputMode: 'freeform',
  inputSchema: {
    type: 'object',
    properties: { code: { type: 'string' } },
    required: ['code'],
    additionalProperties: false
  },
  allowedCallers: ['direct'],
  parallelSafety: 'serial'
};

export const codeExecWaitToolDefinition: ClientToolDefinition = {
  name: 'code_exec_wait',
  description:
    'Wait for a retained Code Exec cell by cellId. It cannot start new work; use code_exec for that. A missing cellId does not mean code_exec is unavailable. Returns only new output, or a bounded terminal snapshot marked cached on repeat reads. yieldMs is a wait window, not a timeout. action defaults to poll (wait); action cancel stops the cell and waits for cleanup. Cancelling this wait does not cancel the cell. Cells belong to the current Session and cannot survive Host restart. Call directly, never inside code_exec. Poll results include waitOutcome; interrupted with reason=steer ends only the foreground wait and preserves the cell.',
  inputSchema: {
    type: 'object',
    properties: {
      cellId: {
        type: 'string',
        description:
          'Copy the complete cellId returned by code_exec (c_ followed by 12 lowercase hex characters). Never use a processId (p_); use exec_wait for processes.'
      },
      yieldMs: {
        type: 'integer',
        minimum: 0,
        maximum: limits.codeMaxWaitYieldMs,
        default: limits.codeDefaultWaitYieldMs,
        description: `Wait up to this many milliseconds. Defaults to ${limits.codeDefaultWaitYieldMs}; maximum ${limits.codeMaxWaitYieldMs}. Zero returns immediately without stopping the cell. Waiting does not restart the cell or extend nested tool timeouts.`
      },
      action: {
        type: 'string',
        enum: ['poll', 'cancel'],
        description:
          'Defaults to poll; cancel terminates the cell rather than just its current wait.'
      }
    },
    required: ['cellId'],
    additionalProperties: false
  },
  allowedCallers: ['direct'],
  parallelSafety: 'safe'
};

function projectProgrammaticTool(
  tool: ClientToolDefinition
): Pick<ClientToolDefinition, 'name' | 'description' | 'inputSchema'> {
  return {
    name: tool.name,
    description: `${allowsDirectTool(tool, true) ? `Call directly or as tools.${tool.name} inside code_exec.` : `Call only as tools.${tool.name} inside code_exec, never as a direct model tool.`}\nInside code_exec, pass a JavaScript value matching inputSchema.\n${tool.description}`,
    inputSchema: stableToolSchema(tool.inputSchema)
  };
}

/** Deferred definitions travel in search results, not in the stable Code Mode description. */
export function projectCodeModeTools(
  tools: readonly ClientToolDefinition[],
  residentTools: readonly ClientToolDefinition[] = tools
): ClientToolDefinition[] {
  const codeModeEnabled = tools.some(
    (tool) => tool.name === 'code_exec' && allowsToolCaller(tool, 'direct')
  );
  const direct = tools
    .filter((tool) => allowsDirectTool(tool, codeModeEnabled))
    .map(stableToolDefinition);
  if (!codeModeEnabled) return direct;
  const programmatic = orderToolDefinitions(
    residentTools.filter((tool) => allowsToolCaller(tool, 'programmatic'))
  );
  const directory = JSON.stringify({
    callableNames: programmatic.map((tool) => tool.name),
    tools: programmatic.map(projectProgrammaticTool)
  });
  if (Buffer.byteLength(directory) > 32 * 1024)
    throw new AgentError(
      'MAR_AGENT_TOOL_EXPOSURE_LIMIT',
      'Programmatic tool directory is too large.'
    );
  return direct.map((tool) =>
    tool.name === 'code_exec'
      ? {
          ...tool,
          description: `${codeModeToolDefinition.description}\nDeferred MCP definitions are returned by direct tool_search and become callable from the next model response, not later in the same response; they are not appended to this description.\nProgrammatic tools: ${directory}`
        }
      : tool
  );
}

/** Preserve native search definitions while providing the same discovery evidence to other protocols. */
export function projectCodeModeSearchResult(
  message: ModelMessage,
  codeModeEnabled: boolean
): ModelMessage {
  if (!message.toolSearchTools) return message;
  if (!codeModeEnabled)
    return {
      ...message,
      toolSearchTools: message.toolSearchTools
        .filter((tool) => allowsToolCaller(tool, 'direct'))
        .map(stableToolDefinition)
    };
  const tools = message.toolSearchTools.map((tool) => ({
    ...(allowsToolCaller(tool, 'programmatic')
      ? {
          ...projectProgrammaticTool(tool),
          ...(allowsDirectTool(tool, true)
            ? { inputMode: tool.inputMode ?? ('json' as const) }
            : {})
        }
      : {
          name: tool.name,
          description: tool.description,
          inputSchema: stableToolSchema(tool.inputSchema),
          inputMode: tool.inputMode ?? ('json' as const)
        }),
    caller: allowsToolCaller(tool, 'programmatic')
      ? allowsDirectTool(tool, true)
        ? 'both'
        : 'programmatic'
      : 'direct'
  }));
  return {
    ...message,
    content: JSON.stringify({ tools }),
    toolSearchTools: tools.map(({ caller: _caller, ...tool }) => tool)
  };
}

function defaultEngineFactory(): CodeModeEngineFactory {
  const core = import.meta.resolve('quickjs-emscripten-core');
  const variant = import.meta.resolve('@jitl/quickjs-wasmfile-release-sync');
  const ffi = pathToFileURL(createRequire(core).resolve('@jitl/quickjs-ffi-types')).href;
  const dependencyRoot = (url: string) => {
    const root = dirname(dirname(fileURLToPath(url)));
    // pnpm's sibling dependencies are symlinks; keep the package-local node_modules tree visible.
    return root.includes(`${sep}.pnpm${sep}`) ? dirname(dirname(root)) : root;
  };
  return {
    moduleUrl: new URL('./quickjs-engine.js', import.meta.url).href,
    runtimeDirectories: [
      ...new Set([
        fileURLToPath(new URL('.', import.meta.url)),
        fileURLToPath(new URL('../input-diagnostics/', import.meta.url)),
        dependencyRoot(core),
        dependencyRoot(variant),
        dependencyRoot(ffi)
      ])
    ],
    options: { coreModuleUrl: core, variantModuleUrl: variant }
  };
}

const environmentKeys = [
  'PATH',
  'Path',
  'SystemRoot',
  'WINDIR',
  'TEMP',
  'TMP',
  'LANG',
  'LC_ALL',
  'TZ'
];

export class CodeModeTool {
  readonly #cells = new CodeCells();
  start(value: unknown, context: ToolExecutionContext) {
    return this.#cells.start(value, context, (code, detached, output) =>
      this.execute(code, detached, output)
    );
  }
  wait(value: unknown, context: ToolExecutionContext) {
    return this.#cells.wait(value, context);
  }
  listSessionResources(sessionId: string) {
    return this.#cells.snapshot(sessionId);
  }
  readonly #active = new Map<AbortController, { sessionId: string; done: Promise<void> }>();
  constructor(
    private readonly paths: WorkspacePathResolver,
    private readonly environment: NodeJS.ProcessEnv = {},
    private readonly executor: LocalProcessExecutor,
    private readonly signalProcessTree: (
      child: import('node:child_process').ChildProcessWithoutNullStreams,
      signal: NodeJS.Signals
    ) => Promise<void>,
    private readonly engineFactory: CodeModeEngineFactory = defaultEngineFactory()
  ) {}

  async execute(
    value: unknown,
    context: ToolExecutionContext,
    output?: CellOutput
  ): Promise<ToolExecutionResult> {
    const code =
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
      typeof code !== 'string' ||
      !code.trim() ||
      Buffer.byteLength(code) > limits.codeMaxInputBytes
    )
      throw new AgentError(
        'MAR_AGENT_TOOL_INPUT_INVALID',
        'Code must be a nonempty JavaScript string within the cell input limit.'
      );
    if (!context.codeMode)
      throw new AgentError(
        'MAR_AGENT_TOOL_NOT_AVAILABLE',
        'Code Mode tool dispatch is unavailable.'
      );
    context.signal.throwIfAborted();
    if (this.#active.size >= limits.codeMaxConcurrentCells)
      throw new AgentError(
        'MAR_AGENT_PROCESS_LIMIT',
        `The Local Host shared running-cell limit (${limits.codeMaxConcurrentCells}) was reached.`
      );
    const controller = new AbortController();
    const signal = AbortSignal.any([context.signal, controller.signal]);
    let release!: () => void;
    const done = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.#active.set(controller, { sessionId: context.sessionId, done });
    try {
      return await this.#run(code, { ...context, signal }, controller, output);
    } finally {
      this.#active.delete(controller);
      release();
    }
  }

  async dispose(sessionId?: string) {
    await this.#cells.dispose(sessionId);
    const active = [...this.#active].filter(
      ([, entry]) => sessionId === undefined || entry.sessionId === sessionId
    );
    for (const [controller] of active)
      controller.abort(
        new AgentError('MAR_AGENT_CODE_CANCELLED', 'Code Mode resources were released.')
      );
    await Promise.all(active.map(([, entry]) => entry.done));
  }

  async #run(
    code: string,
    context: ToolExecutionContext,
    controller: AbortController,
    output?: CellOutput
  ): Promise<ToolExecutionResult> {
    const cwd = await this.paths.resolve('.');
    context.signal.throwIfAborted();
    const environment = Object.fromEntries(
      environmentKeys.flatMap((key) => {
        const value = this.environment[key];
        return value === undefined ? [] : [[key, value]];
      })
    );
    const child = await this.executor.spawn({
      command: process.execPath,
      args: [
        `--max-old-space-size=${limits.codeHeapMegabytes}`,
        '--input-type=module',
        '--eval',
        await readFile(new URL('./worker.js', import.meta.url), 'utf8')
      ],
      cwd,
      shell: false,
      environment,
      environmentKeys: Object.keys(environment),
      runtimeDirectories: this.engineFactory.runtimeDirectories,
      detached: process.platform !== 'win32',
      owner: { sessionId: context.sessionId, executionId: context.executionId },
      signal: context.signal
    });
    const text = new BoundedTextOutput(limits.codeMaxOutputBytes);
    const images: NonNullable<ToolExecutionResult['images']>[number][] = [];
    const observations: CodeObservation[] = [];
    let observationBytes = 0;
    const appendObservation = (value: CodeObservation, originalBytes?: number) => {
      const capture = new BoundedTextOutput(
        Math.max(0, limits.codeMaxOutputBytes - observationBytes),
        ''
      );
      const body = value.type === 'tool_result' ? value.result.content : value.value;
      capture.append(body);
      const bounded = capture.snapshot();
      observationBytes += bounded.retainedBytes;
      text.append(body, originalBytes ?? Buffer.byteLength(body));
      output?.text(body, originalBytes ?? Buffer.byteLength(body));
      const observation: CodeObservation =
        value.type === 'tool_result'
          ? {
              ...value,
              result: {
                ...value.result,
                content: bounded.text,
                truncated: value.result.truncated === true || bounded.droppedBytes > 0
              }
            }
          : {
              ...value,
              value: bounded.text,
              truncated: value.truncated === true || bounded.droppedBytes > 0
            };
      observations.push(observation);
      output?.observe(observation);
    };
    const toolResults = new Map<
      string,
      {
        source: { callId: string; toolName: string; input: unknown };
        outcome: 'completed' | 'failed';
        result: ToolExecutionResult;
      }
    >();
    let transportBytes = 0;
    let calls = 0;
    let complete = false;
    let stateMutations: CodeModeStateMutation[] = [];
    let failure: unknown;
    let stderr = '';
    let buffered = '';
    const decoder = new StringDecoder('utf8');
    const seen = new Set<number>();
    const pending = new Set<Promise<void>>();
    let exited!: () => void;
    const exit = new Promise<void>((resolve) => {
      exited = resolve;
    });
    const fail = (error: unknown) => {
      if (failure === undefined) failure = error;
      if (!controller.signal.aborted) controller.abort(error);
    };
    const abort = () => {
      if (failure === undefined) failure = context.signal.reason;
      void this.signalProcessTree(child, 'SIGKILL').catch((error) => {
        failure ??= error;
      });
    };
    context.signal.addEventListener('abort', abort, { once: true });
    const write = async (message: unknown) => {
      context.signal.throwIfAborted();
      const frame = JSON.stringify(message) + '\n';
      const bytes = Buffer.byteLength(frame);
      transportBytes += bytes;
      if (bytes > limits.codeMaxFrameBytes || transportBytes > limits.codeMaxTransportBytes)
        throw new AgentError(
          'MAR_AGENT_TOOL_OUTPUT_LIMIT',
          'Code Mode exceeded its message transfer limit.'
        );
      await new Promise<void>((resolve, reject) => {
        child.stdin.write(frame, (error) => (error ? reject(error) : resolve()));
      });
    };
    const invoke = createToolCallScheduler<ToolCall, ToolExecutionResult>(
      context.codeMode!.tools,
      async (call) => {
        context.signal.throwIfAborted();
        return context.codeMode!.invoke(call, context.signal);
      }
    );
    const available = new Set(
      context
        .codeMode!.tools.filter((tool) => allowsToolCaller(tool, 'programmatic'))
        .map((tool) => tool.name)
    );
    const receive = (frame: Record<string, unknown>) => {
      if (complete)
        throw new AgentError(
          'MAR_AGENT_CODE_PROTOCOL_ERROR',
          'Code Mode sent data after completion.'
        );
      if (frame.kind === 'observe' && frame.observation && typeof frame.observation === 'object') {
        const value = frame.observation as Record<string, unknown>;
        if (observations.length >= 4096)
          throw new AgentError('MAR_AGENT_TOOL_OUTPUT_LIMIT', 'Too many Code Mode observations.');
        const addImage = (raw: unknown) => {
          if (!context.codeMode?.supportsImages)
            throw new AgentError(
              'MAR_AGENT_INPUT_CAPABILITY_UNSUPPORTED',
              'The current model cannot receive image observations.'
            );
          const image = parseImage(raw);
          const index = images.length;
          images.push(image);
          output?.image(image);
          return index;
        };
        let observation: CodeObservation;
        if (value.type === 'tool_result' && typeof value.operationId === 'string') {
          const original = toolResults.get(value.operationId);
          if (!original)
            throw new AgentError('MAR_AGENT_CODE_PROTOCOL_ERROR', 'Unknown observation source.');
          const bounded = {
            content: original.result.content,
            truncated: original.result.truncated === true
          };
          const indices = original.result.images?.map(addImage);
          const data = [
            'exec',
            'exec_wait',
            'apply_patch',
            'todo_read',
            'todo_write',
            'agent_start',
            'agent_wait',
            'agent_message',
            'agent_cancel'
          ].includes(original.source.toolName)
            ? original.result.data
            : undefined;
          observation = {
            type: 'tool_result',
            id: newObservationId(),
            source: original.source,
            outcome: original.outcome,
            result: {
              content: bounded.content,
              truncated: original.result.truncated === true || bounded.truncated,
              ...(data === undefined ? {} : { data }),
              ...(indices?.length ? { imageIndices: indices } : {})
            }
          };
        } else if (value.type === 'image') {
          observation = {
            type: 'value',
            id: newObservationId(),
            format: 'image',
            value: '',
            imageIndices: [addImage(value.value)]
          };
        } else if (
          value.type === 'value' &&
          typeof value.value === 'string' &&
          ['text', 'json'].includes(String(value.format))
        ) {
          observation = {
            type: 'value',
            id: newObservationId(),
            format: value.format as 'text' | 'json',
            value: value.value,
            truncated:
              typeof value.originalBytes === 'number' &&
              value.originalBytes > Buffer.byteLength(value.value)
          };
        } else throw new AgentError('MAR_AGENT_CODE_PROTOCOL_ERROR', 'Invalid observation frame.');
        appendObservation(
          observation,
          value.type === 'value' && typeof value.originalBytes === 'number'
            ? value.originalBytes
            : undefined
        );
      } else if (frame.kind === 'text' && typeof frame.value === 'string') {
        const originalBytes = frame.originalBytes ?? Buffer.byteLength(frame.value);
        if (
          !Number.isSafeInteger(originalBytes) ||
          (originalBytes as number) < Buffer.byteLength(frame.value)
        )
          throw new AgentError(
            'MAR_AGENT_CODE_PROTOCOL_ERROR',
            'Code Mode sent invalid text byte counts.'
          );
        appendObservation(
          {
            type: 'value',
            id: newObservationId(),
            format: 'text',
            value: frame.value,
            truncated: (originalBytes as number) > Buffer.byteLength(frame.value)
          },
          originalBytes as number
        );
      } else if (frame.kind === 'image') {
        if (!context.codeMode?.supportsImages)
          throw new AgentError(
            'MAR_AGENT_INPUT_CAPABILITY_UNSUPPORTED',
            'The current Code Mode context does not support image output.'
          );
        const image = parseImage(frame.value);
        images.push(image);
        output?.image(image);
        appendObservation({
          type: 'value',
          id: newObservationId(),
          format: 'image',
          value: '',
          imageIndices: [images.length - 1]
        });
      } else if (frame.kind === 'yield') {
        output?.yield();
      } else if (
        frame.kind === 'call' &&
        Number.isSafeInteger(frame.id) &&
        typeof frame.name === 'string'
      ) {
        const id = frame.id as number;
        if (seen.has(id) || ++calls > limits.codeMaxCalls)
          throw new AgentError(
            'MAR_AGENT_CODE_PROTOCOL_ERROR',
            'Code Mode call ID or call count is invalid.'
          );
        seen.add(id);
        const source = {
          callId: randomUUID(),
          toolName: frame.name as string,
          input: frame.arguments
        };
        const operationId = typeof frame.operationId === 'string' ? frame.operationId : String(id);
        const recordCall = (value: CodeToolCallRecord) => output?.call(value);
        recordCall({ ...source, status: 'running' });
        const job = (async () => {
          try {
            if (frame.name === 'code_exec' || !available.has(frame.name as string))
              throw new AgentError(
                'MAR_AGENT_TOOL_NOT_AVAILABLE',
                'The requested nested tool is unavailable.'
              );
            const rawOutput = await invoke({
              name: frame.name as string,
              arguments: frame.arguments,
              callId: source.callId
            });
            const { resultExtensions, ...output } = rawOutput;
            toolResults.set(operationId, { source, outcome: 'completed', result: output });
            recordCall({
              ...source,
              status: 'completed',
              ...(resultExtensions ? { resultExtensions } : {}),
              result: {
                content: '',
                truncated: output.truncated === true,
                data: [
                  'apply_patch',
                  'todo_read',
                  'todo_write',
                  'agent_start',
                  'agent_wait',
                  'agent_message',
                  'agent_cancel'
                ].includes(source.toolName)
                  ? output.data
                  : undefined
              }
            });
            const { content, ...structured } = output;
            const projected =
              output.data !== undefined && content === JSON.stringify(output.data)
                ? structured
                : output;
            await write({ id, ok: true, output: projected });
          } catch (error) {
            // Serialization/transport failures cannot undo an already completed tool call.
            if (toolResults.get(operationId)?.outcome === 'completed') throw error;
            if (context.signal.aborted) return;
            const diagnostic = describeAgentError(error, 'MAR_AGENT_HOST_OPERATION_FAILED');
            const data = structuredToolFailureData(source.toolName, error);
            recordCall({
              ...source,
              status: 'failed',
              ...(failedToolResultExtensions(error)
                ? { resultExtensions: failedToolResultExtensions(error)! }
                : {}),
              error: { code: diagnostic.code, message: diagnostic.message }
            });
            const failureResult: ToolExecutionResult = {
              content: JSON.stringify({
                error: diagnostic.code,
                message: diagnostic.message,
                ...(data === undefined ? {} : { data })
              }),
              ...(data === undefined ? {} : { data })
            };
            const permissionStop = permissionStopFromError(error);
            if (isToolPermissionFailure(error))
              failureResult.data = { error: diagnostic.code, message: diagnostic.message };
            toolResults.set(operationId, { source, outcome: 'failed', result: failureResult });
            if (isToolPermissionFailure(error)) {
              await write({ id, ok: true, output: { data: failureResult.data } });
              return;
            }
            if (permissionStop) {
              fail(error);
              return;
            }
            await write({
              id,
              ok: false,
              error: {
                code: diagnostic.code,
                message: diagnostic.message
              }
            });
          }
        })().catch(fail);
        pending.add(job);
        void job.finally(() => pending.delete(job));
      } else if (frame.kind === 'done') {
        // Child completion cannot undo Host tool effects from calls it did not await.
        if (pending.size)
          throw new AgentError(
            'MAR_AGENT_CODE_INCOMPLETE',
            'Code Mode returned with unawaited tool calls; completed operations are not rolled back.'
          );
        stateMutations = parseCodeModeStateMutations(frame.stateMutations);
        complete = true;
        void this.signalProcessTree(child, 'SIGKILL').catch(fail);
      } else if (frame.kind === 'error' && typeof frame.message === 'string') {
        throw new AgentError(
          typeof frame.code === 'string' ? frame.code.slice(0, 128) : 'MAR_AGENT_CODE_FAILED',
          frame.message.slice(0, 4096)
        );
      } else
        throw new AgentError('MAR_AGENT_CODE_PROTOCOL_ERROR', 'Code Mode sent an invalid message.');
    };
    child.stdout.on('data', (chunk: Buffer) => {
      if (context.signal.aborted) return;
      try {
        transportBytes += chunk.length;
        if (
          transportBytes > limits.codeMaxTransportBytes ||
          Buffer.byteLength(buffered) + chunk.length > limits.codeMaxFrameBytes
        )
          throw new AgentError(
            'MAR_AGENT_TOOL_OUTPUT_LIMIT',
            'Code Mode exceeded its message transfer limit.'
          );
        buffered += decoder.write(chunk);
        let end: number;
        while ((end = buffered.indexOf('\n')) >= 0) {
          const line = buffered.slice(0, end);
          buffered = buffered.slice(end + 1);
          let frame: unknown;
          try {
            frame = JSON.parse(line);
          } catch {
            throw new AgentError('MAR_AGENT_CODE_PROTOCOL_ERROR', 'Code Mode sent invalid JSON.');
          }
          if (!frame || typeof frame !== 'object' || Array.isArray(frame))
            throw new AgentError(
              'MAR_AGENT_CODE_PROTOCOL_ERROR',
              'Code Mode sent an invalid message.'
            );
          receive(frame as Record<string, unknown>);
        }
      } catch (error) {
        fail(error);
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString('utf8')).slice(0, 4096);
    });
    child.stdin.on('error', (error) => {
      if (!complete) fail(error);
    });
    child.once('error', (error) => {
      fail(error);
      exited();
    });
    child.once('exit', (code, signal) => {
      if (code !== 0 && !complete && failure === undefined)
        failure = new AgentError(
          'MAR_AGENT_CODE_FAILED',
          `Code Mode exited with ${signal ?? code}. ${stderr}`.trim()
        );
      exited();
    });
    try {
      if (context.signal.aborted) abort();
      else
        await write({
          code,
          tools: [...available],
          catalog: context
            .codeMode!.tools.filter((tool) => available.has(tool.name))
            .map((tool) => ({
              ...projectProgrammaticTool(tool),
              ...(tool.parameterless ? { parameterless: true } : {}),
              inputMode: tool.inputMode ?? 'json'
            })),
          state: context.codeMode!.state ?? [],
          engine: this.engineFactory,
          limits: {
            memoryBytes: limits.codeMemoryBytes,
            stackBytes: limits.codeStackBytes,
            timeoutMs: limits.codeTimeoutMs,
            outputBytes: limits.codeMaxOutputBytes,
            stateEntries: limits.codeStateMaxEntries,
            stateMutations: limits.codeStateMaxMutations,
            stateKeyBytes: limits.codeStateMaxKeyBytes,
            stateValueBytes: limits.codeStateMaxValueBytes,
            stateTotalBytes: limits.codeStateMaxTotalBytes,
            sleepMs: limits.codeSleepMaxMs
          }
        });
      await exit;
      const permissionStop = context.codeMode?.permissionStop?.();
      if (permissionStop) throw new ToolPermissionStopError(permissionStop);
      if (failure !== undefined) throw failure;
      if (!complete)
        throw new AgentError(
          'MAR_AGENT_CODE_INCOMPLETE',
          'Code Mode exited without a completion message.'
        );
      if (stateMutations.length) await context.codeMode!.commitState?.(stateMutations);
      const captured = text.snapshot();
      return {
        content: observations.length
          ? renderObservations(observations)
          : renderCapturedText(captured, images.length) || '[]',
        observations,
        data: {
          toolCalls: calls,
          outputBytes: captured.originalBytes,
          outputDroppedBytes: captured.droppedBytes
        },
        truncated: captured.droppedBytes > 0,
        ...(images.length ? { images } : {})
      };
    } finally {
      controller.abort(new AgentError('MAR_AGENT_CODE_CANCELLED', 'Code Mode cell has ended.'));
      await this.signalProcessTree(child, 'SIGKILL');
      await exit;
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
      context.signal.removeEventListener('abort', abort);
      await Promise.allSettled(pending);
    }
  }
}

function parseImage(value: unknown): NonNullable<ToolExecutionResult['images']>[number] {
  const invalid = () =>
    new AgentError(
      'MAR_AGENT_IMAGE_FORMAT_UNSUPPORTED',
      'Code Mode image must contain valid PNG, JPEG or WebP base64 with matching MIME.'
    );
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  const image = value as Record<string, unknown>;
  if (
    Object.keys(image).some(
      (key) =>
        !['mimeType', 'dataBase64', 'url', 'urlExpiresAt', 'resourceId', 'byteSize'].includes(key)
    ) ||
    typeof image.mimeType !== 'string' ||
    (image.resourceId !== undefined &&
      (typeof image.resourceId !== 'string' || !/^[a-f0-9]{64}$/u.test(image.resourceId))) ||
    (image.byteSize !== undefined &&
      (!Number.isSafeInteger(image.byteSize) || (image.byteSize as number) <= 0)) ||
    (image.url !== undefined && !isModelImageUrl(image.url)) ||
    (image.urlExpiresAt !== undefined &&
      (typeof image.urlExpiresAt !== 'number' ||
        !Number.isSafeInteger(image.urlExpiresAt) ||
        image.urlExpiresAt <= 0))
  )
    throw invalid();
  if (image.dataBase64 === undefined && isModelImageUrl(image.url))
    return {
      mimeType: image.mimeType,
      url: image.url,
      ...(image.urlExpiresAt === undefined ? {} : { urlExpiresAt: image.urlExpiresAt as number }),
      ...(typeof image.resourceId === 'string' ? { resourceId: image.resourceId } : {}),
      ...(typeof image.byteSize === 'number' ? { byteSize: image.byteSize } : {})
    };
  if (
    typeof image.dataBase64 !== 'string' ||
    image.dataBase64.length === 0 ||
    image.dataBase64.length > Math.ceil(limits.viewImageMaxBytes / 3) * 4 ||
    image.dataBase64.length % 4 !== 0
  )
    throw invalid();
  const bytes = Buffer.from(image.dataBase64, 'base64');
  if (
    bytes.length > limits.viewImageMaxBytes ||
    bytes.toString('base64') !== image.dataBase64 ||
    detectImageMime(bytes) !== image.mimeType
  )
    throw invalid();
  return {
    mimeType: image.mimeType,
    dataBase64: image.dataBase64,
    ...(typeof image.resourceId === 'string' ? { resourceId: image.resourceId } : {}),
    ...(typeof image.byteSize === 'number' ? { byteSize: image.byteSize } : {}),
    ...(image.url === undefined ? {} : { url: image.url }),
    ...(image.urlExpiresAt === undefined ? {} : { urlExpiresAt: image.urlExpiresAt })
  };
}
